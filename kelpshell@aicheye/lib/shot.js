// SPDX-License-Identifier: GPL-3.0-or-later

// The shell's panel for screenshots and screen recordings, with the look of
// the rest: the panel has the card material, and the selected area has the
// frame that an area has while it is recorded (frameSpec in lib/privacy.js),
// in the colour of the ring around the focused window. The rules are in the
// stylesheet, under .kelp-shot.
//
// The shell closes the panel in one frame when a recording starts, so that
// the recording does not show it going. Here the screen is painted into a
// picture before that, and lib/privacy.js fades the picture out where the
// recording does not see it, while the frame of what is recorded comes in
// the place of the frame of the selection.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Frame, frameSpec} from './privacy.js';

const HANDLES = ['_topLeftHandle', '_topRightHandle', '_bottomLeftHandle', '_bottomRightHandle'];

export class Shot {
    constructor(config, backdrop, privacy) {
        this._config = config;
        this._backdrop = backdrop;
        this._privacy = privacy;
        this._ui = null;
        this._laterId = 0;
    }

    enable() {
        const ui = Main.screenshotUI;
        const selection = ui?._areaSelector?._areaIndicator?._selectionRect;
        if (!ui?._panel || !ui._primaryMonitorBin || !selection)
            return;
        this._ui = ui;
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

        this._selection = selection;
        this._dots = HANDLES.map(name => {
            const handle = ui._areaSelector[name];
            const dot = new St.Widget({
                style_class: 'kelp-shot-handle',
                x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            });
            handle.layout_manager = new Clutter.BinLayout();
            handle.add_child(dot);
            return dot;
        });
        this.sync();

        // An own property over the method of the class, taken away again
        // in disable().
        const start = ui._startScreencast;
        this._start = (...args) => {
            try {
                this._handOff(...args);
            } catch (e) {
                console.warn(`kelpshell: at the start of a recording: ${e.message}`);
            }
            return start.apply(ui, args);
        };
        ui._startScreencast = this._start;
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

    /** The frame of the selection, from the config as it is now. */
    sync() {
        if (!this._ui)
            return;
        this._frame?.destroy();
        const {width, radius, reach} = frameSpec(this._config);
        const [ok, color] = Cogl.Color.from_string(this._config.values.focusRing.color);
        this._frame = new Frame(
            ok ? color : new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 140}),
            width, radius, {x: -reach, y: -reach});
        this._frame.add_constraint(new Clutter.BindConstraint({
            source: this._selection, coordinate: Clutter.BindCoordinate.SIZE, offset: 2 * reach,
        }));
        this._selection.add_child(this._frame);
    }

    disable() {
        const ui = this._ui;
        if (!ui)
            return;
        this._ui = null;
        if (ui._startScreencast === this._start)
            delete ui._startScreencast;
        this._frame?.destroy();
        this._frame = null;
        for (const dot of this._dots)
            dot.destroy();
        for (const name of HANDLES)
            ui._areaSelector[name].layout_manager = null;
        this._backdrop.detach(ui._panel);
        ui._panel.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._shadowOpacity.unbind();
        this._shadow.destroy();
        this._shadow = null;
        ui.remove_style_class_name('kelp-shot');
    }

    /** Before the shell starts a recording and closes its panel. */
    _handOff(nRetries = 0) {
        const ui = this._ui;
        // The shell records no window, and a second try has no panel.
        if (nRetries > 0 || ui._windowButton.checked || !ui.visible)
            return;
        const [x, y, width, height] = ui._getSelectedGeometry(false);
        const pictures = global.stage.peek_stage_views().map(view => {
            const layout = new Mtk.Rectangle();
            view.get_layout(layout);
            return {
                content: global.stage.paint_to_content(layout, view.get_scale(),
                    view.color_state, Clutter.PaintFlag.NO_CURSORS),
                x: layout.x, y: layout.y, width: layout.width, height: layout.height,
            };
        });
        this._privacy.handOff({x, y, width, height}, pictures);
    }
}
