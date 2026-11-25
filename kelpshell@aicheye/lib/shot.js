// SPDX-License-Identifier: GPL-3.0-or-later

// The shell's panel for screenshots and screen recordings, with the look of
// the rest, and with a recording of one window.
//
// - The panel has the card material. The rules are in the stylesheet, under
//   .kelp-shot.
// - The selected area has the ring of the focused window around it
//   (focusRing), with square corners as the picture has them, in place of
//   the shell's 2px line and 24px discs. A corner or a side is taken where
//   the shell has it, and the pointer shows it.
// - A window is chosen where it is on the screen: the chosen window is
//   clear and has the ring, and everything else is darkened as around a
//   selected area. The shell lays the windows out as a list on a dark
//   ground in place of the screen. Its list stays the record of what is
//   chosen, and is not shown.
// - A window can be recorded (lib/windowrec.js), which the shell leaves
//   out: its window button is off while the panel is set to record.
//
// The shell closes the panel in one frame when a recording starts, so that
// the recording does not show it going. Here the screen is painted into a
// picture before that, and lib/privacy.js fades the picture out where the
// recording does not see it, while its mark of what is recorded comes.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gettext from 'gettext';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {visibleRect} from './crop.js';
import {cornerPicture, piece} from './privacy.js';
import {WindowRecorder} from './windowrec.js';

// How dark the panel has everything around the selected area: the value of
// .screenshot-ui-area-indicator-shade in the stylesheet.
const SELECT_SHADE = 0.5;
// The clear place goes from one window to the next over this long, and the
// windows come and go over it, as the panel's own parts do.
const MOVE_MS = 200;
// The opacity, of 255, of the ring on the window under the pointer while
// that is not the chosen one.
const HOVER_OPACITY = 130;

const text = Gettext.domain('gnome-shell').gettext;

// The ring around a place, `width` px outside it on each side, as the ring
// of the focused window is: four lines along the sides and four corners.
// With a radius, the place is one with round corners, a window: the
// corners are pictures that darken the place outside the curve and have
// the ring's curve (cornerPicture in lib/privacy.js). The darkening is
// `shade`, that of what is around the place.
const Ring = GObject.registerClass(
class KelpShotRing extends Clutter.Actor {
    _init(config, shade, props = {}) {
        super._init(props);
        const ring = config.values.focusRing;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [ok, color] = Cogl.Color.from_string(ring.color);
        this._color = ok ? color : new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 140});
        this._shade = shade;
        this.reach = Math.max(1, Math.round(ring.width)) * scale;
        this._radius = 0;
        this._lines = [0, 1, 2, 3].map(() => new Clutter.Actor({background_color: this._color}));
        this._corners = [[false, false], [true, false], [false, true], [true, true]].map(
            ([flipX, flipY]) => piece(null, 0, 0, 0, 0, flipX, flipY));
        for (const child of [...this._lines, ...this._corners])
            this.add_child(child);
    }

    /** The radius of the corners of the place, px of the stage. 0: square. */
    set radius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this._drawn = null;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [Math.round(box.get_width()), Math.round(box.get_height())];
        const t = this.reach;
        const radius = Math.max(0, Math.min(this._radius,
            Math.floor((w - 2 * t) / 2), Math.floor((h - 2 * t) / 2)));
        if (radius !== this._drawn) {
            this._drawn = radius;
            // With no radius the picture is the ring's own corner, whose
            // outer edge is round by the width of the ring.
            const content = cornerPicture(radius, radius > 0 ? this._shade : 0, this._color, t);
            for (const corner of this._corners)
                corner.content = content;
        }
        const n = radius + t;
        const place = (child, x, y, width, height) => child.allocate(new Clutter.ActorBox({
            x1: x, y1: y, x2: x + Math.max(0, width), y2: y + Math.max(0, height),
        }));
        place(this._lines[0], n, 0, w - 2 * n, t);
        place(this._lines[1], n, h - t, w - 2 * n, t);
        place(this._lines[2], 0, n, t, h - 2 * n);
        place(this._lines[3], w - t, n, t, h - 2 * n);
        place(this._corners[0], 0, 0, n, n);
        place(this._corners[1], w - n, 0, n, n);
        place(this._corners[2], 0, h - n, n, n);
        place(this._corners[3], w - n, h - n, n, n);
    }
});

/** A ring on `place` (an actor), which it follows. */
function ringOn(config, place) {
    const ring = new Ring(config, SELECT_SHADE);
    ring.set_position(-ring.reach, -ring.reach);
    ring.add_constraint(new Clutter.BindConstraint({
        source: place, coordinate: Clutter.BindCoordinate.SIZE, offset: 2 * ring.reach,
    }));
    place.add_child(ring);
    return ring;
}

