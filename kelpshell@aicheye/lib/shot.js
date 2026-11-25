// SPDX-License-Identifier: GPL-3.0-or-later

// The shell's panel for screenshots and screen recordings, with the look of
// the rest, and with a recording of one window.
//
// - The panel has the card material. The rules are in the stylesheet, under
//   .kelp-shot.
// - The selected area is shown as a focused window is: with round corners
//   and the ring of the focused window around it (focusRing), in place of
//   the shell's 2px line and 24px discs. The picture that is taken has
//   square corners, so what is darkened outside the curve of a corner is
//   in it. A corner or a side is taken where the shell has it, and the
//   pointer shows it.
// - In the list of windows, each window comes from its place on the screen
//   and goes back there, and the windows that are not chosen are dimmed and
//   a little smaller, as in the window switcher.
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

import {areaShape, cornerPicture, piece} from './privacy.js';
import {WindowRecorder} from './windowrec.js';

// How dark the panel has everything around the selected area: the value of
// .screenshot-ui-area-indicator-shade in the stylesheet.
const SELECT_SHADE = 0.5;
// The windows of the list fly from and to their places over this long.
const FLY_MS = 260;
// A window of the list that is not chosen and not under the pointer, as in
// lib/switcher.js.
const REST_OPACITY = 150;
const REST_SCALE = 0.97;
const CHOOSE_MS = 160;

const text = Gettext.domain('gnome-shell').gettext;

// The ring around the selected area, and the corners of the area inside
// it. It is `width` px larger than the area on each side: four lines along
// the sides, and four pictures that darken the area outside the curve of a
// corner and have the ring's curve (cornerPicture in lib/privacy.js).
const Ring = GObject.registerClass(
class KelpShotRing extends Clutter.Actor {
    _init(config, props = {}) {
        super._init(props);
        this._config = config;
        const [ok, color] = Cogl.Color.from_string(config.values.focusRing.color);
        this._color = ok ? color : new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 140});
        this._lines = [0, 1, 2, 3].map(() => new Clutter.Actor({background_color: this._color}));
        this._corners = [[false, false], [true, false], [false, true], [true, true]].map(
            ([flipX, flipY]) => piece(null, 0, 0, 0, 0, flipX, flipY));
        for (const child of [...this._lines, ...this._corners])
            this.add_child(child);
    }

    /** The width of the ring, which the box is larger than the area by. */
    get reach() {
        return areaShape(this._config, 0, 0).width;
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [Math.round(box.get_width()), Math.round(box.get_height())];
        const t = this.reach;
        const {radius} = areaShape(this._config, w - 2 * t, h - 2 * t);
        if (radius !== this._radius) {
            this._radius = radius;
            const content = cornerPicture(radius, SELECT_SHADE, this._color, t);
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

export class Shot {
    constructor(config, backdrop, privacy, tiling) {
        this._config = config;
        this._tiling = tiling;
        this._backdrop = backdrop;
        this._privacy = privacy;
        this._ui = null;
        this._laterId = 0;
        this._idleId = 0;
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

    /** The ring of the selected area, from the config as it is now. */
    sync() {
        if (!this._ui)
            return;
        this._ring?.destroy();
        this._ring = new Ring(this._config);
        const reach = this._ring.reach;
        this._ring.set_position(-reach, -reach);
        this._ring.add_constraint(new Clutter.BindConstraint({
            source: this._selection, coordinate: Clutter.BindCoordinate.SIZE, offset: 2 * reach,
        }));
        this._selection.add_child(this._ring);
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
        for (const widget of this._windows())
            widget.disconnectObject(this);
        this._ring?.destroy();
        this._ring = null;
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

    // ------------------------------------------------------ list of windows

    _windows() {
        return Main.screenshotUI._windowSelectors.flatMap(selector => selector.windows());
    }

    /**
     * The scale and the translation that put a window of the list where
     * the window is on the screen: [scale, x, y], for a pivot at 0, 0.
     */
    _placeOnScreen(widget) {
        const picture = widget.child?._actor;
        const on = widget.child?._bufferRect;
        if (!picture || !on)
            return null;
        widget.set_pivot_point(0, 0);
        widget.set_scale(1, 1);
        widget.set_translation(0, 0, 0);
        const [ox, oy] = widget.get_transformed_position();
        const [px, py] = picture.get_transformed_position();
        const [pw] = picture.get_transformed_size();
        if (!(pw > 0) || !Number.isFinite(ox + px))
            return null;
        const scale = on.width / pw;
        return [scale, on.x - ox - scale * (px - ox), on.y - oy - scale * (py - oy)];
    }

    /** The windows of the list come from their places, or go back there. */
    _showWindows(shown) {
        const animate = St.Settings.get().enable_animations;
        for (const widget of this._windows()) {
            if (shown && !widget._kelpChosen) {
                // Dimmed and smaller unless chosen or under the pointer.
                widget._kelpChosen = () => {
                    const content = widget.child;
                    content.set_pivot_point(0.5, 0.5);
                    const scale = widget.checked ? 1 : REST_SCALE;
                    content.ease({
                        opacity: widget.checked || widget.hover ? 255 : REST_OPACITY,
                        scale_x: scale,
                        scale_y: scale,
                        duration: CHOOSE_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                };
                widget.connectObject('notify::checked', widget._kelpChosen,
                    'notify::hover', widget._kelpChosen, this);
                const scale = widget.checked ? 1 : REST_SCALE;
                widget.child.set_pivot_point(0.5, 0.5);
                widget.child.set_scale(scale, scale);
                widget.child.opacity = widget.checked ? 255 : REST_OPACITY;
            }
            const place = animate ? this._placeOnScreen(widget) : null;
            if (!place)
                continue;
            const [scale, x, y] = place;
            widget.remove_all_transitions();
            if (shown) {
                widget.set_scale(scale, scale);
                widget.set_translation(x, y, 0);
            }
            widget.ease({
                scale_x: shown ? 1 : scale,
                scale_y: shown ? 1 : scale,
                translation_x: shown ? 0 : x,
                translation_y: shown ? 0 : y,
                duration: FLY_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
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
