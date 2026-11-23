// Animations of something that has just been shown, started once the shell
// has finished the work of showing it.
//
// A Clutter transition runs on the clock from the frame it is created in.
// The work of showing a popup for the first time after a login takes part of
// that time, and the animation skips what it took:
//   - the first frame lays the popup out and draws it,
//   - St then recomputes the styles of every widget that was added, in an
//     idle callback (st_widget_update_child_styles). That took 83 ms for the
//     shortcuts sheet the first time, 20 ms the second and nothing after,
//     because St keeps the styles it has computed,
//   - the frame after that lays the popup out again.
// Measured on 2026-11-22 on a 144 Hz monitor with eight windows, the largest
// step of the first opening against later ones, as a share of the whole
// animation: launcher 20% against 11%, shortcuts 56% against 31%, downloads
// 30% against 14%, calendar 27% against 9%, quick settings 39% against 10%.
// That was seen as a first animation that is too fast.
//
// Here the transitions are paused at their first value. They start when a
// frame of the actor's monitor has been drawn and the idle callbacks have
// run. When those callbacks took time, one more frame is drawn first.

import GLib from 'gi://GLib';
import St from 'gi://St';

const NOT_PROPERTIES = new Set([
    'duration', 'delay', 'mode', 'onComplete', 'onStopped',
    'repeatCount', 'autoReverse', 'animationRequired',
]);
// ms from the end of the first frame to the idle callback of this file. It
// runs after St's, so a longer time means St had styles to compute and the
// next frame has a layout to do.
const BUSY_MS = 4;
// ms after which everything starts whatever has been drawn: a popup on a
// monitor that draws no frame would stay at its first value.
const LIMIT_MS = 250;

// What waits: {actor, destroyId, start()}. destroyId is 0 once the actor
// has been destroyed.
let waiting = [];
let paintId = 0;
let idleId = 0;
let limitId = 0;

function disarm() {
    if (paintId)
        global.stage.disconnect(paintId);
    if (idleId)
        GLib.source_remove(idleId);
    if (limitId)
        GLib.source_remove(limitId);
    paintId = idleId = limitId = 0;
}

function release() {
    disarm();
    const list = waiting;
    waiting = [];
    for (const entry of list) {
        if (!entry.destroyId)
            continue;
        entry.actor.disconnect(entry.destroyId);
        try {
            entry.start();
        } catch (e) {
            console.error(e);
        }
    }
}

/** Run done() once, after a frame of a monitor with a waiting actor is drawn. */
function afterPaint(done) {
    if (paintId)
        global.stage.disconnect(paintId);
    paintId = global.stage.connect('after-paint', (_stage, view) => {
        const shown = waiting.some(entry =>
            entry.destroyId && entry.actor.peek_stage_views().includes(view));
        if (!shown)
            return;
        global.stage.disconnect(paintId);
        paintId = 0;
        done();
    });
}

function arm() {
    if (paintId || idleId)
        return;
    if (!limitId) {
        limitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIMIT_MS, () => {
            limitId = 0;
            release();
            return GLib.SOURCE_REMOVE;
        });
    }
    afterPaint(() => {
        const painted = GLib.get_monotonic_time();
        // After St's idle callbacks, which have the default idle priority.
        idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            idleId = 0;
            if (GLib.get_monotonic_time() - painted < BUSY_MS * 1000) {
                release();
                return GLib.SOURCE_REMOVE;
            }
            for (const entry of waiting) {
                if (entry.destroyId)
                    entry.actor.queue_redraw();
            }
            afterPaint(release);
            return GLib.SOURCE_REMOVE;
        });
    });
}

function wait(actor, start) {
    const entry = {actor, start, destroyId: 0};
    entry.destroyId = actor.connect('destroy', () => {
        entry.destroyId = 0;
    });
    waiting.push(entry);
    arm();
}

/**
 * Run start() once actor, which has just been shown or given new content,
 * has been laid out and drawn. Not at all when the actor is destroyed first.
 */
export function afterSettle(actor, start) {
    if (!St.Settings.get().enable_animations) {
        start();
        return;
    }
    wait(actor, start);
}

/**
 * Pause the transitions of these properties ('scale-x') that actor has
 * now. They start once the actor has been laid out and drawn. A transition
 * that is removed or replaced before that is left alone.
 *
 * An actor that fades in from nothing is drawn at an opacity of 1 of 255
 * until then: at 0 it is not drawn at all, and the work of drawing it for
 * the first time would come with the second frame of its animation.
 */
export function holdTransitions(actor, names) {
    if (!St.Settings.get().enable_animations)
        return;
    for (const name of names) {
        const transition = actor.get_transition(name);
        if (!transition)
            continue;
        transition.pause();
        const drawn = name === 'opacity' && actor.opacity === 0 &&
            actor.get_opacity_override() < 0;
        if (drawn)
            actor.set_opacity_override(1);
        wait(actor, () => {
            if (drawn)
                actor.set_opacity_override(-1);
            if (actor.get_transition(name) === transition)
                transition.start();
        });
    }
}

/**
 * actor.ease(params) for an actor that has just been shown or given new
 * content. The transitions start once that has been laid out and drawn.
 */
export function easeSettled(actor, params) {
    actor.ease(params);
    holdTransitions(actor, Object.keys(params)
        .filter(key => !NOT_PROPERTIES.has(key))
        .map(key => key.replaceAll('_', '-')));
}

/** Start everything that waits now. For disable(). */
export function settleNow() {
    release();
}
