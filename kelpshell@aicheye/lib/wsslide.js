// SPDX-License-Identifier: GPL-3.0-or-later

// What is behind the windows while the workspaces slide.
//
// In the shell every workspace slides with a wallpaper of its own, and the
// 100 px between two of them shows the fill of the group they are in
// (.workspace-animation, #2e2e33): a grey bar across the monitor in every
// switch.
//
// Here the wallpapers still slide with the workspaces, and the space
// between two of them is a join that slides with them and looks the same at
// every point of the switch:
//
//   - at either side, the wallpaper next to it, mirrored into the space, so
//     the picture runs on past its edge without a line;
//   - towards the middle the two mirror images are blurred, and the one
//     from above fades into the one from below.
//
// The wallpapers themselves are drawn as they are at rest, so nothing
// changes when a switch starts or ends.
//
// Two earlier versions of 2026-11-21 did not last the day. In the first the
// wallpaper stood still and only the windows moved. In the second the blur
// followed the progress of the switch: the whole wallpaper was blurred
// halfway, and each wallpaper was blurred towards its edge over a length
// that grew with the progress. Under a three-finger swipe that changed with
// every movement of the fingers.
//
// The edge fade of the primary monitor (lib/edgefade.js) is a still copy of
// the wallpaper drawn over the windows. It cannot stand for a wallpaper that
// moves, so it is hidden for the switch and the sliding windows are faded
// themselves, by the same curve over the same width.
//
// Both are fragment shaders on offscreen effects. Without Cogl snippets the
// join is the two mirror images with no blur, and the edge fade stays.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

const BLUR = 40;   // px, blur radius in the middle of a join

const HAVE_SNIPPETS = typeof Cogl.Snippet?.new === 'function' &&
    typeof Clutter.OffscreenEffect.prototype.get_pipeline === 'function';

// One snippet per shader text. Cogl compiles one program for all the
// pipelines that hold the same snippet object.
const snippets = new Map();

/** Multiplies what an actor draws by the alpha a line of GLSL computes. */
const MaskEffect = GObject.registerClass(
class KelpMaskEffect extends Clutter.OffscreenEffect {
    setCode(code) {
        this._code = code;
    }

    vfunc_paint_target(node, paintContext) {
        // Clutter makes a new pipeline whenever the offscreen buffer is
        // resized.
        const pipeline = this.get_pipeline();
        if (pipeline && pipeline !== this._pipeline) {
            this._pipeline = pipeline;
            let snippet = snippets.get(this._code);
            if (!snippet) {
                snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, '', this._code);
                snippets.set(this._code, snippet);
            }
            pipeline.add_snippet(snippet);
        }
        super.vfunc_paint_target(node, paintContext);
    }
});

function masked(actor, code) {
    const effect = new MaskEffect();
    effect.setCode(code);
    actor.add_effect(effect);
    return actor;
}

/**
 * Places and sizes along the axis the workspaces slide on (a) and across it
 * (c), for a strip that slides down (vertical) or sideways.
 */
class Axes {
    constructor(monitor, vertical) {
        this.vertical = vertical;
        this.width = monitor.width;
        this.height = monitor.height;
        this.length = vertical ? monitor.height : monitor.width;   // along
        this.cross = vertical ? monitor.width : monitor.height;    // across
        this.coord = vertical ? 't' : 's';   // the texture coordinate along
    }

    box(a, c, la, lc, props = {}) {
        return new Clutter.Actor({
            x: this.vertical ? c : a, y: this.vertical ? a : c,
            width: this.vertical ? lc : la, height: this.vertical ? la : lc,
            clip_to_allocation: true,
            ...props,
        });
    }

    /** A copy of the wallpaper at (a, c), mirrored along and across on request. */
    copy(source, a, c, flipAlong = false, flipAcross = false) {
        const clone = new Clutter.Clone({
            source, width: this.width, height: this.height,
            x: this.vertical ? c : a, y: this.vertical ? a : c,
        });
        if (flipAlong || flipAcross) {
            const [fx, fy] = this.vertical ? [flipAcross, flipAlong] : [flipAlong, flipAcross];
            clone.set_pivot_point(0.5, 0.5);
            clone.set_scale(fx ? -1 : 1, fy ? -1 : 1);
        }
        return clone;
    }
}

/**
 * The wallpaper past one of its edges, mirrored there and blurred: `gap` px
 * along the axis, the width of the monitor across it. end: past the edge
 * the wallpaper ends at (below it, for a strip that slides down), else past
 * the edge it starts at.
 *
 * The shell's blur effect blurs into the transparent pixels around what it
 * is given, so its picture is see-through near its edges: 120 px in at a
 * radius of 40. What is blurred is larger than what is shown by that much on
 * every side, filled with the wallpaper and mirror images of it. It is still
 * only a strip, a fifth of the monitor at 2160 px, and not the whole picture.
 */
