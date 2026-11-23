// Cards that blur the windows under them (theme.liveBlur).
//
// The material of lib/backdrop.js is a picture of the wallpaper. Over a
// window a card then shows wallpaper where the window is, and looks like a
// hole in the window. Here a card shows the windows under it, blurred and
// mixed towards the tint, over that material. Where no window is under a
// card, the card is the material and nothing else.
//
// One picture per monitor: the windows of that monitor, without the
// wallpaper, drawn at an eighth of their size and blurred there, across and
// then down, by a shader of 25 samples on each of two nested actors. The
// picture is see-through where there is no window. It is drawn again
// whenever a window is. The actor that holds it is hidden, and is only ever
// drawn through the clones in the cards.
//
// The width under the sidebar has three more pictures (setFineArea), at a
// quarter, a half and the whole of the size of the windows, each blurred
// half as wide as the one before. lib/edgefade.js draws all four there, so
// the blur lessens in steps towards the work area.
//
// The windows are in the picture as one Clutter.Clone each. A clone draws
// its window but not where the window is, so each clone is given the place,
// scale and opacity of its window. One clone of the whole window group
// would need none of that, but the wallpaper is in that group.
//
// A window is in a picture only while its frame lies under a layer that
// shows that picture. A clone is drawn again whenever its window is, and
// the picture and every layer that shows it with it: 180 ms of processor
// time and 177 ms of graphics time in each second in which a window drew a
// frame, at 60 frames (measured 2026-11-22), although the window was not
// under the sidebar. So the first column, which starts where the sidebar's
// room ends, is in no picture, and its light no longer spreads into the
// cards next to it.
//
// Each card has a layer under its content with a clone of that picture,
// scaled back up and placed so that it lines up with the screen. The layer's
// shader tints it and cuts it to the card's rounded rectangle.
//
// The layers and the clones are placed again before the next frame after
// something they depend on has changed: a layer or an actor above it was
// laid out, moved or scaled (the sidebar slides over a fullscreen window by
// its translation), or a window was. Until 2026-11-22 all of it was read
// before every frame, which took 12 ms in each second at 60 frames with
// nothing moving. While the shell slides the workspaces it is still every
// frame: the copies it slides are moved by actors that are not watched.
//
// History, all of 2026-11-21:
//
//   - The picture was the window group with the wallpaper, blurred 32 px
//     wide, and took the tint strength of the material. With
//     theme.tintStrength at 1, which gives flat cards, the cards showed no
//     blur at all. The blur now has its own strength (theme.liveBlurTint).
//   - The shell's own blur effect took 0.9 ms of every frame in which a
//     window moved, on a picture of 240 x 135 pixels.
//   - theme.opacity applied to the blurred picture too. At 0.9 the text of
//     a white window showed through a card at a tenth of its strength,
//     under the card's own text. The picture is now opaque where a window
//     is.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    CornerEffect, HAVE_SNIPPETS, SHAPE_CODE, SHAPE_DECLARATIONS, bufferGeometry,
} from './corners.js';

// The picture is 1/8 of the monitor at a display scale of 1, and the same
// number of pixels at any other scale.
const DIVISOR = 8;
// The sigma of the blur, as a share of the monitor's width: 24 px on a
// 1920 px monitor. The Gaussian has a sigma of SIGMA_SAMPLES samples, so the
// samples are 6 px apart there, three quarters of a pixel of the picture.
//
// Until 2026-11-21 the picture was 1/4 of the monitor and the blur 12 px,
// which left the lines of a text as separate bands. Samples one and a half
// pixels apart on that picture, for the same 24 px, drew stripes as far
// apart as the picture's rows.
const SIGMA = 1 / 80;
const SIGMA_SAMPLES = 4;
// The sharper pictures (Glass.setFineArea): each has this many times the
// pixels across of the monitor's picture and a blur that is as many times
// narrower, so 12, 6 and 3 px on a 1920 px monitor. Their samples are three
// quarters of a pixel apart too.
const FINE = [2, 4, 8];
// The picture is this many of its pixels larger than the monitor on every
// side. A layer draws the picture enlarged, and at the picture's edge the
// enlarging mixes the outermost pixel with nothing, so without the margin
// the windows showed sharp through the first 4 px at the edge of the monitor
// (seen on 2026-11-21 as marks of text beside the sidebar's cards). The blur
// does not read the margin, so a window on the next monitor is not in it.
const PAD = 1;

