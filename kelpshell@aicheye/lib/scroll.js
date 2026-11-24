// Touchpad scrolling that is the same in every window: as far for the same
// movement of the fingers, and going on as long after them, as in Firefox.
//
// Each toolkit turns a scroll event into a distance of its own, and has its
// own way of going on once the fingers are off the touchpad. Measured on
// 2026-11-23 in the headless shell, with the same events sent to a window of
// each (40 events of 10 units, 8 ms apart, then the end of the scroll):
//
//                         px for one unit    px after the end    over
//   GTK 4.24                  2.5                  870           2.6 s
//   Firefox 160               4.0                 2460           3.1 s
//   Chrome 158 (Wayland)     12.0                 2990           1.8 s
//
// A unit is one unit of wl_pointer.axis, which is what libinput reports for
// the fingers. The user: "firefox scroll and native app scroll feel the same
// but electron scrolling feels faster", and then "i like the firefox scroll
// speed and acceleration, measure and make them all the same".
//
// Nothing in GTK or Chromium sets these, so it is done here, between the
// touchpad and the windows. The native module (native/scroll.c) hands every
// touchpad scroll event to this file before a window gets it, and sends
// what this file gives it instead:
//
//   - While the fingers are on the touchpad, an event for a window of a
//     toolkit in TOOLKITS is sent with its size times 4 / px, the px of that
//     toolkit: the window then moves as far as a Firefox window would. The
//     events are sent one for each frame of the monitor and not as the
//     touchpad reports them, see _stepPan().
//   - When the fingers leave, the window is not told. This file works out
//     the speed Firefox would go on with, from the last events as Firefox
//     does it, and sends the events of that movement itself, one for each
//     frame of the monitor, each smaller than the one before as Firefox's
//     friction has it. To the window the fingers are still scrolling, and
//     slow down. It is told that the scroll has ended when the speed is
//     under the one Firefox stops at. Its own way of going on then starts
//     from next to nothing.
//   - A Firefox window gets its events one for each frame too, and goes on
//     after the fingers by itself: it is what the others are measured
//     against.
//   - A window of no known toolkit, and the shell's own lists, get their
//     events as they are too.
//
// The movement after the fingers ends early when they are back on the
// touchpad, a key or a button is pressed, or the pointer is over another
// window: each of the events is a scroll event at the place of the pointer.
//
// scroll.speed is a factor on every touchpad scroll event, before all of
// the above. It takes the place of "scroll-factor" in the configuration of
// libinput-config, a library loaded into the shell from /etc/ld.so.preload
// that changes what libinput reports. While that library is still set up
// with a scroll factor, the factor is divided out here, so the two together
// give scroll.speed. GNOME's own setting for the same thing, "scroll-speed"
// in org.gnome.desktop.peripherals.touchpad, is not read by Mutter 51.1.
//
// The numbers of Firefox are its preferences, by name in FIREFOX below with
// the values Firefox 160 starts with. Where the default profile sets one of
// them, in prefs.js or user.js, that value is used: what is changed in
// about:config changes every window, after the shell has started again or
// the configuration was saved.
//
// Without the native module, or when it could not put itself between Mutter
// and Clutter, nothing here does anything.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

