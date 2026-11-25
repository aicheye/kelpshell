// SPDX-License-Identifier: GPL-3.0-or-later

// The shell's panel for screenshots and screen recordings, with the look of
// the rest: the panel has the card material, and the selected area has a
// 1px line on its edge and an angle around each corner, where the shell has
// a 2px line and a 24px disc. The rules are in the stylesheet, under
// .kelp-shot.
//
// The shell closes the panel in one frame when a recording starts, so that
// the recording does not show it going. Here the screen is painted into a
// picture before that, and lib/privacy.js fades the picture out where the
// recording does not see it, while its darkening around the area comes.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The shell's handles on the corners of the selected area, each with the
// side of the corner its angle is on: -1 left or top, 1 right or bottom.
const HANDLES = [
    ['_topLeftHandle', -1, -1], ['_topRightHandle', 1, -1],
    ['_bottomLeftHandle', -1, 1], ['_bottomRightHandle', 1, 1],
];
// An angle is two bars ANGLE_WIDTH px wide and ANGLE_LENGTH px long, outside
// the area, with their inner edges on its edge.
const ANGLE_WIDTH = 3;
const ANGLE_LENGTH = 14;

export class Shot {
    constructor(backdrop, privacy) {
        this._backdrop = backdrop;
        this._privacy = privacy;
        this._ui = null;
        this._laterId = 0;
    }

    enable() {
        const ui = Main.screenshotUI;
        if (!ui?._panel || !ui._primaryMonitorBin || !ui._areaSelector)
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

        // The handle is a square with the corner of the area in its middle,
        // and stays as large as the shell has it: that is where a corner
        // can be taken.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [t, l] = [ANGLE_WIDTH * scale, ANGLE_LENGTH * scale];
        this._angles = HANDLES.map(([name, sideX, sideY]) => {
            const handle = ui._areaSelector[name];
            const angle = new Clutter.Actor();
            const place = () => {
                const [cx, cy] = [handle.width / 2, handle.height / 2];
                const x = sideX < 0 ? cx - t : cx + t - l;
                const y = sideY < 0 ? cy - t : cy + t - l;
                const [across, down] = angle.get_children();
                across.set_position(x, sideY < 0 ? cy - t : cy);
                across.set_size(l, t);
                down.set_position(sideX < 0 ? cx - t : cx, y);
                down.set_size(t, l);
            };
            angle.add_child(new St.Widget({style_class: 'kelp-shot-angle'}));
            angle.add_child(new St.Widget({style_class: 'kelp-shot-angle'}));
            handle.add_child(angle);
            handle.connectObject('notify::size', place, this);
            place();
            return angle;
        });

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

    disable() {
        const ui = this._ui;
        if (!ui)
            return;
        this._ui = null;
        if (ui._startScreencast === this._start)
            delete ui._startScreencast;
        for (const angle of this._angles)
            angle.destroy();
        for (const [name] of HANDLES)
            ui._areaSelector[name].disconnectObject(this);
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