export class Shot {
    constructor(config, backdrop, privacy, tiling) {
        this._config = config;
        this._tiling = tiling;
        this._backdrop = backdrop;
        this._privacy = privacy;
        this._ui = null;
        this._laterId = 0;
        this._idleId = 0;
        this._entries = [];      // the windows that can be chosen, see _listWindows
    }

    enable() {
        const ui = Main.screenshotUI;
        const selection = ui?._areaSelector?._areaIndicator?._selectionRect;
        if (!ui?._panel || !ui._primaryMonitorBin || !selection)
            return;
        this._ui = ui;
        this._selection = selection;
        ui.add_style_class_name('kelp-shot');

        // St draws no blurred shadow for a node with a background image
        // (lib/backdrop.js), so the shadow is on an actor under the panel.
        // It is placed after the panel is: a constraint on an actor that is
        // laid out before the panel reads the panel's place as 0, 0.
        this._shadow = new St.Widget({style_class: 'kelp-shadow kelp-shadow-shot'});
        ui.insert_child_below(this._shadow, ui._primaryMonitorBin);
        ui._panel.connectObject('notify::allocation', () => this._queueShadow(), this);
        this._queueShadow();
        // The panel is faint while an area is dragged.
        this._shadowOpacity = ui._panel.bind_property('opacity', this._shadow, 'opacity',
            GObject.BindingFlags.SYNC_CREATE);
        this._backdrop.attach(ui._panel);

        // Where a window is chosen: the shell's own actor for an area with
        // everything around it darkened, with a window as the area.
        const Indicator = ui._areaSelector._areaIndicator.constructor;
        this._picker = new Indicator({
            style_class: 'screenshot-ui-area-selector',
            reactive: true,
            visible: false,
            opacity: 0,
        });
        this._picker.add_constraint(new Clutter.BindConstraint({
            source: global.stage, coordinate: Clutter.BindCoordinate.ALL,
        }));
        ui.insert_child_below(this._picker, this._shadow);
        // The place of the window under the pointer, for its ring.
        this._hover = new Clutter.Actor({opacity: 0});
        this._picker.add_child(this._hover);
        this._picker.connectObject(
            'motion-event', (_a, event) => this._point(...event.get_coords()),
            'leave-event', () => this._point(-1, -1),
            'button-release-event', (_a, event) => {
                const entry = this._entryAt(...event.get_coords());
                if (entry)
                    entry.widget.checked = true;
                return Clutter.EVENT_STOP;
            }, this);
        ui.connectObject(
            'closed', () => this._showWindows(false, false),
            'key-press-event', (_a, event) => this._key(event), this);

        this.sync();

        this._recorder = new WindowRecorder(this._config);
        this._recorder.probe().then(() => this._ui?._syncWindowButtonSensitivity())
            .catch(e => console.warn(`kelpshell: window recording: ${e.message}`));

        // Own properties over the methods of the class, taken away again in
        // disable().
        const {_startScreencast: start, stopScreencast: stop, open} = ui;
        this._own = {
            _startScreencast: (...args) => {
                if (ui._windowButton.checked && !args[0])
                    return this._recordWindow();
                try {
                    const [x, y, width, height] = ui._getSelectedGeometry(false);
                    // A second try has no panel.
                    if (!args[0] && ui.visible)
                        this._privacy.handOff({x, y, width, height}, this._pictures());
                } catch (e) {
                    console.warn(`kelpshell: at the start of a recording: ${e.message}`);
                }
                return start.apply(ui, args);
            },
            stopScreencast: async () => {
                if (!this._recorder.active)
                    return stop.apply(ui);
                ui._setScreencastInProgress(false);
                return this._recorded(await this._recorder.stop());
            },
            // The shell has the window button off while the panel records.
            _syncWindowButtonSensitivity: () => {
                ui._windowButton.reactive = Main.sessionMode.hasWindows &&
                    ui._windowSelectors.some(selector => selector.windows().length > 0) &&
                    (!ui._castButton.checked || this._recorder.available);
            },
            open: async (...args) => {
                await open.apply(ui, args);
                if (this._ui && ui._windowButton.checked)
                    this._showWindows(true);
            },
        };
        Object.assign(ui, this._own);

        // After the shell's own handlers, which have turned the window
        // button off and the selection on.
        ui._castButton.connectObject('notify::checked', () => {
            ui._syncWindowButtonSensitivity();
            if (ui._castButton.checked && this._leftWindows && ui._windowButton.reactive)
                ui._windowButton.checked = true;
        }, this);
        ui._windowButton.connectObject('notify::checked', () => {
            if (ui._windowButton.checked) {
                this._showWindows(true);
                return;
            }
            this._showWindows(false);
            // For the handler above, if this is the shell leaving the
            // list because the panel is set to record.
            this._leftWindows = true;
            if (!this._idleId) {
                this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleId = 0;
                    this._leftWindows = false;
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, this);
    }

    /** The rings, from the config as it is now. */
    sync() {
        if (!this._ui)
            return;
        this._ring?.destroy();
        this._ring = ringOn(this._config, this._selection);
        this._windowRing?.destroy();
        this._windowRing = ringOn(this._config, this._picker._selectionRect);
        this._hoverRing?.destroy();
        this._hoverRing = ringOn(this._config, this._hover);
    }

    _queueShadow() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            const panel = this._ui?._panel;
            if (panel?.has_allocation()) {
                // The panel's parents are not moved or scaled.
                const [x, y] = panel.get_transformed_position();
                this._shadow.set_position(Math.round(x), Math.round(y));
                this._shadow.set_size(...panel.get_size());
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        const ui = this._ui;
        if (!ui)
            return;
        this._ui = null;
        for (const [name, own] of Object.entries(this._own)) {
            if (ui[name] === own)
                delete ui[name];
        }
        ui._castButton.disconnectObject(this);
        ui._windowButton.disconnectObject(this);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        if (this._recorder.active)
            ui._setScreencastInProgress(false);
        this._releaseWindow();
        this._recorder.destroy();
        this._recorder = null;
        ui.disconnectObject(this);
        for (const widget of this._windows())
            widget.disconnectObject(this);
        this._entries = [];
        this._ring?.destroy();
        this._ring = this._windowRing = this._hoverRing = this._hover = null;
        this._picker.destroy();
        this._picker = null;
        this._backdrop.detach(ui._panel);
        ui._panel.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._shadowOpacity.unbind();
        this._shadow.destroy();
        this._shadow = null;
        ui.remove_style_class_name('kelp-shot');
        ui._syncWindowButtonSensitivity();
    }

    // ---------------------------------------------------- choosing a window

    _windows() {
        return Main.screenshotUI._windowSelectors.flatMap(selector => selector.windows());
    }

    /**
     * The windows that can be chosen, the top one first: {widget, win,
     * rect, radius}. widget is the shell's entry for the window, whose
     * `checked` is what the shell takes as chosen. rect is where the window
     * is drawn, as far as it is on the stage.
     */
    _listWindows() {
        const [width, height] = global.stage.get_size();
        const clip = this._config.values.windows.clipCorners;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const entries = [];
        for (const widget of this._windows()) {
            const win = this._windowOf(widget);
            if (!win)
                continue;
            const drawn = this._tiling?.drawnRect(win) ?? visibleRect(this._config, win);
            const x1 = Math.max(0, drawn.x), y1 = Math.max(0, drawn.y);
            const x2 = Math.min(width, drawn.x + drawn.width);
            const y2 = Math.min(height, drawn.y + drawn.height);
            if (x2 <= x1 || y2 <= y1)
                continue;
            // A corner that is cut off at the edge of the stage is square.
            const whole = x1 === drawn.x && y1 === drawn.y &&
                x2 === drawn.x + drawn.width && y2 === drawn.y + drawn.height;
            entries.push({
                widget, win,
                rect: {x: x1, y: y1, width: x2 - x1, height: y2 - y1},
                radius: clip && whole && !win.is_fullscreen()
                    ? Math.round(this._config.values.focusRing.radius) * scale : 0,
            });
        }
        const order = global.display.sort_windows_by_stacking(entries.map(e => e.win));
        return entries.sort((a, b) => order.indexOf(b.win) - order.indexOf(a.win));
    }

    _entryAt(x, y) {
        return this._entries.find(({rect}) =>
            x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
    }

    /** The pointer is here: the window under it has a faint ring. */
    _point(x, y) {
        const entry = this._entryAt(x, y);
        const shown = entry && !entry.widget.checked;
        if (shown) {
            const {rect, radius} = entry;
            this._hover.set_position(rect.x, rect.y);
            this._hover.set_size(rect.width, rect.height);
            this._hoverRing.radius = radius;
        }
        this._hover.ease({
            opacity: shown ? HOVER_OPACITY : 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return Clutter.EVENT_PROPAGATE;
    }

    /** The clear place is on the chosen window, or nowhere. */
    _choose(animate) {
        const place = this._picker._selectionRect;
        const entry = this._entries.find(e => e.widget.checked);
        const had = place.width > 0 && place.height > 0;
        this._windowRing.visible = !!entry;
        if (!entry) {
            // Everything is darkened.
            place.remove_all_transitions();
            place.set_size(0, 0);
            return;
        }
        const {rect, radius} = entry;
        this._windowRing.radius = radius;
        this._hover.ease({opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        place.remove_all_transitions();
        if (!animate || !had || !St.Settings.get().enable_animations) {
            place.set_position(rect.x, rect.y);
            place.set_size(rect.width, rect.height);
            return;
        }
        place.ease({
            ...rect,
            duration: MOVE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /** Left, up: the window before the chosen one. Right, down, Tab: the next. */
    _key(event) {
        if (!this._picker?.visible || this._entries.length === 0)
            return Clutter.EVENT_PROPAGATE;
        const step = {
            [Clutter.KEY_Left]: -1, [Clutter.KEY_Up]: -1, [Clutter.KEY_ISO_Left_Tab]: -1,
            [Clutter.KEY_Right]: 1, [Clutter.KEY_Down]: 1, [Clutter.KEY_Tab]: 1,
        }[event.get_key_symbol()];
        if (!step)
            return Clutter.EVENT_PROPAGATE;
        // From left to right, then from the top down.
        const order = [...this._entries].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
        const at = order.findIndex(e => e.widget.checked);
        order[(Math.max(at, 0) + (at < 0 ? 0 : step) + order.length) % order.length]
            .widget.checked = true;
        return Clutter.EVENT_STOP;
    }

    /**
     * The panel is set to choose a window (shown), or no longer. The
     * shell's list of the windows is taken off the screen: what is chosen
     * is shown on the windows where they are.
     */
    _showWindows(shown, animate = true) {
        const ui = Main.screenshotUI;
        const picker = this._picker;
        animate &&= St.Settings.get().enable_animations;
        picker.remove_all_transitions();
        if (!shown) {
            this._entries = [];
            if (!animate || !picker.visible) {
                picker.hide();
                picker.opacity = 0;
                return;
            }
            picker.ease({
                opacity: 0,
                duration: MOVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => picker.hide(),
            });
            return;
        }
        for (const selector of ui._windowSelectors)
            selector.hide();
        this._entries = this._listWindows();
        for (const {widget} of this._entries) {
            if (widget._kelpPicked)
                continue;
            widget._kelpPicked = true;
            widget.connectObject('notify::checked', () => {
                if (widget.checked && this._picker?.visible)
                    this._choose(true);
            }, this);
        }
        this._hover.opacity = 0;
        this._choose(false);
        picker.show();
        picker.ease({
            opacity: 255,
            duration: animate ? MOVE_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** The window that a window of the list shows. */
    _windowOf(widget) {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().map(actor => actor.metaWindow).find(win =>
            !win.is_override_redirect() && win.located_on_workspace(workspace) &&
            win.get_frame_rect().equal(widget.boundingBox)) ?? null;
    }

    // ------------------------------------------------------------ recording

    /** The screen as it is now, one picture for each monitor. */
    _pictures() {
        return global.stage.peek_stage_views().map(view => {
            const layout = new Mtk.Rectangle();
            view.get_layout(layout);
            return {
                content: global.stage.paint_to_content(layout, view.get_scale(),
                    view.color_state, Clutter.PaintFlag.NO_CURSORS),
                x: layout.x, y: layout.y, width: layout.width, height: layout.height,
            };
        });
    }

    /** The panel is set to record and a window is chosen. */
    async _recordWindow() {
        const ui = this._ui;
        const widget = this._windows().find(w => w.checked);
        const win = widget && this._windowOf(widget);
        if (!win || !this._recorder.available || this._recorder.active)
            return;
        const drawCursor = ui._cursor.visible;
        try {
            this._privacy.handOff(null, this._pictures());
        } catch (e) {
            console.warn(`kelpshell: at the start of a recording: ${e.message}`);
        }
        ui.close(true);
        delete ui._screencastPath;
        ui._setScreencastInProgress(true);
        // The recording shows the window as it is drawn: at full size.
        this._recordedWindow = win;
        this._tiling.setFullSize(win, true);
        try {
            ui._screencastPath = await this._recorder.start(win, drawCursor, path => {
                // The window has closed, or the encoder has stopped.
                ui._setScreencastInProgress(false);
                this._recorded(path);
            });
        } catch (e) {
            console.warn(`kelpshell: window recording: ${e.message}`);
            ui._setScreencastInProgress(false);
            this._releaseWindow();
            ui._showNotification(text('Screencast Failed to Start'));
        }
    }

    _releaseWindow() {
        if (this._recordedWindow)
            this._tiling.setFullSize(this._recordedWindow, false);
        this._recordedWindow = null;
    }

    /** A recording of a window has ended, with this file or with none. */
    _recorded(path) {
        const ui = Main.screenshotUI;
        this._releaseWindow();
        if (path)
            ui._screencastPath = path;
        else
            delete ui._screencastPath;
        ui._showNotification(text(path ? 'Screencast Recorded' : 'Screencast Failed'));
    }
}