// The preferences of Firefox this file follows. Velocities are in px of the
// monitor (not of the page) for each ms, as in Firefox.
const FIREFOX = {
    // A scroll event times this is the px the page moves. GDK gives Firefox
    // a tenth of a unit, so a unit is 4 px.
    'apz.gtk.pangesture.pixel_delta_mode_multiplier': 40,
    // False: Firefox does not go on after the fingers, and nothing does.
    'apz.gtk.kinetic_scroll.enabled': true,
    // Each ms the speed is multiplied by one less this.
    'apz.fling_friction': 0.002,
    // Under this speed the movement ends.
    'apz.fling_stopped_threshold': 0.01,
    // Fingers that leave slower than this start no movement.
    'apz.fling_min_velocity_threshold': 0.5,
    // The speed at the end is the mean of the last speeds measured: at most
    // this many, and none older than this many ms.
    'apz.max_velocity_queue_size': 5,
    'apz.velocity_relevance_time_ms': 100,
};
// A speed is measured between two events more than this many ms apart
// (MIN_VELOCITY_SAMPLE_TIME in Firefox's SimpleVelocityTracker.cpp).
const SAMPLE_MS = 5;
// ms a window is told that a scroll has ended after the fingers have left
// too slowly for Firefox to go on. A toolkit works out the speed it goes on
// with from the events of the time before the end: GTK 4 from the last 150
// ms (SCROLL_CAPTURE_THRESHOLD_MS in gtkscrolledwindow.c). Told at once,
// after fingers at 0.3 px for each ms, a GTK 4 window went on for 74 px and
// Chrome for 14 px, where Firefox stays (measured 2026-11-23). Chrome still
// went on, for 27 px, when it was told 200 ms after an event that was one
// frame newer than the last of the touchpad (2026-11-24).
const REST_MS = 300;
// ms between two reports of a touchpad, before the first two of a scroll
// have told.
const INPUT_MS = 8;
// ms without a report after which the fingers count as resting.
const IDLE_MS = 150;

// px a window moves for one unit of wl_pointer.axis, by toolkit. own: the
// window goes on after the fingers as Firefox does, by itself.
const TOOLKITS = {
    firefox: {px: 4, own: true},
    gtk4: {px: 2.5},
    chromium: {px: 12},
};
// What a process has mapped tells its toolkit. In this order: Chromium and
// Firefox both use GTK for their menus and dialogs.
const MAPPED = [
    ['firefox', /\/libxul\.so/],
    ['chromium', /\/(libcef\.so|icudtl\.dat|v8_context_snapshot[^/\n]*\.bin|chrome_\d+_percent\.pak)/],
    ['gtk4', /\/libgtk-4\.so/],
];
// GTK 4 windows that scroll by a count of their own and not by the px of
// GTK's scrolled window: terminals. They are left as they are.
const OWN_SCROLLING = /ghostty|ptyxis|kgx|console|terminal|kitty|alacritty|foot/i;

const FINGER = Clutter.ScrollSource.FINGER;
const BOTH_AXES = Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL;

function windowOf(actor) {
    for (let a = actor; a; a = a.get_parent()) {
        if (a instanceof Meta.WindowActor)
            return a.meta_window;
    }
    return null;
}

/** The text of a file, or '' when it cannot be read. */
function readText(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                resolve(new TextDecoder().decode(bytes));
            } catch {
                resolve('');
            }
        });
    });
}

/**
 * The factor libinput-config puts on touchpad scroll events: [x, y]. [1, 1]
 * without the library or without a factor in its configuration.
 */
async function libinputConfigFactor() {
    if (!(await readText('/etc/ld.so.preload')).includes('libinput-config'))
        return [1, 1];
    const factor = [1, 1];
    for (const line of (await readText('/etc/libinput.conf')).split('\n')) {
        const m = /^\s*scroll-factor(-x|-y)?\s*=\s*([\d.]+)\s*$/.exec(line);
        const value = m ? Number(m[2]) : NaN;
        if (!(value > 0))
            continue;
        if (m[1] !== '-y')
            factor[0] = value;
        if (m[1] !== '-x')
            factor[1] = value;
    }
    return factor;
}

