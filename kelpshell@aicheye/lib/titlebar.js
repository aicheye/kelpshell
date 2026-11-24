// SPDX-License-Identifier: GPL-3.0-or-later

// A title bar for a window named in windows.crop.
//
// The client of such a window draws no title bar, or draws one that is cut
// off (see crop.js). With "titlebar": true in the rule this bar is drawn
// above the content, with the window's title in the system's title bar font
// and the buttons of the system's button layout, as on a GTK window.
//
// The bar is a child of the window actor, above the client's surface, so it
// moves, animates and is clipped with the window. It is taller than the
// client's title bar, so its top is above the window's frame.
//
// Every window of a Wayland client that can be resized also gets resize
// handles here, with or without a bar. A client that was told the
// compositor draws its frame (decorations.js) draws none, and one whose
// frame is cut off (crop.js) has its resize border cut off with it, so the
// window has no edge to drag. Mutter draws no frame for a Wayland client.
// The handles are actors that draw nothing, around the window and its bar:
// HANDLE_OUT px outside of the edge and HANDLE_IN px inside of it, and
// HANDLE_CORNER px along both edges at a corner. A press on one starts the
// window manager's own resize, as a press on the edge of a GTK window does.
//
// The windows without a rule in windows.crop have them too. A GTK window
// has a resize border of its own, in the room of the shadow it draws
// around its frame, which lib/corners.js does not draw. That border starts
// outside the frame, so without the handles a press on the edge of the
// window or a little inside it does nothing, where the same press resizes
// a window of windows.crop.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BAR_LINE_CSS} from './corners.js';
import {cropOf, drawnFrame} from './crop.js';
import {steadyLine} from './text.js';

// The pointer moves this far with the button down before the window is dragged.
const DRAG_DISTANCE = 6;
// Two presses this close in time are a double click.
const DOUBLE_CLICK_MS = 400;
// Sizes of .kelp-titlebar-button and .kelp-titlebar-controls in the
// stylesheet, px: a button, the space between two, and the space between
// the buttons and the end of the bar. The title keeps clear of them.
const BUTTON = 24;
const BUTTON_GAP = 13;
const BUTTON_MARGIN = 7;

// The resize handles, px. Outside they stay inside layout.gap (8), so the
// handles of two windows next to each other do not overlap.
const HANDLE_OUT = 8;
const HANDLE_IN = 3;
const HANDLE_CORNER = 20;
// Each handle: the edge or corner, and its boxes as [x1, y1, x2, y2] from
// the width w and the height h of the window with its bar, o px outside, i
// px inside and k px along the edge at a corner.
const HANDLES = [
    ['NW', (w, h, o, i, k) => [[-o, -o, k, i], [-o, i, i, k]]],
    ['N', (w, h, o, i, k) => [[k, -o, w - k, i]]],
    ['NE', (w, h, o, i, k) => [[w - k, -o, w + o, i], [w - i, i, w + o, k]]],
    ['W', (w, h, o, i, k) => [[-o, k, i, h - k]]],
    ['E', (w, h, o, i, k) => [[w - i, k, w + o, h - k]]],
    ['SW', (w, h, o, i, k) => [[-o, h - k, i, h + o], [i, h - i, k, h + o]]],
    ['S', (w, h, o, i, k) => [[k, h - i, w - k, h + o]]],
    ['SE', (w, h, o, i, k) => [[w - i, h - k, w + o, h + o], [w - k, h - i, w - i, h + o]]],
];

const ICONS = {
    minimize: 'window-minimize-symbolic',
    maximize: 'window-maximize-symbolic',
    close: 'window-close-symbolic',
};

/**
 * Whether a window gets resize handles: one of a Wayland client that can be
 * resized, in a state in which it has edges to drag. An X11 window has a
 * frame from Mutter, with its own.
 */
function handled(win) {
    return win.get_client_type() === Meta.WindowClientType.WAYLAND &&
        win.get_window_type() === Meta.WindowType.NORMAL &&
        !win.is_fullscreen() && win.get_maximize_flags() === Meta.MaximizeFlags.NONE &&
        win.allows_resize();
}

export class Titlebars {
    /**
     * @param {Config} config
     * @param {function} onMaximize - called with the window, on a double
     *   click and on the maximize button
     */
    constructor(config, onMaximize) {
        this._config = config;
        this._onMaximize = onMaximize;
    }

    enable() {
        this._bars = new Map();   // window -> bar
        this._frames = new Map(); // window -> the actor that holds its resize handles
        // button-layout: which buttons, on which side. titlebar-font: the
        // font of the title.
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._settings.connectObject(
            'changed::button-layout', () => this._rebuild(),
            'changed::titlebar-font', () => this._rebuild(), this);
        global.display.connectObject(
            'window-created', (_d, win) => this._watch(win), this);
        for (const win of global.display.list_all_windows())
            this._watch(win);
    }

