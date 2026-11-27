// SPDX-License-Identifier: GPL-3.0-or-later

// Scrolling window manager.
//
// Each workspace on each monitor is a strip: columns laid left to right, each
// column holding one or more windows stacked vertically. The strip is wider
// than the screen and the view scrolls to keep the focused column visible.
//
// Mutter keeps every window's real frame inside its monitor. A window whose
// place on the strip is partly or fully outside the view keeps a real frame at
// the nearest position inside the work area, and its actor is translated to
// where it belongs on the strip. Motion is the same translation driven by a
// spring, so the real frame moves once per layout and the picture moves every
// frame.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {CAST_PLACE} from './castplace.js';
import {Spring, rubberBand} from './spring.js';
import {ringColor} from './config.js';
import {Corners, surfaceOf} from './corners.js';
import {EdgeFade} from './edgefade.js';
import {decorateSwitch} from './wsslide.js';
import {cropOf, hasRule, holdFrame, visibleRect} from './crop.js';
import {Titlebars} from './titlebar.js';
import {Widths} from './widths.js';

const MIN_COLUMN_WIDTH = 160;
const MIN_PROPORTION = 0.1;
// A column this share of the view's width short of the whole width counts
// as being as wide as the view, for maximize-column.
const FULL_SLACK = 0.02;
// A window's minimum width that is this share of the view's width or less
// under the width of a preset counts as that preset, see Strip.widthFor.
const MIN_SNAP_SHARE = 0.05;

// Windows that are popups to the eye but give the window manager no hint of
// it: normal type, resizable, no parent. Matched on the names of the app
// (appNames) and on the title.
const FLOAT_RULES = [
    {app: /1password|onepassword/, title: /^quick access/i},
    {title: /^picture[- ]in[- ]picture$/i},
];

/**
 * The names the app of a window goes by, in lower case: the class and the
 * instance the window gives, the id of the app's desktop file and the name
 * the app is shown with.
 *
 * The class alone does not name every app the way its user does. The
 * windows of 1Password have the class "com.onepassword.OnePassword", which
 * does not contain "1password". Its name is "1Password".
 */
function appNames(win) {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    return [win.get_wm_class(), win.get_wm_class_instance(), app?.get_id(), app?.get_name()]
        .filter(name => name).map(name => name.toLowerCase());
}
// Clients that open a window only to be given keyboard focus. wl-copy sets
// the clipboard this way: a transparent window that closes a few
// milliseconds later. Tiled, it would take a column and give it back, and
// every window on the strip would move over and return.
const HELPER_CLASSES = ['io.github.bugaevc.wl-clipboard'];

export function isHelper(win) {
    const cls = (win.get_wm_class() ?? '').toLowerCase();
    return HELPER_CLASSES.includes(cls);
}

// WM_WINDOW_ROLE values that toolkits give to popups and dialogs.
const FLOAT_ROLES = new Set(['pop-up', 'bubble', 'dialog', 'task_dialog']);
// A window is new for this long after it appears. Its title is checked
// against the float rules again in that time, because some apps set the
// title after the window maps, and a new window that leaves the strip gives
// the strip back the view it had.
const LATE_TITLE_MS = 2000;
// A new window of a class that has a float rule keeps its column pending for
// this long after it is first shown, see Column.pending.
const PENDING_MS = 400;
// At the end of that time, a window narrower or lower than this share of
// the place its column gave it did not take the size, see _refusedSize.
const REFUSED_SIZE = 0.75;

// Touchpad swipe. Distances are in touchpad units as libinput reports them
// without acceleration, the same units the shell's own gestures use.
// A client can refuse to become as narrow as its column without declaring a
// minimum size (Firefox does). This long after a frame is requested, a frame
// that is still wider than the request is taken as the window's minimum.
const WIDTH_CHECK_MS = 350;
// A window whose edge is dragged (Tile.holdResize): with the pointer still
// and no new size from the client for this long, the size the client has is
// the size for that place of the pointer.
const HOLD_SETTLE_MS = 400;
// The column or row of a window that fills the room a dragged edge asks
// for (Tile._fillHeld), in px from that edge.
const FILL_INSET = 4;

// How long after the launcher starts a program a new window is taken to be
// that program's window.
const EXPECT_WINDOW_MS = 10000;

// A window that is on no strip, moved or sized by a key (Floater):
const FLOAT_ANSWER_MS = 400;        // its client has this long to take a new size
const FLOAT_STEP = 0.05;            // of the width of the work area: one press of a move key
const FLOAT_MIN_HEIGHT = 120;       // px, the least the height keys give it
const SWIPE_FINGERS = 3;

// Dragging a window. The pointer has to travel this far before a drop place
// is shown or used, so a press on a title bar that barely moves changes
// nothing.
const DRAG_DISTANCE = 24;
// A pointer over the middle of a column stacks the window into it. This
// share of the column's width at each side, up to the pixel limit, puts the
// window beside the column as a column of its own.
const DROP_SIDE_SHARE = 0.25;
const DROP_SIDE_MAX = 140;
// Size of the icon that stands for a window dragged into the sidebar, px.
const SUNK_ICON_SIZE = 48;

// The shell animates a window that enters or leaves fullscreen for 250 ms
// (WINDOW_ANIMATION_TIME in windowManager.js). A tile is placed again this
// long after it found that animation running.
const SIZE_CHANGE_WAIT_MS = 300;
// Closed windows kept for reopen-closed, see Tiling._closed.
const CLOSED_MAX = 20;
// A new tiled window fades in over OPEN_MS, and is drawn smaller than its
// place by OPEN_SHRINK thousandths when the fade starts.
const OPEN_MS = 150;
const OPEN_SHRINK = 60;
// For this long after a new window is mapped it is drawn at the size of its
// place, see Tile.opening.
const OPEN_SIZE_MS = 600;
// A window that is out of the view lies this far left of the leftmost
// monitor, see Tile._park().
const PARK_GAP = 256;
const SWIPE_DISTANCE = 16;          // units before the axis is decided, as in the shell
const SWIPE_UNITS_PER_VIEW = 1200;  // units that scroll the strip by one view width
const SWIPE_COAST = 0.3;            // s of the release velocity added as coasting distance
const SWIPE_FLICK = 300;            // px/s: a faster release moves focus to the next column
const SWIPE_SWITCH_SHARE = 0.08;    // of the view width: a slower release that travelled this far does too
const SWIPE_STEP_SHARE = 0.05;      // of the view width: travel that moves focus to a neighbour already whole in the view, fingers still down
const SWIPE_DRAG_SHARE = 1 / 3;     // of the view width: a release that travelled less moves focus one column, a longer one to where the view coasts
const SWIPE_VELOCITY_MS = 120;      // the release velocity is measured over this long
const SWIPE_REST_MS = 80;           // fingers that rested this long before lifting have no velocity
const SWIPE_AGAIN_MS = 300;         // over a fullscreen window: a swipe this soon after one the same way does not go on from a window to the sidebar, or from the sidebar to a window

// A window that fills the view heads for a place this far, px, towards the
// side it was moved to, at most this share of its width or height, and
// turns back after NUDGE_OUT_MS: it gets seven tenths of the way there,
// 150 px (Tile.nudgeBy).
const NUDGE_PX = 215;
const NUDGE_SHARE = 0.125;
const NUDGE_OUT_MS = 90;

// The strips as they were at the last disable(), for the next enable(): a
// lock of the screen takes the tiling down and an unlock starts it again
// (extension.js). See Tiling._save() for what is kept.
let savedLayout = null;

/**
 * The extension is disabled while the screen is locked. The window actors
 * that were left as they were drawn for the unlock (Tiling.disable) go back
 * to their frames, and the windows floated by hand are no longer kept above.
 */
export function dropSavedLayout() {
    const saved = savedLayout;
    if (!saved?.kept)
        return;
    saved.kept = false;
    for (const actor of global.get_window_actors()) {
        actor.translation_x = 0;
        actor.translation_y = 0;
        actor.set_scale(1, 1);
        actor.set_pivot_point(0, 0);
        clearClip(actor);
    }
    const live = new Set(global.display.list_all_windows());
    for (const win of [...saved.floating, ...saved.raised]) {
        if (live.has(win) && win.is_above())
            win.unmake_above();
    }
}

// Mutter skips drawing whatever lies under a window's opaque area, and it
// does that without looking at the actor's clip. Under the clipped-away part
// of a window nothing would be drawn at all. An actor that has any effect is
// left out of that optimisation, so clipped windows carry this empty one.
const CLIP_EFFECT = 'kelp-clip';
const PassEffect = GObject.registerClass(
class KelpPassEffect extends Clutter.Effect {});

/**
 * top: the y the clip starts at, negative for a title bar above the buffer.
 * A window that is recorded has the clip in its effect, which leaves the
 * recording whole (lib/castplace.js).
 */
function setClip(actor, clip, top, height) {
    const held = actor.get_effect(CAST_PLACE);
    if (held) {
        held.clip = clip ? [clip[0], top, clip[1], height - top] : null;
        if (actor.has_clip)
            actor.remove_clip();
        actor.queue_redraw();
        return;
    }
    if (clip) {
        actor.set_clip(clip[0], top, clip[1], height - top);
        if (!actor.get_effect(CLIP_EFFECT))
            actor.add_effect_with_name(CLIP_EFFECT, new PassEffect());
    } else if (actor.has_clip) {
        clearClip(actor);
    }
}

function clearClip(actor) {
    const held = actor.get_effect(CAST_PLACE);
    if (held)
        held.clip = null;
    actor.remove_clip();
    if (actor.get_effect(CLIP_EFFECT))
        actor.remove_effect_by_name(CLIP_EFFECT);
}

