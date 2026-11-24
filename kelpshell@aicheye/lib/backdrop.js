// SPDX-License-Identifier: GPL-3.0-or-later

// The surface material: the wallpaper, blurred and tinted, drawn inside each
// card at the card's own screen position. Cards then look like frosted glass
// over the wallpaper. The image has the opacity theme.opacity in every pixel,
// so a card also shows a little of what is behind it. The tint is theme.tint
// in the dark style and theme.tintLight in the light style.
//
// The wallpaper file named in GSettings is decoded with GdkPixbuf at a quarter
// of the monitor size. The blurred copy is a small PNG in the cache directory
// that St scales up. There is one per monitor size, and a card shows the one
// of the monitor it is on: the picture of the primary monitor does not reach
// a card on another monitor, which then had no fill at all. A wallpaper GdkPixbuf cannot read (an XML slideshow, for
// example) gives flat tinted cards.
//
// The PNG is named after what it is made from (the wallpaper file, its size
// and time, the monitor size and the theme values), so a login finds the one
// the last session made and decodes nothing. With theme.tintStrength at 1
// the picture would be the tint in every pixel, so none is made and the
// cards have that colour as their background. Until 2026-11-22 the wallpaper
// was decoded once per monitor size at every start: 60 ms each for a
// 6016 x 3900 PNG, also when nothing of it could show.
//
// With theme.liveBlur the cards of the sidebar show the windows under them,
// blurred, over this picture, see lib/glass.js. Everything else that has
// the material (the launcher, the popups) shows the picture alone.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Glass} from './glass.js';

const BASE_DIVISOR = 4;   // the stored image is 1/4 of the monitor size
const CACHE_KEEP = 6;     // pictures kept in the cache that are not shown now

/**
 * Stage position of an actor from allocations only. Scale and translation
 * are left out, so the result is where the actor rests, also while it is in
 * the middle of an open or close animation.
 */
function restingPosition(actor) {
    let x = 0, y = 0;
    for (let a = actor; a && a !== global.stage; a = a.get_parent()) {
        const box = a.get_allocation_box();
        x += box.x1;
        y += box.y1;
    }
    return [x, y];
}

// ---- soft shadow ----
// St cuts a box-shadow off at its blur radius, where it still has 12% of its
// opacity (measured: a 0.45 shadow ends in a step of 0.054). A shadow with a
// small blur hides that. Around a popup, with a blur of 44px, the step shows
// as the straight edges of a second, larger rectangle. The shadow of a
// wrapper that sets -kelp-shadow-blur in the stylesheet is drawn here
// instead: a rounded rectangle blurred until it reaches zero, kept as nine
// textures (four corners, four edges one pixel thick, the middle) that are
// laid out around the wrapper.

const shadowCache = new Map();   // spec as text -> {pad, slice, contents}

/** Blur a row-major Float32Array with a box of the given odd width, along x or y. */
function boxBlur(src, size, width, vertical) {
    const dst = new Float32Array(src.length);
    const half = (width - 1) / 2;
    const step = vertical ? size : 1;
    const line = vertical ? 1 : size;
    for (let l = 0; l < size; l++) {
        const start = l * line;
        let sum = 0;
        for (let i = 0; i <= half && i < size; i++)
            sum += src[start + i * step];
        for (let i = 0; i < size; i++) {
            dst[start + i * step] = sum / width;
            const add = i + half + 1;
            const drop = i - half;
            if (add < size)
                sum += src[start + add * step];
            if (drop >= 0)
                sum -= src[start + drop * step];
        }
    }
    return dst;
}

/**
 * The textures of one shadow. radius, blur and y are px, the corner radius
 * of the box, the blur radius and the distance the shadow is moved down, as
 * in a CSS box-shadow. The shadow is black at opacity alpha.
 *
 * pad: how far the shadow reaches past the box on every side.
 * slice: the side of a corner texture. Past it the shadow does not change
 * along the edge, so the edges and the middle can be stretched.
 */