    disable() {
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
        for (const win of global.display.list_all_windows())
            win.disconnectObject(this);
        for (const bar of this._bars.values())
            bar.destroy();
        this._bars = null;
        for (const frame of this._frames.values())
            frame.destroy();
        this._frames = null;
    }

    /** Make every bar again, after a change of the buttons or the font. */
    _rebuild() {
        for (const bar of this._bars.values())
            bar.destroy();
        this._bars.clear();
        this.syncAll();
        // The new bars were added over the handles.
        for (const [win, frame] of this._frames) {
            const bar = this._bars.get(win);
            if (bar)
                frame.get_parent()?.set_child_above_sibling(frame, bar);
        }
    }

    /** The buttons at the start and at the end of the bar: [[name], [name]]. */
    _layout() {
        const sides = this._settings.get_string('button-layout').split(':');
        return [0, 1].map(i => (sides[i] ?? '').split(',').filter(name => name in ICONS));
    }

    /** CSS for the title, from the titlebar-font setting. */
    _fontStyle() {
        const font = Pango.FontDescription.from_string(this._settings.get_string('titlebar-font'));
        const size = font.get_size() / Pango.SCALE;
        if (!font.get_family() || size <= 0)
            return '';
        return `font-family: "${font.get_family()}"; ` +
            `font-size: ${size}${font.get_size_is_absolute() ? 'px' : 'pt'}; ` +
            `font-weight: ${font.get_weight()};`;
    }

    /** The frame the window is drawn with has changed, see drawnFrame() in crop.js. */
    sync(win) {
        if (this._bars)
            this._sync(win);
    }

    /** After a change of configuration. */
    syncAll() {
        for (const win of global.display.list_all_windows())
            this._sync(win);
    }

    _watch(win) {
        win.connectObject(
            'shown', () => this._sync(win),
            'size-changed', () => this._sync(win),
            'notify::fullscreen', () => this._sync(win),
            'notify::maximized-horizontally', () => this._sync(win),
            'notify::maximized-vertically', () => this._sync(win),
            'notify::wm-class', () => this._sync(win),
            'notify::title', () => this._sync(win),
            'notify::appears-focused', () => this._sync(win),
            'unmanaging', () => {
                // The bar and the handles go with the window actor, after
                // the close animation.
                this._bars.delete(win);
                this._frames.delete(win);
                win.disconnectObject(this);
            },
            this);
        this._sync(win);
    }

    _sync(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        const c = cropOf(this._config, win);
        this._syncHandles(win, actor, c);
        let bar = this._bars.get(win) ?? null;
        if (c.bar <= 0) {
            bar?.destroy();
            this._bars.delete(win);
            return;
        }
        if (!bar) {
            bar = this._build(win);
            actor.add_child(bar);
            actor.connectObject('destroy', () => this._bars?.delete(win), bar);
            this._bars.set(win, bar);
            // The handles are over the bar: its top edge resizes.
            const frame = this._frames.get(win);
            if (frame)
                actor.set_child_above_sibling(frame, bar);
        }
        const frame = drawnFrame(win);
        const buffer = win.get_buffer_rect();
        bar.set_position(frame.x - buffer.x + c.left, frame.y - buffer.y + c.top - c.bar);
        bar.set_size(Math.max(1, frame.width - c.left - c.right), c.bar);
        const radius = this._config.values.windows.clipCorners
            ? this._config.values.focusRing.radius : 0;
        // The border has the colour of the window's outline, see corners.js.
        const style = `border-radius: ${radius}px ${radius}px 0 0; border-color: ${BAR_LINE_CSS};`;
        if (bar.style !== style)
            bar.style = style;
        bar._title.text = win.get_title() ?? '';
        if (win.appears_focused)
            bar.remove_style_class_name('backdrop');
        else
            bar.add_style_class_name('backdrop');
    }

    /** Give a window its resize handles (see handled), placed around it and its bar. */
    _syncHandles(win, actor, c) {
        let frame = this._frames.get(win) ?? null;
        if (!handled(win)) {
            frame?.destroy();
            this._frames.delete(win);
            return;
        }
        if (!frame) {
            frame = this._buildHandles(win);
            actor.add_child(frame);
            actor.connectObject('destroy', () => this._frames?.delete(win), frame);
            this._frames.set(win, frame);
        }
        const rect = drawnFrame(win);
        const buffer = win.get_buffer_rect();
        const w = Math.max(1, rect.width - c.left - c.right);
        const h = Math.max(1, rect.height - c.top - c.bottom + c.bar);
        frame.set_position(rect.x - buffer.x + c.left, rect.y - buffer.y + c.top - c.bar);
        frame.set_size(w, h);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const o = HANDLE_OUT * scale;
        const i = HANDLE_IN * scale;
        // On a small window the corners leave the middle third of each edge.
        const k = Math.min(HANDLE_CORNER * scale, Math.floor(Math.min(w, h) / 3));
        HANDLES.forEach(([, boxes], n) => {
            boxes(w, h, o, i, k).forEach(([x1, y1, x2, y2], m) => {
                const handle = frame._handles[n][m];
                handle.set_position(x1, y1);
                handle.set_size(Math.max(0, x2 - x1), Math.max(0, y2 - y1));
            });
        });
    }

