// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar: a column of cards on the left edge of the primary monitor.
// Clock, workspace minimap, media, notifications, downloads, privacy, and
// status controls. Cards that have nothing to show (no player, no
// notifications, an empty downloads folder, nothing recorded or listened
// to) are hidden. The downloads card is lib/downloads.js.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GnomeDesktop from 'gi://GnomeDesktop';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Thumbnail} from './corners.js';
import {contentRect} from './crop.js';
import {DownloadsCard} from './downloads.js';
import {EDGE} from './edgefade.js';
import {afterSettle, easeSettled, holdTransitions} from './settle.js';
import {Spring} from './spring.js';
import {steadyLine} from './text.js';

const VERTICAL = Clutter.Orientation.VERTICAL;
const HORIZONTAL = Clutter.Orientation.HORIZONTAL;
const COLLAPSE_MS = 240;
// Frames of the monitor's refresh rate that one frame of the collapse
// animation plays at most. See Sidebar._widthItem.
const COLLAPSE_STEP_FRAMES = 1.5;
// Of 255: the icon of a minimized window in the minimap.
const MINIMIZED_OPACITY = 110;
// The shell's time for a window entering or leaving fullscreen.
const FULLSCREEN_MS = 250;
// A card that comes or goes takes this long, as a row of the minimap does.
const CARD_MS = 200;

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function label(text, styleClass, props = {}) {
    const l = new St.Label({text, style_class: styleClass, ...props});
    steadyLine(l);
    return l;
}

// The box the cards are in. Their shadows reach 14 px past them, which is
// 4 px into the first column of windows. With a paint volume that wide,
// every frame a window there draws also draws the 242 actors of the
// sidebar: 13 ms in each second at 60 frames (measured). The box draws
// nothing from setEdge() on, and reports no paint volume past it. St looks
// at no clip for that volume but clip_to_allocation, which would cut the
// shadows off at the cards.
const SidebarBox = GObject.registerClass(
class KelpSidebarBox extends St.BoxLayout {
    /** edge: the x in the box's own units from which nothing is drawn, null for no cut. */
    setEdge(edge) {
        if (edge === (this._edge ?? null))
            return;
        this._edge = edge;
        // The other three sides are not cut.
        const far = 65536;
        if (edge === null)
            this.remove_clip();
        else
            this.set_clip(-far, -far, far + edge, 2 * far);
        this.queue_redraw();
    }

    vfunc_get_paint_volume(volume) {
        if (!super.vfunc_get_paint_volume(volume))
            return false;
        const edge = this._edge ?? null;
        if (edge === null)
            return true;
        const x = volume.get_origin().x;
        if (x + volume.get_width() > edge)
            volume.set_width(Math.max(0, edge - x));
        return true;
    }
});

// The mark that shows where a dragged minimap icon will land. It is drawn
// over the row, under the pointer. A drop goes to the actor under the pointer,
// found by picking, so the mark leaves itself out of picking and the drop
// reaches the row.
const InsertMark = GObject.registerClass(
class KelpInsertMark extends St.Widget {
    vfunc_pick() {
    }
});

// One child, shown from its top edge down to a share of its height: 1 is all
// of it, 0 is none. The share is a property, so it can be eased, and whatever
// is laid out under this actor moves up as the child closes. The child keeps
// its full height and is cut off, and fades with the share.
const Reveal = GObject.registerClass({
    Properties: {
        'share': GObject.ParamSpec.double('share', 'share', 'share',
            GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class KelpReveal extends St.Widget {
    _init(child) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            x_expand: true,
        });
        this._share = 1;
        this.add_child(child);
    }

    get share() {
        return this._share ?? 1;
    }

    set share(value) {
        if (value === this._share)
            return;
        this._share = value;
        if (this.first_child)
            this.first_child.opacity = Math.round(255 * value);
        this.notify('share');
        this.queue_relayout();
    }

    vfunc_get_preferred_height(forWidth) {
        const [min, nat] = super.vfunc_get_preferred_height(forWidth);
        return [Math.round(min * this.share), Math.round(nat * this.share)];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.first_child;
        if (!child)
            return;
        const width = box.get_width();
        const [, height] = child.get_preferred_height(width);
        const place = new Clutter.ActorBox();
        place.set_origin(0, 0);
        place.set_size(width, height);
        child.allocate(place);
    }
});