export const HAVE_GLASS = HAVE_SNIPPETS;

// kelp_step: from one sample to the next, in texture coordinates.
// kelp_within: the first and the last texture coordinate of the picture
// along the blur. A sample past them takes the picture's edge, so the blur
// does not fade towards the edge of the monitor.
const BLUR_DECLARATIONS = `
uniform vec2 kelp_step;
uniform vec2 kelp_within;
`;
// 12 samples on either side reach 3 sigma: the weight is exp(-i * i / 32),
// a sigma of SIGMA_SAMPLES. The colours are premultiplied, and stay so.
const BLUR_CODE = `{
    vec4 kelp_sum = vec4(0.0);
    float kelp_total = 0.0;
    vec2 kelp_at = cogl_tex_coord_in[0].st;
    vec2 kelp_axis = kelp_step.x > 0.0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    float kelp_from = dot(kelp_at, kelp_axis);
    float kelp_pace = kelp_step.x + kelp_step.y;
    for (int kelp_i = -12; kelp_i <= 12; kelp_i++) {
        float kelp_w = exp(-0.03125 * float(kelp_i * kelp_i));
        float kelp_to = clamp(kelp_from + kelp_pace * float(kelp_i), kelp_within.x, kelp_within.y);
        kelp_sum += texture2D(cogl_sampler0, kelp_at + kelp_axis * (kelp_to - kelp_from)) * kelp_w;
        kelp_total += kelp_w;
    }
    cogl_color_out = kelp_sum / kelp_total * cogl_color_in.a;
}`;

let blurSnippet = null;

/** One direction of the blur, on what its actor draws. */
const BlurPass = GObject.registerClass(
class KelpBlurPass extends Clutter.OffscreenEffect {
    setVertical(vertical) {
        this._vertical = vertical;
    }

    /** step: from one sample to the next, in units of the actor. */
    setStep(step) {
        this._step = step;
    }

    vfunc_paint_target(node, paintContext) {
        const pipeline = this.get_pipeline();
        const geometry = pipeline ? bufferGeometry(this) : null;
        if (geometry) {
            // Clutter makes a new pipeline whenever the offscreen buffer is
            // resized.
            if (pipeline !== this._pipeline) {
                this._pipeline = pipeline;
                this._key = '';
                blurSnippet ??= Cogl.Snippet.new(
                    Cogl.SnippetHook.FRAGMENT, BLUR_DECLARATIONS, BLUR_CODE);
                pipeline.add_snippet(blurSnippet);
            }
            // The cards draw the picture many times its size. Clutter sets
            // the filter back to the nearest texel between paints.
            pipeline.set_layer_filters(0,
                Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            const {left, top, scale, texWidth, texHeight} = geometry;
            const [width, height] = this.get_actor().get_size();
            const key = [left, top, scale, texWidth, texHeight, width, height].join(',');
            if (key !== this._key) {
                this._key = key;
                // In pixels of the buffer, the same in both directions.
                const step = this._step * scale;
                // The middles of the first and the last pixel of the monitor.
                const within = this._vertical
                    ? [((PAD - top) * scale + 0.5) / texHeight, ((height - PAD - top) * scale - 0.5) / texHeight]
                    : [((PAD - left) * scale + 0.5) / texWidth, ((width - PAD - left) * scale - 0.5) / texWidth];
                pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_step'), 2, 1,
                    this._vertical ? [0, step / texHeight] : [step / texWidth, 0]);
                pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_within'), 2, 1,
                    within);
            }
        }
        super.vfunc_paint_target(node, paintContext);
    }
});