function shadowTextures(radius, blur, y, alpha) {
    const key = [radius, blur, y, alpha].join(' ');
    let entry = shadowCache.get(key);
    if (entry)
        return entry;

    // Three box blurs of width w are close to a Gaussian with
    // sigma^2 = (w^2 - 1) / 4, and reach 3 (w - 1) / 2 pixels.
    const sigma = Math.max(0.5, blur / 2);
    let width = Math.max(1, Math.round(Math.sqrt(4 * sigma * sigma + 1)));
    if (width % 2 === 0)
        width++;
    const reach = 3 * (width - 1) / 2;
    const pad = reach + Math.abs(y);
    const slice = pad + radius + reach + Math.abs(y);
    const size = 2 * slice + 1;

    let mask = new Float32Array(size * size);
    const x1 = pad, x2 = size - pad, y1 = pad + y, y2 = size - pad + y;
    for (let py = Math.max(0, y1); py < Math.min(size, y2); py++) {
        for (let px = x1; px < x2; px++) {
            // Distance from the centre of the nearest corner circle.
            const dx = Math.max(x1 + radius - (px + 0.5), px + 0.5 - (x2 - radius), 0);
            const dy = Math.max(y1 + radius - (py + 0.5), py + 0.5 - (y2 - radius), 0);
            if (dx * dx + dy * dy <= radius * radius)
                mask[py * size + px] = 1;
        }
    }
    for (let i = 0; i < 3; i++)
        mask = boxBlur(boxBlur(mask, size, width, false), size, width, true);

    const context = global.stage.context.get_backend().get_cogl_context();
    const piece = (px, py, w, h) => {
        // Premultiplied black: only the alpha byte is not zero.
        const data = new Uint8Array(w * h * 4);
        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++)
                data[(j * w + i) * 4 + 3] = Math.round(255 * alpha * mask[(py + j) * size + px + i]);
        }
        const content = St.ImageContent.new_with_preferred_size(w, h);
        content.set_bytes(context, new GLib.Bytes(data),
            Cogl.PixelFormat.RGBA_8888_PRE, w, h, w * 4);
        return content;
    };
    const far = slice + 1;
    entry = {
        pad, slice,
        // Rows of three, top to bottom.
        contents: [
            piece(0, 0, slice, slice), piece(slice, 0, 1, slice), piece(far, 0, slice, slice),
            piece(0, slice, slice, 1), piece(slice, slice, 1, 1), piece(far, slice, slice, 1),
            piece(0, far, slice, slice), piece(slice, far, 1, slice), piece(far, far, slice, slice),
        ],
    };
    shadowCache.set(key, entry);
    return entry;
}

const SoftShadow = GObject.registerClass(
class KelpSoftShadow extends Clutter.Actor {
    _init() {
        super._init({reactive: false});
        this._pieces = [];
        for (let i = 0; i < 9; i++) {
            const piece = new Clutter.Actor({reactive: false});
            piece.set_content_scaling_filters(
                Clutter.ScalingFilter.LINEAR, Clutter.ScalingFilter.LINEAR);
            this._pieces.push(piece);
            this.add_child(piece);
        }
        this.pad = 0;
        this._slice = 0;
    }

    /** Lengths in stage pixels. `texel` is the size of one texture pixel in them. */
    setSpec(radius, blur, y, alpha, texel) {
        const t = shadowTextures(
            Math.round(radius / texel), Math.round(blur / texel), Math.round(y / texel), alpha);
        this.pad = t.pad * texel;
        this._slice = t.slice * texel;
        this._pieces.forEach((piece, i) => piece.set_content(t.contents[i]));
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = box.get_width();
        const h = box.get_height();
        // A box smaller than two corners: the corners are squeezed.
        const cx = Math.min(this._slice, Math.floor(w / 2));
        const cy = Math.min(this._slice, Math.floor(h / 2));
        const xs = [0, cx, w - cx, w];
        const ys = [0, cy, h - cy, h];
        this._pieces.forEach((piece, i) => {
            const col = i % 3;
            const row = Math.floor(i / 3);
            piece.allocate(new Clutter.ActorBox({
                x1: xs[col], y1: ys[row], x2: xs[col + 1], y2: ys[row + 1],
            }));
        });
    }
});

