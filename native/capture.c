// SPDX-License-Identifier: GPL-3.0-or-later

// What the screen casts show, and marks on the screen that no cast shows.
//
// lib/privacy.js draws a glow along the edges of a monitor that is recorded
// or shared. The glow is for the person at the screen and is not to be in
// the recording. The shell cannot do either half of that by itself:
//
// 1. Mutter does not say what a cast shows. The shell is told that a cast
//    has started (MetaRemoteAccessHandle) and nothing more. The monitor,
//    window or area is named in the D-Bus call that makes the stream
//    (org.gnome.Mutter.ScreenCast.Session.RecordMonitor and its siblings),
//    which Mutter answers itself. A message filter on the session bus
//    connection reads those calls and their replies here.
//
// 2. A cast of a monitor is a copy of the picture that monitor is about to
//    show, taken right after the stage has painted its actors or, for a cast
//    with the pointer drawn in, after the pointer too. Whatever an actor
//    paints is in the copy. Mutter makes the copy from a list of functions
//    it calls at those points of a frame (meta_stage_watch_view). This
//    module adds a function to the end of that list, which paints one actor
//    of the extension into the monitor's picture after every copy has been
//    made. In the frame itself the actor has an opacity override of 0, so
//    the stage does not paint it, and with it neither do the casts that
//    paint the stage again for themselves: a cast of an area, a cast into
//    shared memory, a screenshot.
//
//    A frame paints only the part of the monitor that changed, and the rest
//    of the picture is the one of an earlier frame, with the actor painted
//    in. So every frame that is painted also paints the places of the
//    actor's grandchildren again, and they are without the actor when the
//    copy is made. No frame is painted for this alone.
//
// The extension reaches the module through a GObject of the type
// KelpCapture, which it finds by name:
//
//   changed   ()                   emitted when the list of streams changes
//   streams   () -> a(ossstiiiib)   the streams made since the module was
//             loaded and not yet closed: stream path, session path, kind
//             ("monitor", "window", "area", "virtual"), connector, window
//             id, x, y, width, height of an area, and whether the client
//             called it a recording
//   forget    (path: string)       drop a stream that is gone
//   set-root  (actor: ClutterActor or null)
//             the actor that is painted after the copies, a child of the
//             stage with no transformation of its own. Its children are
//             groups, and what is drawn are the children of those: their
//             places are painted again in every frame. null: none
//
// A session that ends with a Stop call or a Closed signal is dropped here.
// The session of a remote desktop ends with neither, so the extension also
// asks for the streams it knows after a cast has stopped, and has those
// forgotten that do not answer.
//
// Mutter and the shell are declared below and not included, as in
// decorations.c, and the module is built for one version of the shell.

#include <gio/gio.h>
#include <stdint.h>
#include <string.h>

// -------------------------------------------------------------------- Mutter

// graphene_matrix_t: four SSE vectors.
typedef struct {
    float value[16];
} __attribute__ ((aligned (16))) Matrix;

// MtkRectangle and graphene_rect_t
typedef struct {
    int x, y, width, height;
} Rect;

typedef struct {
    float x, y, width, height;
} RectF;

// MetaStageWatchPhase
enum {
    WATCH_BEFORE_PAINT = 0,
    WATCH_AFTER_ACTOR_PAINT,
    WATCH_AFTER_OVERLAY_PAINT,
    WATCH_AFTER_PAINT,
};

typedef void (*WatchFunc) (gpointer stage, gpointer view, gconstpointer redraw_clip,
                           gpointer frame, gpointer user_data);

extern gpointer meta_stage_watch_view (gpointer stage, gpointer view, int phase,
                                       WatchFunc callback, gpointer user_data);
extern void meta_stage_remove_watch (gpointer stage, gpointer watch);
extern gpointer meta_display_get_focus_window (gpointer display);
extern guint64 meta_window_get_id (gpointer window);

