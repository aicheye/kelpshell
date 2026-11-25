// SPDX-License-Identifier: GPL-3.0-or-later

// Where a window lies in the picture of a recording of it (lib/windowrec.js).
//
// Mutter makes each frame of a cast of a window in one of two ways. A
// window with one surface whose buffer it can read is copied from that
// buffer. Every other window is painted: the window's actor is painted
// into a buffer of the cast, with the actor's own transform. That is the
// way of every client that draws with the GPU and of every client with
// more than one surface, a browser for example.
//
// lib/tiling.js draws a tile where it is on the strip with the translation
// and the scale of its actor. In a painted frame the window is then away
// from its place by as much as the strip has scrolled, and smaller while it
// has no focus. The buffer of the cast is as large as the monitor and has
// the window's buffer in its upper left corner, with the shadow the client
// draws around its frame: a window as high as the work area loses its lower
// edge by the height of the shadow above it.
//
// CastPlace is an effect on the window's actor. In a paint for the cast it
// takes the actor's translation and scale away again and moves the part of
// the window that is drawn (lib/crop.js) to the corner of the picture. The
// window is painted by itself there, without the shade of the sidebar. The
// stage is painted with perspective and a cast without, which is how the
// two are told apart.
//
// A tile that is partly out of its strip's view is cut there with the clip
// of its actor, which a paint for the cast would be cut by too. While the
// effect is on the actor, lib/tiling.js gives the clip to the effect, which
// cuts the paint for the screen and the pick with it, and leaves the cast
// whole.
//
// Mutter draws the pointer into a cast where the pointer is in the window's
// buffer, which is no longer where the window is in the picture. So the
// cast is asked for without a pointer, the effect draws it after the
// window, and frames are asked for while the pointer moves over the window.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {paintAlone} from './corners.js';
import {visibleRect} from './crop.js';

export const CAST_PLACE = 'kelp-cast-place';

const CastPlace = GObject.registerClass(
class KelpCastPlace extends Clutter.Effect {
    _init(config, win, pointer) {
        super._init();
        this._config = config;
        this._win = win;
        this._pointer = pointer;
        // What the window is cut to on the screen, in its actor: [x, y,
        // width, height], or null.
        this.clip = null;
    }

    vfunc_paint(node, paintContext, _flags) {
        const actor = this.actor;
        const framebuffer = paintContext.get_framebuffer();
        const move = this._move(framebuffer);
        if (!move) {
            const clip = this.clip;
            if (clip)
                framebuffer.push_rectangle_clip(clip[0], clip[1], clip[0] + clip[2], clip[1] + clip[3]);
            try {
                actor.continue_paint(paintContext);
            } finally {
                if (clip)
                    framebuffer.pop_clip();
            }
            return;
        }
        framebuffer.push_matrix();
        framebuffer.transform(move);
        try {
            paintAlone(() => actor.continue_paint(paintContext));
            if (this._pointer)
                this._paintPointer(paintContext);
        } finally {
            framebuffer.pop_matrix();
        }
        // The buffer is read as soon as the actor is painted. What Cogl
        // has kept to draw later is drawn at the end of a buffer's life,
        // and this function holds on to the buffer for longer than that.
        framebuffer.flush();
    }

    vfunc_pick(pickContext) {
        const clip = this.clip;
        if (clip) {
            pickContext.push_clip(new Clutter.ActorBox({
                x1: clip[0], y1: clip[1], x2: clip[0] + clip[2], y2: clip[1] + clip[3],
            }));
        }
        try {
            this.actor.continue_pick(pickContext);
        } finally {
            if (clip)
                pickContext.pop_clip();
        }
    }

    /**
     * What a paint for a cast is transformed by before the actor's own
     * transform, or null in every other paint. The actor's transform is
     * its translation and scale and then its position. In their place the
     * actor is moved to its position less the corner of the drawn part.
     */
    _move(framebuffer) {
        if (global.stage.peek_stage_views().some(view => view.get_framebuffer() === framebuffer))
            return null;
        if (!framebuffer.get_modelview_matrix().is_2d())
            return null;
        const actor = this.actor;
        const [ok, inverse] = actor.get_transform().inverse();
        if (!ok)
            return null;
        const box = actor.get_allocation_box();
        const shown = visibleRect(this._config, this._win);
        const buffer = this._win.get_buffer_rect();
        return new Graphene.Matrix().init_translate(new Graphene.Point3D({
            x: box.x1 - (shown.x - buffer.x),
            y: box.y1 - (shown.y - buffer.y),
            z: 0,
        })).multiply(inverse);
    }

    /** The pointer, while it is on the window. */
    _paintPointer(paintContext) {
        if (!this._win.has_pointer())
            return;
        const tracker = global.backend.get_cursor_tracker();
        const sprite = tracker.get_pointer_visible() ? tracker.get_sprite() : null;
        if (!sprite)
            return;
        const [x, y] = global.get_pointer();
        const [ok, ax, ay] = this.actor.transform_stage_point(x, y);
        if (!ok)
            return;
        // The sprite is drawn in the px of the monitor, each of its own px
        // as `scale` of them. The stage has those px too where St has the
        // scale, and logical px otherwise.
        const physical = St.ThemeContext.get_for_stage(global.stage).scale_factor > 1;
        const monitor = physical ? 1 : global.display.get_monitor_scale(this._win.get_monitor());
        const k = (tracker.get_scale() || 1) / monitor;
        const [hotX, hotY] = tracker.get_hot();
        const left = ax - hotX * k;
        const top = ay - hotY * k;
        const pointer = Clutter.TextureNode.new(sprite, null,
            Clutter.ScalingFilter.LINEAR, Clutter.ScalingFilter.LINEAR);
        pointer.add_rectangle(new Clutter.ActorBox({
            x1: left, y1: top,
            x2: left + sprite.get_width() * k, y2: top + sprite.get_height() * k,
        }));
        pointer.paint(paintContext);
    }
});

/**
 * Keep a window in place in the casts of it from now on. pointer: the
 * pointer is drawn into them. Returns a function that ends it. The tile
 * is synced after that (Tiling.setFullSize), which gives the actor its
 * clip again.
 */
export function holdInPlace(config, win, pointer) {
    const actor = win.get_compositor_private();
    if (!actor)
        return () => {};
    actor.remove_effect_by_name(CAST_PLACE);
    const effect = new CastPlace(config, win, pointer);
    if (actor.has_clip) {
        effect.clip = actor.get_clip();
        actor.remove_clip();
    }
    actor.add_effect_with_name(CAST_PLACE, effect);
    let gone = false;
    actor.connectObject('destroy', () => (gone = true), effect);

    // A cast has a new frame when the window has drawn. The pointer moves
    // without that, so a frame is asked for: Mutter records one when the
    // actor says that the window has drawn.
    const tracker = global.backend.get_cursor_tracker();
    let over = false;
    const moved = () => {
        const now = win.has_pointer();
        if (!gone && (now || over))
            actor.emit('damaged');
        over = now;
    };
    if (pointer) {
        tracker.connectObject(
            'position-invalidated', moved,
            'cursor-changed', moved,
            'visibility-changed', moved, effect);
    }

    return () => {
        tracker.disconnectObject(effect);
        if (gone)
            return;
        actor.disconnectObject(effect);
        actor.remove_effect(effect);
    };
}