// kelp_tint: the tint. kelp_look: its strength, the saturation. kelp_fade:
// the x, in pixels of the offscreen texture, from which nothing of the layer
// is drawn, and the x up to which all of it is. Two equal numbers draw all
// of it everywhere.
const DECLARATIONS = `${SHAPE_DECLARATIONS}
uniform vec3 kelp_tint;
uniform vec2 kelp_look;
uniform vec2 kelp_fade;
`;
// The picture is premultiplied: its alpha is how much of a window is under
// the pixel, times the paint opacity of the card. The colour is taken out of
// that, tinted, and put back, so the card's material shows where no window
// is.
//
// The saturation has the weights of gdk_pixbuf_saturate_and_pixelate(),
// which the wallpaper picture is made with.
const CODE = `{
    float kelp_a = cogl_color_out.a;
    vec3 kelp_c = kelp_a > 0.0 ? cogl_color_out.rgb / kelp_a : vec3(0.0);
    float kelp_grey = dot(kelp_c, vec3(0.30, 0.59, 0.11));
    kelp_c = clamp(vec3(kelp_grey) + (kelp_c - vec3(kelp_grey)) * kelp_look.y, 0.0, 1.0);
    kelp_c = mix(kelp_c, kelp_tint, kelp_look.x);
    cogl_color_out = vec4(kelp_c * kelp_a, kelp_a);
    if (kelp_fade.x != kelp_fade.y)
        cogl_color_out *= clamp((cogl_tex_coord_in[0].x * kelp_size.x - kelp_fade.x) / (kelp_fade.y - kelp_fade.x), 0.0, 1.0);
}
${SHAPE_CODE}`;

let snippet = null;

const GlassEffect = GObject.registerClass(
class KelpGlassEffect extends CornerEffect {
    _snippet() {
        snippet ??= Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
        return snippet;
    }

    // A card is not a window.
    get _shaded() {
        return false;
    }

    /** tint: [r, g, b] from 0 to 1. */
    setLook(tint, strength, saturation) {
        this._look = {tint, values: [strength, saturation]};
        this._lookPipeline = null;
        this.queue_repaint();
    }

    /**
     * Draw less and less of the layer from x = to, and nothing from x =
     * from on, in the actor's own units. from is the larger. null: all of
     * it everywhere.
     */
    setFade(fade) {
        this._fade = fade;
        this._fadeKey = null;
        this.queue_repaint();
    }

    vfunc_paint_target(node, paintContext) {
        // Clutter makes a new pipeline whenever the offscreen buffer is
        // resized, and it has no uniforms yet. Cogl finds a uniform by its
        // name, so they can be set before the parent class adds the shader.
        const pipeline = this.get_pipeline();
        if (pipeline && this._look && pipeline !== this._lookPipeline)
            this._setLook(pipeline);
        super.vfunc_paint_target(node, paintContext);
    }

    _setUniforms(pipeline) {
        super._setUniforms(pipeline);
        const g = this._geometry;
        if (!g)
            return;
        const fade = (this._fade ?? [0, 0]).map(x => (x - g.left) * g.scale);
        const key = fade.join(',');
        if (key === this._fadeKey && pipeline === this._fadePipeline)
            return;
        this._fadeKey = key;
        this._fadePipeline = pipeline;
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_fade'), 2, 1, fade);
    }

    _setLook(pipeline) {
        this._lookPipeline = pipeline;
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_tint'), 3, 1,
            this._look.tint);
        pipeline.set_uniform_float(pipeline.get_uniform_location('kelp_look'), 2, 1,
            this._look.values);
    }
});

/**
 * The picture as a layer shows it. A clone has the paint volume of its
 * source, here the whole picture at the size of the monitor, and a redraw is
 * asked for with that volume, whatever clips the actors above it. Every
 * time a picture changed, the whole primary monitor was drawn again, and
 * 8 px of the next one (measured 2026-11-22). The volume is the part inside
 * the layer.
 */
const PictureView = GObject.registerClass(
class KelpPictureView extends Clutter.Clone {
    vfunc_get_paint_volume(volume) {
        const parent = this.get_parent();
        const k = this.scale_x;
        if (!parent || !(k > 0))
            return false;
        const [width, height] = parent.get_size();
        volume.set_origin(new Graphene.Point3D({x: -this.x / k, y: -this.y / k, z: 0}));
        volume.set_width(width / k);
        volume.set_height(height / k);
        return true;
    }
});

