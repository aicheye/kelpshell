// SPDX-License-Identifier: GPL-3.0-or-later

// A scroll view that goes on for a while after the fingers have left the
// touchpad, as a list of a GTK app does.
//
// St.ScrollView (GNOME Shell 51) moves its adjustment by each scroll event
// and stops with the last one: st_scroll_view_scroll_event() adds
// delta * page_size^(2/3) and nothing follows. A swipe on the touchpad then
// moves the grid of the picker as far as the fingers go and no further.
//
// The view still handles the events itself. This only watches them. Clutter
// marks the event that ends a swipe (get_scroll_finish_flags), and from the
// speed of the last SAMPLE_MS before it the adjustment is moved on, slowing
// down the way GTK's kinetic scrolling does: the speed falls by e for every
// 1 / FRICTION seconds. The next scroll event, or a press, stops it. A
// mouse wheel has no such end and is left as it is.

import Clutter from 'gi://Clutter';

const FRICTION = 4;         // 1/s, as GTK's DECELERATION_FRICTION
const SAMPLE_MS = 150;      // the speed is taken over the events this old or newer
const MIN_SPEED = 0.15;     // px/ms, a swipe slower than this does not go on
const END_SPEED = 0.02;     // px/ms, where the motion ends

export class KineticScroll {
    /** view: an St.ScrollView. Vertical only. */
    constructor(view) {
        this._view = view;
        this._adjustment = view.vadjustment;
        this._samples = [];     // {time: ms, px}
        this._timeline = null;
        view.connectObject(
            'scroll-event', (_a, event) => this._onScroll(event),
            'button-press-event', () => this.stop(),
            'notify::mapped', () => {
                if (!view.mapped)
                    this.stop();
            },
            'destroy', () => this.stop(),
            this);
    }

    destroy() {
        this.stop();
        this._view.disconnectObject(this);
    }

    stop() {
        this._samples = [];
        const timeline = this._timeline;
        this._timeline = null;
        timeline?.stop();
    }

    _onScroll(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;
        // Any new event ends a motion that is under way.
        const samples = this._timeline ? [] : this._samples;
        this.stop();
        this._samples = samples;
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH ||
            event.get_scroll_source() !== Clutter.ScrollSource.FINGER)
            return Clutter.EVENT_PROPAGATE;

        const time = event.get_time();
        const [, dy] = event.get_scroll_delta();
        // What the view makes of the delta, see the top of the file.
        const px = dy * Math.pow(this._adjustment.page_size, 2 / 3);
        this._samples.push({time, px});
        this._samples = this._samples.filter(s => time - s.time <= SAMPLE_MS);

        if (event.get_scroll_finish_flags() & Clutter.ScrollFinishFlags.VERTICAL) {
            const span = time - this._samples[0].time;
            const moved = this._samples.reduce((sum, s) => sum + s.px, 0);
            this._samples = [];
            if (span >= 10 && Math.abs(moved / span) >= MIN_SPEED)
                this._coast(moved / span);
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Go on from the speed the swipe ended with, in px/ms. */
    _coast(speed) {
        const adjustment = this._adjustment;
        const from = adjustment.value;
        const k = FRICTION / 1000;
        // Until the speed is END_SPEED: speed * e^(-k t) = END_SPEED.
        const duration = Math.ceil(Math.log(Math.abs(speed) / END_SPEED) / k);
        const timeline = new Clutter.Timeline({actor: this._view, duration});
        this._timeline = timeline;
        timeline.connect('new-frame', (_t, elapsed) => {
            if (this._timeline !== timeline)
                return;
            const most = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
            const value = from + speed / k * (1 - Math.exp(-k * elapsed));
            adjustment.value = Math.max(adjustment.lower, Math.min(most, value));
            // At an end of the list there is nowhere to go on to.
            if (value <= adjustment.lower || value >= most)
                this.stop();
        });
        timeline.connect('completed', () => {
            if (this._timeline === timeline)
                this._timeline = null;
        });
        timeline.start();
    }
}