extern gpointer clutter_stage_view_get_framebuffer (gpointer view);
extern void clutter_stage_view_get_layout (gpointer view, Rect *layout);
extern void clutter_stage_view_add_redraw_clip (gpointer view, const Rect *clip);
extern gpointer clutter_stage_view_get_color_state (gpointer view);
extern gpointer clutter_paint_context_new_for_framebuffer (gpointer framebuffer,
                                                           gconstpointer redraw_clip,
                                                           int paint_flags,
                                                           gpointer color_state);
extern void clutter_paint_context_destroy (gpointer paint_context);
extern void clutter_actor_paint (gpointer actor, gpointer paint_context);
extern void clutter_actor_set_opacity_override (gpointer actor, int opacity);
extern gpointer clutter_actor_get_parent (gpointer actor);
extern gpointer clutter_actor_get_first_child (gpointer actor);
extern gpointer clutter_actor_get_next_sibling (gpointer actor);
extern void clutter_actor_get_transformed_extents (gpointer actor, RectF *extents);
extern void clutter_actor_get_transform (gpointer actor, Matrix *transform);

extern void cogl_framebuffer_push_matrix (gpointer framebuffer);
extern void cogl_framebuffer_set_modelview_matrix (gpointer framebuffer, const Matrix *matrix);
extern void cogl_framebuffer_pop_matrix (gpointer framebuffer);

extern gpointer shell_global_get (void);
extern gpointer shell_global_get_stage (gpointer global);
extern gpointer shell_global_get_display (gpointer global);

// ------------------------------------------------------------------- streams

#define SESSION_IFACE "org.gnome.Mutter.ScreenCast.Session"
// Calls without a reply that are remembered at most.
#define PENDING_MOST 64

typedef struct {
    char *path;         // of the stream, known from the reply
    char *session;
    const char *kind;
    char *connector;
    guint64 window;
    gboolean focused;   // a window stream with no id: the focused window
    int x, y, width, height;
    gboolean recording;
    // While the call has no reply:
    char *sender;
    guint32 serial;
} Stream;

static struct {
    GObject *object;      // the KelpCapture the extension holds, not referenced
    GPtrArray *streams;   // of Stream, main thread
    GMutex lock;
    GPtrArray *pending;   // of Stream, under lock
} self;

static guint signal_changed;

static void
stream_free (gpointer data)
{
    Stream *stream = data;

    g_free (stream->path);
    g_free (stream->session);
    g_free (stream->connector);
    g_free (stream->sender);
    g_free (stream);
}

static void
changed (void)
{
    if (self.object)
        g_signal_emit (self.object, signal_changed, 0);
}

// Main thread: a stream was made.
static gboolean
stream_added (gpointer data)
{
    Stream *stream = data;

    if (stream->focused) {
        gpointer window =
            meta_display_get_focus_window (shell_global_get_display (shell_global_get ()));

        stream->window = window ? meta_window_get_id (window) : 0;
    }
    g_ptr_array_add (self.streams, stream);
    changed ();
    return G_SOURCE_REMOVE;
}

// Main thread: a session has ended. data: its path, owned.
static gboolean
session_closed (gpointer data)
{
    g_autofree char *session = data;
    gboolean any = FALSE;

    for (guint i = self.streams->len; i > 0; i--) {
        Stream *stream = g_ptr_array_index (self.streams, i - 1);

        if (strcmp (stream->session, session) == 0) {
            g_ptr_array_remove_index (self.streams, i - 1);
            any = TRUE;
        }
    }
    if (any)
        changed ();
    return G_SOURCE_REMOVE;
}

