// SPDX-License-Identifier: GPL-3.0-or-later

// One corner radius for every window.
//
// Clients round their own corners, each with its own radius: 15 px in
// libadwaita, 8 px and square bottom corners in GTK 3, something else in each
// Electron app. The focus ring has one radius, so it only fitted the windows
// that happened to share it.
//
// Here every window is cut to the rounded rectangle of its frame, with the
// radius the focus ring is drawn with. Whatever the client drew outside that
// shape is not drawn, and that includes the shadow a client draws around its
// own frame.
//
// A window with a rule in windows.crop (see crop.js) is cut further in, to
// leave out the frame its client draws inside the window.
//
// Every window that is cut gets a one pixel outline along the edge of the
// shape (windows.outline). Without it a window with dark content and no
// border of its own, a browser on a black page, has no visible edge on a
// dark wallpaper. A cropped window has one in any case: the client's own
// border went with its frame.
//
// The same shader darkens the part of a window that is under the sidebar
// (theme.shade, see setShade below).
//
// The cut is a fragment shader on an offscreen effect. The effect sits on the
// window's surface actor and not on the window actor, so that anything else
// in the window actor is left alone: the shadow Mutter draws for an X11
// window with a server-side frame, and the strip clip from tiling.js.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {cropOf, drawnFrame, isCropped} from './crop.js';

const EFFECT = 'kelp-corners';
// The outline, as a premultiplied colour: white at 16%, mixed into whatever
// the window shows at its edge.
const OUTLINE = [0.16, 0.16, 0.16, 0.16];
// The outline of a window with a drawn title bar (lib/titlebar.js) is one
// opaque colour instead, and the bar's border has the same one: 16% white
// over the bar's #2e2e32. Mixed into the content, the line was 51 on
// Spotify's black and 73 on the bar, and there was a third line where the
// two met, so the window looked as if only its title bar had a border.
const BAR_LINE_RGB = [79, 79, 83];
export const BAR_LINE_CSS = `rgb(${BAR_LINE_RGB.join(', ')})`;
const BAR_LINE = [...BAR_LINE_RGB.map(v => v / 255), 1];