/** Whether two rectangles {x1, y1, x2, y2} share more than half a pixel each way. */
function overlap(a, b) {
    return a.x1 < b.x2 - 0.5 && a.x2 > b.x1 + 0.5 && a.y1 < b.y2 - 0.5 && a.y2 > b.y1 + 0.5;
}

/**
 * Where the frame of a window is drawn on the stage, {x1, y1, x2, y2}, from
 * its actor. The actor is larger than the frame by the shadow the client
 * draws, which lib/corners.js cuts off. null for an actor that is no window.
 */
function drawnFrame(actor) {
    const win = actor.meta_window;
    if (!win)
        return null;
    const frame = win.get_frame_rect();
    const buffer = win.get_buffer_rect();
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(buffer.width > 0) || !(buffer.height > 0))
        return null;
    const kx = width / buffer.width;
    const ky = height / buffer.height;
    const x1 = x + (frame.x - buffer.x) * kx;
    const y1 = y + (frame.y - buffer.y) * ky;
    return {x1, y1, x2: x1 + frame.width * kx, y2: y1 + frame.height * ky};
}

/**
 * Clones of actors that are drawn where their sources are on the stage. The
 * actor of this object has the coordinates of the stage.
 */
class Mirrors {
    /**
     * nested: the sources are not children of an actor that has the
     * coordinates of the stage, so the transforms of their parents count
     * too. The window actors are such children: their parent is the window
     * group, which is not moved or scaled.
     */
    constructor(nested = false) {
        this._nested = nested;
        this.actor = new Clutter.Actor({reactive: false});
        this._clones = [];   // {source, clone, matrix, opacity, size}
    }

    /** sources: the actors to show, the lowest first. */
    set(sources) {
        const have = new Map(this._clones.map(c => [c.source, c]));
        this._clones = sources.map(source => {
            const kept = have.get(source);
            if (kept) {
                have.delete(source);
                return kept;
            }
            const clone = new Clutter.Clone({source, reactive: false, visible: false});
            this.actor.add_child(clone);
            return {source, clone, matrix: null, opacity: -1, size: ''};
        });
        for (const gone of have.values())
            gone.clone.destroy();
        this._clones.forEach(({clone}, i) => this.actor.set_child_at_index(clone, i));
    }

    /**
     * Put every clone where its source is now. under: the places on the
     * stage where the picture is shown, [{x1, y1, x2, y2}], and frameOf
     * gives the frame of a window's actor there. A window whose frame is
     * under none of them is left out. Without the two, every source is in.
     */
    sync(under = null, frameOf = null) {
        for (const c of this._clones) {
            const {source, clone} = c;
            // This runs before the stage lays its actors out for the
            // frame. A window whose client has just drawn a new size has
            // its new place, and the scale and translation the tile gave
            // it for that, but still the box of the old one. Reading the
            // box makes the stage lay out now if this actor waits for it.
            //
            // Until 2026-11-23 the clone was placed from the old box and
            // the new scale. A window that left the full width
            // (maximize-column, or cycle-width from 2/3) was drawn across
            // the whole width under the sidebar for one frame (the user:
            // "there's a frame where there's like a visual artifact on
            // the sidebar").
            source.get_allocation_box();
            let shown = source.visible;
            if (shown && under && frameOf) {
                const frame = frameOf(source);
                shown = !frame || under.some(place => overlap(frame, place));
            }
            if (!shown) {
                if (clone.visible)
                    clone.hide();
                continue;
            }
            if (!clone.visible)
                clone.show();
            // A clone draws its source into its own size.
            const [width, height] = source.get_size();
            const size = `${width}x${height}`;
            if (size !== c.size) {
                c.size = size;
                clone.set_size(width, height);
            }
            // From the source's own coordinates to those of the stage: its
            // place, scale and translation, and those of its parents.
            let matrix = source.get_transform();
            if (this._nested) {
                const stage = source.get_stage();
                for (let p = source.get_parent(); p && p !== stage; p = p.get_parent()) {
                    const above = p.get_transform();
                    if (!above.is_identity())
                        matrix = matrix.multiply(above);
                }
            }
            if (!c.matrix || !matrix.equal(c.matrix)) {
                c.matrix = matrix;
                clone.set_transform(matrix);
            }
            const opacity = source.opacity;
            if (opacity !== c.opacity) {
                c.opacity = opacity;
                clone.opacity = opacity;
            }
        }
    }
}

