// SPDX-License-Identifier: GPL-3.0-or-later

// Touchpad scroll events, handed to the extension before any window gets
// them.
//
// Every toolkit turns the same scroll event into a distance of its own, and
// goes on scrolling in its own way once the fingers are off the touchpad.
// Measured with one event stream sent to three windows: GTK 4 moves 2.5 px
// for each unit, Firefox 4 px and Chromium 12 px, and after the end of the
// stream they go on for 870, 2460 and 2990 px. lib/scroll.js
// makes them equal: it changes the size of the events by the toolkit of the
// window under the pointer, and sends the events of the time after the
// fingers have left itself.
//
// For that the extension has to see a scroll event first and send others in
// its place. The shell's JavaScript never sees an event that goes to a
// window: Mutter gives each event to the Wayland client of that window in an
// event filter of its own, which runs before every other filter and before
// the stage's signals. GNOME's own setting for this, "scroll-speed" of
// org.gnome.desktop.peripherals.touchpad, is in the settings schema, and
// Mutter 51.1 does not read it.
//
// Mutter takes each event from Clutter's queue and passes it to
// clutter_stage_handle_event(), in one place (dispatch_clutter_event() in
// src/backends/meta-backend.c). That is a call from libmutter into
// libmutter-clutter, so it goes through an entry of libmutter's table of
// imported functions. This module puts the address of handle_event() below
// into that entry. Every event then comes here first:
//
//   - a touchpad scroll event is offered to the extension, the "scroll"
//     signal. When a handler returns true the event goes no further. The
//     handler has sent what it wants in its place with "send".
//   - while "watch" is on, a key press, a button press and the start of a
//     touch on the touchpad are announced with "interrupt", and go on as
//     they are.
//   - everything else goes on to Clutter untouched, and so does every event
//     while no handler is connected.
//
// The extension reaches the module through a GObject of the type
// KelpScroll, which it finds by name:
//
//   scroll     (actor: ClutterActor or null, time: int64, dx, dy: double,
//               finish: uint, source: uint, x, y: double, modifiers: uint)
//              -> boolean
//              A scroll event of a touchpad (source 2, fingers) or of a
//              pointing stick (source 3). actor is under the pointer. time
//              is in microseconds, dx and dy are in Clutter's unit, a tenth
//              of what a Wayland client is told. finish has bit 0 or 1 set
//              when the horizontal or vertical scroll has ended.
//   send       (dx, dy: double, finish: uint, x, y: double, modifiers: uint,
//               time: int64)
//              Pass a scroll event to Clutter, as from the device of the
//              last event offered. Called from a "scroll" handler it takes
//              the place and the modifiers of that event, and x, y and
//              modifiers are not read. At any other time it takes the
//              three as they are given. time is in microseconds; 0 is the
//              time of the event the handler runs for, or of the call.
//   watch      (on: boolean)
//   interrupt  (type: uint)   The Clutter type of the event.
//   hooked     () -> boolean  False when the entry was not found in
//              libmutter: nothing is offered then.
//
// Clutter and Mutter are declared below and not included, as in
// decorations.c, and the module is built for one version of the shell. Only
// the two processor types Fedora builds the shell for are handled.

#define _GNU_SOURCE
#include <gio/gio.h>
#include <elf.h>
#include <link.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

// ------------------------------------------------------------------- clutter

// graphene_point_t.
typedef struct {
    float x;
    float y;
} Point;

enum {
    EVENT_KEY_PRESS = 1,
    EVENT_BUTTON_PRESS = 6,
    EVENT_SCROLL = 8,
    EVENT_TOUCH_BEGIN = 9,
    EVENT_TOUCHPAD_HOLD = 15,
};
enum { SCROLL_SMOOTH = 4 };
enum { SOURCE_FINGER = 2, SOURCE_CONTINUOUS = 3 };
enum { GESTURE_BEGIN = 0 };

