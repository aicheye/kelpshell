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
        this._limit = null;      // px, see limit()
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
     * While the sidebar changes its width, the band is no wider than the
     * narrower of the two widths the sidebar takes of the monitor, px:
     * the windows are in the rest of the wider one while they move. null
     * when the sidebar has its width.
     *
     * The work area has the new width from the first frame. With the band
     * as wide as that at once, the windows that still leave the room of a
     * sidebar that widens would be blurred and darkened on the way.
     */
    limit(px) {
        if (px === this._limit)
            return;
        this._limit = px;
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
            const room = Math.min(area.x - monitor.x, this._limit ?? Infinity);
            const width = room + gap;
            // Only where something (the sidebar) reserves the left edge.
            if (room > 0 && width > 0) {
                band = {
                    monitor: index,
                    x: monitor.x, y: monitor.y,
                    width, height: monitor.height,
                    ramp: width,
                    full: [monitor.width, monitor.height],
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
            // The tiling makes the corners after this object.
            this._wm.corners?.syncAll();
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
        // The sharpest picture in any case.
        const levels = place && LEVELS.filter((level, i) => i === 0 ||
            blurSigma(level, place.full[0]) <= place.width * BLUR_SHARE);
        const key = JSON.stringify(place &&
            [place.x, place.y, place.width, place.height, rampAt, levels]);
        if (key === this._frostKey)
            return;
        this._frostKey = key;
        glass?.setFineArea(place &&
            {x: place.x, y: place.y, width: place.width, height: place.height});
        if (!place) {
            this.frost.hide();
            return;
        }
        // The windows as they are: no tint, and the darkening is in them
        // already. The sharpest picture lies lowest.
        if (this._levels !== levels.join()) {
            this._levels = levels.join();
            this.frost.destroy_all_children();
            this._layers = levels.map(level => {
                const layer = glass.createLayer([[0, 0, 0], 0, 1], level);
                this.frost.add_child(layer);
                return layer;
            });
        }
        // Each picture comes in over one share of the width between where
        // the work area starts and rampAt, over the one before it, so the
        // blur doubles from one share to the next.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.max(1, place.width - EDGE * scale);
        const span = width * (1 - rampAt) / this._layers.length;
        this._layers.forEach((layer, i) => {
            const from = width - span * i;
            layer.set_size(Math.ceil(from), place.height);
            layer.setFade(from, from - span);
        });
        this.frost.set_position(place.x, place.y);
        this.frost.set_size(width, place.height);
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