// The filter runs on GDBus's own thread. It only reads the message.
static void
on_call (GDBusMessage *message)
{
    const char *member = g_dbus_message_get_member (message);
    const char *path = g_dbus_message_get_path (message);
    const char *sender = g_dbus_message_get_sender (message);
    GVariant *body = g_dbus_message_get_body (message);
    g_autoptr (GVariant) properties = NULL;
    Stream *stream;

    if (!member || !path || !sender)
        return;
    if (strcmp (member, "Stop") == 0) {
        g_main_context_invoke (NULL, session_closed, g_strdup (path));
        return;
    }
    if (!body)
        return;

    stream = g_new0 (Stream, 1);
    if (strcmp (member, "RecordMonitor") == 0 &&
        g_variant_is_of_type (body, G_VARIANT_TYPE ("(sa{sv})"))) {
        stream->kind = "monitor";
        g_variant_get (body, "(s@a{sv})", &stream->connector, &properties);
    } else if (strcmp (member, "RecordWindow") == 0 &&
               g_variant_is_of_type (body, G_VARIANT_TYPE ("(a{sv})"))) {
        stream->kind = "window";
        g_variant_get (body, "(@a{sv})", &properties);
        stream->focused = !g_variant_lookup (properties, "window-id", "t", &stream->window);
    } else if (strcmp (member, "RecordArea") == 0 &&
               g_variant_is_of_type (body, G_VARIANT_TYPE ("(iiiia{sv})"))) {
        stream->kind = "area";
        g_variant_get (body, "(iiii@a{sv})", &stream->x, &stream->y,
                       &stream->width, &stream->height, &properties);
    } else if (strcmp (member, "RecordVirtual") == 0 &&
               g_variant_is_of_type (body, G_VARIANT_TYPE ("(a{sv})"))) {
        stream->kind = "virtual";
        g_variant_get (body, "(@a{sv})", &properties);
    } else {
        stream_free (stream);
        return;
    }
    g_variant_lookup (properties, "is-recording", "b", &stream->recording);
    stream->session = g_strdup (path);
    stream->sender = g_strdup (sender);
    stream->serial = g_dbus_message_get_serial (message);

    g_mutex_lock (&self.lock);
    if (self.pending->len >= PENDING_MOST)
        g_ptr_array_remove_index (self.pending, 0);
    g_ptr_array_add (self.pending, stream);
    g_mutex_unlock (&self.lock);
}

static void
on_reply (GDBusMessage *message)
{
    const char *destination = g_dbus_message_get_destination (message);
    guint32 serial = g_dbus_message_get_reply_serial (message);
    GVariant *body = g_dbus_message_get_body (message);
    Stream *stream = NULL;

    g_mutex_lock (&self.lock);
    for (guint i = 0; i < self.pending->len; i++) {
        Stream *candidate = g_ptr_array_index (self.pending, i);

        if (candidate->serial == serial && g_strcmp0 (candidate->sender, destination) == 0) {
            stream = g_ptr_array_steal_index (self.pending, i);
            break;
        }
    }
    g_mutex_unlock (&self.lock);
    if (!stream)
        return;

    if (g_dbus_message_get_message_type (message) == G_DBUS_MESSAGE_TYPE_METHOD_RETURN &&
        body && g_variant_is_of_type (body, G_VARIANT_TYPE ("(o)"))) {
        g_variant_get (body, "(o)", &stream->path);
        g_main_context_invoke (NULL, stream_added, stream);
    } else {
        stream_free (stream);
    }
}

static GDBusMessage *
filter (GDBusConnection *connection, GDBusMessage *message, gboolean incoming, gpointer data)
{
    GDBusMessageType type = g_dbus_message_get_message_type (message);

    if (incoming) {
        if (type == G_DBUS_MESSAGE_TYPE_METHOD_CALL &&
            g_strcmp0 (g_dbus_message_get_interface (message), SESSION_IFACE) == 0)
            on_call (message);
    } else if (type == G_DBUS_MESSAGE_TYPE_METHOD_RETURN || type == G_DBUS_MESSAGE_TYPE_ERROR) {
        on_reply (message);
    } else if (type == G_DBUS_MESSAGE_TYPE_SIGNAL &&
               g_strcmp0 (g_dbus_message_get_interface (message), SESSION_IFACE) == 0 &&
               g_strcmp0 (g_dbus_message_get_member (message), "Closed") == 0 &&
               g_dbus_message_get_path (message)) {
        g_main_context_invoke (NULL, session_closed,
                               g_strdup (g_dbus_message_get_path (message)));
    }
    return message;
}

// --------------------------------------------------------------------- marks

static struct {
    gpointer root;     // the actor, a weak pointer
    gpointer stage;    // while the watches are there
    gpointer before;
    gpointer after;
    guint sync_id;
} marks;