extern void clutter_stage_handle_event (gpointer stage, gpointer event);
extern gpointer clutter_stage_get_event_actor (gpointer stage, gconstpointer event);
extern int clutter_event_type (gconstpointer event);
extern int clutter_event_get_flags (gconstpointer event);
extern int64_t clutter_event_get_time_us (gconstpointer event);
extern int clutter_event_get_state (gconstpointer event);
extern void clutter_event_get_position (gconstpointer event, Point *position);
extern gpointer clutter_event_get_source_device (gconstpointer event);
extern gpointer clutter_event_get_device_tool (gconstpointer event);
extern int clutter_event_get_scroll_direction (gconstpointer event);
extern int clutter_event_get_scroll_source (gconstpointer event);
extern int clutter_event_get_scroll_flags (gconstpointer event);
extern int clutter_event_get_scroll_finish_flags (gconstpointer event);
extern void clutter_event_get_scroll_delta (gconstpointer event, double *dx, double *dy);
extern int clutter_event_get_gesture_phase (gconstpointer event);
extern gpointer clutter_event_copy (gconstpointer event);
extern void clutter_event_free (gpointer event);
extern gpointer clutter_event_scroll_smooth_new (int flags, int64_t time_us,
                                                 gpointer source_device, gpointer tool,
                                                 int modifiers, Point coords, Point delta,
                                                 int scroll_flags, int scroll_source,
                                                 int finish_flags);

// --------------------------------------------------------------------- state

static struct {
    GObject *object;      // the KelpScroll the extension holds, not referenced
    gboolean hooked;
    gboolean watch;
    gpointer stage;       // of the last event
    gpointer current;     // the event a "scroll" handler is running for
    gpointer last;        // a copy of the last scroll event offered
} self;

static guint signal_scroll;
static guint signal_interrupt;

// ---------------------------------------------------------------------- hook

static gboolean
has_handler (guint signal)
{
    return self.object &&
        g_signal_has_handler_pending (self.object, signal, 0, TRUE);
}

static void
handle_event (gpointer stage, gpointer event)
{
    int type = clutter_event_type (event);

    self.stage = stage;
    if (type == EVENT_SCROLL && !self.current && has_handler (signal_scroll) &&
        clutter_event_get_scroll_direction (event) == SCROLL_SMOOTH) {
        int source = clutter_event_get_scroll_source (event);

        if (source == SOURCE_FINGER || source == SOURCE_CONTINUOUS) {
            gboolean handled = FALSE;
            double dx, dy;
            Point at;

            clutter_event_get_scroll_delta (event, &dx, &dy);
            clutter_event_get_position (event, &at);
            if (self.last)
                clutter_event_free (self.last);
            self.last = clutter_event_copy (event);
            self.current = event;
            g_signal_emit (self.object, signal_scroll, 0,
                           clutter_stage_get_event_actor (stage, event),
                           clutter_event_get_time_us (event), dx, dy,
                           (guint) clutter_event_get_scroll_finish_flags (event),
                           (guint) source, (double) at.x, (double) at.y,
                           (guint) clutter_event_get_state (event), &handled);
            self.current = NULL;
            if (handled)
                return;
        }
    } else if (self.watch && has_handler (signal_interrupt) &&
               (type == EVENT_KEY_PRESS || type == EVENT_BUTTON_PRESS ||
                type == EVENT_TOUCH_BEGIN ||
                (type == EVENT_TOUCHPAD_HOLD &&
                 clutter_event_get_gesture_phase (event) == GESTURE_BEGIN))) {
        g_signal_emit (self.object, signal_interrupt, 0, (guint) type);
    }
    clutter_stage_handle_event (stage, event);
}

static void
kelp_scroll_send (GObject *object, double dx, double dy, guint finish,
                  double x, double y, guint modifiers, int64_t time)
{
    gconstpointer from = self.current ? self.current : self.last;
    Point at = {(float) x, (float) y};
    gpointer event;

    if (!from || !self.stage)
        return;
    if (time <= 0)
        time = self.current ? clutter_event_get_time_us (from) : g_get_monotonic_time ();
    if (self.current) {
        clutter_event_get_position (from, &at);
        modifiers = clutter_event_get_state (from);
    }
    event = clutter_event_scroll_smooth_new (clutter_event_get_flags (from), time,
                                             clutter_event_get_source_device (from),
                                             clutter_event_get_device_tool (from),
                                             modifiers, at,
                                             (Point) {(float) dx, (float) dy},
                                             clutter_event_get_scroll_flags (from),
                                             clutter_event_get_scroll_source (from),
                                             finish);
    if (!event)
        return;
    clutter_stage_handle_event (self.stage, event);
    clutter_event_free (event);
}

