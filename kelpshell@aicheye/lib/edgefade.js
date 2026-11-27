// SPDX-License-Identifier: GPL-3.0-or-later

// Windows that scroll off the left of the view pass under the sidebar and
// run on to the edge of the monitor. Under the sidebar they are darkened
// towards black: by theme.shade (0.35) at the edge of the monitor, and less
// from there on, across the whole width the sidebar reserves, with no part
// where it stays the same.
//
// With theme.liveBlur they are blurred there too. The blur is full from the
// edge of the monitor across theme.shadeRamp (0.1) of that width, and
// lessens from there to nothing where the work area starts. Without it the
// windows are sharp under the sidebar, and darkened as with it.
//
// The blur is drawn here over the windows across that whole width, so the
// windows are blurred between the cards too. It is four pictures of the
// windows (lib/glass.js), blurred 3, 6, 12 and 24 px wide on a 1920 px
// monitor, one over the other. The widest is the one the cards show. The
// width from where the work area starts to theme.shadeRamp is four equal
// shares, and each picture comes in across one of them: the 3 px one
// nearest the work area, the 24 px one last. So the blur doubles from share
// to share, and a line of text gets wider and fainter towards the edge of
// the monitor.
//
// The 24 px picture alone, whole across 85% of the width and mixed with the
// sharp windows across the last 15%, reads as a band with one soft edge:
// text is either gone or sharp, and in the 28 px between it is both at once.
//
// The pictures are see-through where no window is, so the wallpaper stays
// as it is. The darkening is not drawn here. It is part of the shader every
// window is cut with, which is given the place from here (setShade in
// lib/corners.js), so it lies on the windows only and not on the wallpaper
// between them, and the picture is made of windows that are darkened
// already.
//
// With the blur under the cards only, the text of a window is sharp and
// easy to read between the cards and behind the downloads pile: the
// darkening is half of theme.shade in the middle of the cards.
//
// theme.shade is 0.35, towards black, and lessens across the whole width,
// so a white window is #a6a6a6 at the edge of the monitor and nowhere
// darker. A shade of 0.6 towards the tint makes a grey band as wide as the
// sidebar over a white window, with a soft edge 15% of that width. A shade
// of 1 towards black, full across 25% of the width and lessening across the
// other 75%, about 138 px, makes a white window a black slab at the edge of
// the monitor that goes to white within 100 px.
//
// Under the collapsed sidebar the width is 68 px in place of 198. With the
// same darkening and the same four pictures there, a white window goes from
// white to the grey of the edge within a third of the way, and its text is
// blurred 24 px wide in a strip of 68. So both go by the width: the
// darkening at the edge is theme.shade * width / 200 px (0.12 at 68 px),
// which lessens by the same amount per pixel as under the wide sidebar, and
// only the pictures with a blur of a seventh of the width or less are drawn
// (3 and 6 px at 68 px).
//
// While the sidebar collapses or expands, the darkening and the blur go
// with the cards, frame by frame (follow()): they are across the room the
// cards take now, and the windows leave that room or come into it at the
// same pace. The darkening is the one of that width. The blur is between
// what it is under the narrow sidebar and under the wide one, as far along
// as the cards are: each picture comes in across a part of the width that
// goes from its part there to its part here, and a picture the narrow
// sidebar does not show grows from nothing at the edge of the monitor.
//
// Where the shader that darkens the windows cannot be made (lib/corners.js
// needs Cogl snippets and their uniforms in JavaScript), the windows fade
// into the wallpaper instead: the wallpaper is drawn over them, opaque at
// the monitor edge and transparent where the work area starts plus
// layout.gap. The gradient is a fragment shader on one clone of the
// wallpaper actor, so the opacity changes on every pixel column. Without
// Cogl snippets it is a row of 2 px wide clones, each with its own opacity,
// which shows steps on a bright window.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {setShade} from './corners.js';
import {HAVE_GLASS, blurSigma} from './glass.js';

const SLICE = 2;        // px, fallback only
// theme.shadeRamp when the configuration gives no number: where the blur
// of the windows starts to lessen, as a share of the width the sidebar
// reserves, from the edge of the monitor. The darkening does not use it.
const RAMP_AT = 0.1;
// theme.shade when the configuration gives no number: how far the windows
// are mixed towards black at the edge of the monitor.
const SHADE = 0.35;
// The width under the sidebar, px at a display scale of 1, from which the
// darkening at the edge of the monitor is all of theme.shade. Under a
// narrower sidebar it is less by as much as the width is, so it lessens by
// the same amount per pixel under a wide and a narrow sidebar.
const SHADE_WIDTH = 200;
// The blur under the sidebar has a sigma of no more than this share of the
// width under it.
const BLUR_SHARE = 1 / 7;
const RESIZE_MS = 240;  // the sidebar's collapse animation, see sidebar.js
// The blurred windows end this many px before the first column starts. A
// redraw is asked for 1 px larger than what changed, so with the layers up
// to that column, every frame a window there draws also draws all of them
// (measured). They are see-through at that end.
export const EDGE = 2;
const SHOW_MS = 200;