/** The blurred picture of the windows in one part of a monitor. */
class Picture {
    /**
     * area: the part of the stage it shows, {x, y, width, height}, inside
     * one monitor. scale: the display scale of that monitor. divisor: the
     * picture is 1/divisor of the area at a display scale of 1. sigma: of
     * the blur, in stage pixels.
     */
    constructor(area, scale, divisor, sigma) {
        this.area = {x: area.x, y: area.y, width: area.width, height: area.height};
        // Stage units per unit of the picture.
        this.divisor = divisor * Math.max(1, scale);
        this.pad = PAD;
        this.width = Math.ceil(area.width / this.divisor) + 2 * PAD;
        this.height = Math.ceil(area.height / this.divisor) + 2 * PAD;
        const size = {width: this.width, height: this.height, reactive: false};
        // On its monitor, so that its buffers have that monitor's scale.
        this.actor = new Clutter.Actor({...size, x: area.x, y: area.y, visible: false});
        this._inner = new Clutter.Actor({...size, clip_to_allocation: true});
        for (const [actor, vertical] of [[this._inner, false], [this.actor, true]]) {
            const pass = new BlurPass();
            pass.setVertical(vertical);
            pass.setStep(sigma / SIGMA_SAMPLES / this.divisor);
            actor.add_effect(pass);
        }
        this.actor.add_child(this._inner);
        // The windows, and over them what the shell shows in their place
        // while the workspaces slide.
        this.windows = new Mirrors();
        this.sliding = new Mirrors(true);
        for (const mirrors of [this.windows, this.sliding]) {
            mirrors.actor.set_pivot_point(0, 0);
            mirrors.actor.set_scale(1 / this.divisor, 1 / this.divisor);
            mirrors.actor.set_position(
                PAD - this.area.x / this.divisor, PAD - this.area.y / this.divisor);
            this._inner.add_child(mirrors.actor);
        }
        this.sliding.actor.hide();
        // Where the layers that show this picture are on the stage.
        this.under = [];
        Main.uiGroup.add_child(this.actor);
    }

    /**
     * The shell slides the workspaces of this monitor. groups: the actors
     * that hold the copies of the windows it slides, null when it is over.
     */
    setSliding(groups) {
        this.sliding.set(groups ?? []);
        this.sliding.actor.visible = groups !== null;
        this.windows.actor.visible = groups === null;
    }

    /** frameOf: see Mirrors.sync(). */
    sync(frameOf) {
        if (this.windows.actor.visible)
            this.windows.sync(this.under, frameOf);
        if (this.sliding.actor.visible)
            this.sliding.sync();
    }

    destroy() {
        this.actor.destroy();
        this.actor = null;
    }
}

/**
 * What a card draws under its content. It belongs to a ShadowBin, which
 * gives it the card's box.
 */