function rectKey(r) {
    return `${r.x},${r.y},${r.width},${r.height}`;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/**
 * The frame to ask a window for so that the part of it that is drawn is
 * rect, see visibleRect() in crop.js: larger by the edges that are cut off,
 * and below a drawn title bar.
 */
function frameFor(config, win, rect) {
    const c = cropOf(config, win);
    const top = c.top - c.bar;
    return {
        x: rect.x - c.left, y: rect.y - top,
        width: rect.width + c.left + c.right, height: rect.height + top + c.bottom,
    };
}

function isMaximized(win) {
    return win.get_maximize_flags() !== Meta.MaximizeFlags.NONE;
}

function minSize(win) {
    try {
        const r = win.get_min_size();
        if (Array.isArray(r)) {
            const nums = r.filter(v => typeof v === 'number');
            if (nums.length >= 2)
                return [nums[0], nums[1]];
        }
    } catch {
    }
    return [0, 0];
}

/**
 * Shows where a dragged window lands: a panel over the place it takes in a
 * stack or at an end of the strip, or a bar between two columns.
 */
class DropHint {
    constructor() {
        this.actor = new St.Widget({
            style_class: 'kelp-drop-hint',
            reactive: false,
            visible: false,
            opacity: 0,
        });
        global.window_group.add_child(this.actor);
        this._rect = null;
    }

    /**
     * rect: {x, y, width, height}. dragged: the dragged window's actor.
     * The hint is drawn over that window: the window is as large as the
     * place it would take, and would cover a hint under it.
     */
    show(rect, dragged) {
        const actor = this.actor;
        if (dragged?.get_parent() === global.window_group)
            global.window_group.set_child_above_sibling(actor, dragged);
        const r = this._rect;
        if (r && r.x === rect.x && r.y === rect.y && r.width === rect.width &&
            r.height === rect.height)
            return;
        this._rect = rect;
        actor.remove_all_transitions();
        if (!r) {
            actor.set_position(rect.x, rect.y);
            actor.set_size(rect.width, rect.height);
            actor.show();
            actor.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            actor.ease({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                opacity: 255,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }
    }

    hide() {
        if (!this._rect)
            return;
        this._rect = null;
        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.actor.hide(),
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

class Tile {
    constructor(wm, win) {
        this.wm = wm;
        this.win = win;
        this.actor = win.get_compositor_private();
        this.x = new Spring();
        this.y = new Spring();
        // How much smaller than its place the window is drawn, in
        // thousandths: 0 for the current tile, 20 for the rest at
        // windows.unfocusedScale 0.98. Thousandths, because a spring comes
        // to rest within 0.4 of its target.
        this.shrink = new Spring();
        // The size the window is drawn at, px. A client takes a new size in
        // one frame. These follow the frame with the spring the positions
        // use, and the actor is scaled from the size of its frame to them,
        // so the window grows or shrinks to its new size while its
        // neighbours move over.
        this.w = new Spring();
        this.h = new Spring();
        this._sized = false;     // w and h hold a size
        // Stage x of the middle of the place, while the window is drawn
        // around it at whatever width it has (setTarget). null otherwise.
        this._middle = null;
        this._middleX = null;    // the x last written for it
        // Where the tile was drawn when the sidebar began to change its
        // width, while it goes to its new place with the cards: {x, w,
        // free}, see Tiling.glideBegin. null otherwise.
        this._glide = null;
        // px added to the x and the y the window is drawn at, and the time
        // in s until it turns back, see nudgeBy.
        this.nudge = new Spring();
        this.nudgeY = new Spring();
        this._nudgeLeft = 0;
        this.target = null;      // place on the strip, screen coordinates
        this.strip = null;
        this.column = null;
        this.weight = 1;         // share of the column height
        // Where the tile was on each strip it has left, see Strip.placeOf.
        this.places = new WeakMap();
        this.placed = false;
        this.grabbed = false;
        this._held = null;       // an edge is dragged with the pointer, see holdResize
        this._request = null;
        this.minWidth = 0;       // narrowest width the client took when asked for less
        this.cameFrom = null;    // the strip's scroll before this window came in over a fullscreen one
        this._retries = 0;       // times the current request was sent again
        this._checkId = 0;
        this._sizeChangeId = 0;
        // A new window that has not been mapped for OPEN_SIZE_MS yet. Its
        // first buffer often has another size than the one it was asked
        // for: Ghostty 360 px wide, then 858 px 35 ms later, Firefox
        // 1280 px, then 858 px 120 ms later. For that time the window is
        // drawn at the size of its place, whatever its frame is (_size).
        // The size spring would draw it growing or shrinking from its
        // first size while it fades in.
        this.opening = false;
        this._openId = 0;

        win.connectObject(
            'position-changed', () => this.sync(),
            'size-changed', () => this._onSizeChanged(),
            this);
    }

    _onSizeChanged() {
        this._unshift();
        this._followSize();
        this.sync();
        // The window went under the minimum recorded for it, so that
        // minimum was wrong: the client answered after the check.
        if (this.minWidth && visibleRect(this.wm.config, this.win).width < this.minWidth)
            this._queueWidthCheck();
        else if (this._missized())
            this._queueWidthCheck();
        else if (this._fits())
            this._retries = 0;
    }

    /**
     * Move the frame back to the position last asked for, when the client
     * has moved it with the buffer that changed its size.
     *
     * A GTK window with a gravity sends wl_surface.offset with every buffer
     * of a new size: half of the change, so the window stays around its
     * middle. Mutter adds that to the position it was asked for. The Video
     * Player (Showtime) does this: leaving fullscreen on a 1440 px wide
     * monitor its frame ends 386 px to the right of its place and 15 px
     * above it, and after opening 261 px to the right. The tile is drawn
     * at its place whatever its frame is, so with the frame left there
     * clicks land beside the window, and the shell's animation out of
     * fullscreen ends at the frame and not at the place.
     *
     * This runs in the window's size-changed signal, which Mutter emits
     * before it tells the shell about the new size, so that animation
     * reads the corrected frame.
     */
    _unshift() {
        const r = this._request;
        if (!r || this.dead || this.grabbed || this.fullscreen || !this.strip ||
            this._unshifting || this._missized())
            return;
        const frame = this.win.get_frame_rect();
        if (frame.x === r.x && frame.y === r.y)
            return;
        this._unshifting = true;
        try {
            this.win.move_frame(true, r.x, r.y);
        } finally {
            this._unshifting = false;
        }
    }

    /**
     * Whether the frame is not the one last asked for: smaller, or taller.
     * A frame that is only wider is the client's minimum width, see
     * _queueWidthCheck().
     *
     * A taller frame counts too. A client that sets a taller size of its
     * own would otherwise keep it: a Firefox window made from a dragged
     * tab, and Spotify when it opens, reach past the bottom of the view.
     */
    _missized() {
        const r = this._request;
        if (!r || this.dead || this.grabbed || this.fullscreen || !this.strip)
            return false;
        const frame = this.win.get_frame_rect();
        return frame.width < r.width - 1 || Math.abs(frame.height - r.height) > 1;
    }

    /** Whether the frame has the size last asked for. */
    _fits() {
        const r = this._request;
        if (!r || this.dead)
            return false;
        const frame = this.win.get_frame_rect();
        return Math.abs(frame.width - r.width) <= 1 && Math.abs(frame.height - r.height) <= 1;
    }

    /**
     * Send the drawn size to the size the frame has now. It goes there at
     * once for a window that is not on the strip yet, is held by the
     * pointer or is fullscreen, and while the shell runs its own animation
     * of a size change (maximize, fullscreen).
     */
    _followSize() {
        const frame = visibleRect(this.wm.config, this.win);
        const still = !this._sized || !this.placed || this.grabbed || this.fullscreen ||
            !this.target || !this.wm.animator.enabled || this.actor?.__animationInfo ||
            this.opening;
        if (still) {
            this.w.set(frame.width);
            this.h.set(frame.height);
        } else {
            this.w.target = frame.width;
            this.h.target = frame.height;
            this.wm.animator.add(this);
        }
        this._sized = true;
    }

    /**
     * An edge of the window is being dragged with the pointer (op, a
     * Meta.GrabOp), and the shell draws the window's frame (a rule of
     * windows.crop). Until the drag ends that frame is drawn at the size
     * the pointer asks for, so its edge is under the pointer in every
     * frame: the shape the window is cut to, its title bar, its handles
     * and the ring (drawnFrame() in crop.js, heldRect).
     *
     * The window manager asks the client for a size on every motion, and
     * the window's frame changes when the client has drawn it. Measured
     * with an edge dragged 4 px every 16 ms: the edge of the test Spotify
     * and of a Chrome window is 16 px behind the pointer (67 ms, four
     * frames), the edge of a GTK window 4 px (17 ms). Drawn at the
     * window's frame, the edge would trail the pointer by that much.
     *
     * The content is drawn at the size it has. Where the frame asked for
     * is smaller, the shape cuts it off. Where it is larger, the room
     * between the two is filled with the content's last column or row of
     * pixels, drawn as wide as that room (_fillHeld), which continues the
     * background the window has at that edge.
     *
     * The content is not scaled to the size asked for: it would be 3 to
     * 5% narrower or wider than it is while the pointer moves, and go
     * back when it stops.
     *
     * Not for a window that draws its own frame: that frame is part of
     * the content, and cannot be drawn ahead of it.
     */
    holdResize(op) {
        const name = Object.keys(Meta.GrabOp).find(k => Meta.GrabOp[k] === op) ?? '';
        const edges = name.startsWith('RESIZING_') ? name.slice('RESIZING_'.length) : '';
        if (!edges || this.dead || !this.wm.animator.enabled || !hasRule(this.wm.config, this.win))
            return;
        const [px, py] = global.get_pointer();
        const f = this.win.get_frame_rect();
        const size = [f.width, f.height];
        const held = this._held = {
            edges, px, py,
            frame: {x: f.x, y: f.y, width: f.width, height: f.height},
            min: minSize(this.win),
            raw: size,        // the size for the place of the pointer
            bias: [0, 0],     // what the client's size differs from it by, see _holdStep
            size,             // raw + bias: the size the frame is drawn at
            seen: size,       // the size of the frame at the last step
            moved: 0,         // ms, the last change of raw
            answered: 0,      // ms, the last change of seen
            fills: null,      // see _fillHeld
        };
        this.wm.animator.add({
            tick: () => {
                if (this.dead || this._held !== held)
                    return false;
                this._holdStep(held);
                return true;
            },
        });
    }

    /** Once per frame of a drag: the size for where the pointer is now. */
    _holdStep(held) {
        const now = GLib.get_monotonic_time() / 1000;
        const [px, py] = global.get_pointer();
        const {edges, frame, min} = held;
        // px the frame grows by on an axis: the far edge follows the
        // pointer, the near edge goes against it.
        const grown = (far, near, moved) => {
            if (edges.includes(far))
                return moved;
            return edges.includes(near) ? -moved : 0;
        };
        const dx = grown('E', 'W', px - held.px);
        const dy = grown('S', 'N', py - held.py);
        const raw = [
            Math.max(1, min[0], Math.round(frame.width + dx)),
            Math.max(1, min[1], Math.round(frame.height + dy)),
        ];
        const f = this.win.get_frame_rect();
        if (raw[0] !== held.raw[0] || raw[1] !== held.raw[1])
            held.moved = now;
        if (f.width !== held.seen[0] || f.height !== held.seen[1])
            held.answered = now;
        held.raw = raw;
        held.seen = [f.width, f.height];
        // A size the client did not take, or a limit of the window manager
        // that is not known here: the frame is not drawn at a size the
        // window will never have.
        if (now - held.moved > HOLD_SETTLE_MS && now - held.answered > HOLD_SETTLE_MS)
            held.bias = [f.width - raw[0], f.height - raw[1]];
        const size = [raw[0] + held.bias[0], raw[1] + held.bias[1]];
        if (size[0] !== held.size[0] || size[1] !== held.size[1]) {
            held.size = size;
            holdFrame(this.win, this._heldFrame());
            this.wm.corners?.sync(this.win);
            this.wm.titlebars?.sync(this.win);
            this.sync();
        }
    }

    /** The drag is over: everything is drawn at the window's own frame again. */
    releaseResize() {
        const held = this._held;
        if (!held)
            return;
        this._held = null;
        holdFrame(this.win, null);
        for (const fill of Object.values(held.fills ?? {}))
            fill.destroy();
        if (!this.dead) {
            this.wm.corners?.sync(this.win);
            this.wm.titlebars?.sync(this.win);
        }
    }

    /** The frame a dragged edge asks for, see holdResize. null with none. */
    _heldFrame() {
        const held = this._held;
        if (!held || !this.grabbed)
            return null;
        const {edges, frame} = held;
        const [width, height] = held.size;
        // The opposite edge stays where it was when the drag began.
        return {
            x: edges.includes('W') ? frame.x + frame.width - width : frame.x,
            y: edges.includes('N') ? frame.y + frame.height - height : frame.y,
            width, height,
        };
    }

    /**
     * The part of that frame that is drawn, as visibleRect() gives it for
     * the frame the window has. null when no edge is dragged.
     */
    heldRect() {
        const want = this._heldFrame();
        if (!want)
            return null;
        const c = this.crop;
        return {
            x: want.x + c.left,
            y: want.y + c.top - c.bar,
            width: Math.max(1, want.width - c.left - c.right),
            height: Math.max(1, want.height - c.top - c.bottom) + c.bar,
        };
    }

    /**
     * Fill the room between the frame the window has and a larger one its
     * dragged edge asks for, see holdResize. Three clones of the window's
     * surface, each cut to one column, one row or one pixel next to the
     * edge that moves, and scaled to the size of the room: beside the
     * content, above or below it, and in the corner between the two.
     */
    _fillHeld() {
        const held = this._held;
        if (!held)
            return;
        const want = this._heldFrame();
        const actor = this.actor;
        const surface = want && actor ? surfaceOf(actor) : null;
        if (!surface) {
            for (const fill of Object.values(held.fills ?? {}))
                fill.hide();
            return;
        }
        if (!held.fills) {
            held.fills = {};
            for (const key of ['x', 'y', 'xy']) {
                const fill = new Clutter.Clone({source: surface, reactive: false, visible: false});
                actor.insert_child_above(fill, surface);
                held.fills[key] = fill;
            }
        }
        const real = this.win.get_frame_rect();
        const buffer = this.win.get_buffer_rect();
        // Both frames in the actor's own coordinates.
        const fx = real.x - buffer.x, fy = real.y - buffer.y;
        const wx = want.x - buffer.x, wy = want.y - buffer.y;
        // The part of the window's frame that is inside the one asked for.
        const x1 = Math.max(fx, wx), x2 = Math.min(fx + real.width, wx + want.width);
        const y1 = Math.max(fy, wy), y2 = Math.min(fy + real.height, wy + want.height);
        // The room on the side of the edge that moves: its start and size,
        // and the column or row of the content next to it. One px in from
        // the edge, which may hold a line the client draws around itself.
        const left = fx - wx, top = fy - wy;
        const gx = Math.max(0, left > 0 ? left : wx + want.width - fx - real.width);
        const gy = Math.max(0, top > 0 ? top : wy + want.height - fy - real.height);
        const bx = left > 0 ? wx : fx + real.width;
        const by = top > 0 ? wy : fy + real.height;
        const sx = left > 0 ? fx + FILL_INSET : fx + real.width - 1 - FILL_INSET;
        const sy = top > 0 ? fy + FILL_INSET : fy + real.height - 1 - FILL_INSET;
        const [ox, oy] = surface.get_position();
        const [sw, sh] = surface.get_size();
        const place = (fill, shown, cx, cy, cw, ch, kx, ky, x, y) => {
            if (!shown || cw <= 0 || ch <= 0) {
                fill.hide();
                return;
            }
            // A clone draws its source into its own size.
            fill.set_size(sw, sh);
            fill.set_clip(cx - ox, cy - oy, cw, ch);
            // Scaled around the corner of the part that is drawn, so its
            // place does not depend on the scale. Scaled around the
            // clone's own corner, the place is a product of about 800 px
            // and a scale of about 1000, which is exact to 1/16 px only,
            // and the wallpaper shows in lines between the fills.
            fill.set_pivot_point((cx - ox) / sw, (cy - oy) / sh);
            fill.set_scale(kx, ky);
            fill.set_position(x - (cx - ox), y - (cy - oy));
            fill.show();
        };
        // Only the middle of that column or row, a 64th of a pixel: a
        // whole pixel drawn wider is mixed with the pixels on both sides of
        // it, which gives the room a gradient.
        const thin = 1 / 64;
        const cx = sx + 0.5 - thin / 2, cy = sy + 0.5 - thin / 2;
        // Each fill reaches 1 px into the content next to it. Their edges
        // are not exactly on whole pixels, and the wallpaper would show in
        // a line where two of them meet.
        const ex = gx + 1, ey = gy + 1;
        const dx = left > 0 ? bx : bx - 1, dy = top > 0 ? by : by - 1;
        place(held.fills.x, gx > 0, cx, y1, thin, y2 - y1, ex / thin, 1, dx, y1);
        place(held.fills.y, gy > 0, x1, cy, x2 - x1, thin, 1, ey / thin, x1, dy);
        // The corner reaches FILL_INSET px in: the last rows of the fill
        // beside the content are those of the content's edge, which can
        // differ from the row the fill below it is drawn from.
        const n = FILL_INSET;
        place(held.fills.xy, gx > 0 && gy > 0, cx, cy, thin, thin,
            (gx + n) / thin, (gy + n) / thin, left > 0 ? bx : bx - n, top > 0 ? by : by - n);
    }

    /** The size the window is drawn at before unfocusedScale: [width, height]. */
    _size(frame) {
        if (this.opening && this.target)
            return [this.target.width, this.target.height];
        return this._sized ? [this.w.value, this.h.value] : [frame.width, frame.height];
    }

    /** The edges of the window that are not drawn, see crop.js. */
    get crop() {
        return cropOf(this.wm.config, this.win);
    }

    get fullscreen() {
        return this.win.is_fullscreen();
    }

    /**
     * The window has been mapped. fade: the shell does not animate it (see
     * Tiling._patchMapAnimation), so it fades in here and grows to its
     * place around the middle of it.
     *
     * The shell's own animation scales the actor from 1% around the bottom
     * middle of the buffer, and this tile writes the scale and the pivot
     * of the same actor. With both, which of the two is drawn depends on
     * which ran first. The size springs run unseen during the animation,
     * so the width jumps back when it is over, and the ring is laid out
     * for a size the window is not drawn at.
     */
    open(fade) {
        const actor = this.actor;
        if (!actor || this.dead)
            return;
        if (this.opening && !this._openId) {
            this._openId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OPEN_SIZE_MS, () => {
                this._openId = 0;
                // From the size of the place to the size the frame has by
                // now, with the spring if they differ.
                if (this.target && this._sized) {
                    this.w.set(this.target.width);
                    this.h.set(this.target.height);
                }
                this.opening = false;
                this._followSize();
                this.sync();
                return GLib.SOURCE_REMOVE;
            });
        }
        if (!fade)
            return;
        const target = this.shrink.target;
        this.shrink.set(target + OPEN_SHRINK);
        this.shrink.target = target;
        this.wm.animator.add(this);
        actor.opacity = 0;
        actor.ease({
            opacity: 255,
            duration: OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.sync();
    }

    /**
     * The current tile is drawn at the size of its place. Every other tile
     * is drawn smaller by windows.unfocusedScale, around its middle, so it
     * keeps its place and the windows next to it do not move. A window
     * that is kept at full size (setFullSize) is drawn as the current one.
     */
    setCurrent(current, animate) {
        const scale = clamp(Number(this.wm.config.values.windows.unfocusedScale) || 1, 0.5, 1);
        const full = current || this.wm.fullSize.has(this.win);
        const target = full ? 0 : (1 - scale) * 1000;
        if (this.shrink.target === target)
            return;
        if (!this.placed || !animate || !this.wm.animator.enabled) {
            this.shrink.set(target);
        } else {
            this.shrink.target = target;
            this.wm.animator.add(this);
        }
        this.sync();
    }

    /** The scale the window is drawn at now. */
    get scale() {
        return 1 - this.shrink.value / 1000;
    }

    /** Where the window is drawn now, with its scale: {x, y, width, height}. */
    drawn() {
        const [w, h] = this._size(visibleRect(this.wm.config, this.win));
        const k = this.scale;
        const width = Math.round(w * k);
        const height = Math.round(h * k);
        return {
            x: Math.round(this.x.value + this.nudge.value + (w - width) / 2) + (this.strip?.push ?? 0),
            y: Math.round(this.y.value + this.nudgeY.value + (h - height) / 2),
            width, height,
        };
    }

    /**
     * Scale the actor by kx and ky around the top left corner of frame.
     * Returns false while the shell is animating the actor's scale: a
     * window that opens, minimizes or comes back. The shell sets the scale
     * to 1 when that is over, so the tile is synced again after it.
     */
    _setScale(kx, ky, frame, buffer) {
        const actor = this.actor;
        const busy = actor.get_transition('scale-x') ?? actor.get_transition('scale-y');
        if (busy) {
            if (this._scaleWait !== busy) {
                this._scaleWait = busy;
                busy.connect('stopped', () => {
                    if (this._scaleWait === busy)
                        this._scaleWait = null;
                    if (this.dead)
                        return;
                    // After the shell's own handler for the end of its
                    // animation, which runs in this same emission and sets
                    // the actor's translation to 0, and before the frame is
                    // drawn. An idle would run after that frame, and the
                    // window would be drawn at its frame for one frame,
                    // away from its place on a strip that is still moving.
                    this._scaleId ||= global.compositor.get_laters().add(
                        Meta.LaterType.BEFORE_REDRAW, () => {
                            this._scaleId = 0;
                            this.sync();
                            return GLib.SOURCE_REMOVE;
                        });
                });
            }
            return false;
        }
        if ((kx !== 1 || ky !== 1) && buffer.width > 0 && buffer.height > 0) {
            actor.set_pivot_point(
                (frame.x - buffer.x) / buffer.width,
                (frame.y - buffer.y) / buffer.height);
        }
        if (actor.scale_x !== kx || actor.scale_y !== ky)
            actor.set_scale(kx, ky);
        return true;
    }

    /**
     * Set the place on the strip. Returns nothing; motion runs on the animator.
     *
     * A place that changes its width around the same middle is the place
     * of a column that is centred in the view, after cycle-width for
     * example. The window then stays around that middle at every width it
     * is drawn at, so it grows or shrinks to both sides at once. With its
     * left edge on a spring of its own, which starts with the key press,
     * and its width following when the client has taken the new size, 30
     * to 150 ms later, the window would move to the left first and then
     * grow to the right.
     */
    setTarget(rect, animate) {
        const old = this.target;
        const middle = rect.x + rect.width / 2;
        const animated = this.placed && animate && this.wm.animator.enabled;
        let around = false;
        if (animated && old && this._sized && !this.opening) {
            // Still around this middle from the last change, or drawn
            // around it now and given another width.
            around = this._middle !== null
                ? Math.abs(middle - this._middle) <= 1
                : rect.width !== old.width &&
                    Math.abs(middle - (old.x + old.width / 2)) <= 1 &&
                    Math.abs(middle - (this.x.value + this.w.value / 2)) <= 1;
        }
        if (!around || this._middle === null)
            this._middleX = null;
        this._middle = around ? middle : null;
        this.target = rect;
        if (!animated) {
            this.x.set(rect.x);
            this.y.set(rect.y);
            this.placed = true;
        } else {
            // Around a middle, sync() takes x from the width.
            if (!around)
                this.x.target = rect.x;
            this.y.target = rect.y;
            this.wm.animator.add(this);
        }
        this.applyFrame();
        this.sync();
    }

    /** Move the real frame to the target, kept inside the strip's work area. */
    applyFrame(force = false) {
        if (this.dead || this.grabbed || this.fullscreen || !this.target || !this.strip)
            return;
        const area = this.strip.area;
        const t = this.target;
        // Next to a fullscreen window the strip reaches into the room of
        // the sidebar (Strip._shiftFor), and the frame goes there with it:
        // the menus of the window open where its frame is. A column as
        // wide as the monitor reaches into it with no shift.
        const left = area.x - (this.strip._room ?? 0);
        const x = clamp(t.x, left, Math.max(left, area.x + area.width - t.width));
        // A window with a recorded minimum is still asked for the width its
        // column has without that minimum. A request for the recorded width
        // would replace the narrower one, and a client that had not answered
        // yet would then never take the narrower width.
        const width = this.minWidth && this.column
            ? Math.min(t.width, this.strip.widthFor(this.column, this.column.proportion, {learned: false}))
            : t.width;
        // A cropped window is asked for a frame larger than its place by the
        // edges that are not drawn. A drawn title bar takes its height from
        // the top of the place: it is taller than the edge cut there, so the
        // frame starts below the top of the place.
        const c = this.crop;
        const top = c.top - c.bar;
        const q = {
            x: x - c.left, y: t.y - top,
            width: width + c.left + c.right, height: t.height + top + c.bottom,
        };
        const r = this._request;
        if (!force && r && r.x === q.x && r.y === q.y && r.width === q.width && r.height === q.height)
            return;
        if (!force)
            this._retries = 0;
        this._request = q;
        this.win.move_resize_frame(true, q.x, q.y, q.width, q.height);
        this._queueWidthCheck();
    }

    /**
     * Once the client has had time to answer, compare its width with the
     * request. The wait matters: a frame from an earlier, wider request can
     * arrive after a narrower one was made. A client can also take longer
     * than the wait, so the recorded minimum is dropped again when the
     * window later takes the requested width.
     */
    _queueWidthCheck() {
        if (this._checkId)
            GLib.source_remove(this._checkId);
        this._checkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WIDTH_CHECK_MS, () => {
            this._checkId = 0;
            const r = this._request;
            if (this.dead || !r || this.grabbed || this.fullscreen || !this.strip)
                return GLib.SOURCE_REMOVE;
            // Not the size of its place: the client set a size of its own
            // after it took the one it was given. Firefox does when it
            // restores its last session, and would stay small in a
            // full-size place. The same frame is asked for again, three
            // times at most, so a client that cannot take the size is left
            // alone after that. The count starts again once the client has
            // taken the size (_onSizeChanged). Otherwise the fourth time a
            // window changes its own size, it would keep it.
            if (this._missized() && this._retries < 3) {
                this._retries++;
                this.applyFrame(true);
                return GLib.SOURCE_REMOVE;
            }
            // A client that had not answered when the tile arrived with
            // the sidebar is still drawn at the width of its place, see
            // Tiling.glideEnd. A frame that is as it was asked for or wider
            // by now, or was asked for three more times, is the one the
            // window keeps.
            if (this._sized && !this._glide &&
                this.w.target !== visibleRect(this.wm.config, this.win).width) {
                this._followSize();
                this.sync();
            }
            const width = this.win.get_frame_rect().width;
            const c = this.crop;
            const min = width > r.width + 1 ? width - c.left - c.right : 0;
            if (min !== this.minWidth) {
                this.minWidth = min;
                // The column takes the window's width, and its neighbours move over.
                this.strip.layout(true);
                this.wm.ring.sync();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Translate the actor from its real frame to its place on the strip. */
    sync() {
        const actor = this.actor;
        if (!actor || this.dead)
            return;
        // Entering or leaving fullscreen, the shell animates this actor's
        // translation and scale from the old frame to the new one. Writing
        // the translation here would restart that from the wrong place, and
        // the strip's clip would cut the scaled window. The actor is left
        // alone until the animation is over.
        if (actor.__animationInfo) {
            clearClip(actor);
            if (!this._sizeChangeId) {
                this._sizeChangeId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, SIZE_CHANGE_WAIT_MS, () => {
                        this._sizeChangeId = 0;
                        this.sync();
                        return GLib.SOURCE_REMOVE;
                    });
            }
            return;
        }
        const frame = visibleRect(this.wm.config, this.win);
        const buffer = this.win.get_buffer_rect();
        if (this.grabbed || this.fullscreen || !this.target) {
            this._parked = null;
            actor.translation_x = this.fullscreen ? Math.round(this.nudge.value) : 0;
            actor.translation_y = this.fullscreen ? Math.round(this.nudgeY.value) : 0;
            this._setScale(1, 1, frame, buffer);
            // A dragged edge that asks for a larger frame, see holdResize.
            this._fillHeld();
            this.w.set(frame.width);
            this.h.set(frame.height);
            clearClip(actor);
            this._syncDialogs(null);
            if (this.wm.focusTile === this)
                this.wm.ring.sync();
            return;
        }
        // The springs hold the place and the size of the part that is
        // drawn. The frame is scaled to that size, and by unfocusedScale
        // around the middle of it.
        // The sidebar shown over a fullscreen window moves the strip over
        // by the width it shows, see Strip.push.
        let [w, h] = this._size(frame);
        if (this._middle !== null)
            this._aroundMiddle(w);
        const vx = Math.round(this.x.value + this.nudge.value) + this.strip.push;
        const vy = Math.round(this.y.value + this.nudgeY.value);
        let k = this.scale;
        let kx = frame.width > 0 ? k * w / frame.width : k;
        let ky = frame.height > 0 ? k * h / frame.height : k;
        if (this._park(actor, frame, buffer, vx + w * (1 - k) / 2 - frame.x, kx, w * k)) {
            // A dialog wider than its window can still reach into the view.
            this._syncDialogs([vx + w / 2, vy + h / 2]);
            if (this.wm.focusTile === this) {
                const d = this.drawn();
                this.wm.ring.place(d.x, d.y, d.width, d.height);
            }
            return;
        }
        if (!this._setScale(kx, ky, frame, buffer)) {
            // The shell draws the window at the size of its frame. The
            // springs are put there too, so nothing is left to run when the
            // shell's animation is over, and drawn() is what is drawn.
            this.w.set(frame.width);
            this.h.set(frame.height);
            this.shrink.set(this.shrink.target);
            [w, h] = [frame.width, frame.height];
            k = kx = ky = 1;
        }
        actor.translation_x = vx + w * (1 - k) / 2 - frame.x;
        actor.translation_y = vy + h * (1 - k) / 2 - frame.y;

        // Clip to the strip's view, so a column that is partly out of view
        // does not draw on the next monitor. The buffer
        // rect is used and not the actor's own geometry, because the actor
        // is moved after the signals that lead here. The clip is in the
        // actor's own units, which are kx stage pixels each, and the scaled
        // actor starts (1 - kx) of the way from its left edge to its pivot,
        // the left edge of the frame.
        const pivot = frame.x - buffer.x;
        const left = buffer.x + actor.translation_x + pivot * (1 - kx);
        const clip = this.strip.clipFor(left, buffer.width * kx);
        setClip(actor, clip && [clip[0] / kx, clip[1] / kx],
            Math.min(0, frame.y - buffer.y), buffer.height);
        this._syncDialogs([vx + w / 2, vy + h / 2]);

        if (this.wm.focusTile === this) {
            const d = this.drawn();
            this.wm.ring.place(d.x, d.y, d.width, d.height);
        }
    }

    /**
     * Draw the dialogs attached to the window around the middle of where
     * the window is drawn. middle: [x, y] on the stage. null: the window is
     * drawn at its frame, and so are they.
     *
     * Mutter keeps an attached dialog in the middle of its parent's frame,
     * and moves it when that frame moves. The window is not drawn at its
     * frame while it is on its way to a new place, and never when part of
     * its place is out of the view: the frame stays inside the work area
     * (applyFrame) and the actor is moved from there. A file chooser of a
     * window that had been scrolled half out of the view stayed in the
     * middle of the monitor, over the window that had come in beside it.
     *
     * The dialog's actor is moved by the same distance, so it is drawn and
     * takes its clicks in the middle of the window, and it is cut at the
     * edges of the view as the window is. Rounded as Mutter rounds, so a
     * dialog of a window that is drawn at its frame is not moved at all.
     */
    _syncDialogs(middle) {
        const dialogs = this.wm.attached.get(this.win);
        if (!dialogs)
            return;
        for (const win of dialogs) {
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            if (!middle || !this.strip) {
                actor.translation_x = 0;
                actor.translation_y = 0;
                clearClip(actor);
            } else {
                const frame = win.get_frame_rect();
                const buffer = win.get_buffer_rect();
                const top = Math.min(0, frame.y - buffer.y);
                let tx = Math.floor(middle[0]) - Math.floor(frame.width / 2) - frame.x;
                const ty = Math.floor(middle[1]) - Math.floor(frame.height / 2) - frame.y;
                let clip = this.strip.clipFor(buffer.x + tx, buffer.width);
                if (clip && clip[1] <= 0) {
                    // Nothing of it is in the view: to the left of every
                    // monitor, as its window is (_park).
                    let leftmost = 0;
                    for (const m of Main.layoutManager.monitors)
                        leftmost = Math.min(leftmost, m.x);
                    tx = leftmost - PARK_GAP - buffer.width - buffer.x;
                    clip = [0, 0];
                }
                if (actor.translation_x !== tx)
                    actor.translation_x = tx;
                if (actor.translation_y !== ty)
                    actor.translation_y = ty;
                setClip(actor, clip, top, buffer.height);
            }
            if (this.wm.ring.win === win)
                this.wm.ring.sync();
        }
    }

    /**
     * A window with nothing of it in the view is put to the left of every
     * monitor and left there, until part of it is in the view again.
     * Returns whether it is. tx: the translation that would put the actor
     * at its place on the strip, kx: the scale it would have there, width:
     * of the part of the frame that is drawn there.
     *
     * A window that lib/corners.js cuts to its frame is out of the view
     * when its frame is. Any other is when its buffer is, which is larger
     * by the shadow the client draws.
     *
     * Left at its place on the strip with a clip that leaves nothing of
     * it, such a window would be moved and scaled there in every frame of
     * an animation. Its place can be on the next monitor. A clip does not
     * limit the area an actor asks to have drawn again when it has
     * children, so that monitor would be drawn again in every one of
     * those frames (measured: 220 frames in 15 changes of focus), and a
     * client there would be told to draw at that monitor's rate with
     * nothing of it to see.
     */
    _park(actor, frame, buffer, tx, kx, width) {
        const pivot = frame.x - buffer.x;
        const clip = this.wm.corners?.cuts(this.win)
            ? this.strip.clipFor(frame.x + tx, width)
            : this.strip.clipFor(buffer.x + tx + pivot * (1 - kx), buffer.width * kx);
        // Not while the shell animates the scale, see _setScale().
        if (!clip || clip[1] > 0 ||
            actor.get_transition('scale-x') || actor.get_transition('scale-y')) {
            this._parked = null;
            return false;
        }
        const key = `${buffer.x},${buffer.width}`;
        if (this._parked?.key === key && actor.translation_x === this._parked.x)
            return true;
        let leftmost = 0;
        for (const m of Main.layoutManager.monitors)
            leftmost = Math.min(leftmost, m.x);
        const x = leftmost - PARK_GAP - buffer.width - buffer.x;
        actor.translation_x = x;
        setClip(actor, [0, 0], Math.min(0, frame.y - buffer.y), buffer.height);
        this._parked = {key, x};
        return true;
    }

    /**
     * Put x where a window of width w is around the middle of its place.
     * That ends when the window has the width of its place, and when
     * something else has moved the tile since the last time (a swipe, a
     * drag, a workspace switch): it goes on from where that put it.
     */
    _aroundMiddle(w) {
        const last = this._middleX;
        if (last !== null && (this.x.value !== last || this.x.target !== last)) {
            this._middle = this._middleX = null;
            return;
        }
        if (this.w.atRest && Math.abs(w - this.target.width) <= 1) {
            this.x.set(this.target.x);
            this._middle = this._middleX = null;
            return;
        }
        this.x.set(this._middle - w / 2);
        this._middleX = this.x.value;
    }

    tick(dt, omega, zeta) {
        if (this.dead)
            return false;
        // The sidebar's animation writes the place and the width of a tile
        // that goes with it, see Tiling.glideStep.
        const glide = this._glide;
        const ownX = !glide || glide.free;
        if (ownX)
            this.x.step(dt, omega, zeta);
        this.y.step(dt, omega, zeta);
        this.shrink.step(dt, omega, zeta);
        if (!glide)
            this.w.step(dt, omega, zeta);
        this.h.step(dt, omega, zeta);
        const nudges = [this.nudge, this.nudgeY];
        if (nudges.some(n => n.target !== 0)) {
            this._nudgeLeft -= dt;
            if (this._nudgeLeft <= 0)
                nudges.forEach(n => (n.target = 0));
        }
        nudges.forEach(n => n.step(dt, omega, zeta));
        this.sync();
        return !((!ownX || this.x.atRest) && this.y.atRest && this.shrink.atRest &&
            (!!glide || this.w.atRest) && this.h.atRest &&
            nudges.every(n => n.atRest && n.target === 0));
    }

    /**
     * Draw the window towards a side for a moment, dx -1 left or 1 right,
     * dy -1 up or 1 down: it heads for a place NUDGE_PX that way on the
     * spring the places use, and for its own place again after
     * NUDGE_OUT_MS. The place it has on the strip and its frame stay as
     * they are.
     *
     * For a window that fills the view, when its column changes place on
     * the strip (Tiling._nudgeFull) and when it goes to another workspace
     * (Tiling.moveToWorkspace). A key that repeats keeps it out.
     */
    nudgeBy(dx, dy = 0) {
        const animator = this.wm.animator;
        if (this.dead || this.grabbed || !animator.enabled)
            return;
        const frame = visibleRect(this.wm.config, this.win);
        if (dx)
            this.nudge.target = dx * Math.min(NUDGE_PX, frame.width * NUDGE_SHARE);
        if (dy)
            this.nudgeY.target = dy * Math.min(NUDGE_PX, frame.height * NUDGE_SHARE);
        this._nudgeLeft = NUDGE_OUT_MS / 1000;
        animator.add(this);
    }

    /** resetActor is false when the window is closing, so it does not jump. */
    destroy(resetActor = true) {
        this.dead = true;
        this.releaseResize();
        if (this._checkId)
            GLib.source_remove(this._checkId);
        this._checkId = 0;
        if (this._sizeChangeId)
            GLib.source_remove(this._sizeChangeId);
        this._sizeChangeId = 0;
        if (this._scaleId)
            global.compositor.get_laters().remove(this._scaleId);
        this._scaleId = 0;
        if (this._openId)
            GLib.source_remove(this._openId);
        this._openId = 0;
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        this.win.disconnectObject(this);
        this.wm.animator.remove(this);
        if (resetActor)
            this._syncDialogs(null);
        if (resetActor && this.actor) {
            this.actor.translation_x = 0;
            this.actor.translation_y = 0;
            // Not while the shell animates the scale: a window being minimized.
            if (!this.actor.get_transition('scale-x') && !this.actor.get_transition('scale-y')) {
                this.actor.set_scale(1, 1);
                this.actor.set_pivot_point(0, 0);
            }
            clearClip(this.actor);
        }
    }
}

/**
 * A window that is on no strip, on its way to a place or a size a key gave
 * it. The frame is asked for at once, and the window is drawn from where it
 * was to where it goes on the springs the tiles use.
 *
 * The springs hold the middle and the size of what is drawn. The size
 * follows the frame, which changes when the client has drawn the new one,
 * 30 to 150 ms after the key. The middle starts with the key. With the left
 * edge on a spring in its place, a window that changes its width around its
 * middle would move to the left first and then grow to the right.
 */
class Floater {
    constructor(wm, win) {
        this.wm = wm;
        this.win = win;
        this.actor = win.get_compositor_private();
        const r = visibleRect(wm.config, win);
        this.cx = new Spring(r.x + r.width / 2);
        this.cy = new Spring(r.y + r.height / 2);
        this.w = new Spring(r.width);
        this.h = new Spring(r.height);
        // The place asked for last, as visibleRect() gives one. The next
        // key press starts from it, so a held key goes on from where the
        // window is going and not from where it is drawn.
        this.rect = r;
        this._pending = false;   // the client has not taken the size asked for
        this._pendingId = 0;
        win.connectObject(
            'position-changed', () => this._onFrame(),
            'size-changed', () => this._onFrame(),
            this);
    }

    /** Ask for a place: {x, y, width, height} of the part that is drawn. */
    moveTo(rect) {
        const win = this.win;
        const q = frameFor(this.wm.config, win, rect);
        const frame = win.get_frame_rect();
        const resized = q.width !== frame.width || q.height !== frame.height;
        this.rect = rect;
        this._pending = resized;
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        if (resized) {
            // A client that takes another size than the one asked for, or
            // none, keeps the frame it has.
            this._pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLOAT_ANSWER_MS, () => {
                this._pendingId = 0;
                this._settled();
                this._retarget();
                return GLib.SOURCE_REMOVE;
            });
            win.move_resize_frame(true, q.x, q.y, q.width, q.height);
        } else {
            win.move_frame(true, q.x, q.y);
            // Where Mutter put it: it keeps a title bar on the monitor.
            this.rect = visibleRect(this.wm.config, win);
        }
        this._retarget();
    }

    _onFrame() {
        const frame = visibleRect(this.wm.config, this.win);
        if (this._pending && Math.abs(frame.width - this.rect.width) <= 1 &&
            Math.abs(frame.height - this.rect.height) <= 1)
            this._settled();
        this._retarget();
    }

    /** The frame the window has now is the one it keeps. */
    _settled() {
        this._pending = false;
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        this.rect = visibleRect(this.wm.config, this.win);
    }

    _retarget() {
        if (this.dead)
            return;
        const frame = visibleRect(this.wm.config, this.win);
        // Mutter moves a window that was asked for a new size when its
        // client has answered. Until then the frame is the old one.
        const to = this._pending ? this.rect : frame;
        this.cx.target = to.x + to.width / 2;
        this.cy.target = to.y + to.height / 2;
        this.w.target = frame.width;
        this.h.target = frame.height;
        this.wm.animator.add(this);
        this.sync();
    }

    /** Where the window is drawn now: {x, y, width, height}. */
    drawn() {
        return {
            x: Math.round(this.cx.value - this.w.value / 2),
            y: Math.round(this.cy.value - this.h.value / 2),
            width: Math.round(this.w.value),
            height: Math.round(this.h.value),
        };
    }

    /** Scale and translate the actor from its real frame to where it is drawn. */
    sync() {
        const actor = this.actor;
        if (!actor || this.dead)
            return;
        // The shell animates this actor: a window that is minimized, or one
        // that enters fullscreen. It is left to the shell.
        if (actor.__animationInfo || actor.get_transition('scale-x') ||
            actor.get_transition('scale-y')) {
            this.stop();
            return;
        }
        const frame = visibleRect(this.wm.config, this.win);
        const buffer = this.win.get_buffer_rect();
        const d = this.drawn();
        const kx = frame.width > 0 ? this.w.value / frame.width : 1;
        const ky = frame.height > 0 ? this.h.value / frame.height : 1;
        if ((kx !== 1 || ky !== 1) && buffer.width > 0 && buffer.height > 0) {
            actor.set_pivot_point(
                (frame.x - buffer.x) / buffer.width,
                (frame.y - buffer.y) / buffer.height);
        }
        if (actor.scale_x !== kx || actor.scale_y !== ky)
            actor.set_scale(kx, ky);
        actor.translation_x = d.x - frame.x;
        actor.translation_y = d.y - frame.y;
        if (this.wm.ring.win === this.win)
            this.wm.ring.place(d.x, d.y, d.width, d.height);
    }

    tick(dt, omega, zeta) {
        if (this.dead)
            return false;
        const springs = [this.cx, this.cy, this.w, this.h];
        for (const spring of springs)
            spring.step(dt, omega, zeta);
        if (!this._pending && springs.every(s => s.atRest)) {
            this.stop();
            return false;
        }
        this.sync();
        return !this.dead;
    }

    /**
     * The window is drawn at its frame again. resetActor is false when the
     * window is closing, so it does not jump.
     */
    stop(resetActor = true) {
        if (this.dead)
            return;
        this.dead = true;
        if (this._pendingId)
            GLib.source_remove(this._pendingId);
        this._pendingId = 0;
        this.win.disconnectObject(this);
        this.wm.animator.remove(this);
        this.wm.floaters.delete(this.win);
        const actor = this.actor;
        if (!resetActor || !actor)
            return;
        actor.translation_x = 0;
        actor.translation_y = 0;
        if (!actor.get_transition('scale-x') && !actor.get_transition('scale-y')) {
            actor.set_scale(1, 1);
            actor.set_pivot_point(0, 0);
        }
        if (this.wm.ring.win === this.win)
            this.wm.ring.sync();
    }
}

class Column {
    constructor(proportion) {
        this.tiles = [];
        this.proportion = proportion;
        this.restore = null;     // proportion before maximize-column
        // On a strip that does not scroll (Strip.fits): the width was set
        // by hand, so the column has that share of the view, and the
        // columns that are not pinned share what is left. shared is the
        // proportion it had before it was pinned.
        this.pinned = false;
        this.shared = null;
        this.active = null;      // last focused tile in this column
        this.x = 0;              // strip coordinate
        this.width = 0;
        // The column of a new window that may still turn out to float
        // (Tiling._mayFloatLate). It has its place and its width, but the
        // columns after it stay where they are and the view does not scroll
        // to it, so a window that leaves again has moved nothing. Otherwise
        // the columns to the right of a new 1Password window would start
        // to move over, and come back when its title arrives and matches
        // the float rule.
        this.pending = false;
    }
}

class Strip {
    constructor(wm, monitor, workspace) {
        this.wm = wm;
        this.monitor = monitor;
        this.workspace = workspace;   // null: the single strip of a secondary monitor
        this.columns = [];
        this.scroll = 0;
        this.focus = null;
        this.freeScroll = false;      // the view was placed by a key or for a new window: it does not follow the focus
        this._swipe = null;
        this._settle = null;          // what waits for a swipe over a fullscreen window to end
        this._room = 0;               // see room, as of the last _measure()
        this._shift = 0;              // see _shiftFor, as of the last layout()
        this._room = 0;               // see room, as of the last _measure()
        this._coverAt = -1;           // index of the fullscreen window's column, see _coverSide
        this.left = false;            // its workspace was left since it was last at rest, see unpeek()
        this.usedAt = 0;              // the latest time one of its windows was used, when it was left
        this._coverLast = null;       // the last swipe over a fullscreen window that counted, see _coverAgain
    }

    /**
     * The work area of the monitor. The sidebar gives up its strut while a
     * fullscreen window hides the cards (Sidebar._placeStrut), and the
     * work area then starts at the edge of the monitor. The strip keeps
     * the area it has with the strut, so no window changes its place or
     * its size when a window enters or leaves fullscreen.
     */
    get area() {
        const ws = this.workspace ?? global.workspace_manager.get_active_workspace();
        const area = ws.get_work_area_for_monitor(this.monitor);
        const room = this.wm.peekSink?.room(this.monitor) ?? 0;
        const left = this.monitorRect.x + room;
        if (room <= 0 || area.x >= left)
            return area;
        return {
            x: left, y: area.y,
            width: Math.max(0, area.x + area.width - left), height: area.height,
        };
    }

    get monitorRect() {
        return global.display.get_monitor_geometry(this.monitor);
    }

    get gap() {
        return this.wm.config.values.layout.gap *
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    get viewWidth() {
        return this.area.width - 2 * this.gap;
    }

    /**
     * px of the left side of the monitor that the work area leaves for the
     * sidebar, on a strip with a fullscreen window. The cards are out of
     * view there. 0 on any other strip.
     */
    get room() {
        const peek = this.wm.peekSink;
        if (!peek || !this.tiles.some(t => t.fullscreen))
            return 0;
        return clamp(peek.room(this.monitor), 0, this.area.x - this.monitorRect.x);
    }

    /**
     * px the strip is drawn to the left of its place in the work area, with
     * col in focus at a scroll. Next to a fullscreen window the strip moves
     * into the room of the sidebar, so the first column in view is one gap
     * from the edge of the monitor. It moves no further than the room col
     * has on its right in the view: a column at the right edge of the view
     * stays there. With centerFocusedColumn "always" the strip moves half
     * of the way, to the middle of the monitor.
     *
     * With that room kept free, a window that comes in from the left over
     * a fullscreen window would stop the width of the sidebar away from
     * the edge.
     */
    _shiftFor(col, scroll, viewW) {
        const room = this._room;
        // Nothing shows over a fullscreen window that has focus. The other
        // tiles keep their places under it, so they do not move when a
        // window enters or leaves fullscreen.
        if (!room || !col || col.pending || col.tiles.some(t => t.fullscreen))
            return 0;
        // Against the left edge of the monitor, or the right edge of the
        // view, see _coverSide. This comes before the centred strip.
        const side = this._coverSide(col);
        if (side)
            return side < 0 ? room : 0;
        if (this.wm.config.values.layout.centerFocusedColumn === 'always' ||
            this._centredScroll(viewW) !== null)
            return Math.round(room / 2);
        return Math.round(clamp(viewW - (col.x + col.width - scroll), 0, room));
    }

    /**
     * The side of the fullscreen window col is on: -1 left, 1 right. 0
     * with no fullscreen window on the monitor, for its own column, and
     * where the view is centred on the column in focus.
     *
     * A window over a fullscreen one lies against the edge of the monitor
     * it came in from, one gap away, at any width: the left edge for a
     * column on the left of the fullscreen window, the right edge for one
     * on the right. The strip is not kept inside its ends for that, since
     * nothing of it shows but the windows over the fullscreen one.
     *
     * Scrolling the least distance that shows the column, inside the ends
     * of the strip, would leave a window that is made narrower at the
     * right edge away from it by the width it lost, in the middle of the
     * fullscreen window.
     *
     * A strip narrower than the view (centerColumns, centerSingleColumn)
     * is not centred here either. The fullscreen window's column counts
     * in that width, so one window over it would stand at
     * (viewW - totalWidth) / 2 from the edge, and a second one would make
     * the strip wider than the view and put both against the edge.
     */
    _coverSide(col) {
        if (this._coverAt < 0 || !col || col.pending ||
            this.wm.config.values.layout.centerFocusedColumn === 'always')
            return 0;
        const at = this.columns.indexOf(col);
        return at < 0 ? 0 : Math.sign(at - this._coverAt);
    }

    /** The scroll that puts col against its edge, see _coverSide. null with no side. */
    _coverScroll(col, viewW) {
        const side = this._coverSide(col);
        if (!side)
            return null;
        return Math.round(side > 0 ? col.x + col.width - viewW : col.x);
    }

    /** The scroll the strip has once col has the focus, coming from base. */
    _scrollTo(col, viewW, base) {
        const [lo, hi] = this._scrollRange(viewW);
        return this._coverScroll(col, viewW) ?? clamp(this._scrollFor(col, viewW, base), lo, hi);
    }

    /**
     * The proportion of the widest column. 1 is the width of the view.
     * Over a fullscreen window it is the width of the monitor less a gap
     * on each side: the cards are out of view there, so maximize-column
     * fills the monitor. The column is as wide as the view again when the
     * window leaves fullscreen.
     */
    get fullProportion() {
        const {viewW} = this._measure();
        return this._coverAt >= 0 && this._room > 0
            ? Math.max(1, this.proportionFor(viewW + this._room)) : 1;
    }

    /**
     * px of that shift the cards take back while they are shown over the
     * fullscreen window. The tiles are drawn that far to the right of
     * their places, so they move over as the cards reach them and return
     * with them.
     */
    get push() {
        if (!this._shift)
            return 0;
        const shown = this.wm.peekSink?.amount() ?? 0;
        return clamp(shown - (this._room - this._shift), 0, this._shift);
    }

    /**
     * A secondary monitor does not scroll: its columns share the width of
     * the view, each in the ratio of its proportion, so every window on it
     * is in view. layout.scrollSecondary gives it a scrolling strip instead.
     */
    get fits() {
        return this.workspace === null && !this.wm.config.values.layout.scrollSecondary;
    }

    get tiles() {
        return this.columns.flatMap(c => c.tiles);
    }

    get totalWidth() {
        const last = this.columns.findLast(c => !c.pending);
        return last ? last.x + last.width : 0;
    }

    get maxScroll() {
        return Math.max(0, this.totalWidth - this.viewWidth);
    }

    /** Add a tile as a new column at index (default: right of the focus). */
    addColumn(tile, index = null, proportion = null) {
        const col = new Column(proportion ?? this.wm.config.values.layout.defaultWidth);
        col.tiles.push(tile);
        col.active = tile;
        if (index === null) {
            const focusIdx = this.focus ? this.columns.indexOf(this.focus.column) : -1;
            index = focusIdx >= 0 ? focusIdx + 1 : this.columns.length;
        }
        this.columns.splice(clamp(index, 0, this.columns.length), 0, col);
        tile.strip = this;
        tile.column = col;
        return col;
    }

    /**
     * The place a tile takes as a column of its own at index, once that
     * column has the focus and the view has followed it: {x, y, width,
     * height} on the stage. The index counts the columns without the
     * tile's own column when the tile is alone in it, as addColumn() does
     * after the tile is taken out. The strip is left as it was.
     *
     * places, if given, is a Map that takes the x the other tiles have
     * then, for those that are somewhere else now. None on a strip that
     * does not scroll: there the other columns change their widths.
     */
    placeAsColumn(tile, index, proportion = null, places = null) {
        const columns = this.columns;
        const own = tile.strip === this ? tile.column : null;
        const col = new Column(proportion ?? this.wm.config.values.layout.defaultWidth);
        col.tiles.push(tile);
        const next = columns.filter(c => c !== own || c.tiles.length > 1);
        next.splice(clamp(index, 0, next.length), 0, col);
        try {
            this.columns = next;
            const {area, gap, viewW} = this._measure();
            const scroll = Math.round(this._scrollTo(col, viewW, this.scroll));
            const shift = this._shiftFor(col, scroll, viewW);
            const left = area.x - shift + gap - scroll;
            if (places && !this.fits) {
                for (const c of next) {
                    for (const t of c.tiles) {
                        if (t !== tile && t.target && !t.fullscreen && t.target.x !== left + c.x)
                            places.set(t, left + c.x);
                    }
                }
            }
            return {
                x: left + col.x,
                y: area.y + gap,
                width: col.width,
                height: Math.max(40, area.height - 2 * gap),
            };
        } finally {
            // The widths and places of the columns as they are.
            this.columns = columns;
            this._measure();
        }
    }

    /** Add a tile to an existing column at row. */
    addToColumn(tile, col, row = null) {
        col.tiles.splice(row ?? col.tiles.length, 0, tile);
        tile.strip = this;
        tile.column = col;
        tile.weight = 1;
    }

    /**
     * Where a tile is on this strip, for restore(): the index of its
     * column, the tiles above and below it, and the tiles of the columns
     * on either side.
     */
    placeOf(tile) {
        const col = tile.column;
        const index = this.columns.indexOf(col);
        const row = col.tiles.indexOf(tile);
        return {
            index,
            weight: tile.weight,
            above: col.tiles[row - 1] ?? null,
            below: col.tiles[row + 1] ?? null,
            before: [...this.columns[index - 1]?.tiles ?? []],
            after: [...this.columns[index + 1]?.tiles ?? []],
        };
    }

    /**
     * Put a tile that is on no strip where placeOf() found it. The strip
     * may have changed since: the tile goes under the one that was above
     * it or over the one that was below it, if either is still here. Else
     * it is a column of its own, right of a tile that was in the column
     * before it, or left of one that was in the column after it, or at
     * the index it had.
     */
    restore(tile, place, proportion = null) {
        const here = t => t?.strip === this && t.column !== null;
        const mate = [place.above, place.below].find(here);
        if (mate) {
            const col = mate.column;
            const row = col.tiles.indexOf(mate);
            this.addToColumn(tile, col, mate === place.above ? row + 1 : row);
            tile.weight = place.weight;
            return;
        }
        const before = place.before.find(here);
        const after = place.after.find(here);
        let index = place.index;
        if (before)
            index = this.columns.indexOf(before.column) + 1;
        else if (after)
            index = this.columns.indexOf(after.column);
        this.addColumn(tile, index, proportion);
    }

    remove(tile) {
        const col = tile.column;
        if (!col)
            return;
        const row = col.tiles.indexOf(tile);
        if (row >= 0)
            col.tiles.splice(row, 1);
        if (col.active === tile)
            col.active = col.tiles[Math.min(row, col.tiles.length - 1)] ?? null;
        if (col.tiles.length === 0)
            this.columns.splice(this.columns.indexOf(col), 1);
        if (this.focus === tile)
            this.focus = null;
        tile.column = null;
        tile.strip = null;
    }

    /** The tile focus should go to when this one goes away. */
    successor(tile) {
        const col = tile.column;
        const row = col.tiles.indexOf(tile);
        if (col.tiles.length > 1)
            return col.tiles[row > 0 ? row - 1 : 1];
        const idx = this.columns.indexOf(col);
        const next = this.columns[idx - 1] ?? this.columns[idx + 1];
        return next ? next.active ?? next.tiles[0] : null;
    }

    /**
     * Horizontal clip, in the actor's own coordinates, for something drawn at
     * stage x with the given width. null when it is entirely inside the view.
     */
    clipFor(x, width) {
        const [left, right] = this._view ?? [-Infinity, Infinity];
        const l = Math.max(x, left);
        const r = Math.min(x + width, right);
        if (l <= x && r >= x + width)
            return null;
        return [l - x, Math.max(0, r - l)];
    }

    _measure() {
        const area = this.area;
        const gap = this.gap;
        // The view is the whole monitor, so a window that scrolls off to the
        // left runs on behind the sidebar cards and is cut off only at the
        // edge of the monitor. On the primary monitor that part of the
        // window is darkened (lib/edgefade.js), and with theme.liveBlur the
        // cards blur it (lib/glass.js). The cards are chrome
        // and are drawn above the windows. A cut at the work area would
        // end the window in a vertical line next to the sidebar.
        const mon = this.monitorRect;
        this._view = [mon.x, mon.x + mon.width];
        this._room = this.room;
        const cover = this.fits ? null : this.cover;
        this._coverAt = cover ? this.columns.indexOf(cover.column) : -1;
        const viewW = Math.max(MIN_COLUMN_WIDTH, area.width - 2 * gap);
        let x = 0;
        const last = this.columns.findLastIndex(c => !c.pending);
        const filled = this.fits && this.columns.some(c => !c.pending && !c.pinned);
        this.columns.forEach((col, i) => {
            col.width = this.widthFor(col, col.proportion, {area, gap});
            // The last column of a strip that fits takes what rounding
            // left. Not when every column is pinned: those can be narrower
            // than the view together.
            if (filled && i === last)
                col.width = Math.max(col.width, viewW - x);
            col.x = x;
            // A pending column takes no room yet.
            if (!col.pending)
                x += col.width + gap;
        });
        return {area, gap, viewW};
    }

    /**
     * Width a column gets at a proportion: that share of the view, but not
     * narrower than its windows go (declared minimum sizes and widths the
     * clients refused to go under) and not wider than the view.
     */
    widthFor(col, proportion,
        {area = this.area, gap = this.gap, learned = true, pinned = col.pinned} = {}) {
        const viewW = Math.max(MIN_COLUMN_WIDTH, area.width - 2 * gap);
        if (this.fits)
            return this._fitWidth(col, proportion, {area, gap, viewW, learned, pinned});
        const min = this._leastWidth(col, learned);
        const width = p => Math.round((area.width - gap) * p - gap);
        let want = width(proportion);
        // Wider than the view over a fullscreen window, see fullProportion.
        const cap = viewW + (this._coverAt >= 0 ? this._room : 0);
        // A column as wide as the view is as wide as the monitor there. It
        // was made full width with no fullscreen window on the strip, and
        // at the width of the view it would leave the room of the sidebar
        // empty beside it, with the cards out of view.
        if (cap > viewW && viewW - want <= FULL_SLACK * viewW)
            want = cap;
        let least = Math.min(min, viewW);
        if (want < least) {
            // The window does not go as narrow as asked. Its minimum is
            // the width of no preset, and next to one of them the
            // difference is too small to be a width of its own: the column
            // takes the preset's. At its minimum, Spotify (800 px) on a
            // view where 2/3 is 827 px would go from 827 to 800 and back
            // with cycle-width, and be 27 px short of the column grid at
            // 1/3 and 1/2.
            const near = this.wm.config.values.layout.presetWidths
                .map(width)
                .filter(w => w >= least && w <= cap && w - least <= viewW * MIN_SNAP_SHARE);
            if (near.length > 0)
                least = Math.min(...near);
        }
        return clamp(want, least, cap);
    }

    /**
     * The narrowest a column goes: the widest of the minimum sizes its
     * windows declare, and of the widths they kept when asked for less
     * (learned: false leaves those out).
     */
    _leastWidth(col, learned = true) {
        return Math.max(MIN_COLUMN_WIDTH,
            ...col.tiles.map(t => Math.max(minSize(t.win)[0], learned ? t.minWidth : 0)));
    }

    /**
     * widthFor() on a strip that does not scroll. The columns share the
     * view, and none is narrower than its windows go, so no window lies
     * over the one next to it.
     *
     * A pinned column has the width its proportion gives on a scrolling
     * strip, as far as the others allow: together the pinned columns leave
     * every other column its least width. The columns that are not pinned
     * share what is left in the ratio of their proportions.
     */
    _fitWidth(col, proportion, {area, gap, viewW, learned, pinned}) {
        // A pending column has the width it gets once it counts. The
        // others share the view without it.
        const sharing = this.columns.filter(c => c === col || !c.pending);
        const shared = viewW - (sharing.length - 1) * gap;
        const share = c => c === col ? proportion : c.proportion;
        const isPinned = c => c === col ? pinned : c.pinned;
        const sum = (cols, f) => cols.reduce((total, c) => total + f(c), 0);
        // On a view too narrow for all of them, each has its part of it.
        const leasts = new Map(sharing.map(c => [c, this._leastWidth(c, c !== col || learned)]));
        const fit = Math.min(1, shared / sum(sharing, c => leasts.get(c)));
        const least = c => Math.max(1, Math.floor(leasts.get(c) * fit));
        const want = c => Math.max(least(c), Math.round((area.width - gap) * share(c) - gap));

        const fixed = sharing.filter(isPinned);
        const free = sharing.filter(c => !isPinned(c));
        const room = shared - sum(free, least);
        const wanted = sum(fixed, want);
        const base = sum(fixed, least);
        // Pinned columns that want more than there is give up the same
        // part of what each has over its least width.
        const part = wanted > room ? Math.max(0, room - base) / (wanted - base) : 1;
        const fixedWidth = c => Math.floor(least(c) + (want(c) - least(c)) * part);
        if (pinned)
            return fixedWidth(col);

        // A column whose share is under its least width has that width,
        // and the others share what is then left.
        let rest = shared - sum(fixed, fixedWidth);
        let open = free;
        for (;;) {
            const each = rest / sum(open, share);
            const short = open.filter(c => each * share(c) < least(c));
            if (short.length === 0)
                return Math.max(1, Math.floor(each * proportion));
            if (short.includes(col))
                return least(col);
            rest -= sum(short, least);
            open = open.filter(c => !short.includes(c));
        }
    }

    /** The proportion that gives a column this width. */
    proportionFor(width) {
        const area = this.area;
        const gap = this.gap;
        return (width + gap) / Math.max(1, area.width - gap);
    }

    /** Make col the column the view follows, and scroll to show it. */
    ensureVisible(col) {
        if (!col || col.pending || !this.columns.includes(col))
            return;
        // A swipe holds the view. It settles it when the fingers lift.
        if (this._swipe && !this._swipe.cover)
            return;
        this.freeScroll = false;
        const {viewW} = this._measure();
        this._follow(col, viewW);
    }

    /**
     * How col lies in the view: 'left' with its left edge at the left edge
     * of the view, 'right' with its right edge at the right edge, 'middle'
     * in the middle of the view. null for any other place, for a column as
     * wide as the view, which is all three, and on a strip that does not
     * scroll.
     */
    anchorOf(col) {
        if (!col || col.pending || !this.columns.includes(col))
            return null;
        const {viewW} = this._measure();
        if (this.fits || this._centredScroll(viewW) !== null)
            return null;
        const scroll = this._resolveScroll(viewW);
        const near = (a, b) => Math.abs(a - b) <= 1;
        const left = near(col.x, scroll);
        const right = near(col.x + col.width, scroll + viewW);
        if (left && right)
            return null;
        if (left || right)
            return left ? 'left' : 'right';
        return near(col.x + col.width / 2, scroll + viewW / 2) ? 'middle' : null;
    }

    /**
     * Whether col is as wide as the view of a strip that scrolls, within
     * FULL_SLACK. anchorOf() has no place for such a column: it is at the
     * left edge, at the right edge and in the middle at once.
     */
    fillsView(col) {
        if (this.fits || !col || col.pending || !this.columns.includes(col))
            return false;
        const {viewW} = this._measure();
        return viewW - col.width <= FULL_SLACK * viewW;
    }

    /**
     * Scroll so that col lies in the view as anchorOf() found it, with the
     * width it has now, or as near to that as the ends of the strip allow.
     *
     * The view is never past an end of the strip: columns that are as wide
     * as the view together leave no empty space beside them. That holds
     * for a view that was placed by hand too (center-column, or a column
     * made narrower after it was as wide as the view). Otherwise the last
     * column, made full width and narrower again with maximize-column,
     * would stand in the middle with nothing on its right.
     */
    keepAnchor(col, anchor) {
        if (!anchor || !this.columns.includes(col))
            return;
        const {viewW} = this._measure();
        const scroll = {
            left: col.x,
            right: col.x + col.width - viewW,
            middle: col.x - (viewW - col.width) / 2,
        }[anchor];
        const [lo, hi] = this._scrollRange(viewW);
        this.scroll = clamp(scroll, lo, hi);
    }

    /**
     * Put col at a place in the view and leave the view there: 'middle',
     * 'left' or 'right', as near to it as the ends of the strip allow. The
     * view does not follow the focus until the focus goes to another
     * column. Columns that are narrower than the view together stay where
     * they are, with the same room on both sides (centerColumns).
     */
    place(col, anchor) {
        if (!col || col.pending || !this.columns.includes(col))
            return;
        // A swipe holds the view. It settles it when the fingers lift.
        if (this._swipe && !this._swipe.cover)
            return;
        this.freeScroll = true;
        this.keepAnchor(col, anchor);
    }

    /** Scroll the least distance that shows col completely. */
    _follow(col, viewW) {
        this.scroll = this._scrollFor(col, viewW, this.scroll);
    }

    /** The scroll nearest to `scroll` that shows col completely. */
    _scrollFor(col, viewW, scroll) {
        if (this.fits)
            return 0;
        if (this.wm.config.values.layout.centerFocusedColumn === 'always')
            return col.x - (viewW - col.width) / 2;
        if (col.x < scroll)
            return col.x;
        if (col.x + col.width > scroll + viewW)
            return col.x + col.width - viewW;
        return scroll;
    }

    /**
     * The scroll that puts the columns in the middle of the view, when they
     * are narrower than the view together and the configuration centres
     * them: centerSingleColumn for one column, centerColumns for more. null
     * otherwise.
     */
    _centredScroll(viewW) {
        const {centerSingleColumn, centerColumns} = this.wm.config.values.layout;
        const n = this.columns.filter(c => !c.pending).length;
        const total = this.totalWidth;
        if (n === 0 || total >= viewW || !(n === 1 ? centerSingleColumn : centerColumns))
            return null;
        return Math.round(-(viewW - total) / 2);
    }

    /** Scroll value for the current state, after clamping and centring. */
    _resolveScroll(viewW) {
        const {centerFocusedColumn} = this.wm.config.values.layout;
        // Over a fullscreen window the column in focus is against its
        // edge, whatever the scroll kept here is, and on a strip that is
        // centred otherwise.
        const anchored = this._coverScroll(this.focus?.column, viewW);
        if (anchored !== null)
            return anchored;
        const centred = this._centredScroll(viewW);
        if (centred !== null)
            return centred;
        if (this.fits)
            return 0;
        if (centerFocusedColumn === 'always')
            return Math.round(this.scroll);
        // Inside the ends of the strip, also for a view that was placed by
        // a key (freeScroll): see keepAnchor.
        this.scroll = clamp(this.scroll, 0, this.maxScroll);
        return Math.round(this.scroll);
    }

    layout(animate = true) {
        const {area, gap, viewW} = this._measure();
        // Widths may have changed (resize, sidebar toggle): keep the focused
        // column in view unless the view was placed by hand.
        if (!this.freeScroll && !this._swipe && this.focus?.column && !this.focus.column.pending)
            this._follow(this.focus.column, viewW);
        const scroll = this._resolveScroll(viewW);
        const pushed = this.push;
        const shift = this._shift = this._shiftFor(this.focus?.column, scroll, viewW);
        // The shift changed while the cards were shown over the fullscreen
        // window, which left fullscreen for example: the tiles go on from
        // where they were drawn.
        const carry = pushed - this.push;
        if (carry) {
            for (const tile of this.tiles)
                tile.x.value += carry;
        }
        for (const col of this.columns) {
            const n = col.tiles.length;
            const avail = area.height - 2 * gap - (n - 1) * gap;
            const total = col.tiles.reduce((s, t) => s + t.weight, 0);
            let y = area.y + gap;
            let used = 0;
            col.tiles.forEach((tile, i) => {
                const h = i === n - 1
                    ? avail - used
                    : Math.round(avail * tile.weight / total);
                used += h;
                const rect = {
                    x: area.x - shift + gap + col.x - scroll,
                    y,
                    width: col.width,
                    height: Math.max(40, h),
                };
                y += h + gap;
                tile.setCurrent(tile === this.wm.currentTile, animate);
                if (!tile.fullscreen)
                    tile.setTarget(rect, animate);
            });
        }
        // The fingers hold the picture, whatever asked for this layout.
        if (this._swipe && !this._swipe.cover)
            this._swipePlace(this._swipe);
    }

    // ---- touchpad swipe ----
    // The picture follows the fingers. On release the view coasts with the
    // release velocity and settles with a column at the left edge, at the
    // right edge or in the middle of the view, and focus goes to the column
    // in view there that is next to the one that had it.

    /** Lowest and highest scroll the view can rest at. */
    _scrollRange(viewW) {
        const {centerFocusedColumn} = this.wm.config.values.layout;
        if (this.columns.length === 0)
            return [0, 0];
        const middle = this._centredScroll(viewW);
        if (middle !== null)
            return [middle, middle];
        if (this.fits)
            return [0, 0];
        const centred = col => col.x - (viewW - col.width) / 2;
        if (centerFocusedColumn === 'always')
            return [centred(this.columns[0]), centred(this.columns.at(-1))];
        return [0, this.maxScroll];
    }

    /** Scroll positions the view can settle on, each with the column it shows. */
    _snapPoints(viewW) {
        const [lo, hi] = this._scrollRange(viewW);
        const always = this.wm.config.values.layout.centerFocusedColumn === 'always';
        const points = [];
        for (const col of this.columns) {
            const middle = col.x - (viewW - col.width) / 2;
            if (always) {
                points.push({scroll: clamp(middle, lo, hi), col});
                continue;
            }
            // The column flush with the left edge of the view, or with the right.
            for (const scroll of [col.x, col.x + col.width - viewW])
                points.push({scroll: clamp(scroll, lo, hi), col});
            // The column in the middle of the view, with a part of each
            // neighbour beside it. Not for a column near an end of the
            // strip: the view cannot scroll far enough to centre it.
            if (middle > lo + 0.5 && middle < hi - 0.5)
                points.push({scroll: middle, col});
        }
        return points;
    }

    /**
     * The column that takes focus when a swipe has settled the view on
     * point, coming from the column `from`. Several columns are whole in
     * the view there. Focus goes to the nearest of them past `from` in the
     * direction the view moved, so a swipe from the first of three columns
     * goes to the second and not to the third, which came into view with
     * it. With centerFocusedColumn "always" the view settles on one column
     * and that one takes focus.
     */
    _swipeFocus(point, from, dir, viewW) {
        if (this.wm.config.values.layout.centerFocusedColumn === 'always')
            return point.col;
        const at = this.columns.indexOf(from);
        const inView = this.columns.filter(col =>
            col.x >= point.scroll - 0.5 && col.x + col.width <= point.scroll + viewW + 0.5);
        if (at < 0 || inView.length === 0)
            return point.col;
        if (dir > 0)
            return inView.find(col => this.columns.indexOf(col) > at) ?? inView.at(-1);
        return inView.findLast(col => this.columns.indexOf(col) < at) ?? inView[0];
    }

    swipeBegin() {
        const {viewW} = this._measure();
        const base = this._resolveScroll(viewW);
        const cover = this.cover;
        // A window that the last swipe sent on its way over the fullscreen
        // one goes on until this swipe has a direction, see _coverUpdate.
        // Anything else that still settles ends now.
        const flying = !!cover && !!this._settle?.flight;
        if (!flying)
            this._settle?.finish();
        if (cover) {
            // Something is about to be drawn over the fullscreen window, so
            // the compositor may not hand that window to the display alone.
            global.compositor.disable_unredirect();
            this._swipe = {
                cover, base, viewW, travel: 0, net: 0, history: [], plan: null,
                flying, caught: null,
            };
            return;
        }
        // Start from where the picture is, so a swipe that begins while the
        // previous one is still settling does not jump.
        const lead = this.tiles.find(t => t.target && !t.fullscreen);
        const pos = base + (lead ? lead.target.x - lead.x.value : 0);
        // from: the column that has focus now. step: -1 or 1 once focus has
        // gone to the column before or after it, see _swipeStep.
        this._swipe = {
            base, viewW, raw: pos, pos, history: [],
            from: this.focus?.column ?? null, step: 0,
        };
        for (const tile of this.tiles)
            this.wm.animator.remove(tile);
    }

    /** Draw the strip where the fingers have it. */
    _swipePlace(s) {
        const offset = s.pos - s.base;
        for (const tile of this.tiles) {
            if (!tile.target || tile.fullscreen)
                continue;
            // The spring rests there, so a tile that animates its scale
            // during the swipe does not also pull its place back.
            tile.x.set(tile.target.x - offset);
            tile.sync();
        }
    }

    /**
     * The column next to the one the swipe began on, in direction dir, if
     * it was whole in the view where the swipe began. null otherwise.
     */
    _swipeNeighbour(s, dir) {
        const at = this.columns.indexOf(s.from);
        const col = at >= 0 && dir !== 0 ? this.columns[at + dir] ?? null : null;
        if (!col || col.pending)
            return null;
        const whole = col.x >= s.base - 0.5 && col.x + col.width <= s.base + s.viewW + 0.5;
        return whole ? col : null;
    }

    /**
     * Move focus while the fingers are down. A neighbour that is whole in
     * the view needs no scrolling to be seen, so a swipe towards it can
     * only ask for focus. It takes focus once the fingers have travelled
     * SWIPE_STEP_SHARE of the view, and gives it back when they return to
     * within half of that.
     *
     * With focus moved only when the fingers lift, two narrow columns side
     * by side would show it late: the view has nowhere to settle but where
     * it was, so the picture would follow the fingers and go back, and the
     * ring would change windows only after that.
     */
    _swipeStep(s) {
        const travel = s.raw - s.base;
        const dir = Math.sign(travel);
        const reach = Math.abs(travel);
        const limit = s.viewW * SWIPE_STEP_SHARE;
        let step = s.step;
        if (step !== 0 && (step !== dir || reach < limit / 2))
            step = 0;
        if (step === 0 && reach > limit && this._swipeNeighbour(s, dir))
            step = dir;
        if (step === s.step)
            return;
        s.step = step;
        const col = step ? this._swipeNeighbour(s, step) : s.from;
        const tile = col?.active ?? col?.tiles[0] ?? null;
        if (!tile || !this.columns.includes(col))
            return;
        this.focus = tile;
        col.active = tile;
        if (this.wm.isActiveStrip(this) && !tile.win.has_focus())
            tile.win.activate(global.get_current_time());
    }

    swipeUpdate(delta, timeMs) {
        const s = this._swipe;
        if (!s)
            return;
        if (s.cover) {
            this._coverUpdate(s, delta, timeMs);
            return;
        }
        s.raw += delta;
        const [lo, hi] = this._scrollRange(s.viewW);
        const size = s.viewW / 2;
        if (s.raw < lo)
            s.pos = lo - rubberBand(lo - s.raw, size);
        else if (s.raw > hi)
            s.pos = hi + rubberBand(s.raw - hi, size);
        else
            s.pos = s.raw;
        s.history.push({time: timeMs, raw: s.raw});
        while (s.history.length > 2 && timeMs - s.history[0].time > SWIPE_VELOCITY_MS)
            s.history.shift();
        this._swipeStep(s);
        this._swipePlace(s);
        this._swipeBetween(s);
    }

    /**
     * Tell where the swipe has the strip, for the minimap: between the
     * window that had the focus when it began and the one of the column
     * after or before it, see Tiling.between.
     *
     * A neighbour that is whole in the view takes the focus once the
     * fingers have travelled SWIPE_STEP_SHARE of the view (_swipeStep),
     * and the share is the part of that travel done. Any other neighbour
     * has to scroll into the view, and the share is the part of that
     * scrolling done. From there it goes on to the column after it the
     * same way. At an end of the strip the view scrolls no further, and
     * neither does the share: a column that scrolling cannot bring in is
     * not one the swipe goes to.
     *
     * By the travel of the fingers alone, a long swipe on a strip that can
     * scroll by one column would count two columns, and come back to the
     * first when the fingers lift (measured: the fill went to the third
     * icon and returned to the second).
     */
    _swipeBetween(s) {
        const win = col => (col?.active ?? col?.tiles[0])?.win ?? null;
        const tell = (from, to, share) => {
            const a = win(from);
            const b = win(to);
            this.wm.setBetween('windows', a && b ? [a, b, share] : null);
        };
        let at = this.columns.indexOf(s.from);
        if (at < 0 || !this.wm.isActiveStrip(this)) {
            this.wm.setBetween('windows', null);
            return;
        }
        const dir = Math.sign(s.raw - s.base);
        const near = this._swipeNeighbour(s, dir);
        if (near) {
            const limit = Math.max(1, s.viewW * SWIPE_STEP_SHARE);
            tell(s.from, near, clamp(Math.abs(s.raw - s.base) / limit, 0, 1));
            return;
        }
        const [lo, hi] = this._scrollRange(s.viewW);
        const pos = clamp(s.raw, lo, hi);
        let base = s.base;
        for (;;) {
            const col = this.columns[at];
            const next = dir ? this.columns[at + dir] : null;
            const to = next && !next.pending ? this._scrollTo(next, s.viewW, base) : base;
            const whole = (to - base) * dir;
            const done = (pos - base) * dir;
            if (whole < 1) {
                tell(col, col, 0);
                return;
            }
            if (done < whole) {
                tell(col, next, Math.max(0, done) / whole);
                return;
            }
            base = to;
            at += dir;
        }
    }

    swipeEnd(timeMs, cancelled = false) {
        const s = this._swipe;
        this._swipe = null;
        if (s?.cover) {
            this._coverEnd(s, timeMs, cancelled);
            return;
        }
        if (!s || this.columns.length === 0)
            return;
        const {viewW} = this._measure();
        const [lo, hi] = this._scrollRange(viewW);

        // Release velocity in px/s, from the last SWIPE_VELOCITY_MS of motion.
        let velocity = 0;
        const first = s.history[0];
        const last = s.history.at(-1);
        if (!cancelled && last && last.time > first.time && timeMs - last.time < SWIPE_REST_MS)
            velocity = (last.raw - first.raw) / ((last.time - first.time) / 1000);
        // Focus went to a neighbour during the swipe (_swipeStep) and stays
        // there, whether the fingers were moving or at rest when they
        // lifted. A flick back towards the start returns it.
        const stepped = !cancelled && s.step !== 0 &&
            !(Math.abs(velocity) > SWIPE_FLICK && Math.sign(velocity) !== s.step);
        const dir = stepped ? s.step : Math.sign(velocity) || Math.sign(s.raw - s.base);

        const points = this._snapPoints(viewW);
        // Coasting stops at the first snap point past the position the
        // fingers let go at. A flick then moves one step however fast it
        // was, and a long drag still travels as far as the fingers did.
        const ahead = points.map(p => p.scroll).filter(x => x > s.pos + 0.5);
        const behind = points.map(p => p.scroll).filter(x => x < s.pos - 0.5);
        const coastHi = ahead.length ? Math.min(...ahead) : hi;
        const coastLo = behind.length ? Math.max(...behind) : lo;
        const projected = cancelled
            ? s.base
            : clamp(s.pos + velocity * SWIPE_COAST, coastLo, coastHi);
        // Nearest snap point. Several columns can share one scroll position
        // (the right edge of one is the left edge of the next view). Then the
        // column further along in the direction of travel wins.
        const closest = candidates => {
            let found = null;
            for (const p of candidates) {
                const dist = Math.abs(p.scroll - projected);
                if (!found || dist < found.dist - 0.5 ||
                    (dist <= found.dist + 0.5 && dir > 0))
                    found = {...p, dist};
            }
            return found;
        };
        let best = closest(points);

        // What the swipe was for. Fingers that were still moving when they
        // lifted ask for the next window: focus moves one column on in the
        // direction of travel, however little the view moved. Past
        // SWIPE_DRAG_SHARE of travel the fingers moved the view a long way,
        // and focus goes to a column at the snap point it coasts to. Either
        // way the view then settles with the column that took focus in the
        // middle, or as near to it as the ends of the strip allow.
        //
        // Scrolling the least distance that shows that column whole would,
        // for a column that is whole already, take the view back to where
        // the swipe began, against the motion of the fingers.
        //
        // Fingers that rested before they lifted placed the view by hand:
        // it settles on the nearest column edge, and focus stays where it
        // was while that column is whole in the view. A swipe that came
        // back towards its start changes nothing. Where the strip cannot
        // scroll there is no view to place, so travel alone moves the focus.
        const travel = s.raw - s.base;
        const far = Math.abs(travel) > viewW * SWIPE_SWITCH_SHARE;
        const onward = stepped || (!cancelled && dir !== 0 && Math.sign(travel) === dir &&
            (Math.abs(velocity) > SWIPE_FLICK || (far && (velocity !== 0 || hi <= lo))));
        const from = this.columns.includes(s.from) ? s.from : this.focus?.column ?? null;
        const at = this.columns.indexOf(from);
        const next = at >= 0 ? this.columns[at + dir] ?? null : null;
        let col = from;
        if (cancelled) {
            best = {scroll: s.base};
        } else if (onward && next && Math.abs(travel) < viewW * SWIPE_DRAG_SHARE) {
            col = next;
        } else {
            const whole = c => c.x >= best.scroll - 0.5 &&
                c.x + c.width <= best.scroll + viewW + 0.5;
            const moved = Math.abs(best.scroll - s.base) >= 1;
            if (moved && (onward || at < 0 || !whole(from)))
                col = this._swipeFocus(best, from, Math.sign(best.scroll - s.base), viewW);
            // No other column came whole into the view: the view only moved
            // the focused column from one side to the other, or not at all.
            if (onward && col === from && next)
                col = next;
        }
        if (!cancelled && onward && col && col !== from) {
            // Not past where the swipe began, against the fingers. Two
            // columns that are narrower than half the view together have
            // their middle on that side.
            const middle = clamp(col.x - (viewW - col.width) / 2, lo, hi);
            best = {scroll: dir > 0 ? Math.max(middle, s.base) : Math.min(middle, s.base)};
        }

        if (hi > lo) {
            this.scroll = best.scroll;
            this.freeScroll = false;
        }
        const tile = col?.active ?? col?.tiles[0] ?? null;
        if (tile) {
            // Before the layout, which keeps the focused column in view.
            this.focus = tile;
            col.active = tile;
        }
        // The springs carry the release velocity on, unless the picture was
        // pulled past the end of the strip.
        const carry = s.raw >= lo && s.raw <= hi ? -velocity : 0;
        for (const t of this.tiles)
            t.x.velocity = carry;
        this.layout(true);
        if (tile && this.wm.isActiveStrip(this) && !tile.win.has_focus())
            tile.win.activate(global.get_current_time());
    }

    // ---- swipe over a fullscreen window ----
    // A fullscreen window is not on the strip: it covers the monitor, and
    // the window that has focus is drawn over it at its place on the strip.
    // The other tiles are under it, so scrolling them shows nothing, and a
    // swipe that scrolled the strip would change the picture only when the
    // fingers lift.
    //
    // Here a swipe moves one thing, and that thing follows the fingers:
    //   - towards a column: the window of that column that will take focus
    //     comes in from the edge of the monitor on that side, over the
    //     fullscreen window, to the place it has when it has focus. It
    //     stays there when the fingers lift.
    //   - from a window over the fullscreen one, back towards it: that
    //     window leaves the way it came. A second window that came in
    //     after the first is still over the fullscreen one. Back from the
    //     second, the second leaves, goes under the fullscreen window
    //     again, and the first returns to the place it had before the
    //     second came in. So each swipe back undoes one swipe in.
    //   - towards the left with no column on the left: the sidebar comes in
    //     from the left edge with the fingers, stops at the place it has
    //     with no fullscreen window, and stays there when they lift.
    //   - towards the right while the sidebar is there: the sidebar leaves
    //     with the fingers, and nothing else moves.
    // "Towards the left" is the direction of travel on the strip, so it is
    // the same swipe that goes to the column on the left without a
    // fullscreen window, with or without natural scrolling.
    //
    // The focus keys do the same without the fingers, see coverStep(): the
    // window or the sidebar comes in or leaves on its spring.
    //
    // A swipe that begins while the last one's window is still on its way
    // takes that window where it is drawn and moves nothing else, see
    // _catch. The same for the sidebar on its way out, see _coverPlan.
    // And a swipe that begins within SWIPE_AGAIN_MS of one the same way
    // does not go on from a window to the sidebar or from the sidebar to
    // a window, see _coverAgain. Without these, a swipe would put the
    // window at the end of its way in one frame and begin from there:
    // after a swipe that sends a window out to the right, a second one the
    // same way would bring the sidebar in, and one the other way would
    // bring the window in again from the edge of the monitor.
    //
    // The windows that are over the fullscreen one already, and stay
    // there, go to the place they have after the swipe with the fingers
    // too, see _coverRest. Otherwise they would stay where they are until
    // the fingers lift: a second window would come in over the first, and
    // the first would move over on its spring after that.

    /** The fullscreen tile that covers this strip's monitor, or null. */
    get cover() {
        // A strip on a workspace that is not shown keeps the layout it
        // had when it was: the monitor's state is that of the workspace
        // in view. Without this a window as wide as the monitor would take
        // the width of the view when its workspace is left, and its own
        // again on the way back.
        const ws = this.workspace;
        const shown = !ws || ws === global.workspace_manager.get_active_workspace();
        if (shown && !global.display.get_monitor_in_fullscreen(this.monitor))
            return null;
        return this.shownFull;
    }

    /**
     * The fullscreen tile of this strip that is drawn over its other
     * fullscreen ones: the one in focus, or the top one in the stack of
     * the windows while a window that came in over it has the focus. null
     * with no fullscreen tile.
     *
     * With several fullscreen windows on a strip, the first in the order
     * of the columns can be one that is under the one on the screen. A
     * window that came in over the second of two would be placed, and sent
     * out, as if it were over the first.
     */
    get shownFull() {
        if (this.focus?.fullscreen)
            return this.focus;
        const full = this.tiles.filter(t => t.fullscreen);
        if (full.length < 2)
            return full[0] ?? null;
        const top = global.display.sort_windows_by_stacking(full.map(t => t.win)).at(-1);
        return full.find(t => t.win === top) ?? full[0];
    }

    /** What a swipe moves for a direction of travel: 1 to the right, -1 to the left. */
    _coverPlan(s, dir) {
        const {cover} = s;
        const focus = this.focus;
        const peek = this.wm.peekSink;
        const at = focus ? this.columns.indexOf(focus.column) : -1;
        const next = at >= 0 ? this.columns[at + dir] ?? null : null;
        // The cards are over the fullscreen window to stay. A swipe to
        // the right takes them out, by as much as the fingers travel, and
        // moves nothing else: it does not bring in the window of the
        // column on the right.
        if (peek?.available(this.monitor) && peek.held()) {
            if (dir > 0) {
                const from = peek.amount();
                return {kind: 'sidebar', dir, from, reach: from};
            }
            if (!next)
                return {kind: 'none', dir};
        }
        // The cards are on their way out after such a swipe. This one
        // takes them where they are: on out, or back in. A second swipe
        // to the right does not bring in the window of the column on the
        // right while they leave.
        if (peek?.available(this.monitor) && !peek.held() && peek.amount() > 0) {
            const from = peek.amount();
            return dir > 0
                ? {kind: 'sidebar', dir, from, reach: from, leaving: true}
                : {kind: 'sidebar', dir, from, reach: Math.max(0, peek.width() - from)};
        }
        if (!next) {
            // A second swipe the same way, right after one that moved a
            // window, does not bring the cards in after it.
            if (this._coverAgain(s, dir, 'window'))
                return {kind: 'none', dir};
            // Past the first column is the sidebar. The pull starts from
            // what is shown of it, so a swipe that begins while it springs
            // back takes it from where it is.
            if (dir < 0 && peek?.available(this.monitor)) {
                const from = peek.amount();
                return {kind: 'sidebar', dir, from, reach: Math.max(0, peek.width() - from)};
            }
            return {kind: 'none', dir};
        }
        const [left, right] = this._view;
        const back = focus !== cover && next.tiles.includes(cover);
        const tile = back ? cover : next.active ?? next.tiles[0];
        // The next column is another fullscreen window. Nothing moves with
        // the fingers: it takes the focus when they lift, as it does after
        // a focus key, and what is over this one leaves then.
        if (!back && tile?.fullscreen)
            return {kind: 'app', dir, tile, reach: s.viewW};
        if (!back && !tile?.target)
            return {kind: 'none', dir};
        const scroll = this._scrollTo(next, s.viewW, s.base);
        // The window of the next column is over the fullscreen one already.
        const shown = !back && focus !== cover && !this.under(tile, cover);

        if (back || shown) {
            const towards = Math.sign(this.columns.indexOf(cover.column) - at) === dir;
            // Away from the fullscreen window, to a window that is in view:
            // nothing comes in or leaves, the focus moves when the fingers lift.
            if (!towards)
                return {kind: 'focus', dir, col: next, tile, scroll, reach: s.viewW};
            // Back towards the fullscreen window: the column in focus
            // leaves the way it came, and tile takes the focus. The windows
            // over the fullscreen one past that column leave with it, each
            // by the same distance. They are there after a click or the
            // switcher, and would otherwise stay until the fullscreen
            // window is raised over them in a single frame.
            const leave = -dir;
            const tiles = this.columns
                .filter((_col, i) => i === at || Math.sign(i - at) === leave)
                .flatMap(col => col.tiles)
                .filter(t => t.target && !t.fullscreen &&
                    (t.column === focus.column || !this.under(t, cover)));
            // From where each is drawn now, so a swipe that begins while a
            // window still settles does not move it at once.
            const items = tiles.map(t => ({tile: t, from: t.x.value}));
            const lead = items.find(i => i.tile.column === focus.column);
            const reach = !lead ? 0 : Math.max(0, leave > 0
                ? right - lead.from
                : lead.from + lead.tile.target.width - left);
            // The windows that stay go back to the place they had before
            // the leaving ones came in, see _coverLeave.
            const moved = items.map(i => i.tile);
            const before = moved.find(t => t.cameFrom !== null)?.cameFrom ?? this.scroll;
            const rest = back ? []
                : this._coverRest(s, tile.column, this._scrollTo(tile.column, s.viewW, before), moved);
            return {kind: 'out', dir, leave, items, to: tile, reach, rest};
        }

        // A second swipe the same way, right after one that sent the cards
        // out, does not bring a window in after them.
        if (this._coverAgain(s, dir, 'sidebar'))
            return {kind: 'none', dir};

        // The place it has once it has focus, see _shiftFor.
        const final = tile.target.x - (scroll - s.base) +
            this._shift - this._shiftFor(next, scroll, s.viewW);
        const start = dir > 0 ? right : left - tile.target.width;
        this.wm.animator.remove(tile);
        tile.x.set(start);
        tile.sync();
        // Over the fullscreen window for the time of the swipe. The
        // compositor puts the actors in its own order again when the window
        // takes focus.
        const group = tile.actor.get_parent();
        const kids = group?.get_children() ?? [];
        const raised = cover.actor.get_parent() === group &&
            kids.indexOf(tile.actor) < kids.indexOf(cover.actor);
        if (raised)
            group.set_child_above_sibling(tile.actor, cover.actor);
        return {
            kind: 'in', dir, col: next, tile, scroll, final, start, raised,
            reach: Math.abs(final - start),
            rest: this._coverRest(s, next, scroll, [tile]),
        };
    }

    /**
     * The windows over the fullscreen one that a swipe neither brings in
     * nor sends out (moved), each with the place it is drawn at now and the
     * place it has once col has the focus at scroll: [{tile, from, to}].
     * They go from one to the other as the fingers travel, see _coverDraw.
     */
    _coverRest(s, col, scroll, moved) {
        // Every window is under a fullscreen one that has the focus.
        if (this.focus === s.cover)
            return [];
        // The same change of scroll and shift as for a window that comes
        // in, see _shiftFor.
        const by = s.base - scroll + this._shift - this._shiftFor(col, scroll, s.viewW);
        return this.tiles
            .filter(t => t.target && !t.fullscreen && !moved.includes(t) &&
                !this.under(t, s.cover))
            .map(t => ({tile: t, from: t.x.value, to: t.target.x + by}));
    }

    /**
     * Give the windows of plan.rest the speed of the window the fingers
     * moved (velocity, px/s), each in the ratio of its way to that
     * window's. Their springs then stay as far along as its spring.
     */
    _coverCarry(plan, velocity) {
        const span = plan.kind === 'in' ? plan.final - plan.start : plan.leave * plan.reach;
        for (const {tile, from, to} of plan.rest) {
            if (!tile.dead)
                tile.x.velocity = span ? velocity * (to - from) / span : 0;
        }
    }

    /**
     * Put windows back where a plan found them, and on towards their places
     * if they were still settling then. entries: [{tile, from}].
     */
    _coverReturn(entries) {
        for (const {tile, from} of entries) {
            if (tile.dead)
                continue;
            tile.x.set(from);
            if (tile.target)
                tile.x.target = tile.target.x;
            this.wm.animator.add(tile);
            tile.sync();
        }
    }

    /**
     * Whether swipe s, in direction dir, began within SWIPE_AGAIN_MS of the
     * end of a swipe the same way that moved what: 'window' or 'sidebar'.
     * Two strokes that close together are one motion of the hand, and the
     * second does not start on a thing of the other kind. A focus key has
     * no time and is never such a swipe.
     */
    _coverAgain(s, dir, what) {
        const last = this._coverLast;
        return !!last && s.began !== undefined && last.what === what &&
            last.dir === dir && s.began - last.time < SWIPE_AGAIN_MS;
    }

    /** Draw a plan with the fingers d px from where they started. */
    _coverDraw(plan, d) {
        if (!plan)
            return;
        if (plan.kind === 'sidebar') {
            // Travel to the left shows more of the cards.
            this.wm.peekSink?.update(plan.from - plan.dir * d);
        } else if (plan.kind === 'in') {
            const x = plan.dir > 0
                ? Math.max(plan.final, plan.start - d)
                : Math.min(plan.final, plan.start + d);
            plan.tile.x.set(x);
            plan.tile.sync();
        } else if (plan.kind === 'out') {
            const by = plan.leave * Math.min(d, plan.reach);
            for (const {tile, from} of plan.items) {
                tile.x.set(from + by);
                tile.sync();
            }
        }
        if (plan.rest?.length) {
            // As far along their way as the window the fingers move.
            const part = plan.reach > 0 ? Math.min(d, plan.reach) / plan.reach : 0;
            for (const {tile, from, to} of plan.rest) {
                if (tile.dead)
                    continue;
                tile.x.set(from + (to - from) * part);
                tile.sync();
            }
        }
    }

    /** Put back what a plan moved, at once. */
    _coverDrop(plan) {
        if (plan.kind === 'sidebar') {
            // Out again for cards that were coming in, back in for cards
            // that were there to stay.
            if (plan.dir < 0 || plan.leaving)
                this.wm.peekSink?.end(0);
            else
                this.wm.peekSink?.stay(0);
        } else if (plan.kind === 'in') {
            this._coverLower(plan);
            this._coverReturn(plan.rest);
        } else if (plan.kind === 'out') {
            this._coverReturn([...plan.items, ...plan.rest]);
        }
    }

    /** Under the fullscreen window again, at its place on the strip. */
    _coverLower(plan) {
        const {tile, raised} = plan;
        if (tile.dead)
            return;
        const cover = this.shownFull;
        if (raised && cover && cover.actor.get_parent() === tile.actor.get_parent())
            tile.actor.get_parent().set_child_below_sibling(tile.actor, cover.actor);
        if (tile.target)
            tile.x.set(tile.target.x);
        tile.sync();
    }

    _coverUpdate(s, delta, timeMs) {
        s.travel += delta;
        s.net += delta;
        s.began ??= timeMs;
        const dir = Math.sign(s.travel);
        if (s.flying && dir !== 0) {
            // A window is still on its way from the last swipe. With two
            // or more windows over the fullscreen one, a swipe the same
            // way is for the next of them: the one on its way arrives now.
            // Any other swipe takes the window where it is.
            s.flying = false;
            const flight = this._settle?.flight;
            const next = flight?.stays && dir === flight.plan.dir;
            const caught = flight && !next ? this._catch() : null;
            if (caught) {
                s.caught = caught;
                s.plan = caught.plan;
                s.travel += caught.travel;
            } else if (this._settle) {
                this._settle.finish();
                s.base = this._resolveScroll(s.viewW);
            }
        }
        if (s.caught) {
            // The window that was caught, between the place it left and
            // the end of its way, and nothing else.
            s.travel = s.plan.dir * clamp(s.travel * s.plan.dir, 0, s.plan.reach);
        } else {
            if (s.plan && s.plan.dir !== dir) {
                this._coverDrop(s.plan);
                s.plan = null;
            }
            if (!s.plan && dir !== 0)
                s.plan = this._coverPlan(s, dir);
            // The fingers do not travel on past the place where what they
            // move stops. If they did, on the way back the sidebar or the
            // window would stay where it is until they had come back as
            // far as they had gone past it.
            const reach = s.plan?.reach;
            if (Number.isFinite(reach))
                s.travel = dir * Math.min(Math.abs(s.travel), reach);
        }
        s.history.push({time: timeMs, raw: s.travel});
        while (s.history.length > 2 && timeMs - s.history[0].time > SWIPE_VELOCITY_MS)
            s.history.shift();
        this._coverDraw(s.plan, Math.abs(s.travel));
        // For the minimap: between the window that has the focus and the
        // one that takes it when the fingers lift, by the share of the way
        // that window has come in or the other has left.
        const plan = s.plan;
        const kinds = {in: plan?.tile, focus: plan?.tile, app: plan?.tile, out: plan?.to};
        const to = plan ? kinds[plan.kind] ?? null : null;
        const from = this.focus;
        this.wm.setBetween('windows', to && from && plan.reach > 0 && this.wm.isActiveStrip(this)
            ? [from.win, to.win, clamp(Math.abs(s.travel) / plan.reach, 0, 1)] : null);
    }

    /**
     * The fingers lifted. The swipe counts when they were still moving the
     * way they started (faster than SWIPE_FLICK), or had travelled
     * SWIPE_SWITCH_SHARE of the view or half of the way, whichever is less,
     * and were not moving back. Otherwise everything returns.
     */
    _coverEnd(s, timeMs, cancelled) {
        const plan = s.plan;
        let velocity = 0;
        const first = s.history[0];
        const last = s.history.at(-1);
        if (!cancelled && last && last.time > first.time && timeMs - last.time < SWIPE_REST_MS)
            velocity = (last.raw - first.raw) / ((last.time - first.time) / 1000);
        const done = () => global.compositor.enable_unredirect();
        if (!plan || plan.kind === 'none') {
            done();
            return;
        }
        // A caught window was some way along when the fingers took it, so
        // fingers at rest say where it goes by the way they moved it.
        const dir = Math.sign(velocity) || Math.sign(s.caught ? s.net : s.travel);
        const far = Math.abs(s.travel) > Math.min(s.viewW * SWIPE_SWITCH_SHARE, plan.reach / 2);
        const counts = !cancelled && dir === plan.dir &&
            (Math.abs(velocity) > SWIPE_FLICK || far);
        const time = global.get_current_time();
        if (counts) {
            this._coverLast = {
                time: timeMs, dir: plan.dir,
                what: plan.kind === 'sidebar' ? 'sidebar' : 'window',
            };
        }

        if (plan.kind === 'sidebar') {
            // A swipe that counts leaves the cards where it took them: in
            // to stay, or out. One that does not puts them back. They go
            // on with the speed the fingers had. Travel towards the left
            // shows more of them. Cards that were leaving when the swipe
            // took them go on out.
            if ((plan.dir < 0) === counts && !plan.leaving)
                this.wm.peekSink?.stay(-velocity);
            else
                this.wm.peekSink?.end(-velocity);
            done();
        } else if (plan.kind === 'app') {
            // The windows over this fullscreen window leave when the
            // other one has the focus, see coverClear().
            if (counts && this.wm.isActiveStrip(this))
                plan.tile.win.activate(time);
            done();
        } else if (plan.kind === 'focus' && !counts) {
            done();
        } else if (plan.kind !== 'out' && counts) {
            // Focus goes to the window that came in, and the strip scrolls
            // to the place it was drawn towards. Its spring carries it there.
            const {tile, col} = plan;
            const [lo, hi] = this._scrollRange(s.viewW);
            if (plan.kind === 'in') {
                tile.cameFrom = s.base;
                tile.x.velocity = -velocity;
                this._coverCarry(plan, -velocity);
            }
            if (hi > lo) {
                this.scroll = plan.scroll;
                this.freeScroll = false;
            }
            this.focus = tile;
            col.active = tile;
            this.layout(true);
            if (this.wm.isActiveStrip(this) && !tile.win.has_focus())
                tile.win.activate(time);
            done();
        } else if (plan.kind === 'in') {
            // Back out to the edge, then under the fullscreen window again.
            plan.tile.x.target = plan.start;
            plan.tile.x.velocity = -velocity;
            // The windows that moved over for it return with it.
            const rest = plan.rest.map(r => r.tile).filter(t => !t.dead && t.target);
            for (const tile of rest)
                tile.x.target = tile.target.x;
            this._coverCarry(plan, -velocity);
            this._settleWhen([plan.tile, ...rest], () => {
                this._coverLower(plan);
                done();
            }, {plan});
        } else if (counts) {
            this._coverLeave(plan, s.cover, s.viewW, -velocity, done, s.caught?.undo);
        } else {
            // A window that was caught on its way out: as before it left.
            s.caught?.undo?.();
            for (const {tile} of plan.items)
                tile.x.velocity = -velocity;
            this._coverCarry(plan, -velocity);
            this.layout(true);
            done();
        }
    }

    /**
     * The window that the last swipe or focus key sent on its way over the
     * fullscreen window, for a swipe that begins before it has arrived: out
     * past the edge of the monitor (_coverLeave), or back out after a swipe
     * in that did not count. It stops where it is drawn, and the swipe goes
     * on with the plan that moved it, as far along as the window is
     * (travel). null with no such window.
     *
     * The swipe moves that window and nothing else: towards the end of its
     * way, or back to the place it left.
     */
    _catch() {
        const item = this._settle;
        const flight = item?.flight;
        if (!flight)
            return null;
        const {plan} = flight;
        let lead;
        if (plan.kind === 'in')
            lead = plan.tile.dead ? null : {tile: plan.tile, from: plan.start};
        else
            lead = plan.items.find(i => !i.tile.dead);
        if (!lead || lead.tile.strip !== this)
            return null;
        // The settle item is dropped without its done(), which would have
        // let the compositor unredirect again: the swipe holds that off
        // itself.
        this._settle = null;
        this.wm.animator.remove(item);
        global.compositor.enable_unredirect();
        for (const tile of item.tiles) {
            if (!tile.dead)
                tile.x.set(tile.x.value);
        }
        const gone = plan.kind === 'in'
            ? Math.abs(lead.tile.x.value - plan.start)
            : (lead.tile.x.value - lead.from) * plan.leave;
        return {plan, travel: plan.dir * clamp(gone, 0, plan.reach), undo: flight.undo};
    }

    /**
     * The windows of an 'out' plan go all the way out, then plan.to takes
     * the focus. velocity: of the windows, in px/s. done() runs after that.
     * undoFirst: for windows that were caught on their way out and are sent
     * on, the undo() of the first time they left.
     */
    _coverLeave(plan, cover, viewW, velocity, done, undoFirst = null) {
        const {to, items} = plan;
        const tiles = items.map(i => i.tile);
        const time = global.get_current_time();
        const stays = to !== cover && !to.dead && to.strip === this;
        // For a swipe that catches the windows on their way and brings
        // them back, see _catch.
        const was = {
            focus: this.focus, scroll: this.scroll, free: this.freeScroll,
            came: tiles.map(t => [t, t.cameFrom]),
        };
        const undo = () => {
            for (const [tile, came] of was.came) {
                if (!tile.dead)
                    tile.cameFrom = came;
            }
            const {focus} = was;
            if (!stays || !focus || focus.dead || focus.strip !== this)
                return;
            this.scroll = was.scroll;
            this.freeScroll = was.free;
            this.focus = focus;
            focus.column.active = focus;
            this.wm._makeCurrent(focus);
            if (this.wm.isActiveStrip(this) && !focus.win.has_focus())
                focus.win.activate(global.get_current_time());
        };
        if (stays) {
            // A window that stays over the fullscreen one goes back to the
            // place it had before the leaving one came in, while that one
            // leaves. It does the same in the other direction when a
            // window comes in. Without the scroll kept in cameFrom the
            // strip would scroll the least distance, and the window that
            // stays would move to the left while the other leaves to the
            // right.
            const before = tiles.find(t => t.cameFrom !== null)?.cameFrom ?? this.scroll;
            const [lo, hi] = this._scrollRange(viewW);
            if (hi > lo) {
                this.scroll = clamp(this._scrollFor(to.column, viewW, before), lo, hi);
                this.freeScroll = false;
            }
            this.focus = to;
            to.column.active = to;
            this.layout(true);
            // Full size from now, not from when it has the focus.
            this.wm._makeCurrent(to);
            // The windows that stay were moved by the fingers so far.
            this._coverCarry(plan, velocity);
        }
        for (const tile of tiles)
            tile.cameFrom = null;
        for (const {tile, from} of items) {
            tile.x.target = from + plan.leave * plan.reach;
            tile.x.velocity = velocity;
        }
        this._settleWhen(tiles, () => {
            if (!stays) {
                // The fullscreen window takes focus once the column is all
                // the way out: that raises it over the column at once.
                // Not from a window of this strip that took the focus
                // while the column left: the switcher, the minimap.
                const other = this.tiles.some(t => t !== cover && !tiles.includes(t) &&
                    t.win.has_focus());
                if (!cover.dead && cover.strip === this && !other) {
                    this.focus = cover;
                    cover.column.active = cover;
                    if (this.wm.isActiveStrip(this) && !cover.win.has_focus())
                        cover.win.activate(time);
                }
                // Nothing is over the fullscreen window now.
                for (const tile of this.tiles)
                    tile.cameFrom = null;
                this.layout(false);
                done();
                return;
            }
            // The focus went elsewhere while the windows left: a click, the
            // switcher. That window keeps it and nothing is lowered.
            if (this.focus === to && !to.dead && to.strip === this) {
                for (const tile of tiles) {
                    if (tile.dead)
                        continue;
                    // Under the fullscreen window again, as before it came
                    // in. The compositor follows the stack of the windows a
                    // frame later, so the actor is put there as well.
                    tile.win.lower();
                    const group = tile.actor?.get_parent();
                    if (group && !cover.dead && cover.actor?.get_parent() === group)
                        group.set_child_below_sibling(tile.actor, cover.actor);
                    if (tile.target)
                        tile.x.set(tile.target.x);
                    tile.sync();
                }
                if (this.wm.isActiveStrip(this) && !to.win.has_focus())
                    to.win.activate(time);
            }
            this.layout(true);
            done();
        }, {plan, stays, undo: undoFirst ?? undo});
    }

    /**
     * A focus key pressed over a fullscreen window, for a direction of
     * travel. It does what a swipe that way does. Returns false when there
     * is nothing to do here, and the key moves the focus as it does on a
     * strip with no fullscreen window.
     */
    coverStep(dir) {
        const cover = this.cover;
        if (!cover || this._swipe)
            return false;
        const peek = this.wm.peekSink;
        // The other way while the sidebar is held: it leaves.
        if (dir > 0 && peek?.available(this.monitor) && peek.held()) {
            peek.end(0);
            return true;
        }
        this._settle?.finish();
        const focus = this.focus;
        const at = focus ? this.columns.indexOf(focus.column) : -1;
        const next = at >= 0 ? this.columns[at + dir] ?? null : null;
        if (!next) {
            if (dir < 0 && peek?.available(this.monitor)) {
                // The same key again sends the cards back out: there is
                // nothing further to the left for it to go to.
                if (peek.held())
                    peek.end(0);
                else
                    peek.hold();
                return true;
            }
            return false;
        }
        if (!this.wm.animator.enabled)
            return false;
        const {viewW} = this._measure();
        const s = {cover, base: this._resolveScroll(viewW), viewW};
        const plan = this._coverPlan(s, dir);
        if (plan.kind === 'in') {
            const {tile} = plan;
            const [lo, hi] = this._scrollRange(viewW);
            tile.cameFrom = s.base;
            if (hi > lo) {
                this.scroll = plan.scroll;
                this.freeScroll = false;
            }
            this.focus = tile;
            next.active = tile;
            // The spring takes the window from the edge to its place.
            this.layout(true);
            tile.win.activate(global.get_current_time());
            return true;
        }
        if (plan.kind === 'out') {
            global.compositor.disable_unredirect();
            this._coverLeave(plan, cover, viewW, 0,
                () => global.compositor.enable_unredirect());
            return true;
        }
        // 'focus': a window away from the fullscreen one that is over it
        // already is in view, or scrolls into view, like any column.
        // 'app': another fullscreen window takes the focus like any column.
        return false;
    }

    /**
     * A window that is not the fullscreen one is about to take the focus
     * without a swipe or a focus key: the switcher, the minimap. Called
     * before the strip scrolls to it and is laid out, which puts the window
     * on its spring.
     *
     * A window under the fullscreen one comes in from the edge of the
     * monitor on its side, as it does after a focus key (coverStep). Its
     * place under the fullscreen window depends on what the strip showed
     * last, and can be in view: from there the window would be shown at
     * once, at or near the place it comes to rest at.
     *
     * A window that is on its way out stays over the fullscreen one and
     * returns from where it is drawn. What waited for it to be out is
     * dropped: that would put it at the end of its way in one frame and
     * under the fullscreen window, with the focus in it.
     */
    coverEnter(tile) {
        const cover = this.cover;
        if (!cover || tile === cover || tile.fullscreen || tile.strip !== this || this._swipe)
            return;
        const animator = this.wm.animator;
        const item = this._settle;
        if (item?.tiles.includes(tile)) {
            this._settle = null;
            animator.remove(item);
            // done() would have let the compositor unredirect again.
            global.compositor.enable_unredirect();
            for (const t of item.tiles) {
                if (!t.dead)
                    t.x.set(t.x.value);
            }
            return;
        }
        // Other windows that are on their way out arrive now, before the
        // layout: the end of their way lays the strip out with no animation.
        item?.finish();
        const side = Math.sign(this.columns.indexOf(tile.column) - this.columns.indexOf(cover.column));
        if (!side || !tile.target || tile.column.pending || !animator.enabled ||
            !this.under(tile, cover))
            return;
        const {viewW} = this._measure();
        const [left, right] = this._view;
        tile.cameFrom = this._resolveScroll(viewW);
        animator.remove(tile);
        tile.x.set(side > 0 ? right : left - tile.target.width);
        tile.sync();
    }

    /**
     * A window over the fullscreen one took the focus without a swipe or a
     * focus key: a click on it, the switcher, the minimap. The windows over
     * the fullscreen one that came in after it leave the way they came and
     * go under the fullscreen window again, and it returns to the place it
     * had before they came in, as after a swipe or a focus key back to it.
     * Returns false when no window is past it.
     */
    coverFocus(tile) {
        const cover = this.cover;
        if (!cover || tile === cover || tile.fullscreen || this._swipe ||
            this.focus !== tile || !this.wm.animator.enabled)
            return false;
        const at = this.columns.indexOf(tile.column);
        const leave = Math.sign(at - this.columns.indexOf(cover.column));
        if (at < 0 || !leave)
            return false;
        this._settle?.finish();
        const {viewW} = this._measure();
        // The nearest to the window first: _coverLeave() takes the scroll
        // from before the first of them came in.
        const tiles = this.columns
            .filter((_col, i) => Math.sign(i - at) === leave)
            .flatMap(col => col.tiles)
            .filter(t => t.target && !t.fullscreen && !this.under(t, cover));
        if (leave < 0)
            tiles.reverse();
        if (tiles.length === 0)
            return false;
        const items = tiles.map(t => ({tile: t, from: t.x.value}));
        const [left, right] = this._view;
        // As far as takes the nearest of them past the edge of the monitor.
        const reach = Math.max(0, leave > 0
            ? right - Math.min(...items.map(i => i.from))
            : Math.max(...items.map(i => i.from + i.tile.target.width)) - left);
        global.compositor.disable_unredirect();
        const plan = {kind: 'out', dir: -leave, to: tile, items, leave, reach, rest: []};
        this._coverLeave(plan, cover, viewW, 0, () => global.compositor.enable_unredirect());
        return true;
    }

    /**
     * The fullscreen window took the focus without a swipe or a focus key:
     * a click on it, the switcher, the minimap. The windows over it leave
     * the way they came, those of each side by the same distance, and are
     * under it after that. Returns false when no window is over it.
     *
     * Mutter has the fullscreen window over every other one from the
     * moment it has the focus, and the compositor puts the actors in that
     * order before the next frame: the windows over it would be gone in
     * that frame. Their actors are put over it again after the compositor
     * has done that, for as long as they are on their way.
     */
    coverClear() {
        const cover = this.cover;
        if (!cover || this.focus !== cover || this._swipe || !this.wm.animator.enabled)
            return false;
        const over = this.tiles.filter(t => t !== cover && !t.fullscreen && t.target &&
            !t.dead && !this.under(t, cover));
        if (over.length === 0)
            return false;
        this._settle?.finish();
        const laters = global.compositor.get_laters();
        const group = cover.actor?.get_parent();
        const stack = above => {
            for (const tile of over) {
                if (tile.dead || !group || tile.actor?.get_parent() !== group || cover.dead)
                    continue;
                if (above)
                    group.set_child_above_sibling(tile.actor, cover.actor);
                else
                    group.set_child_below_sibling(tile.actor, cover.actor);
            }
        };
        global.compositor.disable_unredirect();
        // Laters of this kind run after the one the compositor orders its
        // actors in.
        let laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            laterId = 0;
            stack(true);
            return GLib.SOURCE_REMOVE;
        });
        this._coverSendOut(cover, over, () => {
            if (laterId)
                laters.remove(laterId);
            laterId = 0;
            stack(false);
            for (const tile of this.tiles)
                tile.cameFrom = null;
            this.layout(false);
            global.compositor.enable_unredirect();
        });
        return true;
    }

    /**
     * Send the windows over the fullscreen one (over) out the way they
     * came, each to its side of that window, those of one side by the same
     * distance: as far as takes the one that is furthest in past the edge
     * of the monitor. done() runs when they are out.
     */
    _coverSendOut(cover, over, done) {
        const at = this.columns.indexOf(cover.column);
        const [left, right] = this._view;
        const sideOf = t => Math.sign(this.columns.indexOf(t.column) - at) || 1;
        const reach = side => Math.max(0, ...over.filter(t => sideOf(t) === side)
            .map(t => side > 0 ? right - t.x.value : t.x.value + t.target.width - left));
        for (const tile of over) {
            const side = sideOf(tile);
            tile.cameFrom = null;
            tile.x.target = tile.x.value + side * reach(side);
            tile.x.velocity = 0;
        }
        this._settleWhen(over, done);
    }

    /**
     * A window that came in over the fullscreen one is gone from the
     * strip: closed, minimized, moved away. to is the window that is in
     * view now, before the scroll the strip had before the other came in.
     * The strip returns to that scroll, so to has the place it had then,
     * as after a swipe back (_coverLeave).
     *
     * With the scroll kept as it is and two windows over the fullscreen
     * one, closing the second would leave the first at the left of the
     * view, and from there the strip would move it into the room of the
     * sidebar, to the left edge of the monitor.
     */
    coverGone(to, before) {
        const cover = this.cover;
        if (!cover || !to || to === cover || to.fullscreen || to.strip !== this || this._swipe)
            return;
        const {viewW} = this._measure();
        const [lo, hi] = this._scrollRange(viewW);
        if (hi > lo) {
            this.scroll = clamp(this._scrollFor(to.column, viewW, before), lo, hi);
            this.freeScroll = false;
        }
    }

    /**
     * The workspace of this strip was left and has come back into view.
     * The windows over the fullscreen one slide out the way they came and
     * go under it again, the strip has the scroll from before the first of
     * them came in, and the fullscreen window takes the focus.
     *
     * They leave here, with the workspace at rest, and not while it slid
     * away or behind it: there the way out is over in the first 100 ms of
     * the slide, or not seen at all, and the windows are missed on the way
     * back. Left over the fullscreen window, they would stay while the
     * sidebar that was shown with them has gone: its cards belong to the
     * monitor, and the workspace shown in between has them at their place.
     *
     * animate false: at once. For a strip that is not shown.
     */
    unpeek(animate = true) {
        const cover = this.cover;
        // A swipe on the strip has begun: the fingers have the windows.
        if (!cover || this._swipe)
            return;
        // Windows that are on their way out arrive now.
        this._settle?.finish();
        const at = this.columns.indexOf(cover.column);
        const away = t => Math.abs(this.columns.indexOf(t.column) - at);
        // The nearest to the fullscreen window came in first.
        const over = this.tiles
            .filter(t => t !== cover && !t.fullscreen && t.target && !t.dead &&
                !this.under(t, cover))
            .sort((a, b) => away(a) - away(b));
        if (over.length === 0 && this.focus === cover)
            return;
        const before = over.find(t => t.cameFrom !== null)?.cameFrom ?? null;
        const moving = animate && over.length > 0 && this.wm.animator.enabled;
        const under = () => {
            if (moving)
                global.compositor.enable_unredirect();
            if (cover.dead || cover.strip !== this)
                return;
            // The keyboard was in one of these windows: it goes to the
            // fullscreen one. Not from a window of another monitor.
            const had = this.wm.isActiveStrip(this) && this.tiles.some(t => t.win.has_focus());
            if (before !== null) {
                this.scroll = before;
                this.freeScroll = false;
            }
            for (const tile of over) {
                if (tile.dead || tile.strip !== this)
                    continue;
                // As in _coverLeave(): the compositor follows the stack of
                // the windows a frame later, so the actor is put there too.
                tile.win.lower();
                const group = tile.actor?.get_parent();
                if (group && cover.actor?.get_parent() === group)
                    group.set_child_below_sibling(tile.actor, cover.actor);
            }
            for (const tile of this.tiles)
                tile.cameFrom = null;
            this.focus = cover;
            cover.column.active = cover;
            this.layout(false);
            if (had && !cover.win.has_focus())
                cover.win.activate(global.get_current_time());
        };
        if (moving) {
            global.compositor.disable_unredirect();
            this._coverSendOut(cover, over, under);
        } else {
            under();
        }
    }

    /**
     * A window was dropped beside the fullscreen one, or into a column
     * there. The windows over the fullscreen one on the other side of it
     * leave the way they came and go under it again, as they do before a
     * swipe brings a window in from that side.
     *
     * The strip has one scroll, and it puts the column in focus against its
     * edge of the monitor. A window on the other side would be drawn where
     * that scroll leaves it: out of view but for a part of it at the edge.
     */
    coverOneSide(tile) {
        const cover = this.cover;
        if (!cover || tile === cover || tile.strip !== this || this._swipe)
            return;
        const at = this.columns.indexOf(cover.column);
        const sideOf = t => Math.sign(this.columns.indexOf(t.column) - at);
        const side = sideOf(tile);
        const others = this.tiles.filter(t => t !== cover && !t.fullscreen && t.target &&
            !t.dead && side && sideOf(t) === -side && !this.under(t, cover));
        if (others.length === 0)
            return;
        const moving = this.wm.animator.enabled;
        const under = () => {
            if (moving)
                global.compositor.enable_unredirect();
            for (const t of others) {
                if (t.dead || t.strip !== this || cover.dead || this.focus === t)
                    continue;
                t.cameFrom = null;
                // As in _coverLeave(): the compositor follows the stack of
                // the windows a frame later, so the actor is put there too.
                t.win.lower();
                const group = t.actor?.get_parent();
                if (group && cover.actor?.get_parent() === group)
                    group.set_child_below_sibling(t.actor, cover.actor);
                if (t.target)
                    t.x.set(t.target.x);
                t.sync();
            }
        };
        // Windows that are on their way from a swipe arrive now.
        this._settle?.finish();
        if (moving) {
            global.compositor.disable_unredirect();
            this._coverSendOut(cover, others, under);
        } else {
            under();
        }
    }

    /**
     * Whether a tile is on its way out from over the fullscreen window, to
     * go under it when it is out: after a swipe, a focus key, or a click on
     * a window that came in before it.
     */
    leaving(tile) {
        const item = this._settle;
        if (!item?.tiles.includes(tile))
            return false;
        // No plan: every tile leaves (_coverSendOut). An 'in' plan here is
        // a swipe in that did not count: its window goes back out, and the
        // others return to their places.
        const plan = item.flight?.plan;
        return !plan || plan.kind === 'out' || plan.tile === tile;
    }

    /** Whether a tile's window is drawn under the fullscreen window. */
    under(tile, cover) {
        const group = tile.actor?.get_parent();
        if (!group || cover.actor?.get_parent() !== group)
            return false;
        const kids = group.get_children();
        return kids.indexOf(tile.actor) < kids.indexOf(cover.actor);
    }

    /** End a swipe over a fullscreen window now. For disable(). */
    abortCover() {
        const s = this._swipe;
        if (s?.cover) {
            this._swipe = null;
            this._coverEnd(s, 0, true);
        }
        this._settle?.finish();
    }

    /**
     * Run done() once the springs of these tiles have come to rest. flight
     * says what is on its way, for a swipe that begins before that: the
     * plan that moves the tiles, undo() for what was changed when they set
     * off, and stays, whether a window stays over the fullscreen one. See
     * _catch.
     */
    _settleWhen(tiles, done, flight = null) {
        const animator = this.wm.animator;
        const item = {
            tiles, flight,
            tick: () => {
                if (!tiles.every(t => t.dead || t.x.atRest))
                    return true;
                item.finish();
                return false;
            },
            finish: () => {
                if (this._settle !== item)
                    return;
                this._settle = null;
                animator.remove(item);
                for (const t of tiles) {
                    if (!t.dead)
                        t.x.set(t.x.target);
                }
                done();
            },
        };
        this._settle = item;
        if (!animator.enabled) {
            item.finish();
            return;
        }
        // The tiles first: the ticker runs its items in the order they came.
        for (const t of tiles)
            animator.add(t);
        animator.add(item);
    }
}

class FocusRing {
    constructor(wm) {
        this.wm = wm;
        this.actor = new St.Widget({
            style_class: 'kelp-focus-ring',
            reactive: false,
            visible: false,
        });
        global.window_group.add_child(this.actor);
        this.win = null;
        this.restyle();
        // After the shell's own handler, which was connected first and has
        // started its animation of the size change by now. The window's own
        // size-changed signal comes before that handler, so a sync from it
        // finds no animation to follow. With that sync alone, a window
        // that leaves fullscreen would shrink to its place over 250 ms
        // with the ring at that place from the first frame.
        global.window_manager.connectObject('size-changed', (_wm, actor) => {
            if (actor.meta_window !== this.win)
                return;
            const shown = this.actor.visible;
            this.sync();
            if (!shown && this.actor.visible)
                this._fadeIn();
        }, 'map', (_wm, actor) => this._onShown(actor),
        'unminimize', (_wm, actor) => this._onShown(actor),
        'destroy', (_wm, actor) => this._leave(actor), this);
        this._leaving = null;      // {actor, frame, buffer, opacity}, see leaving()
        this._ghosts = new Set();  // functions that end a ring on a closing window
    }

    /**
     * The shell has mapped a window or brought it back from minimized. The
     * ring is on the window by then, placed with no animation to follow,
     * and nothing moves it after that: it would be at the window's place
     * at its full size while the window grows to that from 1% of it. A
     * prompt of 1Password opens that way.
     *
     * This runs after the shell's own handler, which has the actor at the
     * scale its animation starts from by now, see _animated().
     */
    _onShown(actor) {
        if (actor.meta_window === this.win)
            this.sync();
    }

    /**
     * win is closing. If the ring is on it, a copy of the ring stays on
     * the window while the shell shrinks and fades it (_leave), and the
     * ring itself goes to the window that takes the focus. Without the
     * copy, the closing window would be drawn for 150 ms more with no
     * ring.
     */
    leaving(win) {
        const actor = win.get_compositor_private();
        if (this.win !== win || !this.actor.visible || !actor)
            return;
        this._leaving = {
            actor,
            frame: visibleRect(this.wm.config, win),
            buffer: win.get_buffer_rect(),
            opacity: this.actor.opacity,
        };
    }

    /**
     * The shell has started to close a window. This runs after the
     * shell's own handler, so the transition of the actor's scale is
     * there if the shell animates the close. The copy of the ring is
     * placed from the actor's scale and opacity before every frame of
     * that transition.
     */
    _leave(actor) {
        const leaving = this._leaving;
        if (leaving?.actor !== actor)
            return;
        this._leaving = null;
        const busy = actor.get_transition('scale-x');
        const {frame, buffer, opacity} = leaving;
        if (!busy || buffer.width <= 0 || buffer.height <= 0)
            return;
        const w = this.wm.config.values.focusRing.width *
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const ghost = new St.Widget({
            style_class: 'kelp-focus-ring',
            style: this.actor.style,
            reactive: false,
            width: frame.width + 2 * w,
            height: frame.height + 2 * w,
        });
        ghost.set_pivot_point(0, 0);
        global.window_group.insert_child_above(ghost, actor);
        // The same arithmetic as _animated(): the ring is laid out for the
        // window at rest and scaled with it around the actor's pivot.
        const place = () => {
            const kx = actor.scale_x;
            const ky = actor.scale_y;
            const [px, py] = actor.get_pivot_point();
            const pivotX = px * buffer.width;
            const pivotY = py * buffer.height;
            ghost.set_scale(kx, ky);
            ghost.set_position(
                actor.x + actor.translation_x + pivotX + kx * (frame.x - buffer.x - pivotX - w),
                actor.y + actor.translation_y + pivotY + ky * (frame.y - buffer.y - pivotY - w));
            ghost.opacity = Math.round(opacity * actor.opacity / 255);
        };
        let laterId = 0;
        let ended = false;
        const end = () => {
            if (ended)
                return;
            ended = true;
            this._ghosts.delete(end);
            if (laterId)
                global.compositor.get_laters().remove(laterId);
            laterId = 0;
            ghost.destroy();
        };
        this._ghosts.add(end);
        // The opacity has a transition of its own, which can be stepped
        // after this one. The copy is placed once all of a frame's
        // transitions have been.
        busy.connect('new-frame', () => {
            if (ended || laterId)
                return;
            laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                laterId = 0;
                if (!ended)
                    place();
                return GLib.SOURCE_REMOVE;
            });
        });
        busy.connect('stopped', end);
        actor.connect('destroy', end);
        place();
    }

    restyle() {
        const c = this.wm.config.values.focusRing;
        // The ring is drawn outside the window, so its inner edge follows the
        // window's corner when its outer radius is that radius plus its width.
        this.actor.style = `border: ${c.width}px solid ${ringColor(this.wm.config)}; ` +
            `border-radius: ${c.radius + c.width}px;`;
    }

    /** fade: the ring fades in on a window it was not on. */
    setWindow(win, fade = true) {
        if (this.win === win) {
            this.sync();
            return;
        }
        this.win?.disconnectObject(this);
        this.win = win;
        win?.connectObject(
            'position-changed', () => this.sync(),
            'size-changed', () => this.sync(),
            'notify::fullscreen', () => this.sync(),
            'unmanaging', () => {
                this.leaving(win);
                this.setWindow(null);
            },
            this);
        this.sync();
        if (fade) {
            this._fadeIn();
        } else {
            this.actor.remove_all_transitions();
            this.actor.opacity = 255;
        }
    }

    _fadeIn() {
        this.actor.remove_all_transitions();
        this.actor.opacity = 0;
        this.actor.ease({
            opacity: 255,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Whether the shell is holding the window at the frame it had before a
     * size change. It does from the moment the change is asked for until the
     * client has drawn the new size, and then animates from the old frame to
     * the new one. A window that leaves fullscreen still covers the monitor
     * for that time.
     */
    _held() {
        const actor = this.win?.get_compositor_private();
        return !!actor?.__animationInfo &&
            !actor.get_transition('scale-x') && !actor.get_transition('scale-y');
    }

    _wanted() {
        const win = this.win;
        // hidden: the window is being dragged through the sidebar as an icon.
        // covered: the window picker of lib/shot.js draws the ring itself.
        if (!win || this.hidden || this.covered || !this.wm.config.values.focusRing.enabled)
            return false;
        if (win.is_fullscreen() || win.minimized || this._held())
            return false;
        // A window that is recorded or shared has the outline of
        // lib/privacy.js on it, with the focus and without.
        if (this.wm.fullSize.has(win))
            return false;
        const type = win.get_window_type();
        return type === Meta.WindowType.NORMAL || type === Meta.WindowType.DIALOG ||
            type === Meta.WindowType.MODAL_DIALOG || type === Meta.WindowType.UTILITY;
    }

    /** Follow the window: its strip position if tiled, else its frame. */
    sync() {
        if (!this._wanted()) {
            this.actor.hide();
            return;
        }
        const tile = this.wm.tiles.get(this.win);
        let frame = this.wm.drawnRect(this.win);
        // An attached dialog is drawn away from its frame, see
        // Tile._syncDialogs.
        const moved = !tile && this.wm.hostOf(this.win) ? this.win.get_compositor_private() : null;
        if (moved) {
            frame = {
                x: frame.x + moved.translation_x, y: frame.y + moved.translation_y,
                width: frame.width, height: frame.height,
            };
        }
        this.place(frame.x, frame.y, frame.width, frame.height);
        this.restack();
    }

    place(x, y, width, height) {
        if (!this._wanted()) {
            this.actor.hide();
            return;
        }
        const hidden = !this.actor.visible;
        this._place(x, y, width, height);
        // The ring comes up on a window that is fading in: a new window
        // that left its column, which was out of view, for the middle of
        // the monitor. It fades in too, and is not there before the window.
        if (hidden && this.actor.visible) {
            const actor = this.win.get_compositor_private();
            if (actor?.get_transition('opacity') && actor.opacity < 255)
                this._fadeIn();
        }
    }

    _place(x, y, width, height) {
        const w = this.wm.config.values.focusRing.width *
            St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.actor.set_position(x - w, y - w);
        this.actor.set_size(width + 2 * w, height + 2 * w);
        const drawn = this._animated();
        if (drawn && width > 0 && height > 0) {
            // The ring is laid out for the window at rest, then scaled and
            // moved onto the window as the shell draws it now, so its width
            // and its corners shrink with the window's.
            const kx = drawn.width / width;
            const ky = drawn.height / height;
            this.actor.set_pivot_point(0, 0);
            this.actor.set_scale(kx, ky);
            this.actor.translation_x = drawn.x - w * kx - (x - w);
            this.actor.translation_y = drawn.y - w * ky - (y - w);
            if (this.actor.has_clip)
                this.actor.remove_clip();
            this.actor.show();
            return;
        }
        this.actor.set_scale(1, 1);
        this.actor.translation_x = 0;
        this.actor.translation_y = 0;
        const strip = (this.wm.tiles.get(this.win) ?? this.wm.hostOf(this.win))?.strip;
        const clip = strip?.clipFor(x - w, width + 2 * w);
        // Nothing of the window is in the view. St asks for a redraw of the
        // whole ring whatever its clip, which can be on the next monitor.
        if (clip && clip[1] <= 0) {
            this.actor.hide();
            return;
        }
        if (clip)
            this.actor.set_clip(clip[0], 0, clip[1], height + 2 * w);
        else if (this.actor.has_clip)
            this.actor.remove_clip();
        this.actor.show();
    }

    /**
     * The window's frame as it is drawn while the shell animates the scale
     * of its actor: a window that opens or comes back from minimized, 400 ms
     * from nothing at a corner of the monitor, or one that leaves
     * fullscreen, 250 ms from the size of the monitor. null when it does not.
     *
     * The ring follows this frame. At the window's place at rest from the
     * first frame, it would be there before the window.
     */
    _animated() {
        const win = this.win;
        const actor = win?.get_compositor_private();
        const busy = actor?.get_transition('scale-x') ?? actor?.get_transition('scale-y');
        if (!busy) {
            // The shell sets a window it maps to the scale its animation
            // starts from, and starts the animation after an await. The
            // ring is at that scale until then, and is placed again
            // before the next frame, when the transition is there.
            if (!actor || !Main.wm._mapping?.has(actor))
                return null;
            this._shownId ||= global.compositor.get_laters().add(
                Meta.LaterType.BEFORE_REDRAW, () => {
                    this._shownId = 0;
                    this.sync();
                    return GLib.SOURCE_REMOVE;
                });
        } else if (this._busy !== busy) {
            this._busy = busy;
            // The shell animates the actor's position with transitions of
            // their own, and this one can be stepped before them. The ring
            // is placed once all of a frame's transitions have been.
            busy.connect('new-frame', () => {
                if (this._busy !== busy || this._laterId)
                    return;
                this._laterId = global.compositor.get_laters().add(
                    Meta.LaterType.BEFORE_REDRAW, () => {
                        this._laterId = 0;
                        // sync() and not the last place: on the frame the
                        // animation ends, the tile has a new place too.
                        if (!this._destroyed)
                            this.sync();
                        return GLib.SOURCE_REMOVE;
                    });
            });
            busy.connect('stopped', () => {
                if (this._busy !== busy)
                    return;
                this._busy = null;
                // After the shell's own handler for the end of its
                // animation, which runs in this same emission and puts the
                // actor's scale back.
                this._idleId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._idleId = 0;
                    this.sync();
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
        const buffer = win.get_buffer_rect();
        if (buffer.width <= 0 || buffer.height <= 0)
            return null;
        // From the actor's properties. Its allocation, which
        // get_transformed_position() reads, still has the position of the
        // frame before: the stage lays out after the transitions step.
        const kx = actor.scale_x;
        const ky = actor.scale_y;
        const [px, py] = actor.get_pivot_point();
        const pivotX = px * buffer.width;
        const pivotY = py * buffer.height;
        const frame = visibleRect(this.wm.config, win);
        return {
            x: actor.x + actor.translation_x + pivotX + kx * (frame.x - buffer.x - pivotX),
            y: actor.y + actor.translation_y + pivotY + ky * (frame.y - buffer.y - pivotY),
            width: frame.width * kx,
            height: frame.height * ky,
        };
    }

    restack() {
        const actor = this.win?.get_compositor_private();
        if (actor && actor.get_parent() === global.window_group)
            global.window_group.set_child_above_sibling(this.actor, actor);
    }

    destroy() {
        this.win?.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        if (this._shownId)
            global.compositor.get_laters().remove(this._shownId);
        this._shownId = 0;
        this._busy = null;
        this._leaving = null;
        for (const end of [...this._ghosts])
            end();
        this._destroyed = true;
        this.actor.destroy();
    }
}

export class Tiling {
    constructor(config, animator) {
        this.config = config;
        this.animator = animator;
        this._listeners = new Set();
        // Where a swipe or a slide of the workspaces is, see setBetween().
        this.between = {windows: null, workspaces: null};
        this._betweenListeners = new Set();
        this._slide = null;            // the MonitorGroup the shell slides the workspaces in
        this._movingWindow = null;     // the window a key is sending to another workspace, see moveToWorkspace
        this.glass = null;
    }

    enable() {
        this.tiles = new Map();
        this.strips = new Map();
        this.floating = new Set();     // floated by hand in this session
        this.floaters = new Map();     // window on no strip -> its Floater, while a key moves it
        // window on no strip -> the place it had before maximize-column
        // made it fill the view, see _toggleFloatFill.
        this._floatRestore = new WeakMap();
        this.raised = new Set();       // put over the other windows by layout.above
        // window -> the dialogs attached to it and to its dialogs, and each
        // of those dialogs -> that window. See Tile._syncDialogs.
        this.attached = new Map();
        this._hosts = new Map();
        this._recentring = new Map();  // window -> id of its size-changed handler, see _floatLate
        this.refused = new Set();      // did not take the size of a column, see _refusedSize
        this.forced = new Set();       // tiled by hand against the automatic rules
        this._born = new Map();        // window -> ms when it was created
        this._unmapped = new WeakSet();   // new windows the shell has not mapped yet
        // The apps of the windows closed last, newest last: {id, monitor}.
        this._closed = [];
        this._wantOpen = new WeakSet();   // mapped without the shell's animation, not faded in yet
        this._centred = new WeakSet(); // new floating windows already centred
        this._expected = null;         // {monitor, until}: where the launcher wants the next new window
        this._activeMonitor = -1;      // monitor of the last click or focus change
        this._switchedOn = -1;         // the active monitor when the workspace last changed
        this._touches = 0;             // fingers on a touchscreen
        this._currentId = 0;           // waits for a button release, see _makeCurrent
        this._afterId = 0;             // the same, see _afterPointer
        this._wantCurrent = null;
        // Set by the sidebar: {over(win, x, y), drop(win, x, y), leave()}.
        // A window dragged over the sidebar is handed to it.
        this.dragSink = null;
        // Set by the sidebar, for a swipe or a focus key over a fullscreen window:
        // {available(monitor), room(monitor), amount(), update(px),
        // end(velocity), hold(), held()}.
        this.peekSink = null;
        this._home = new Map();        // new window -> monitor it is being sent to
        this._rehomeHeld = false;      // see _moveToNeighbour
        this.focusTile = null;
        // The tile drawn at full size: the one that last had focus. It stays
        // while focus is on the launcher or on a floating window.
        this.currentTile = null;
        // Windows that are drawn at full size without the focus too.
        this.fullSize = new Set();
        this._middleId = 0;      // see focusInMiddle
        this.ring = new FocusRing(this);
        this.dropHint = new DropHint();
        // this.glass: the Glass of lib/glass.js, set by extension.js before
        // this, because the fade asks it for a layer.
        this.fade = new EdgeFade(this);
        this.fade.enable();
        this._drag = null;             // {tile, x, y, moved} while a window is dragged
        this._wsIds = new Map();
        this._wsSerial = 0;
        this._touchpad = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
        this.corners = new Corners(this.config);
        this.corners.enable();
        // A double click on a drawn title bar, or a click on its maximize
        // button, toggles the column to full width, once the click has
        // given the window focus.
        this.titlebars = new Titlebars(this.config, win => {
            if (this.focusTile?.win === win)
                this.maximizeColumn();
        });
        this.titlebars.enable();
        this.widths = new Widths(this.config);
        this.widths.enable();
        // window -> the share of the view its column had when it last left a
        // strip without closing: minimized, floated, set always on top.
        this._lastWidth = new WeakMap();

        this._patchWorkspaceAnimation();
        this._patchMapAnimation();

        global.display.connectObject(
            'window-created', (_d, win) => {
                this._born.set(win, GLib.get_monotonic_time() / 1000);
                this._unmapped.add(win);
                this._watch(win);
            },
            'notify::focus-window', () => this._onFocus(),
            'grab-op-begin', (_d, win, op) => this._onGrabBegin(win, op),
            'grab-op-end', (_d, win, op) => this._onGrabEnd(win, op),
            'window-entered-monitor', (_d, monitor, win) => {
                if (win === global.display.focus_window)
                    this._activeMonitor = monitor;
                this._rehome(win);
            },
            'workareas-changed', () => this._onWorkAreas(),
            // The view of a strip is the whole monitor under a fullscreen
            // window, so the clips of its windows change.
            'in-fullscreen-changed', () => this.layoutAll(true),
            'restacked', () => this.ring.restack(),
            'window-demands-attention', () => this._changed(),
            'window-marked-urgent', () => this._changed(),
            this);
        // After the shell's own handler, which was connected first.
        global.window_manager.connectObject(
            'map', (_wm, actor) => this._onMapped(actor), this);
        global.workspace_manager.connectObject(
            'workspace-removed', () => this._pruneStrips(),
            'workspaces-reordered', () => this._changed(),
            'workspace-added', () => this._changed(),
            'active-workspace-changed', () => {
                // Read before Mutter gives the focus to a window of the new
                // workspace, see _onWorkspaceSwitched().
                this._switchedOn = this.activeMonitor;
                this._switching = true;
                this.ring.sync();
                this._leaveCurrent();
                this._changed();
            },
            'workspace-switched', () => {
                this._switching = false;
                // Before a window is activated from here.
                this._noteLeft();
                // See _onFocus().
                const cover = this._refocus;
                this._refocus = null;
                if (cover && this.tiles.has(cover) && cover.is_fullscreen())
                    cover.activate(global.get_current_time());
                this._onWorkspaceSwitched();
                this._unpeekSoon();
            },
            this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            for (const win of [...this.tiles.keys()])
                this._rehome(win);
            this.layoutAll(false);
        }, this);
        // A click or a touch anywhere, on a window or on the empty desktop,
        // makes its monitor the one new windows open on.
        global.stage.connectObject('captured-event', (_stage, event) => {
            const type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN)
                this._touches++;
            else if (type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL)
                this._touches = Math.max(0, this._touches - 1);
            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const [x, y] = event.get_coords();
                const monitor = global.display.get_monitor_index_for_rect(
                    new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1}));
                this._activeMonitor = monitor >= 0 ? monitor : global.display.get_current_monitor();
                this._onDesktopPress(x, y, event.get_time());
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);
        global.stage.connectObject('event::touchpad',
            (_a, event) => this._onTouchpad(event), this);
    }

    /**
     * Give the windows that are open their tiles. extension.js calls this
     * once the sidebar is enabled: the places on a strip with a fullscreen
     * window depend on the room the sidebar takes (peekSink).
     *
     * Done at the end of enable(), before the sidebar is there, this
     * would ask a window over a fullscreen one for the wrong width after
     * an unlock. Measured: 945 px, half of a view as wide as the monitor,
     * drawn 87 px to the left of its place, then 0.3 s of motion to its
     * 858 px once the sidebar had set its strut.
     */
    adopt() {
        this._adopt();
        this._onFocus();
    }

    /**
     * keep: the screen is being locked, and enable() runs again at the
     * unlock. The windows stay drawn where they are, and the windows
     * floated by hand stay above the others, so the first frame after the
     * unlock is the last one before the lock.
     */
    disable(keep = false) {
        savedLayout = this._save(keep);

        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.stage.disconnectObject(this);
        for (const win of global.display.list_all_windows())
            win.disconnectObject(this);
        for (const win of [...this._recentring.keys()])
            this._stopRecentring(win);
        this._endDrag();

        for (const floater of [...this.floaters.values()])
            floater.stop();
        for (const tile of this.tiles.values())
            tile.destroy(!keep);
        if (!keep) {
            // Actors of windows that left the strip while translated.
            for (const actor of global.get_window_actors()) {
                actor.translation_x = 0;
                actor.translation_y = 0;
                clearClip(actor);
            }
            for (const win of [...this.floating, ...this.raised]) {
                if (win.is_above())
                    win.unmake_above();
            }
        }
        if (this._middleId)
            global.display.disconnect(this._middleId);
        this._middleId = 0;
        this.ring.destroy();
        this.dropHint.destroy();
        this.fade.disable();
        this.fade = null;
        this.titlebars.disable();
        this.titlebars = null;
        this.corners.disable();
        this.corners = null;
        this.widths.disable();
        this.widths = null;
        this._touchpad = null;
        this._swipe = null;
        if (this._currentId)
            GLib.source_remove(this._currentId);
        this._currentId = 0;
        if (this._afterId)
            GLib.source_remove(this._afterId);
        this._afterId = 0;
        if (this._unpeekId)
            global.compositor.get_laters().remove(this._unpeekId);
        this._unpeekId = 0;
        this._slide = null;
        this._switching = false;
        this._refocus = null;
        this._wantCurrent = null;
        this._currentPending = false;
        for (const strip of this.strips.values())
            strip.abortCover();
        this._unpatchWorkspaceAnimation();
        this._unpatchMapAnimation();
        this.tiles.clear();
        this.strips.clear();
        this.floating.clear();
        this.raised.clear();
        this.attached.clear();
        this._hosts.clear();
        this.refused.clear();
        this.forced.clear();
        this._born.clear();
        this._closed = [];
        this._home.clear();
        this._expected = null;
        this._listeners.clear();
        this.focusTile = null;
    }

    /**
     * What _adopt() needs to build the strips again as they are now: per
     * strip its columns with their windows, widths and heights, the scroll
     * and the window in focus, and for the whole the current tile and the
     * windows floated or tiled by hand.
     *
     * The order of the columns and their widths are not enough. With
     * those alone every strip would start at scroll 0 after an unlock,
     * with no focus and no current tile, and move to where the focus is
     * on the springs: a full-width window was measured 112 px to the left
     * of its place in the first frame. A window floated by hand would be
     * tiled again, and a fullscreen window would leave its strip.
     */
    _save(kept) {
        const current = this._currentPending ? this._wantCurrent : this.currentTile;
        return {
            kept,
            strips: [...this.strips.values()].map(strip => ({
                monitor: strip.monitor,
                workspace: strip.workspace,
                view: rectKey(strip.monitorRect),
                scroll: strip.scroll,
                freeScroll: strip.freeScroll,
                focus: strip.focus?.win ?? null,
                columns: strip.columns.filter(col => !col.pending).map(col => ({
                    proportion: col.proportion,
                    restore: col.restore,
                    pinned: col.pinned,
                    shared: col.shared,
                    active: col.active?.win ?? null,
                    tiles: col.tiles.map(tile => ({
                        win: tile.win,
                        weight: tile.weight,
                        minWidth: tile.minWidth,
                        cameFrom: tile.cameFrom,
                        // Where it is drawn once its springs are at rest.
                        at: tile.placed
                            ? [tile.x.target, tile.y.target, tile.shrink.target] : null,
                    })),
                })),
            })),
            current: current?.win ?? null,
            floating: [...this.floating],
            raised: [...this.raised],
            refused: [...this.refused],
            forced: [...this.forced],
            lastWidth: this._lastWidth,
            closed: this._closed,
            activeMonitor: this._activeMonitor,
        };
    }

    // ---- change notification, used by the minimap ----

    onChanged(fn) {
        this._listeners.add(fn);
    }

    _changed() {
        for (const fn of this._listeners)
            fn();
    }

    // ---- where a swipe is, used by the minimap ----
    // The minimap has a fill behind the active workspace and one behind
    // the icon of the focused window. A swipe changes the workspace or the
    // focus when the fingers lift, or later, so fills that move when those
    // change would stand still for the whole swipe and move after it.
    //
    // this.between tells where the swipe is while it lasts:
    //   windows: [from, to, share], two Meta.Windows, or null
    //   workspaces: [from, to, share], two workspace indices, or null
    // share is 0 at from and 1 at to.

    onBetween(fn) {
        this._betweenListeners.add(fn);
    }

    setBetween(what, value) {
        if (value === null && this.between[what] === null)
            return;
        this.between[what] = value;
        for (const fn of this._betweenListeners)
            fn();
    }

    /**
     * The window the strip of a workspace has in focus on the primary
     * monitor, by the index of the workspace: the one that takes the focus
     * when that workspace is shown. null for none.
     */
    focusOf(index) {
        const ws = global.workspace_manager.get_workspace_by_index(index);
        const primary = global.display.get_primary_monitor();
        for (const strip of this.strips.values()) {
            if (ws && strip.workspace === ws && strip.monitor === primary)
                return strip.focus?.win ?? null;
        }
        return null;
    }

    /**
     * The shell slides the workspaces of the primary monitor in group, a
     * MonitorGroup. While the fingers of a swipe do that, and when it goes
     * on by itself after they have lifted, its progress is told as the two
     * workspaces it is between, until the group is destroyed.
     *
     * Not for a slide after a key. The workspace changes before that
     * slide, so the rows of the minimap change their heights during it,
     * and a fill held between two rows that move goes 12 px past its place
     * and back (measured). The fill goes to its row by itself there, in
     * the time the rows take.
     */
    _followSlide(group) {
        this._slide = group;
        const update = () => {
            if (this._slide !== group)
                return;
            const animation = Main.wm._workspaceAnimation;
            const swiped = animation?._swipeTracker?._state === 1 ||
                animation?._switchData?.gestureActivated === true;
            if (!swiped)
                return;
            const points = (group._workspaceGroups ?? [])
                .filter(g => g.workspace)
                .map(g => ({index: g.workspace.index(), at: group.getWorkspaceProgress(g.workspace)}))
                .sort((a, b) => a.at - b.at);
            if (points.length === 0)
                return;
            const p = group.progress;
            const a = points.findLast(point => point.at <= p) ?? points[0];
            const b = points.find(point => point.at >= p) ?? points.at(-1);
            const share = b.at > a.at ? clamp((p - a.at) / (b.at - a.at), 0, 1) : 0;
            this.setBetween('workspaces', [a.index, b.index, share]);
        };
        group.connect('notify::progress', update);
        group.connect('destroy', () => {
            if (this._slide !== group)
                return;
            this._slide = null;
            this.setBetween('workspaces', null);
            // The workspace that was entered is at rest now. After a
            // swipe the shell changes the workspace when the slide is
            // over, right before this: _unpeekSoon() is waiting then, and
            // looks once Mutter knows which monitor is in fullscreen.
            if (!this._unpeekId)
                this._unpeekBack();
        });
    }

    /**
     * The workspace has changed. What was shown over a fullscreen window
     * is put away, so that a workspace with a fullscreen window is that
     * window alone again after it was left: the sidebar leaves now, if
     * the workspace that is entered has a fullscreen window too, and the
     * windows over the fullscreen one of a workspace that was left slide
     * out when that workspace is back and at rest (Strip.unpeek).
     *
     * Before the next frame: the shell has made the slide by then, if
     * there is one, and Mutter has looked at which monitor is in
     * fullscreen, so the sidebar knows whether it is still over a
     * fullscreen window.
     */
    _unpeekSoon() {
        this._unpeekId ||= global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._unpeekId = 0;
            if (this.peekSink?.held())
                this.peekSink.end(0);
            // The slide ends in _followSlide().
            if (!this._slide)
                this._unpeekBack();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The workspace has changed: which strips have been left, for
     * _unpeekBack().
     *
     * A workspace that comes back because one of its windows was
     * activated, from the sidebar or the switcher, is not one that was
     * left and returned to: the window was chosen, and stays over the
     * fullscreen one. Mutter sets the time a window was last used when it
     * is activated, and not when it gives the focus to the window used
     * last on a workspace that is entered, so a time later than the ones
     * the strip had when it was left tells the two apart.
     */
    _noteLeft() {
        const active = global.workspace_manager.get_active_workspace();
        const used = strip => Math.max(0, ...strip.tiles.map(t => t.win.get_user_time()));
        for (const strip of this.strips.values()) {
            if (!strip.workspace)
                continue;
            if (strip.workspace !== active) {
                if (!strip.left)
                    strip.usedAt = used(strip);
                strip.left = true;
            } else if (strip.left && used(strip) > strip.usedAt) {
                strip.left = false;
            }
        }
    }

    /** The workspace that is shown is at rest, see _unpeekSoon(). */
    _unpeekBack() {
        const active = global.workspace_manager.get_active_workspace();
        for (const strip of this.strips.values()) {
            if (strip.workspace !== active || !strip.left)
                continue;
            strip.left = false;
            strip.unpeek();
        }
    }

    // ---- strips ----

    _wsId(ws) {
        if (!this._wsIds.has(ws))
            this._wsIds.set(ws, ++this._wsSerial);
        return this._wsIds.get(ws);
    }

    /** A number that a workspace keeps while it exists, whatever its index. */
    workspaceId(ws) {
        return this._wsId(ws);
    }

    _stripWorkspace(win, monitor = win.get_monitor()) {
        const perMonitor = Meta.prefs_get_workspaces_only_on_primary() &&
            monitor !== global.display.get_primary_monitor();
        return perMonitor ? null : win.get_workspace();
    }

    _strip(monitor, ws) {
        const key = `${monitor}:${ws ? this._wsId(ws) : 'all'}`;
        let strip = this.strips.get(key);
        if (!strip) {
            strip = new Strip(this, monitor, ws);
            this.strips.set(key, strip);
        }
        return strip;
    }

    _stripFor(win) {
        // A new window the launcher started counts as on the launcher's
        // monitor before Mutter has moved it there.
        const monitor = this._home.get(win) ?? win.get_monitor();
        if (monitor < 0)
            return null;
        const ws = this._stripWorkspace(win, monitor);
        if (!ws && !(Meta.prefs_get_workspaces_only_on_primary() &&
            monitor !== global.display.get_primary_monitor()))
            return null;
        return this._strip(monitor, ws);
    }

    /**
     * The strip the keys and the swipe act on: the one of the focused
     * window, or without one, the strip on the active workspace of the
     * active monitor (see activeMonitor).
     */
    activeStrip() {
        if (this.focusTile?.strip)
            return this.focusTile.strip;
        return this._stripOn(this.activeMonitor);
    }

    /** The strip a monitor shows now. */
    _stripOn(monitor) {
        const primary = global.display.get_primary_monitor();
        const perMonitor = Meta.prefs_get_workspaces_only_on_primary() && monitor !== primary;
        return this._strip(monitor,
            perMonitor ? null : global.workspace_manager.get_active_workspace());
    }

    isActiveStrip(strip) {
        return !strip.workspace ||
            strip.workspace === global.workspace_manager.get_active_workspace();
    }

    _pruneStrips() {
        const n = global.workspace_manager.get_n_workspaces();
        const live = new Set();
        for (let i = 0; i < n; i++)
            live.add(global.workspace_manager.get_workspace_by_index(i));
        for (const [key, strip] of this.strips) {
            if (strip.workspace && !live.has(strip.workspace) && strip.columns.length === 0)
                this.strips.delete(key);
        }
        for (const ws of [...this._wsIds.keys()]) {
            if (!live.has(ws))
                this._wsIds.delete(ws);
        }
        this._changed();
    }

    layoutAll(animate = true) {
        for (const strip of this.strips.values())
            strip.layout(animate);
        this.ring?.sync();
    }

    /**
     * The work areas changed. Mutter then makes every window that is
     * wider than its work area that narrow. The sidebar's strut comes and
     * goes with a fullscreen window in view (Sidebar._placeStrut), so a
     * window as wide as the monitor over a fullscreen one is made narrower
     * when another workspace is shown. Its frame is asked for again here,
     * which gives it its width back when its workspace is shown again.
     */
    _onWorkAreas() {
        this.layoutAll(true);
        for (const tile of this.tiles.values()) {
            if (tile._missized()) {
                tile._retries = 0;
                tile.applyFrame(true);
            }
        }
    }

    // ---- the sidebar changes its width ----
    // The sidebar collapses or expands over some frames (Super+B), and the
    // room it takes from the windows changes with it. The windows go to
    // their new places in the same frames: the left edge of the first
    // column stays one gap from the cards all the way.
    //
    // The windows are asked for their new frames once, when the cards
    // start to move. From then on each tile is drawn between where it was
    // and its new place, by the share of the way the cards have gone, and
    // at a width between the two the same way. A client takes its new size
    // some frames later, and the picture of the window is scaled to the
    // width for that frame, as it is for every other change of width.
    //
    // With the frames asked for when the cards have arrived, the cards
    // moved first and the windows after them. With the tiles on their
    // springs from the start, they would move at another pace than the
    // cards, and each would change its width only when its client has
    // answered: a window would move over first and grow after that.

    /**
     * The sidebar starts to change its width. change() gives the windows
     * their new room (the sidebar's strut), and the work areas are read
     * from it before it returns.
     */
    glideBegin(change) {
        this.glideEnd();
        const from = new Map();
        for (const tile of this.tiles.values()) {
            if (tile.placed && tile.target && tile._sized && !tile.fullscreen && !tile.grabbed) {
                from.set(tile, {
                    x: tile.x.value, w: tile.w.value, free: false,
                    tx: tile.target.x, tw: tile.target.width,
                });
            }
        }
        change();
        this.layoutAll(true);
        for (const [tile, glide] of from) {
            const t = tile.target;
            // A tile that keeps its place is left on its springs: one on
            // another monitor.
            if (tile.dead || !t || (t.x === glide.tx && t.width === glide.tw))
                continue;
            tile._glide = glide;
        }
        this.glideStep(0);
    }

    /** The cards have gone this share of their way, 0 to 1. */
    glideStep(share) {
        let moved = false;
        for (const tile of this.tiles.values()) {
            const glide = tile._glide;
            if (!glide)
                continue;
            const t = tile.target;
            if (tile.dead || !t || tile.fullscreen || tile.grabbed) {
                tile._glide = null;
                continue;
            }
            // A swipe took the strip: the fingers and then the springs
            // have its place from here on.
            if (tile.strip?._swipe)
                glide.free = true;
            tile._middle = tile._middleX = null;
            if (!glide.free)
                tile.x.set(glide.x + (t.x - glide.x) * share);
            tile.w.set(glide.w + (t.width - glide.w) * share);
            tile.sync();
            moved = true;
        }
        if (moved)
            this.ring?.sync();
    }

    /**
     * The cards have arrived, or stopped on the way. Every tile goes on
     * from where it is drawn now, on its springs: to its place, and to the
     * width its frame has.
     */
    glideEnd() {
        for (const tile of this.tiles.values()) {
            if (!tile._glide)
                continue;
            tile._glide = null;
            if (tile.dead || !tile.target)
                continue;
            tile.x.target = tile.target.x;
            // A client that has not taken its new size yet keeps the width
            // the tile is drawn at, until it has (size-changed), or until
            // the check of its width. On the spring now, the window would
            // go back towards its old width first.
            if (tile._fits())
                tile._followSize();
            this.animator.add(tile);
        }
    }

    /**
     * The sidebar shows more or less of itself over a fullscreen window.
     * The tiles of that strip are drawn again, see Strip.push.
     */
    peekMoved() {
        for (const strip of this.strips.values()) {
            if (!strip._shift)
                continue;
            for (const tile of strip.tiles)
                tile.sync();
        }
    }

    // ---- which windows tile ----

    _shouldTile(win) {
        if (win.is_override_redirect() || win.minimized || isHelper(win))
            return false;
        if (win.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        if (win.get_transient_for() || win.is_skip_taskbar())
            return false;
        if (win.is_always_on_all_workspaces() || win.is_above())
            return false;
        if (this.floating.has(win))
            return false;
        // A fullscreen window allows no resize and cannot be maximized,
        // whatever it is when it is not fullscreen. One that is a tile
        // stays a tile. Asked like any window when it is shown again,
        // which is every return to its workspace, it would leave the strip
        // there: no key would reach it, and leaving fullscreen would not
        // bring it back.
        if (win.is_fullscreen() && this.tiles.has(win))
            return true;
        if (!win.allows_resize())
            return false;
        if (this.forced.has(win))
            return true;
        if (this.refused.has(win))
            return false;
        return !this._looksFloating(win);
    }

    /**
     * Automatic rules for a window that could tile. toggle-float overrides
     * them for one window in either direction.
     */
    _looksFloating(win) {
        // A maximum size smaller than the work area: a fixed-size prompt.
        if (!win.can_maximize())
            return true;
        if (FLOAT_ROLES.has((win.get_role() ?? '').toLowerCase()))
            return true;
        const names = appNames(win);
        const title = win.get_title() ?? '';
        if (FLOAT_RULES.some(r =>
            (!r.app || names.some(name => r.app.test(name))) && r.title.test(title)))
            return true;
        const lower = title.toLowerCase();
        for (const pattern of this.config.values.layout.float) {
            const p = String(pattern).toLowerCase();
            if (p && (lower.includes(p) || names.some(name => name.includes(p))))
                return true;
        }
        return false;
    }

    /**
     * A new window that an automatic rule keeps out of the strip opens in
     * the middle of its monitor, where the launcher opens. Mutter would put
     * it in the top left corner, because the tiled windows leave no free
     * space for its placement to find. X11 clients choose their own position
     * and keep it.
     */
    _centreNew(win) {
        if (!this._born.has(win) || this._centred.has(win) || this.tiles.has(win))
            return;
        this._centred.add(win);
        if (win.get_client_type() !== Meta.WindowClientType.WAYLAND ||
            win.get_window_type() !== Meta.WindowType.NORMAL || isHelper(win) ||
            win.get_transient_for() || win.is_fullscreen() || !this._looksFloating(win))
            return;
        this._centre(win);
    }

    /** Size and centre a window that has just left the strip. */
    _placeFloating(win, area) {
        const w = Math.round(area.width * 0.55);
        const h = Math.round(area.height * 0.7);
        win.move_resize_frame(true,
            area.x + Math.round((area.width - w) / 2),
            area.y + Math.round((area.height - h) / 2), w, h);
    }

    /**
     * A title that arrives just after the window opened can match a float
     * rule the first check could not see. The window was given a column by
     * then, so it leaves the strip here.
     */
    _onTitle(win) {
        this._changed();
        const born = this._born.get(win);
        const tile = this.tiles.get(win);
        if (!tile || born === undefined ||
            GLib.get_monotonic_time() / 1000 - born > LATE_TITLE_MS)
            return;
        if (this._shouldTile(win))
            return;
        const area = tile.strip.area;
        this._untrack(win, false, true);
        this._placeFloating(win, area);
        this._raise(win);
    }

    /**
     * A window that got a column and turned out not to belong on the strip
     * leaves it: in the middle of its monitor at the size it has, and over
     * the other windows if layout.above names its app.
     *
     * The title is one way to find out, see _onTitle. It is not enough:
     * 1Password opens every prompt as a window that can be resized and
     * maximized, and only Quick Access has a title rule. By the title
     * alone, its request to use an SSH key would get a column and would
     * not be always on top. The two signs used here do not need the
     * title: the window stops allowing a resize (_onResizeable), or it
     * did not take the size of its column (_settleLater).
     */
    _floatLate(win) {
        if (!this.tiles.has(win))
            return;
        this._untrack(win, false, this._isNew(win));
        this._centre(win);
        // Out of its column, the client can go back to a size of its own.
        const until = GLib.get_monotonic_time() / 1000 + PENDING_MS;
        this._stopRecentring(win);
        this._recentring.set(win, win.connect('size-changed', () => {
            if (GLib.get_monotonic_time() / 1000 > until || this.tiles.has(win))
                this._stopRecentring(win);
            else
                this._centre(win);
        }));
        this._raise(win);
    }

    /** End the size-changed handler _floatLate() gave a window. */
    _stopRecentring(win) {
        const id = this._recentring.get(win);
        if (id === undefined)
            return;
        this._recentring.delete(win);
        win.disconnect(id);
    }

    /** Put a window in the middle of its monitor. */
    _centre(win) {
        const frame = win.get_frame_rect();
        const m = global.display.get_monitor_geometry(win.get_monitor());
        win.move_frame(true,
            m.x + Math.round((m.width - frame.width) / 2),
            m.y + Math.round((m.height - frame.height) / 2));
    }

    /** Whether a name of the window's app (appNames) contains one of the names of a layout list. */
    _named(win, list) {
        if (!Array.isArray(list))
            return false;
        const names = appNames(win);
        return list.some(p => String(p) &&
            names.some(name => name.includes(String(p).toLowerCase())));
    }

    /**
     * Size limits that arrive after the first configure. A fullscreen tile
     * allows no resize either and stays a tile, see _shouldTile.
     */
    _onResizeable(win) {
        if (this.tiles.has(win) && !win.is_fullscreen() && !this._shouldTile(win))
            this._floatLate(win);
    }

    /**
     * Whether the window is much smaller than the place its column gave
     * it: a client that draws at a size of its own whatever it is told.
     */
    _refusedSize(tile) {
        const t = tile.target;
        if (!t || tile.fullscreen)
            return false;
        const f = tile.win.get_frame_rect();
        return f.width < t.width * REFUSED_SIZE || f.height < t.height * REFUSED_SIZE;
    }

    /**
     * The window an attached dialog is drawn with: its parent, or the
     * parent of the dialog it is attached to. null for any other window.
     */
    _hostWindow(win) {
        if (win.is_override_redirect())
            return null;
        let host = win;
        for (let n = 0; n < 8 && host?.is_attached_dialog(); n++)
            host = host.get_transient_for();
        return host && host !== win ? host : null;
    }

    /** The tile of the window an attached dialog is drawn with, or null. */
    hostOf(win) {
        const host = this._hosts.get(win);
        return host ? this.tiles.get(host) ?? null : null;
    }

    /**
     * List a window as a dialog of the window it is attached to, or take it
     * off the list when it is attached to none. A window is asked when it
     * is shown, when its type changes (a client can say that it is modal
     * after it has opened) and when it takes the focus.
     */
    _attach(win) {
        const host = this._hostWindow(win);
        if (host === (this._hosts.get(win) ?? null))
            return;
        this._detach(win);
        if (!host)
            return;
        this._hosts.set(win, host);
        if (!this.attached.has(host))
            this.attached.set(host, new Set());
        this.attached.get(host).add(win);
        this.tiles.get(host)?.sync();
    }

    /** reset: the dialog is drawn at its frame again. Not for one that is closing. */
    _detach(win, reset = true) {
        const host = this._hosts.get(win);
        if (!host)
            return;
        this._hosts.delete(win);
        const dialogs = this.attached.get(host);
        dialogs?.delete(win);
        if (dialogs?.size === 0)
            this.attached.delete(host);
        const actor = reset ? win.get_compositor_private() : null;
        if (actor) {
            actor.translation_x = 0;
            actor.translation_y = 0;
            clearClip(actor);
        }
    }

    _watch(win) {
        win.connectObject(
            'configure', (_w, config) => this._onConfigure(win, config),
            'shown', () => {
                this._sendHome(win);
                this._retile(win);
                this._centreNew(win);
                this._settleLater(win);
                this._attach(win);
            },
            'position-changed', () => this.hostOf(win)?.sync(),
            'size-changed', () => this.hostOf(win)?.sync(),
            'notify::window-type', () => this._attach(win),
            'unmanaging', () => this._onUnmanaging(win),
            'workspace-changed', () => this._rehome(win),
            'notify::minimized', () => this._onMinimized(win),
            'notify::fullscreen', () => this._onFullscreen(win),
            'notify::maximized-horizontally', () => this._onMaximized(win),
            'notify::maximized-vertically', () => this._onMaximized(win),
            'notify::above', () => this._retile(win),
            'raised', () => this._onRaised(win),
            'notify::resizeable', () => this._onResizeable(win),
            'notify::title', () => this._onTitle(win),
            this);
    }

    /**
     * A window was raised: by a click on it, also when it has the focus
     * and is on top already, or because it was activated. The sidebar that
     * was brought in over a fullscreen window leaves then: the work goes
     * on in the window. The stage is not told of a press that goes to a
     * window, so this signal is what there is for a click.
     */
    _onRaised(win) {
        const peek = this.peekSink;
        if (peek?.held() && peek.available(win.get_monitor()))
            peek.end(0);
    }

    /**
     * First configure of a new window: give it its column before it draws.
     * Do not call config.get_rect() here: in Mutter 51 the returned rectangle
     * is freed twice once GJS collects it, which aborts the shell.
     *
     * Nor config.set_rect(): Mutter 51 reads the rectangle after GJS has
     * freed it. What arrives is the memory of a freed rectangle: observed,
     * a new window at x = 318107456, y = 21945 (the two halves of a heap
     * address) with a size of its own, moved to its place 25 to 95 ms
     * after it was shown, and Firefox told 3826 x 1440 and drawing its
     * first frame that size. The place is given as four numbers.
     */
    _onConfigure(win, config) {
        try {
            if (!config.get_is_initial() || this.tiles.has(win) || !this._shouldTile(win))
                return;
            if (config.get_is_fullscreen())
                return;
            this._claimExpected(win);
            const maximized = config.get_maximize_flags() !== Meta.MaximizeFlags.NONE;
            const tile = this._track(win, {
                proportion: maximized ? 1 : null,
                apply: false,
                pending: this._mayFloatLate(win),
            });
            if (!tile?.target)
                return;
            if (maximized)
                config.set_maximize_flags(Meta.MaximizeFlags.NONE);
            const area = tile.strip.area;
            const t = tile.target;
            const x = clamp(t.x, area.x, Math.max(area.x, area.x + area.width - t.width));
            config.set_position(x, t.y);
            config.set_size(t.width, t.height);
            tile._request = {x, y: t.y, width: t.width, height: t.height};
        } catch (e) {
            console.error(e);
        }
    }

    /**
     * The active monitor: the one of the last click or touch, or the
     * monitor of the window that last took focus. New windows open there.
     */
    get activeMonitor() {
        const n = global.display.get_n_monitors();
        return this._activeMonitor >= 0 && this._activeMonitor < n
            ? this._activeMonitor : global.display.get_current_monitor();
    }

    /** Make a monitor the active one. For the hot corner of that monitor. */
    setActiveMonitor(monitor) {
        if (monitor >= 0 && monitor < global.display.get_n_monitors())
            this._activeMonitor = monitor;
    }

    /**
     * A press on the desktop of a monitor: not on a window, and not on one
     * of the shell's own actors. A press on a window gives that window the
     * focus. One on the desktop takes the focus from every window, on every
     * monitor: no window has the focus ring, and every tile is drawn at
     * windows.unfocusedScale. The pressed monitor is the active one (set by
     * the caller), so the keys act on its strip.
     */
    _onDesktopPress(x, y, time) {
        if (Main.actionMode !== Shell.ActionMode.NORMAL)
            return;
        if (!this._isDesktop(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)))
            return;
        if (global.display.focus_window)
            global.display.unset_input_focus(time);
        this._makeCurrent(null);
    }

    /** Whether an actor found under the pointer is the desktop. */
    _isDesktop(actor) {
        if (!actor || actor === global.stage)
            return true;
        for (let a = actor; a; a = a.get_parent()) {
            // A desktop icons extension draws its icons in a window.
            if (a instanceof Meta.WindowActor)
                return a.meta_window?.get_window_type() === Meta.WindowType.DESKTOP;
            if (a === global.window_group)
                return true;
        }
        return false;
    }

    /**
     * A press that closed the launcher: the launcher had the pointer, so the
     * press did not reach what is drawn there. The window at the point gets
     * the focus. With no window there, the monitor does (focusMonitor).
     */
    focusAt(x, y) {
        const monitor = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width: 1, height: 1}));
        if (monitor < 0)
            return;
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor && !(actor instanceof Meta.WindowActor))
            actor = actor.get_parent();
        const win = actor?.meta_window;
        if (win && !win.is_override_redirect() && !isHelper(win) &&
            win.get_window_type() !== Meta.WindowType.DESKTOP) {
            this.setActiveMonitor(monitor);
            win.activate(global.get_current_time());
            return;
        }
        this.focusMonitor(monitor);
    }

    /**
     * Keep a window drawn as the one with the focus while it has none (on),
     * or let it be drawn smaller again. A cast of a window shows the window
     * as it is drawn, so a recorded or shared window is kept at full size,
     * and the ring leaves it to the outline that marks it.
     */
    setFullSize(win, on) {
        if (on)
            this.fullSize.add(win);
        else
            this.fullSize.delete(win);
        const tile = this.tiles.get(win);
        tile?.setCurrent(tile === this.currentTile, true);
        // The clip of the tile's actor is with the recording while it runs.
        tile?.sync();
        this.ring.sync();
    }

    /**
     * Give a window the focus, and slide its column to the middle of the
     * view as center-column does. The column is placed once the focus is on
     * it: the view follows a focus that goes to another column. A window on
     * no strip has the focus and stays where it is.
     */
    focusInMiddle(win) {
        const middle = () => {
            const tile = this.tiles.get(win);
            if (!tile?.strip)
                return;
            tile.strip.place(tile.column, 'middle');
            tile.strip.layout(true);
            this._changed();
        };
        if (this._middleId)
            global.display.disconnect(this._middleId);
        this._middleId = 0;
        if (global.display.focus_window === win) {
            middle();
            return;
        }
        // After the handler of this class, which was connected first.
        this._middleId = global.display.connect('notify::focus-window', () => {
            global.display.disconnect(this._middleId);
            this._middleId = 0;
            if (global.display.focus_window === win)
                middle();
        });
        win.activate(global.get_current_time());
    }

    /**
     * Where a window is drawn now, {x, y, width, height}: its place on the
     * strip with its scale if it is tiled, else its frame.
     */
    drawnRect(win) {
        const tile = this.tiles.get(win);
        // A fullscreen tile is drawn at its frame, which is its monitor,
        // and not at the place its column has (Tile.sync).
        if (tile?.fullscreen) {
            const frame = win.get_frame_rect();
            return {
                x: frame.x + Math.round(tile.nudge.value),
                y: frame.y + Math.round(tile.nudgeY.value),
                width: frame.width, height: frame.height,
            };
        }
        if (tile?.target && !tile.grabbed)
            return tile.drawn();
        // A window on no strip that a key is moving has a Floater.
        return tile?.heldRect() ?? this.floaters.get(win)?.drawn() ??
            visibleRect(this.config, win);
    }

    /**
     * Make a monitor the one the keys act on, from its card in the sidebar.
     * The focus goes to the window that last had it there. With no window
     * there, no window has the focus.
     */
    focusMonitor(monitor) {
        this.setActiveMonitor(monitor);
        const time = global.get_current_time();
        const next = this.focusable(monitor);
        if (next) {
            next.activate(time);
            return;
        }
        if (global.display.focus_window)
            global.display.unset_input_focus(time);
        this._makeCurrent(null);
    }

    /**
     * The window a monitor gives the focus to, on the active workspace: the
     * one used last that is not minimized. null when it shows no window.
     */
    focusable(monitor) {
        const workspace = global.workspace_manager.get_active_workspace();
        return global.display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .find(w => w.get_monitor() === monitor && !w.minimized && !isHelper(w)) ?? null;
    }

    /** The next new window opens on this monitor. The launcher calls this. */
    expectWindow(monitor, ms = EXPECT_WINDOW_MS) {
        this._expected = {monitor, until: GLib.get_monotonic_time() / 1000 + ms};
    }

    /** Give a new window the monitor the launcher asked for, if it asked. */
    _claimExpected(win) {
        if (this._home.has(win))
            return;
        if (win.get_window_type() !== Meta.WindowType.NORMAL || win.get_transient_for())
            return;
        // The launcher's monitor if it started this window, else the active
        // monitor.
        const e = this._expected;
        this._expected = null;
        const expected = e && GLib.get_monotonic_time() / 1000 <= e.until &&
            e.monitor < global.display.get_n_monitors();
        // Set even when the window is on that monitor now: Mutter can move a
        // new window to another monitor between its first configure and its
        // first show.
        this._home.set(win, expected ? e.monitor : this.activeMonitor);
    }

    /** First show of a new window: move it to the launcher's monitor if it is not there. */
    _sendHome(win) {
        if (this._born.has(win) && !this._centred.has(win) && !this.tiles.has(win))
            this._claimExpected(win);
        const monitor = this._home.get(win);
        if (monitor === undefined)
            return;
        this._home.delete(win);
        if (win.get_monitor() !== monitor)
            win.move_to_monitor(monitor);
    }

    /** Whether the window opened less than LATE_TITLE_MS ago. */
    _isNew(win) {
        const born = this._born.get(win);
        return born !== undefined && GLib.get_monotonic_time() / 1000 - born <= LATE_TITLE_MS;
    }

    /** Tile the window if it should be tiled and is not, or the reverse. */
    _retile(win) {
        const tile = this.tiles.get(win);
        const should = this._shouldTile(win);
        if (should && !tile) {
            this._track(win, {pending: this._isNew(win) && this._mayFloatLate(win)});
        } else if (!should && tile) {
            this._untrack(win, false, this._isNew(win));
        } else if (tile) {
            // Shown after the initial configure: make sure the frame took.
            tile.applyFrame(true);
            tile.sync();
        }
        this._raise(win);
    }

    /**
     * layout.above: a window of one of these apps that is not on the strip
     * is set always on top. A tiled window that gets the focus is raised
     * over every floating one, and a prompt of 1Password (Quick Access, the
     * request to use an SSH key) would then be behind the columns, where
     * nothing shows that it waits for an answer.
     *
     * A window that is on the strip, or about to be, is left alone: one
     * that is always on top never tiles.
     */
    _raise(win) {
        if (win.is_above() || this.tiles.has(win) || win.minimized ||
            win.is_override_redirect() || isHelper(win))
            return;
        const type = win.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG && type !== Meta.WindowType.UTILITY)
            return;
        if (!this._named(win, this.config.values.layout.above))
            return;
        if (this._shouldTile(win))
            return;
        this.raised.add(win);
        win.make_above();
    }

    /**
     * Whether a new window of this class can leave the strip a moment after
     * it opened: a float rule names the class, and the title the rule looks
     * for may not be set yet. Its column is pending until the window has
     * been shown for PENDING_MS.
     */
    _mayFloatLate(win) {
        const names = appNames(win);
        return FLOAT_RULES.some(r => r.app && names.some(name => r.app.test(name)));
    }

    /** PENDING_MS after a new window is shown, its pending column counts. */
    _settleLater(win) {
        const tile = this.tiles.get(win);
        if (!tile?.column?.pending || tile._pendingId)
            return;
        tile._pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PENDING_MS, () => {
            tile._pendingId = 0;
            const strip = tile.strip;
            if (tile.dead || !strip || !tile.column?.pending)
                return GLib.SOURCE_REMOVE;
            if (this._refusedSize(tile)) {
                this.refused.add(win);
                this._floatLate(win);
                return GLib.SOURCE_REMOVE;
            }
            tile.column.pending = false;
            // In the middle of the view as far as the strip allows, as any
            // new window: see _onFocus.
            tile.fresh = false;
            if (strip.focus === tile)
                strip.place(tile.column, 'middle');
            strip.layout(true);
            this.ring.sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _track(win, {proportion = null, index = null, apply = true, pending = false} = {}) {
        if (this.tiles.has(win) || !win.get_compositor_private())
            return null;
        const strip = this._stripFor(win);
        if (!strip)
            return null;
        // The tile writes the scale and the place of the same actor.
        this.floaters.get(win)?.stop();
        const tile = new Tile(this, win);
        // What the strip showed before this window. _untrack puts it back
        // when a new window turns out to float.
        tile.before = {
            scroll: strip.scroll,
            freeScroll: strip.freeScroll,
            focus: strip.focus,
            current: this.currentTile,
        };
        this.tiles.set(win, tile);
        tile.opening = this._unmapped.has(win) || this._wantOpen.has(win);
        // A window that has just opened, for the place the view gives it
        // when it takes the focus, see _onFocus.
        tile.fresh = this._isNew(win);
        // A window that opens over a fullscreen one came in as one does
        // after a swipe or a focus key. When it leaves or closes, the
        // windows that were over the fullscreen one before it return to
        // the places they had, see Strip._coverLeave and coverGone.
        // Without the scroll kept here, the window that stays would go to
        // the left edge of the monitor.
        if (strip.cover && !win.is_fullscreen())
            tile.cameFrom = strip.scroll;
        if (apply && win.is_maximized?.()) {
            this._unmaximize(win);
            proportion = 1;
        }
        strip.addColumn(tile, index, proportion ?? this._rememberedWidth(win));
        tile.column.pending = pending;
        if (!apply) {
            // Inside the configure handler: compute places, leave this
            // window's frame to the configure result.
            tile.grabbed = true;
            strip.layout(true);
            tile.grabbed = false;
            tile.sync();
        } else {
            strip.layout(true);
        }
        // Mapped before it had a tile.
        if (this._wantOpen.delete(win))
            tile.open(true);
        this._changed();
        return tile;
    }

    /**
     * Keep the app of a window that closes, for reopen-closed. Only a
     * window with an icon in the sidebar counts, and only an app that has a
     * desktop file, since that is what can be started again.
     */
    _rememberClosed(win) {
        if (!this._listed(win))
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app || app.is_window_backed())
            return;
        this._closed.push({id: app.get_id(), monitor: win.get_monitor()});
        if (this._closed.length > CLOSED_MAX)
            this._closed.shift();
    }

    /**
     * Open a new window of the app whose window was closed last, on the
     * monitor that window was on. Each call goes one closed window further
     * back. The app opens the window, so what it shows is the app's choice:
     * a browser opens a new window, not the tabs the closed one had.
     */
    reopenClosed() {
        for (;;) {
            const closed = this._closed.pop();
            if (!closed)
                return;
            const app = Shell.AppSystem.get_default().lookup_app(closed.id);
            if (!app)
                continue;
            if (closed.monitor >= 0 && closed.monitor < global.display.get_n_monitors())
                this.expectWindow(closed.monitor);
            app.open_new_window(-1);
            return;
        }
    }

    /**
     * The width for a window that enters a strip with none given: the one it
     * had the last time it was tiled, else the one stored for its app. null
     * gives layout.defaultWidth.
     */
    _rememberedWidth(win) {
        return this._lastWidth.get(win) ?? this.widths.get(win);
    }

    /**
     * restore: the window is new and an automatic rule has taken it out of
     * the strip again. A prompt can declare its fixed size, or set the
     * title a float rule matches, after it was given a column at its first
     * configure. The view had scrolled to that column when the window took
     * focus. It goes back to where it was, with the focus column and the
     * current tile it had, so a prompt that opens leaves the strip as it
     * found it.
     */
    _untrack(win, closing = false, restore = false) {
        const tile = this.tiles.get(win);
        if (!tile)
            return;
        const strip = tile.strip;
        if (!closing && tile.column)
            this._lastWidth.set(win, tile.column.proportion);
        // The window that is in view once this one is gone: the one the
        // focus goes to, see _onUnmanaging.
        const stays = strip && tile.column && strip.focus === tile
            ? strip.successor(tile) : strip?.focus ?? null;
        strip?.remove(tile);
        if (!restore && strip && tile.cameFrom !== null)
            strip.coverGone(stays, tile.cameFrom);
        if (restore && strip && tile.before) {
            const {scroll, freeScroll, focus, current} = tile.before;
            strip.scroll = scroll;
            strip.freeScroll = freeScroll;
            if (focus?.strip === strip)
                strip.focus = focus;
            if (this.currentTile === tile && current && this.tiles.get(current.win) === current)
                this.currentTile = current;
        }
        tile.destroy(!closing);
        this.tiles.delete(win);
        if (this.focusTile === tile)
            this.focusTile = null;
        strip?.layout(true);
        this._changed();
    }

    _onUnmanaging(win) {
        this._rememberClosed(win);
        // Before the focus moves on and takes the ring with it.
        this.ring.leaving(win);
        this.floaters.get(win)?.stop(false);
        const tile = this.tiles.get(win);
        const strip = tile?.strip;
        // Hand focus to the neighbour so the view does not jump to whichever
        // window was used most recently.
        const next = strip && win.has_focus() && this.isActiveStrip(strip)
            ? strip.successor(tile) : null;
        // The window leaves its strip before anything is laid out. Mutter
        // segfaults in meta_window_update_monitor() when a window that is
        // being unmanaged is moved, and activating the neighbour runs a layout.
        this._untrack(win, true);
        // Mutter closes the dialogs attached to a window with it.
        this._detach(win, false);
        for (const dialog of this.attached.get(win) ?? [])
            this._hosts.delete(dialog);
        this.attached.delete(win);
        this.floating.delete(win);
        this.raised.delete(win);
        this.refused.delete(win);
        this.forced.delete(win);
        this._born.delete(win);
        this._home.delete(win);
        this._stopRecentring(win);
        win.disconnectObject(this);
        if (next?.strip) {
            next.strip.focus = next;
            next.win.activate(global.get_current_time());
        }
        this._changed();
    }

    _adopt() {
        const wins = global.display.list_all_windows();
        const live = new Set(wins);
        const saved = savedLayout;
        savedLayout = null;
        if (saved) {
            for (const win of saved.floating.filter(w => live.has(w)))
                this.floating.add(win);
            for (const win of (saved.raised ?? []).filter(w => live.has(w)))
                this.raised.add(win);
            for (const win of (saved.refused ?? []).filter(w => live.has(w)))
                this.refused.add(win);
            for (const win of saved.forced.filter(w => live.has(w)))
                this.forced.add(win);
            this._lastWidth = saved.lastWidth;
            this._closed = saved.closed;
            this._activeMonitor = saved.activeMonitor;
        }
        // After a lock the tiles start where they were drawn before it,
        // so a tile moves only if its place has changed: a window was
        // closed or opened while the screen was locked. After any other
        // disable the windows are drawn at their frames, and go to their
        // places from there.
        const still = !!saved?.kept;
        const fromFrame = tile => {
            const frame = visibleRect(this.config, tile.win);
            tile.x.set(frame.x);
            tile.y.set(frame.y);
            tile.placed = true;
        };
        for (const win of wins)
            this._watch(win);

        // The strips that were saved, column by column. A window that has
        // closed since is left out, and one that has changed its monitor
        // or its workspace goes to the end of the strip it is on now.
        for (const s of saved?.strips ?? []) {
            let strip = null;
            for (const c of s.columns) {
                let col = null;
                for (const t of c.tiles) {
                    const win = t.win;
                    // A fullscreen window allows no resize, so it is not
                    // asked whether it tiles: it was a tile.
                    if (!live.has(win) || this.tiles.has(win) || !win.get_compositor_private() ||
                        !(this._shouldTile(win) || (win.is_fullscreen() && !win.minimized)))
                        continue;
                    const home = this._stripFor(win);
                    if (!home || home.monitor !== s.monitor || home.workspace !== s.workspace)
                        continue;
                    strip = home;
                    const tile = new Tile(this, win);
                    this.tiles.set(win, tile);
                    if (!still) {
                        fromFrame(tile);
                    } else if (t.at && s.view === rectKey(strip.monitorRect)) {
                        // Not after a change of the monitors: the tile is
                        // then put at its place with no way to it.
                        tile.x.set(t.at[0]);
                        tile.y.set(t.at[1]);
                        tile.shrink.set(t.at[2]);
                        tile.placed = true;
                    }
                    if (win.is_maximized?.())
                        this._unmaximize(win);
                    if (col) {
                        strip.addToColumn(tile, col);
                    } else {
                        col = strip.addColumn(tile, strip.columns.length, c.proportion);
                        col.restore = c.restore;
                        col.pinned = c.pinned;
                        col.shared = c.shared;
                    }
                    tile.weight = t.weight;
                    tile.minWidth = t.minWidth;
                    tile.cameFrom = t.cameFrom;
                }
                const active = col && this.tiles.get(c.active);
                if (active?.column === col)
                    col.active = active;
            }
            if (!strip)
                continue;
            strip.scroll = s.scroll;
            strip.freeScroll = s.freeScroll;
            const focus = this.tiles.get(s.focus);
            if (focus?.strip === strip)
                strip.focus = focus;
        }
        const current = saved && this.tiles.get(saved.current);
        if (current)
            this.currentTile = current;

        // Every other window that tiles, in the order of where it is.
        const rest = wins.filter(win => !this.tiles.has(win) &&
            this._shouldTile(win) && win.get_compositor_private());
        rest.sort((a, b) => a.get_frame_rect().x - b.get_frame_rect().x ||
            a.get_stable_sequence() - b.get_stable_sequence());
        for (const win of rest) {
            const strip = this._stripFor(win);
            if (!strip)
                continue;
            const tile = new Tile(this, win);
            this.tiles.set(win, tile);
            fromFrame(tile);
            if (win.is_maximized?.())
                this._unmaximize(win);
            strip.addColumn(tile, strip.columns.length, this._rememberedWidth(win));
        }
        // The windows that are open and not on a strip, see layout.above.
        for (const win of wins)
            this._raise(win);
        for (const win of wins)
            this._attach(win);
        // The ring is on the window that gets the focus back from the lock
        // screen with no fade, see _onFocus.
        this._resumed = still;
        this.layoutAll(true);
        this._changed();
    }

    // ---- window events ----

    _onFocus() {
        const win = global.display.focus_window;
        // Focus comes back to the window that had it when the helper closes,
        // so the ring and the minimap stay where they are.
        if (win && isHelper(win))
            return;
        // Mutter gives the focus to the window used last on the workspace
        // that is entered. That can be one that went under the fullscreen
        // window while its workspace was not shown (Strip.unpeek, on its
        // way out when the workspace was left again), with nothing of it
        // to see: the fullscreen window takes the focus once the workspace
        // has changed. A window that was activated on that workspace was
        // raised first, and keeps the focus.
        if (win && this._switching) {
            const tile = this.tiles.get(win);
            const cover = tile?.strip?.shownFull;
            if (cover && cover !== tile &&
                global.display.sort_windows_by_stacking([win, cover.win])[0] === win) {
                this._refocus = cover.win;
                return;
            }
        }
        // A new window takes focus before Mutter has moved it to the monitor
        // it was given, so its strip or its pending monitor comes first.
        if (win) {
            const monitor = this.tiles.get(win)?.strip?.monitor ??
                this._home.get(win) ?? win.get_monitor();
            if (monitor >= 0)
                this._activeMonitor = monitor;
        }
        const focused = win ? this.tiles.get(win) ?? null : null;
        this.focusTile = focused;
        // An attached dialog is drawn in the middle of its window, so the
        // view shows that window when the dialog takes the focus. Without
        // this, the dialog of a window that is out of the view would have
        // the keyboard with nothing of it to see.
        if (win && !focused)
            this._attach(win);
        const tile = focused ?? (win ? this.hostOf(win) : null);
        if (tile)
            this._makeCurrent(tile);
        if (tile?.strip) {
            const strip = tile.strip;
            // A swipe or a focus key over a fullscreen window has made the
            // tile the strip's focus before the window took it.
            const own = strip.focus === tile;
            // Before the scroll changes: from the edge of the monitor, or
            // from where it is drawn on its way out.
            if (!own)
                strip.coverEnter(tile);
            strip.focus = tile;
            tile.column.active = tile;
            // A new window is in the middle of the view, or as near to it
            // as the ends of the strip allow: the view shows no empty
            // space past an end. The least scrolling that shows it would
            // put it at the right edge. Any other window that takes the
            // focus is shown with the least scrolling.
            if (focused && tile.fresh && !tile.column.pending && this._isNew(win)) {
                tile.fresh = false;
                strip.place(tile.column, 'middle');
            } else {
                strip.ensureVisible(tile.column);
            }
            strip.layout(true);
            // Once the button is up: the window moves, and a click that
            // began on it would end somewhere else in it, see _makeCurrent().
            if (!own && strip.cover && tile !== strip.cover) {
                this._afterPointer(() => {
                    if (!tile.dead && tile.strip === strip)
                        strip.coverFocus(tile);
                });
            } else if (!own && tile === strip.cover) {
                // Now, and not when the button is up: Mutter has the
                // fullscreen window over the others from this moment.
                strip.coverClear();
            }
        }
        const fade = !this._resumed;
        if (win)
            this._resumed = false;
        this.ring.setWindow(win ?? null, fade);
        this._changed();
    }

    /** Run fn now, or once no pointer button or finger is down. */
    _afterPointer(fn) {
        if (this._afterId)
            GLib.source_remove(this._afterId);
        this._afterId = 0;
        if (!this._pointerHeld()) {
            fn();
            return;
        }
        // Looked at every 30 ms, as in _makeCurrent().
        const until = GLib.get_monotonic_time() + 3e6;
        this._afterId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            if (this._pointerHeld() && GLib.get_monotonic_time() < until)
                return GLib.SOURCE_CONTINUE;
            this._afterId = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Draw a tile at full size and the others at windows.unfocusedScale.
     *
     * A press on a window that has no focus gives it the focus, and is also
     * the start of a click in it. If the window grew from 98% to full
     * size under the pointer, the release of that click would land up to
     * 1% of the window's size away from the press: next to the button that
     * was pressed, or far enough for the app to take the click as a drag.
     * The window grows when the button, or the finger, is released, so the
     * whole click is over a window that does not move.
     *
     * tile is null after a press on the desktop: no tile is current then.
     */
    _makeCurrent(tile) {
        this._wantCurrent = tile;
        this._currentPending = true;
        if (this._currentId)
            return;
        const apply = () => {
            if (!this._currentPending)
                return;
            const want = this._wantCurrent;
            this._currentPending = false;
            this._wantCurrent = null;
            if (want && this.tiles.get(want.win) !== want)
                return;
            this.currentTile = want;
            for (const other of this.tiles.values())
                other.setCurrent(other === want, true);
        };
        if (!this._pointerHeld()) {
            apply();
            return;
        }
        // Looked at every 30 ms, and not on the release event: a release
        // that ends a window drag does not reach the stage. After 3 s the
        // window grows in any case.
        const until = GLib.get_monotonic_time() + 3e6;
        this._currentId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            if (this._pointerHeld() && GLib.get_monotonic_time() < until)
                return GLib.SOURCE_CONTINUE;
            this._currentId = 0;
            this._touches = 0;
            apply();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * After a change of workspace: the current tile is no longer current
     * when its window stayed behind on another workspace.
     *
     * A window that gets the focus on the new workspace becomes the current
     * tile through _onFocus(), which shrinks the one left behind. A
     * workspace with no window gives the focus to nothing, and _onFocus()
     * leaves the current tile alone then (the focus also goes to nothing
     * while the launcher is open). Without this, the window left behind
     * would lose its ring and slide away at full size.
     */
    _leaveCurrent() {
        const tile = this._currentPending ? this._wantCurrent : this.currentTile;
        if (!tile)
            return;
        const active = global.workspace_manager.get_active_workspace();
        if (!tile.win.located_on_workspace(active))
            this._makeCurrent(null);
    }

    /**
     * After a change of workspace, once Mutter has given the focus to a
     * window of the new one. It takes the window used last, and a window on
     * a monitor without workspaces is on every workspace. So a change to an
     * empty workspace gives the focus to a window of the other monitor,
     * and that monitor would become the active one: the sidebar would show
     * the new workspace and the other monitor both as current.
     *
     * The focus stays on the monitor the change was made on: with the
     * window that last had it there on the new workspace, or with none.
     */
    _onWorkspaceSwitched() {
        const monitor = this._switchedOn ?? -1;
        this._switchedOn = -1;
        if (monitor < 0 || monitor >= global.display.get_n_monitors())
            return;
        const win = global.display.focus_window;
        // A window that is on the new workspace only was activated, which
        // changed the workspace: it keeps the focus.
        if (!win || isHelper(win) || win.get_monitor() === monitor || !win.is_on_all_workspaces())
            return;
        this.focusMonitor(monitor);
    }

    /** Whether a pointer button or a finger is down. */
    _pointerHeld() {
        const M = Clutter.ModifierType;
        const [, , mods] = global.get_pointer();
        return this._touches > 0 ||
            (mods & (M.BUTTON1_MASK | M.BUTTON2_MASK | M.BUTTON3_MASK)) !== 0;
    }

    /** The window changed workspace or monitor: move it to that strip. */
    _rehome(win) {
        const tile = this.tiles.get(win);
        if (!tile || tile.grabbed || this._rehomeHeld)
            return;
        const strip = this._stripFor(win);
        if (!strip || strip === tile.strip)
            return;
        const old = tile.strip;
        const proportion = tile.column?.proportion ?? null;
        if (old?.columns.includes(tile.column))
            tile.places.set(old, old.placeOf(tile));
        old?.remove(tile);
        // To another workspace of the same monitor, the window glides from
        // where it is drawn to its new place while the workspaces slide. On
        // another monitor it starts at its new place.
        if (old?.monitor !== strip.monitor)
            tile.placed = false;
        tile._request = null;
        // Back on a workspace it has been on, it takes the place it had
        // there. On one it has not been on it goes right of the column
        // that had the focus there. A window sent down and up again went
        // to the end of the strip it came from: that strip has no focus
        // once its focused window has left.
        const place = old?.monitor === strip.monitor ? tile.places.get(strip) : null;
        if (place)
            strip.restore(tile, place, proportion);
        else
            strip.addColumn(tile, null, proportion);
        if (win.has_focus()) {
            // Focus does not change when a focused window moves, so no focus
            // event will make the new strip follow it.
            tile.column.active = tile;
            strip.focus = tile;
            strip.ensureVisible(tile.column);
        }
        old?.layout(true);
        strip.layout(true);
        this._changed();
    }

    _onMinimized(win) {
        this.floaters.get(win)?.stop();
        if (win.minimized)
            this._untrack(win, true);
        else
            this._retile(win);
    }

    _onFullscreen(win) {
        this.floaters.get(win)?.stop();
        const tile = this.tiles.get(win);
        if (!tile) {
            // A window that was fullscreen when it opened was not asked
            // whether it tiles, see _shouldTile(). It is asked now.
            if (!win.is_fullscreen())
                this._retile(win);
            return;
        }
        if (!win.is_fullscreen()) {
            tile._request = null;
            // Nothing is over a fullscreen window any more.
            for (const other of tile.strip?.tiles ?? [])
                other.cameFrom = null;
            // The window that left fullscreen has its place at once. The
            // others move over on their springs, to make room for the
            // sidebar that comes back, see Strip._shiftFor.
            tile.strip?.layout(true);
            if (tile.target) {
                tile.x.set(tile.target.x);
                tile.y.set(tile.target.y);
                tile.sync();
            }
        }
        tile.sync();
        this.ring.sync();
    }

    _unmaximize(win) {
        this._unmaximizing = true;
        try {
            if (win.set_unmaximize_flags)
                win.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
            else
                win.unmaximize(Meta.MaximizeFlags.BOTH);
        } finally {
            this._unmaximizing = false;
        }
    }

    /** Maximize means "fill the view" here: toggle the column to full width. */
    _onMaximized(win) {
        const tile = this.tiles.get(win);
        if (!tile || this._unmaximizing || tile.grabbed)
            return;
        const flags = win.get_maximize_flags();
        if (flags === Meta.MaximizeFlags.NONE)
            return;
        this._unmaximize(win);
        // The shell has prepared its own animation of the maximize (a
        // double click on a title bar asks for one): 250 ms, with its own
        // easing, on the window actor. The focus ring and the other windows
        // move on the springs, so the ring and the window would be out of
        // step. Without it the window changes size the way it does for the
        // maximize-column key, which never starts that animation. Mutter
        // tells the shell about the maximize after it has told this
        // handler, so the animation is also dropped before the next frame.
        const drop = () => Main.wm._sizeChangeWindowDone?.(Main.wm._shellwm, tile.actor);
        drop();
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (!tile.dead && !tile.fullscreen) {
                drop();
                tile.sync();
            }
            return GLib.SOURCE_REMOVE;
        });
        tile._request = null;
        if (flags === Meta.MaximizeFlags.BOTH)
            this._toggleMaximizeColumn(tile);
        else
            tile.strip?.layout(true);
    }

    _onGrabBegin(win, op) {
        // The pointer has the window from here: it is drawn at its frame.
        this.floaters.get(win)?.stop();
        const tile = this.tiles.get(win);
        if (!tile)
            return;
        const frame = visibleRect(this.config, win);
        tile.grabbed = true;
        tile.x.set(frame.x);
        tile.y.set(frame.y);
        tile.sync();
        this._grabMoving = op === Meta.GrabOp.MOVING ||
            op === Meta.GrabOp.MOVING_UNCONSTRAINED ||
            op === Meta.GrabOp.KEYBOARD_MOVING;
        if (this._grabMoving) {
            const [x, y] = global.get_pointer();
            this._drag = {
                tile, x, y, moved: false,
                // A keyboard move leaves the pointer wherever it was.
                pointer: op !== Meta.GrabOp.KEYBOARD_MOVING,
                sunk: false, icon: null,
                places: new Map(),      // the windows drawn out of their places, see _showPlaces
            };
            win.connectObject('position-changed', () => this._onDragMotion(), this.dropHint);
        } else {
            tile.holdResize(op);
        }
    }

    /**
     * A drag that is still going on when the tiling is disabled: no
     * grab-op-end comes for it. The window is drawn whole again, and the
     * icon that was dragged in its place over the sidebar goes.
     */
    _endDrag() {
        const drag = this._drag;
        this._drag = null;
        if (!drag)
            return;
        drag.tile.win.disconnectObject(this.dropHint);
        this._showPlaces(drag, null);
        drag.icon?.destroy();
        drag.icon = null;
        const actor = drag.tile.actor;
        if (drag.sunk && actor) {
            actor.remove_all_transitions();
            actor.set_scale(1, 1);
            actor.opacity = 255;
        }
    }

    /**
     * The dragged window goes into the sidebar, or comes back out of it. In
     * the sidebar the window shrinks away under the pointer and its icon is
     * dragged in its place, as if the icon had been picked up in the minimap.
     */
    _setSunk(drag, sunk) {
        if (drag.sunk === sunk)
            return;
        drag.sunk = sunk;
        this.ring.hidden = sunk;
        this.ring.sync();
        const actor = drag.tile.actor;
        if (sunk) {
            const [px, py] = global.get_pointer();
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_size();
            actor.set_pivot_point(
                clamp((px - ax) / Math.max(1, aw), 0, 1),
                clamp((py - ay) / Math.max(1, ah), 0, 1));
            actor.ease({
                scale_x: 0.08, scale_y: 0.08, opacity: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            const app = Shell.WindowTracker.get_default().get_window_app(drag.tile.win);
            drag.icon = app
                ? app.create_icon_texture(SUNK_ICON_SIZE)
                : new St.Icon({icon_name: 'application-x-executable', icon_size: SUNK_ICON_SIZE});
            drag.icon.reactive = false;
            drag.icon.opacity = 0;
            Main.uiGroup.add_child(drag.icon);
            drag.icon.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            actor.ease({
                scale_x: 1, scale_y: 1, opacity: 255,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            drag.icon?.destroy();
            drag.icon = null;
        }
    }

    /** The dragged window moved: show where it lands if dropped now. */
    _onDragMotion() {
        const drag = this._drag;
        if (!drag || drag.tile.dead)
            return;
        const [px, py] = global.get_pointer();
        if (!drag.moved) {
            const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            if (Math.hypot(px - drag.x, py - drag.y) < DRAG_DISTANCE * s)
                return;
            drag.moved = true;
        }
        const tile = drag.tile;
        const sunk = drag.pointer && (this.dragSink?.over(tile.win, px, py) ?? false);
        this._setSunk(drag, sunk);
        if (sunk) {
            this._showPlaces(drag, null);
            this.dropHint.hide();
            const [w, h] = drag.icon.get_size();
            drag.icon.set_position(Math.round(px - w / 2), Math.round(py - h / 2));
            return;
        }
        const strip = this._dropStrip(tile, px, py, drag.pointer);
        const target = strip ? this._dropTarget(tile, strip, px, py) : null;
        this._showPlaces(drag, target?.places ?? null);
        if (target?.rect)
            this.dropHint.show(target.rect, tile.actor);
        else
            this.dropHint.hide();
    }

    /**
     * Draw the other windows where they are once the dragged one is dropped
     * (places: tile -> x), or back at their own places (null). A window
     * that the drop place lies over moves out of it, which shows where the
     * dragged window goes and where that window goes.
     *
     * Only the springs move. The layout and the frames stay, so the next
     * motion finds the same drop places, and a drag that ends anywhere else
     * leaves nothing to undo but the springs.
     */
    _showPlaces(drag, places) {
        for (const tile of new Set([...drag.places.keys(), ...places?.keys() ?? []])) {
            if (tile.dead || !tile.target || tile.grabbed || tile.fullscreen)
                continue;
            const x = places?.get(tile) ?? tile.target.x;
            if (tile.x.target === x)
                continue;
            if (this.animator.enabled) {
                tile.x.target = x;
                this.animator.add(tile);
            } else {
                tile.x.set(x);
                tile.sync();
            }
        }
        drag.places = places ?? new Map();
    }

    /**
     * The strip a dragged window lands on: the one of the monitor the
     * pointer is on, for the window's workspace.
     *
     * Not the strip of the monitor the window is on, which Mutter takes
     * from where most of the window is. A window held by the left end of
     * its title bar is mostly to the right of the pointer. With the
     * pointer near the right edge of one monitor, most of it is on the
     * monitor to the right, and it would land there: the last place of
     * the left monitor could only be reached by holding the window near
     * its right end.
     *
     * pointer: false for a move with the keyboard, which leaves the pointer
     * where it was. The window's own monitor counts then.
     */
    _dropStrip(tile, px, py, pointer) {
        if (pointer) {
            const monitor = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({x: Math.round(px), y: Math.round(py), width: 1, height: 1}));
            if (monitor >= 0) {
                const ws = this._stripWorkspace(tile.win, monitor);
                if (ws || (Meta.prefs_get_workspaces_only_on_primary() &&
                    monitor !== global.display.get_primary_monitor()))
                    return this._strip(monitor, ws);
            }
        }
        return this._stripFor(tile.win) ?? tile.strip;
    }

    /**
     * Where a dragged tile lands when dropped with the pointer at px, py.
     *
     * Returns {column, row, rect} to join a column at a row, or
     * {index, rect, places} to become a column at an index. The index
     * counts the strip's columns without the dragged window's own column
     * when the window is alone in it, which is how the strip is once the
     * window is taken out. rect is the place to show. places has the x of
     * each other window that is somewhere else once the window is dropped,
     * see _showPlaces.
     *
     * The rules, for the pointer over the strip:
     *   - the middle of a column: into that column, at the row the pointer
     *     is at and at the column's width.
     *   - a side of a column (DROP_SIDE_SHARE) or a gap: a column of its
     *     own on that side, at the width the window has.
     *   - over a fullscreen window: the left or the right edge of the
     *     monitor, by the half the pointer is on, or into the column of a
     *     window that is shown over it.
     *
     * The columns are read from the layout (Tile.target) and not from
     * where the windows are drawn. A window that _showPlaces has moved out
     * of the way keeps its drop places, so the place under a pointer at
     * rest does not change while the windows move.
     */
    _dropTarget(tile, strip, px, py) {
        const area = strip.area;
        const gap = strip.gap;
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const own = tile.strip === strip ? tile.column : null;
        const alone = own?.tiles.length === 1;
        const cover = strip.fits ? null : strip.cover;
        const over = cover && cover !== tile ? cover : null;
        // The columns as they are drawn, without the dragged window. Over a
        // fullscreen window, the columns that have a window over it: the
        // others are not in view, and neither is the place a window would
        // take in the fullscreen window's own column. A window that is on
        // its way under the fullscreen window counts as under it. A press
        // on a window sends out those that came in after it.
        const inView = t => !t.fullscreen && !strip.under(t, over) && !strip.leaving(t);
        const cols = [];
        for (const column of strip.columns) {
            const tiles = column.tiles.filter(t => t !== tile && t.target);
            if (tiles.length === 0)
                continue;
            if (over && (column === over.column || !tiles.some(inView)))
                continue;
            cols.push({column, tiles, x: tiles[0].target.x, width: column.width});
        }

        for (const c of cols) {
            const side = Math.min(c.width * DROP_SIDE_SHARE, DROP_SIDE_MAX * s);
            if (px < c.x + side || px > c.x + c.width - side)
                continue;
            // The row whose place the pointer is over, and that place once
            // the column has one more window of weight 1.
            const row = c.tiles.filter(t => t.target.y + t.target.height / 2 < py).length;
            const total = c.tiles.reduce((sum, t) => sum + t.weight, 0) + 1;
            const avail = area.height - 2 * gap - c.tiles.length * gap;
            let y = area.y + gap;
            for (let i = 0; i < row; i++)
                y += Math.round(avail * c.tiles[i].weight / total) + gap;
            const height = Math.max(40, Math.round(avail / total));
            return {column: c.column, row, rect: {x: c.x, y, width: c.width, height}};
        }

        if (over) {
            // Beside the fullscreen window there are two places: against
            // the left edge of the monitor and against the right edge, at
            // the width the window has. The half of the monitor the pointer
            // is on says which. The window goes past the windows that are
            // over the fullscreen one on that side, so it is the one at the
            // edge, as a window that a swipe brings in is.
            const list = strip.columns.filter(c => c !== own || !alone);
            const at = list.indexOf(over.column);
            const mon = strip.monitorRect;
            const side = px < mon.x + mon.width / 2 ? -1 : 1;
            const shown = cols.map(c => list.indexOf(c.column))
                .filter(i => Math.sign(i - at) === side);
            const index = side < 0 ? Math.min(at, ...shown) : Math.max(at, ...shown) + 1;
            const places = new Map();
            const rect = strip.placeAsColumn(tile, index, tile.column?.proportion, places);
            // Only the windows that are in view move out of the way.
            for (const t of [...places.keys()]) {
                if (!inView(t))
                    places.delete(t);
            }
            // The windows over the fullscreen one on the other side leave
            // when the window is dropped here, see Strip.coverOneSide.
            for (const c of cols) {
                if (Math.sign(list.indexOf(c.column) - at) !== -side)
                    continue;
                for (const t of c.tiles.filter(inView))
                    places.set(t, side > 0 ? mon.x - t.target.width : mon.x + mon.width);
            }
            return {index, rect, places};
        }

        const index = cols.filter(c => c.x + c.width / 2 < px).length;
        // Back where it came from: show the place it left.
        if (alone && tile.target && index === strip.columns.indexOf(own)) {
            const t = tile.target;
            return {index, rect: {x: t.x, y: t.y, width: t.width, height: t.height}};
        }
        // Beside a column, at the width the window keeps: the place it has
        // once it is dropped. The other windows are drawn where they are
        // then (places), so the place is free: with the view where it is,
        // the windows between the place the window left and this one each
        // move over by one place.
        const places = new Map();
        const rect = strip.placeAsColumn(tile, index, tile.column?.proportion, places);
        return {index, rect, places};
    }

    _onGrabEnd(win) {
        const tile = this.tiles.get(win);
        if (!tile || !tile.grabbed)
            return;
        // The frame a dragged edge asked for last, see Tile.holdResize.
        const held = tile.heldRect();
        tile.releaseResize();
        tile.grabbed = false;
        tile._request = null;
        const drag = this._drag?.tile === tile ? this._drag : null;
        this._drag = null;
        win.disconnectObject(this.dropHint);
        this.dropHint.hide();
        // The layout below gives every window its place. This is for a
        // drag that ends without one.
        if (drag)
            this._showPlaces(drag, null);
        if (win.get_maximize_flags() !== Meta.MaximizeFlags.NONE) {
            this._onMaximized(win);
            return;
        }
        const frame = visibleRect(this.config, win);
        tile.x.set(frame.x);
        tile.y.set(frame.y);
        tile.placed = true;

        let strip = this._stripFor(win) ?? tile.strip;
        const gap = strip.gap;
        if (this._grabMoving && drag?.sunk) {
            // Dropped in the sidebar: the minimap places the window, as it
            // does for an icon dropped on one of its rows.
            const [px, py] = global.get_pointer();
            this._setSunk(drag, false);
            this.dragSink?.drop(win, px, py);
            for (const s of this.strips.values())
                s.layout(true);
        } else if (this._grabMoving) {
            // Drop: into the column under the pointer, or beside it as a
            // column of its own. A drag shorter than DRAG_DISTANCE puts the
            // window back.
            const [px, py] = global.get_pointer();
            strip = this._dropStrip(tile, px, py, drag?.pointer ?? false) ?? strip;
            const target = drag?.moved ? this._dropTarget(tile, strip, px, py) : null;
            if (target) {
                const proportion = tile.column.proportion;
                tile.strip.remove(tile);
                if (target.column && strip.columns.includes(target.column))
                    strip.addToColumn(tile, target.column, target.row);
                else
                    strip.addColumn(tile, target.index ?? null, proportion);
                tile.column.active = tile;
                // Taking the window out cleared the strip's focus. Without
                // it the view does not follow the window to where it landed.
                strip.focus = tile;
                strip.freeScroll = false;
                strip.ensureVisible(tile.column);
            }
            for (const s of this.strips.values())
                s.layout(true);
            if (target)
                strip.coverOneSide(tile);
        } else {
            // Resize: keep the new width, and the new share of the height.
            // Of the frame a dragged edge asked for last, which the client
            // may not have drawn yet.
            const size = held ?? frame;
            strip = tile.strip;
            const area = strip.area;
            tile.column.proportion = clamp(
                (size.width + gap) / (area.width - gap), MIN_PROPORTION, 1);
            tile.column.restore = null;
            this.widths.set(win, tile.column.proportion);
            const col = tile.column;
            if (col.tiles.length > 1) {
                const avail = area.height - 2 * gap - (col.tiles.length - 1) * gap;
                const total = col.tiles.reduce((s, t) => s + t.weight, 0);
                const others = total - tile.weight;
                const share = clamp(size.height / avail, 0.1, 0.9);
                tile.weight = others * share / (1 - share);
            }
            strip.layout(true);
        }
        this._changed();
    }

    /**
     * Three or more fingers moving sideways scroll the strip. The axis is
     * decided the way the shell decides it (16 units travelled, then the
     * larger of the two components), so a vertical swipe is left to the
     * shell's workspace gesture and the two never both act on one swipe.
     */
    _onTouchpad(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            // A swipe whose end never arrived.
            this._swipe?.strip?.swipeEnd(event.get_time(), true);
            this._swipe = null;
            this.setBetween('windows', null);
            if (this.config.values.gestures.swipeScroll &&
                event.get_touchpad_gesture_finger_count() >= SWIPE_FINGERS &&
                Main.actionMode === Shell.ActionMode.NORMAL)
                this._swipe = {dx: 0, dy: 0, strip: null, ignored: false};
            return Clutter.EVENT_PROPAGATE;
        }
        const s = this._swipe;
        if (!s || s.ignored)
            return Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
            if (!s.strip) {
                s.dx += dx;
                s.dy += dy;
                if (Math.hypot(s.dx, s.dy) < SWIPE_DISTANCE)
                    return Clutter.EVENT_PROPAGATE;
                if (Math.abs(s.dx) <= Math.abs(s.dy)) {
                    s.ignored = true;
                    return Clutter.EVENT_PROPAGATE;
                }
                s.strip = this.activeStrip();
                s.strip.swipeBegin();
            }
            // With natural scrolling the windows follow the fingers. Without
            // it they move the other way, as they do in the shell's gestures.
            const natural = this._touchpad.get_boolean('natural-scroll');
            const gain = s.strip.viewWidth / SWIPE_UNITS_PER_VIEW *
                clamp(this.config.values.gestures.sensitivity, 0.1, 10);
            s.strip.swipeUpdate((natural ? -dx : dx) * gain, event.get_time());
            return Clutter.EVENT_STOP;
        }

        // END or CANCEL
        this._swipe = null;
        if (!s.strip)
            return Clutter.EVENT_PROPAGATE;
        s.strip.swipeEnd(event.get_time(), phase === Clutter.TouchpadGesturePhase.CANCEL);
        // After the focus has changed: the minimap then knows where its
        // fill goes from the place the fingers left it at.
        this.setBetween('windows', null);
        return Clutter.EVENT_STOP;
    }

    // ---- workspace switch animation ----
    // The shell animates clones placed at each actor's real position. Add the
    // translation so windows appear where they are on the strip.

    _patchWorkspaceAnimation() {
        const proto = Object.getPrototypeOf(WorkspaceAnimation.WorkspaceGroup.prototype);
        if (!proto || typeof proto._createClone !== 'function')
            return;
        const original = proto._createClone;
        this._wsAnimPatch = {proto, original};
        // The clone is drawn where the window is drawn, and follows it while
        // the workspaces slide. A window that moves to another workspace
        // makes the columns there move over during the slide. A clone left
        // at its first place would show them still, then jump at the end.
        proto._createClone = function (windowActor) {
            const clone = original.call(this, windowActor);
            const monitor = this._monitor;
            const sync = () => {
                clone.set_position(
                    windowActor.x - monitor.x + windowActor.translation_x,
                    windowActor.y - monitor.y + windowActor.translation_y);
                // A clone is drawn without its source's scale.
                const pivot = windowActor.pivot_point;
                clone.set_pivot_point(pivot.x, pivot.y);
                clone.set_scale(windowActor.scale_x, windowActor.scale_y);
            };
            sync();
            windowActor.connectObject(
                'notify::translation-x', sync,
                'notify::translation-y', sync,
                'notify::x', sync,
                'notify::y', sync,
                'notify::scale-x', sync,
                clone);
            return clone;
        };
        this._patchSwitchBackdrop();
    }

    /**
     * What is behind the windows during a workspace switch, see
     * lib/wsslide.js. The shell gives every workspace a wallpaper of its
     * own that slides with it. Here the group that holds the workspaces
     * gets them, with the space between two workspaces filled.
     */
    _patchSwitchBackdrop() {
        const group = WorkspaceAnimation.WorkspaceGroup?.prototype;
        const monitorGroup = WorkspaceAnimation.MonitorGroup?.prototype;
        if (typeof group?._createBackground !== 'function' ||
            typeof monitorGroup?._init !== 'function' ||
            !WorkspaceAnimation.WorkspaceBackground)
            return;
        const createBackground = group._createBackground;
        const init = monitorGroup._init;
        const tiling = this;
        this._switchPatch = {group, createBackground, monitorGroup, init};
        group._createBackground = function () {};
        // The window a key sends to another workspace is the moving window
        // of the switch, see moveToWorkspace. The shell's own field for it
        // is cleared when a switch that is still running is ended for the
        // new one, which is after the key and before these are made.
        monitorGroup._init = function (monitor, indices, moving, ...rest) {
            init.call(this, monitor, indices, tiling._movingWindow ?? moving, ...rest);
            try {
                decorateSwitch(this, monitor, tiling.fade, tiling.glass);
                if (monitor.index === Main.layoutManager.primaryIndex)
                    tiling._followSlide(this);
            } catch (e) {
                console.error(e);
            }
        };
    }

    /**
     * The shell does not animate the map of a new window that tiles. The
     * tile does (Tile.open), with the scale and the place it already
     * controls, so the focus ring follows the same numbers as the window.
     * Windows that do not tile keep the shell's animation.
     *
     * The shell does not animate a size change of a window that is opening
     * either (Tile.opening). With two monitors, Ghostty's first frame is
     * 360 px wide at the right edge of the last monitor. Its second frame
     * is its place, which can be on another monitor, and Mutter reports
     * that as a size change. The shell would then draw the window flying
     * from that edge to its place for 250 ms, with the ring already at
     * the place.
     */
    _patchMapAnimation() {
        const wm = Main.wm;
        const original = wm._shouldAnimateActor;
        if (typeof original !== 'function')
            return;
        const tiling = this;
        this._mapPatch = {wm, original, own: Object.hasOwn(wm, '_shouldAnimateActor')};
        wm._shouldAnimateActor = function (actor, types) {
            // The original first: it also clears the actor from the list of
            // actors whose next animation is skipped.
            if (!original.call(this, actor, types))
                return false;
            const win = actor.meta_window;
            if (!win || !tiling.animator.enabled)
                return true;
            const tile = tiling.tiles.get(win);
            if (!tiling._unmapped.has(win))
                return !tile?.opening;
            if (!tile && !tiling._shouldTile(win))
                return true;
            tiling._wantOpen.add(win);
            return false;
        };
    }

    _unpatchMapAnimation() {
        const patch = this._mapPatch;
        this._mapPatch = null;
        if (!patch)
            return;
        if (patch.own)
            patch.wm._shouldAnimateActor = patch.original;
        else
            delete patch.wm._shouldAnimateActor;
    }

    /** The shell has mapped a window: fade it in if the shell did not. */
    _onMapped(actor) {
        const win = actor.meta_window;
        if (!win)
            return;
        this._unmapped.delete(win);
        const tile = this.tiles.get(win);
        tile?.open(this._wantOpen.delete(win));
    }

    _unpatchWorkspaceAnimation() {
        if (this._wsAnimPatch)
            this._wsAnimPatch.proto._createClone = this._wsAnimPatch.original;
        this._wsAnimPatch = null;
        const patch = this._switchPatch;
        this._switchPatch = null;
        if (patch) {
            patch.group._createBackground = patch.createBackground;
            patch.monitorGroup._init = patch.init;
        }
    }

    // ---- data for the minimap ----

    /**
     * Windows of a workspace on the primary monitor in strip order, tiled
     * first, then floating. The windows of the other monitors are listed
     * by windowsOn(): each of those monitors has a card of its own in the
     * sidebar.
     */
    windowsOf(ws) {
        const primary = global.display.get_primary_monitor();
        const tiled = [];
        for (const strip of this.strips.values()) {
            if (strip.workspace === ws && strip.monitor === primary)
                tiled.push(...strip.tiles.map(t => t.win));
        }
        const seen = new Set(tiled);
        const rest = ws.list_windows().filter(w =>
            !seen.has(w) && this._listed(w) && w.get_monitor() === primary &&
            !w.is_on_all_workspaces());
        rest.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        return [...tiled, ...rest];
    }

    /** Windows on a monitor that is not the primary, in strip order, then floating. */
    windowsOn(monitor) {
        const ws = global.workspace_manager.get_active_workspace();
        const tiled = [];
        for (const strip of this.strips.values()) {
            if (strip.monitor === monitor && this.isActiveStrip(strip))
                tiled.push(...strip.tiles.map(t => t.win));
        }
        const seen = new Set(tiled);
        const rest = ws.list_windows().filter(w =>
            !seen.has(w) && this._listed(w) && w.get_monitor() === monitor);
        rest.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
        return [...tiled, ...rest];
    }

    /** Whether a window that is not tiled has an icon in the sidebar. */
    _listed(w) {
        // A window has neither class nor title until its client sets them.
        // A helper window is known by its class, so it is left out before
        // that too.
        return !isHelper(w) && !!(w.get_wm_class() || w.get_title()) && !w.is_skip_taskbar() &&
            (w.get_window_type() === Meta.WindowType.NORMAL ||
             (w.get_window_type() === Meta.WindowType.DIALOG && !w.get_transient_for()));
    }

    // ---- actions ----

    _focused() {
        return this.focusTile ?? this.activeStrip()?.focus ?? null;
    }

    _activate(tile) {
        if (!tile)
            return;
        const strip = tile.strip;
        strip.focus = tile;
        tile.column.active = tile;
        tile.win.activate(global.get_current_time());
    }

    /**
     * Left and right along the strip. Past its first or last column, or on
     * a monitor with no tiled window, the focus goes to the monitor on that
     * side: to the column nearest the one it came from. A window that is on
     * no strip is between the columns, see _focusFloat().
     */
    focusColumn(delta) {
        const strip = this.activeStrip();
        if (!strip)
            return;
        const n = strip.columns.length;
        if (n > 0 && strip.coverStep(delta))
            return;
        if (this._focusFloat(strip, delta))
            return;
        const tile = this._focused();
        let idx = tile?.column ? strip.columns.indexOf(tile.column) + delta : 0;
        if (!tile || tile.strip !== strip)
            idx = delta > 0 ? 0 : n - 1;
        if (idx < 0 || idx >= n) {
            const side = delta < 0 ? Meta.DisplayDirection.LEFT : Meta.DisplayDirection.RIGHT;
            if (this._focusNeighbour(strip.monitor, side) || n === 0)
                return;
        }
        const col = strip.columns[clamp(idx, 0, n - 1)];
        this._activate(col.active ?? col.tiles[0]);
    }

    /**
     * Move the focus to the monitor next to this one in a direction. To the
     * left or the right it goes to the column on the near side of that
     * monitor's strip, so the opposite key comes back. Up or down it goes
     * to the window that last had the focus there. Returns false when there
     * is no monitor on that side.
     */
    _focusNeighbour(monitor, direction) {
        const next = global.display.get_monitor_neighbor_index(monitor, direction);
        if (next < 0)
            return false;
        const strip = this._stripOn(next);
        let col = null;
        if (direction === Meta.DisplayDirection.LEFT)
            col = strip?.columns.at(-1);
        else if (direction === Meta.DisplayDirection.RIGHT)
            col = strip?.columns[0];
        if (col) {
            this.setActiveMonitor(next);
            this._activate(col.active ?? col.tiles[0]);
        } else {
            this.focusMonitor(next);
        }
        return true;
    }

    /**
     * focus-left and focus-right to and from the windows of a strip's
     * monitor that are on no strip. Such a window is in the order of the
     * columns at the place its middle has on the screen. At the same
     * middle as a column it comes after the column, so a window that
     * floats over the middle of a lone column is one press to the right
     * of it, and the column one press to the left of the window.
     *
     * The place of a column on the screen changes when the view scrolls,
     * so the order is the one the screen shows at each press.
     *
     * Returns false when the key moves the focus as it does on a strip
     * with columns only.
     */
    _focusFloat(strip, delta) {
        // Over a fullscreen window the keys bring windows in and out.
        if (strip.cover)
            return false;
        const own = this._floatingFocus();
        const from = own?.get_monitor() === strip.monitor ? own : null;
        const floats = this._floatsOn(strip).filter(w => w !== from);
        if (!from && floats.length === 0)
            return false;
        const entry = win => {
            const r = this._floatRect(win);
            return {mid: Math.round(r.x + r.width / 2), layer: 1, seq: win.get_stable_sequence(), win};
        };
        const columnEntry = (col, i) => {
            const t = (col.active ?? col.tiles[0])?.target;
            return t ? {mid: Math.round(t.x + t.width / 2), layer: 0, seq: i, col} : null;
        };
        // Whether a is further along the way the key goes than b.
        const past = (a, b) => {
            const d = a.mid - b.mid || a.layer - b.layer || a.seq - b.seq;
            return delta > 0 ? d > 0 : d < 0;
        };
        const nearest = list => list.reduce((best, e) => !best || past(best, e) ? e : best, null);
        const go = e => {
            if (e.col)
                this._activate(e.col.active ?? e.col.tiles[0]);
            else
                e.win.activate(global.get_current_time());
        };
        if (from) {
            const here = entry(from);
            const columns = strip.columns.map(columnEntry).filter(e => e);
            const next = nearest([...columns, ...floats.map(entry)].filter(e => past(e, here)));
            if (next) {
                go(next);
            } else {
                this._focusNeighbour(strip.monitor,
                    delta < 0 ? Meta.DisplayDirection.LEFT : Meta.DisplayDirection.RIGHT);
            }
            return true;
        }
        const tile = this._focused();
        if (!tile) {
            // A monitor with no column, and the focus on no window of it.
            if (strip.columns.length > 0)
                return false;
            const all = floats.map(entry);
            go(all.reduce((best, e) => past(best, e) ? e : best));
            return true;
        }
        if (tile.strip !== strip || !tile.column)
            return false;
        const at = strip.columns.indexOf(tile.column);
        const here = columnEntry(tile.column, at);
        if (!here)
            return false;
        // Between this column and the one the key goes to.
        const to = strip.columns[at + delta];
        const bound = to ? columnEntry(to, at + delta) : null;
        const next = nearest(floats.map(entry)
            .filter(e => past(e, here) && (!bound || past(bound, e))));
        if (!next)
            return false;
        go(next);
        return true;
    }

    /** The windows a strip's monitor shows that are on no strip and have an icon in the sidebar. */
    _floatsOn(strip) {
        const ws = strip.workspace ?? global.workspace_manager.get_active_workspace();
        return ws.list_windows().filter(w => !this.tiles.has(w) && this._listed(w) &&
            !w.minimized && w.get_monitor() === strip.monitor);
    }

    /**
     * The window in focus, when it is one the keys move and size as a
     * window on no strip. Not a dialog that is attached to its window:
     * Mutter keeps that in the middle of the window.
     */
    _floatingFocus() {
        const win = global.display.focus_window;
        if (!win || this.tiles.has(win) || win.is_override_redirect() || isHelper(win) ||
            win.minimized || win.is_fullscreen() || win.is_attached_dialog())
            return null;
        const type = win.get_window_type();
        if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG &&
            type !== Meta.WindowType.MODAL_DIALOG && type !== Meta.WindowType.UTILITY)
            return null;
        return win;
    }

    /**
     * Where a window on no strip can go on its monitor: the work area less
     * one gap on each side, which is the place of a column as wide as the
     * view. {x, y, width, height}, and strip: the strip the monitor shows.
     */
    _floatBounds(win) {
        const strip = this._stripOn(win.get_monitor());
        const area = strip.area;
        const gap = strip.gap;
        return {
            strip,
            x: area.x + gap, y: area.y + gap,
            width: Math.max(1, area.width - 2 * gap),
            height: Math.max(1, area.height - 2 * gap),
        };
    }

    /**
     * The place a window on no strip has, or is on its way to: the part
     * that is drawn. A maximized window counts as one that fills the view,
     * so a key takes it from there to a place inside the view.
     */
    _floatRect(win) {
        const r = isMaximized(win) ? this._floatBounds(win)
            : this.floaters.get(win)?.rect ?? visibleRect(this.config, win);
        return {x: r.x, y: r.y, width: r.width, height: r.height};
    }

    /**
     * Whether a key can size a window on no strip. A maximized window
     * allows no resize, and leaves that state for the size (_floatTo).
     */
    _floatSizes(win) {
        return win.allows_resize() || isMaximized(win);
    }

    /**
     * Send a window on no strip to a place, {x, y, width, height} of the
     * part that is drawn. A window that allows no resize keeps its size.
     * Returns whether the place is another than the one it has.
     */
    _floatTo(win, rect) {
        if (!win.allows_move())
            return false;
        const cur = this._floatRect(win);
        const sized = this._floatSizes(win);
        const to = {
            x: Math.round(rect.x), y: Math.round(rect.y),
            width: sized ? Math.round(rect.width) : cur.width,
            height: sized ? Math.round(rect.height) : cur.height,
        };
        if (rectKey(to) === rectKey(cur))
            return false;
        // A maximized window takes no other frame. The shell animates the
        // change of size from here, see Floater.sync.
        if (isMaximized(win))
            this._unmaximize(win);
        if (!this.animator.enabled || !win.get_compositor_private()) {
            this.floaters.get(win)?.stop();
            const q = frameFor(this.config, win, to);
            win.move_resize_frame(true, q.x, q.y, q.width, q.height);
            return true;
        }
        let floater = this.floaters.get(win);
        if (!floater) {
            floater = new Floater(this, win);
            this.floaters.set(win, floater);
        }
        floater.moveTo(to);
        return true;
    }

    /**
     * Give a window on no strip a size. A side that is at an edge of the
     * view stays there, as a column at the left or the right edge of the
     * view does when its width changes. Anywhere else the window keeps its
     * middle, as far as the edges of the view allow: one stops a side
     * that would grow past it, and a side that is past it already stays
     * where it is.
     */
    _floatSize(win, width, height) {
        const r = this._floatRect(win);
        const b = this._floatBounds(win);
        const along = (at, size, to, lo, span) => {
            if (to === size)
                return at;
            const near = Math.abs(at - lo) <= 1;
            const far = Math.abs(at + size - lo - span) <= 1;
            if (near !== far)
                return near ? lo : lo + span - to;
            const first = Math.min(lo, at);
            const last = Math.max(lo + span, at + size);
            return clamp(Math.round(at + (size - to) / 2), first, Math.max(first, last - to));
        };
        this._floatTo(win, {
            x: along(r.x, r.width, width, b.x, b.width),
            y: along(r.y, r.height, height, b.y, b.height),
            width, height,
        });
    }

    /** The width a share of the view gives a window on no strip: that of a column. */
    _floatWidth(win, proportion) {
        const b = this._floatBounds(win);
        const area = b.strip.area;
        const gap = b.strip.gap;
        return clamp(Math.round((area.width - gap) * proportion - gap),
            Math.min(b.width, Math.max(MIN_COLUMN_WIDTH, minSize(win)[0])), b.width);
    }

    /** cycle-width for a window on no strip: the next of layout.presetWidths, as a column takes them. */
    _cycleFloatWidth(win) {
        const presets = this.config.values.layout.presetWidths;
        if (!presets.length || !this._floatSizes(win))
            return;
        const r = this._floatRect(win);
        const cur = this._floatBounds(win).strip.proportionFor(r.width);
        const ordered = [
            ...presets.filter(p => p > cur + 0.01),
            ...presets.filter(p => p <= cur + 0.01),
        ];
        const next = ordered.find(p => Math.abs(this._floatWidth(win, p) - r.width) > 1);
        if (next !== undefined)
            this._floatSize(win, this._floatWidth(win, next), r.height);
    }

    /**
     * maximize-column for a window on no strip: it fills the place of a
     * column as wide as the view, and the next press gives it the place it
     * had before. A window that fills the view with no such place, sized
     * by hand, gets the size of a window that has just left its strip.
     */
    _toggleFloatFill(win) {
        // Maximized: back to the place Mutter kept for it.
        if (isMaximized(win)) {
            this._unmaximize(win);
            return;
        }
        if (!win.allows_resize())
            return;
        const b = this._floatBounds(win);
        const r = this._floatRect(win);
        const fills = rect => b.width - rect.width <= FULL_SLACK * b.width &&
            b.height - rect.height <= FULL_SLACK * b.height;
        if (!fills(r)) {
            this._floatRestore.set(win, r);
            this._floatTo(win, {x: b.x, y: b.y, width: b.width, height: b.height});
            return;
        }
        const saved = this._floatRestore.get(win);
        this._floatRestore.delete(win);
        const area = b.strip.area;
        const size = saved && !fills(saved)
            ? saved : {width: area.width * 0.55, height: area.height * 0.7};
        // The place from before, when it is on the monitor the window is
        // on now. Else the middle of this one.
        const there = size === saved &&
            saved.x + saved.width / 2 >= area.x && saved.x + saved.width / 2 < area.x + area.width &&
            saved.y + saved.height / 2 >= area.y && saved.y + saved.height / 2 < area.y + area.height;
        this._floatTo(win, there ? saved : {
            x: area.x + (area.width - size.width) / 2,
            y: area.y + (area.height - size.height) / 2,
            width: size.width, height: size.height,
        });
    }

    /**
     * align-left, align-right and align-center for a window on no strip:
     * to that side of the view at the height it has, or to the middle of
     * the monitor, where a new window that floats opens (_centre). A
     * window that fits in the view stays inside it there.
     */
    _alignFloat(win, anchor) {
        const b = this._floatBounds(win);
        const r = this._floatRect(win);
        if (anchor === 'left') {
            r.x = b.x;
        } else if (anchor === 'right') {
            r.x = b.x + b.width - r.width;
        } else {
            const m = global.display.get_monitor_geometry(win.get_monitor());
            const inside = (at, size, lo, span) =>
                size <= span ? clamp(at, lo, lo + span - size) : at;
            r.x = inside(m.x + Math.round((m.width - r.width) / 2), r.width, b.x, b.width);
            r.y = inside(m.y + Math.round((m.height - r.height) / 2), r.height, b.y, b.height);
        }
        this._floatTo(win, r);
    }

    /**
     * A move key for a window on no strip: one step that way, FLOAT_STEP
     * of the width of the work area, and no further than the edge of the
     * view. dx, dy: -1, 0 or 1. Returns false for a window that is at
     * that edge, or past it: the key then takes it to the next monitor or
     * workspace, as it takes a column at the end of its strip.
     */
    _stepFloat(win, dx, dy) {
        if (!win.allows_move())
            return false;
        const b = this._floatBounds(win);
        const r = this._floatRect(win);
        const step = Math.max(1, Math.round(b.strip.area.width * FLOAT_STEP));
        const along = (at, size, lo, span, dir) => {
            if (dir < 0)
                return at > lo ? Math.max(lo, at - step) : null;
            const last = lo + span - size;
            return at < last ? Math.min(last, at + step) : null;
        };
        const to = dx !== 0
            ? along(r.x, r.width, b.x, b.width, dx) : along(r.y, r.height, b.y, b.height, dy);
        if (to === null)
            return false;
        if (dx !== 0)
            r.x = to;
        else
            r.y = to;
        return this._floatTo(win, r);
    }

    focusEdge(last) {
        const strip = this.activeStrip();
        const col = last ? strip?.columns.at(-1) : strip?.columns[0];
        if (col)
            this._activate(col.active ?? col.tiles[0]);
    }

    /**
     * Up/down inside the column, then to the next workspace. A monitor
     * above or below takes the focus where there is no workspace to go to:
     * from a monitor that has none of its own, and from the first or the
     * last workspace.
     */
    focusRow(delta) {
        const tile = this.focusTile;
        if (tile) {
            const col = tile.column;
            const row = col.tiles.indexOf(tile) + delta;
            if (row >= 0 && row < col.tiles.length) {
                this._activate(col.tiles[row]);
                return;
            }
        }
        const strip = this.activeStrip();
        const side = delta < 0 ? Meta.DisplayDirection.UP : Meta.DisplayDirection.DOWN;
        const wm = global.workspace_manager;
        const index = wm.get_active_workspace_index() + delta;
        const none = strip?.workspace === null || index < 0 || index >= wm.get_n_workspaces();
        if (strip && none && this._focusNeighbour(strip.monitor, side))
            return;
        this.switchWorkspace(delta);
    }

    switchWorkspace(delta) {
        const wm = global.workspace_manager;
        this.gotoWorkspace(wm.get_active_workspace_index() + delta);
    }

    gotoWorkspace(index) {
        const wm = global.workspace_manager;
        if (index < 0 || index >= wm.get_n_workspaces())
            return;
        wm.get_workspace_by_index(index).activate(global.get_current_time());
    }

    /**
     * Send a window to a workspace and go there with it.
     *
     * The shell draws a window in the workspace it is on, and this one is
     * on the new workspace already when the two slide: it would be gone
     * from its place in one frame and come in again with the new
     * workspace, from above or below. It is the shell's moving window for
     * the switch (as in the shell's own actionMoveWindow): it is drawn
     * where it is while the workspaces change behind it, and a tile
     * glides to the place it has on the new strip.
     *
     * A fullscreen window, and one that is alone in a column as wide as
     * the view, has the same place on both strips and would stand still:
     * it is nudged the way it goes.
     */
    moveToWorkspace(index, win = global.display.focus_window) {
        const wm = global.workspace_manager;
        if (!win || index < 0 || index >= wm.get_n_workspaces())
            return;
        const from = win.get_workspace()?.index() ?? index;
        if (from === index)
            return;
        const animation = this.animator.enabled ? Main.wm._workspaceAnimation : null;
        const tile = this.tiles.get(win);
        const fills = !!tile?.column &&
            (tile.fullscreen || (tile.column.tiles.length === 1 && this._fillsStrip(tile)));
        // For the groups the shell makes for the switch, see
        // _patchSwitchBackdrop. The shell's field is set for a shell
        // whose groups could not be patched.
        this._movingWindow = animation ? win : null;
        if (animation)
            animation.movingWindow = win;
        win.change_workspace_by_index(index, false);
        wm.get_workspace_by_index(index).activate_with_focus(win, global.get_current_time());
        this._movingWindow = null;
        if (!animation)
            return;
        // The shell has made its animation by now, if it runs one. Left
        // set with none run, the next change of workspace would draw the
        // window as the one that moves.
        animation.movingWindow = null;
        if (fills)
            tile.nudgeBy(0, Math.sign(index - from));
    }

    /**
     * A drop on a workspace row of the minimap: put the window on that
     * workspace of the primary monitor, between the windows whose icons are
     * before and after the drop position. Either can be null. Between two
     * windows of one column it joins that column, else it becomes a column
     * of its own. A floating window only changes workspace and monitor.
     */
    placeWindow(win, index, prev = null, next = null) {
        const wm = global.workspace_manager;
        if (!win || index < 0 || index >= wm.get_n_workspaces())
            return;
        const primary = global.display.get_primary_monitor();
        const crossed = win.get_monitor() !== primary;
        if (crossed)
            win.move_to_monitor(primary);
        if (win.get_workspace()?.index() !== index)
            win.change_workspace_by_index(index, false);
        this._placeBetween(win, prev, next, crossed);
    }

    /**
     * A drop on the card of a monitor that is not the primary: put the
     * window on that monitor, between prev and next as placeWindow() does.
     */
    placeOnMonitor(win, monitor, prev = null, next = null) {
        if (!win || monitor < 0 || monitor >= global.display.get_n_monitors())
            return;
        const crossed = win.get_monitor() !== monitor;
        if (crossed)
            win.move_to_monitor(monitor);
        // With workspaces on every monitor, the card lists the windows of
        // the active workspace, so the window comes to that one.
        const ws = global.workspace_manager.get_active_workspace();
        if (!win.is_on_all_workspaces() && win.get_workspace() !== ws)
            win.change_workspace(ws);
        this._placeBetween(win, prev, next, crossed);
    }

    /**
     * Give the tile of a window that a drop has put on a workspace and a
     * monitor its place in the strip there. crossed: it came from another
     * monitor, and starts at its new place. On the same monitor it glides.
     */
    _placeBetween(win, prev, next, crossed) {
        const tile = this.tiles.get(win);
        if (!tile)
            return;
        // The handlers of the monitor and the workspace change have moved
        // the tile to its strip, except for a window that was dragged over
        // the edge of its monitor: a grabbed tile stays in its strip.
        this._rehome(win);
        const strip = tile.strip;
        if (!strip || !tile.column)
            return;
        const inStrip = w => {
            const t = w ? this.tiles.get(w) : null;
            return t && t !== tile && t.strip === strip ? t : null;
        };
        const before = inStrip(prev);
        const after = inStrip(next);
        if (before || after) {
            const focused = strip.focus === tile;
            const proportion = tile.column.proportion;
            strip.remove(tile);
            if (before && after && before.column === after.column)
                strip.addToColumn(tile, after.column, after.column.tiles.indexOf(after));
            else if (after)
                strip.addColumn(tile, strip.columns.indexOf(after.column), proportion);
            else
                strip.addColumn(tile, strip.columns.indexOf(before.column) + 1, proportion);

            if (focused)
                strip.focus = tile;
        } else if (!crossed) {
            return;
        }
        tile.placed = !crossed;
        this._relayout(strip, strip.focus);
    }

    moveToWorkspaceBy(delta) {
        const win = global.display.focus_window;
        const ws = win?.get_workspace();
        if (ws)
            this.moveToWorkspace(ws.index() + delta, win);
    }

    /**
     * Left and right along the strip. Past its first or last column the
     * column goes to the monitor on that side, as the focus does with
     * focusColumn(). A window on no strip moves that way on its monitor
     * (_stepFloat), and from the edge of it to the monitor on that side.
     */
    moveColumn(delta) {
        const side = delta < 0 ? Meta.DisplayDirection.LEFT : Meta.DisplayDirection.RIGHT;
        const tile = this.focusTile;
        if (!tile) {
            const win = this._floatingFocus();
            if (!win || !this._stepFloat(win, delta, 0))
                this._moveFloating(side);
            return;
        }
        const strip = tile.strip;
        const idx = strip.columns.indexOf(tile.column);
        const to = idx + delta;
        if (to < 0 || to >= strip.columns.length) {
            this._moveToNeighbour([...tile.column.tiles], side);
            return;
        }
        strip.columns.splice(idx, 1);
        strip.columns.splice(to, 0, tile.column);
        this._relayout(strip, tile);
        this._nudgeFull(tile, delta);
    }

    /**
     * The column of tile has changed place on its strip, towards dir (-1
     * left, 1 right). A fullscreen window, and a column as wide as the
     * view, is drawn at the same place before and after: the view follows
     * the column, and only its neighbours move, behind it. Its windows are
     * nudged that way, so the key shows on the window it moved.
     */
    _nudgeFull(tile, dir) {
        const col = tile.column;
        if (!col || !(tile.fullscreen || tile.strip.fillsView(col)))
            return;
        for (const t of col.tiles)
            t.nudgeBy(Math.sign(dir));
    }

    moveColumnToEdge(last) {
        const tile = this.focusTile;
        if (!tile) {
            const win = this._floatingFocus();
            if (win)
                this._alignFloat(win, last ? 'right' : 'left');
            return;
        }
        const strip = tile.strip;
        const idx = strip.columns.indexOf(tile.column);
        strip.columns.splice(idx, 1);
        if (last)
            strip.columns.push(tile.column);
        else
            strip.columns.unshift(tile.column);
        this._relayout(strip, tile);
        if (strip.columns.indexOf(tile.column) !== idx)
            this._nudgeFull(tile, last ? 1 : -1);
    }

    /**
     * Up/down inside the column, then to the next workspace. The window
     * goes to a monitor above or below where there is no workspace to go
     * to, as the focus does with focusRow(). A window on no strip moves up
     * or down on its monitor first (_stepFloat), and goes on from the
     * edge of it.
     */
    moveRow(delta) {
        const tile = this.focusTile;
        if (tile) {
            const col = tile.column;
            const row = col.tiles.indexOf(tile);
            const to = row + delta;
            if (to >= 0 && to < col.tiles.length) {
                col.tiles.splice(row, 1);
                col.tiles.splice(to, 0, tile);
                this._relayout(tile.strip, tile);
                return;
            }
        }
        const win = global.display.focus_window;
        const float = tile ? null : this._floatingFocus();
        if (float && this._stepFloat(float, 0, delta))
            return;
        const strip = tile?.strip ?? (win ? this._stripOn(win.get_monitor()) : null);
        const side = delta < 0 ? Meta.DisplayDirection.UP : Meta.DisplayDirection.DOWN;
        const wm = global.workspace_manager;
        const index = wm.get_active_workspace_index() + delta;
        const none = strip?.workspace === null || index < 0 || index >= wm.get_n_workspaces();
        if (none && (tile ? this._moveToNeighbour([tile], side) : this._moveFloating(side)))
            return;
        this.moveToWorkspaceBy(delta);
    }

    /**
     * Move tiles of one strip to the monitor next to theirs in a
     * direction, as one column in the order given. To the left or the right
     * the column goes to the near end of that monitor's strip, so the
     * opposite key brings it back. Up or down it goes right of the column
     * that had the focus there. Returns false when there is no monitor on
     * that side.
     */
    _moveToNeighbour(tiles, direction) {
        const from = tiles[0].strip;
        const next = global.display.get_monitor_neighbor_index(from.monitor, direction);
        if (next < 0)
            return false;
        const focus = tiles.find(t => t === this.focusTile) ?? tiles[0];
        const weights = tiles.map(t => t.weight);
        // All of them before the first one changes strip: that lays out
        // the strip it leaves, and Mutter moves a window that has been
        // asked for a new size only when its client has answered.
        this._rehomeHeld = true;
        try {
            for (const tile of tiles)
                tile.win.move_to_monitor(next);
        } finally {
            this._rehomeHeld = false;
        }
        for (const tile of tiles)
            this._rehome(tile.win);
        const moved = tiles.filter(t => t.strip && t.strip !== from);
        const lead = moved[0];
        if (!lead)
            return true;
        // Each arrived as a column of its own.
        const to = lead.strip;
        const col = lead.column;
        for (const tile of moved.slice(1)) {
            to.remove(tile);
            to.addToColumn(tile, col);
        }
        tiles.forEach((tile, i) => {
            tile.weight = weights[i];
        });
        if (direction === Meta.DisplayDirection.LEFT ||
            direction === Meta.DisplayDirection.RIGHT) {
            to.columns.splice(to.columns.indexOf(col), 1);
            if (direction === Meta.DisplayDirection.LEFT)
                to.columns.push(col);
            else
                to.columns.unshift(col);
        }
        if (moved.includes(focus)) {
            col.active = focus;
            to.focus = focus;
            this.setActiveMonitor(next);
        }
        from.layout(true);
        this._relayout(to, to.focus);
        return true;
    }

    /**
     * Move the focused window, when it is on no strip, to the monitor next
     * to its own in a direction. It arrives at the near edge of that
     * monitor's view, so the opposite key brings it back. Returns false
     * when nothing was moved.
     */
    _moveFloating(direction) {
        const win = this._floatingFocus();
        if (!win?.allows_move())
            return false;
        const next = global.display.get_monitor_neighbor_index(win.get_monitor(), direction);
        if (next < 0)
            return false;
        this.floaters.get(win)?.stop();
        win.move_to_monitor(next);
        this.setActiveMonitor(next);
        if (win.get_monitor() !== next)
            return true;
        const b = this._floatBounds(win);
        const r = visibleRect(this.config, win);
        if (direction === Meta.DisplayDirection.LEFT)
            r.x = b.x + b.width - r.width;
        else if (direction === Meta.DisplayDirection.RIGHT)
            r.x = b.x;
        else if (direction === Meta.DisplayDirection.UP)
            r.y = b.y + b.height - r.height;
        else
            r.y = b.y;
        const q = frameFor(this.config, win, r);
        win.move_frame(true, q.x, q.y);
        return true;
    }

    /** In a shared column: leave it to that side. Alone: join the neighbour. */
    consumeOrExpel(delta) {
        const tile = this.focusTile;
        if (!tile)
            return;
        const strip = tile.strip;
        const col = tile.column;
        const idx = strip.columns.indexOf(col);
        if (col.tiles.length > 1) {
            const proportion = col.proportion;
            strip.remove(tile);
            strip.addColumn(tile, delta < 0 ? idx : idx + 1, proportion);
        } else {
            const neighbour = strip.columns[idx + delta];
            if (!neighbour)
                return;
            strip.remove(tile);
            strip.addToColumn(tile, neighbour);
        }
        tile.column.active = tile;
        strip.focus = tile;
        this._relayout(strip, tile);
    }

    _relayout(strip, tile) {
        if (tile?.column) {
            strip.freeScroll = false;
            strip.ensureVisible(tile.column);
        }
        strip.layout(true);
        this._changed();
    }

    /**
     * cycle-width: the next of layout.presetWidths. A fullscreen window
     * leaves fullscreen for the first of them, as a column as wide as the
     * view does. A window on no strip takes the same widths where it is
     * (_cycleFloatWidth).
     */
    cycleWidth() {
        const tile = this.focusTile;
        if (!tile) {
            const win = this._floatingFocus();
            if (win)
                this._cycleFloatWidth(win);
            return;
        }
        const presets = this.config.values.layout.presetWidths;
        if (!presets.length)
            return;
        const col = tile.column;
        const strip = tile.strip;
        const left = this._leaveFullscreen(tile);
        if (strip.fits) {
            this._cycleFitWidth(tile, presets);
            if (left)
                this._placeNow(tile);
            return;
        }
        // From fullscreen the cycle starts at the widest, whatever width
        // the column had under it.
        if (left && !this._fillsStrip(tile)) {
            col.restore = col.proportion;
            col.proportion = strip.fullProportion;
        }
        const cur = col.proportion;
        // The presets in cycling order, starting after the current one.
        const ordered = [
            ...presets.filter(p => p > cur + 0.01),
            ...presets.filter(p => p <= cur + 0.01),
        ];
        // A preset narrower than the window goes gives the window's minimum
        // width. Two such presets give the same width, and so does one when
        // the column is already at the minimum. Skip to a preset that
        // changes the width, so every press does something.
        const width = strip.widthFor(col, cur);
        const next = ordered.find(p => Math.abs(strip.widthFor(col, p) - width) > 1) ?? ordered[0];
        this._setProportion(tile, next);
        if (left)
            this._placeNow(tile);
    }

    /** Take the window of a tile out of fullscreen. Returns whether it was in it. */
    _leaveFullscreen(tile) {
        if (!tile.win.is_fullscreen())
            return false;
        tile.win.unmake_fullscreen();
        return true;
    }

    /**
     * Put a tile at its place without the springs: a window that leaves
     * fullscreen for another width has that place at once, as one that
     * leaves it for the width it had (see _onFullscreen).
     */
    _placeNow(tile) {
        if (!tile.target || tile.dead)
            return;
        tile.x.set(tile.target.x);
        tile.y.set(tile.target.y);
        tile.sync();
        this.ring.sync();
    }

    /**
     * Whether the column of a tile is as wide as it can be, within
     * FULL_SLACK: the view, or the monitor over a fullscreen window.
     */
    _fillsStrip(tile) {
        const col = tile.column;
        const strip = tile.strip;
        const full = strip.widthFor(col, strip.fullProportion, {pinned: true});
        const width = strip.fits ? col.width : strip.widthFor(col, col.proportion);
        return full - width <= FULL_SLACK * full;
    }

    /**
     * cycle-width on a strip that does not scroll. The column takes each
     * preset as its share of the view, and the other columns share what is
     * left. After the last preset it shares the view again, as it did
     * before its width was set.
     *
     * As only the ratio between the columns, the presets would do nothing
     * to a window that is alone on its monitor.
     */
    _cycleFitWidth(tile, presets) {
        const col = tile.column;
        const strip = tile.strip;
        const cur = col.proportion;
        const SHARE = null;
        const ordered = col.pinned
            ? [...presets.filter(p => p > cur + 0.01), SHARE, ...presets.filter(p => p <= cur + 0.01)]
            : [...presets];
        const widthAt = p => p === SHARE
            ? strip.widthFor(col, col.shared ?? cur, {pinned: false})
            : strip.widthFor(col, p, {pinned: true});
        const next = ordered.find(p => Math.abs(widthAt(p) - col.width) > 1);
        if (next === undefined)
            return;
        if (next === SHARE) {
            col.pinned = false;
            col.proportion = col.shared ?? cur;
            col.shared = null;
            col.restore = null;
            this.widths.set(tile.win, col.proportion);
            this._relayout(strip, tile);
            return;
        }
        this._setProportion(tile, next);
    }

    adjustWidth(delta) {
        const tile = this.focusTile;
        if (!tile) {
            // A window on no strip: by the same share of the view, around
            // its middle.
            const win = this._floatingFocus();
            if (win && this._floatSizes(win)) {
                const r = this._floatRect(win);
                const p = this._floatBounds(win).strip.proportionFor(r.width) + delta;
                this._floatSize(win, this._floatWidth(win, p), r.height);
            }
            return;
        }
        const col = tile.column;
        const strip = tile.strip;
        // Start from the width the column has, which is more than its
        // proportion says when a window's minimum holds it wider, and is
        // not what its proportion says on a strip that does not scroll.
        const base = strip.proportionFor(
            strip.fits ? col.width : strip.widthFor(col, col.proportion));
        // Narrowing asks the windows again: a minimum learned earlier may
        // not hold any more (Firefox with its sidebar closed, for example).
        if (delta < 0) {
            for (const t of col.tiles)
                t.minWidth = 0;
        }
        this._setProportion(tile, base + delta);
    }

    /**
     * Give the column of a tile another width. A column at the left edge
     * of the view, at the right edge, or in the middle of it stays there,
     * and the columns beside it move.
     *
     * Scrolling the least distance that shows the column whole would keep
     * its left edge. A column at the right edge that became narrower
     * would then be at neither edge, and a column in the middle would be
     * off the middle, or at the right edge when it grew.
     */
    _setProportion(tile, p) {
        const strip = tile.strip;
        const col = tile.column;
        const anchor = strip.anchorOf(col);
        const full = strip.fillsView(col);
        this._pin(tile);
        col.proportion = clamp(p, MIN_PROPORTION, strip.fullProportion);
        col.restore = null;
        this.widths.set(tile.win, col.proportion);
        if (full && !strip.fillsView(col)) {
            this._layoutCentred(tile);
            return;
        }
        if (!anchor) {
            // At none of the three places: the middle, as far as the strip
            // allows. That is where a new window is put when the middle
            // itself is past an end of the strip, so cycle-width keeps it
            // there. A strip that does not scroll has no such place.
            if (strip.fits)
                this._relayout(strip, tile);
            else
                this._layoutCentred(tile);
            return;
        }
        strip.freeScroll &&= anchor === 'middle';
        strip.keepAnchor(col, anchor);
        strip.layout(true);
        this._changed();
    }

    /**
     * Lay out after the column of a tile went from the width of the view to
     * a narrower one, or after any other change of width that leaves it at
     * no place of its own. The column sits in the middle of the view, with
     * a part of each neighbour beside it, as after center-column. The
     * first and the last column have no neighbour on one side and stay at
     * that end of the strip: the view shows no empty space there.
     *
     * A column as wide as the view is at no single place in it (see
     * Strip.anchorOf), so it has no edge to keep when it becomes narrower.
     */
    _layoutCentred(tile) {
        const strip = tile.strip;
        strip.place(tile.column, 'middle');
        strip.layout(true);
        this._changed();
    }

    adjustHeight(delta) {
        const tile = this.focusTile;
        if (!tile) {
            // A window on no strip: by the same share of its height,
            // around its middle.
            const win = this._floatingFocus();
            if (win && this._floatSizes(win)) {
                const r = this._floatRect(win);
                const b = this._floatBounds(win);
                const least = Math.min(b.height, Math.max(FLOAT_MIN_HEIGHT, minSize(win)[1]));
                this._floatSize(win, r.width,
                    clamp(Math.round(r.height * (1 + delta)), least, b.height));
            }
            return;
        }
        if (tile.column.tiles.length < 2)
            return;
        tile.weight = clamp(tile.weight * (1 + delta), 0.25, 4);
        tile.strip.layout(true);
    }

    /** A width set by hand on a strip that does not scroll, see Column.pinned. */
    _pin(tile) {
        const col = tile.column;
        if (!tile.strip.fits || col.pinned)
            return;
        col.pinned = true;
        col.shared = col.proportion;
    }

    /**
     * maximize-column: a column that is not as wide as the view becomes
     * that wide, and one that is becomes narrower again.
     *
     * Which of the two is read from the width the column has, within
     * FULL_SLACK of the widest it can be, and not from Column.restore,
     * which only this key sets. A column made as wide as the view by
     * hand, with the pointer or the width keys, has none, so the first
     * press would make it "as wide as the view" again, which changes
     * nothing on the screen.
     *
     * Narrower is the width from before the key, when there is one and it
     * is narrower. Without one it is the widest of layout.presetWidths
     * that is narrower than the view, two thirds with the defaults. The
     * narrower column is in the middle of the view, see _layoutCentred().
     */
    _toggleMaximizeColumn(tile) {
        const col = tile.column;
        const strip = tile.strip;
        // The widest a column can be: the view, or the monitor over a
        // fullscreen window.
        const widest = strip.fullProportion;
        const full = strip.widthFor(col, widest, {pinned: true});
        const narrower = p => Number.isFinite(p) && p >= MIN_PROPORTION &&
            full - strip.widthFor(col, p, {pinned: true}) > FULL_SLACK * full;
        if (this._fillsStrip(tile)) {
            const presets = this.config.values.layout.presetWidths;
            const target = [
                col.restore,
                ...[...presets].sort((a, b) => b - a),
                this.config.values.layout.defaultWidth,
                2 / 3,
            ].find(narrower);
            if (target === undefined)
                return;
            this._pin(tile);
            col.proportion = target;
            col.restore = null;
            if (!strip.fits) {
                this.widths.set(tile.win, col.proportion);
                this._layoutCentred(tile);
                return;
            }
        } else {
            this._pin(tile);
            col.restore = col.proportion;
            col.proportion = widest;
        }
        this.widths.set(tile.win, col.proportion);
        this._relayout(tile.strip, tile);
    }

    /**
     * maximize-column, see _toggleMaximizeColumn(). A fullscreen window
     * leaves fullscreen for a column as wide as the view. A window on no
     * strip fills the view, see _toggleFloatFill().
     */
    maximizeColumn() {
        const tile = this.focusTile;
        if (!tile) {
            const win = this._floatingFocus();
            if (win)
                this._toggleFloatFill(win);
            return;
        }
        if (!this._leaveFullscreen(tile)) {
            this._toggleMaximizeColumn(tile);
            return;
        }
        if (!this._fillsStrip(tile))
            this._toggleMaximizeColumn(tile);
        this._placeNow(tile);
    }

    toggleFullscreen() {
        const win = global.display.focus_window;
        if (!win)
            return;
        if (win.is_fullscreen())
            win.unmake_fullscreen();
        else
            win.make_fullscreen();
    }

    centerColumn() {
        this.alignColumn('middle');
    }

    /**
     * Slide the column in focus to a place on the screen: 'left', 'right'
     * or 'middle'. The view scrolls, the order of the columns and the
     * focus stay. Not past an end of the strip, see Strip.keepAnchor. A
     * window on no strip goes to that place itself (_alignFloat).
     */
    alignColumn(anchor) {
        const tile = this.focusTile;
        if (!tile) {
            const win = this._floatingFocus();
            if (win)
                this._alignFloat(win, anchor);
            return;
        }
        tile.strip.place(tile.column, anchor);
        tile.strip.layout(true);
        this._changed();
    }

    minimizeWindow() {
        const win = global.display.focus_window;
        if (win && win.get_window_type() === Meta.WindowType.NORMAL && win.can_minimize())
            win.minimize();
    }

    toggleFloat() {
        const win = global.display.focus_window;
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        if (this.tiles.has(win)) {
            const area = this.tiles.get(win).strip.area;
            this.forced.delete(win);
            this.floating.add(win);
            this._untrack(win);
            this._placeFloating(win, area);
            win.make_above();
        } else {
            // Floated by hand, or left out of the strip by an automatic rule.
            // Only a window floated here was put above the others here.
            // Before it is lowered: that asks again whether it tiles.
            this.forced.add(win);
            const lowered = [this.floating.delete(win), this.raised.delete(win)];
            if (lowered.includes(true) && win.is_above())
                win.unmake_above();
            this._retile(win);
            this._onFocus();
        }
        this.ring.sync();
    }

    closeWindow() {
        global.display.focus_window?.delete(global.get_current_time());
    }
}
