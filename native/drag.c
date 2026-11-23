// Dragging files from the shell into a Wayland client.
//
// In Wayland a drag starts in a client: the compositor carries the offer
// from one client to another. Mutter has no way to start one itself, so a
// file shown by the shell (the downloads pile, lib/downloads.js) could not
// be dropped on a window.
//
// This module is the source of such a drag. The extension moves a picture
// of the file with the pointer (the shell's own drag code) and tells this
// module which window is under the pointer. The module speaks the
// wl_data_device protocol to the client of that window: it offers the files
// as text/uri-list, sends enter, motion, leave and drop, and writes the list
// to the client when it asks for it. To the client this is a drag like any
// other.
//
// A client under Xwayland does not take part: Mutter turns Wayland drags
// into X11 ones inside its own drag code, which is not used here.
//
// The extension reaches the module through a GObject of the type KelpDrag,
// which it finds by name. It has four action signals:
//
//   begin   (uris: string)  start a drag of these URIs, one per line
//   motion  (window: MetaWindow or null, x, y: double, time: uint) -> boolean
//           the pointer is at (x, y) of the window's surface, or over no
//           window. True when the client would take a drop.
//   drop    () -> boolean   the button was released. True when the client
//           was told to take the files.
//   cancel  ()              end the drag with no drop
//
// libwayland-server and Mutter are declared below and not included, as in
// decorations.c, and the module is built for one version of the shell.

#include <gio/gio.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

// ---------------------------------------------------------------- libwayland

struct wl_display;
struct wl_client;
struct wl_resource;
struct wl_interface;

struct wl_list {
    struct wl_list *prev;
    struct wl_list *next;
};

struct wl_listener {
    struct wl_list link;
    void (*notify) (struct wl_listener *listener, void *data);
};

enum { ITERATOR_STOP = 0, ITERATOR_CONTINUE = 1 };

typedef void (*wl_resource_destroy_func_t) (struct wl_resource *resource);
typedef int (*wl_client_for_each_resource_iterator_func_t) (struct wl_resource *resource,
                                                            void *user_data);

extern const struct wl_interface wl_data_offer_interface;

extern struct wl_resource *wl_resource_create (struct wl_client *client,
                                               const struct wl_interface *interface,
                                               int version, uint32_t id);
extern void wl_resource_set_implementation (struct wl_resource *resource,
                                            const void *implementation, void *data,
                                            wl_resource_destroy_func_t destroy);
extern void *wl_resource_get_user_data (struct wl_resource *resource);
extern struct wl_client *wl_resource_get_client (struct wl_resource *resource);
extern int wl_resource_get_version (struct wl_resource *resource);
extern const char *wl_resource_get_class (struct wl_resource *resource);
extern void wl_resource_post_event (struct wl_resource *resource, uint32_t opcode, ...);
extern void wl_resource_destroy (struct wl_resource *resource);
extern void wl_resource_add_destroy_listener (struct wl_resource *resource,
                                              struct wl_listener *listener);
extern void wl_list_remove (struct wl_list *elm);
extern void wl_list_init (struct wl_list *list);
extern void wl_client_for_each_resource (struct wl_client *client,
                                         wl_client_for_each_resource_iterator_func_t iterator,
                                         void *user_data);
extern uint32_t wl_display_next_serial (struct wl_display *display);

// wl_data_device events
#define DEVICE_DATA_OFFER 0
#define DEVICE_ENTER 1
#define DEVICE_LEAVE 2
#define DEVICE_MOTION 3
#define DEVICE_DROP 4
// wl_data_offer events
#define OFFER_OFFER 0
#define OFFER_SOURCE_ACTIONS 1
#define OFFER_ACTION 2
// wl_data_device_manager.dnd_action
#define ACTION_NONE 0
#define ACTION_COPY 1

#define FIXED(v) ((int32_t) ((v) * 256.0))

// -------------------------------------------------------------------- Mutter

extern gpointer shell_global_get (void);
extern gpointer shell_global_get_context (gpointer global);
extern gpointer meta_context_get_wayland_compositor (gpointer context);
extern struct wl_display *meta_wayland_compositor_get_wayland_display (gpointer compositor);
extern gpointer meta_window_get_wayland_surface (gpointer window);
extern struct wl_resource *meta_wayland_surface_get_resource (gpointer surface);

// ---------------------------------------------------------------------- drag

static struct wl_display *display;

// What one client was offered. It lives as long as the client keeps the
// wl_data_offer, which is past the end of the drag: the client reads the
// files after the drop.
typedef struct {
    char *uris;         // text/uri-list: one URI per line, CR LF
    char *paths;        // text/plain: one path per line
    gboolean accepted;  // the client named a type it takes
    uint32_t action;    // the action chosen with the client, version 3
    int version;
} Offer;

static struct {
    gboolean active;
    char *uris;
    char *paths;
    struct wl_resource *surface;   // under the pointer
    struct wl_resource *device;    // the wl_data_device of its client
    struct wl_resource *offer;     // what that client was offered
    struct wl_listener surface_gone;
    struct wl_listener device_gone;
    struct wl_listener offer_gone;
} drag;