// A container for one child, which always gets the whole content box. St.Bin
// gives a child that does not expand its natural size, and an expanding
// child would make the wrapper expand inside the sidebar's box layout.
//
// A style class that sets -kelp-shadow-blur gives the bin a soft shadow (see
// above) from -kelp-shadow-y, -kelp-shadow-color and its border-radius. The
// shadow is a second child, drawn under the content and allocated past the
// bin's own box, so it takes no room in the layout. St.Bin cannot hold it:
// an actor added to an St.Bin becomes its one child.
//
// setMaterial() makes the bin draw the material itself, for a child that
// is large and restyled often (the shell's popups). St draws a background
// image with rounded corners in software, at the size of the whole box:
// about 10 ms for the calendar popup on a 3840 px wide display. The shell
// restyles a popup every time it opens and closes (it gets and loses the
// :focus and :last-child pseudo classes), and St draws that image again
// each time. Here the material is seven pieces under the child: three
// rectangles, which St draws as plain textured quads, and the four
// corners, which are the only parts drawn in software and are one corner
// radius in size. Each piece gets its own background position from the
// backdrop, so together they show one picture.
export const ShadowBin = GObject.registerClass(
class KelpShadowBin extends St.Widget {
    _init(props = {}) {
        const {child = null, ...rest} = props;
        super._init(rest);
        this._child = null;
        this._soft = null;
        this._pieces = null;
        this._backdrop = null;
        this._glass = null;        // the Glass that placed a layer here
        this._glassLayer = null;
        this.connect('style-changed', () => {
            this._syncSoftShadow();
            this._syncMaterial();
            this._syncGlass();
        });
        this.child = child;
    }

    /** Stop drawing the material under the child. */
    clearMaterial() {
        if (!this._pieces)
            return;
        for (const piece of this._pieces) {
            this._backdrop.detach(piece);
            piece.destroy();
        }
        this._pieces = null;
        this.queue_relayout();
    }

    /** Draw the material under the child, in pieces. The child has no background. */
    setMaterial(backdrop) {
        if (this._pieces)
            return;
        this._backdrop = backdrop;
        this._pieces = [];
        for (let i = 0; i < 7; i++) {
            // Clipped: St lets a background image that is not repeated run
            // past the box of a node with no border and no colour.
            const piece = new St.Widget({reactive: false, clip_to_allocation: true});
            this._pieces.push(piece);
            // Under the child, and under the layer of the glass if there
            // is one.
            const over = this._glassLayer ?? this._child;
            if (over)
                this.insert_child_below(piece, over);
            else
                this.add_child(piece);
        }
        this._syncMaterial();
    }

    /**
     * Draw a layer of lib/glass.js under the child, over the whole box and
     * cut to the bin's corner radius.
     */
    setGlass(glass, layer) {
        this._glass = glass;
        this._glassLayer = layer;
        if (this._child)
            this.insert_child_below(layer, this._child);
        else
            this.add_child(layer);
        layer.connect('destroy', () => (this._glassLayer = null));
        this._syncGlass();
    }

    _syncGlass() {
        // The theme node of an actor that is not on the stage is not final.
        if (this._glassLayer && this.get_stage())
            this._glassLayer.setRadius(this.get_theme_node().get_border_radius(St.Corner.TOPLEFT));
    }

    /**
     * The first four pieces are the corners, clockwise from the top left.
     * Each has the bin's radius on its one outer corner.
     */
    _syncMaterial() {
        if (!this._pieces)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = this.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        if (radius !== this._radius) {
            this._radius = radius;
            this.queue_relayout();
        }
        const r = radius / scale;
        const corners = [`${r}px 0 0 0`, `0 ${r}px 0 0`, `0 0 ${r}px 0`, `0 0 0 ${r}px`];
        this._pieces.forEach((piece, i) =>
            this._backdrop.attach(piece, i < 4 ? `border-radius: ${corners[i]}; ` : ''));
    }

    get child() {
        return this._child;
    }

    set child(actor) {
        this.set_child(actor);
    }

    /** The old child is taken out and not destroyed. */
    set_child(actor) {
        if (actor === this._child)
            return;
        if (this._child) {
            this._child.disconnectObject(this);
            this.remove_child(this._child);
        }
        this._child = actor ?? null;
        if (actor) {
            this.add_child(actor);
            actor.connectObject('destroy', () => (this._child = null), this);
        }
        this.queue_relayout();
    }

    get_child() {
        return this._child;
    }

    _syncSoftShadow() {
        const node = this.get_theme_node();
        const [found, blur] = node.lookup_length('-kelp-shadow-blur', false);
        if (!found || blur <= 0) {
            this._soft?.destroy();
            this._soft = null;
            return;
        }
        const [, y] = node.lookup_length('-kelp-shadow-y', false);
        const [hasColor, color] = node.lookup_color('-kelp-shadow-color', false);
        const alpha = hasColor ? color.alpha / 255 : 0.4;
        const radius = node.get_border_radius(St.Corner.TOPLEFT);
        const spec = [radius, blur, y, alpha].join(' ');
        if (spec === this._softSpec && this._soft)
            return;
        this._softSpec = spec;
        if (!this._soft) {
            this._soft = new SoftShadow();
            this.insert_child_below(this._soft, null);
        }
        // Lengths from the theme are in stage pixels. One texture pixel is
        // one CSS pixel: the shadow has no detail that needs more.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        try {
            this._soft.setSpec(radius, blur, y, alpha, scale);
        } catch (e) {
            console.warn(`kelpshell: soft shadow: ${e.message}`);
            this._soft.destroy();
            this._soft = null;
        }
    }

    vfunc_get_preferred_width(forHeight) {
        const node = this.get_theme_node();
        const [min, nat] = this._child?.visible
            ? this._child.get_preferred_width(node.adjust_for_height(forHeight)) : [0, 0];
        return node.adjust_preferred_width(min, nat);
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const [min, nat] = this._child?.visible
            ? this._child.get_preferred_height(node.adjust_for_width(forWidth)) : [0, 0];
        return node.adjust_preferred_height(min, nat);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        this._child?.allocate(this.get_theme_node().get_content_box(box));
        if (this._pieces) {
            const w = box.get_width();
            const h = box.get_height();
            const r = Math.min(this._radius ?? 0, Math.floor(w / 2), Math.floor(h / 2));
            const boxes = [
                [0, 0, r, r], [w - r, 0, w, r], [w - r, h - r, w, h], [0, h - r, r, h],
                [r, 0, w - r, r], [0, r, w, h - r], [r, h - r, w - r, h],
            ];
            this._pieces.forEach((piece, i) => {
                const [x1, y1, x2, y2] = boxes[i];
                piece.allocate(new Clutter.ActorBox({x1, y1, x2, y2}));
            });
        }
        if (this._glassLayer) {
            this._glassLayer.allocate(new Clutter.ActorBox({
                x1: 0, y1: 0, x2: box.get_width(), y2: box.get_height(),
            }));
            // The bin may have moved on the stage with its size unchanged.
            this._glass.moved();
        }
        if (this._soft) {
            const pad = this._soft.pad;
            this._soft.allocate(new Clutter.ActorBox({
                x1: -pad, y1: -pad,
                x2: box.get_width() + pad, y2: box.get_height() + pad,
            }));
        }
    }
});