static void
kelp_scroll_watch (GObject *object, gboolean on)
{
    self.watch = on;
}

static gboolean
kelp_scroll_hooked (GObject *object)
{
    return self.hooked;
}

// ------------------------------------------------- libmutter's import table

#if defined (__x86_64__)
#define RELOC_JUMP_SLOT R_X86_64_JUMP_SLOT
#define RELOC_GLOB_DAT R_X86_64_GLOB_DAT
#elif defined (__aarch64__)
#define RELOC_JUMP_SLOT R_AARCH64_JUMP_SLOT
#define RELOC_GLOB_DAT R_AARCH64_GLOB_DAT
#endif

#ifdef RELOC_JUMP_SLOT

// libmutter-51.so.0, and not libmutter-clutter-51.so.0.
static gboolean
is_libmutter (const char *path)
{
    const char *name = path ? strrchr (path, '/') : NULL;

    name = name ? name + 1 : path;
    return name && g_str_has_prefix (name, "libmutter-") && g_ascii_isdigit (name[10]);
}

// The address in a dynamic section: glibc has added the address the object
// is loaded at to it, on the two processor types above.
static uintptr_t
address (const struct dl_phdr_info *info, ElfW (Addr) value)
{
    return value < info->dlpi_addr ? info->dlpi_addr + value : value;
}

static void **
find_in (const struct dl_phdr_info *info, const ElfW (Rela) *rela, size_t size,
         const ElfW (Sym) *symbols, const char *strings, const char *wanted)
{
    size_t i;

    for (i = 0; rela && i < size / sizeof (ElfW (Rela)); i++) {
        unsigned long type = ELF64_R_TYPE (rela[i].r_info);

        if (type != RELOC_JUMP_SLOT && type != RELOC_GLOB_DAT)
            continue;
        if (!strcmp (strings + symbols[ELF64_R_SYM (rela[i].r_info)].st_name, wanted))
            return (void **) (info->dlpi_addr + rela[i].r_offset);
    }
    return NULL;
}

struct search {
    const char *wanted;
    void **entry;
    gboolean read_only;   // the entry is in the part glibc has made read-only
};

static int
search_object (struct dl_phdr_info *info, size_t size, void *data)
{
    struct search *search = data;
    const ElfW (Dyn) *dynamic = NULL;
    const ElfW (Sym) *symbols = NULL;
    const ElfW (Rela) *plt = NULL, *rela = NULL;
    const char *strings = NULL;
    size_t plt_size = 0, rela_size = 0;
    int i;

    if (!is_libmutter (info->dlpi_name))
        return 0;
    for (i = 0; i < info->dlpi_phnum; i++) {
        if (info->dlpi_phdr[i].p_type == PT_DYNAMIC)
            dynamic = (const ElfW (Dyn) *) (info->dlpi_addr + info->dlpi_phdr[i].p_vaddr);
    }
    for (; dynamic && dynamic->d_tag != DT_NULL; dynamic++) {
        switch (dynamic->d_tag) {
        case DT_SYMTAB: symbols = (gpointer) address (info, dynamic->d_un.d_ptr); break;
        case DT_STRTAB: strings = (gpointer) address (info, dynamic->d_un.d_ptr); break;
        case DT_JMPREL: plt = (gpointer) address (info, dynamic->d_un.d_ptr); break;
        case DT_RELA: rela = (gpointer) address (info, dynamic->d_un.d_ptr); break;
        case DT_PLTRELSZ: plt_size = dynamic->d_un.d_val; break;
        case DT_RELASZ: rela_size = dynamic->d_un.d_val; break;
        }
    }
    if (!symbols || !strings)
        return 1;
    search->entry = find_in (info, plt, plt_size, symbols, strings, search->wanted);
    if (!search->entry)
        search->entry = find_in (info, rela, rela_size, symbols, strings, search->wanted);
    for (i = 0; search->entry && i < info->dlpi_phnum; i++) {
        const ElfW (Phdr) *header = &info->dlpi_phdr[i];
        uintptr_t start = info->dlpi_addr + header->p_vaddr;

        if (header->p_type == PT_GNU_RELRO && (uintptr_t) search->entry >= start &&
            (uintptr_t) search->entry < start + header->p_memsz)
            search->read_only = TRUE;
    }
    return 1;
}