// Premultiplied colour, so every channel is scaled. s runs 0 to 1 across the
// actor: the wallpaper is opaque at the left and gone at the right.
const FADE_GLSL = 'cogl_color_out *= 1.0 - smoothstep(0.0, 1.0, cogl_tex_coord_in[0].s);';
// The pictures of lib/glass.js the blurred windows are drawn with, the
// sharpest first: a blur of 3, 6, 12 and 24 px on a 1920 px monitor.
const LEVELS = [3, 2, 1, 0];

const HAVE_SNIPPETS = typeof Cogl.Snippet?.new === 'function' &&
    typeof Clutter.OffscreenEffect.prototype.get_pipeline === 'function';

const FadeEffect = GObject.registerClass(
class KelpFadeEffect extends Clutter.OffscreenEffect {
    vfunc_paint_target(node, paintContext) {
        // Clutter creates the pipeline with the offscreen buffer and makes a
        // new one when the buffer is resized.
        const pipeline = this.get_pipeline();
        if (pipeline && pipeline !== this._pipeline) {
            this._pipeline = pipeline;
            try {
                pipeline.add_snippet(
                    Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, '', FADE_GLSL));
            } catch (e) {
                console.warn(`kelpshell: edge fade shader: ${e.message}`);
            }
        }
        super.vfunc_paint_target(node, paintContext);
    }
});

export class EdgeFade {
    constructor(wm) {
        this._wm = wm;
        this._signature = '';
        this._band = null;       // {monitor, x, y, width, height}
        this._room = null;       // px, see follow()
        this._ends = null;       // [px, px], see follow()
    }

    enable() {
        this.actor = new Clutter.Actor({
            reactive: false, visible: false, clip_to_allocation: true,
        });
        Main.uiGroup.insert_child_above(this.actor, global.window_group);
        // With theme.liveBlur: the windows under the sidebar, blurred.
        this.frost = new Clutter.Actor({
            reactive: false, visible: false, clip_to_allocation: true,
        });
        Main.uiGroup.insert_child_above(this.frost, global.window_group);
        this._frostKey = '';
        global.display.connectObject(
            'in-fullscreen-changed', () => this.sync(),
            'workareas-changed', () => this.sync(),
            this);
        // The shell replaces its background actors after this signal, in
        // its own handler, so the source is looked up a moment later.
        Main.layoutManager.connectObject(
            'monitors-changed', () => this.syncSoon(),
            'startup-complete', () => this.sync(true),
            this);
        this.sync();
    }

    disable() {
        if (this._soonId)
            GLib.source_remove(this._soonId);
        this._soonId = 0;
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._manager?.disconnectObject(this);
        this._manager = null;
        setShade(null);
        this._shadeKey = undefined;
        this.actor.destroy();
        this.actor = null;
        // Its layers go with it.
        this.frost.destroy();
        this.frost = this._layers = this._levels = null;
        this._wm.glass?.setFineArea(null);
        this._band = null;
    }

    /**
     * The place of the wallpaper drawn over the windows, {monitor, x, y,
     * width, height}, or null for none: the windows are darkened instead.
     */
    get band() {
        return this._band;
    }

    /**
     * Hide the fade (on) or show it again. During a workspace switch the
     * wallpaper moves, so this still copy of it cannot stand for it. The
     * windows that slide are faded themselves for that time, see
     * lib/wsslide.js.
     */
    suspend(on) {
        this._suspended = on;
        if (!this.actor)
            return;
        if (on) {
            this.actor.hide();
        } else if (this._band) {
            this.actor.remove_all_transitions();
            this.actor.opacity = 255;
            this.actor.show();
        }
    }