function blurredEdge(axes, source, end, gap, radius) {
    const margin = Math.ceil(3 * radius);
    const holder = axes.box(0, 0, gap, axes.cross);
    const blurred = axes.box(-margin, -margin, gap + 2 * margin, axes.cross + 2 * margin);
    // Where the wallpaper itself starts, in the holder: it ends where the
    // holder starts, or starts where the holder ends.
    const origin = end ? -axes.length : gap;
    const mirror = origin + (end ? axes.length : -axes.length);
    for (const across of [-1, 0, 1]) {
        const c = margin + across * axes.cross;
        blurred.add_child(axes.copy(source, margin + origin, c, false, across !== 0));
        blurred.add_child(axes.copy(source, margin + mirror, c, true, across !== 0));
    }
    blurred.add_effect(new Shell.BlurEffect({
        radius, brightness: 1, mode: Shell.BlurMode.ACTOR,
    }));
    holder.add_child(blurred);
    return holder;
}

/**
 * The join between two wallpapers: `gap` px along the axis, from the end of
 * one wallpaper to the start of the next.
 *
 * Under everything, each half shows the wallpaper next to it, mirrored. Over
 * that, the blurred mirror images, the one from before fading into the one
 * from after across the whole join. The blurred part is see-through at both
 * sides of the join and opaque over its middle 30%, which hides the line
 * where the two sharp halves meet.
 */
function seam(axes, source, gap, radius) {
    const half = Math.ceil(gap / 2);
    const actor = axes.box(0, 0, gap, axes.cross);
    const first = axes.box(0, 0, half, axes.cross);
    first.add_child(axes.copy(source, 0, 0, true));
    const second = axes.box(gap - half, 0, half, axes.cross);
    second.add_child(axes.copy(source, half - axes.length, 0, true));
    actor.add_child(second);
    actor.add_child(first);
    if (!HAVE_SNIPPETS)
        return actor;

    const t = `cogl_tex_coord_in[0].${axes.coord}`;
    const soft = masked(axes.box(0, 0, gap, axes.cross),
        `cogl_color_out *= smoothstep(0.0, 0.35, ${t}) * (1.0 - smoothstep(0.65, 1.0, ${t}));`);
    soft.add_child(blurredEdge(axes, source, false, gap, radius));
    const before = masked(axes.box(0, 0, gap, axes.cross),
        `cogl_color_out *= 1.0 - smoothstep(0.0, 1.0, ${t});`);
    before.add_child(blurredEdge(axes, source, true, gap, radius));
    soft.add_child(before);
    actor.add_child(soft);
    return actor;
}

/**
 * Give the group the shell slides the workspaces in its wallpapers. group is
 * a MonitorGroup that has just been built, fade the EdgeFade. glass: the
 * Glass of lib/glass.js, or null. The group covers the windows and slides
 * copies of them, so the cards that blur the windows under them are shown
 * those copies for as long as the group lasts.
 */
export function decorateSwitch(group, monitor, fade, glass = null) {
    // Under everything, and still: the source of every copy, and what shows
    // wherever nothing else is drawn.
    const source = new WorkspaceAnimation.WorkspaceBackground(
        global.workspace_manager.get_active_workspace(), monitor);
    group.insert_child_at_index(source, 0);

    const container = group._container;
    const groups = group._workspaceGroups ?? [];
    if (!container || groups.length === 0)
        return;

    const vertical = global.workspace_manager.layout_rows === -1;
    const axes = new Axes(monitor, vertical);
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const place = g => vertical ? g.y : g.x;
    const sorted = [...groups].sort((a, b) => place(a) - place(b));
    sorted.forEach((g, i) => {
        container.insert_child_at_index(new Clutter.Clone({
            source, x: g.x, y: g.y, width: monitor.width, height: monitor.height,
        }), 0);
        const next = sorted[i + 1];
        const gap = next ? Math.round(place(next) - place(g) - axes.length) : 0;
        if (gap <= 0)
            return;
        const join = seam(axes, source, gap, BLUR * scale);
        const a = place(g) + axes.length;
        join.set_position(vertical ? g.x : a, vertical ? a : g.y);
        container.insert_child_at_index(join, 0);
    });

    // The windows fade towards the left edge of the primary monitor, as
    // they do under the edge fade at rest.
    const others = group.get_children().filter(c =>
        c instanceof WorkspaceAnimation.WorkspaceGroup);
    glass?.setSliding(group, monitor, [...groups, ...others]);

    const band = monitor.index === Main.layoutManager.primaryIndex ? fade?.band : null;
    if (!band || !HAVE_SNIPPETS)
        return;
    const code = `cogl_color_out *= smoothstep(0.0, 1.0, cogl_tex_coord_in[0].s * ${(monitor.width / band.width).toFixed(4)});`;
    for (const g of [...groups, ...others]) {
        // Nothing to fade, or a fullscreen window: that one has no fade at
        // rest either.
        if (g.get_n_children() === 0)
            continue;
        if (g.workspace?.list_windows().some(w =>
            w.get_monitor() === monitor.index && w.is_fullscreen()))
            continue;
        const effect = new MaskEffect();
        effect.setCode(code);
        g.add_effect(effect);
    }
    fade.suspend(true);
    group.connect('destroy', () => fade.suspend(false));
}