static void
offer_free (struct wl_resource *resource)
{
    Offer *offer = wl_resource_get_user_data (resource);

    g_free (offer->uris);
    g_free (offer->paths);
    g_free (offer);
}

static void
offer_accept (struct wl_client *client, struct wl_resource *resource,
              uint32_t serial, const char *mime_type)
{
    Offer *offer = wl_resource_get_user_data (resource);

    offer->accepted = mime_type != NULL;
}

static void
offer_receive (struct wl_client *client, struct wl_resource *resource,
               const char *mime_type, int32_t fd)
{
    Offer *offer = wl_resource_get_user_data (resource);
    const char *text = g_str_has_prefix (mime_type, "text/uri-list") ? offer->uris : offer->paths;
    size_t left = strlen (text);

    // A list of file names is far below the size of a pipe, so the write
    // does not wait for the client.
    while (left > 0) {
        ssize_t n = write (fd, text, left);

        if (n <= 0)
            break;
        text += n;
        left -= n;
    }
    close (fd);
}

static void
offer_destroy (struct wl_client *client, struct wl_resource *resource)
{
    wl_resource_destroy (resource);
}

static void
offer_finish (struct wl_client *client, struct wl_resource *resource)
{
}

static void
offer_set_actions (struct wl_client *client, struct wl_resource *resource,
                   uint32_t actions, uint32_t preferred)
{
    Offer *offer = wl_resource_get_user_data (resource);
    uint32_t action = (actions & ACTION_COPY) ? ACTION_COPY : ACTION_NONE;

    if (action == offer->action)
        return;
    offer->action = action;
    wl_resource_post_event (resource, OFFER_ACTION, action);
}

static const struct {
    void (*accept) (struct wl_client *, struct wl_resource *, uint32_t, const char *);
    void (*receive) (struct wl_client *, struct wl_resource *, const char *, int32_t);
    void (*destroy) (struct wl_client *, struct wl_resource *);
    void (*finish) (struct wl_client *, struct wl_resource *);
    void (*set_actions) (struct wl_client *, struct wl_resource *, uint32_t, uint32_t);
} offer_implementation = {
    offer_accept,
    offer_receive,
    offer_destroy,
    offer_finish,
    offer_set_actions,
};

static int
find_device (struct wl_resource *resource, void *user_data)
{
    struct wl_resource **found = user_data;

    if (g_strcmp0 (wl_resource_get_class (resource), "wl_data_device") != 0)
        return ITERATOR_CONTINUE;
    *found = resource;
    return ITERATOR_STOP;
}

/** Forget the client under the pointer, without a word to it. */
static void
unfocus (void)
{
    if (drag.surface)
        wl_list_remove (&drag.surface_gone.link);
    if (drag.device)
        wl_list_remove (&drag.device_gone.link);
    if (drag.offer)
        wl_list_remove (&drag.offer_gone.link);
    drag.surface = drag.device = drag.offer = NULL;
}

static void
on_surface_gone (struct wl_listener *listener, void *data)
{
    // The client learns that its surface is gone from its own request.
    unfocus ();
}

static void
on_device_gone (struct wl_listener *listener, void *data)
{
    unfocus ();
}

static void
on_offer_gone (struct wl_listener *listener, void *data)
{
    wl_list_remove (&drag.offer_gone.link);
    drag.offer = NULL;
}

static void
leave (void)
{
    if (drag.device)
        wl_resource_post_event (drag.device, DEVICE_LEAVE);
    unfocus ();
}

static void
enter (struct wl_resource *surface, double x, double y)
{
    struct wl_client *client = wl_resource_get_client (surface);
    struct wl_resource *device = NULL;
    struct wl_resource *resource;
    Offer *offer;

    drag.surface = surface;
    drag.surface_gone.notify = on_surface_gone;
    wl_resource_add_destroy_listener (surface, &drag.surface_gone);

    wl_client_for_each_resource (client, find_device, &device);
    if (!device)
        return;
    resource = wl_resource_create (client, &wl_data_offer_interface,
                                   wl_resource_get_version (device), 0);
    if (!resource)
        return;
    offer = g_new0 (Offer, 1);
    offer->uris = g_strdup (drag.uris);
    offer->paths = g_strdup (drag.paths);
    offer->version = wl_resource_get_version (device);
    wl_resource_set_implementation (resource, &offer_implementation, offer, offer_free);

    drag.device = device;
    drag.device_gone.notify = on_device_gone;
    wl_resource_add_destroy_listener (device, &drag.device_gone);
    drag.offer = resource;
    drag.offer_gone.notify = on_offer_gone;
    wl_resource_add_destroy_listener (resource, &drag.offer_gone);

    wl_resource_post_event (device, DEVICE_DATA_OFFER, resource);
    wl_resource_post_event (resource, OFFER_OFFER, "text/uri-list");
    wl_resource_post_event (resource, OFFER_OFFER, "text/plain;charset=utf-8");
    wl_resource_post_event (resource, OFFER_OFFER, "text/plain");
    if (offer->version >= 3)
        wl_resource_post_event (resource, OFFER_SOURCE_ACTIONS, (uint32_t) ACTION_COPY);
    wl_resource_post_event (device, DEVICE_ENTER, wl_display_next_serial (display),
                            surface, FIXED (x), FIXED (y), resource);
}