// A card and the spacing under it, shown to a share of their height: 1 is
// all, 0 is none. What is over the slot in the sidebar moves down as it
// closes. The card is given that share of its height and fades with it, so
// it gets shorter from the top while its lower edge moves by the share of
// the spacing only. What is in the card has to take a height under its
// own, see FullHeight. The spacing is part of the slot, so a closed slot
// takes no room at all and nothing moves when the card is hidden after
// that.
//
// The slot of a card in the upper part of the sidebar has the spacing over
// the card (above). What is under it moves up as it closes, and the card
// gets shorter from below.
//
// Shown or hidden in one frame, the system card would move the downloads
// pile over it by the card's height in that frame. A card that kept its
// height and moved with the top of the slot would slide down and be cut
// off at the slot's lower edge: a card is to get shorter where it is. The
// media card and the notifications card are in such slots too.
const CardSlot = GObject.registerClass({
    Properties: {
        'share': GObject.ParamSpec.double('share', 'share', 'share',
            GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class KelpCardSlot extends St.Widget {
    /** above: the spacing is over the card, for a slot under another card. */
    _init(child, above = false) {
        super._init({x_expand: true});
        this._above = above;
        this._gap = 0;
        this._shown = child.visible;
        this._share = child.visible ? 1 : 0;
        child.opacity = child.visible ? 255 : 0;
        this.add_child(child);
    }

    get share() {
        return this._share ?? 1;
    }

    set share(value) {
        if (value === this._share)
            return;
        this._share = value;
        if (this.first_child)
            this.first_child.opacity = Math.round(255 * value);
        this.notify('share');
        this.queue_relayout();
    }

    /** px of spacing under the card, or over it. */
    set gap(px) {
        if (px === this._gap)
            return;
        this._gap = px;
        this.queue_relayout();
    }

    /**
     * Open the slot and show the card, or close it and hide the card, over
     * CARD_MS. In one frame with animate false, and for a slot that is not
     * on the screen.
     */
    setShown(show, animate = true) {
        const child = this.first_child;
        if (show === this._shown)
            return;
        this._shown = show;
        this.remove_transition('share');
        if (!animate || !this.mapped || !St.Settings.get().enable_animations) {
            this.share = show ? 1 : 0;
            child.visible = show;
            return;
        }
        if (show)
            child.show();
        this.ease_property('share', show ? 1 : 0, {
            duration: CARD_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!show)
                    child.hide();
            },
        });
    }

    vfunc_get_preferred_width(forHeight) {
        return this.first_child?.get_preferred_width(forHeight) ?? [0, 0];
    }

    vfunc_get_preferred_height(forWidth) {
        const child = this.first_child;
        if (!child?.visible)
            return [0, 0];
        const [, nat] = child.get_preferred_height(forWidth);
        const height = Math.round((nat + this._gap) * this.share);
        return [height, height];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const child = this.first_child;
        if (!child?.visible)
            return;
        const width = box.get_width();
        const [, nat] = child.get_preferred_height(width);
        const top = this._above ? Math.min(box.get_height(), Math.round(this._gap * this.share)) : 0;
        const place = new Clutter.ActorBox();
        place.set_origin(0, top);
        place.set_size(width, Math.min(box.get_height() - top, Math.round(nat * this.share)));
        child.allocate(place);
    }
});

// One child at its natural height, with its lower edge on the lower edge of
// this actor, or its top on the top (top: true). In an actor that is given
// less than that height the rest of the child is cut off, and nothing in
// the child is squeezed or moves. For what is in a card of a CardSlot: the
// edge is the one of the card that stays where it is while the slot closes.
//
// easeOver() is for a child whose own height changes in one frame, a list
// that is built again: this actor then goes from the height it had to the
// new one over CARD_MS, by tail, the px added to the child's height.
const FullHeight = GObject.registerClass({
    Properties: {
        'tail': GObject.ParamSpec.double('tail', 'tail', 'tail',
            GObject.ParamFlags.READWRITE, -100000, 100000, 0),
    },
}, class KelpFullHeight extends St.Widget {
    _init(child, top = false) {
        super._init({clip_to_allocation: true, x_expand: true});
        this._top = top;
        this._tail = 0;
        this.add_child(child);
    }

    get tail() {
        return this._tail ?? 0;
    }

    set tail(value) {
        if (value === this._tail)
            return;
        this._tail = value;
        this.notify('tail');
        this.queue_relayout();
    }

    /** change() changes the height of the child. */
    easeOver(change) {
        const width = this.width;
        const animate = this.mapped && width > 0 && St.Settings.get().enable_animations;
        // The height it is drawn at, a tail that still runs included.
        const before = this.height;
        change();
        this.remove_transition('tail');
        if (!animate) {
            this.tail = 0;
            return;
        }
        const [, after] = this.first_child.get_preferred_height(width);
        this.tail = before - after;
        this.ease_property('tail', 0, {
            duration: CARD_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    vfunc_get_preferred_width(forHeight) {
        return this.first_child.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(forWidth) {
        const [min, nat] = this.first_child.get_preferred_height(forWidth);
        const tail = this.tail;
        if (!tail)
            return [min, nat];
        const height = Math.max(0, nat + tail);
        return [height, height];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const width = box.get_width();
        const [, height] = this.first_child.get_preferred_height(width);
        const place = new Clutter.ActorBox();
        place.set_origin(0, this._top ? 0 : box.get_height() - height);
        place.set_size(width, height);
        this.first_child.allocate(place);
    }
});

// A row of the minimap that takes the height of what is in it over ROW_MS,
// from the height the row before it had.
//
// The rows are built again each time a window, the focus or the workspace
// changes. The active workspace has larger icons and a line for a title, so
// without this a change of workspace would make one row lower and another
// higher in one frame, and the card with them.
//
// grow goes from 0, the height given to growFrom(), to 1, the height of the
// content. While it is under 1 the content has its own height from the top
// of the row and is cut at the row's lower edge.
const ROW_MS = 200;

const EaseRow = GObject.registerClass({
    Properties: {
        'grow': GObject.ParamSpec.double('grow', 'grow', 'grow',
            GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class KelpEaseRow extends St.Button {
    get grow() {
        return this._grow ?? 1;
    }

    set grow(value) {
        if (value === this._grow)
            return;
        this._grow = value;
        this.notify('grow');
        this.queue_relayout();
    }

    growFrom(height) {
        this._from = height;
        this.remove_transition('grow');
        this.grow = 0;
        this.clip_to_allocation = true;
        this.ease_property('grow', 1, {
            duration: ROW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => (this.clip_to_allocation = false),
        });
        // The row has just been built: its first layout and its styles
        // take part of the first frames.
        holdTransitions(this, ['grow']);
    }

    vfunc_get_preferred_height(forWidth) {
        const [min, nat] = super.vfunc_get_preferred_height(forWidth);
        if (this.grow >= 1)
            return [min, nat];
        // Not rounded: with two rows that change at once, one up and one
        // down, each rounded for itself, their sum, the height of the card,
        // would go up and down by a pixel.
        const height = this._from + (nat - this._from) * this.grow;
        return [height, height];
    }

    vfunc_allocate(box) {
        const child = this.child;
        if (this.grow >= 1 || !child) {
            super.vfunc_allocate(box);
            return;
        }
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const width = content.x2 - content.x1;
        const [, height] = child.get_preferred_height(width);
        const place = new Clutter.ActorBox();
        place.set_origin(content.x1, content.y1);
        place.set_size(width, height);
        child.allocate(place);
    }
});

// The list of those rows. tail is added to its height, in px: the height of
// rows that are gone, which goes to 0 over ROW_MS, so the card closes over
// them as it does over a row that gets lower. For a row that is new it is
// the space between two rows, taken off: that space is there from the first
// frame, and the row itself starts at a height of 0.
const EaseList = GObject.registerClass({
    Properties: {
        'tail': GObject.ParamSpec.double('tail', 'tail', 'tail',
            GObject.ParamFlags.READWRITE, -100000, 100000, 0),
    },
}, class KelpEaseList extends St.BoxLayout {
    get tail() {
        return this._tail ?? 0;
    }

    set tail(value) {
        if (value === this._tail)
            return;
        this._tail = value;
        this.notify('tail');
        this.queue_relayout();
    }

    vfunc_get_preferred_height(forWidth) {
        const [min, nat] = super.vfunc_get_preferred_height(forWidth);
        const tail = this.tail;
        return [Math.max(0, min + tail), Math.max(0, nat + tail)];
    }
});

// The fill behind the active workspace of the minimap, and the one behind
// the icon of the focused window. Each is one actor that moves to its new
// place over ROW_MS when the workspace or the focus changes.
//
// The fills are not the backgrounds of the row and of the icon themselves.
// The rows are built again at every change, so such a fill would be gone
// from one place and there at another in one frame.
//
// A mark has the place of its target, an actor of the list, which
// MarkedList reads at every layout. While it moves, its place is between the
// one it had when the target changed (from) and the one the target has now,
// by progress. The target is a new actor after every rebuild: key tells
// whether it stands for the same workspace or window as the one before.
//
// During a three-finger swipe, and while the workspaces slide, the mark is
// held between two actors of the list by the share of the way the swipe has
// gone (hold), so it moves with the fingers and with the windows. The
// workspace and the focus change only when the fingers lift or later: a
// mark that waits for its target would stand still for the whole swipe and
// move after it.
const Mark = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', 'progress', 'progress',
            GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class KelpMark extends St.Widget {
    _init(styleClass) {
        super._init({style_class: styleClass, reactive: false, opacity: 0});
        this.target = null;
        this.key = null;
        this.from = null;   // [x, y, width, height] in the list
        this.box = null;    // where it was put by the last layout
        this.pair = null;   // [a, b, share]: held between two actors, see hold()
    }

    /** Between two actors of the list, share of the way from a to b, whatever the target is. */
    hold(a, b, share) {
        for (const actor of [a, b]) {
            if (this.pair?.includes(actor))
                continue;
            actor.connect('destroy', () => {
                if (this.pair?.includes(actor))
                    this.pair = null;
            });
        }
        this.pair = [a, b, share];
        this.get_parent()?.queue_relayout();
    }

    /**
     * No longer held. The mark stays where it is until settle(), or until
     * moveTo() sends it to a new target from there. Returns whether it was
     * held.
     */
    release() {
        if (!this.pair)
            return false;
        this.pair = null;
        this.remove_transition('progress');
        this.from = this.box;
        this.progress = this.box ? 0 : 1;
        return true;
    }

    /** From where release() left it to its target over ROW_MS, unless it is on its way already. */
    settle() {
        if (this.progress >= 1 || this.get_transition('progress'))
            return;
        this.ease_property('progress', 1, {
            duration: ROW_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    get progress() {
        return this._progress ?? 1;
    }

    set progress(value) {
        if (value === this._progress)
            return;
        this._progress = value;
        this.notify('progress');
        this.get_parent()?.queue_relayout();
    }

    /** actor: the new target, or null for none. animate: false puts it there at once. */
    moveTo(actor, key, animate) {
        const before = this.key;
        this.target = actor;
        this.key = actor ? key : null;
        actor?.connect('destroy', () => {
            if (this.target === actor)
                this.target = null;
        });
        this.get_parent()?.queue_relayout();
        const fade = opacity => {
            if (!animate) {
                this.remove_transition('opacity');
                this.opacity = opacity;
            } else if (this.opacity !== opacity) {
                this.ease({opacity, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
        };
        if (!actor) {
            fade(0);
            return;
        }
        if (!animate) {
            this.remove_transition('progress');
            this.progress = 1;
        } else if (this.key !== before) {
            this.remove_transition('progress');
            // From where it is. With no place before, or one that has
            // faded out, it is at its target at once and fades in.
            const slides = before !== null && this.box && this.opacity > 0;
            this.from = slides ? this.box : null;
            this.progress = slides ? 0 : 1;
            if (slides) {
                this.ease_property('progress', 1, {
                    duration: ROW_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
                // The rows have just been built, as in EaseRow.growFrom().
                holdTransitions(this, ['progress']);
            }
        }
        fade(255);
    }
});

// The list of the minimap with its two marks under it.
const MarkedList = GObject.registerClass(
class KelpMarkedList extends St.Viewport {
    _init(list) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this.rowMark = new Mark('kelp-ws-mark');
        this.cellMark = new Mark('kelp-win-mark');
        this.add_child(this.rowMark);
        this.add_child(this.cellMark);
        this.add_child(list);
    }

    /** [x, y, width, height] of an actor of the list, in this actor. */
    _place(actor) {
        const [width, height] = actor.get_allocation_box().get_size();
        let x = 0;
        let y = 0;
        for (let a = actor; a !== this; a = a.get_parent()) {
            if (!a)
                return null;
            const box = a.get_allocation_box();
            x += box.x1;
            y += box.y1;
        }
        return [x, y, width, height];
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        for (const mark of [this.rowMark, this.cellMark]) {
            const to = mark.target ? this._place(mark.target) : null;
            // With no target it fades out where it is.
            let at = mark.box ?? [0, 0, 0, 0];
            const a = mark.pair ? this._place(mark.pair[0]) : null;
            const b = mark.pair ? this._place(mark.pair[1]) : null;
            if (a && b) {
                // Held by a swipe, see Mark.hold().
                at = a.map((v, i) => v + (b[i] - v) * mark.pair[2]);
            } else if (to) {
                const t = mark.progress;
                at = mark.from && t < 1 ? mark.from.map((v, i) => v + (to[i] - v) * t) : to;
            }
            mark.box = at;
            mark.allocate(new Clutter.ActorBox({
                x1: at[0], y1: at[1], x2: at[0] + at[2], y2: at[1] + at[3],
            }));
        }
    }
});

// A bar with a fill over the left `fraction` of its width: how far a track
// has played, and the meters of the system card. The fill is placed when
// the bar is laid out.
//
// The fill is not given a width, the bar's width times the fraction, each
// time a value is read. An actor that waits for a layout reports its
// natural width, and for such a bar that is the width of the fill. The
// cards are hidden over a fullscreen window and are not laid out there, so
// with each reading the fill would become its own width times the fraction,
// down to nothing. When the cards come back the bar would be empty until
// the next reading, and then jump to its value.
const FillBar = GObject.registerClass(
class KelpFillBar extends St.Widget {
    _init(fillClass, props) {
        super._init(props);
        this._fraction = 0;
        this._fill = new St.Widget({style_class: fillClass});
        this.add_child(this._fill);
    }

    get fraction() {
        return this._fraction;
    }

    set fraction(value) {
        if (value === this._fraction)
            return;
        this._fraction = value;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const fill = new Clutter.ActorBox();
        fill.set_origin(content.x1, content.y1);
        fill.set_size(
            Math.round((content.x2 - content.x1) * this._fraction),
            content.y2 - content.y1);
        this._fill.allocate(fill);
    }
});

// Children of one size, side by side, on as many lines as the width needs.
// Clutter.FlowLayout does this too, but in a row of the minimap it gave every
// child a height of 0.
//
// `ahead` returns the px the container is still going to grow by. While the
// sidebar widens from its collapsed width, the lines are those of the final
// width, and the children that do not fit yet are past the right edge. With
// the lines of the current width every icon would have a line of its own at
// first, and the card would be several times its final height for the first
// frames.
const WrapLayout = GObject.registerClass(
class KelpWrapLayout extends Clutter.LayoutManager {
    _init(spacing, ahead = null) {
        super._init();
        this._spacing = spacing;
        this._ahead = ahead;
    }

    /** Width and height of the largest child, and the number of children. */
    _measure(container) {
        let width = 0, height = 0, count = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            count++;
            width = Math.max(width, child.get_preferred_width(-1)[1]);
            height = Math.max(height, child.get_preferred_height(-1)[1]);
        }
        return [width, height, count];
    }

    _perLine(forWidth, width, count) {
        if (forWidth < 0)
            return Math.max(1, count);
        forWidth += this._ahead?.() ?? 0;
        return Math.max(1, Math.floor((forWidth + this._spacing) / (width + this._spacing)));
    }

    vfunc_get_preferred_width(container, _forHeight) {
        const [width, , count] = this._measure(container);
        return [width, count * width + Math.max(0, count - 1) * this._spacing];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const [width, height, count] = this._measure(container);
        if (count === 0)
            return [0, 0];
        const lines = Math.ceil(count / this._perLine(forWidth, width, count));
        const total = lines * height + (lines - 1) * this._spacing;
        return [total, total];
    }

    vfunc_allocate(container, box) {
        const [width, height, count] = this._measure(container);
        const perLine = this._perLine(box.get_width(), width, count);
        let i = 0;
        for (const child of container.get_children()) {
            if (!child.visible)
                continue;
            const x = box.x1 + (i % perLine) * (width + this._spacing);
            const y = box.y1 + Math.floor(i / perLine) * (height + this._spacing);
            child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + height}));
            i++;
        }
    }
});

function iconButton(iconName, styleClass, onClick) {
    const button = new St.Button({
        style_class: `kelp-icon-button ${styleClass}`,
        child: new St.Icon({icon_name: iconName, style_class: 'kelp-icon'}),
        can_focus: true,
        x_expand: true,
    });
    button.connect('clicked', onClick);
    return button;
}

// ---------------------------------------------------------------- clock

class ClockCard {
    constructor(sidebar) {
        this._sidebar = sidebar;
        this._time = new St.Label({style_class: 'kelp-clock-time', y_align: Clutter.ActorAlign.END});
        this._ampm = new St.Label({style_class: 'kelp-clock-ampm', y_align: Clutter.ActorAlign.END});
        this._date = label('', 'kelp-clock-date');
        this._short = new St.Label({
            style_class: 'kelp-clock-short', x_align: Clutter.ActorAlign.CENTER, visible: false,
        });
        this._timeRow = new St.BoxLayout({style_class: 'kelp-clock-row'});
        this._timeRow.add_child(this._time);
        this._timeRow.add_child(this._ampm);
        // The current week, one cell per day, today highlighted.
        this._week = new St.BoxLayout({style_class: 'kelp-week', x_expand: true});
        this._weekKey = '';
        // The collapsed style goes at once when the sidebar expands, and
        // the card widens over COLLAPSE_MS. For its first four frames the
        // card is narrower than the time at its large size (68 px), and a
        // label that shortens its text would show an ellipsis there, which
        // is seen as a flash. So the text is not shortened. It is cut off
        // at the edge of the card, and shows as the card widens. The date
        // does not wrap either: it would break as "Saturd-" on the first
        // frame.
        for (const text of [this._time, this._ampm, this._date])
            text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._date.clutter_text.line_wrap = false;
        // The markup of the collapsed time, see _update(). It is set again
        // once the label has given its text the font of a new style.
        // Without that the text is laid out without the line height of the
        // markup after every style change, until the next minute sets the
        // markup again: the collapsed card is 92 px high for that time and
        // 81 px after it, and every card under it moves up by 11 px with
        // the minute.
        this._stacked = null;
        this._time.connect_after('style-changed', () => {
            if (this._collapsed && this._stacked)
                this._time.clutter_text.set_markup(this._stacked);
        });
        const box = new St.BoxLayout({
            orientation: VERTICAL, x_expand: true, clip_to_allocation: true,
        });
        box.add_child(this._timeRow);
        box.add_child(this._short);
        box.add_child(this._date);
        box.add_child(this._week);

        const surface = new St.Button({
            style_class: 'kelp-card kelp-clock',
            child: box,
            can_focus: true,
        });
        surface.connect('clicked', () => sidebar.tweaks.toggleDateMenu(this.actor));
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true}, true);

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._settings.connectObject('changed::clock-format', () => this._update(), this);
        this._clock = new GnomeDesktop.WallClock();
        this._clock.connectObject('notify::clock', () => this._update(), this);
        this._update();
    }

    setCollapsed(collapsed) {
        this._collapsed = collapsed;
        this._date.visible = !collapsed;
        this._week.visible = !collapsed;
        this._short.visible = collapsed;
        this._timeRow.x_align = collapsed ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.START;
        this._update();
    }

    /** Rebuild the week strip when the day changes. */
    _updateWeek(now) {
        const key = now.format('%F');
        if (key === this._weekKey)
            return;
        this._weekKey = key;
        this._week.destroy_all_children();
        // get_day_of_week() is 1 (Monday) to 7; the week start is 0 (Sunday) to 6.
        const offset = (now.get_day_of_week() % 7 - Shell.util_get_week_start() + 7) % 7;
        for (let i = 0; i < 7; i++) {
            const day = now.add_days(i - offset);
            const cell = new St.BoxLayout({
                orientation: VERTICAL,
                style_class: 'kelp-week-day',
                x_expand: true,
            });
            if (i === offset)
                cell.add_style_class_name('today');
            cell.add_child(new St.Label({
                text: day.format('%a').slice(0, 1).toUpperCase(),
                style_class: 'kelp-week-letter',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            cell.add_child(new St.Label({
                text: day.format('%-e'),
                style_class: 'kelp-week-number',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            // Not shortened while the card widens, see the constructor.
            for (const text of cell.get_children())
                text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._week.add_child(cell);
        }
    }

    _update() {
        const now = GLib.DateTime.new_now_local();
        const h24 = this._settings.get_string('clock-format') === '24h';
        const hour = h24 ? now.format('%H') : now.format('%l').trim();
        const minute = now.format('%M');
        if (this._collapsed) {
            // Hours over minutes, and the weekday and day under them. The
            // hour has two digits here ("01"), so the two lines are the
            // same width. The line height comes from markup, because St
            // replaces the attributes of the text on every style change.
            const stacked = h24 ? hour : now.format('%I');
            this._stacked = `<span line_height="0.8">${stacked}\n${minute}</span>`;
            this._time.clutter_text.set_markup(this._stacked);
            this._ampm.visible = false;
            this._short.text = now.format('%a %-e').toUpperCase();
        } else {
            this._time.text = `${hour}:${minute}`;
            this._ampm.text = h24 ? '' : now.format('%p');
            this._ampm.visible = !h24;
        }
        this._date.text = now.format('%A, %b %-e');
        this._updateWeek(now);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._clock.disconnectObject(this);
        this._clock = null;
    }
}

// ---------------------------------------------------------------- preview

// The largest size of the thumbnail, px.
const PREVIEW_WIDTH = 400;
const PREVIEW_HEIGHT = 270;

/** A live thumbnail of a window, shown next to the minimap icon under the pointer. */
class Preview {
    constructor(sidebar) {
        this._sidebar = sidebar;
        this._thumb = new St.Widget({style_class: 'kelp-preview-thumb', clip_to_allocation: true});
        this._title = label('', 'kelp-preview-title');
        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-preview',
            orientation: VERTICAL,
        });
        surface.add_child(this._thumb);
        surface.add_child(this._title);
        this.actor = sidebar.backdrop.wrap(surface, 'kelp-shadow-float', {
            reactive: false,
            visible: false,
            opacity: 0,
        }, true);
        Main.layoutManager.addTopChrome(this.actor);
    }

    show(win, anchor) {
        // The surface and not the window actor: a tiled window's actor is
        // clipped to the view, and a column out of view is clipped to nothing.
        const source = win.get_compositor_private()?.get_first_child();
        if (!source)
            return;
        const s = scaleFactor();
        const frame = contentRect(this._sidebar.config, win);
        const buffer = win.get_buffer_rect();
        const k = Math.min(PREVIEW_WIDTH * s / frame.width, PREVIEW_HEIGHT * s / frame.height, 1);
        this._clear();
        this._thumb.set_size(Math.round(frame.width * k), Math.round(frame.height * k));
        this._thumb.add_child(new Thumbnail({
            source,
            x: Math.round((buffer.x - frame.x) * k),
            y: Math.round((buffer.y - frame.y) * k),
            width: Math.round(buffer.width * k),
            height: Math.round(buffer.height * k),
        }));
        this._title.text = win.get_title() ?? '';
        this._title.set_width(Math.round(frame.width * k));

        const monitor = Main.layoutManager.primaryMonitor;
        const [, ay] = anchor.get_transformed_position();
        const [, natH] = this.actor.get_preferred_height(-1);
        const x = this._sidebar.rightEdge + 8 * s;
        const y = Math.max(monitor.y + 8 * s,
            Math.min(ay + anchor.height / 2 - natH / 2, monitor.y + monitor.height - natH - 8 * s));
        this.actor.set_position(Math.round(x), Math.round(y));
        this.actor.show();
        this.actor.remove_all_transitions();
        this.actor.translation_x = this.actor.opacity === 0 ? -6 * s : this.actor.translation_x;
        // Once the thumbnail has been drawn, see settle.js.
        easeSettled(this.actor, {
            opacity: 255,
            translation_x: 0,
            duration: 140,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    hide() {
        if (!this.actor.visible)
            return;
        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.actor.hide();
                this._clear();
            },
        });
    }

    _clear() {
        this._thumb.destroy_all_children();
    }

    destroy() {
        this._clear();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}

// ---------------------------------------------------------------- minimap

// Opacity of the icons of a workspace that is not the active one, 0 to 255.
const REST_OPACITY = 150;
// Size of the icon that follows the pointer in a drag, px.
const DRAG_ICON = 36;
// The title line of the active workspace opens and closes in this time.
const CAPTION_MS = 180;
// The icons of a workspace grow in when it becomes the active one.
const ARRIVE_MS = 200;
const ARRIVE_STAGGER_MS = 25;
const ARRIVE_SCALE = 0.6;

class Minimap {
    constructor(sidebar) {
        this._sidebar = sidebar;
        this._tiling = sidebar.tiling;
        this._tracker = Shell.WindowTracker.get_default();
        this._signature = '';
        this._scrollAcc = 0;
        this._iconGeometry = new Set();   // windows given a rectangle to minimize to

        this._rows = new EaseList({
            orientation: VERTICAL,
            style_class: 'kelp-ws-list',
            x_expand: true,
        });
        this._marked = new MarkedList(this._rows);
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            child: this._marked,
            x_expand: true,
        });
        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-minimap',
            orientation: VERTICAL,
            reactive: true,
        });
        surface.add_child(this._scroll);
        surface.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true}, true);

        // A card for every monitor but the primary, under this one, with
        // the icons of the windows on that monitor. Workspaces are on the
        // primary monitor only, so such a card has one row and no numbers.
        this.monitors = new St.BoxLayout({
            orientation: VERTICAL,
            x_expand: true,
            visible: false,
        });
        this._monitorCards = new Map();   // monitor index -> {actor, surface, row}

        this._preview = new Preview(sidebar);
        this._tiling.onChanged(() => this.queueRebuild());
        // A window that is recorded or shared has a dot on its icon.
        sidebar.privacy?.onChanged(() => this.queueRebuild());
        this._settleId = 0;
        this._tiling.onBetween(() => this._syncBetween());
        Main.layoutManager.connectObject('monitors-changed', () => this.queueRebuild(), this);
        this._rebuild();
    }

    setCollapsed(collapsed) {
        this._collapsed = collapsed;
        this._signature = '';
        // The rows change their form and the card its width: the heights
        // of the rows before say nothing about the new ones.
        this._plain = true;
        this._rebuild();
    }

    /** Build the rows now, with no animation from the rows before. */
    rebuildNow() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._plain = true;
        this._rebuild();
    }

    queueRebuild() {
        // The tiling still reports changes while the shell ends, after the
        // sidebar is gone. Rows built again then are logged as "has been
        // already disposed".
        if (this._idleId || this._destroyed)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            if (this._dragging)
                this._pending = true;
            else
                this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onScroll(event) {
        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            this._scrollAcc += dy;
            if (Math.abs(this._scrollAcc) >= 1) {
                step = Math.sign(this._scrollAcc);
                this._scrollAcc = 0;
            }
            break;
        }
        default:
            break;
        }
        if (step)
            this._tiling.switchWorkspace(step);
        return Clutter.EVENT_STOP;
    }

    _rebuild() {
        const wm = global.workspace_manager;
        const n = wm.get_n_workspaces();
        const active = wm.get_active_workspace_index();
        const focus = global.display.focus_window;
        const model = [];
        for (let i = 0; i < n; i++)
            model.push(this._tiling.windowsOf(wm.get_workspace_by_index(i)));
        // With dynamic workspaces the shell keeps one empty workspace after
        // the last one in use. For a moment it has two: a new window (a file
        // chooser, for example) counts on the empty one until it is placed,
        // so the shell adds another and removes it again. Only one empty
        // row is shown after the last workspace with a window, and every
        // row up to the active workspace.
        if (Meta.prefs_get_dynamic_workspaces()) {
            let last = model.length - 1;
            while (last > 0 && model[last].length === 0)
                last--;
            model.length = Math.min(model.length, Math.max(last + 2, active + 1));
        }

        const primary = global.display.get_primary_monitor();
        const others = [];
        for (let m = 0; m < global.display.get_n_monitors(); m++) {
            if (m !== primary)
                others.push({monitor: m, wins: this._tiling.windowsOn(m)});
        }

        const attention = w => w.urgent || w.demands_attention;
        const cast = w => this._sidebar.privacy?.castOf(w) ?? null;
        const ids = wins => wins.map(w => [w.get_id(), attention(w), cast(w)]);
        const signature = JSON.stringify([
            model.map(ids), active, focus?.get_id() ?? 0,
            others.map(o => [o.monitor, ids(o.wins)]),
        ]);
        if (signature === this._signature)
            return;
        this._signature = signature;

        // The title lines as they are now, before the rows are built again.
        const titleOf = row => row?._reveal
            ? {index: row._index, share: row._reveal.share, text: row._caption.text} : null;
        const before = titleOf(this._rows.get_children().find(r => r._reveal));
        const beforeOn = new Map();
        for (const [monitor, card] of this._monitorCards)
            beforeOn.set(monitor, titleOf(card.surface.first_child));

        // The heights the rows have now, in the middle of an earlier
        // change too: the new rows start from them.
        const old = this._rows.get_children();
        const ease = !this._plain && old.length > 0 && this._rows.mapped;
        this._plain = false;
        const heights = old.map(row => row.height);
        const spacing = this._rows.layout_manager?.spacing ?? 0;
        let tail = this._rows.tail;

        this._hidePreview();
        this._rows.destroy_all_children();
        model.forEach((wins, index) => {
            this._rows.add_child(this._buildRow(index, wins, index === active, focus));
        });
        this._rows.remove_transition('tail');
        if (ease) {
            const rows = this._rows.get_children();
            rows.forEach((row, index) => row.growFrom(heights[index] ?? 0));
            for (let i = rows.length; i < heights.length; i++)
                tail += heights[i] + spacing;
            tail -= Math.max(0, rows.length - heights.length) * spacing;
        } else {
            tail = 0;
        }
        this._rows.tail = tail;
        if (tail !== 0) {
            this._rows.ease_property('tail', 0, {
                duration: ROW_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
            holdTransitions(this._rows, ['tail']);
        }
        // The two fills move to the active workspace and to the icon of the
        // focused window.
        const rows = this._rows.get_children();
        let focused = null;
        for (const row of rows)
            focused ??= row._slots?.find(slot => slot.win === focus)?.cell ?? null;
        this._marked.rowMark.moveTo(rows[active] ?? null, active, ease);
        this._marked.cellMark.moveTo(focused, focus?.get_id(), ease);
        // A swipe that holds a fill holds it between the new rows.
        this._syncBetween();
        // The title line closes when the focus leaves the windows of the
        // active workspace, and opens when it comes back. It starts from the
        // height the line of the same workspace had, with the title that
        // line showed while it closes.
        this._settleCaption(this._rows.get_child_at_index(active),
            before?.index === active ? before : null);
        this._rebuildMonitors(others, focus, beforeOn);
        // Not after a swipe: the icons of that row have grown to their
        // size with the fingers.
        if (this._active !== undefined && this._active !== active && !this._collapsed &&
            !this._morphed)
            this._arrive(this._rows.get_child_at_index(active));
        this._morphed = false;
        this._active = active;
    }

    /**
     * A swipe has the workspaces or the windows between two of them, or
     * has ended (Tiling.between). While it lasts, the fill of the active
     * workspace lies between the rows of the two workspaces, and the fill
     * of the focused window between the icons of the two windows.
     *
     * Between two workspaces, the two rows are drawn between their forms
     * by the same share (_morphRow), and the fill of the focused window
     * lies between the icon it is on and the icon of the window that has
     * the focus of the other workspace.
     *
     * When it ends, the rows are built for the new workspace or focus at
     * once, where that is queued, and the fills go on from where they are
     * to their new places. Left to the idle callback, that came 50 ms
     * after the fingers had lifted (measured), with the windows on their
     * way and the fill at rest. A fill that has no new place goes back to
     * its own from an idle callback: sent on at once in every case, it
     * would start back towards the window the swipe began on before the
     * rows are built, and turn round.
     */
    _syncBetween() {
        if (this._destroyed)
            return;
        const {workspaces, windows} = this._tiling.between;
        const rows = this._rows.get_children();
        const cellOf = win => {
            for (const row of rows) {
                const cell = row._slots?.find(slot => slot.win === win)?.cell;
                if (cell)
                    return cell;
            }
            return null;
        };
        let ended = false;
        const place = (mark, a, b, share) => {
            if (a && b)
                mark.hold(a, b, share);
            else if (mark.release())
                ended = true;
        };
        place(this._marked.rowMark,
            workspaces && rows[workspaces[0]], workspaces && rows[workspaces[1]], workspaces?.[2]);
        // The window a workspace shows as focused: the one that has the
        // focus, in the active workspace, else the one its strip has.
        const active = global.workspace_manager.get_active_workspace_index();
        const focus = global.display.focus_window;
        const focusOf = index => index === active && focus && rows[index]?._slots?.some(slot => slot.win === focus)
            ? focus : this._tiling.focusOf(index);
        let pair = windows;
        if (!pair && workspaces) {
            const [a, b, share] = workspaces;
            pair = [focusOf(a), focusOf(b), share];
        }
        place(this._marked.cellMark,
            pair && cellOf(pair[0]), pair && cellOf(pair[1]), pair?.[2]);
        if (workspaces && !this._collapsed) {
            const [a, b, share] = workspaces;
            rows.forEach((row, index) => {
                let amount = 0;
                if (index === a)
                    amount = a === b ? 1 : 1 - share;
                else if (index === b)
                    amount = share;
                // Not a row that has its form: at rest and built at rest.
                if (amount !== row._amount)
                    this._morphRow(row, amount, focusOf(index));
            });
            this._morphing = true;
        }
        // The rows that were drawn between two forms are built again in
        // any case: their icons have a picture of another size.
        const morphed = this._morphing && !workspaces;
        if (!ended && !morphed)
            return;
        if (morphed) {
            this._morphing = false;
            this._morphed = true;
            this._signature = '';
        }
        if ((this._idleId || morphed) && !this._dragging) {
            if (this._idleId)
                GLib.source_remove(this._idleId);
            this._idleId = 0;
            this._rebuild();
        }
        // After a rebuild that is queued later: an idle of a lower
        // priority than the one of queueRebuild().
        this._settleId ||= GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._settleId = 0;
            this._marked.rowMark.settle();
            this._marked.cellMark.settle();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Give the title line of a row that was built again the height its
     * windows call for, starting from the height `before` had (null: the
     * row is new, and the line has that height at once).
     */
    _settleCaption(row, before) {
        if (!row?._reveal)
            return;
        const open = row._named ? 1 : 0;
        const from = before ? before.share : open;
        row._reveal.share = from;
        if (from === open)
            return;
        if (!open)
            row._caption.text = before.text;
        row._reveal.ease_property('share', open, {
            duration: CAPTION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /** One card for each monitor in `others`: [{monitor, wins}]. */
    _rebuildMonitors(others, focus, before) {
        const live = new Set(others.map(o => o.monitor));
        for (const [monitor, card] of this._monitorCards) {
            if (live.has(monitor))
                continue;
            card.actor.destroy();
            this._monitorCards.delete(monitor);
        }
        for (const {monitor, wins} of others) {
            let card = this._monitorCards.get(monitor);
            if (!card) {
                const surface = new St.BoxLayout({
                    style_class: 'kelp-card kelp-minimap',
                    orientation: VERTICAL,
                    reactive: true,
                });
                card = {
                    surface,
                    actor: this._sidebar.backdrop.wrap(surface, '', {x_expand: true}, true),
                };
                this._monitorCards.set(monitor, card);
                this.monitors.add_child(card.actor);
            }
            card.surface.destroy_all_children();
            const row = this._buildMonitorRow(monitor, wins, focus);
            card.row = row;
            card.surface.add_child(row);
            this._settleCaption(row, before.get(monitor) ?? null);
        }
        this.monitors.visible = others.length > 0;
    }

    /**
     * The row of a monitor's card: a mark where a workspace has its number,
     * then the icons of the windows on the monitor, at the size the active
     * workspace has. The title line is that of the focused window, when it
     * is on this monitor. A click on the row makes the monitor the one the
     * keys act on. Icons are dragged to and from it as for a workspace row.
     */
    _buildMonitorRow(monitor, wins, focus) {
        const grid = !this._collapsed;
        const cells = this._cellBox();
        const box = new St.BoxLayout({style_class: 'kelp-ws-box', x_expand: true});
        let caption = null;
        let reveal = null;
        if (grid) {
            box.add_child(new St.Icon({
                icon_name: 'video-display-symbolic',
                style_class: 'kelp-monitor-mark',
                y_align: Clutter.ActorAlign.START,
            }));
            caption = label('', 'kelp-ws-caption', {x_expand: true});
            reveal = new Reveal(caption);
            const column = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
            column.add_child(cells);
            column.add_child(reveal);
            box.add_child(column);
        } else {
            box.add_child(cells);
        }
        const row = new St.Button({
            style_class: 'kelp-ws',
            child: box,
            x_expand: true,
            can_focus: true,
        });
        row.connect('clicked', () => this._tiling.focusMonitor(monitor));
        const slots = [];
        row._sideBySide = grid;
        this._takeDrops(row, slots,
            (win, prev, next) => this._tiling.placeOnMonitor(win, monitor, prev, next));
        if (wins.length === 0) {
            this._addCell(cells, this._addButton(() => {
                this._tiling.focusMonitor(monitor);
                this._sidebar.launcher?.open();
            }));
        }
        const named = this._fillCells(cells, wins, focus, true, caption, slots);
        if (named)
            row.add_style_pseudo_class('checked');
        row._caption = caption;
        row._reveal = reveal;
        row._named = named !== null;
        return row;
    }

    /** The container of a row's icons: lines side by side, or a column collapsed. */
    _cellBox() {
        const gap = 2 * scaleFactor();   // .kelp-ws-cells spacing
        return this._collapsed
            ? new St.BoxLayout({
                orientation: VERTICAL,
                style_class: 'kelp-ws-cells',
                x_expand: true,
            })
            : new St.Widget({
                layout_manager: new WrapLayout(gap, () => this._sidebar.widthAhead()),
                x_expand: true,
            });
    }

    _addCell(cells, cell) {
        // Collapsed, the cells sit in the middle of the row, so the
        // space is the same on both sides for any card width.
        if (this._collapsed)
            cell.x_align = Clutter.ActorAlign.CENTER;
        cells.add_child(cell);
    }

    /** The plus of a row with no window. */
    _addButton(run) {
        const add = new St.Button({
            style_class: 'kelp-win kelp-win-add',
            child: new St.Icon({icon_name: 'list-add-symbolic', style_class: 'kelp-icon'}),
        });
        add.connect('clicked', run);
        return add;
    }

    /**
     * Add the icons of wins to a row, and show in its title line (caption,
     * or null) the title of the focused window or of the icon under the
     * pointer. slots collects {win, cell} for the drop position. Returns
     * the focused window if it is one of wins, else null.
     */
    _fillCells(cells, wins, focus, active, caption, slots) {
        const named = wins.includes(focus) ? focus : null;
        let shown = named;
        const showTitle = (win, hovered) => {
            shown = win;
            caption.text = win?.title ?? '';
            if (hovered)
                caption.add_style_pseudo_class('hover');
            else
                caption.remove_style_pseudo_class('hover');
        };
        // A terminal changes its title many times a second. The text is
        // set in place, so that does not rebuild the list.
        const followTitle = win => win.connectObject('notify::title', () => {
            if (shown === win)
                caption.text = win.title ?? '';
        }, caption);
        for (const win of wins) {
            const cell = this._buildCell(win, win === focus, active);
            slots.push({win, cell});
            this._addCell(cells, cell);
            if (!caption)
                continue;
            cell.connect('notify::hover', () => showTitle(cell.hover ? win : named, cell.hover));
            followTitle(win);
        }
        if (caption)
            showTitle(named, false);
        return named;
    }

    /** Grow the icons of a row in, one after the other. */
    _arrive(row) {
        row?._slots.forEach(({cell}, i) => {
            cell.set_pivot_point(0.5, 0.5);
            cell.set_scale(ARRIVE_SCALE, ARRIVE_SCALE);
            cell.opacity = 0;
            cell.ease({
                scale_x: 1,
                scale_y: 1,
                opacity: 255,
                delay: i * ARRIVE_STAGGER_MS,
                duration: ARRIVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
    }

    /**
     * One workspace: its number, then the icons of its windows, side by side.
     * The active workspace has larger icons at full opacity, and one line of
     * text under them: the title of the focused window, or of the window
     * under the pointer. Collapsed, every workspace is a column of icons.
     */
    _buildRow(index, wins, active, focus) {
        const grid = !this._collapsed;
        const cells = this._cellBox();
        const box = new St.BoxLayout({style_class: 'kelp-ws-box', x_expand: true});
        if (grid) {
            box.add_child(new St.Label({
                text: `${index + 1}`,
                style_class: 'kelp-ws-number',
                y_align: Clutter.ActorAlign.START,
            }));
        }
        // The title line of the active workspace. It has its height while
        // a window of the workspace has the focus, and keeps it when the
        // pointer moves over an icon. With no focused window here it has no
        // height: _rebuild() closes and opens it.
        // Every other row has the line too, with no height. A swipe to that
        // workspace opens it with the fingers, see _morphRow.
        let caption = null;
        let reveal = null;
        let restCaption = null;
        let restReveal = null;
        if (grid) {
            const line = label('', 'kelp-ws-caption', {x_expand: true});
            const shown = new Reveal(line);
            if (active) {
                caption = line;
                reveal = shown;
            } else {
                restCaption = line;
                restReveal = shown;
                shown.share = 0;
            }
            const column = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
            column.add_child(cells);
            column.add_child(shown);
            box.add_child(column);
        } else {
            box.add_child(cells);
        }

        const row = new EaseRow({
            style_class: grid && !active ? 'kelp-ws kelp-ws-rest' : 'kelp-ws',
            child: box,
            x_expand: true,
            can_focus: true,
        });
        if (active)
            row.add_style_pseudo_class('checked');
        row.connect('clicked', () => this._tiling.gotoWorkspace(index));
        if (grid && !active) {
            cells.opacity = REST_OPACITY;
            row.connect('notify::hover', () => cells.ease({
                opacity: row.hover ? 255 : REST_OPACITY,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            }));
        }
        const slots = [];
        row._index = index;
        row._sideBySide = grid;
        this._takeDrops(row, slots,
            (win, prev, next) => this._tiling.placeWindow(win, index, prev, next));

        if (wins.length === 0) {
            this._addCell(cells, this._addButton(() => {
                this._tiling.gotoWorkspace(index);
                this._sidebar.launcher?.open();
            }));
        }
        const named = this._fillCells(cells, wins, focus, active, caption, slots);
        row._caption = caption;
        row._reveal = reveal;
        row._named = named !== null;
        // For _morphRow(): the form the row was built in, and its parts.
        row._built = active ? 1 : 0;
        row._amount = row._built;
        row._cellBox = cells;
        row._number = grid ? box.first_child : null;
        row._restCaption = restCaption;
        row._restReveal = restReveal;
        return row;
    }

    /**
     * Draw a row of the grid between its form at rest (amount 0) and the
     * form of the active workspace (1): the cells from 24 to 30 px and
     * their icons from 16 to 24 px, the icons from REST_OPACITY to full,
     * the number from its place and colour at rest to those of the active
     * row, and the title line from closed to open. A swipe up or down
     * gives the row it leaves and the row it goes to their amounts, so
     * both change with the fingers (_syncBetween). focus: the window whose
     * title the line of a row at rest shows as it opens, or null.
     *
     * The rows are built again when the workspace has changed, and take
     * these forms then in one step: the active row with its icons at their
     * size from the first frame. With nothing drawn in between, the icons
     * and the title line stood still for the whole swipe and changed after
     * it.
     *
     * An icon is scaled from a picture of 24 px, also in the row that
     * grows: its picture of 16 px would be drawn at one and a half times
     * its size by the end of the swipe.
     */
    _morphRow(row, amount, focus) {
        if (!row?._cellBox || !row._number || row._amount === amount)
            return;
        row._amount = amount;
        const k = scaleFactor();
        const size = (24 + 6 * amount) * k;
        for (const cell of row._cellBox.get_children()) {
            cell.set_size(size, size);
            const icon = cell._icon;
            if (!icon)
                continue;
            if (cell._iconPx < 24 && icon instanceof St.Icon) {
                icon.icon_size = 24;
                cell._iconPx = 24;
            }
            const scale = (16 + 8 * amount) / cell._iconPx;
            icon.set_pivot_point(0.5, 0.5);
            icon.set_scale(scale, scale);
        }
        if (!row.hover)
            row._cellBox.opacity = Math.round(REST_OPACITY + (255 - REST_OPACITY) * amount);
        // The number of a row at rest has the colour of the active one at
        // 36% (.kelp-ws-number), and lies 3 px higher.
        row.add_style_pseudo_class('checked');
        row._number.opacity = Math.round(255 * (0.36 + 0.64 * amount));
        row._number.translation_y = (4 + 3 * amount - (row._built ? 7 : 4)) * k;
        const reveal = row._reveal ?? row._restReveal;
        if (!reveal)
            return;
        if (row._restCaption)
            row._restCaption.text = focus?.title ?? '';
        const open = row._built ? row._named : focus !== null;
        reveal.remove_transition('share');
        reveal.share = open ? amount : 0;
    }

    /**
     * Make a row take dragged icons. slots is the row's icons in order,
     * [{win, cell}], for the drop position. place(win, prev, next) puts a
     * dropped window between the windows prev and next of the row.
     */
    _takeDrops(row, slots, place) {
        row._slots = slots;
        row._place = place;
        row._delegate = {
            handleDragOver: (source, _actor, x, y) => {
                if (!source?.metaWindow)
                    return DND.DragMotionResult.CONTINUE;
                this._setDropRow(row);
                this._showInsert(this._dropPlace(row, slots, source.metaWindow, x, y));
                return DND.DragMotionResult.MOVE_DROP;
            },
            acceptDrop: (source, _actor, x, y) => {
                if (!source?.metaWindow)
                    return false;
                const at = this._dropPlace(row, slots, source.metaWindow, x, y);
                place(source.metaWindow, at.prev, at.next);
                return true;
            },
        };
    }

    /**
     * A click on a window's icon goes to the window. A click on the icon of
     * the window that has the focus minimizes it, as a dock does, and a
     * click on a minimized window brings it back.
     */
    _onCellClicked(win, cell) {
        // The shell animates a window that is minimized or brought back to
        // and from this rectangle. Without one it uses the top left corner
        // of the monitor.
        const [x, y] = cell.get_transformed_position();
        const [width, height] = cell.get_transformed_size();
        this._iconGeometry.add(win);
        win.set_icon_geometry(new Mtk.Rectangle({
            x: Math.round(x), y: Math.round(y),
            width: Math.round(width), height: Math.round(height),
        }));
        if (win === global.display.focus_window && !win.minimized && win.can_minimize())
            win.minimize();
        else
            Main.activateWindow(win);
    }

    /** A square cell with the icon of the window's app. It can be dragged. */
    _buildCell(win, focused, active) {
        let s = 16;
        if (this._collapsed)
            s = 22;
        else if (active)
            s = 24;
        const app = this._tracker.get_window_app(win);
        const icon = app
            ? app.create_icon_texture(s)
            : new St.Icon({icon_name: 'application-x-executable', icon_size: s});
        const cell = new St.Button({
            style_class: 'kelp-win',
            child: icon,
            can_focus: true,
        });
        // A window that is recorded or shared has a dot in the corner of
        // its icon, in the colour of the outline on the window itself.
        const cast = this._sidebar.privacy?.castOf(win);
        if (cast) {
            const box = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
            });
            cell.child = null;
            icon.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            box.add_child(icon);
            box.add_child(new St.Widget({
                style_class: `kelp-win-cast kelp-win-cast-${cast}`,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
            }));
            cell.child = box;
            cell.accessible_name = cast === 'record' ? 'Recorded window' : 'Shared window';
        }
        // For _morphRow(): the icon, and the size its picture has.
        cell._icon = icon;
        cell._iconPx = s;
        if (focused)
            cell.add_style_pseudo_class('checked');
        if (win.urgent || win.demands_attention)
            cell.add_style_class_name('urgent');
        if (win.minimized)
            icon.opacity = MINIMIZED_OPACITY;
        cell.connect('clicked', () => this._onCellClicked(win, cell));
        cell.connect('notify::hover', () => {
            if (cell.hover)
                this._queuePreview(win, cell);
            else
                this._hidePreview();
        });
        cell.track_hover = true;

        // The dragged icon is DRAG_ICON px for every row, whatever the size
        // of the icons in the row.
        cell._delegate = {
            metaWindow: win,
            getDragActor: () => app
                ? app.create_icon_texture(DRAG_ICON)
                : new St.Icon({icon_name: 'application-x-executable', icon_size: DRAG_ICON}),
            getDragActorSource: () => cell,
        };
        const draggable = DND.makeDraggable(cell, {dragActorOpacity: 230});
        draggable.connect('drag-begin', () => {
            this._dragging = true;
            this._hidePreview();
        });
        draggable.connect('drag-end', () => {
            this._dragging = false;
            // The shell ends a drag after the sidebar has gone, too.
            if (this._destroyed)
                return;
            this._setDropRow(null);
            this._showInsert(null);
            if (this._pending) {
                this._pending = false;
                this.queueRebuild();
            }
        });
        return cell;
    }

    /**
     * The window whose icon is at a stage point, with the icon: {win,
     * cell}, or null.
     */
    windowAt(x, y) {
        const find = actor => {
            for (const child of actor.get_children()) {
                if (!child.mapped)
                    continue;
                const win = child._delegate?.metaWindow;
                if (!win) {
                    const found = find(child);
                    if (found)
                        return found;
                    continue;
                }
                const [cx, cy] = child.get_transformed_position();
                const [cw, ch] = child.get_transformed_size();
                if (x >= cx && x < cx + cw && y >= cy && y < cy + ch)
                    return {win, cell: child};
            }
            return null;
        };
        return find(this.actor) ?? find(this.monitors);
    }

    /** The workspace or monitor row under a stage point, and that point in the row. */
    _rowAt(x, y) {
        const rows = [
            ...this._rows.get_children(),
            ...[...this._monitorCards.values()].map(card => card.row),
        ];
        for (const row of rows) {
            const [rx, ry] = row.get_transformed_position();
            const [rw, rh] = row.get_transformed_size();
            if (x >= rx && x < rx + rw && y >= ry && y < ry + rh)
                return [row, x - rx, y - ry];
        }
        return [null, 0, 0];
    }

    /**
     * A window is being dragged over the sidebar with the pointer at x, y:
     * mark the row and the place it would land, as for a dragged icon.
     */
    windowDragOver(win, x, y) {
        this._dragging = true;
        this._hidePreview();
        const [row, rowX, rowY] = this._rowAt(x, y);
        this._setDropRow(row);
        this._showInsert(row ? this._dropPlace(row, row._slots, win, rowX, rowY) : null);
    }

    /** The window was dropped at x, y. Returns whether a row took it. */
    windowDrop(win, x, y) {
        const [row, rowX, rowY] = this._rowAt(x, y);
        if (row) {
            const at = this._dropPlace(row, row._slots, win, rowX, rowY);
            row._place(win, at.prev, at.next);
        }
        this.windowDragLeave();
        return !!row;
    }

    windowDragLeave() {
        if (!this._dragging)
            return;
        this._dragging = false;
        this._setDropRow(null);
        this._showInsert(null);
        if (this._pending) {
            this._pending = false;
            this.queueRebuild();
        }
    }

    _setDropRow(row) {
        if (this._dropRow === row)
            return;
        this._dropRow?.remove_style_pseudo_class('drop');
        this._dropRow = row;
        row?.add_style_pseudo_class('drop');
        if (!row)
            this._showInsert(null);
    }

    /**
     * Where a dragged icon lands in a row. x, y is the pointer in the row's
     * coordinates. Returns the windows whose icons end up before and
     * after it (prev, next, either can be null), and the stage rectangle of
     * the insertion mark, or mark: null when the drop changes nothing.
     */
    _dropPlace(row, slots, dragged, x, y) {
        const [rowX, rowY] = row.get_transformed_position();
        const px = rowX + x;
        const py = rowY + y;
        const sideBySide = row._sideBySide;
        const boxes = slots.map(({cell}) => {
            const [cx, cy] = cell.get_transformed_position();
            const [cw, ch] = cell.get_transformed_size();
            return {x: cx, y: cy, width: cw, height: ch};
        });
        // The windows before the pointer: those whose middle is above it.
        // Side by side, those on a line above it, and those on its line
        // whose middle is left of it.
        let at = 0;
        for (const b of boxes) {
            const before = sideBySide
                ? b.y + b.height <= py || (b.y <= py && b.x + b.width / 2 < px)
                : b.y + b.height / 2 < py;
            if (before)
                at++;
        }
        const others = (from, step) => {
            for (let i = from; i >= 0 && i < slots.length; i += step) {
                if (slots[i].win !== dragged)
                    return slots[i].win;
            }
            return null;
        };
        const place = {prev: others(at - 1, -1), next: others(at, 1), mark: null};
        const own = slots.findIndex(slot => slot.win === dragged);
        if (boxes.length === 0 || (own >= 0 && (at === own || at === own + 1)))
            return place;

        // The mark sits in the gap before the window at the position, or
        // after the last one.
        const gap = 2 * scaleFactor();      // .kelp-ws-cells spacing
        const thick = 2 * scaleFactor();
        const behind = at >= boxes.length;
        const b = behind ? boxes[at - 1] : boxes[at];
        if (sideBySide) {
            const mx = behind ? b.x + b.width + (gap - thick) / 2 : b.x - (gap + thick) / 2;
            place.mark = {x: mx, y: b.y, width: thick, height: b.height};
        } else {
            const my = behind ? b.y + b.height + (gap - thick) / 2 : b.y - (gap + thick) / 2;
            place.mark = {x: b.x, y: my, width: b.width, height: thick};
        }
        return place;
    }

    _showInsert(place) {
        const mark = place?.mark ?? null;
        if (!mark) {
            this._insert?.hide();
            return;
        }
        if (!this._insert) {
            this._insert = new InsertMark({style_class: 'kelp-ws-insert', reactive: false});
            Main.uiGroup.add_child(this._insert);
        }
        this._insert.set_position(Math.round(mark.x), Math.round(mark.y));
        this._insert.set_size(Math.round(mark.width), Math.round(mark.height));
        // Above the dragged icon, which is under the pointer and would
        // cover the mark.
        Main.uiGroup.set_child_above_sibling(this._insert, null);
        this._insert.show();
    }

    _queuePreview(win, cell) {
        this._cancelPreviewTimer();
        if (this._dragging || this._destroyed)
            return;
        const delay = this._preview.actor.visible
            ? 40 : this._sidebar.config.values.sidebar.previewDelay;
        this._previewId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._previewId = 0;
            if (cell.mapped && cell.hover)
                this._preview.show(win, cell);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPreviewTimer() {
        if (this._previewId)
            GLib.source_remove(this._previewId);
        this._previewId = 0;
    }

    _hidePreview() {
        this._cancelPreviewTimer();
        // An icon under the pointer reports the end of its hover when the
        // sidebar is taken off the stage, after destroy().
        if (!this._destroyed)
            this._preview.hide();
    }

    destroy() {
        this._destroyed = true;
        this._cancelPreviewTimer();
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._insert?.destroy();
        this._insert = null;
        this._dropRow = null;
        // The windows minimize to the shell's own place again.
        const live = new Set(global.display.list_all_windows());
        for (const win of this._iconGeometry) {
            if (live.has(win))
                win.set_icon_geometry(null);
        }
        this._iconGeometry.clear();
        Main.layoutManager.disconnectObject(this);
        this._preview.destroy();
    }
}

// ---------------------------------------------------------------- media

// The bar of the track's position opens and closes in this time.
const BAR_MS = 200;
// With no position to show, the bar closes after this time without one.
const BAR_CLOSE_MS = 900;

class MediaCard {
    constructor(sidebar) {
        this._sidebar = sidebar;
        this._player = null;

        this._cover = new St.Bin({style_class: 'kelp-media-cover'});
        this._title = label('', 'kelp-media-title');
        this._artist = label('', 'kelp-media-artist');
        this._text = new St.BoxLayout({
            orientation: VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._text.add_child(this._title);
        this._text.add_child(this._artist);
        const head = new St.BoxLayout({style_class: 'kelp-media-head', x_expand: true});
        head.add_child(this._cover);
        head.add_child(this._text);
        // The cover, title and artist are one button that goes to the
        // player's window.
        this._head = new St.Button({
            style_class: 'kelp-media-jump',
            child: head,
            can_focus: true,
            x_expand: true,
        });
        this._head.connect('clicked', () => this._jump());

        this._prev = iconButton('media-skip-backward-symbolic', 'kelp-media-button',
            () => this._player?.previous());
        this._play = iconButton('media-playback-start-symbolic', 'kelp-media-button',
            () => this._player?.playPause());
        this._next = iconButton('media-skip-forward-symbolic', 'kelp-media-button',
            () => this._player?.next());
        this._controls = new St.BoxLayout({style_class: 'kelp-media-controls', x_expand: true});
        this._controls.add_child(this._prev);
        this._controls.add_child(this._play);
        this._controls.add_child(this._next);

        // How far the track has played. MPRIS sends no signal as the
        // position advances, so it is read once a second while a track plays.
        //
        // With no position to show the bar has no height, and the card is
        // 12 px lower: the bar opens and closes over BAR_MS, and the card
        // follows it. A browser reports no length between two videos, and
        // a bar that closed at once would change the height of the card
        // each time. So the bar waits BAR_CLOSE_MS before it closes, and
        // does not close when a position is back by then.
        this._progress = new FillBar('kelp-media-progress-fill', {
            style_class: 'kelp-media-progress',
            x_expand: true,
        });
        this._bar = new Reveal(this._progress);
        this._bar.share = 0;
        this._barOpen = false;
        this._barCloseId = 0;

        // The card is in a slot that closes when no player is left. What
        // is in the card keeps its height then, and is cut off at the
        // card's border: the padding is on the inner box.
        const inner = new St.BoxLayout({
            style_class: 'kelp-media',
            orientation: VERTICAL,
            x_expand: true,
        });
        inner.add_child(this._head);
        inner.add_child(this._bar);
        inner.add_child(this._controls);
        const surface = new St.Bin({
            style_class: 'kelp-card kelp-card-cut',
            child: new FullHeight(inner, true),
        });
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true, visible: false}, true);
        this.slot = new CardSlot(this.actor, true);

        this._source = new Mpris.MprisSource();
        this._since = new Map();   // player that plays -> when it started, monotonic us
        // Every player is watched, because a player that starts playing
        // while the shown one is paused sends 'changed' only on itself.
        this._source.connectObject(
            'player-added', (_s, p) => {
                p.connectObject('changed', () => this._onChanged(), this);
                this._pick();
            },
            'player-removed', (_s, p) => {
                p.disconnectObject(this);
                this._pick();
            },
            this);
        for (const p of this._source.players)
            p.connectObject('changed', () => this._onChanged(), this);
        this._pick();
    }

    /** Collapsed: the cover, with the three buttons in a column under it. */
    setCollapsed(collapsed) {
        this._collapsed = collapsed;
        this._text.visible = !collapsed;
        this._controls.orientation = collapsed ? VERTICAL : Clutter.Orientation.HORIZONTAL;
        const align = collapsed ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
        this._head.x_align = align;
        this._controls.x_align = align;
    }

    /** Focus the player's window, on whichever workspace it is. */
    _jump() {
        const p = this._player;
        if (!p)
            return;
        const win = this._windowOf(p);
        if (win)
            Main.activateWindow(win);
        else
            p.raise();
    }

    /**
     * The most recently used window of the player's app. A player whose
     * desktop entry names no installed app has none, so the window is then
     * looked up by the last part of the player's bus name
     * (org.mpris.MediaPlayer2.spotify gives "spotify") in the window classes.
     */
    _windowOf(p) {
        return this._windowsOf(p)[0] ?? null;
    }

    /** The windows of the player's app, most recently used first. */
    _windowsOf(p) {
        const own = p.app?.get_windows() ?? [];
        if (own.length)
            return own;
        const name = (p._busName ?? '')
            .replace(/^org\.mpris\.MediaPlayer2\./, '').split('.')[0].toLowerCase();
        if (!name)
            return [];
        return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null).filter(
            w => (w.get_wm_class() ?? '').toLowerCase().includes(name));
    }

    /**
     * The card shows what is playing. With several players playing it shows
     * the one that started first, and stays with it until it stops. With
     * none playing it stays with the player it showed, so that one can be
     * started again from here.
     *
     * A player whose window has the focus is not left out, though its
     * window shows the track already. The card would change player with
     * the focus, and show a paused player while the focused one plays.
     */
    _pick() {
        const all = this._source.players;
        for (const p of [...this._since.keys()]) {
            if (!all.includes(p))
                this._since.delete(p);
        }
        for (const p of all) {
            if (p.status !== 'Playing')
                this._since.delete(p);
            else if (!this._since.has(p))
                this._since.set(p, GLib.get_monotonic_time());
        }
        const playing = [...this._since.keys()]
            .sort((a, b) => this._since.get(a) - this._since.get(b));
        const kept = all.includes(this._player) ? this._player : null;
        this._player = playing[0] ?? kept ?? all[0] ?? null;
        this._update();
    }

    /** A player's status or track changed. _pick() also draws the card again. */
    _onChanged() {
        this._pick();
    }

    /** Track length in microseconds, 0 when the player does not give one. */
    _trackLength(p) {
        try {
            return Number(p._playerProxy?.Metadata?.['mpris:length']?.deepUnpack() ?? 0) || 0;
        } catch {
            return 0;
        }
    }

    /** Read the position now, and keep reading it while the player plays. */
    _syncProgress() {
        const playing = this._player?.status === 'Playing';
        if (playing && !this._tickId) {
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._readPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!playing && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._readPosition();
    }

    _readPosition() {
        const p = this._player;
        const length = p ? this._trackLength(p) : 0;
        if (!p?._busName || length <= 0) {
            this._wantBar(false);
            return;
        }
        Gio.DBus.session.call(
            p._busName, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1000, null,
            (connection, result) => {
                let position;
                try {
                    const [value] = connection.call_finish(result).deepUnpack();
                    position = Number(value.deepUnpack());
                } catch {
                    position = NaN;
                }
                // The card was destroyed, or the player or track changed,
                // while the call was out.
                if (!this._source || this._player !== p || this._trackLength(p) !== length)
                    return;
                this._wantBar(Number.isFinite(position));
                if (Number.isFinite(position))
                    this._progress.fraction = Math.max(0, Math.min(1, position / length));
            });
    }

    /** Whether there is a position to show. */
    _wantBar(open) {
        if (open || !this.actor.mapped) {
            if (this._barCloseId)
                GLib.source_remove(this._barCloseId);
            this._barCloseId = 0;
            this._setBar(open);
        } else if (this._barOpen && !this._barCloseId) {
            this._barCloseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BAR_CLOSE_MS, () => {
                this._barCloseId = 0;
                this._setBar(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _setBar(open) {
        if (open === this._barOpen)
            return;
        this._barOpen = open;
        this._bar.remove_transition('share');
        // A card that is not on the screen has the bar in its place when
        // it is shown.
        if (!this.actor.mapped) {
            this._bar.share = open ? 1 : 0;
            return;
        }
        this._bar.ease_property('share', open ? 1 : 0, {
            duration: BAR_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _update() {
        const p = this._player;
        // A card that closes keeps the track it showed.
        this.slot.setShown(!!p);
        this._syncProgress();
        if (!p)
            return;
        this._title.text = p.trackTitle || p.app?.get_name() || 'Media';
        this._artist.text = p.trackArtists?.join(', ') ?? '';
        this._artist.visible = this._artist.text !== '';
        this._play.child.icon_name = p.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = p.canGoPrevious;
        this._next.reactive = p.canGoNext;

        const url = p.trackCoverUrl;
        if (url !== this._coverUrl) {
            this._coverUrl = url;
            this._coverLoad?.cancel();
            this._coverLoad = null;
            if (url?.startsWith('file://'))
                this._showCover(url);
            else if (url)
                this._fetchCover(url);
            else
                this._showCoverIcon();
        }
    }

    /** The cover fills the box. `uri` is a local file. */
    _showCover(uri) {
        this._cover.child = null;
        this._cover.style = `background-image: url("${uri}"); background-size: cover;`;
    }

    /** No cover: the icon of the player's app on the grey box. */
    _showCoverIcon() {
        const gicon = this._player?.app?.get_icon() ??
            new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        this._cover.style = null;
        this._cover.child = new St.Icon({gicon, style_class: 'kelp-media-cover-icon'});
    }

    /**
     * A cover at a web address, as Spotify sends. It is saved to the cache
     * directory and shown from there. The stylesheet reads a background
     * image while the shell waits: with a web address the shell would stop
     * for the time of the download (2167 ms measured with a server that
     * answers after 2 s). The cover of the last track stays until the new
     * one is there.
     */
    _fetchCover(url) {
        const cancellable = new Gio.Cancellable();
        this._coverLoad = cancellable;
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kelpshell']);
        // The file is named after the address: St keeps a loaded image
        // under its file name, so one name for every cover would show the
        // first cover for every track.
        const sum = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `cover-${sum}`]));
        Gio.File.new_for_uri(url).load_contents_async(cancellable, (source, result) => {
            try {
                const [, bytes] = source.load_contents_finish(result);
                if (cancellable.is_cancelled())
                    return;
                GLib.mkdir_with_parents(dir, 0o755);
                file.replace_contents(bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch {
                if (!cancellable.is_cancelled())
                    this._showCoverIcon();
                return;
            }
            // One cover is kept on disk.
            if (this._coverFile && !this._coverFile.equal(file))
                this._deleteCoverFile();
            this._coverFile = file;
            this._showCover(file.get_uri());
        });
    }

    _deleteCoverFile() {
        try {
            this._coverFile?.delete(null);
        } catch {
            // Already gone.
        }
        this._coverFile = null;
    }

    destroy() {
        this._coverLoad?.cancel();
        this._coverLoad = null;
        this._deleteCoverFile();
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        if (this._barCloseId)
            GLib.source_remove(this._barCloseId);
        this._barCloseId = 0;
        for (const p of this._source._players.values())
            p.disconnectObject(this);
        this._source.disconnectObject(this);
        this._source = null;
    }
}

// ---------------------------------------------------------------- notifications

class NotificationsCard {
    constructor(sidebar) {
        this._sidebar = sidebar;

        this._count = new St.Label({style_class: 'kelp-badge', y_align: Clutter.ActorAlign.CENTER});
        this._heading = label('Notifications', 'kelp-heading', {
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        this._bell = new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic',
            style_class: 'kelp-icon',
        });
        const headBox = new St.BoxLayout({style_class: 'kelp-notif-head', x_expand: true});
        headBox.add_child(this._bell);
        headBox.add_child(this._heading);
        headBox.add_child(this._count);
        this._headBox = headBox;
        this._head = new St.Button({
            style_class: 'kelp-row-button',
            child: headBox,
            x_expand: true,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE,
        });
        this._head.connect('clicked', (_b, button) => {
            if (button === 2)
                this._clear();
            else
                sidebar.tweaks.toggleDateMenu(this.actor);
        });

        this._list = new St.BoxLayout({orientation: VERTICAL, style_class: 'kelp-notif-list', x_expand: true});
        // The list is built again when a notification comes or goes, and
        // the card moves to its new height over CARD_MS.
        this._listHold = new FullHeight(this._list, true);
        // As in the media card: the slot closes with the last notification.
        const inner = new St.BoxLayout({
            style_class: 'kelp-notifications',
            orientation: VERTICAL,
            x_expand: true,
        });
        inner.add_child(this._head);
        inner.add_child(this._listHold);
        const surface = new St.Bin({
            style_class: 'kelp-card kelp-card-cut',
            child: new FullHeight(inner, true),
        });
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true, visible: false}, true);
        this.slot = new CardSlot(this.actor, true);

        Main.messageTray.connectObject(
            'source-added', (_t, source) => {
                this._watch(source);
                this._sync();
            },
            'source-removed', (_t, source) => {
                source.disconnectObject(this);
                this._sync();
            },
            this);
        for (const source of Main.messageTray.getSources())
            this._watch(source);
        this._sync();
    }

    _watch(source) {
        source.connectObject(
            'notification-added', () => this._sync(),
            'notification-removed', () => this._sync(),
            this);
    }

    setCollapsed(collapsed) {
        this._collapsed = collapsed;
        this._heading.visible = !collapsed;
        this._listHold.visible = !collapsed;
        // The collapsed card is too narrow for the bell and the count side
        // by side, so the count goes under the bell, both centred.
        this._headBox.orientation = collapsed ? VERTICAL : HORIZONTAL;
        const align = collapsed ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
        this._bell.x_align = align;
        this._count.x_align = align;
        this._sync();
    }

    _all() {
        const all = Main.messageTray.getSources().flatMap(s => s.notifications ?? []);
        all.sort((a, b) => (b.datetime?.to_unix() ?? 0) - (a.datetime?.to_unix() ?? 0));
        return all;
    }

    _clear() {
        for (const n of this._all()) {
            if (!n.resident)
                n.destroy();
        }
    }

    _sync() {
        const all = this._all();
        this.slot.setShown(all.length > 0);
        // A card that closes keeps the rows it showed.
        if (all.length === 0 && this.actor.mapped)
            return;
        this._count.text = `${all.length}`;
        this._listHold.easeOver(() => this._fill(all));
    }

    _fill(all) {
        this._list.destroy_all_children();
        if (this._collapsed)
            return;
        const max = Math.max(0, this._sidebar.config.values.sidebar.notifications);
        for (const n of all.slice(0, max)) {
            const title = label(n.title ?? n.source?.title ?? '', 'kelp-notif-title');
            const box = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
            box.add_child(title);
            const body = (n.body ?? '').replace(/\s+/g, ' ').trim();
            if (body)
                box.add_child(label(body, 'kelp-notif-body'));
            const row = new St.Button({
                style_class: 'kelp-row-button kelp-notif',
                child: box,
                x_expand: true,
                can_focus: true,
                button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
            });
            row.connect('clicked', (_b, button) => {
                if (button === 1)
                    n.activate();
                else
                    n.destroy();
            });
            this._list.add_child(row);
        }
    }

    destroy() {
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
    }
}

// ---------------------------------------------------------------- system

const SYSTEM_POLL_S = 2;

/** One labelled meter: name, bar, value. */
class Meter {
    constructor(name, styleClass) {
        this.name = label(name, 'kelp-meter-label', {y_align: Clutter.ActorAlign.CENTER});
        this.track = new FillBar(`kelp-meter-fill ${styleClass}`, {
            style_class: 'kelp-meter',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.value = new St.Label({
            style_class: 'kelp-meter-value', y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor = new St.BoxLayout({style_class: 'kelp-meter-row', x_expand: true});
        this.actor.add_child(this.name);
        this.actor.add_child(this.track);
        this.actor.add_child(this.value);
    }

    /** text defaults to the fraction as a percentage. */
    set(fraction, text = null) {
        const f = Math.max(0, Math.min(1, fraction));
        this.value.text = text ?? `${Math.round(f * 100)}%`;
        this.track.fraction = f;
    }

    setCollapsed(collapsed) {
        this.name.visible = !collapsed;
        this.value.visible = !collapsed;
    }
}

/** Short form of a byte rate: 0K, 850K, 1.2M, 34M, 1.1G. */
function formatRate(bytesPerSecond) {
    const k = bytesPerSecond / 1024;
    if (k < 1000)
        return `${Math.round(k)}K`;
    const m = k / 1024;
    if (m < 1000)
        return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
    return `${(m / 1024).toFixed(1)}G`;
}

/**
 * Processor, memory, disk space, disk activity and network use, read every
 * SYSTEM_POLL_S seconds. DISK is the share of the home filesystem in use.
 * I/O is bytes read plus written per second on the physical disks, NET is
 * bytes received plus sent per second on the physical interfaces. Both are on
 * a logarithmic bar from 1 KB/s (empty) to 1 GB/s (full).
 */
class SystemCard {
    constructor(sidebar) {
        this._sidebar = sidebar;
        this._cancellable = new Gio.Cancellable();   // the disk space question, see _tickDisk
        this._cpu = new Meter('CPU', 'cpu');
        this._mem = new Meter('RAM', 'mem');
        this._disk = new Meter('DISK', 'disk');
        this._io = new Meter('I/O', 'io');
        this._net = new Meter('NET', 'net');
        this._meters = [this._cpu, this._mem, this._disk, this._io, this._net];

        const box = new St.BoxLayout({
            orientation: VERTICAL, style_class: 'kelp-meters', x_expand: true,
        });
        for (const meter of this._meters)
            box.add_child(meter.actor);
        // The padding of the card is on the box of the meters, so the
        // meters are cut off at the border of the card while it closes.
        const surface = new St.Button({
            style_class: 'kelp-card kelp-system',
            child: new FullHeight(box),
            can_focus: true,
        });
        surface.connect('clicked', () => this._openMonitor());
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true}, true);

        this._lastCpu = null;
        this._lastNet = null;
        this._lastIo = null;
        this._physical = new Map();   // interface name -> has a device behind it
        this._disks = new Map();      // block device name -> is a whole physical disk
        this._ticks = 0;
        this._timerId = 0;
    }

    /**
     * The meters are read while the card is in use (sidebar.system) and
     * not at all while it is not. A rate is the difference of two
     * readings, so the readings from before a pause are dropped.
     */
    setPolling(polling) {
        if (polling === !!this._timerId)
            return;
        if (!polling) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
            return;
        }
        this._lastCpu = this._lastNet = this._lastIo = null;
        this._ticks = 0;
        this._io.set(0, formatRate(0));
        this._net.set(0, formatRate(0));
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SYSTEM_POLL_S, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _read(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes) : '';
        } catch {
            return '';
        }
    }

    _tick() {
        this._tickCpu();
        this._tickMemory();
        this._tickIo();
        this._tickNetwork();
        // The disk fills slowly: every 30 s.
        if (this._ticks++ % 15 === 0)
            this._tickDisk();
    }

    _tickCpu() {
        // /proc/stat, first line: cpu user nice system idle iowait irq softirq steal
        const fields = this._read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
        if (fields.length < 5 || !fields.every(Number.isFinite))
            return;
        const total = fields.reduce((a, b) => a + b, 0);
        const idle = fields[3] + fields[4];
        if (this._lastCpu && total > this._lastCpu.total)
            this._cpu.set(1 - (idle - this._lastCpu.idle) / (total - this._lastCpu.total));
        this._lastCpu = {total, idle};
    }

    _tickMemory() {
        const meminfo = this._read('/proc/meminfo');
        const kb = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1]);
        const total = kb('MemTotal');
        const available = kb('MemAvailable');
        if (total > 0 && Number.isFinite(available))
            this._mem.set(1 - available / total);
    }

    /** Asked off the main loop: a home on a network mount can take long to answer. */
    _tickDisk() {
        Gio.File.new_for_path(GLib.get_home_dir()).query_filesystem_info_async(
            'filesystem::size,filesystem::free', GLib.PRIORITY_LOW, this._cancellable,
            (file, result) => {
                try {
                    const info = file.query_filesystem_info_finish(result);
                    const size = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    if (size > 0 && !this._cancellable.is_cancelled())
                        this._disk.set(1 - free / size);
                } catch {
                    // Cancelled, or the filesystem gave no answer: the
                    // meter keeps its last value.
                }
            });
    }

    /** Fraction of a logarithmic bar from 1 KB/s to 1 GB/s. */
    _rateFraction(bytesPerSecond) {
        return Math.log10(Math.max(bytesPerSecond, 1) / 1e3) / 6;
    }

    _tickIo() {
        // /proc/diskstats: major minor name reads merged sectors_read ms
        // writes merged sectors_written ... A sector here is 512 bytes.
        let bytes = 0;
        for (const line of this._read('/proc/diskstats').split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length < 10)
                continue;
            const name = f[2];
            // Whole disks with hardware behind them: partitions are not in
            // /sys/block, and loop, zram and device-mapper have no device.
            if (!this._disks.has(name)) {
                this._disks.set(name, GLib.file_test(
                    `/sys/block/${name}/device`, GLib.FileTest.EXISTS));
            }
            if (this._disks.get(name))
                bytes += (Number(f[5]) + Number(f[9])) * 512;
        }
        const time = GLib.get_monotonic_time() / 1e6;
        if (this._lastIo && time > this._lastIo.time && bytes >= this._lastIo.bytes) {
            const rate = (bytes - this._lastIo.bytes) / (time - this._lastIo.time);
            this._io.set(this._rateFraction(rate), formatRate(rate));
        }
        this._lastIo = {time, bytes};
    }

    _tickNetwork() {
        // /proc/net/dev: "name: rx_bytes 7 more fields tx_bytes ...", two header lines.
        let bytes = 0;
        for (const line of this._read('/proc/net/dev').split('\n').slice(2)) {
            const [name, rest] = line.split(':');
            if (!rest)
                continue;
            const iface = name.trim();
            // Only interfaces with hardware behind them. Traffic through a
            // tunnel or bridge is counted once, on the card that carries it.
            if (!this._physical.has(iface)) {
                this._physical.set(iface, GLib.file_test(
                    `/sys/class/net/${iface}/device`, GLib.FileTest.EXISTS));
            }
            if (!this._physical.get(iface))
                continue;
            const fields = rest.trim().split(/\s+/).map(Number);
            bytes += (fields[0] || 0) + (fields[8] || 0);
        }
        const time = GLib.get_monotonic_time() / 1e6;
        if (this._lastNet && time > this._lastNet.time && bytes >= this._lastNet.bytes) {
            const rate = (bytes - this._lastNet.bytes) / (time - this._lastNet.time);
            this._net.set(this._rateFraction(rate), formatRate(rate));
        }
        this._lastNet = {time, bytes};
    }

    _openMonitor() {
        const system = Shell.AppSystem.get_default();
        for (const id of ['org.gnome.SystemMonitor.desktop', 'net.nokyan.Resources.desktop',
            'io.missioncenter.MissionCenter.desktop', 'org.gnome.Usage.desktop']) {
            const app = system.lookup_app(id);
            if (app) {
                app.activate();
                return;
            }
        }
    }

    setCollapsed(collapsed) {
        for (const meter of this._meters)
            meter.setCollapsed(collapsed);
    }

    destroy() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        this._cancellable.cancel();
    }
}

// ---------------------------------------------------------------- controls

// ---------------------------------------------------------------- privacy

const CHIP_MS = 200;
// The icon of the microphone chip changes over this long, as the colours
// of a chip do (stylesheet).
const CHIP_HOVER_MS = 120;

// A chip of the privacy card: icons and labels in a row, with a click or
// without. A chip that stops what it stands for ends in a stop button, a
// square on a dark ground. Its row is as wide as the chip, so the button is
// at the far edge of every such chip and what is stopped at the near one.
function chip(styleClass, children, onClick, stops = false) {
    const box = new St.BoxLayout({
        style_class: 'kelp-chip-box',
        x_expand: stops,
        x_align: stops ? Clutter.ActorAlign.FILL : Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    for (const child of children)
        box.add_child(child);
    if (stops) {
        box.add_child(new St.Bin({
            style_class: 'kelp-chip-stop',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Widget({style_class: 'kelp-chip-stop-mark'}),
        }));
    }
    const button = new St.Button({
        style_class: `kelp-chip ${styleClass}${stops ? ' kelp-chip-stops' : ''}`,
        child: box,
        reactive: !!onClick,
        can_focus: !!onClick,
        track_hover: !!onClick,
        clip_to_allocation: true,
        visible: false,
    });
    if (onClick) {
        button.connect('clicked', onClick);
        // The pointing hand over a chip that a click acts on, the arrow
        // over one that only shows something.
        button.set_cursor_type(Clutter.CursorType.POINTER);
    }
    return button;
}

// The chips of the privacy card, in lines that are filled from edge to edge.
// A chip is as wide as what is in it and the chips of a line share the room
// that is left, so one chip is as wide as the card and two are half of it
// each. In a column (the collapsed sidebar) each chip is a line.
//
// When the chips that are shown change, every chip goes from the place it
// is drawn at to its new one over CHIP_MS, and the box from its height to
// the new one. A chip that comes grows from the edge of the chip before it
// and fades in, or from the lower edge of the box when it starts a line. A
// chip that goes does the reverse.
const ChipBox = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', 'progress', 'progress',
            GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class KelpChipBox extends St.Widget {
    _init(spacing) {
        super._init({style_class: 'kelp-privacy', x_expand: true, clip_to_allocation: true});
        this._spacing = spacing;
        this._column = false;
        this._shown = new Set();
        this._from = null;   // while the chips move: {boxes, opacity, height}
        this._progress = 1;
    }

    get progress() {
        return this._progress ?? 1;
    }

    set progress(value) {
        if (value === this._progress)
            return;
        this._progress = value;
        for (const child of this.get_children()) {
            const from = this._from?.opacity.get(child) ?? 0;
            const to = this._shown.has(child) ? 255 : 0;
            child.opacity = Math.round(from + (to - from) * value);
        }
        this.notify('progress');
        this.queue_relayout();
    }

    set column(column) {
        this._column = column;
        this._settle();
    }

    /** chips: the children that are shown from now on. */
    setShown(chips, animate) {
        const next = new Set(chips);
        if (next.size === this._shown.size && chips.every(c => this._shown.has(c)))
            return;
        // What is drawn now, also in the middle of an earlier change.
        const drawn = this.get_children().filter(c => c.visible && c.has_allocation());
        const from = {
            boxes: new Map(drawn.map(c => {
                const b = c.get_allocation_box();
                return [c, [b.x1, b.y1, b.x2, b.y2]];
            })),
            opacity: new Map(drawn.map(c => [c, c.opacity])),
            height: this.has_allocation() ? this.get_allocation_box().get_height() : 0,
        };
        this._restarting = true;
        this.remove_transition('progress');
        this._restarting = false;
        animate &&= this.mapped && this.has_allocation() && St.Settings.get().enable_animations;
        this._shown = next;
        if (!animate) {
            this._settle();
            return;
        }
        this._from = from;
        for (const child of chips) {
            if (!child.visible) {
                child.opacity = 0;
                child.show();
            }
        }
        this._progress = 0;
        this.ease_property('progress', 1, {
            duration: CHIP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                if (!this._restarting)
                    this._settle();
            },
        });
    }

    /** The chips are where they stay. */
    _settle() {
        this._from = null;
        this._progress = 1;
        for (const child of this.get_children()) {
            child.visible = this._shown.has(child);
            child.opacity = 255;
        }
        this.queue_relayout();
    }

    /**
     * The places of the shown chips in a box of this width, from its top
     * left corner: [Map chip -> [x1, y1, x2, y2], height].
     */
    _place(width) {
        const lines = [];
        let line = null, used = 0;
        for (const child of this.get_children()) {
            if (!this._shown.has(child))
                continue;
            const [, w] = child.get_preferred_width(-1);
            const [, h] = child.get_preferred_height(-1);
            if (line && !this._column && used + this._spacing + w <= width) {
                used += this._spacing;
            } else {
                line = [];
                lines.push(line);
                used = 0;
            }
            used += w;
            line.push({child, w, h});
        }
        const boxes = new Map();
        let y = 0;
        lines.forEach((chips, i) => {
            y += i > 0 ? this._spacing : 0;
            const height = Math.max(...chips.map(c => c.h));
            const taken = chips.reduce((sum, c) => sum + c.w, 0) + (chips.length - 1) * this._spacing;
            const more = Math.max(0, width - taken) / chips.length;
            let x = 0;
            for (const c of chips) {
                boxes.set(c.child, [x, y, x + c.w + more, y + height]);
                x += c.w + more + this._spacing;
            }
            y += height;
        });
        return [boxes, y];
    }

    /**
     * Where a chip that comes starts, or one that goes ends: with no width
     * at the right edge of the chip before it on its line, or with no
     * height on the lower edge of the other arrangement when that has no
     * line there.
     *
     * box: the chip's own place. others: the places of the other
     * arrangement. bottom: its lower edge.
     */
    _closed(child, box, others, bottom) {
        if (box[1] >= bottom)
            return [box[0], bottom, box[2], bottom];
        let x = 0;
        for (let before = child.get_previous_sibling(); before; before = before.get_previous_sibling()) {
            const other = others.get(before);
            if (other && other[1] < box[3] && other[3] > box[1]) {
                x = other[2];
                break;
            }
        }
        x = Math.max(box[0], Math.min(x, box[2]));
        return [x, box[1], x, box[3]];
    }

    vfunc_get_preferred_width(_forHeight) {
        let min = 0, nat = 0;
        for (const child of this.get_children()) {
            if (!this._shown.has(child))
                continue;
            const [, width] = child.get_preferred_width(-1);
            min = Math.max(min, width);
            nat = this._column ? min : nat + width + (nat > 0 ? this._spacing : 0);
        }
        return this.get_theme_node().adjust_preferred_width(min, nat);
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const [, height] = this._place(forWidth < 0 ? Infinity : node.adjust_for_width(forWidth));
        const [, full] = node.adjust_preferred_height(height, height);
        const from = this._from;
        // Not rounded: the card over it is placed from this height.
        const now = from ? from.height + (full - from.height) * this.progress : full;
        return [now, now];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const node = this.get_theme_node();
        const content = node.get_content_box(box);
        // Relative to this actor.
        const [left, top] = [content.x1 - box.x1, content.y1 - box.y1];
        const [placed, height] = this._place(content.x2 - content.x1);
        const target = new Map([...placed].map(([c, b]) =>
            [c, [b[0] + left, b[1] + top, b[2] + left, b[3] + top]]));
        const from = this._from;
        const p = this.progress;
        for (const child of this.get_children()) {
            if (!child.visible)
                continue;
            let to = target.get(child) ?? null;
            let start = from?.boxes.get(child) ?? null;
            if (from && !to && start)
                to = this._closed(child, start, target, top + height);
            else if (from && to && !start)
                start = this._closed(child, to, from.boxes, from.height - top);
            if (!to)
                continue;
            const at = start ? to.map((v, i) => start[i] + (v - start[i]) * p) : to;
            child.allocate(new Clutter.ActorBox({
                x1: Math.round(at[0]), y1: Math.round(at[1]),
                x2: Math.round(at[2]), y2: Math.round(at[3]),
            }));
        }
    }
});

// What is recorded, shared or listened to now (lib/privacy.js), one chip
// each: the screen recording with its time, a screen that is shared, the
// microphone, a camera. A click stops the recording, stops the sharing, or
// mutes the microphone. The card is there only while one of them is.
class PrivacyCard {
    constructor(sidebar) {
        this._privacy = sidebar.privacy;
        const icon = name => new St.Icon({
            icon_name: name, style_class: 'kelp-icon', y_align: Clutter.ActorAlign.CENTER,
        });

        this._time = new St.Label({
            style_class: 'kelp-chip-time', y_align: Clutter.ActorAlign.CENTER,
        });
        // The whole time or none of it while a chip opens.
        this._time.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._record = chip('kelp-chip-record', [this._time],
            () => this._privacy.stopRecording(), true);
        this._record.accessible_name = 'Stop recording';
        this._cast = chip('kelp-chip-cast', [icon('screen-shared-symbolic')],
            () => this._privacy.stopSharing(), true);
        this._cast.accessible_name = 'Stop sharing the screen';
        // The microphone chip shows what the microphone is, and under the
        // pointer what a click makes of it: the crossed microphone over one
        // that listens, the plain one over a muted one. After a click it
        // shows the new state until the pointer has left.
        this._micOn = icon('audio-input-microphone-symbolic');
        this._micOff = icon('microphone-disabled-symbolic');
        this._micOff.opacity = 0;
        const mic = new St.Widget({
            layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER,
        });
        mic.add_child(this._micOn);
        mic.add_child(this._micOff);
        this._mic = chip('kelp-chip-mic', [mic], () => {
            this._micClicked = this._mic.hover;
            this._privacy.toggleMicrophone();
        });
        this._mic.connect('notify::hover', () => {
            if (!this._mic.hover)
                this._micClicked = false;
            this._syncMic(true);
        });
        this._camera = chip('kelp-chip-camera', [icon('camera-web-symbolic')], null);
        this._camera.accessible_name = 'Camera in use';

        this._chips = new ChipBox(4 * scaleFactor());
        for (const child of [this._record, this._cast, this._mic, this._camera])
            this._chips.add_child(child);
        // As in the system card: the padding is on the box of the chips,
        // which is cut off at the border of the card while it closes.
        const surface = new St.Bin({
            style_class: 'kelp-card kelp-card-cut',
            child: new FullHeight(this._chips),
        });
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true, visible: false}, true);
        this.slot = new CardSlot(this.actor);
        this._shown = false;

        this._privacy.onChanged(() => this._sync());
        this._sync();
    }

    _sync() {
        if (!this._chips)
            return;
        const p = this._privacy;
        const any = p.recording || p.sharing > 0 || !!p.microphone || p.camera;
        if (!any) {
            // The chips stay as they are while the card closes.
            this._shown = false;
            this.slot.setShown(false);
            return;
        }
        // A card that is hidden, or on its way there, gets its chips in
        // one frame: it is the card that opens.
        const animate = this._shown && this.actor.mapped;
        const seconds = p.recordingSeconds;
        const pad = n => String(n).padStart(2, '0');
        const [h, m] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60];
        if (p.recording)
            this._time.text = `${h > 0 ? `${h}:${pad(m)}` : m}:${pad(seconds % 60)}`;
        if (p.microphone)
            this._syncMic(animate);
        if (p.microphone === 'muted')
            this._mic.add_style_class_name('muted');
        else if (p.microphone)
            this._mic.remove_style_class_name('muted');
        const shown = [];
        if (p.recording)
            shown.push(this._record);
        if (p.sharing > 0)
            shown.push(this._cast);
        if (p.microphone)
            shown.push(this._mic);
        if (p.camera)
            shown.push(this._camera);
        this._chips.setShown(shown, animate);
        this._shown = true;
        this.slot.setShown(true);
    }

    _syncMic(animate) {
        const muted = this._privacy.microphone === 'muted';
        const crossed = muted !== (this._mic.hover && !this._micClicked);
        const ease = (actor, shown) => actor.ease({
            opacity: shown ? 255 : 0,
            duration: animate ? CHIP_HOVER_MS : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        ease(this._micOn, !crossed);
        ease(this._micOff, crossed);
        this._mic.accessible_name = muted ? 'Unmute the microphone' : 'Mute the microphone';
    }

    setCollapsed(collapsed) {
        // The collapsed card has room for one thing in a chip: the stop
        // button of the recording, the icon of the sharing.
        this._time.visible = !collapsed;
        this._cast.child.last_child.visible = !collapsed;
        for (const stops of [this._record, this._cast]) {
            stops.child.x_align = collapsed
                ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL;
        }
        this._chips.column = collapsed;
    }

    destroy() {
        this._chips = null;
    }
}

// On mains power and not charging, the battery counts as full from this
// charge, percent.
const BATTERY_FULL_PERCENT = 95;

// The status row is filled up to this many places. An icon is one place, the
// battery icon with its time is two.
const STATUS_PLACES = 4;

// Icons that can fill the status row, by their name in sidebar.statusFill.
// Each follows a toggle of quick settings. The shell has an icon of its own
// for each, shown only in one state: the power mode while it is not
// "balanced", Bluetooth while a device is connected, night light while the
// screen is tinted. These show the state the rest of the time.
const STATUS_FILLS = {
    powerMode: {
        indicator: '_powerProfiles',
        iconName: toggle => toggle.iconName,
        dim: () => false,
    },
    bluetooth: {
        indicator: '_bluetooth',
        iconName: toggle => toggle.checked
            ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
        dim: toggle => !toggle.checked,
    },
    nightLight: {
        indicator: '_nightLight',
        iconName: toggle => toggle.iconName,
        dim: toggle => !toggle.checked,
    },
};

class ControlsCard {
    constructor(sidebar) {
        this._sidebar = sidebar;

        // The top bar's status icons (network, sound, battery, microphone in
        // use, ...) are moved here while the extension is enabled.
        this._qs = Main.panel.statusArea.quickSettings ?? null;
        this._indicators = this._qs?._indicators ?? null;
        this._statusBox = new St.BoxLayout({
            style_class: 'kelp-status-box',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._status = new St.Button({
            style_class: 'kelp-row-button kelp-status',
            child: this._statusBox,
            x_expand: true,
            can_focus: true,
        });
        if (this._indicators) {
            this._indicatorsParent = this._indicators.get_parent();
            this._indicatorsParent?.remove_child(this._indicators);
            this._indicators.x_align = Clutter.ActorAlign.CENTER;
            this._statusBox.add_child(this._indicators);
        } else {
            this._statusBox.add_child(new St.Icon({
                icon_name: 'emblem-system-symbolic', style_class: 'kelp-icon',
            }));
        }
        this._status.connect('clicked', () => sidebar.tweaks.toggleQuickSettings(this.actor));

        // The icons that fill the row, see _syncStatus().
        this._fills = new Map();
        for (const [name, kind] of Object.entries(STATUS_FILLS)) {
            const icon = new St.Icon({style_class: 'system-status-icon', visible: false});
            this._statusBox.add_child(icon);
            this._fills.set(name, {...kind, icon, toggle: null, own: null});
        }

        // The battery: its icon, then the time until it is empty, or full
        // while it charges. The two are one group and the last thing in the
        // row, so no other icon comes between them. The icon is the shell's
        // own, moved out of the status icons. Until the shell has made it,
        // an icon made here stands in.
        this._batteryBox = new St.BoxLayout({
            style_class: 'kelp-battery',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._batteryFallback = new St.Icon({style_class: 'system-status-icon'});
        this._batteryTime = new St.Label({
            style_class: 'kelp-battery-time',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._batteryBox.add_child(this._batteryFallback);
        this._batteryBox.add_child(this._batteryTime);
        this._statusBox.add_child(this._batteryBox);
        this._batteryBox.connect('notify::visible', () => this._syncStatus());
        this._batteryTime.connect('notify::visible', () => this._syncStatus());
        this._batteryIcon = null;
        // The shell makes its icons after its own startup, so they are
        // looked for again whenever one is added.
        this._watched = new Set();
        this._indicators?.connectObject('child-added', () => {
            this._bindBatteryIcon();
            this._watchIndicators();
        }, this);
        this._bindBatteryIcon();

        this._cancellable = new Gio.Cancellable();
        const watch = (path, iface, set) => Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', path, iface, this._cancellable, (_source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch {
                    return;
                }
                set(proxy);
                proxy.connectObject(
                    'g-properties-changed', () => this._syncBattery(), this._batteryTime);
                this._syncBattery();
            });
        watch('/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device',
            proxy => (this._battery = proxy));
        // OnBattery: whether the machine runs on the battery.
        watch('/org/freedesktop/UPower', 'org.freedesktop.UPower',
            proxy => (this._upower = proxy));

        // The volume row has a speaker icon of its own, which mutes on a
        // click. The shell's speaker icon among the status icons is shown
        // only while that row is hidden.
        this._volume = new VolumeRow(sidebar);
        this._volume.actor.connect('notify::visible', () => this._syncStatus());
        // After the battery group and the volume row exist: the count of
        // the places looks at both.
        this._fillTries = 0;
        this._bindFills();
        this._watchIndicators();

        this._search = iconButton('system-search-symbolic', '', () => sidebar.launcher?.toggle());
        this._collapse = iconButton('sidebar-show-symbolic', '', () => sidebar.toggleCollapsed());
        this._buttons = new St.BoxLayout({style_class: 'kelp-control-buttons', x_expand: true});
        // The collapse button is at the bottom left of the card: first in
        // the row here, last in the column of the collapsed sidebar, see
        // setCollapsed().
        this._buttons.add_child(this._collapse);
        this._buttons.add_child(this._search);

        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-controls',
            orientation: VERTICAL,
        });
        surface.add_child(this._status);
        surface.add_child(this._volume.actor);
        surface.add_child(this._buttons);
        this.actor = sidebar.backdrop.wrap(surface, '', {x_expand: true}, true);
    }

    /**
     * Connect each fill icon to its toggle in quick settings. The shell
     * makes the toggles after its own startup, so this is tried again for a
     * while.
     */
    _bindFills() {
        this._fillId = 0;
        for (const fill of this._fills.values()) {
            if (fill.toggle)
                continue;
            const indicator = this._qs?.[fill.indicator] ?? null;
            const toggle = indicator?.quickSettingsItems?.[0] ?? null;
            if (!toggle)
                continue;
            fill.toggle = toggle;
            fill.own = indicator._indicator ?? null;
            toggle.connectObject(
                'notify::checked', () => this._syncStatus(),
                'notify::visible', () => this._syncStatus(),
                'notify::icon-name', () => this._syncStatus(), fill.icon);
        }
        this._syncStatus();
        if ([...this._fills.values()].some(f => !f.toggle) && ++this._fillTries <= 10) {
            this._fillId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                this._bindFills();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /**
     * Follow every status icon of the shell: each one that is shown or
     * hidden changes how many places of the row are taken.
     */
    _watchIndicators() {
        for (const box of this._indicators?.get_children() ?? []) {
            if (this._watched.has(box))
                continue;
            this._watched.add(box);
            box.connectObject('notify::visible', () => this._syncStatus(), this);
            // One box can hold several icons: the network one has a second
            // for a VPN.
            for (const icon of box.get_children())
                icon.connectObject('notify::visible', () => this._syncStatus(), this);
        }
        this._syncStatus();
    }

    /** The names in sidebar.statusFill that are known, in their order. */
    _fillOrder() {
        const list = this._sidebar.config.values.sidebar.statusFill;
        return Array.isArray(list) ? list.filter(name => this._fills.has(name)) : [];
    }

    /**
     * Which icons the row shows.
     *
     * The shell's own icons are always shown: each says that something is
     * the case now (the network, a connected Bluetooth device, a microphone
     * or camera in use, a power mode other than "balanced"). So is the
     * battery. Four of the shell's icons are not: the speaker while the
     * volume row is shown, night light unless sidebar.statusFill names it,
     * and the microphone and the camera, which the privacy card shows.
     *
     * While those take less than STATUS_PLACES places, the icons of
     * sidebar.statusFill are added in their order until the places are
     * taken. On battery the time takes a place, so fewer are added than on
     * mains power with a full battery, and the row keeps about its width.
     */
    _syncStatus() {
        if (this._syncing || !this._fills)
            return;
        this._syncing = true;
        const order = this._fillOrder();
        // The shell shows each of its icon boxes whenever one of the icons
        // in it is shown, so the result is set again each time the shell
        // changes it.
        const shown = {
            _volumeOutput: !this._volume?.actor.visible,
            _nightLight: order.includes('nightLight'),
            _volumeInput: false,
            _camera: false,
        };
        for (const [name, wanted] of Object.entries(shown)) {
            const box = this._qs?.[name] ?? null;
            if (!box)
                continue;
            const visible = wanted && box.get_children().some(c => c.visible);
            if (box.visible !== visible)
                box.visible = visible;
        }

        let places = 0;
        for (const box of this._indicators?.get_children() ?? []) {
            if (box.visible)
                places += Math.max(1, box.get_children().filter(c => c.visible).length);
        }
        if (this._batteryBox.visible)
            places += this._batteryTime.visible ? 2 : 1;

        for (const [name, fill] of this._fills) {
            const {toggle, own, icon} = fill;
            const able = !!toggle && order.includes(name) && toggle.visible && !own?.visible;
            if (able) {
                icon.icon_name = fill.iconName(toggle);
                icon.opacity = fill.dim(toggle) ? 110 : 255;
            }
            fill.able = able;
            icon.visible = false;
        }
        // In the order of the list, which is also their order in the row.
        let index = this._statusBox.get_children().indexOf(this._batteryBox) - this._fills.size;
        for (const name of order) {
            const fill = this._fills.get(name);
            this._statusBox.set_child_at_index(fill.icon, index++);
            if (fill.able && places < STATUS_PLACES) {
                fill.icon.visible = true;
                places++;
            }
        }
        this._syncing = false;
    }

    /** The config has changed. */
    sync() {
        this._syncStatus();
    }

    /**
     * Move the shell's battery icon in front of the time. The shell makes
     * it after its own startup, so this runs again whenever a status icon
     * is added.
     */
    _bindBatteryIcon() {
        const icon = this._qs?._system ?? null;
        if (!icon || this._batteryIcon || icon.get_parent() !== this._indicators)
            return;
        this._batteryIcon = icon;
        this._indicators.remove_child(icon);
        // In the middle of the group, for the collapsed sidebar, where the
        // time is under the icon and wider than it.
        icon.x_align = Clutter.ActorAlign.CENTER;
        this._batteryBox.insert_child_at_index(icon, 0);
        this._batteryFallback.hide();
    }

    _syncBattery() {
        if (!this._battery)
            return;
        const get = name => this._battery.get_cached_property(name)?.deepUnpack() ?? 0;
        // UPower device states: 1 charging, 2 discharging, 4 fully charged.
        const state = get('State');
        const percent = get('Percentage');
        const onBattery =
            this._upower?.get_cached_property('OnBattery')?.deepUnpack() ?? state === 2;
        // Plugged in and full: the icon alone, there is no time to wait
        // for. Some machines report a full battery on mains power as
        // discharging, at a rate near zero, so the state alone does not
        // tell.
        const full = !onBattery &&
            (state === 4 || (state !== 1 && percent >= BATTERY_FULL_PERCENT));
        this._batteryBox.visible = !!get('IsPresent');

        const level = Math.round(percent / 10) * 10;
        this._batteryFallback.icon_name =
            `battery-level-${level}${state === 1 ? '-charging' : ''}-symbolic`;

        // On mains power and not charging there is no time to show. The
        // time to empty UPower gives then is months long.
        let seconds = 0;
        if (full)
            seconds = 0;
        else if (state === 1)
            seconds = Number(get('TimeToFull'));
        else if (state === 2 && onBattery)
            seconds = Number(get('TimeToEmpty'));
        this._batteryTime.visible = seconds > 0;
        if (seconds <= 0)
            return;
        const minutes = Math.round(seconds / 60);
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        this._batteryTime.text = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    setCollapsed(collapsed) {
        const orientation = collapsed ? VERTICAL : HORIZONTAL;
        this._buttons.orientation = orientation;
        this._buttons.set_child_at_index(this._collapse, collapsed ? 1 : 0);
        this._statusBox.orientation = orientation;
        this._batteryBox.orientation = orientation;
        if (this._indicators)
            this._indicators.orientation = orientation;
        this._volume.setCollapsed(collapsed);
    }

    destroy() {
        if (this._fillId)
            GLib.source_remove(this._fillId);
        this._fillId = 0;
        this._cancellable.cancel();
        this._indicators?.disconnectObject(this);
        for (const box of this._watched) {
            box.disconnectObject(this);
            for (const icon of box.get_children())
                icon.disconnectObject(this);
        }
        this._watched.clear();
        this._fills = null;
        // The ones the row hid are shown again as the shell shows them.
        for (const name of ['_volumeOutput', '_nightLight', '_volumeInput', '_camera']) {
            const box = this._qs?.[name] ?? null;
            if (box)
                box.visible = box.get_children().some(c => c.visible);
        }
        this._volume.destroy();
        // Give the status icons back before the card is destroyed.
        if (this._batteryIcon) {
            this._batteryBox.remove_child(this._batteryIcon);
            this._batteryIcon.x_align = Clutter.ActorAlign.FILL;
            this._indicators.add_child(this._batteryIcon);
            this._batteryIcon = null;
        }
        if (this._indicators) {
            this._statusBox.remove_child(this._indicators);
            this._indicators.orientation = HORIZONTAL;
            this._indicators.x_align = Clutter.ActorAlign.FILL;
            this._indicatorsParent?.add_child(this._indicators);
        }
    }
}

/**
 * The icon of an output device that is not the machine's own speakers:
 * headphones, a headset, a display, or speakers on Bluetooth, the network
 * or USB. null for the machine's own speakers and for a device of no known
 * kind, where the icon shows the volume instead.
 *
 * libgvc names a device's icon after the kind of its port: audio-headphones,
 * audio-headset, video-display, audio-speakers (with -bluetooth for a
 * Bluetooth one), audio-card for the rest. The laptop's speakers are
 * audio-speakers too. Their stream is the one of a sound card
 * (audio-card-analog), which tells them from speakers that are a device of
 * their own.
 */
function outputKindIcon(device, stream) {
    const name = device?.icon_name ?? '';
    const factor = stream?.form_factor ?? '';
    const port = stream && stream.get_ports().length > 0
        ? stream.get_port()?.port.toLowerCase() ?? '' : '';
    if (name.startsWith('audio-headset') || factor === 'headset')
        return 'audio-headset-symbolic';
    if (name.startsWith('audio-headphones') || factor === 'headphone' || port.includes('headphone'))
        return 'audio-headphones-symbolic';
    if (name.startsWith('video-display') || port.includes('hdmi'))
        return 'video-display-symbolic';
    if (name.startsWith('tv') || factor === 'tv')
        return 'tv-symbolic';
    const own = stream?.icon_name ?? '';
    if (name.startsWith('audio-speakers') && (!own.startsWith('audio-card') || own.includes('usb')))
        return 'audio-speakers-symbolic';
    return null;
}

/** The icon of a device in the output menu: its kind, also for the machine's own speakers. */
function outputGicon(device) {
    const parts = (device.icon_name || 'audio-card').split('-');
    const names = [];
    for (let n = parts.length; n >= 2; n--)
        names.push(`${parts.slice(0, n).join('-')}-symbolic`);
    names.push('audio-card-symbolic');
    return Gio.ThemedIcon.new_from_names(names);
}

/**
 * The name of a device in the output menu, and what tells it from another
 * of the same name. libgvc gives the port ("Speakers") and where it is
 * ("Ryzen HD Audio Controller"). For a Bluetooth device the port says
 * little ("Speaker") and the second is the device's name, so that comes
 * first.
 */
function outputNames(device, stream) {
    const {description, origin} = device;
    if (origin && (device.icon_name ?? '').includes('bluetooth'))
        return [origin, 'Bluetooth'];
    if (!origin && (stream?.name ?? '').startsWith('raop_sink'))
        return [description, 'AirPlay'];
    return [description, origin ?? ''];
}

/**
 * The output devices, shown next to the sidebar on a secondary click on the
 * speaker icon. A click on one makes it the output.
 */
class OutputMenu {
    constructor(sidebar, control) {
        this._sidebar = sidebar;
        this._control = control;
        this._rows = [];
        this._selected = -1;
        this._anchor = null;
        this.isOpen = false;
        // The ids of the devices. libgvc has no list of them, only a signal
        // for each one that comes and goes. Those that were there before
        // this was made are read in open(), see _known().
        this._ids = new Set();

        this._overlay = new St.Widget({reactive: true, can_focus: true, visible: false});
        // As in lib/downloads.js: a press outside closes the menu, the
        // focus goes to what was pressed, and the event is not stopped.
        this._overlay.connect('button-press-event', (_a, event) => {
            if (!this._box.contains(global.stage.get_event_actor(event))) {
                const [x, y] = event.get_coords();
                this.close();
                this._sidebar.tiling.focusAt(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));

        this._list = new St.BoxLayout({style_class: 'kelp-output-list', orientation: VERTICAL});
        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-output-menu',
            orientation: VERTICAL,
            reactive: true,
        });
        surface.add_child(this._list);
        this._box = sidebar.backdrop.wrap(surface, 'kelp-shadow-float', {}, true);
        this._overlay.add_child(this._box);
        // The height is only right once the list has been laid out, and a
        // device that comes or goes changes it.
        this._box.connect('notify::height', () => this._place());
        Main.layoutManager.addTopChrome(this._overlay);

        this._control.connectObject(
            'output-added', (_c, id) => {
                this._ids.add(id);
                this._rebuild();
            },
            'output-removed', (_c, id) => {
                this._ids.delete(id);
                this._rebuild();
            },
            'active-output-update', () => this._rebuild(),
            this);
    }

    destroy() {
        this.close(false);
        this._control.disconnectObject(this);
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = this._box = this._list = null;
    }

    /** anchor: the actor the menu is level with. */
    toggle(anchor) {
        if (this.isOpen)
            this.close();
        else
            this.open(anchor);
    }

    open(anchor) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (this.isOpen || !monitor)
            return;
        const grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        if (!grab)
            return;
        this._grab = grab;
        this.isOpen = true;
        this._anchor = anchor;
        this._known();
        this._rebuild();

        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._overlay.reactive = true;
        // Shown before it is placed: hidden, the list reports a wrong
        // height until it has been shown once.
        this._overlay.show();
        this._place();
        this._overlay.grab_key_focus();

        this._box.remove_all_transitions();
        this._box.opacity = 0;
        this._box.translation_x = -8 * scaleFactor();
        // Once the first frame is drawn, see settle.js.
        easeSettled(this._box, {
            opacity: 255,
            translation_x: 0,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    close(animate = true) {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        Main.popModal(this._grab);
        this._grab = null;
        // The pointer is over what is under the menu again at once, and
        // not only when the menu has faded.
        this._overlay.reactive = false;
        this._box.remove_all_transitions();
        if (!animate) {
            this._overlay.hide();
            return;
        }
        this._box.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._overlay.hide(),
        });
    }

    /**
     * Add the devices that were there before this was made: those in the
     * shell's own menu, which has followed the signals since the shell
     * started, and the device of every stream. The shell's menu alone is
     * not enough: it has been seen empty while five streams were there.
     */
    _known() {
        const shell = Main.panel.statusArea.quickSettings?._volumeOutput?._output?._deviceItems;
        for (const id of shell?.keys() ?? [])
            this._ids.add(id);
        if (this._control.get_state() !== Gvc.MixerControlState.READY)
            return;
        for (const sink of this._control.get_sinks()) {
            const device = this._control.lookup_device_from_stream(sink);
            if (device)
                this._ids.add(device.get_id());
        }
    }

    /** Next to the cards, level with the speaker icon where the monitor has room. */
    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        const anchor = this._anchor;
        if (!this.isOpen || !anchor || !monitor)
            return;
        const s = scaleFactor();
        // As far from the monitor's edge as the cards, so the menu ends
        // level with the card it was opened from.
        const margin = this._sidebar.config.values.sidebar.margin * s;
        const [, , , height] = this._box.get_preferred_size();
        const [, anchorY] = anchor.get_transformed_position();
        const [, anchorHeight] = anchor.get_transformed_size();
        const x = this._sidebar.rightEdge + 8 * s - monitor.x;
        const y = Math.max(margin, Math.min(
            anchorY - monitor.y + anchorHeight / 2 - height / 2,
            monitor.height - height - margin));
        this._box.set_position(Math.round(x), Math.round(y));
    }

    _rebuild() {
        if (!this.isOpen)
            return;
        this._list.destroy_all_children();
        this._rows = [];
        this._selected = -1;
        const control = this._control;
        const sink = control.get_state() === Gvc.MixerControlState.READY
            ? control.get_default_sink() : null;
        const active = sink ? control.lookup_device_from_stream(sink)?.get_id() ?? -1 : -1;
        const ids = [...this._ids].sort((a, b) => a - b);
        for (const id of ids) {
            const device = control.lookup_output_id(id);
            if (!device)
                continue;
            const [name, origin] = outputNames(device, control.get_stream_from_device(device));
            // x_expand on the box itself: with it only on a label inside,
            // the box of a row does not take the width of the button, and
            // the row is drawn in its middle.
            const row = new St.BoxLayout({style_class: 'kelp-output-row-box', x_expand: true});
            row.add_child(new St.Icon({gicon: outputGicon(device), style_class: 'kelp-icon'}));
            // One of the two labels takes the room that is left, so the
            // mark of every row is at the right end.
            const title = new St.Label({
                text: name, style_class: 'kelp-output-name',
                y_align: Clutter.ActorAlign.CENTER, x_expand: !origin,
            });
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(title);
            if (origin) {
                const where = new St.Label({
                    text: origin, style_class: 'kelp-output-origin',
                    y_align: Clutter.ActorAlign.CENTER, x_expand: true,
                });
                where.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                row.add_child(where);
            }
            // A row without the mark keeps its room.
            row.add_child(new St.Icon({
                icon_name: 'object-select-symbolic',
                style_class: 'kelp-output-check',
                opacity: id === active ? 255 : 0,
            }));
            const actor = new St.Button({style_class: 'kelp-output-row', child: row, x_expand: true});
            const index = this._rows.length;
            const run = () => {
                this.close();
                const now = control.lookup_output_id(id);
                if (now)
                    control.change_output(now);
            };
            actor.connect('clicked', run);
            actor.connect('motion-event', () => {
                if (this._selected !== index)
                    this._select(index);
                return Clutter.EVENT_PROPAGATE;
            });
            this._list.add_child(actor);
            this._rows.push({actor, run});
        }
        if (this._rows.length === 0)
            this._list.add_child(label('No output devices', 'kelp-output-empty'));
    }

    _select(index) {
        const n = this._rows.length;
        if (n === 0)
            return;
        this._selected = (index + n) % n;
        this._rows.forEach((row, i) => {
            if (i === this._selected)
                row.actor.add_style_pseudo_class('selected');
            else
                row.actor.remove_style_pseudo_class('selected');
        });
    }

    _onKey(event) {
        const at = this._selected;
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_Tab:
            this._select(at + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_ISO_Left_Tab:
            this._select(at < 0 ? -1 : at - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._rows[at]?.run();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}

/**
 * Output volume: the speaker icon and a slider. A click on the icon mutes, a
 * secondary click shows the output devices. The icon shows the kind of the
 * device where that is not the machine's own speakers, and the volume where
 * it is. Muted, it is the muted speaker for every device. Hidden while there
 * is no output device. Collapsed, the icon alone is shown.
 */
class VolumeRow {
    constructor(sidebar) {
        this._control = Volume.getMixerControl();
        this._stream = null;
        this._collapsed = false;

        this._icon = new St.Icon({style_class: 'kelp-icon'});
        this._mute = new St.Button({
            style_class: 'kelp-icon-button kelp-volume-mute',
            child: this._icon,
            can_focus: true,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.SECONDARY,
        });
        this._menu = new OutputMenu(sidebar, this._control);
        this._mute.connect('clicked', (_b, button) => {
            if (button !== 1)
                this._menu.toggle(this._mute);
            else if (this._stream)
                this._stream.change_is_muted(!this._stream.is_muted);
        });
        this._slider = new Slider(0);
        this._slider.add_style_class_name('kelp-volume-slider');
        this._slider.x_expand = true;
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._slider.connect('notify::value', () => this._onSlider());

        this.actor = new St.BoxLayout({
            style_class: 'kelp-volume',
            x_expand: true,
            visible: false,
        });
        this.actor.add_child(this._mute);
        this.actor.add_child(this._slider);

        this._control.connectObject(
            'state-changed', () => this._pick(),
            'default-sink-changed', () => this._pick(),
            'active-output-update', () => this._sync(),
            this);
        this._pick();
    }

    _pick() {
        const stream = this._control.get_state() === Gvc.MixerControlState.READY
            ? this._control.get_default_sink() : null;
        if (stream !== this._stream) {
            this._stream?.disconnectObject(this);
            this._stream = stream;
            stream?.connectObject(
                'notify::volume', () => this._sync(),
                'notify::is-muted', () => this._sync(),
                // Headphones plugged into the machine are another port of
                // the same stream.
                'notify::port', () => this._sync(),
                this);
        }
        this._sync();
    }

    _sync() {
        const stream = this._stream;
        this.actor.visible = !!stream;
        this._slider.visible = !this._collapsed;
        this._mute.x_expand = this._collapsed;
        if (!stream)
            return;
        const max = this._control.get_vol_max_norm();
        const level = stream.is_muted ? 0 : Math.min(1, stream.volume / max);
        // The slider is set here from the stream, so that is not written
        // back to the stream.
        this._setting = true;
        this._slider.value = level;
        this._setting = false;
        const names = ['muted', 'low', 'medium', 'high'];
        const kind = level > 0
            ? outputKindIcon(this._control.lookup_device_from_stream(stream), stream) : null;
        this._icon.icon_name = kind ??
            `audio-volume-${names[level <= 0 ? 0 : Math.ceil(level * 3)]}-symbolic`;
    }

    _onSlider() {
        const stream = this._stream;
        if (this._setting || !stream)
            return;
        const volume = Math.round(this._slider.value * this._control.get_vol_max_norm());
        if (stream.volume === volume && !stream.is_muted)
            return;
        stream.volume = volume;
        stream.push_volume();
        if (stream.is_muted && volume > 0)
            stream.change_is_muted(false);
    }

    setCollapsed(collapsed) {
        this._collapsed = collapsed;
        this._sync();
    }

    destroy() {
        this._menu.destroy();
        this._stream?.disconnectObject(this);
        this._control.disconnectObject(this);
        this._stream = null;
    }
}

// ---------------------------------------------------------------- sidebar

export class Sidebar {
    constructor({config, backdrop, tiling, tweaks, cheatsheet, privacy}) {
        this.config = config;
        this.privacy = privacy;
        this.backdrop = backdrop;
        this.tiling = tiling;
        this.tweaks = tweaks;
        this.cheatsheet = cheatsheet;
        this.launcher = null;
    }

    /**
     * state: what the sidebar was like before a lock of the screen, see
     * the state getter. The key and the button collapse it without
     * writing the configuration, so without the state the sidebar would
     * come back from every lock as the configuration has it, and the
     * windows would change their width for it.
     */
    enable(state = null) {
        this.collapsed = state?.collapsed ?? this.config.values.sidebar.collapsed;

        // An empty actor that reserves the screen edge. It is resized in one
        // step, when the cards start to change their width, so the windows
        // are asked for a new size once per toggle and not on every frame
        // of the card animation. They are drawn at their new places as far
        // as the cards have gone, see Tiling.glideBegin.
        this._strut = new St.Widget({reactive: false});
        this._strutWidth = 0;    // the width it has with no fullscreen window
        this._lifted = false;    // it has no width now, see _placeStrut
        Main.layoutManager.addChrome(this._strut, {affectsStruts: true, trackFullscreen: true});

        // Not reactive: a click between or beside the cards goes to the
        // window under it. The cards take the clicks on them, see below.
        this.actor = new SidebarBox({
            name: 'kelpSidebar',
            style_class: 'kelp-sidebar',
            orientation: VERTICAL,
            reactive: false,
        });
        // The shell would hide the cards in one frame when a window goes
        // fullscreen. They slide out and in here, see _syncFullscreen.
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: false});
        this._covered = false;
        this._peek = false;      // shown over a fullscreen window, see peekUpdate
        this._held = false;      // the compositor is kept from unredirecting
        // px of the cards' width shown over a fullscreen window. It follows
        // the fingers, and goes to its target on the spring of the windows.
        this._peekPos = new Spring();
        // The width of the cards while they collapse or expand:
        // {from, to, elapsed, most, step, done}, see reposition().
        //
        // The animation plays COLLAPSE_MS of frames, however long each
        // frame took. Its time starts once the cards have been laid out
        // and drawn in their other style (settle.js). No later frame moves
        // it on by more than COLLAPSE_STEP_FRAMES frames of the monitor.
        //
        // It is not a Clutter transition, which runs on the clock. The
        // first collapse after a login is slower than the later ones
        // (styles and icon sizes that were never used before): with eight
        // windows on two monitors its first frame takes 17 ms and the third
        // comes 31 ms after the second (measured). A transition is then
        // 56% of the way by the third frame, against 36% on a later
        // collapse, which is seen as a collapse that is too fast.
        this._widening = null;
        this._widthItem = {
            tick: dt => {
                const a = this._widening;
                if (!a || !this.actor)
                    return false;
                a.elapsed += Math.min(dt * 1000, a.most);
                const t = Math.min(1, a.elapsed / COLLAPSE_MS);
                // The curve of Clutter.AnimationMode.EASE_OUT_CUBIC.
                const share = 1 - (1 - t) ** 3;
                this.actor.width = a.from + (a.to - a.from) * share;
                // The windows go the same share of their way.
                a.step?.(share);
                if (t < 1)
                    return true;
                this._widening = null;
                a.done();
                return false;
            },
        };
        this._peekItem = {
            tick: (dt, omega, zeta) => {
                if (!this.actor || !this._covered || !this._peek)
                    return false;
                this._peekPos.step(dt, omega, zeta);
                this._peekDraw();
                if (!this._peekPos.atRest)
                    return true;
                this._peekRest();
                return false;
            },
        };
        global.display.connectObject(
            'in-fullscreen-changed', () => this._syncFullscreen(true), this);

        this._clock = new ClockCard(this);
        this._minimap = new Minimap(this);
        this._media = new MediaCard(this);
        this._notifications = new NotificationsCard(this);
        this._downloads = new DownloadsCard(this);
        this._system = new SystemCard(this);
        this._privacy = new PrivacyCard(this);
        this._controls = new ControlsCard(this);
        this._cards = [this._clock, this._minimap, this._media, this._notifications,
            this._downloads, this._system, this._privacy, this._controls];
        // The whole of a card stops a click, its padding too.
        for (const card of this._cards)
            card.actor.reactive = true;

        this.actor.add_child(this._clock.actor);
        // The minimap and the cards under it that come and go, each in a
        // slot with the spacing over it, in a box with no spacing of its
        // own: see CardSlot. The cards of the other monitors are shown and
        // hidden in one frame, their slot is only their spacing.
        const monitors = new CardSlot(this._minimap.monitors, true);
        monitors.share = 1;
        this._gapSlots = [monitors, this._media.slot, this._notifications.slot];
        const upper = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
        upper.add_child(this._minimap.actor);
        for (const slot of this._gapSlots)
            upper.add_child(slot);
        this.actor.add_child(upper);
        // The room that is left between the cards at the top and those at
        // the bottom.
        this._spacer = new St.Widget({y_expand: true});
        this._crowded = false;   // the system card is hidden to make room for the pile
        this._systemHeight = 0;
        this._systemShown = null;   // null until the first _syncSystem()
        this._roomId = 0;
        this._spacer.connect('notify::height', () => this.syncRoom());
        this.actor.add_child(this._spacer);
        this.actor.add_child(this._downloads.actor);
        // The system card and the privacy card, each with the spacing
        // under it, and the controls card, in a box with no spacing of its
        // own: see CardSlot.
        this._systemSlot = new CardSlot(this._system.actor);
        this._gapSlots.push(this._privacy.slot);
        const bottom = new St.BoxLayout({orientation: VERTICAL, x_expand: true});
        bottom.add_child(this._systemSlot);
        bottom.add_child(this._privacy.slot);
        bottom.add_child(this._controls.actor);
        this.actor.add_child(bottom);

        Main.layoutManager.connectObject('monitors-changed', () => this.reposition(false), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this.reposition(false), this);
        // A window dragged over the sidebar becomes a drag of its icon.
        let inside = false;
        this.tiling.dragSink = {
            over: (win, x, y) => {
                const was = inside;
                inside = this._contains(x, y);
                if (inside)
                    this._minimap.windowDragOver(win, x, y);
                else if (was)
                    this._minimap.windowDragLeave();
                return inside;
            },
            drop: (win, x, y) => {
                inside = false;
                return this._minimap.windowDrop(win, x, y);
            },
        };
        // A swipe or a focus key towards the left, past the first column of
        // a fullscreen window, shows the cards. They stay until a swipe or
        // a focus key the other way.
        this.tiling.peekSink = {
            available: monitor => this._covered === true &&
                monitor === Main.layoutManager.primaryMonitor?.index,
            // px the work area of a monitor leaves for the cards.
            // The strut has no width while a fullscreen window hides the
            // cards (_placeStrut): this is the width it has without one.
            room: monitor => this._strut &&
                monitor === Main.layoutManager.primaryMonitor?.index ? this._strutWidth : 0,
            amount: () => this._peek
                ? Math.max(0, Math.min(this._peekPos.value, this._margin() + this._cardWidth())) : 0,
            // px of the cards that can be shown: a pull stops there.
            width: () => this._margin() + this._cardWidth(),
            update: px => this.peekUpdate(px),
            end: velocity => this.peekEnd(velocity),
            hold: () => this.peekHold(),
            stay: velocity => this.peekStay(velocity),
            // Whether the cards are over the fullscreen window to stay.
            held: () => this._covered === true && this._peek && this._peekPos.target > 0,
        };
        this._applyCollapsed();
        // Cards that were shown over a fullscreen window are shown again:
        // reposition() keeps them when it finds the monitor covered.
        this._peek = !!state?.peek;
        this.reposition(false);
    }

    /**
     * The tiling has given the open windows their tiles, which it does
     * after this is enabled (extension.js). The minimap shows them in its
     * first frame.
     */
    windowsAdopted() {
        this._minimap.rebuildNow();
    }

    /** What enable() takes to bring the sidebar back after a lock. */
    get state() {
        return {
            collapsed: this.collapsed,
            // Shown over a fullscreen window, to stay.
            peek: this._covered === true && this._peek && this._peekPos.target > 0,
        };
    }

    disable() {
        this.tiling.dragSink = null;
        this.tiling.peekSink = null;
        this._peekStop();
        this._hold(false);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        for (const card of this._cards)
            card.destroy();
        Main.layoutManager.removeChrome(this.actor);
        this.tiling.animator?.remove(this._widthItem);
        if (this._widening)
            this.tiling.glideEnd?.();
        this._widening = null;
        this.tiling.fade?.limit(null);
        Main.layoutManager.removeChrome(this._strut);
        if (this._roomId)
            global.compositor.get_laters().remove(this._roomId);
        this._roomId = 0;
        this.actor.destroy();
        this._strut.destroy();
        this._cards = [];
        this.actor = this._strut = this._spacer = null;
    }

    /** The place and size of the strut now, for lib/lockhold.js. */
    get strutRect() {
        if (!this._strut)
            return null;
        const [x, y] = this._strut.get_position();
        const [width, height] = this._strut.get_size();
        return {x, y, width, height};
    }

    /**
     * What of the sidebar is at a stage point, for the window picker of
     * lib/shot.js: null where no card is, {win, cell} on the icon of a
     * window in the minimap, and {} on the rest of a card.
     */
    pick(x, y) {
        const on = actor => {
            if (!actor.mapped)
                return false;
            const [ax, ay] = actor.get_transformed_position();
            const [aw, ah] = actor.get_transformed_size();
            return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
        };
        // No cards: the sidebar is disabled.
        if (this._cards.length === 0)
            return null;
        const cards = [...this._cards.map(card => card.actor), ...this._minimap.monitors.get_children()];
        if (!cards.some(on))
            return null;
        return this._minimap.windowAt(x, y) ?? {};
    }

    /** The cards with the icons of the windows, which the picker leaves clear. */
    get windowCards() {
        if (this._cards.length === 0)
            return [];
        return [this._minimap.actor, ...this._minimap.monitors.get_children()];
    }

    /** Whether a stage point is over the sidebar's column of cards. */
    _contains(x, y) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || (this._covered && !this._peek) || !this.actor.visible)
            return false;
        return x >= monitor.x && x < this.rightEdge &&
            y >= monitor.y && y < monitor.y + monitor.height;
    }

    /** Stage x of the cards' right edge. */
    get rightEdge() {
        return this.actor.x + this._cardWidth() + this._margin();
    }

    _margin() {
        return this.config.values.sidebar.margin * scaleFactor();
    }

    /** px the cards still have to widen by in the collapse animation. */
    widthAhead() {
        if (!this.actor)
            return 0;
        return Math.max(0, this._margin() + this._cardWidth() - this.actor.width);
    }

    _cardWidth() {
        const c = this.config.values.sidebar;
        return (this.collapsed ? c.collapsedWidth : c.width) * scaleFactor();
    }

    /**
     * The room over the downloads pile has changed, or what the pile needs
     * of it. The system card is looked at before the next frame: this is
     * called while the cards are laid out.
     */
    syncRoom() {
        if (!this._spacer || this._roomId)
            return;
        this._roomId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._roomId = 0;
            this._syncSystem();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The system card is hidden while the downloads pile has no room to
     * spread: the pile then lies lower by the height of that card, and
     * spreads into the room that gives. Without this the spread pile lies
     * on the card above it, for example with a notification showing.
     *
     * The room is always the one there would be with the system card
     * shown, so the card does not come back into room that only its own
     * absence made.
     */
    _syncSystem() {
        if (!this.actor)
            return;
        const c = this.config.values.sidebar;
        const system = this._system.actor;
        const slot = this._systemSlot;
        this._system.setPolling(!!c.system);
        const gap = c.gap * scaleFactor();
        slot.gap = gap;
        const need = this._downloads.spreadRoom();
        if (system.visible && slot.share >= 1 && system.has_allocation())
            this._systemHeight = system.get_allocation_box().get_height();
        let crowded = false;
        if (c.system && need > 0 && this._spacer.has_allocation()) {
            // From the card over the pile to the pile: the spacer and the
            // spacing on both sides of it, less what the slot has closed
            // by, while it opens or closes.
            const room = this._spacer.get_allocation_box().get_height() + 2 * gap -
                (1 - slot.share) * (this._systemHeight + gap);
            // One spacing stays clear over the folder.
            crowded = room < need + gap;
        }
        this._crowded = crowded;
        const show = c.system && !crowded;
        if (show === this._systemShown)
            return;
        const first = this._systemShown === null;
        this._systemShown = show;
        slot.remove_transition('share');
        if (first || !this.actor.mapped || !St.Settings.get().enable_animations) {
            slot.share = show ? 1 : 0;
            system.visible = show;
            return;
        }
        if (show)
            system.show();
        slot.ease_property('share', show ? 1 : 0, {
            duration: CARD_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (!show)
                    system.hide();
            },
        });
    }

    reposition(animate) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.actor)
            return;
        const c = this.config.values.sidebar;
        this._syncSystem();
        this._downloads.sync();
        this._controls.sync();
        const width = this._margin() + this._cardWidth();
        this.actor.style =
            `padding: ${c.margin}px 0 ${c.margin}px ${c.margin}px; spacing: ${c.gap}px;`;
        this._minimap.monitors.style = `spacing: ${c.gap}px;`;
        for (const slot of this._gapSlots)
            slot.gap = c.gap * scaleFactor();
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.height = monitor.height;
        this.actor.remove_all_transitions();
        // The strut is the room the windows leave for the cards. It takes
        // its new width in one step, and the windows are asked for their
        // new size then. In an animation that is when the cards start to
        // move, and the windows are drawn going to their new places as the
        // cards go to their width, see Tiling.glideBegin.
        // The cards' shadows end EDGE px before the windows start, where
        // the room between the two leaves the shadows faint by then. The
        // cut goes with the cards, as the windows do.
        const scale = scaleFactor();
        const room = (this.config.values.layout.gap - EDGE) * scale;
        const edgeFor = w => room >= 6 * scale ? w + room : null;
        const fade = this.tiling.fade;
        const animator = this.tiling.animator;
        animator.remove(this._widthItem);
        // Stopped on the way, by a second press of the key: the windows
        // stay where they are drawn, as the cards do, until the next
        // animation takes both from there. On their springs they would go
        // on to the places they were given while the cards stand still
        // (47 px under the cards in the 80 ms before the cards turn back).
        const stopped = this._widening !== null;
        this._widening = null;
        if (animate && animator.enabled && this.actor.width !== width) {
            const rate = this.actor.peek_stage_views()[0]?.get_refresh_rate() || 60;
            this.actor.setEdge(edgeFor(this.actor.width));
            const a = this._widening = {
                from: this.actor.width, to: width, elapsed: 0,
                most: COLLAPSE_STEP_FRAMES * 1000 / rate,
                step: null,
                done: () => {
                    this.actor.setEdge(edgeFor(width));
                    this.tiling.glideEnd();
                    fade?.limit(null);
                },
            };
            afterSettle(this.actor, () => {
                if (this._widening !== a)
                    return;
                fade?.limit(Math.min(this._strutWidth, width));
                this.tiling.glideBegin(() => {
                    this._strutWidth = width;
                    this._placeStrut(true);
                });
                a.step = share => {
                    this.actor.setEdge(edgeFor(this.actor.width));
                    this.tiling.glideStep(share);
                };
                animator.add(this._widthItem);
            });
        } else {
            this.actor.width = width;
            this._strutWidth = width;
            this._placeStrut();
            this.actor.setEdge(edgeFor(width));
            fade?.limit(null);
            if (stopped)
                this.tiling.glideEnd();
        }
        // The transitions were removed above, and the width may have changed.
        this._covered = null;
        this._syncFullscreen(false);
    }

    /**
     * Give the strut its place: the room the windows leave for the cards.
     * It has no width while a window is fullscreen on the sidebar's
     * monitor. The cards are out of view then, and Mutter does not make a
     * window wider than the work area, so a window over the fullscreen one
     * could not be as wide as the monitor (maximize-column there asked for
     * 1900 px on a 1920 px monitor and got 1746). The strips keep the area
     * they have with the strut, see Strip.area in lib/tiling.js.
     *
     * The shell reads the size of its struts when an actor's allocation
     * changes, before the next frame. This strut is hidden under a
     * fullscreen window and gets none, so the shell is asked to read them
     * here. now: it is asked in any case, so the work areas have the new
     * width when this returns.
     */
    _placeStrut(now = false) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._strut)
            return;
        const lifted = global.display.get_monitor_in_fullscreen(monitor.index);
        this._strut.set_position(monitor.x, monitor.y);
        this._strut.set_size(lifted ? 0 : this._strutWidth, monitor.height);
        if (lifted !== this._lifted || now) {
            this._lifted = lifted;
            Main.layoutManager._updateRegions?.();
        }
    }

    /**
     * Slide the cards off the left edge while a window is fullscreen on the
     * sidebar's monitor, and back when it is not. The time is the shell's
     * own for a window that enters or leaves fullscreen, so the cards and
     * the window move together.
     */
    _syncFullscreen(animate) {
        const actor = this.actor;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!actor || !monitor)
            return;
        const covered = global.display.get_monitor_in_fullscreen(monitor.index);
        if (covered === this._covered)
            return;
        // reposition() asks again for the same state after a change of
        // width. Cards that a swipe had shown over the fullscreen window
        // then stay shown: the collapse button on them would hide them.
        const peek = this._covered === null && covered && this._peek;
        this._covered = covered;
        this._placeStrut();
        this._peek = peek;
        this._hold(peek);
        const shown = !covered || peek;
        const shift = -(this._margin() + this._cardWidth());
        if (peek)
            this._peekPos.set(-shift);
        else
            this._peekStop();
        this.tiling.peekMoved();
        actor.remove_transition('translation-x');
        if (!animate || !St.Settings.get().enable_animations) {
            actor.translation_x = shown ? 0 : shift;
            actor.visible = shown;
            return;
        }
        if (!shown) {
            actor.ease({
                translation_x: shift,
                duration: FULLSCREEN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => actor.hide(),
            });
        } else {
            actor.show();
            actor.ease({
                translation_x: 0,
                duration: FULLSCREEN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Over a fullscreen window the compositor can give the display that
     * window alone and skip everything else drawn on it. While the cards
     * are shown there, it is told not to.
     */
    _hold(on) {
        if (on === this._held)
            return;
        this._held = on;
        if (on)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    /**
     * The cards over a fullscreen window, pulled px from the left edge.
     * Called for every motion of a swipe, so the cards follow the fingers
     * up to the place they have with no fullscreen window, and stop there.
     * peekStay() leaves them there, peekEnd() sends them back out.
     *
     * A pull further than their width does not move them on: the margin
     * left of the cards would be wider than the one above them.
     */
    peekUpdate(px) {
        const actor = this.actor;
        if (!actor || !this._covered)
            return;
        const width = this._margin() + this._cardWidth();
        this._peekStop();
        this._peek = true;
        this._hold(true);
        actor.remove_transition('translation-x');
        actor.show();
        this._peekPos.set(Math.max(0, Math.min(px, width)));
        this._peekDraw();
    }

    /**
     * The cards spring back out: a swipe or a focus key the other way, or
     * a swipe that brought them in and did not go far enough. velocity is
     * the speed they had, in px/s, positive when more of them was coming
     * into view.
     */
    peekEnd(velocity = 0) {
        if (!this.actor || !this._covered || !this._peek)
            return;
        this._peekStop();
        this._peekTo(0, velocity);
    }

    /**
     * The fingers lifted after a swipe that brought the cards in: they go
     * on to their place and stay there, until peekEnd(). They do not go
     * back out by themselves when the fingers lift.
     */
    peekStay(velocity = 0) {
        if (!this.actor || !this._covered || !this._peek)
            return;
        this._peekStop();
        this._peekTo(this._margin() + this._cardWidth(), velocity);
    }

    /** A focus key asked for the cards: they come in and stay. */
    peekHold() {
        const actor = this.actor;
        if (!actor || !this._covered)
            return;
        if (!this._peek)
            this._peekPos.set(0);
        this._peek = true;
        this._hold(true);
        actor.remove_transition('translation-x');
        this._peekDraw();
        actor.show();
        this._peekTo(this._margin() + this._cardWidth());
    }

    /** Send the shown width to target on the spring. */
    _peekTo(target, velocity = this._peekPos.velocity) {
        const pos = this._peekPos;
        const animator = this.tiling.animator;
        if (!animator.enabled) {
            pos.set(target);
            this._peekDraw();
            this._peekRest();
            return;
        }
        pos.target = target;
        pos.velocity = velocity;
        animator.add(this._peekItem);
    }

    _peekDraw() {
        // A spring with animation.damping under 1 passes its target. The
        // cards do not pass their place.
        const width = this._margin() + this._cardWidth();
        this.actor.translation_x = Math.min(this._peekPos.value, width) - width;
        // The windows over the fullscreen one move over by what is shown.
        this.tiling.peekMoved();
    }

    /** The spring came to rest. Out of view, the cards are hidden again. */
    _peekRest() {
        if (this._peekPos.value > 0)
            return;
        this._peek = false;
        this.actor.hide();
        this._hold(false);
    }

    /** Stop the spring. */
    _peekStop() {
        this.tiling.animator?.remove(this._peekItem);
    }

    _applyCollapsed() {
        if (this.collapsed)
            this.actor.add_style_class_name('collapsed');
        else
            this.actor.remove_style_class_name('collapsed');
        for (const card of this._cards)
            card.setCollapsed(this.collapsed);
    }

    setCollapsed(collapsed) {
        if (this.collapsed === collapsed)
            return;
        this.collapsed = collapsed;
        this._applyCollapsed();
        this.reposition(true);
    }

    /**
     * The cards the calendar and the quick settings popups open next to,
     * as the clicks on them give them to lib/tweaks.js. For lib/warm.js.
     */
    get calendarSource() {
        return this._clock?.actor ?? null;
    }

    get quickSettingsSource() {
        return this._controls?.actor ?? null;
    }

    toggleCollapsed() {
        this.setCollapsed(!this.collapsed);
    }
}