function parseColor(hex, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    return m ? parseInt(m[1], 16) : fallback;
}

/**
 * True while the light style is on. lib/tweaks.js makes the shell follow the
 * "color-scheme" setting in both directions, and the shell then loads
 * stylesheet-light.css in place of stylesheet-dark.css.
 */
export function isLight() {
    return Main.getStyleVariant() === 'light';
}

/** The tint of the current style, as 0xrrggbb. */
export function themeTint(config) {
    const theme = config.values.theme;
    return isLight()
        ? parseColor(theme.tintLight, 0xf1f2f4)
        : parseColor(theme.tint, 0x16181d);
}

export class Backdrop {
    /**
     * live: false keeps the live blur off whatever theme.liveBlur says. The
     * lock screen has no windows to blur (lib/lockscreen.js).
     */
    constructor(config, {live = true} = {}) {
        this._config = config;
        this._liveAllowed = live;
        this._listeners = new Set();
        this._attached = new Map();   // actor -> {base, laterId}
        this._serial = 0;
        this._images = [];            // one per monitor: {x, y, width, height, path, url}
        this.glass = new Glass();
        this._live = new WeakSet();   // attached actors with a layer of the glass under them
        this._liveBins = new Set();   // the ShadowBins those actors are in
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kelpshell']);
    }