// After the stage, the pointer and every copy for a cast: paint the actor
// into the picture of this monitor. The clip of the frame is still on the
// framebuffer, so only the part that was painted again is painted over, and
// the rest of the picture has the actor from the frame it was painted in.
static void
after_paint (gpointer stage, gpointer view, gconstpointer redraw_clip,
             gpointer frame, gpointer user_data)
{
    gpointer framebuffer, context;
    Matrix modelview;

    if (!marks.root || clutter_actor_get_parent (marks.root) != stage)
        return;
    framebuffer = clutter_stage_view_get_framebuffer (view);
    context = clutter_paint_context_new_for_framebuffer (
        framebuffer, redraw_clip, 0, clutter_stage_view_get_color_state (view));
    // The stage has taken its own transformation off the framebuffer again.
    clutter_actor_get_transform (stage, &modelview);
    cogl_framebuffer_push_matrix (framebuffer);
    cogl_framebuffer_set_modelview_matrix (framebuffer, &modelview);
    clutter_actor_set_opacity_override (marks.root, -1);
    clutter_actor_paint (marks.root, context);
    clutter_actor_set_opacity_override (marks.root, 0);
    cogl_framebuffer_pop_matrix (framebuffer);
    clutter_paint_context_destroy (context);
}

static gboolean sync_watches (gpointer data);

// Before a frame of a monitor is painted. Mutter has not yet taken the part
// of the monitor that the frame paints again.
//
// Mutter calls the functions of a phase in the order of its list, and a
// cast that starts adds its own to the end. Before every frame the paint
// function is taken out and added again, so it is the last one when the
// frame is painted. The list of this phase is another one, which Mutter is
// going through now, so nothing is taken out of it here.
static void
before_paint (gpointer stage, gpointer view, gconstpointer redraw_clip,
              gpointer frame, gpointer user_data)
{
    Rect layout;

    if (!marks.root) {
        // The actor was destroyed with no word from the extension.
        if (!marks.sync_id)
            marks.sync_id = g_idle_add (sync_watches, NULL);
        return;
    }
    if (marks.after)
        meta_stage_remove_watch (stage, marks.after);
    marks.after = meta_stage_watch_view (stage, NULL, WATCH_AFTER_PAINT, after_paint, NULL);

    // What was painted over in an earlier frame is painted again.
    clutter_stage_view_get_layout (view, &layout);
    for (gpointer group = clutter_actor_get_first_child (marks.root); group;
         group = clutter_actor_get_next_sibling (group)) {
        for (gpointer piece = clutter_actor_get_first_child (group); piece;
             piece = clutter_actor_get_next_sibling (piece)) {
            RectF extents = { 0 };
            int x1, y1, x2, y2;

            clutter_actor_get_transformed_extents (piece, &extents);
            // Two px more on each side: the numbers are cut to whole
            // ones, and a scaled picture is filtered.
            x1 = MAX ((int) extents.x - 2, layout.x);
            y1 = MAX ((int) extents.y - 2, layout.y);
            x2 = MIN ((int) (extents.x + extents.width) + 2, layout.x + layout.width);
            y2 = MIN ((int) (extents.y + extents.height) + 2, layout.y + layout.height);
            if (x2 > x1 && y2 > y1) {
                Rect clip = { x1, y1, x2 - x1, y2 - y1 };

                clutter_stage_view_add_redraw_clip (view, &clip);
            }
        }
    }
}

static gboolean
sync_watches (gpointer data)
{
    marks.sync_id = 0;
    if (marks.root && !marks.before) {
        marks.stage = shell_global_get_stage (shell_global_get ());
        marks.before = meta_stage_watch_view (marks.stage, NULL, WATCH_BEFORE_PAINT,
                                              before_paint, NULL);
    } else if (!marks.root && marks.before) {
        meta_stage_remove_watch (marks.stage, marks.before);
        if (marks.after)
            meta_stage_remove_watch (marks.stage, marks.after);
        marks.before = marks.after = NULL;
    }
    return G_SOURCE_REMOVE;
}

