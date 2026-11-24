// SPDX-License-Identifier: GPL-3.0-or-later

// The size of an X11 window after the scale of Xwayland has changed.
//
// Xwayland has one scale for all its windows: the highest scale of a monitor,
// rounded up. A window that is W wide on the screen is W x scale pixels wide
// to its client. The scale changes when the only monitor with that scale
// comes or goes: 2 to 1 when the lid of a laptop at scale 2 closes next to a
// monitor at scale 1, and back when it opens.
//
// Mutter 51 gives an X11 client a new size or position only when the window's
// rectangle on the screen has changed: meta_window_x11_move_resize_internal()
// compares the rectangles in screen units. A window that keeps its rectangle
// through a change of the scale keeps the pixels of the old scale. Measured
// with VLC, fullscreen on a 2560 x 1440 monitor at scale 1 beside a panel at
// scale 2, in the shell without extensions too:
//
//   - the panel goes: the client stays 5120 x 2880 in a frame of 2560 x 1440,
//     and a quarter of the picture fills the monitor;
//   - the panel comes back to a client of 2560 x 1440: it is drawn 1280 x 720,
//     in the top left quarter of the monitor.
//
// A window without a frame that is not fullscreen keeps its old position as
// well. Measured with mpv and no border, at 576, 8 on the screen: the X
// server still had it at 576, 8 after the scale went back to 2, where that
// place is 1152, 16.
//
// This module sends such a window the rectangle Mutter has for it, in the
// pixels of the scale that is in effect: the XConfigureWindow request that
// was left out. The X server does nothing for a window that has that
// rectangle already.
//
// The request is sent twice, the first time for a rectangle that is 1 px of
// the screen less high, see lib/x11size.js. Qt (VLC) needs that: its own
// scale follows the DPI in the X settings, which changes with the scale of
// Xwayland, so a window of 5120 x 2880 at 2 and one of 2560 x 1440 at 1 are
// the same 2560 x 1440 to it. Sent that size once, VLC laid out nothing:
// its main window was 2560 x 1440 and the video window inside it stayed
// 5120 x 2832.
//
// The extension reaches the module through a GObject of the type
// KelpX11Size, which it finds by name. It has one action signal:
//
//   resync  (window: MetaWindow, trim: int) -> boolean
//           Send the window its rectangle, trim px of the screen less high.
//           False for a window this does not apply to, see
//           kelp_x11_size_resync().
//
// Xlib and Mutter are declared below and not included, as in decorations.c,
// and the module is built for one version of the shell.

#include <gio/gio.h>

// ---------------------------------------------------------------------- Xlib

typedef struct {
    int x, y;
    int width, height;
    int border_width;
    unsigned long sibling;
    int stack_mode;
} XWindowChanges;

#define CWX (1 << 0)
#define CWY (1 << 1)
#define CWWidth (1 << 2)
#define CWHeight (1 << 3)

extern int XConfigureWindow (gpointer display, unsigned long window,
                             unsigned int mask, XWindowChanges *values);

// -------------------------------------------------------------------- Mutter

typedef struct {
    int x, y;
    int width, height;
} MtkRectangle;

extern GType meta_window_x11_get_type (void);
extern gpointer meta_window_get_display (gpointer window);
extern gpointer meta_display_get_x11_display (gpointer display);
extern gpointer meta_x11_display_get_xdisplay (gpointer x11_display);
extern unsigned long meta_window_x11_get_xwindow (gpointer window);
extern gpointer meta_window_x11_get_frame (gpointer window);
extern gboolean meta_window_is_override_redirect (gpointer window);
extern gboolean meta_window_is_fullscreen (gpointer window);
extern void meta_window_get_frame_rect (gpointer window, MtkRectangle *rect);
extern void meta_window_get_buffer_rect (gpointer window, MtkRectangle *rect);
extern void meta_window_stage_to_protocol_rect (gpointer window,
                                                const MtkRectangle *stage_rect,
                                                MtkRectangle *protocol_rect);
