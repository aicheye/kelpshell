// Springs and the frame ticker that drives them.
//
// A spring keeps its velocity when its target changes, so retargeting in the
// middle of a move continues smoothly. Clutter's ease() restarts from rest.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const REST_DISTANCE = 0.4;   // px
const REST_VELOCITY = 4;     // px/s

/** Distance shown for a pull of d px past an end: it never reaches size. */
export function rubberBand(d, size) {
    return size * (1 - 1 / (d * 0.55 / size + 1));
}

export class Spring {
    constructor(value = 0) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
    }

    set(value) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
    }

    get atRest() {
        return this.value === this.target && this.velocity === 0;
    }

    /**
     * Advance by dt seconds using the closed-form solution of
     * x'' = -omega^2 (x - target) - 2 zeta omega x', which is stable for any dt.
     */
    step(dt, omega, zeta) {
        if (this.atRest)
            return;
        const d = this.value - this.target;
        const v = this.velocity;
        let x, nv;
        if (zeta >= 1) {
            const c2 = v + omega * d;
            const e = Math.exp(-omega * dt);
            x = (d + c2 * dt) * e;
            nv = (c2 - omega * (d + c2 * dt)) * e;
        } else {
            const wd = omega * Math.sqrt(1 - zeta * zeta);
            const b = (v + zeta * omega * d) / wd;
            const e = Math.exp(-zeta * omega * dt);
            const cos = Math.cos(wd * dt);
            const sin = Math.sin(wd * dt);
            x = e * (d * cos + b * sin);
            nv = e * ((b * wd - zeta * omega * d) * cos - (d * wd + zeta * omega * b) * sin);
        }
        if (Math.abs(x) < REST_DISTANCE && Math.abs(nv) < REST_VELOCITY) {
            this.value = this.target;
            this.velocity = 0;
        } else {
            this.value = this.target + x;
            this.velocity = nv;
        }
    }
}

/** Calls tick(dt) on registered objects once per frame while any is active. */
export class Animator {
    constructor(config) {
        this._config = config;
        this._items = new Set();
        this._timeline = null;
        this._last = 0;
    }

    get omega() {
        return Math.sqrt(Math.max(1, this._config.values.animation.stiffness));
    }

    get zeta() {
        return Math.max(0.2, this._config.values.animation.damping);
    }

    get enabled() {
        return St.Settings.get().enable_animations;
    }

    enable() {
        this._timeline = new Clutter.Timeline({
            actor: global.stage,
            duration: 1000,
            repeat_count: -1,
        });
        this._timeline.connect('new-frame', () => this._tick());
    }

    disable() {
        this._timeline?.stop();
        this._timeline = null;
        this._items.clear();
    }

    /** item.tick(dt, omega, zeta) returns true while it still needs frames. */
    add(item) {
        this._items.add(item);
        if (this._timeline && !this._timeline.is_playing()) {
            this._last = GLib.get_monotonic_time();
            this._timeline.start();
        }
    }

    remove(item) {
        this._items.delete(item);
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min(0.05, Math.max(0.001, (now - this._last) / 1e6));
        this._last = now;
        const omega = this.omega;
        const zeta = this.zeta;
        for (const item of this._items) {
            let active = false;
            try {
                active = item.tick(dt, omega, zeta);
            } catch (e) {
                console.error(e);
            }
            if (!active)
                this._items.delete(item);
        }
        if (this._items.size === 0)
            this._timeline.stop();
    }
}