// --------------------------------------------------------------- the object

static GVariant *
kelp_capture_streams (GObject *object)
{
    GVariantBuilder builder;

    g_variant_builder_init (&builder, G_VARIANT_TYPE ("a(ossstiiiib)"));
    for (guint i = 0; i < self.streams->len; i++) {
        Stream *stream = g_ptr_array_index (self.streams, i);

        g_variant_builder_add (&builder, "(ossstiiiib)", stream->path, stream->session,
                               stream->kind, stream->connector ? stream->connector : "",
                               stream->window, stream->x, stream->y,
                               stream->width, stream->height, stream->recording);
    }
    return g_variant_ref_sink (g_variant_builder_end (&builder));
}

static void
kelp_capture_forget (GObject *object, const char *path)
{
    for (guint i = 0; path && i < self.streams->len; i++) {
        Stream *stream = g_ptr_array_index (self.streams, i);

        if (strcmp (stream->path, path) == 0) {
            g_ptr_array_remove_index (self.streams, i);
            changed ();
            return;
        }
    }
}

static void
kelp_capture_set_root (GObject *object, GObject *actor)
{
    if (marks.root == actor)
        return;
    if (marks.root) {
        g_object_remove_weak_pointer (marks.root, &marks.root);
        clutter_actor_set_opacity_override (marks.root, -1);
    }
    marks.root = actor;
    if (actor) {
        g_object_add_weak_pointer (actor, &marks.root);
        clutter_actor_set_opacity_override (actor, 0);
    }
    if (marks.sync_id)
        g_source_remove (marks.sync_id);
    sync_watches (NULL);
}

typedef GObject KelpCapture;
typedef GObjectClass KelpCaptureClass;

static void
kelp_capture_weak (gpointer data, GObject *gone)
{
    if (self.object == gone)
        self.object = NULL;
}

static void
kelp_capture_init (GTypeInstance *instance, gpointer klass)
{
    // The newest object is the one the extension holds.
    self.object = G_OBJECT (instance);
    g_object_weak_ref (self.object, kelp_capture_weak, NULL);
}

static void
kelp_capture_class_init (gpointer klass, gpointer data)
{
    GType type = G_TYPE_FROM_CLASS (klass);
    GSignalFlags action = G_SIGNAL_RUN_LAST | G_SIGNAL_ACTION;

    signal_changed = g_signal_new ("changed", type, G_SIGNAL_RUN_LAST, 0,
                                   NULL, NULL, NULL, G_TYPE_NONE, 0);
    g_signal_new_class_handler ("streams", type, action, G_CALLBACK (kelp_capture_streams),
                                NULL, NULL, NULL, G_TYPE_VARIANT, 0);
    g_signal_new_class_handler ("forget", type, action, G_CALLBACK (kelp_capture_forget),
                                NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_STRING);
    g_signal_new_class_handler ("set-root", type, action, G_CALLBACK (kelp_capture_set_root),
                                NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_OBJECT);
}

// -------------------------------------------------------------------- module

void
g_io_module_load (GIOModule *module)
{
    static gboolean loaded;
    g_autoptr (GDBusConnection) bus = NULL;

    if (loaded)
        return;
    loaded = TRUE;
    // The filter and the watches point into this code, so it stays in
    // memory for the life of the shell.
    g_type_module_use (G_TYPE_MODULE (module));

    self.streams = g_ptr_array_new_with_free_func (stream_free);
    self.pending = g_ptr_array_new_with_free_func (stream_free);
    g_mutex_init (&self.lock);
    // The connection Mutter has its screen cast objects on.
    bus = g_bus_get_sync (G_BUS_TYPE_SESSION, NULL, NULL);
    if (bus)
        g_dbus_connection_add_filter (bus, filter, NULL, NULL);
    g_type_register_static_simple (G_TYPE_OBJECT, "KelpCapture",
                                   sizeof (KelpCaptureClass), kelp_capture_class_init,
                                   sizeof (KelpCapture), kelp_capture_init, 0);
}

void
g_io_module_unload (GIOModule *module)
{
}