export const GlassLayer = GObject.registerClass(
class KelpGlassLayer extends Clutter.Actor {
    _init() {
        super._init({reactive: false, clip_to_allocation: true, visible: false});
        this._effect = new GlassEffect();
        this.add_effect(this._effect);
        this._picture = null;
        this._view = null;
        this._radius = 0;
        this._at = '';
        // Which picture it shows: 0 for the one of its monitor, 1 and up
        // for the sharper ones of Glass.setFineArea(), the sharpest last.
        this.level = 0;
    }

    setLook(tint, strength, saturation) {
        this._effect.setLook(tint, strength, saturation);
    }

    /**
     * Draw nothing of the layer from x = from on, and all of it up to x =
     * to, which is the smaller, in the layer's own units.
     */
    setFade(from, to) {
        this._effect.setFade([from, to]);
    }

    /** radius: of the card's corners, in stage pixels. */
    setRadius(radius) {
        if (radius === this._radius)
            return;
        this._radius = radius;
        this._shape();
    }

    _shape() {
        const [width, height] = this.get_size();
        this._effect.setShape([0, 0, width, height], this._radius);
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        this._shape();
    }

    /** Show a picture (null for none) so that it lines up with the screen at stage (x, y). */
    place(picture, x, y) {
        if (picture !== this._picture) {
            this._view?.destroy();
            this._view = null;
            this._picture = picture;
            this._at = '';
            if (picture) {
                this._view = new PictureView({
                    source: picture.actor,
                    width: picture.width, height: picture.height, reactive: false,
                });
                this._view.set_pivot_point(0, 0);
                this._view.set_scale(picture.divisor, picture.divisor);
                this.add_child(this._view);
            }
        }
        if (!picture)
            return;
        const at = `${x},${y}`;
        if (at === this._at)
            return;
        this._at = at;
        const margin = picture.pad * picture.divisor;
        this._view.set_position(picture.area.x - margin - x, picture.area.y - margin - y);
    }
});

// What moves an actor on the stage without laying out the actors in it.
const MOVES = ['notify::allocation', 'notify::translation-x', 'notify::translation-y',
    'notify::scale-x', 'notify::scale-y'];
// The same for a window's actor, and what else its clone copies.
const WINDOW_MOVES = [...MOVES, 'notify::pivot-point', 'notify::visible', 'notify::opacity'];

export class Glass {
    constructor() {
        this._layers = new Set();
        this._pictures = [];
        this._fine = [];       // the pictures of _fineArea, the least sharp first
        this._fineArea = null;
        this._look = null;
        this._laterId = 0;
        this._followId = 0;
        this._wanted = false;
        this._stale = true;    // the list of windows has changed
        this._layersDirty = true;    // a layer may have moved on the stage
        this._windowsDirty = true;   // a window may have moved, or a layer has
        this._used = new Set();      // the pictures a mapped layer shows
        this._slides = 0;            // workspace slides of the shell that are running
        this._sliding = new Set();   // those slides: {monitor, groups}, see setSliding
        this._watched = new Map();   // actor -> ids of the handlers on it
        this._onLayerMoved = () => this.moved();
        this._onWindowMoved = () => {
            this._windowsDirty = true;
            this._schedule();
        };
    }

    /** Whether the cards show the pictures. The caller draws its own material if not. */
    get active() {
        return this._wanted && this._pictures.length > 0;
    }