// Make libmutter call handle_event() where it calls
// clutter_stage_handle_event(). The entry is changed only while it holds
// the address of that function.
static gboolean
hook (void)
{
    struct search search = {"clutter_stage_handle_event", NULL, FALSE};
    long page = sysconf (_SC_PAGESIZE);
    void *start;

    dl_iterate_phdr (search_object, &search);
    if (!search.entry || *search.entry != (void *) clutter_stage_handle_event)
        return FALSE;
    start = (void *) ((uintptr_t) search.entry & ~((uintptr_t) page - 1));
    if (search.read_only && mprotect (start, page, PROT_READ | PROT_WRITE) != 0)
        return FALSE;
    *search.entry = (void *) handle_event;
    if (search.read_only)
        mprotect (start, page, PROT_READ);
    return TRUE;
}

#else

static gboolean
hook (void)
{
    return FALSE;
}

#endif

// -------------------------------------------------------------------- object

typedef GObject KelpScroll;
typedef GObjectClass KelpScrollClass;

static void
kelp_scroll_weak (gpointer data, GObject *gone)
{
    if (self.object != gone)
        return;
    self.object = NULL;
    // The copy of the last event is of no use to the next object.
    g_clear_pointer (&self.last, clutter_event_free);
}

static void
kelp_scroll_init (GTypeInstance *instance, gpointer klass)
{
    // The extension makes one. The events go to the newest.
    self.object = G_OBJECT (instance);
    self.watch = FALSE;
    g_object_weak_ref (self.object, kelp_scroll_weak, NULL);
}

static void
kelp_scroll_class_init (gpointer klass, gpointer data)
{
    GType type = G_TYPE_FROM_CLASS (klass);
    GSignalFlags action = G_SIGNAL_RUN_LAST | G_SIGNAL_ACTION;

    signal_scroll = g_signal_new ("scroll", type, G_SIGNAL_RUN_LAST, 0,
                                  g_signal_accumulator_true_handled, NULL, NULL,
                                  G_TYPE_BOOLEAN, 9,
                                  G_TYPE_OBJECT, G_TYPE_INT64, G_TYPE_DOUBLE, G_TYPE_DOUBLE,
                                  G_TYPE_UINT, G_TYPE_UINT, G_TYPE_DOUBLE, G_TYPE_DOUBLE,
                                  G_TYPE_UINT);
    signal_interrupt = g_signal_new ("interrupt", type, G_SIGNAL_RUN_LAST, 0,
                                     NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_UINT);
    g_signal_new_class_handler ("send", type, action, G_CALLBACK (kelp_scroll_send),
                                NULL, NULL, NULL, G_TYPE_NONE, 7,
                                G_TYPE_DOUBLE, G_TYPE_DOUBLE, G_TYPE_UINT,
                                G_TYPE_DOUBLE, G_TYPE_DOUBLE, G_TYPE_UINT, G_TYPE_INT64);
    g_signal_new_class_handler ("watch", type, action, G_CALLBACK (kelp_scroll_watch),
                                NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_BOOLEAN);
    g_signal_new_class_handler ("hooked", type, action, G_CALLBACK (kelp_scroll_hooked),
                                NULL, NULL, NULL, G_TYPE_BOOLEAN, 0);
}

// -------------------------------------------------------------------- module

void
g_io_module_load (GIOModule *module)
{
    static gboolean loaded;

    if (loaded)
        return;
    loaded = TRUE;
    // libmutter calls into this code for every event from now on, so it
    // stays in memory for the life of the shell.
    g_type_module_use (G_TYPE_MODULE (module));

    self.hooked = hook ();
    g_type_register_static_simple (G_TYPE_OBJECT, "KelpScroll",
                                   sizeof (KelpScrollClass), kelp_scroll_class_init,
                                   sizeof (KelpScroll), kelp_scroll_init, 0);
}

void
g_io_module_unload (GIOModule *module)
{
}
