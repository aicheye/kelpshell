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
// - The screen under the panel is the screen as it is now for as long as
//   a window is chosen, for a screenshot too, where the shell shows a
//   picture of the screen from the moment the panel opened. A window that
//   is chosen takes the focus and its column slides to the middle of the
//   view, so a window that is out of the view can be chosen as well: by
//   its icon in the sidebar, whose cards with the windows stay clear, or
//   with the keys. The screenshot of a window is taken when it is saved.
//   The cards of the sidebar lie over the rings, as over the windows.
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

import {holdInPlace} from './castplace.js';
import {visibleRect} from './crop.js';
import {cornerPicture, piece} from './privacy.js';
import {WindowRecorder} from './windowrec.js';

// How dark the panel has everything around the selected area: the value of
// .screenshot-ui-area-indicator-shade in the stylesheet.
const SELECT_SHADE = 0.5;
// A window that is chosen gets clear over this long while the one before
// it is darkened, and the windows come and go over it, as the panel's own
// parts do.
const MOVE_MS = 200;
// The opacity, of 255, of the ring on the window under the pointer while
// that is not the chosen one, and how long it takes to come and go.
const HOVER_OPACITY = 130;
const HOVER_MS = 80;
// After a window is chosen the pointer has to move this far, px, before a
// window under it gets that ring again.
const HOVER_AWAY = 8;

const text = Gettext.domain('gnome-shell').gettext;

// The ring around a place, `width` px outside it on each side, as the ring
// of the focused window is: four lines along the sides and four corners.
// A corner with a radius is one of a window: its picture darkens the place
// outside the curve and has the ring's curve (cornerPicture in
// lib/privacy.js). The darkening is `shade`, that of what is around the
// place, or 0 for a place that is darkened as a whole. Without `line` the
// ring has no colour and is the darkening of the corners alone.
const Ring = GObject.registerClass(
class KelpShotRing extends Clutter.Actor {
    _init(config, shade, line = true) {
        super._init();
        const ring = config.values.focusRing;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [ok, color] = Cogl.Color.from_string(ring.color);
        this._color = ok ? color : new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 140});
        if (!line)
            this._color = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0});
        this._shade = shade;
        this.reach = Math.max(1, Math.round(ring.width)) * scale;
        this._radii = [0, 0, 0, 0];
        this._drawn = [null, null, null, null];
        this._lines = [0, 1, 2, 3].map(() => new Clutter.Actor({background_color: this._color}));
        this._corners = [[false, false], [true, false], [false, true], [true, true]].map(
            ([flipX, flipY]) => piece(null, 0, 0, 0, 0, flipX, flipY));
        for (const child of [...this._lines, ...this._corners])
            this.add_child(child);
    }

    /**
     * The radius of each corner of the place, px of the stage: upper left,
     * upper right, lower left, lower right. 0: square.
     */
    set radii(radii) {
        if (radii.every((radius, i) => radius === this._radii[i]))
            return;
        this._radii = [...radii];
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [Math.round(box.get_width()), Math.round(box.get_height())];
        const t = this.reach;
        const most = Math.max(0, Math.min(Math.floor((w - 2 * t) / 2), Math.floor((h - 2 * t) / 2)));
        // The size of each corner: its radius and the ring.
        const n = this._radii.map((wanted, i) => {
            const radius = Math.min(wanted, most);
            if (radius !== this._drawn[i]) {
                this._drawn[i] = radius;
                // With no radius the picture is the ring's own corner, whose
                // outer edge is round by the width of the ring.
                this._corners[i].content =
                    cornerPicture(radius, radius > 0 ? this._shade : 0, this._color, t);
            }
            return radius + t;
        });
        const place = (child, x, y, width, height) => child.allocate(new Clutter.ActorBox({
            x1: x, y1: y, x2: x + Math.max(0, width), y2: y + Math.max(0, height),
        }));
        place(this._lines[0], n[0], 0, w - n[0] - n[1], t);
        place(this._lines[1], n[2], h - t, w - n[2] - n[3], t);
        place(this._lines[2], 0, n[0], t, h - n[0] - n[2]);
        place(this._lines[3], w - t, n[1], t, h - n[1] - n[3]);
        place(this._corners[0], 0, 0, n[0], n[0]);
        place(this._corners[1], w - n[1], 0, n[1], n[1]);
        place(this._corners[2], 0, h - n[2], n[2], n[2]);
        place(this._corners[3], w - n[3], h - n[3], n[3], n[3]);
    }
});