    enable() {
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._rebuild(), this);
        const stale = () => {
            this._stale = true;
            this._schedule();
        };
        // A window was opened, closed or raised.
        global.display.connectObject('restacked', stale, this);
        global.window_manager.connectObject('map', stale, 'destroy', stale, this);
    }

    disable() {
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._slides = 0;
        this._sliding.clear();
        this.setActive(false);
        this._follow();
        for (const [actor, ids] of this._watched) {
            for (const id of ids)
                actor.disconnect(id);
        }
        this._watched.clear();
        this._layers.clear();
    }

    /**
     * A layer for a card. It shows nothing until the glass is active.
     * look: [tint as [r, g, b], strength, saturation] for a layer that
     * keeps a look of its own, whatever setLook() gives the cards. level:
     * 0 for the picture of the layer's monitor, 1 to FINE.length for a
     * sharper one of the area given to setFineArea().
     */
    createLayer(look = null, level = 0) {
        const layer = new GlassLayer();
        layer.level = level;
        layer.ownLook = look !== null;
        this._layers.add(layer);
        layer.connect('destroy', () => this._layers.delete(layer));
        layer.connect('notify::allocation', this._onLayerMoved);
        layer.connect('notify::mapped', () => {
            if (layer.mapped)
                this._watchAbove(layer);
            this.moved();
        });
        if (look ?? this._look)
            layer.setLook(...look ?? this._look);
        layer.visible = this.active;
        return layer;
    }

    /** tint: 0xrrggbb. */
    setLook(tint, strength, saturation) {
        this._look = [
            [(tint >> 16) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255],
            strength, saturation,
        ];
        for (const layer of this._layers) {
            if (!layer.ownLook)
                layer.setLook(...this._look);
        }
    }

    setActive(active) {
        active = active && HAVE_GLASS;
        if (active === this._wanted)
            return;
        this._wanted = active;
        this._rebuild();
    }

    /**
     * Keep sharper pictures of one part of a monitor, for the layers with
     * a level over 0. area: {x, y, width, height} on the stage, null for
     * none. A picture of the whole monitor at these sizes would cost 4, 16
     * and 64 times the blur of the monitor's own picture.
     */
    setFineArea(area) {
        const key = JSON.stringify(area);
        if (key === this._fineKey)
            return;
        this._fineKey = key;
        this._fineArea = area;
        this._buildFine();
        this._applySliding();
        this._layersDirty = true;
        this._place();
    }

    _buildFine() {
        for (const layer of this._layers) {
            if (layer.level > 0)
                layer.place(null);
        }
        for (const picture of this._fine)
            picture.destroy();
        this._fine = [];
        const area = this._fineArea;
        if (!this._wanted || !area)
            return;
        const cx = area.x + area.width / 2, cy = area.y + area.height / 2;
        const monitor = Main.layoutManager.monitors.find(m =>
            cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height);
        if (!monitor)
            return;
        const scale = global.display.get_monitor_scale(monitor.index);
        const sigma = monitor.width * SIGMA;
        try {
            this._fine = FINE.map(times => {
                // As far past the area as the blur reads from there.
                const reach = Math.ceil(3 * sigma / times);
                const width = Math.min(area.width + reach, monitor.x + monitor.width - area.x);
                return new Picture({...area, width}, scale, DIVISOR / times, sigma / times);
            });
        } catch (e) {
            console.warn(`kelpshell: live blur: ${e.message}`);
            this._fine = [];
        }
        this._stale = true;
    }

    /**
     * A layer may have moved on the stage: a card has been laid out, or an
     * actor above a layer was moved. The layers are placed before the next
     * frame.
     */
    moved() {
        this._layersDirty = true;
        this._schedule();
    }

    _schedule() {
        if (!this.active || this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Call fn when one of the signals says that actor has moved. */
    _watch(actor, signals, fn) {
        if (this._watched.has(actor))
            return;
        const ids = signals.map(signal => actor.connect(signal, fn));
        ids.push(actor.connect('destroy', () => this._watched.delete(actor)));
        this._watched.set(actor, ids);
    }

    /** Every actor above a layer moves the layer when it moves. */
    _watchAbove(layer) {
        const stage = layer.get_stage();
        for (let a = layer.get_parent(); a && a !== stage; a = a.get_parent())
            this._watch(a, MOVES, this._onLayerMoved);
    }

    /**
     * The shell is sliding the workspaces of a monitor. group: the actor it
     * does that in, which ends the slide when it is destroyed. groups: the
     * actors in it that hold the copies of the windows.
     */
    setSliding(group, monitor, groups) {
        const slide = {monitor, groups};
        this._sliding.add(slide);
        this._applySliding();
        this._slides++;
        this._follow();
        group.connect('destroy', () => {
            this._sliding.delete(slide);
            this._applySliding();
            this._slides = Math.max(0, this._slides - 1);
            this._follow();
            this._onWindowMoved();
        });
    }

    /**
     * Show every picture the copies the shell slides on its monitor, or
     * its windows when no slide runs there. Also for pictures that are
     * made while a slide runs: the sharper ones (setFineArea) are made
     * when the monitor leaves fullscreen, which a switch away from a
     * workspace with a fullscreen window does at its start or its end.
     *
     * Until 2026-11-22 a picture made during a slide showed the windows.
     * The window actors of both workspaces are visible under the shell's
     * group until the slide is over, so the width under the sidebar showed
     * the fullscreen window, blurred and still, over the workspaces that
     * slid (the user: "when i switch workspaces while full screened
     * sometimes the sidebar has this weird grey background", "i think
     * it's the full screen image left over").
     */
    _applySliding() {
        for (const picture of [...this._pictures, ...this._fine]) {
            if (!picture.actor)
                continue;
            const {x, y} = picture.area;
            const slide = [...this._sliding].find(({monitor: m}) =>
                x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
            picture.setSliding(slide ? slide.groups : null);
        }
    }

    /** Before every frame while the shell slides the workspaces, and not otherwise. */
    _follow() {
        const on = this._slides > 0 && this.active;
        if (on && !this._followId) {
            this._followId = global.stage.connect('before-update', () => this._place());
        } else if (!on && this._followId) {
            global.stage.disconnect(this._followId);
            this._followId = 0;
        }
    }

    _rebuild() {
        for (const layer of this._layers)
            layer.place(null);
        for (const picture of this._pictures)
            picture.destroy();
        this._pictures = [];
        if (this._wanted) {
            try {
                this._pictures = Main.layoutManager.monitors.map(m => new Picture(
                    m, global.display.get_monitor_scale(m.index), DIVISOR, m.width * SIGMA));
            } catch (e) {
                console.warn(`kelpshell: live blur: ${e.message}`);
                this._pictures = [];
            }
        }
        this._buildFine();
        this._applySliding();
        this._stale = true;
        this._layersDirty = true;
        this._used = new Set();
        for (const layer of this._layers) {
            layer.visible = this.active;
            if (layer.mapped)
                this._watchAbove(layer);
        }
        this._follow();
        this._place();
    }

    _pictureAt(x, y) {
        return this._pictures.find(p => {
            const m = p.area;
            return x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height;
        }) ?? null;
    }

    /** Give every mapped layer its picture, lined up with the screen. */
    _placeLayers() {
        const used = new Set();
        for (const picture of [...this._pictures, ...this._fine])
            picture.under = [];
        for (const layer of this._layers) {
            if (!layer.mapped)
                continue;
            // The box the stage gives the layer in this frame: reading it
            // makes the stage lay out now if the layer waits for it, as
            // for a window in Mirrors.sync(). A layer that waits answers
            // get_size() with its natural size. Until 2026-11-23 a card
            // whose content changed with the windows (the minimap, when a
            // column changes its width) was taken to be 224 px wide for
            // one frame, not 164, so the first column counted as under it
            // and its light showed at the edge of the cards in that frame.
            const box = layer.get_allocation_box();
            const [x, y] = layer.get_transformed_position();
            if (!Number.isFinite(x) || !Number.isFinite(y))
                continue;
            const width = box.get_width();
            const height = box.get_height();
            const picture = layer.level > 0
                ? this._fine[layer.level - 1]
                : this._pictureAt(x + width / 2, y + height / 2) ?? this._pictures[0];
            layer.place(picture ?? null, Math.round(x), Math.round(y));
            if (picture) {
                used.add(picture);
                picture.under.push({x1: x, y1: y, x2: x + width, y2: y + height});
            }
        }
        this._used = used;
    }

    _place() {
        if (!this.active)
            return;
        if (this._layersDirty) {
            this._layersDirty = false;
            this._placeLayers();
            // Which windows are under a layer has changed with it.
            this._windowsDirty = true;
        }
        // Only the pictures a card shows follow their windows.
        if (this._used.size === 0)
            return;
        if (this._stale) {
            this._stale = false;
            // Every window is in every picture: each picture is cut to its
            // monitor, and a window can lie across two.
            const actors = global.get_window_actors();
            for (const picture of [...this._pictures, ...this._fine])
                picture.windows.set(actors);
            for (const actor of actors)
                this._watch(actor, WINDOW_MOVES, this._onWindowMoved);
            this._windowsDirty = true;
        }
        if (!this._windowsDirty && this._slides === 0)
            return;
        this._windowsDirty = false;
        // One reading of each window for all the pictures.
        const frames = new Map();
        const frameOf = actor => {
            let frame = frames.get(actor);
            if (frame === undefined) {
                frame = drawnFrame(actor);
                frames.set(actor, frame);
            }
            return frame;
        };
        for (const picture of this._used)
            picture.sync(frameOf);
    }
}
