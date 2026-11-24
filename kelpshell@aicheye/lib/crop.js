// SPDX-License-Identifier: GPL-3.0-or-later

// Windows that draw a frame of their own which cannot be turned off.
//
// A Chromium window asks the compositor for a title bar. GNOME has none to
// give a Wayland client, so Chromium draws its fallback: a blue title bar and
// border inside the window. Spotify is the common case.
//
// A rule in windows.crop names such a window. With the native module
// (decorations.js) the client of a named window is told that the compositor
// draws its title bar, and it draws no frame at all. Without the module the
// rule gives the thickness of the frame on each side: the window is asked
// for a frame that much larger than its tile, and the extra is not drawn
// (corners.js), so the client's content fills the tile.
//
// With "titlebar": true the shell draws a title bar in the place of the
// client's own (titlebar.js). That bar has the height of a GTK title bar,
// and it is above the window's content.

import Meta from 'gi://Meta';
import St from 'gi://St';

const NONE = Object.freeze({top: 0, right: 0, bottom: 0, left: 0, bar: 0});
// Height of the drawn title bar, px: that of the title bar GTK 4 draws for a
// window without a header bar of its own.
const BAR_HEIGHT = 38;

// Whether the client of a window draws no frame because the compositor does
// its decorations: Decorations.serves, while the extension is enabled.
let serves = null;

export function setServes(fn) {
    serves = fn;
}

/**
 * The rule of windows.crop for a window as it is now, or null. A fullscreen
 * or maximized window has none: Chromium draws no frame, or a different one,
 * in those states. X11 clients get a frame from Mutter and never draw this
 * one.
 */
function ruleFor(config, win) {
    const rules = config.values.windows.crop;
    if (!Array.isArray(rules) || rules.length === 0)
        return null;
    if (win.get_client_type() !== Meta.WindowClientType.WAYLAND ||
        win.get_window_type() !== Meta.WindowType.NORMAL ||
        win.is_fullscreen() || win.get_maximize_flags() !== Meta.MaximizeFlags.NONE)
        return null;
    const wmClass = (win.get_wm_class() ?? '').toLowerCase();
    if (!wmClass)
        return null;
    return rules.find(r => typeof r?.match === 'string' && r.match &&
        wmClass.includes(r.match.toLowerCase())) ?? null;
}

/**
 * Whether a rule of windows.crop applies to the window as it is now. Its
 * client then draws no frame, or one that is cut off, so the window has no
 * edge of its own to resize it by (titlebar.js gives it handles).
 */
export function hasRule(config, win) {
    return ruleFor(config, win) !== null;
}

/**
 * The edges cut from a window, in stage units: {top, right, bottom, left},
 * and bar: the height of the title bar drawn above the content, 0 for none.
 * All 0 for a window without a rule, see ruleFor.
 */
export function cropOf(config, win) {
    const rule = ruleFor(config, win);
    if (!rule)
        return NONE;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const bar = rule.titlebar ? Math.round(BAR_HEIGHT * scale) : 0;
    // This client draws no frame, so there is nothing to cut.
    if (serves?.(win))
        return {top: 0, right: 0, bottom: 0, left: 0, bar};
    const side = v => Math.max(0, Math.round((Number(v) || 0) * scale));
    return {
        top: side(rule.top), right: side(rule.right),
        bottom: side(rule.bottom), left: side(rule.left),
        bar,
    };
}

// The frame a window is drawn with while one of its edges is dragged, see
// Tile.holdResize in tiling.js: window -> {x, y, width, height}.
const held = new Map();

/** Draw win with this frame in place of its own. null: with its own again. */
export function holdFrame(win, rect) {
    if (rect)
        held.set(win, rect);
    else
        held.delete(win);
}

/**
 * The frame a window's shape, title bar and resize handles are drawn for:
 * the one it has, or the one its dragged edge asks for.
 */
export function drawnFrame(win) {
    return held.get(win) ?? win.get_frame_rect();
}

export function isCropped(crop) {
    return crop.top > 0 || crop.right > 0 || crop.bottom > 0 || crop.left > 0;
}

/**
 * The part of a window's frame that its client's content fills. The sidebar
 * preview shows this.
 */
export function contentRect(config, win) {
    const frame = win.get_frame_rect();
    const c = cropOf(config, win);
    return {
        x: frame.x + c.left,
        y: frame.y + c.top,
        width: Math.max(1, frame.width - c.left - c.right),
        height: Math.max(1, frame.height - c.top - c.bottom),
    };
}

/**
 * The part of a window's frame that is drawn, the title bar included:
 * {x, y, width, height}. This is what takes the window's place in a tile.
 */
export function visibleRect(config, win) {
    const r = contentRect(config, win);
    const {bar} = cropOf(config, win);
    return {x: r.x, y: r.y - bar, width: r.width, height: r.height + bar};
}