extern void mtk_x11_error_trap_push (gpointer xdisplay);
extern void mtk_x11_error_trap_pop (gpointer xdisplay);

// -------------------------------------------------------------------- resync

/*
 * Which rectangle the client has, by the kind of window:
 *
 *   - Without a frame of Mutter's, the client window is a child of the root
 *     window and has the window's buffer rectangle: position and size.
 *   - Fullscreen with a frame, the frame has no borders. The client fills
 *     it, at 0, 0 of the frame, and has the size of the frame rectangle.
 *     Mutter keeps the frame's own window at the scale in effect.
 *   - With a frame and not fullscreen, the client is smaller than the frame
 *     by its borders, which are not known here. Nothing is sent. Such a
 *     window was measured to get its size from Mutter when the frame's
 *     borders are read again after the change.
 *
 * A window that manages itself (a menu, a tooltip) is not Mutter's to size.
 */
static gboolean
kelp_x11_size_resync (GObject *object, GObject *window, int trim)
{
    gpointer x11_display, xdisplay;
    unsigned long xwindow;
    gboolean framed;
    MtkRectangle stage, protocol;
    XWindowChanges values = { 0 };
    unsigned int mask = CWWidth | CWHeight;

    if (!window || !G_TYPE_CHECK_INSTANCE_TYPE (window, meta_window_x11_get_type ()))
        return FALSE;
    if (meta_window_is_override_redirect (window))
        return FALSE;
    x11_display = meta_display_get_x11_display (meta_window_get_display (window));
    xdisplay = x11_display ? meta_x11_display_get_xdisplay (x11_display) : NULL;
    xwindow = meta_window_x11_get_xwindow (window);
    if (!xdisplay || !xwindow)
        return FALSE;

    framed = meta_window_x11_get_frame (window) != NULL;
    if (framed) {
        if (!meta_window_is_fullscreen (window))
            return FALSE;
        meta_window_get_frame_rect (window, &stage);
    } else {
        meta_window_get_buffer_rect (window, &stage);
        mask |= CWX | CWY;
    }
    if (stage.width <= 0 || stage.height <= 0)
        return FALSE;
    // In the units of the screen, which is 2 px of the X server at scale 2.
    // With 1 px of the X server less at scale 2, VLC laid out nothing.
    if (trim > 0 && stage.height > trim)
        stage.height -= trim;
    meta_window_stage_to_protocol_rect (window, &stage, &protocol);
    values.x = protocol.x;
    values.y = protocol.y;
    values.width = protocol.width;
    values.height = protocol.height;

    // A window that is gone by now answers with an error, which ends the
    // shell when nothing has asked for it.
    mtk_x11_error_trap_push (xdisplay);
    XConfigureWindow (xdisplay, xwindow, mask, &values);
    mtk_x11_error_trap_pop (xdisplay);
    return TRUE;
}

typedef GObject KelpX11Size;
typedef GObjectClass KelpX11SizeClass;

static void
kelp_x11_size_class_init (gpointer klass, gpointer data)
{
    g_signal_new_class_handler ("resync", G_TYPE_FROM_CLASS (klass),
                                G_SIGNAL_RUN_LAST | G_SIGNAL_ACTION,
                                G_CALLBACK (kelp_x11_size_resync),
                                NULL, NULL, NULL, G_TYPE_BOOLEAN, 2, G_TYPE_OBJECT, G_TYPE_INT);
}

// -------------------------------------------------------------------- module

void
g_io_module_load (GIOModule *module)
{
    static gboolean loaded;

    if (loaded)
        return;
    loaded = TRUE;
    // The type stays registered, so the code stays in memory for the life
    // of the shell.
    g_type_module_use (G_TYPE_MODULE (module));
    g_type_register_static_simple (G_TYPE_OBJECT, "KelpX11Size",
                                   sizeof (KelpX11SizeClass), kelp_x11_size_class_init,
                                   sizeof (KelpX11Size), NULL, 0);
}

void
g_io_module_unload (GIOModule *module)
{
}