/** A ring on `place` (an actor), which it follows. */
function ringOn(config, place, shade, line = true) {
    const ring = new Ring(config, shade, line);
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
        this._holes = [];        // the two clear places, see enable
        this._front = 0;         // which of them is on the chosen window
        this._pointed = null;    // the entry under the pointer, if it is not chosen
        this._chosenAt = null;   // where the pointer was when a window was chosen, see _choose
        this._tickId = 0;
        this._wins = new Map();  // the shell's entry for a window -> the window
        this._cell = null;       // the icon in the sidebar the pointer is on
        this._cards = new Map(); // a card of the sidebar -> its picture over the darkening
        this.sidebar = null;     // set by extension.js
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

        // Where a window is chosen. Over the whole stage lie two of the
        // shell's own actors for an area with everything around it
        // darkened, each with a window as its area: the chosen window, and
        // the one that was chosen before it for as long as it takes that
        // one to get dark again (_place).
        const Indicator = ui._areaSelector._areaIndicator.constructor;
        this._picker = new Clutter.Actor({reactive: true, visible: false, opacity: 0});
        this._picker.add_constraint(new Clutter.BindConstraint({
            source: global.stage, coordinate: Clutter.BindCoordinate.ALL,
        }));
        ui.insert_child_below(this._picker, this._shadow);
        this._holes = [0, 1].map(() => {
            const actor = new Indicator({style_class: 'screenshot-ui-area-selector'});
            actor.add_constraint(new Clutter.BindConstraint({
                source: this._picker, coordinate: Clutter.BindCoordinate.SIZE,
            }));
            this._picker.add_child(actor);
            return {actor, ring: null, entry: null};
        });
        // The place of the window under the pointer, for its ring.
        this._hover = new Clutter.Actor({opacity: 0});
        this._picker.add_child(this._hover);
        this._picker.connectObject(
            'motion-event', (_a, event) => this._point(...event.get_coords()),
            'leave-event', () => this._point(-1, -1),
            'button-release-event', (_a, event) => {
                const {entry} = this._at(...event.get_coords());
                if (entry)
                    entry.widget.checked = true;
                return Clutter.EVENT_STOP;
            }, this);
        ui.connectObject(
            'closed', () => {
                this._showWindows(false, false);
                this._wins.clear();
                // For the next time the panel opens.
                ui._stageScreenshotContainer.opacity = 255;
            },
            'key-press-event', (_a, event) => this._key(event), this);

        this.sync();

        this._recorder = new WindowRecorder(this._config);
        this._recorder.probe().then(() => this._ui?._syncWindowButtonSensitivity())
            .catch(e => console.warn(`kelpshell: window recording: ${e.message}`));

        // Own properties over the methods of the class, taken away again in
        // disable().
        const {_startScreencast: start, stopScreencast: stop, open, _saveScreenshot: save} = ui;
        this._own = {
            _saveScreenshot: (...args) => {
                try {
                    if (ui._windowButton.checked)
                        this._retake();
                } catch (e) {
                    console.warn(`kelpshell: screenshot of a window: ${e.message}`);
                }
                return save.apply(ui, args);
            },
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
                const opened = open.apply(ui, args);
                // The shell has made its list by now, and a window is
                // still where its entry says. Later it may have moved.
                this._mapWindows();
                await opened;
                if (this._ui && ui.visible && ui._windowButton.checked)
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
            // The shell shows its picture of the screen again when the
            // panel goes back to screenshots.
            this._syncFrozen(true);
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
        this._ring = ringOn(this._config, this._selection, SELECT_SHADE);
        // A clear place darkens the corners of its window outside their
        // curve, and comes and goes with a fade. The ring of the chosen
        // window is an actor of its own, which is on the window at once.
        for (const hole of this._holes) {
            hole.ring?.destroy();
            hole.ring = ringOn(this._config, hole.actor._selectionRect, SELECT_SHADE, false);
        }
        this._chosenRing?.destroy();
        this._chosenRing = new Ring(this._config, 0);
        this._picker.insert_child_above(this._chosenRing, this._hover);
        // The window under the pointer is darkened, corners and all.
        this._hoverRing?.destroy();
        this._hoverRing = ringOn(this._config, this._hover, 0);
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
        this._recorder.destroy();
        this._recorder = null;
        this._releaseWindow();
        ui.disconnectObject(this);
        for (const widget of this._windows())
            widget.disconnectObject(this);
        this._showWindows(false, false);
        this._wins.clear();
        // The shell's picture of the screen, for its own list of windows.
        ui._stageScreenshotContainer.opacity = 255;
        if (ui.visible && ui._shotButton.checked)
            ui._stageScreenshotContainer.show();
        this._ring?.destroy();
        this._ring = this._hoverRing = this._hover = this._chosenRing = null;
        this._picker.destroy();
        this._picker = null;
        this._holes = [];
        this._cards.clear();
        this.sidebar = null;
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
     * Which window each entry of the shell's list shows. The shell says
     * where the window was when the list was made, so this is asked right
     * after that. An entry that is known keeps its window.
     */
    _mapWindows() {
        const widgets = this._windows();
        for (const widget of [...this._wins.keys()]) {
            if (!widgets.includes(widget))
                this._wins.delete(widget);
        }
        const taken = new Set(this._wins.values());
        for (const widget of widgets) {
            if (this._wins.has(widget))
                continue;
            const win = this._windowOf(widget, taken);
            if (win) {
                this._wins.set(widget, win);
                taken.add(win);
            }
        }
    }

    /**
     * Where a window is drawn, as far as it is shown, and the radius of
     * each of its corners: {rect, radii}, or null for a window of which
     * nothing is shown. A tile is cut at the sides of its monitor, and
     * every window at the edges of the stage. A corner that is cut off is
     * square.
     */
    _placeOf(win) {
        if (win.minimized || !win.get_compositor_private())
            return null;
        const [width, height] = global.stage.get_size();
        const view = this._tiling?.tiles.get(win)?.strip?.monitorRect;
        const drawn = this._tiling?.drawnRect(win) ?? visibleRect(this._config, win);
        const x1 = Math.max(view?.x ?? 0, 0, drawn.x), y1 = Math.max(0, drawn.y);
        const x2 = Math.min(view ? view.x + view.width : width, width, drawn.x + drawn.width);
        const y2 = Math.min(height, drawn.y + drawn.height);
        if (x2 <= x1 || y2 <= y1)
            return null;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = this._config.values.windows.clipCorners && !win.is_fullscreen()
            ? Math.round(this._config.values.focusRing.radius) * scale : 0;
        const [left, top] = [x1 > drawn.x, y1 > drawn.y];
        const [right, bottom] = [x2 < drawn.x + drawn.width, y2 < drawn.y + drawn.height];
        return {
            rect: {x: x1, y: y1, width: x2 - x1, height: y2 - y1},
            radii: [left || top, right || top, left || bottom, right || bottom]
                .map(cut => cut ? 0 : radius),
        };
    }

    /**
     * The windows that can be chosen, the top one first: {widget, win,
     * rect, radii}. widget is the shell's entry for the window, whose
     * `checked` is what the shell takes as chosen. A window of which
     * nothing is shown has no rect.
     */
    _listWindows() {
        const entries = [];
        for (const widget of this._windows()) {
            const win = this._wins.get(widget);
            if (win)
                entries.push({widget, win, rect: null, radii: null, ...this._placeOf(win)});
        }
        const order = global.display.sort_windows_by_stacking(entries.map(e => e.win));
        return entries.sort((a, b) => order.indexOf(b.win) - order.indexOf(a.win));
    }

    /**
     * What can be chosen at a point of the stage: {entry, cell}. On the
     * sidebar that is the window whose icon is there, with the icon, and
     * nothing on the rest of a card. Elsewhere it is the top window there.
     */
    _at(x, y) {
        const card = this.sidebar?.pick(x, y);
        if (card) {
            const entry = card.win ? this._entries.find(e => e.win === card.win) : null;
            return {entry: entry ?? null, cell: entry ? card.cell : null};
        }
        const entry = this._entries.find(({rect}) => rect &&
            x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
        return {entry: entry ?? null, cell: null};
    }

    /** The icon in the sidebar under the pointer is drawn as one that is pointed at. */
    _setCell(cell) {
        if (cell === this._cell)
            return;
        this._cell?.remove_style_pseudo_class('hover');
        this._cell?.disconnectObject(this);
        this._cell = cell;
        cell?.add_style_pseudo_class('hover');
        // The sidebar builds its icons again when the focus moves.
        cell?.connectObject('destroy', () => (this._cell = null), this);
    }

    /** The pointer is here: the window under it has a faint ring. */
    _point(x, y) {
        this._pointer = [x, y];
        const away = HOVER_AWAY * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (this._chosenAt && Math.hypot(x - this._chosenAt[0], y - this._chosenAt[1]) >= away)
            this._chosenAt = null;
        this._repoint();
        this._place();
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * What the pointer is on, from where it was last. Also after the
     * windows have moved under a pointer that stands still.
     */
    _repoint() {
        const {entry, cell} = this._at(...this._pointer ?? [-1, -1]);
        this._setCell(cell);
        const pointed = entry && !entry.widget.checked && !this._chosenAt ? entry : null;
        const shown = !!pointed?.rect;
        if (pointed === this._pointed && shown === this._hoverShown)
            return;
        this._pointed = pointed;
        this._hoverShown = shown;
        this._hover.ease({
            opacity: shown ? HOVER_OPACITY : 0,
            duration: HOVER_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Another window is chosen, or none. The window takes the focus and
     * its column slides to the middle of the view. Its clear place is on
     * it from the start and gets clear as the one of the window before
     * gets dark (_place).
     *
     * The ring of the window under the pointer is gone at once and stays
     * away until the pointer has moved: the windows slide now, and the
     * ring would come and go on each one that passes under a pointer that
     * rests where the click was.
     */
    _choose(animate) {
        const entry = this._entries.find(e => e.widget.checked) ?? null;
        const [front, back] = [this._holes[this._front], this._holes[1 - this._front]];
        this._chosenAt = [...this._pointer ?? [-1, -1]];
        this._hover.remove_all_transitions();
        this._hover.opacity = 0;
        this._hoverShown = false;
        this._pointed = null;
        this._repoint();
        front.actor.remove_all_transitions();
        back.actor.remove_all_transitions();
        if (animate && entry !== front.entry && St.Settings.get().enable_animations) {
            // The two change places: the one that was dark is on the new
            // window, and the other stays on the window before.
            this._front = 1 - this._front;
            back.entry = entry;
            back.actor.opacity = 0;
            back.actor.ease({
                opacity: 255,
                duration: MOVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            front.entry = entry;
            front.actor.opacity = 255;
            back.entry = null;
        }
        if (entry && animate)
            this._tiling?.focusInMiddle(entry.win);
        this._place();
    }

    /**
     * The clear places and the rings are where their windows are drawn
     * now, and the cards of the sidebar with the windows are clear. Before
     * every frame while the panel shows them: the windows move under it.
     */
    _place() {
        const picker = this._picker;
        if (!picker?.visible)
            return;
        for (const entry of this._entries)
            Object.assign(entry, {rect: null, radii: null}, this._placeOf(entry.win));
        // Another window may be under the pointer now.
        const places = this._entries.map(({rect}) =>
            rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : '').join(';');
        if (places !== this._places) {
            this._places = places;
            this._repoint();
        }
        this._placeCards();
        const chosen = this._holes[this._front].entry;
        const ring = this._chosenRing;
        ring.visible = !!chosen?.rect;
        if (ring.visible) {
            ring.radii = chosen.radii;
            ring.set_position(chosen.rect.x - ring.reach, chosen.rect.y - ring.reach);
            ring.set_size(chosen.rect.width + 2 * ring.reach, chosen.rect.height + 2 * ring.reach);
        }
        for (const hole of this._holes) {
            const place = hole.actor._selectionRect;
            const rect = hole.entry?.rect;
            hole.ring.visible = !!rect;
            if (rect) {
                hole.ring.radii = hole.entry.radii;
                place.set_position(rect.x, rect.y);
                place.set_size(rect.width, rect.height);
            } else {
                // Everything is darkened.
                place.set_size(0, 0);
            }
        }
        // Two darkenings of a and b lie over everything but the two
        // windows. Together they are as dark as one: (1 - a)(1 - b) is
        // 1 - SELECT_SHADE.
        const [front, back] = [this._holes[this._front], this._holes[1 - this._front]];
        const a = SELECT_SHADE * front.actor.opacity / 255;
        back.actor.opacity = Math.round(255 * (1 - (1 - SELECT_SHADE) / (1 - a)) / SELECT_SHADE);
        if (back.actor.opacity === 0)
            back.entry = null;
        const pointed = this._pointed?.rect ? this._pointed : null;
        if (pointed) {
            this._hover.set_position(pointed.rect.x, pointed.rect.y);
            this._hover.set_size(pointed.rect.width, pointed.rect.height);
            this._hoverRing.radii = pointed.radii;
        }
    }

    /**
     * The cards of the sidebar, as pictures over the darkening and the
     * rings: a window runs under the cards, and so does its ring. The
     * cards with the icons of the windows are clear, a window is chosen
     * there too. The others are as dark as what is around the window.
     */
    _placeCards() {
        const clear = this.sidebar?.windowCards ?? [];
        const sources = [...clear, ...this.sidebar?.otherCards ?? []];
        for (const [source, card] of this._cards) {
            if (!sources.includes(source)) {
                this._cards.delete(source);
                card.destroy();
            }
        }
        for (const source of sources) {
            let card = this._cards.get(source);
            if (!card) {
                card = new Clutter.Clone({source});
                // A picture of the card with every colour at 1 - SELECT_SHADE
                // of its strength is the card under a darkening of
                // SELECT_SHADE, and is cut to the card's own outline.
                card._shade = new Clutter.BrightnessContrastEffect();
                card._shade.set_brightness(-SELECT_SHADE);
                card.add_effect(card._shade);
                this._cards.set(source, card);
                this._picker.add_child(card);
                source.connectObject('destroy', () => {
                    if (this._cards.delete(source))
                        card.destroy();
                }, card);
            }
            card._shade.enabled = !clear.includes(source);
            card.visible = source.mapped;
            if (!card.visible)
                continue;
            card.set_position(...source.get_transformed_position());
            card.set_size(...source.get_transformed_size());
        }
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
        // From left to right, then from the top down, also past the sides
        // of the view.
        const at = e => this._tiling?.drawnRect(e.win) ?? e.win.get_frame_rect();
        const order = this._entries.filter(e => !e.win.minimized).sort((a, b) => {
            const [ra, rb] = [at(a), at(b)];
            return ra.x - rb.x || ra.y - rb.y;
        });
        if (order.length === 0)
            return Clutter.EVENT_PROPAGATE;
        const now = order.findIndex(e => e.widget.checked);
        order[(Math.max(now, 0) + (now < 0 ? 0 : step) + order.length) % order.length]
            .widget.checked = true;
        return Clutter.EVENT_STOP;
    }

    /**
     * The shell's picture of the screen from the moment the panel opened
     * is shown for a screenshot of an area or a monitor, and not while a
     * window is chosen or the panel records.
     */
    _syncFrozen(animate) {
        const ui = Main.screenshotUI;
        const frozen = ui._stageScreenshotContainer;
        const shown = !ui._castButton.checked && !ui._windowButton.checked;
        animate &&= St.Settings.get().enable_animations;
        // The fade before this one ends where it is.
        const run = this._frozenRun = (this._frozenRun ?? 0) + 1;
        frozen.remove_all_transitions();
        if (shown)
            frozen.show();
        frozen.ease({
            opacity: shown ? 255 : 0,
            duration: animate ? MOVE_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            // Also when it is cut short: the shell moves the picture to
            // another parent once the panel has faded in, which ends this.
            onStopped: () => {
                if (run !== this._frozenRun)
                    return;
                frozen.opacity = shown ? 255 : 0;
                if (!shown)
                    frozen.hide();
            },
        });
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
        // The ring of the chosen window is drawn here, at once. The ring of
        // lib/tiling.js would fade in under it on every window that is
        // chosen.
        if (this._tiling) {
            this._tiling.ring.covered = shown;
            this._tiling.ring.sync();
        }
        if (!shown) {
            this._entries = [];
            this._pointed = null;
            this._places = null;
            for (const hole of this._holes)
                hole.entry = null;
            this._setCell(null);
            if (this._tickId)
                global.stage.disconnect(this._tickId);
            this._tickId = 0;
            if (ui.visible)
                this._syncFrozen(animate);
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
        this._mapWindows();
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
        this._hoverShown = false;
        this._pointed = null;
        // Where the pointer is now is not known until it moves.
        this._pointer = null;
        picker.show();
        this._syncFrozen(animate);
        this._choose(false);
        if (!this._tickId)
            this._tickId = global.stage.connect('before-update', () => this._place());
        picker.ease({
            opacity: 255,
            duration: animate ? MOVE_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** The window that an entry of the shell's list shows, of those not in `taken`. */
    _windowOf(widget, taken) {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().map(actor => actor.metaWindow).find(win =>
            !taken.has(win) && !win.is_override_redirect() &&
            win.located_on_workspace(workspace) &&
            win.get_frame_rect().equal(widget.boundingBox)) ?? null;
    }

    /**
     * The picture of the chosen window that a screenshot saves, taken
     * now: the window as it is drawn, without its place on the strip and
     * without the shade of the sidebar (lib/castplace.js). The shell took
     * one when the panel opened, of a window that may have had no focus.
     */
    _retake() {
        const entry = this._entries.find(e => e.widget.checked);
        const actor = entry?.win.get_compositor_private();
        const content = entry?.widget.child;
        if (!actor || !content?._actor)
            return;
        const shown = visibleRect(this._config, entry.win);
        const release = holdInPlace(this._config, entry.win, false);
        let picture = null;
        try {
            // The clip is in the coordinates of the actor's parent. The
            // hold has the drawn part at the corner of the actor.
            picture = actor.paint_to_content(new Mtk.Rectangle({
                x: Math.floor(actor.x), y: Math.floor(actor.y),
                width: shown.width, height: shown.height,
            }));
        } finally {
            release();
            this._tiling?.tiles.get(entry.win)?.sync();
        }
        if (!picture)
            return;
        content._actor.content = picture;
        // The pointer of the shell's picture is where it was in the
        // window's buffer. This picture starts at the part that is drawn.
        const frame = entry.win.get_frame_rect();
        const box = content._boundingBox;
        content._bufferRect = new Mtk.Rectangle({
            x: box.x + shown.x - frame.x, y: box.y + shown.y - frame.y,
            width: shown.width, height: shown.height,
        });
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
        // From the list of the panel: the window may have moved since the
        // shell made its own.
        const win = this._entries.find(e => e.widget.checked)?.win;
        if (!win || !this._recorder.available || this._recorder.active)
            return;
        const drawCursor = ui._cursor.visible;
        // The recorded window has the focus and is in the middle of the
        // view when the recording starts.
        this._tiling?.focusInMiddle(win);
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