/** The values the default profile of Firefox sets for the names in FIREFOX. */
async function firefoxPrefs() {
    const home = GLib.get_home_dir();
    const roots = [
        `${home}/.config/mozilla/firefox`,
        `${home}/.mozilla/firefox`,
        `${home}/.var/app/org.mozilla.firefox/.mozilla/firefox`,
    ];
    const found = {};
    for (const root of roots) {
        // eslint-disable-next-line no-await-in-loop
        const ini = await readText(`${root}/profiles.ini`);
        if (!ini)
            continue;
        // The profile of the installed Firefox, or else the one marked as
        // the default.
        let path = /^\[Install[^\]]*\][^[]*?^Default=(.+)$/m.exec(ini)?.[1];
        if (!path) {
            const section = ini.split(/^\[/m).find(s => /^Default=1$/m.test(s)) ?? '';
            path = /^Path=(.+)$/m.exec(section)?.[1];
        }
        if (!path)
            continue;
        const dir = path.startsWith('/') ? path : `${root}/${path.trim()}`;
        for (const name of ['prefs.js', 'user.js']) {
            // eslint-disable-next-line no-await-in-loop
            const text = await readText(`${dir}/${name}`);
            for (const m of text.matchAll(/^user_pref\("([^"]+)",\s*"?([^")]*)"?\);/gm)) {
                if (!(m[1] in FIREFOX))
                    continue;
                if (typeof FIREFOX[m[1]] === 'boolean')
                    found[m[1]] = m[2] === 'true';
                else if (Number.isFinite(Number(m[2])))
                    found[m[1]] = Number(m[2]);
            }
        }
        break;
    }
    return found;
}

export class Scroll {
    constructor(config) {
        this._config = config;
        this._native = null;
        this._prefs = {...FIREFOX};
        this._factor = [1, 1];        // of libinput-config
        this._byPid = new Map();      // pid -> toolkit name, or a promise of it
        this._pan = null;             // the scroll the fingers are making
        this._carry = null;           // px not yet sent to a window of an X11 client
        this._fling = null;           // the movement after it
        this._serial = 0;
    }

    enable() {
        let type = null;
        try {
            type = GObject.type_from_name('KelpScroll');
        } catch {
            // Not registered: the module is not built for this shell.
        }
        if (!type)
            return;
        const native = GObject.Object.new(type);
        if (!native.emit('hooked'))
            return;
        this._native = native;
        native.connectObject(
            'scroll', (...args) => {
                try {
                    return this._onScroll(...args);
                } catch (e) {
                    // The event goes on as it is.
                    console.error(e);
                    return false;
                }
            },
            'interrupt', () => this._haltFling(),
            this);
        global.display.connectObject('window-created', (_d, window) => this._mapped(window), this);
        for (const window of global.display.list_all_windows())
            this._mapped(window);
        this.apply();
    }

    disable() {
        this._serial++;
        this._dropPan();
        this._endFling(true);
        this._native?.disconnectObject(this);
        this._native = null;
        global.display.disconnectObject(this);
        this._byPid.clear();
        this._carry = null;
    }

    /** After a change of configuration: the files are read again. */
    apply() {
        if (!this._native)
            return;
        const serial = ++this._serial;
        Promise.all([firefoxPrefs(), libinputConfigFactor()]).then(([prefs, factor]) => {
            if (serial !== this._serial)
                return;
            this._prefs = {...FIREFOX, ...prefs};
            this._factor = factor;
        }).catch(console.error);
    }

    // ---- which toolkit a window is of ----

    /** Find the toolkit of the window's process, once for each process. */
    _mapped(window) {
        const pid = window.get_pid();
        if (pid <= 0 || this._byPid.has(pid))
            return;
        this._byPid.set(pid, null);
        readText(`/proc/${pid}/maps`).then(text => {
            if (!this._native)
                return;
            this._byPid.set(pid, MAPPED.find(([, mapped]) => mapped.test(text))?.[0] ?? 'none');
        });
    }

    /** The entry of TOOLKITS for a window, or null. */
    _toolkit(window) {
        if (!window)
            return null;
        const names = [window.get_wm_class(), window.get_wm_class_instance(),
            window.get_gtk_application_id?.()].filter(Boolean).join(' ').toLowerCase();
        const rules = this._config.values.scroll.apps;
        for (const rule of Array.isArray(rules) ? rules : []) {
            if (typeof rule?.match === 'string' && names.includes(rule.match.toLowerCase()))
                return TOOLKITS[rule.toolkit] ?? null;
        }
        const pid = window.get_pid();
        if (!this._byPid.has(pid))
            this._mapped(window);
        const name = this._byPid.get(pid);
        if (name === 'gtk4' && OWN_SCROLLING.test(names))
            return null;
        return TOOLKITS[name] ?? null;
    }

    // ---- the fingers ----

    _onScroll(native, actor, timeUs, dx, dy, finish, source, x, y, modifiers) {
        const values = this._config.values.scroll;
        const speed = Number(values.speed) > 0 ? Number(values.speed) : 1;
        const sx = speed / this._factor[0];
        const sy = speed / this._factor[1];
        const window = windowOf(actor);
        const toolkit = values.likeFirefox !== false && source === FINGER
            ? this._toolkit(window) : null;

        // The fingers are back: the window was never told that they had
        // left, so to it this is the same scroll.
        const flung = this._fling;
        if (flung)
            this._endFling(flung.window !== window);

        let pan = this._pan;
        if (pan && (pan.window !== window || pan.toolkit !== toolkit)) {
            this._dropPan();
            pan = null;
        }
        if (!toolkit) {
            if (sx === 1 && sy === 1)
                return false;
            native.emit('send', dx * sx, dy * sy, finish, 0, 0, 0, 0);
            return true;
        }

        const pxPerUnit = this._prefs['apz.gtk.pangesture.pixel_delta_mode_multiplier'] / 10;
        const k = pxPerUnit / toolkit.px;
        const scale = global.display.get_monitor_scale(Math.max(0, window.get_monitor()));
        const t = timeUs / 1000;
        if (!pan) {
            pan = this._pan = {
                window, toolkit, scale,
                // What Firefox would measure, see below.
                x: 0, y: 0, sampleTime: Math.floor(t), sampleX: 0, sampleY: 0, speeds: [],
                // What the window is sent, see _stepPan(): where the scroll
                // was at the time of each event, in Clutter's unit, and how
                // much of it has been sent.
                points: [{t: t - INPUT_MS, x: 0, y: 0}],
                atX: 0, atY: 0, sentX: 0, sentY: 0, sentTime: 0,
                period: INPUT_MS, lastTime: 0, timeline: null, steps: 0, clock: 0,
                ending: null,
            };
        }
        // The fingers moved again before the last of the scroll was sent.
        pan.ending = null;

        const moved = dx !== 0 || dy !== 0;
        if (moved) {
            pan.atX += dx * sx * k;
            pan.atY += dy * sy * k;
            pan.points.push({t, x: pan.atX, y: pan.atY});
            if (pan.points.length > 12)
                pan.points.shift();
            // The time between two reports: the longest of the last ones.
            // A touchpad that reports every 6 to 10 ms is read 10 ms back,
            // so that the report after the time read is there. A longer
            // wait is the fingers at rest.
            const gap = t - pan.lastTime;
            if (pan.lastTime && gap > 1 && gap < 25)
                pan.period = Math.max(gap, pan.period + (gap - pan.period) * 0.15);
            pan.lastTime = t;
        }

        if (!toolkit.own) {
            // As Firefox would see the event: px of the monitor, and the
            // time in whole ms, which is all a Wayland client is given.
            const time = Math.floor(t);
            pan.x += dx * 10 * sx * pxPerUnit * scale;
            pan.y += dy * 10 * sy * pxPerUnit * scale;
            // The event that ends the scroll moves nothing, and Firefox
            // measures no speed from it. Counted as a speed of none, it made
            // the mean of the last five a fifth too low.
            if ((moved || !finish) && time > pan.sampleTime + SAMPLE_MS) {
                const dt = time - pan.sampleTime;
                pan.speeds.push({time, x: (pan.x - pan.sampleX) / dt, y: (pan.y - pan.sampleY) / dt});
                if (pan.speeds.length > this._prefs['apz.max_velocity_queue_size'])
                    pan.speeds.shift();
                pan.sampleTime = time;
                pan.sampleX = pan.x;
                pan.sampleY = pan.y;
            }
        }

        if (finish) {
            // The fingers have left. What the window has not been sent yet
            // goes out with the next frames, and then _endPan() runs.
            let vx = 0;
            let vy = 0;
            if (!toolkit.own) {
                const time = Math.floor(t);
                const recent = pan.speeds.filter(sample =>
                    time - sample.time < this._prefs['apz.velocity_relevance_time_ms']);
                for (const sample of recent) {
                    vx += sample.x / recent.length;
                    vy += sample.y / recent.length;
                }
                if (!this._prefs['apz.gtk.kinetic_scroll.enabled'] ||
                    Math.hypot(vx, vy) <= this._prefs['apz.fling_min_velocity_threshold'])
                    vx = vy = 0;
            }
            pan.ending = {finish, vx, vy};
        }
        this._runPan(pan);
        return true;
    }

    _runPan(pan) {
        if (pan.timeline)
            return;
        pan.steps = 0;
        pan.timeline = new Clutter.Timeline({
            actor: pan.window.get_compositor_private(), duration: 1000, repeat_count: -1,
        });
        pan.timeline.connect('new-frame', timeline => {
            try {
                if (this._pan === pan)
                    this._stepPan(pan, timeline);
            } catch (e) {
                console.error(e);
                this._dropPan();
            }
        });
        pan.timeline.start();
    }

    /**
     * One frame of the scroll the fingers are making: the window is sent
     * the way the fingers went in the time of one frame, as one event.
     *
     * A touchpad reports the fingers about every 8 ms and a monitor shows a
     * frame every 6.9 ms (144 Hz) or 8.3 ms (120 Hz), so passed on as they
     * come, the events are not one for each frame: a window gets two in one
     * frame and none in the next, and what it draws jumps and waits for the
     * same movement of the fingers. With events 8 ms apart on a 120 Hz
     * monitor that was one frame of twice the distance in about every 25,
     * in Firefox, GTK 4 and Chrome alike (measured 2026-11-24; the user:
     * "the scroll bar definitely stutters on firefox"). The time an event
     * spends in the shell's JavaScript, up to 1.3 ms in 3500 events, can
     * move one more over the edge of a frame.
     *
     * Here the events only say where the scroll was at which time. Each
     * frame, the place it had one touchpad report before the time of the
     * frame is read from them, between two events on a straight line, and
     * the window is sent the way from the place of the frame before. The
     * frames are a whole number of frame times apart by the frame clock, as
     * in _stepFling(). The price is that one report, about 8 ms, between
     * the fingers and the window: a place between two events is not known
     * before the second one is there.
     */
    _stepPan(pan, timeline) {
        const frame = 1000 / (timeline.frame_clock?.get_refresh_rate() || 60);
        const now = GLib.get_monotonic_time() / 1000;
        const frames = pan.steps++ === 0
            ? 1 : Math.max(1, Math.round(timeline.get_delta() / frame));
        pan.clock += frames * frame;
        // The first frame, or the clock of the frames has left the time.
        if (pan.steps === 1 || Math.abs(pan.clock - now) > 2 * frame)
            pan.clock = now;
        const at = pan.clock - pan.period;

        // Where the scroll was at that time: on the line between the two
        // events around it, and where the last event has it from then on.
        const points = pan.points;
        const last = points[points.length - 1];
        let x = last.x;
        let y = last.y;
        if (at < last.t) {
            let i = points.length - 1;
            while (i > 0 && points[i - 1].t > at)
                i--;
            const b = points[i];
            const a = points[Math.max(0, i - 1)];
            const share = b.t > a.t ? Math.max(0, (at - a.t) / (b.t - a.t)) : 0;
            x = a.x + (b.x - a.x) * share;
            y = a.y + (b.y - a.y) * share;
        }
        if (x !== pan.sentX || y !== pan.sentY) {
            const [px, py, modifiers] = global.get_pointer();
            // The time the scroll was at this place: Firefox measures the
            // speed it goes on with from the way and the time between two
            // events. Times go up, a ms apart at the least.
            pan.sentTime = Math.max(pan.sentTime + 1, Math.min(at, last.t));
            this._send(pan.window, pan.toolkit, x - pan.sentX, y - pan.sentY,
                px, py, modifiers, Math.round(pan.sentTime * 1000));
            pan.sentX = x;
            pan.sentY = y;
        }
        if (at < last.t)
            return;
        // All of it is sent.
        if (pan.ending)
            this._endPan(pan, Math.min(at - last.t, frames * frame));
        else if (now - pan.lastTime > IDLE_MS)
            this._stopPan(pan);
    }

    /** The fingers rest on the touchpad: no frames until they move again. */
    _stopPan(pan) {
        pan.timeline?.stop();
        pan.timeline = null;
    }

    /** Forget the scroll of the fingers as it is, with nothing sent. */
    _dropPan() {
        if (this._pan)
            this._stopPan(this._pan);
        this._pan = null;
    }

    /**
     * The fingers have left and the window has all of their scroll. over:
     * the ms of this frame that came after the last of it.
     *
     * The movement after the fingers starts in the same frame, for those
     * ms. Started with the next frame, it left this one with the rest of
     * the fingers' way alone: 3.8 px between frames of 8 px (measured
     * 2026-11-24).
     */
    _endPan(pan, over) {
        const {finish, vx, vy} = pan.ending;
        this._dropPan();
        if (pan.toolkit.own) {
            const [x, y, modifiers] = global.get_pointer();
            this._native.emit('send', 0, 0, finish, x, y, modifiers,
                Math.round((pan.sentTime + 1) * 1000));
            return;
        }
        this._startFling(pan.window, pan.toolkit, pan.scale, vx, vy, pan.sentTime);
        if (over > 0 && this._fling?.timeline)
            this._advanceFling(this._fling, over);
    }

    // ---- after the fingers ----

    /**
     * With no speed: only the wait of REST_MS before the window is told.
     * time: of the last event the window was sent, in ms.
     */
    _startFling(window, toolkit, scale, vx, vy, time) {
        const fling = this._fling = {
            window, toolkit, scale, vx, vy, timeline: null, restId: 0, steps: 0,
            time: time || GLib.get_monotonic_time() / 1000,
        };
        this._native.emit('watch', true);
        if (vx === 0 && vy === 0) {
            this._rest(fling);
            return;
        }
        // On the frames of the monitor the window is on: a window draws one
        // frame for each of them, and then gets one event for each frame.
        fling.timeline = new Clutter.Timeline({
            actor: window.get_compositor_private(), duration: 1000, repeat_count: -1,
        });
        fling.timeline.connect('new-frame', timeline => {
            try {
                this._stepFling(timeline);
            } catch (e) {
                console.error(e);
                this._endFling(true);
            }
        });
        fling.timeline.start();
    }

    /**
     * A key, a button or the fingers on the touchpad: the movement stops
     * where it is. The window is told after REST_MS and not at once. Told
     * in the middle of the movement it goes on by itself, from the speed of
     * the last events: a GTK 4 window stopped 1.2 s into a fast movement
     * went on for another 2.3 s (measured 2026-11-23).
     */
    _haltFling() {
        const fling = this._fling;
        if (!fling || fling.restId)
            return;
        fling.vx = fling.vy = 0;
        this._rest(fling);
    }

    _rest(fling) {
        fling.timeline?.stop();
        fling.timeline = null;
        fling.restId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REST_MS, () => {
            fling.restId = 0;
            this._endFling(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * One frame of the movement. The time it covers is a whole number of
     * frames of the monitor, from the frame clock: one, or more when the
     * shell has left frames out.
     *
     * Until 2026-11-24 it was the time since the step before, read from the
     * clock when the step ran. The frames of a monitor are shown the same
     * time apart, and Mutter does not start its work for them the same time
     * apart: it starts as late as the work of the last frames allows. A
     * step that ran 2 ms late moved the window by a quarter more than its
     * frame, and the next one by as much less (the user: "i occasionally
     * feel stutters"). With steps delayed by 0 to 4 ms in the headless
     * shell, the events sent were off the mean of their two neighbours by
     * 22% on average and by up to 112%, and are by nothing now.
     */
    _stepFling(timeline) {
        const fling = this._fling;
        const frame = 1000 / (timeline.frame_clock?.get_refresh_rate() || 60);
        // The first step has no step before it.
        const frames = fling.steps++ === 0
            ? 1 : Math.max(1, Math.round(timeline.get_delta() / frame));
        this._advanceFling(fling, frames * frame);
    }

    /** Move on by dt ms. */
    _advanceFling(fling, dt) {
        // DesktopFlingPhysics::Sample in Firefox.
        const friction = this._prefs['apz.fling_friction'];
        const stopped = this._prefs['apz.fling_stopped_threshold'];
        const slowed = v => Math.abs(v) <= stopped ? 0 : v * Math.pow(1 - friction, dt);
        fling.vx = slowed(fling.vx);
        fling.vy = slowed(fling.vy);
        const [x, y, modifiers] = global.get_pointer();
        if (windowOf(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)) !== fling.window) {
            this._endFling(true);
            return;
        }
        // The last events were of next to no speed: the window can be told.
        if (fling.vx === 0 && fling.vy === 0) {
            this._endFling(true);
            return;
        }
        // px of the monitor to Clutter's unit for this toolkit.
        const unit = fling.scale * fling.toolkit.px * 10;
        fling.time += dt;
        this._send(fling.window, fling.toolkit,
            fling.vx * dt / unit, fling.vy * dt / unit, x, y, modifiers,
            Math.round(fling.time * 1000));
    }

    /**
     * Send a scroll event of (dx, dy) in Clutter's unit to a window.
     *
     * Chromium under Xwayland moves by whole px for each event and drops
     * the rest: with events of 3.6 px each it moved 3 px for each, and
     * ended a sixth short of the others (measured 2026-11-23). A window of
     * an X11 client gets events of whole px, and what is left of one goes
     * into the next. Each is a fiftieth of a px over the whole number: on
     * its way through Xwayland the number comes out a little under now and
     * then, and Chromium then drops a whole px.
     */
    _send(window, toolkit, dx, dy, x, y, modifiers, timeUs) {
        if (window.get_client_type() === Meta.WindowClientType.X11) {
            const px = toolkit.px * 10;
            let carry = this._carry;
            if (carry?.window !== window)
                carry = this._carry = {window, x: 0, y: 0};
            const wholeX = Math.trunc(dx * px + carry.x);
            const wholeY = Math.trunc(dy * px + carry.y);
            const sentX = wholeX + Math.sign(wholeX) * 0.02;
            const sentY = wholeY + Math.sign(wholeY) * 0.02;
            carry.x += dx * px - sentX;
            carry.y += dy * px - sentY;
            if (wholeX === 0 && wholeY === 0)
                return;
            dx = sentX / px;
            dy = sentY / px;
        }
        this._native.emit('send', dx, dy, 0, x, y, modifiers, timeUs);
    }

    /** tell: let the window know that the scroll has ended. */
    _endFling(tell) {
        const fling = this._fling;
        if (!fling)
            return;
        this._fling = null;
        fling.timeline?.stop();
        if (fling.restId)
            GLib.source_remove(fling.restId);
        this._native?.emit('watch', false);
        if (tell && this._native) {
            const [x, y, modifiers] = global.get_pointer();
            this._native.emit('send', 0, 0, BOTH_AXES, x, y, modifiers, 0);
        }
    }
}