    enable() {
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._bgSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._bgSettings.connectObject('changed', () => this.refreshSoon(1500), this);
        // The stylesheet changes at once with the colour scheme, so the
        // material follows without the wait.
        this._ifaceSettings.connectObject('changed::color-scheme', () => this.refreshSoon(50), this);
        // The pictures that are in the cache go to the new places of the
        // monitors in the same frame, see _place(). The ones that have to
        // be made wait until the monitors have stopped changing.
        Main.layoutManager.connectObject(
            'monitors-changed', () => {
                this._place();
                this.refreshSoon(800);
            },
            this);
        if (this._liveAllowed)
            this.glass.enable();
        this._syncGlass();
        this.refreshSoon(50);
    }

    disable() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._serial++;
        this._bgSettings.disconnectObject(this);
        this._ifaceSettings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        for (const actor of [...this._attached.keys()])
            this.detach(actor);
        if (this._liveAllowed)
            this.glass.disable();
        this._listeners.clear();
        shadowCache.clear();
        // The pictures stay in the cache for the next start.
        this._images = [];
    }

    onChanged(fn) {
        this._listeners.add(fn);
    }

    refreshSoon(ms) {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._refreshId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Turn the live blur on or off and give it the look of the material. */
    _syncGlass() {
        const theme = this._config.values.theme;
        const number = (v, low, high, fallback) =>
            Number.isFinite(Number(v)) ? Math.max(low, Math.min(high, Number(v))) : fallback;
        this.glass.setLook(this._tint(),
            number(theme.liveBlurTint, 0, 1, 0.7),
            number(theme.saturation, 0, 4, 1));
        const was = this.glass.active;
        this.glass.setActive(this._liveAllowed && theme.liveBlur === true);
        if (this.glass.active !== was) {
            for (const bin of this._liveBins)
                this._syncLiveBin(bin);
            for (const actor of this._attached.keys())
                this._apply(actor);
        }
    }

    /**
     * With the glass, a card's surface has no background: the bin draws
     * the material, and the layer of the glass lies on it, under the
     * surface. Without it the surface draws the material itself.
     */
    _syncLiveBin(bin) {
        if (this.glass.active)
            bin.setMaterial(this);
        else
            bin.clearMaterial();
    }

    async refresh() {
        // One that was asked for with refreshSoon() would make the same
        // picture again: enable() asks for one, and the lock screen calls
        // this right after it.
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
        this._syncGlass();
        const serial = ++this._serial;
        const monitors = Main.layoutManager.monitors;
        if (monitors.length === 0)
            return;
        const plan = this._plan(monitors);
        const missing = [...new Set(plan.map(entry => entry.size))]
            .filter(size => size.cached && !size.path);
        // With every picture in the cache this is all of it. With one to
        // make, the others are shown now only when the monitors are not
        // where the pictures on the screen are: after a change of the
        // wallpaper the old pictures stay until the new ones are made.
        if (missing.length === 0 || this._moved(monitors))
            this._show(plan);
        if (missing.length === 0) {
            this._prune(new Set(this._images.map(i => i.path)));
            return;
        }
        for (const size of missing) {
            try {
                // One at a time: a newer refresh ends this one between two
                // pictures.
                // eslint-disable-next-line no-await-in-loop
                const pixbuf = await this._loadWallpaper(size.w, size.h);
                if (serial === this._serial)
                    size.path = this._render(pixbuf, size.w, size.h, size.cached);
            } catch (e) {
                console.warn(`kelpshell: backdrop: ${e.message}`);
            }
            // A newer refresh has started: it makes its own files.
            if (serial !== this._serial)
                return;
        }
        this._show(plan);
        this._prune(new Set(this._images.map(i => i.path)));
    }

    /**
     * What each monitor shows, from the cache alone: [{monitor, size}], one
     * size per "width x height" with {w, h, cached, path}. cached is the
     * file the picture is kept in, null for the flat tint. path is that
     * file when it is there, and null when it has to be made.
     */
    _plan(monitors) {
        const sizes = new Map();
        // The tint in every pixel: the cards take it as a colour.
        const flat = Number(this._config.values.theme.tintStrength) >= 1;
        return monitors.map(monitor => {
            const key = `${monitor.width}x${monitor.height}`;
            if (!sizes.has(key)) {
                const size = {
                    w: Math.max(16, Math.round(monitor.width / BASE_DIVISOR)),
                    h: Math.max(16, Math.round(monitor.height / BASE_DIVISOR)),
                    cached: null,
                    path: null,
                };
                try {
                    size.cached = flat ? null : this._cachePath(size.w, size.h);
                    if (size.cached && GLib.file_test(size.cached, GLib.FileTest.EXISTS))
                        size.path = size.cached;
                } catch (e) {
                    console.warn(`kelpshell: backdrop: ${e.message}`);
                }
                sizes.set(key, size);
            }
            return {monitor, size: sizes.get(key)};
        });
    }

    /** Put the pictures of a plan on the screen. */
    _show(plan) {
        this._images = plan.map(({monitor, size}) => ({
            x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
            path: size.path, url: size.path ? GLib.filename_to_uri(size.path, null) : null,
        }));
        for (const actor of this._attached.keys())
            this._apply(actor);
        for (const fn of this._listeners)
            fn();
    }

    /** True when the pictures on the screen are not at the places of these monitors. */
    _moved(monitors) {
        return monitors.length !== this._images.length || monitors.some((m, i) => {
            const image = this._images[i];
            return image.x !== m.x || image.y !== m.y ||
                image.width !== m.width || image.height !== m.height;
        });
    }

    /**
     * The monitors have changed: every picture that is in the cache goes to
     * the place its monitor has now, and a monitor whose picture has to be
     * made shows the flat tint until refresh() has made it.
     *
     * Until 2026-11-23 the pictures stayed where they were until refresh()
     * ran, 800 ms later. With the external monitor unplugged, the laptop
     * panel showed the top left 1440 x 960 of the external monitor's 2560
     * x 1440 picture for that time, 1.78 times too large, and then its own
     * (the user, of the lock screen: "the scaling was off for my laptop
     * and it like snapped into scale").
     */
    _place() {
        const monitors = Main.layoutManager.monitors;
        if (monitors.length === 0)
            return;
        // A refresh that is making pictures now would put them at the
        // places the monitors had when it started.
        this._serial++;
        this._show(this._plan(monitors));
    }

    /** Whether the picture of this monitor, at the place and of the size it has now, was made. */
    hasPictureOn(monitor) {
        return this._images.some(i => i.url && i.x === monitor.x && i.y === monitor.y &&
            i.width === monitor.width && i.height === monitor.height);
    }

    /**
     * The file a picture of w x h is kept in, named after everything it is
     * made from. Throws when there is no wallpaper file to read.
     */
    _cachePath(w, h) {
        const path = this._wallpaperPath();
        if (!path)
            throw new Error('no wallpaper image');
        const info = Gio.File.new_for_path(path).query_info(
            'time::modified,standard::size', Gio.FileQueryInfoFlags.NONE, null);
        const theme = this._config.values.theme;
        const key = [
            path, info.get_attribute_uint64('time::modified'), info.get_size(), w, h,
            this._bgSettings.get_string('picture-options'),
            theme.saturation, theme.blur, theme.tintStrength, this._tint(), this._opacity(),
        ].join('|');
        const sum = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, key, -1);
        return GLib.build_filenamev([this._dir, `backdrop-${sum}.png`]);
    }

    /**
     * Delete the pictures in the cache that are not in keep, but for the
     * CACHE_KEEP newest: those of the other colour scheme and of a monitor
     * that is not connected now are found again without a decode.
     */
    _prune(keep) {
        let entries = [];
        try {
            const dir = Gio.File.new_for_path(this._dir);
            const list = dir.enumerate_children(
                'standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = list.next_file(null))) {
                const name = info.get_name();
                if (!name.startsWith('backdrop-') || !name.endsWith('.png'))
                    continue;
                entries.push({
                    path: GLib.build_filenamev([this._dir, name]),
                    time: info.get_attribute_uint64('time::modified'),
                    // A name from before 2026-11-22 is never asked for again.
                    old: !/^backdrop-[0-9a-f]{32}\.png$/.test(name),
                });
            }
            list.close(null);
        } catch {
            return;
        }
        entries = entries.filter(e => !keep.has(e.path)).sort((a, b) => b.time - a.time);
        entries.forEach((e, i) => {
            if (e.old || i >= CACHE_KEEP)
                this._removeFile(e.path);
        });
    }

    /** The wallpaper file for the current colour scheme, or null. */
    _wallpaperPath() {
        const dark = this._ifaceSettings.get_string('color-scheme') === 'prefer-dark';
        const uri = this._bgSettings.get_string(dark ? 'picture-uri-dark' : 'picture-uri') ||
            this._bgSettings.get_string('picture-uri');
        if (!uri || this._bgSettings.get_string('picture-options') === 'none')
            return null;
        const file = uri.includes('://') ? Gio.File.new_for_uri(uri) : Gio.File.new_for_path(uri);
        return file.get_path();
    }

    /**
     * Load the wallpaper scaled and cropped to w x h, decoding off the main
     * thread.
     *
     * The size of the file is asked for off the main thread too. gdk-pixbuf
     * 2.44 starts a loader process for that, and get_file_info() waited for
     * it: 135 to 280 ms in which the shell drew nothing, for a 6016 x 3900
     * PNG (measured 2026-11-22).
     */
    async _loadWallpaper(w, h) {
        const path = this._wallpaperPath();
        if (!path)
            throw new Error('no wallpaper image');
        const [format, iw, ih] = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.get_file_info_async(path, null, (_source, result) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.get_file_info_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (!format || iw <= 0 || ih <= 0)
            throw new Error(`cannot read ${path}`);
        // Cover the monitor, as the default "zoom" picture option does.
        const stretched = this._bgSettings.get_string('picture-options') === 'stretched';
        const k = Math.max(w / iw, h / ih);
        const sw = stretched ? w : Math.max(w, Math.ceil(iw * k));
        const sh = stretched ? h : Math.max(h, Math.ceil(ih * k));
        return new Promise((resolve, reject) => {
            const stream = Gio.File.new_for_path(path).read(null);
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, sw, sh, false, null,
                (_source, result) => {
                    try {
                        const pb = GdkPixbuf.Pixbuf.new_from_stream_finish(result);
                        stream.close(null);
                        resolve(pb.new_subpixbuf(
                            Math.floor((pb.get_width() - w) / 2),
                            Math.floor((pb.get_height() - h) / 2), w, h).copy());
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /** path: the file the picture is written to. */
    _render(pb, w, h, path) {
        const theme = this._config.values.theme;

        if (theme.saturation !== 1)
            pb.saturate_and_pixelate(pb, theme.saturation, false);

        // Blur: halve the size several times, then double it back. Each
        // bilinear step averages neighbours, which approximates a wide blur.
        const sizes = [];
        let cw = w, ch = h;
        const passes = Math.max(0, Math.min(6, Math.round(theme.blur)));
        for (let i = 0; i < passes && cw > 8 && ch > 8; i++) {
            sizes.push([cw, ch]);
            cw = Math.max(4, cw >> 1);
            ch = Math.max(4, ch >> 1);
            pb = pb.scale_simple(cw, ch, GdkPixbuf.InterpType.BILINEAR);
        }
        while (sizes.length) {
            const [pw, ph] = sizes.pop();
            pb = pb.scale_simple(pw, ph, GdkPixbuf.InterpType.HYPER);
        }

        const strength = Math.max(0, Math.min(1, theme.tintStrength));
        const tint = this._tint();
        pb = pb.composite_color_simple(w, h, GdkPixbuf.InterpType.BILINEAR,
            Math.round(255 * (1 - strength)), 64, tint, tint);

        const opacity = this._opacity();
        if (opacity < 1) {
            const clear = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, w, h);
            clear.fill(0x00000000);
            pb.composite(clear, 0, 0, w, h, 0, 0, 1, 1,
                GdkPixbuf.InterpType.NEAREST, Math.round(255 * opacity));
            pb = clear;
        }

        // Under another name first: a start that finds the file reads all of it.
        const part = `${path}.${GLib.get_monotonic_time()}.part`;
        pb.savev(part, 'png', [], []);
        if (GLib.rename(part, path) !== 0) {
            GLib.unlink(part);
            throw new Error(`cannot write ${path}`);
        }
        return path;
    }

    /** The tint of the current style, as 0xrrggbb. */
    _tint() {
        return themeTint(this._config);
    }

    _opacity() {
        const o = Number(this._config.values.theme.opacity);
        return Number.isFinite(o) ? Math.max(0.3, Math.min(1, o)) : 1;
    }

    /** The tint at the opacity of the cards, for a card without the image. */
    _flat() {
        const t = this._tint();
        return `background-color: rgba(${t >> 16}, ${(t >> 8) & 255}, ${t & 255}, ${this._opacity()});`;
    }

    _removeFile(path) {
        if (path)
            GLib.unlink(path);
    }

    /**
     * Keep actor's inline style showing the material at its screen position.
     * baseStyle is extra inline CSS kept in front of the generated part.
     */
    attach(actor, baseStyle = '') {
        if (this._attached.has(actor)) {
            this._attached.get(actor).base = baseStyle;
            this._apply(actor);
            return;
        }
        this._attached.set(actor, {base: baseStyle, laterId: 0, last: null});
        actor.connectObject(
            'notify::allocation', () => this._queue(actor),
            'notify::mapped', () => this._queue(actor),
            'destroy', () => this.detach(actor),
            this);
        this._queue(actor);
    }

    detach(actor) {
        const state = this._attached.get(actor);
        if (!state)
            return;
        if (state.laterId)
            global.compositor.get_laters().remove(state.laterId);
        actor.disconnectObject(this);
        this._attached.delete(actor);
    }

    /**
     * Give surface the material and return an actor that holds it and draws
     * its drop shadow. St builds a box-shadow from the node's own background,
     * and for a node with a background image and rounded corners it paints a
     * hard-edged copy of the image where the blurred shadow belongs. The
     * wrapper has a flat background, which St shadows correctly.
     *
     * live: with theme.liveBlur the surface shows the windows under it,
     * blurred, in place of the picture of the wallpaper.
     */
    wrap(surface, shadowClass = '', props = {}, live = false) {
        const outer = new ShadowBin({
            style_class: `kelp-shadow ${shadowClass}`.trim(),
            child: surface,
            ...props,
        });
        if (live) {
            outer.setGlass(this.glass, this.glass.createLayer());
            this._live.add(surface);
            this._liveBins.add(outer);
            outer.connect('destroy', () => this._liveBins.delete(outer));
            this._syncLiveBin(outer);
        }
        this.attach(surface);
        return outer;
    }

    /** Recompute an attached actor's material after it has moved. */
    update(actor) {
        this._queue(actor);
    }

    _queue(actor) {
        const state = this._attached.get(actor);
        if (!state || state.laterId)
            return;
        state.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            state.laterId = 0;
            this._apply(actor);
            return GLib.SOURCE_REMOVE;
        });
    }

    _apply(actor) {
        const state = this._attached.get(actor);
        if (!state)
            return;
        const style = `${state.base}${this.styleAt(actor)}`;
        if (style !== state.last) {
            state.last = style;
            actor.style = style;
        }
    }

    /** CSS background declarations for an actor at its current stage position. */
    styleAt(actor) {
        // The bin the actor is in draws the material.
        if (this.glass.active && this._live.has(actor))
            return 'background-color: transparent;';
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // An actor that has never been allocated reports an infinite box.
        const [x, y] = restingPosition(actor);
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return this._flat();
        // The picture of the monitor the middle of the actor is on.
        const [width, height] = actor.get_allocation_box().get_size();
        const cx = x + width / 2;
        const cy = y + height / 2;
        const m = this._images.find(i =>
            cx >= i.x && cx < i.x + i.width && cy >= i.y && cy < i.y + i.height) ?? this._images[0];
        if (!m?.url)
            return this._flat();
        const px = v => Math.round(v / scale);
        return `background-image: url("${m.url}"); ` +
            `background-size: ${px(m.width)}px ${px(m.height)}px; ` +
            `background-position: ${px(m.x - x)}px ${px(m.y - y)}px; ` +
            'background-repeat: no-repeat; ' +
            // No colour under the image: it would make the card opaque.
            // The shell theme gives its popups and banners one.
            'background-color: transparent;';
    }
}