/** Whether the client under the pointer would take a drop now. */
static gboolean
wanted (void)
{
    Offer *offer;

    if (!drag.device || !drag.offer)
        return FALSE;
    offer = wl_resource_get_user_data (drag.offer);
    return offer->accepted && (offer->version < 3 || offer->action != ACTION_NONE);
}

static void
end (void)
{
    unfocus ();
    g_clear_pointer (&drag.uris, g_free);
    g_clear_pointer (&drag.paths, g_free);
    drag.active = FALSE;
}

// --------------------------------------------------------------- the object

static void
kelp_drag_begin (GObject *object, const char *uris)
{
    g_auto (GStrv) lines = NULL;
    g_autoptr (GString) list = g_string_new (NULL);
    g_autoptr (GString) paths = g_string_new (NULL);

    if (drag.active) {
        leave ();
        end ();
    }
    if (!display || !uris)
        return;
    lines = g_strsplit (uris, "\n", -1);
    for (char **line = lines; *line; line++) {
        g_autofree char *path = NULL;

        if (!**line)
            continue;
        g_string_append_printf (list, "%s\r\n", *line);
        path = g_filename_from_uri (*line, NULL, NULL);
        if (paths->len > 0)
            g_string_append_c (paths, '\n');
        g_string_append (paths, path ? path : *line);
    }
    if (list->len == 0)
        return;
    drag.uris = g_string_free (g_steal_pointer (&list), FALSE);
    drag.paths = g_string_free (g_steal_pointer (&paths), FALSE);
    drag.active = TRUE;
}

static gboolean
kelp_drag_motion (GObject *object, GObject *window, double x, double y, guint time)
{
    gpointer surface_object = window ? meta_window_get_wayland_surface (window) : NULL;
    struct wl_resource *surface =
        surface_object ? meta_wayland_surface_get_resource (surface_object) : NULL;

    if (!drag.active)
        return FALSE;
    if (surface != drag.surface) {
        leave ();
        if (surface)
            enter (surface, x, y);
    } else if (drag.device) {
        wl_resource_post_event (drag.device, DEVICE_MOTION, (uint32_t) time, FIXED (x), FIXED (y));
    }
    return wanted ();
}

static gboolean
kelp_drag_drop (GObject *object)
{
    gboolean dropped;

    if (!drag.active)
        return FALSE;
    dropped = wanted ();
    // Mutter sends leave after drop as well. The offer stays with the
    // client, which reads the files from it and then destroys it.
    if (dropped)
        wl_resource_post_event (drag.device, DEVICE_DROP);
    leave ();
    end ();
    return dropped;
}

static void
kelp_drag_cancel (GObject *object)
{
    if (!drag.active)
        return;
    leave ();
    end ();
}

typedef GObject KelpDrag;
typedef GObjectClass KelpDragClass;

static void
kelp_drag_class_init (gpointer klass, gpointer data)
{
    GType type = G_TYPE_FROM_CLASS (klass);
    GSignalFlags flags = G_SIGNAL_RUN_LAST | G_SIGNAL_ACTION;

    g_signal_new_class_handler ("begin", type, flags, G_CALLBACK (kelp_drag_begin),
                                NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_STRING);
    g_signal_new_class_handler ("motion", type, flags, G_CALLBACK (kelp_drag_motion),
                                NULL, NULL, NULL, G_TYPE_BOOLEAN, 4,
                                G_TYPE_OBJECT, G_TYPE_DOUBLE, G_TYPE_DOUBLE, G_TYPE_UINT);
    g_signal_new_class_handler ("drop", type, flags, G_CALLBACK (kelp_drag_drop),
                                NULL, NULL, NULL, G_TYPE_BOOLEAN, 0);
    g_signal_new_class_handler ("cancel", type, flags, G_CALLBACK (kelp_drag_cancel),
                                NULL, NULL, NULL, G_TYPE_NONE, 0);
}

// -------------------------------------------------------------------- module

void
g_io_module_load (GIOModule *module)
{
    static gboolean loaded;
    gpointer compositor;

    if (loaded)
        return;
    loaded = TRUE;
    // Clients hold objects whose requests are handled by this code, so it
    // stays in memory for the life of the shell.
    g_type_module_use (G_TYPE_MODULE (module));

    compositor = meta_context_get_wayland_compositor (shell_global_get_context (shell_global_get ()));
    if (!compositor)
        return;
    display = meta_wayland_compositor_get_wayland_display (compositor);
    g_type_register_static_simple (G_TYPE_OBJECT, "KelpDrag",
                                   sizeof (KelpDragClass), kelp_drag_class_init,
                                   sizeof (KelpDrag), NULL, 0);
}

void
g_io_module_unload (GIOModule *module)
{
}