// Distance to a rounded rectangle, negative inside. kelp_bounds is the shape
// in pixels of the offscreen texture (x1, y1, x2, y2) and kelp_size is the
// size of that texture. kelp_line is the outline's colour, premultiplied,
// and kelp_width its width in pixels. A transparent colour draws none.
export const SHAPE_DECLARATIONS = `
uniform vec4 kelp_bounds;
uniform vec2 kelp_size;
uniform vec2 kelp_radius;
uniform vec4 kelp_line;
uniform float kelp_width;

// kelp_radius is the radius of the top corners, then of the bottom ones.
float kelp_distance(vec2 p) {
    vec2 centre = (kelp_bounds.xy + kelp_bounds.zw) * 0.5;
    float r = p.y < centre.y ? kelp_radius.x : kelp_radius.y;
    vec2 inner = (kelp_bounds.zw - kelp_bounds.xy) * 0.5 - vec2(r);
    vec2 q = abs(p - centre) - inner;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;
// The distance is turned into coverage over one pixel. The colour is
// premultiplied, so every channel is scaled. The outline is the band of
// kelp_width pixels inside the edge, where kelp_line is drawn over the window.
export const SHAPE_CODE = `{
    float kelp_d = kelp_distance(cogl_tex_coord_in[0].xy * kelp_size);
    float kelp_cover = clamp(0.5 - kelp_d, 0.0, 1.0);
    float kelp_band = kelp_cover * clamp(0.5 + kelp_d + kelp_width, 0.0, 1.0);
    cogl_color_out = cogl_color_out * kelp_cover * (1.0 - kelp_band * kelp_line.a) + kelp_line * kelp_band;
}`;

// The shade: a window is mixed towards a colour where it lies under the
// sidebar, fully from the edge of the monitor on, less and less from
// kelp_shade_ramp on, and not at all where the work area starts. kelp_shade
// is that range in pixels of the offscreen texture (x of the edge of the
// monitor, x of none, top, bottom), kelp_shade_ramp an x between the two,
// kelp_shade_color the colour and, in its fourth part, the strength. A
// strength of 0 draws none.
const SHADE_DECLARATIONS = `
uniform vec4 kelp_shade;
uniform float kelp_shade_ramp;
uniform vec4 kelp_shade_color;
`;
const SHADE_CODE = `{
    vec2 kelp_p = cogl_tex_coord_in[0].xy * kelp_size;
    float kelp_k = kelp_shade_color.a
        * (1.0 - smoothstep(kelp_shade_ramp, kelp_shade.y, kelp_p.x))
        * step(kelp_shade.x, kelp_p.x) * step(kelp_shade.z, kelp_p.y) * step(kelp_p.y, kelp_shade.w);
    cogl_color_out.rgb = mix(cogl_color_out.rgb, kelp_shade_color.rgb * cogl_color_out.a, kelp_k);
}`;

// {x0, ramp, x1, y0, y1, color: [r, g, b], strength} in stage pixels, or null.
let shade = null;

/**
 * Where windows are darkened: fully from stage x0 to ramp, not at x1 and
 * past it, between stage y0 and y1. null for nowhere. Corners.syncAll()
 * draws the windows again.
 */
export function setShade(value) {
    shade = value;
}

/**
 * Where the actor of an offscreen effect lies in the effect's texture:
 * {left, top, scale, texWidth, texHeight}, or null before the first paint.
 * A point (x, y) of the actor is at ((x - left) * scale, (y - top) * scale)
 * in the texture.
 *
 * The arithmetic is that of clutter_offscreen_effect_pre_paint() and
 * _clutter_actor_box_enlarge_for_effects() in Mutter 51: the buffer covers
 * the actor's paint volume plus 3 px, and one unit of the actor is `scale`
 * pixels of the buffer.
 */
export function bufferGeometry(effect) {
    const actor = effect.get_actor();
    const texture = effect.get_texture();
    if (!actor || !texture)
        return null;
    let x = 0, y = 0;
    let [width, height] = actor.get_size();
    const volume = actor.get_paint_volume();
    if (volume) {
        const origin = volume.get_origin();
        x = origin.x;
        y = origin.y;
        width = volume.get_width();
        height = volume.get_height();
    }
    const boxWidth = Math.round(width) + 3;
    const boxHeight = Math.round(height) + 3;
    const texWidth = texture.get_width();
    return {
        left: Math.ceil(Math.fround(x + width + 0.75)) - boxWidth,
        top: Math.ceil(Math.fround(y + height + 0.75)) - boxHeight,
        scale: Math.max(1, Math.round(texWidth / boxWidth)),
        texWidth,
        texHeight: texture.get_height(),
    };
}

export const HAVE_SNIPPETS = typeof Cogl.Snippet?.new === 'function' &&
    typeof Clutter.OffscreenEffect.prototype.get_pipeline === 'function' &&
    typeof Cogl.Pipeline.prototype.set_uniform_float === 'function';

// One snippet for every pipeline. Cogl compiles one program for all the
// pipelines that hold the same snippet object.
let snippet = null;

// Surface actors that a thumbnail is showing, each with the number of
// thumbnails. A thumbnail shows the window by itself, so a surface in this
// map is drawn without the shade in a clone.
//
// Clutter samples the offscreen buffer with the nearest texel, which is
// exact at full size. A Clutter.Clone that draws the surface at a third of
// its size then keeps one texel in nine, and text breaks up. So every clone
// is drawn with trilinear filtering, and Cogl makes the mipmaps for that
// whenever the buffer has been redrawn.
//
// Until 2026-11-22 only the thumbnails were. The pictures of lib/glass.js
// draw each window through a clone at an eighth of its size, which kept one
// texel in 64, and another one after each pixel the window moved: under the
// sidebar a pixel of blurred text changed by 1.7 to 3 levels of 255 for
// each pixel of travel, and one of 1 px stripes by 30 to 70.
const thumbnails = new Map();

// Minification and magnification filters for the offscreen buffer.
const NEAREST = [Cogl.PipelineFilter.NEAREST, Cogl.PipelineFilter.NEAREST];
const LINEAR = [Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR];
const TRILINEAR = [Cogl.PipelineFilter.LINEAR_MIPMAP_LINEAR, Cogl.PipelineFilter.LINEAR];

/**
 * A thumbnail of this surface actor is being shown (on) or has gone (off).
 * Calls are counted, so each on needs one off.
 */
export function setThumbnail(surface, on) {
    if (!surface)
        return;
    const count = (thumbnails.get(surface) ?? 0) + (on ? 1 : -1);
    if (count > 0)
        thumbnails.set(surface, count);
    else
        thumbnails.delete(surface);
}

export const CornerEffect = GObject.registerClass(
class KelpCornerEffect extends Clutter.OffscreenEffect {
    /** The shader. A subclass that draws more than the shape gives its own. */
    _snippet() {
        snippet ??= Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
            SHAPE_DECLARATIONS + SHADE_DECLARATIONS, SHADE_CODE + SHAPE_CODE);
        return snippet;
    }

    /** Whether this effect is on a window, which the shade applies to. */
    get _shaded() {
        return true;
    }

    /**
     * frame: the part of the window that is drawn, in the actor's own
     * coordinates, as [x1, y1, x2, y2]. radius and outlineWidth are in the
     * same units. line is the outline's premultiplied colour [r, g, b, a],
     * null for none. topRadius is for the top corners.
     */
    setShape(frame, radius, line = null, outlineWidth = 1, topRadius = radius) {
        const key = `${frame.join(',')},${radius},${line?.join('/')},${outlineWidth},${topRadius}`;
        if (key === this._shapeKey)
            return;
        this._shapeKey = key;
        this._frame = frame;
        this._radius = radius;
        this._topRadius = topRadius;
        this._line = line ?? [0, 0, 0, 0];
        this._outlineWidth = outlineWidth;
        this._uniformKey = null;
        this.queue_repaint();
    }

    vfunc_paint_target(node, paintContext) {
        // Clutter makes a new pipeline whenever the offscreen buffer is
        // resized.
        const pipeline = this.get_pipeline();
        if (pipeline && pipeline !== this._pipeline) {
            this._pipeline = pipeline;
            this._uniformKey = null;
            this._filters = NEAREST;
            pipeline.add_snippet(this._snippet());
        }
        // Clutter samples the buffer with the nearest texel, which is exact
        // at full size. A clone gets mipmaps (see thumbnails above). A
        // window actor that is scaled, by tiling.js for a window without
        // focus or by the shell while a window opens, gets linear filtering:
        // nearest would drop one row of pixels in fifty at a scale of 0.98.
        const actor = this.get_actor();
        const parent = actor?.get_parent();
        let filters = NEAREST;
        if (actor?.is_in_clone_paint())
            filters = TRILINEAR;
        else if (parent && (parent.scale_x !== 1 || parent.scale_y !== 1))
            filters = LINEAR;
        if (pipeline && filters !== this._filters) {
            this._filters = filters;
            pipeline.set_layer_filters(0, filters[0], filters[1]);
        }
        if (pipeline && this._frame) {
            this._setUniforms(pipeline);
            if (this._shaded)
                this._setShade(pipeline);
        }
        super.vfunc_paint_target(node, paintContext);
    }

    /** Where the frame lies in the offscreen texture, see bufferGeometry(). */
    _setUniforms(pipeline) {
        const geometry = bufferGeometry(this);
        if (!geometry)
            return;
        this._geometry = geometry;
        const {left, top, scale, texWidth, texHeight} = geometry;

        const key = [left, top, texWidth, texHeight, scale].join(',');
        if (key === this._uniformKey)
            return;
        this._uniformKey = key;

        const f = this._frame;
        const limit = r => Math.max(0, Math.min(r, (f[2] - f[0]) / 2, (f[3] - f[1]) / 2));
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_bounds'), 4, 1, [
            (f[0] - left) * scale, (f[1] - top) * scale,
            (f[2] - left) * scale, (f[3] - top) * scale,
        ]);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_size'), 2, 1,
            [texWidth, texHeight]);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_radius'), 2, 1,
            [limit(this._topRadius) * scale, limit(this._radius) * scale]);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_line'), 4, 1, this._line);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_width'), 1, 1,
            [this._outlineWidth * scale]);
        this._shadeKey = null;
    }

    /**
     * The shade for this paint, from where the window is on the stage now.
     * It is worked out at every paint: a window that scrolls is painted
     * each frame, and its texture is not.
     */
    _setShade(pipeline) {
        const actor = this.get_actor();
        const g = this._geometry;
        let range = [0, 1, 0, 0];
        let ramp = 0;
        let color = [0, 0, 0, 0];
        // Not in a thumbnail, which shows the window by itself.
        if (shade && g && !(thumbnails.has(actor) && actor.is_in_clone_paint())) {
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            const kx = aw > 0 ? actor.width / aw : 1;
            const ky = ah > 0 ? actor.height / ah : 1;
            const tx = x => ((x - ax) * kx - g.left) * g.scale;
            const ty = y => ((y - ay) * ky - g.top) * g.scale;
            const none = tx(shade.x1);
            // Only a window that reaches under the sidebar.
            if (none > 0 && Number.isFinite(none)) {
                range = [tx(shade.x0), none, ty(shade.y0), ty(shade.y1)];
                ramp = tx(shade.ramp);
                color = [...shade.color, shade.strength];
            }
        }
        const key = `${range.join(',')},${ramp},${color.join(',')}`;
        if (key === this._shadeKey)
            return;
        this._shadeKey = key;
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_shade'), 4, 1, range);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_shade_ramp'), 1, 1, [ramp]);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_shade_color'), 4, 1, color);
    }
});

// The child of a window actor that draws the client's surfaces. In Mutter 51
// that is a MetaSurfaceContainerActorWayland for a Wayland window.
export function surfaceOf(actor) {
    return actor.get_children().find(
        child => child.constructor.$gtype.name.startsWith('MetaSurface')) ?? null;
}

export class Corners {
    constructor(config) {
        this._config = config;
    }

    enable() {
        this._surfaces = new Map();   // window -> surface actor that has the effect
        this._actors = new WeakSet(); // window actors whose children are watched
        global.display.connectObject(
            'window-created', (_d, win) => this._watch(win), this);
        for (const win of global.display.list_all_windows())
            this._watch(win);
    }

    disable() {
        global.display.disconnectObject(this);
        for (const win of global.display.list_all_windows()) {
            win.disconnectObject(this);
            win.get_compositor_private()?.disconnectObject(this);
        }
        for (const win of [...this._surfaces.keys()])
            this._clear(win);
        this._surfaces = null;
        this._actors = null;
    }

    /** Whether the window is cut to its frame, so nothing it draws past that shows. */
    cuts(win) {
        return this._surfaces?.has(win) ?? false;
    }

    /** The frame the window is drawn with has changed, see drawnFrame() in crop.js. */
    sync(win) {
        if (this._surfaces)
            this._sync(win);
    }

    /** After a change of configuration, or of the shade. */
    syncAll() {
        for (const win of global.display.list_all_windows())
            this._sync(win);
        for (const surface of this._surfaces?.values() ?? [])
            surface.get_effect(EFFECT)?.queue_repaint();
    }

    _watch(win) {
        win.connectObject(
            'shown', () => this._sync(win),
            'size-changed', () => this._sync(win),
            'notify::fullscreen', () => this._sync(win),
            'notify::maximized-horizontally', () => this._sync(win),
            'notify::maximized-vertically', () => this._sync(win),
            'notify::window-type', () => this._sync(win),
            'notify::wm-class', () => this._sync(win),
            'unmanaging', () => this._unwatch(win),
            this);
        this._sync(win);
    }

    _unwatch(win) {
        // The effect stays on a closing window, so its corners do not turn
        // square for the length of the close animation. It goes with the
        // actor.
        this._surfaces.delete(win);
        win.disconnectObject(this);
        win.get_compositor_private()?.disconnectObject(this);
    }

    _wanted(win, crop) {
        if (!HAVE_SNIPPETS)
            return false;
        const w = this._config.values.windows;
        if (!w.clipCorners && !w.outline && !isCropped(crop))
            return false;
        if (win.is_fullscreen() || win.is_override_redirect())
            return false;
        const type = win.get_window_type();
        return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG ||
            type === Meta.WindowType.MODAL_DIALOG || type === Meta.WindowType.UTILITY;
    }

    _sync(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        // An X11 window gets its surface, or a new one, after it is created.
        if (!this._actors.has(actor)) {
            this._actors.add(actor);
            actor.connectObject(
                'child-added', () => this._sync(win),
                'destroy', () => this._surfaces?.delete(win),
                this);
        }
        const crop = cropOf(this._config, win);
        const surface = this._wanted(win, crop) ? surfaceOf(actor) : null;
        const had = this._surfaces.get(win) ?? null;
        if (had && had !== surface)
            this._clear(win);
        if (!surface)
            return;

        let effect = surface.get_effect(EFFECT);
        if (!effect) {
            effect = new CornerEffect();
            surface.add_effect_with_name(EFFECT, effect);
            this._surfaces.set(win, surface);
        }
        const frame = drawnFrame(win);
        const buffer = win.get_buffer_rect();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const x = frame.x - buffer.x;
        const y = frame.y - buffer.y;
        const radius = this._config.values.windows.clipCorners
            ? this._config.values.focusRing.radius * scale : 0;
        // Under a drawn title bar the shape starts at the top of the bar,
        // with the bar's corners. The bar covers that part, so what is left
        // to see is the outline down the sides and along the bottom, with
        // no line across the window where the bar ends.
        const bar = crop.bar > 0;
        const outlined = this._config.values.windows.outline || isCropped(crop);
        let line = null;
        if (bar)
            line = BAR_LINE;
        else if (outlined)
            line = OUTLINE;
        effect.setShape(
            [x + crop.left, y + crop.top - (bar ? crop.bar : 0),
                x + frame.width - crop.right, y + frame.height - crop.bottom],
            radius, line, scale);
    }

    _clear(win) {
        const surface = this._surfaces.get(win);
        this._surfaces.delete(win);
        if (surface?.get_effect(EFFECT))
            surface.remove_effect_by_name(EFFECT);
    }
}