    syncSoon() {
        if (this._soonId)
            return;
        this._soonId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._soonId = 0;
            this.sync(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The sidebar is changing its width and takes px of the monitor now,
     * on its way between the two widths of ends, [narrower, wider]: the
     * windows are darkened and blurred across px. ends can be left out
     * after the first call. null when the sidebar has its width.
     *
     * The work area has the new width from the first frame, and the cards
     * and the windows take 240 ms to get there. Taken from the work area,
     * the darkening and the blur would change in that one frame: the
     * windows that still leave the room of a sidebar that widens would be
     * blurred and darkened on the way.
     */
    follow(px, ends = null) {
        if (px === this._room)
            return;
        this._room = px;
        this._ends = px === null ? null : ends ?? this._ends;
        this.sync();
    }

    /** Recompute the band from the work area and rebuild it if it changed. */
    sync(force = false) {
        if (!this.actor)
            return;
        const index = Main.layoutManager.primaryIndex;
        const monitor = Main.layoutManager.primaryMonitor;
        const manager = Main.layoutManager._bgManagers?.[index] ?? null;
        const source = manager?.backgroundActor ?? null;
        let band = null;
        const theme = this._wm.config.values.theme;
        // HAVE_GLASS: the windows have the shader that darkens them.
        const live = HAVE_GLASS && theme.liveBlur === true;
        const set = Number(theme.shadeRamp);
        const rampAt = Number.isFinite(set) ? Math.max(0, Math.min(0.999, set)) : RAMP_AT;
        if (monitor && (HAVE_GLASS || source) && !global.display.get_monitor_in_fullscreen(index)) {
            const ws = global.workspace_manager.get_active_workspace();
            const area = ws.get_work_area_for_monitor(index);
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const gap = this._wm.config.values.layout.gap * scale;
            let room = area.x - monitor.x;
            // The wallpaper drawn over the windows has a transition of its
            // own below. It keeps to the narrower width until the sidebar
            // has its width.
            if (this._room !== null)
                room = HAVE_GLASS ? this._room : Math.min(room, this._ends?.[0] ?? room);
            const width = room + gap;
            // Only where something (the sidebar) reserves the left edge.
            if (room > 0 && width > 0) {
                band = {
                    monitor: index,
                    x: monitor.x, y: monitor.y,
                    width, height: monitor.height,
                    ramp: width,
                    full: [monitor.width, monitor.height],
                    // The widths of the band at the two ends of the
                    // sidebar's way, see follow().
                    ends: this._room !== null && this._ends
                        ? this._ends.map(px => px + gap) : null,
                };
            }
        }
        // The band is where the windows are darkened, and with the live
        // blur blurred. The wallpaper is not drawn over them.
        let shade = null;
        const wanted = Number(theme.shade);
        let strength = Number.isFinite(wanted) ? Math.max(0, Math.min(1, wanted)) : SHADE;
        if (band) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            strength *= Math.min(1, band.width / (SHADE_WIDTH * scale));
        }
        if (HAVE_GLASS && band && strength > 0) {
            // ramp is x0: the darkening lessens from the edge of the monitor
            // on. A part at full strength reads as a band over a white window.
            shade = {
                x0: band.x, ramp: band.x, x1: band.x + band.width,
                y0: band.y, y1: band.y + band.height,
                color: [0, 0, 0],
                strength,
            };
        }
        const shadeKey = JSON.stringify(shade);
        if (shadeKey !== this._shadeKey) {
            this._shadeKey = shadeKey;
            setShade(shade);
            if (this._room !== null) {
                // The shader reads the shade at every paint, so the windows
                // are only painted again, and their clones in the blurred
                // pictures with them. The corners are as they were.
                for (const actor of global.get_window_actors())
                    actor.queue_redraw();
            } else {
                // The tiling makes the corners after this object.
                this._wm.corners?.syncAll();
            }
        }
        this._syncFrost(live ? band : null, rampAt);
        if (HAVE_GLASS)
            band = null;

        if (manager !== this._manager) {
            this._manager?.disconnectObject(this);
            this._manager = manager;
            // 'changed' follows a wallpaper change, when the actor is replaced.
            manager?.connectObject('changed', () => this.sync(true), this);
        }

        const signature = JSON.stringify(band);
        const changed = force || signature !== this._signature || source !== this._source;
        const hadBand = this._band !== null;
        this._band = band;
        this._signature = signature;
        this._source = source;
        if (!changed)
            return;

        const actor = this.actor;
        const animate = St.Settings.get().enable_animations;
        actor.remove_all_transitions();
        if (!band) {
            // Fullscreen, the windows are darkened instead, or nothing
            // reserves the edge any more.
            actor.ease({
                opacity: 0,
                duration: animate ? SHOW_MS : 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => actor.hide(),
            });
        } else {
            actor.destroy_all_children();
            actor.set_position(band.x, band.y);
            actor.height = band.height;
            if (HAVE_SNIPPETS) {
                if (!actor.get_effect('fade'))
                    actor.add_effect_with_name('fade', new FadeEffect());
                actor.add_child(new Clutter.Clone({
                    source, x: 0, y: 0, width: band.full[0], height: band.full[1],
                }));
                // The sidebar collapses and expands over RESIZE_MS. The fade
                // follows it at the same pace.
                if (hadBand && actor.visible && animate) {
                    actor.ease({
                        width: band.width,
                        duration: RESIZE_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                } else {
                    actor.width = band.width;
                }
            } else {
                actor.width = band.width;
                for (let x = 0; x < band.width; x += SLICE) {
                    const t = (x + SLICE / 2) / band.width;
                    const alpha = 1 - t * t * (3 - 2 * t);   // smoothstep, 1 to 0
                    this._slice(source, band, x, Math.min(SLICE, band.width - x),
                        Math.round(255 * Math.max(0, Math.min(1, alpha))));
                }
            }
            if (this._suspended)
                return;
            if (!actor.visible)
                actor.opacity = 0;
            actor.show();
            actor.ease({
                opacity: 255,
                duration: animate ? SHOW_MS : 0,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Show the blurred windows across place, a band (see sync()), or hide
     * them (null).
     */
    _syncFrost(place, rampAt) {
        const glass = this._wm.glass;
        if (!glass)
            place = null;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // What is drawn across a band of this width at rest: the pictures,
        // the sharpest first and in any case, the width they are drawn
        // across, and for each the x it starts to come in at and the x it
        // is whole from, towards the edge of the monitor. Each comes in
        // over one share of the width between where the work area starts
        // and rampAt, over the one before it, so the blur doubles from one
        // share to the next.
        const rest = width => {
            const levels = LEVELS.filter((level, i) => i === 0 ||
                blurSigma(level, place.full[0]) <= width * BLUR_SHARE);
            const across = Math.max(1, width - EDGE * scale);
            const span = across * (1 - rampAt) / levels.length;
            return {
                levels, across,
                fades: levels.map((_level, i) => [across - span * i, across - span * (i + 1)]),
            };
        };
        let look = null;
        let area = null;
        if (place) {
            look = rest(place.width);
            area = {x: place.x, y: place.y, width: place.width, height: place.height};
        }
        if (place?.ends) {
            // On the way between two widths, see follow(). The pictures of
            // the narrow band are the first of those of the wide one.
            const [narrow, wide] = place.ends.map(rest);
            const way = place.ends[1] - place.ends[0];
            const t = way > 0
                ? Math.max(0, Math.min(1, (place.width - place.ends[0]) / way)) : 1;
            look = {
                levels: wide.levels,
                across: look.across,
                fades: wide.fades.map((to, i) => {
                    const from = narrow.fades[i] ?? [0, 0];
                    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
                }),
            };
            // The sharper pictures are made for the wide band all the way:
            // they are made again when their area changes.
            area.width = place.ends[1];
        }
        const key = JSON.stringify(place && [place.x, place.y, place.height, look, area]);
        if (key === this._frostKey)
            return;
        this._frostKey = key;
        glass?.setFineArea(area);
        if (!place) {
            this.frost.hide();
            return;
        }
        // The windows as they are: no tint, and the darkening is in them
        // already. The sharpest picture lies lowest.
        if (this._levels !== look.levels.join()) {
            this._levels = look.levels.join();
            this.frost.destroy_all_children();
            this._layers = look.levels.map(level => {
                const layer = glass.createLayer([[0, 0, 0], 0, 1], level);
                this.frost.add_child(layer);
                return layer;
            });
        }
        this._layers.forEach((layer, i) => {
            const [from, to] = look.fades[i];
            layer.set_size(Math.max(1, Math.ceil(from)), place.height);
            layer.setFade(from, to);
        });
        this.frost.set_position(place.x, place.y);
        this.frost.set_size(look.across, place.height);
        this.frost.show();
        // The layers have moved with the actor they are in.
        glass.moved();
    }

    _slice(source, band, x, width, opacity) {
        if (opacity <= 0)
            return;
        const slice = new Clutter.Actor({
            x, y: 0, width, height: band.height,
            clip_to_allocation: true,
            opacity,
        });
        slice.add_child(new Clutter.Clone({
            source, x: -x, y: 0, width: band.full[0], height: band.full[1],
        }));
        this.actor.add_child(slice);
    }
}