    _buildHandles(win) {
        const frame = new Clutter.Actor({reactive: false});
        // A colour, although nothing of it shows: an actor with none takes
        // no part in the place its parents are drawn in, and the stage does
        // not look for the pointer's actor outside of that place.
        const clear = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0});
        frame._handles = HANDLES.map(([edge, boxes]) => boxes(0, 0, 0, 0, 0).map(() => {
            const handle = new Clutter.Actor({reactive: true, background_color: clear});
            handle.set_cursor_type(Clutter.CursorType[`${edge}_RESIZE`]);
            handle.connect('button-press-event', (_a, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;
                Main.activateWindow(win);
                this._beginGrab(win, Meta.GrabOp[`RESIZING_${edge}`], event);
                return Clutter.EVENT_STOP;
            });
            frame.add_child(handle);
            return handle;
        }));
        return frame;
    }

    _build(win) {
        const bar = new St.Widget({
            style_class: 'kelp-titlebar',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
        });
        bar._title = new St.Label({
            style_class: 'kelp-titlebar-title',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        steadyLine(bar._title);
        bar.add_child(bar._title);
        const run = {
            minimize: () => win.minimize(),
            maximize: () => {
                Main.activateWindow(win);
                this._onMaximize?.(win);
            },
            close: () => win.delete(global.get_current_time()),
        };
        const sides = this._layout();
        sides.forEach((names, i) => {
            if (names.length === 0)
                return;
            const box = new St.BoxLayout({
                style_class: 'kelp-titlebar-controls',
                x_expand: true,
                y_expand: true,
                x_align: i === 0 ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            });
            for (const name of names)
                box.add_child(this._button(ICONS[name], run[name]));
            bar.add_child(box);
        });
        // The title is in the middle of the bar, so both sides keep the
        // width of the wider group of buttons.
        const count = Math.max(sides[0].length, sides[1].length);
        const pad = count > 0
            ? BUTTON_MARGIN + count * BUTTON + (count - 1) * BUTTON_GAP + BUTTON_GAP : BUTTON_GAP;
        bar._title.style = `padding: 0 ${pad}px; ${this._fontStyle()}`;

        // Press focuses the window, a drag moves it, a double click goes to
        // the window manager.
        let press = null;
        let lastPress = 0;
        bar.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            Main.activateWindow(win);
            const time = event.get_time();
            if (time - lastPress <= DOUBLE_CLICK_MS) {
                lastPress = 0;
                press = null;
                this._onMaximize?.(win);
            } else {
                lastPress = time;
                press = event.get_coords();
            }
            return Clutter.EVENT_STOP;
        });
        bar.connect('motion-event', (_a, event) => {
            if (!press)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            if (Math.hypot(x - press[0], y - press[1]) >= DRAG_DISTANCE) {
                press = null;
                this._beginMove(win, event);
            }
            return Clutter.EVENT_STOP;
        });
        bar.connect('button-release-event', () => {
            press = null;
            return Clutter.EVENT_STOP;
        });
        // The pointer left the bar with the button still down.
        bar.connect('leave-event', (_a, event) => {
            if (press) {
                press = null;
                this._beginMove(win, event);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        return bar;
    }

    /**
     * A round button of the bar. Not an St.Button: over a window actor its
     * click is never recognised, although the press and the release both
     * arrive.
     */
    _button(iconName, run) {
        const button = new St.Bin({
            style_class: 'kelp-titlebar-button',
            child: new St.Icon({icon_name: iconName}),
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        let armed = false;
        const arm = on => {
            armed = on;
            if (on)
                button.add_style_pseudo_class('active');
            else
                button.remove_style_pseudo_class('active');
        };
        button.connect('button-press-event', (_a, event) => {
            arm(event.get_button() === Clutter.BUTTON_PRIMARY);
            return Clutter.EVENT_STOP;
        });
        button.connect('button-release-event', () => {
            const was = armed;
            arm(false);
            if (was)
                run();
            return Clutter.EVENT_STOP;
        });
        button.connect('leave-event', () => {
            arm(false);
            return Clutter.EVENT_PROPAGATE;
        });
        return button;
    }

    _beginMove(win, event) {
        this._beginGrab(win, Meta.GrabOp.MOVING, event);
    }

    _beginGrab(win, op, event) {
        const backend = global.stage.get_context().get_backend();
        const sprite = backend.get_sprite(global.stage, event) ||
            backend.get_pointer_sprite(global.stage);
        const [x, y] = event.get_coords();
        win.begin_grab_op(op, sprite, event.get_time(), new Graphene.Point({x, y}));
    }
}
