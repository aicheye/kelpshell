// SPDX-License-Identifier: GPL-3.0-or-later

// Touchpad scrolling that is the same in every window: as far for the same
// movement of the fingers, and going on as long after them, as in Firefox.
//
// Each toolkit turns a scroll event into a distance of its own, and has its
// own way of going on once the fingers are off the touchpad. Measured in the
// headless shell, with the same events sent to a window of each (40 events
// of 10 units, 8 ms apart, then the end of the scroll):
//
//                         px for one unit    px after the end    over
//   GTK 4.24                  2.5                  870           2.6 s
//   Firefox 160               4.0                 2460           3.1 s
//   Chrome 158 (Wayland)     12.0                 2990           1.8 s
//
// A unit is one unit of wl_pointer.axis, which is what libinput reports for
// the fingers.
//
// Visual Studio Code is Chromium, and its editor, lists and terminal do not
// scroll as a Chromium page does. They take the whole number of px
// Chromium would move for an event, with what is after the point cut off,
// and move by 50/120 of that, rounded up to a whole px (measured in Code
// 1.147: an event of 12 px moves the editor 5 px, one of 7.3 px moves it 3
// px, one of 1 px or less moves nothing). Sent what a Chromium page is
// sent, the editor moves 42% as far, and not at all for the slow events at
// the start and the end of a scroll. See _send() for what it is sent.
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
// after fingers at 0.3 px for each ms, a GTK 4 window goes on for 74 px and
// Chrome for 14 px, where Firefox stays (measured). Chrome still goes on,
// for 27 px, when it is told 200 ms after an event that is one frame newer
// than the last of the touchpad (measured).
const REST_MS = 300;
// ms between two reports of a touchpad, before any have told.
const INPUT_MS = 8;
// ms a report is on its way from the touchpad to this file, at the most.
const DELIVERY_MS = 1;
// The times between reports that are kept.
const GAPS = 20;
// The share of a frame's time by which the time read back changes in one
// frame, at the most: see _stepPan().
const LAG_STEP = 0.03;
// Gestures kept for scroll.log.
const LOG_GESTURES = 40;
// ms without a report after which the fingers count as resting.
const IDLE_MS = 150;

// px a window moves for one unit of wl_pointer.axis, by toolkit. own: the
// window goes on after the fingers as Firefox does, by itself. wheel: the
// window moves by whole px, one for this many px of a Chromium page.
const TOOLKITS = {
    firefox: {px: 4, own: true},
    gtk4: {px: 2.5},
    chromium: {px: 12},
    code: {px: 12, wheel: 120 / 50},
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
// Chromium windows that scroll as the editor of Visual Studio Code does: Code
// and what is built from it.
const CODE = /vscode|vscodium|codium|code-oss|code-insiders|(^| )code( |$)|cursor|windsurf/i;

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
        this._gaps = [];              // ms between the last reports of the touchpad
        this._gap = INPUT_MS;         // ms between two reports, see _onScroll()
        this._lag = INPUT_MS + DELIVERY_MS;   // ms the window is behind the fingers
        this._log = null;             // the gestures recorded for scroll.log
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
        if (name === 'chromium' && CODE.test(names))
            return TOOLKITS.code;
        return TOOLKITS[name] ?? null;
    }

    // ---- the fingers ----

    _onScroll(native, actor, timeUs, dx, dy, finish, source, _x, _y, _modifiers) {
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
                lastTime: 0, timeline: null, steps: 0, clock: 0,
                ending: null,
            };
            this._logStart(window, toolkit, scale);
        }
        this._note('e', t, dx, dy, finish, GLib.get_monotonic_time() / 1000);
        // The fingers moved again before the last of the scroll was sent.
        pan.ending = null;

        const moved = dx !== 0 || dy !== 0;
        if (moved) {
            pan.atX += dx * sx * k;
            pan.atY += dy * sy * k;
            pan.points.push({t, x: pan.atX, y: pan.atY});
            if (pan.points.length > 12)
                pan.points.shift();
            // The time between two reports: what four in five of the last
            // GAPS were under. One that is left out now and then, or all
            // that are while the fingers creep, do not count for it. A
            // longer wait is the fingers at rest.
            const gap = t - pan.lastTime;
            if (pan.lastTime && gap > 1 && gap < 25) {
                this._gaps.push(gap);
                if (this._gaps.length > GAPS)
                    this._gaps.shift();
                const sorted = this._gaps.slice().sort((p, q) => p - q);
                this._gap = sorted[Math.floor((sorted.length - 1) * 0.8)];
            }
            pan.lastTime = t;
        }

        if (!toolkit.own) {
            // As Firefox would see the event: px of the monitor, and the
            // time in whole ms, which is all a Wayland client is given.
            const time = Math.floor(t);
            pan.x += dx * 10 * sx * pxPerUnit * scale;
            pan.y += dy * 10 * sy * pxPerUnit * scale;
            // The event that ends the scroll moves nothing, and Firefox
            // measures no speed from it. Counted as a speed of none, it
            // would make the mean of the last five a fifth too low.
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

    // ---- scroll.log ----

    /**
     * With scroll.log on, what came from the touchpad and what was sent for
     * it is kept for the last LOG_GESTURES scrolls and written to
     * ~/.cache/kelpshell/scroll-log.json after each: for finding out why a
     * scroll was not even on this machine.
     */
    _logStart(window, toolkit, scale) {
        if (this._config.values.scroll.log !== true) {
            this._log = null;
            return;
        }
        this._log ??= [];
        this._log.push([['g', window.get_wm_class(), toolkit.px, scale,
            global.display.get_monitor_geometry(Math.max(0, window.get_monitor())).width]]);
        if (this._log.length > LOG_GESTURES)
            this._log.shift();
    }

    _note(...values) {
        this._log?.[this._log.length - 1].push(values);
    }

    _logWrite() {
        if (!this._log)
            return;
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kelpshell']);
        GLib.mkdir_with_parents(dir, 0o755);
        const round = v => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
        const text = JSON.stringify(this._log.map(gesture => gesture.map(row => row.map(round))));
        Gio.File.new_for_path(GLib.build_filenamev([dir, 'scroll-log.json'])).replace_contents_bytes_async(
            new GLib.Bytes(new TextEncoder().encode(text)), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (file, result) => {
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    console.warn(`kelpshell: scroll log: ${e.message}`);
                }
            });
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
     * monitor that is one frame of twice the distance in about every 25,
     * in Firefox, GTK 4 and Chrome alike (measured). The time an event
     * spends in the shell's JavaScript, up to 1.3 ms in 3500 events, can
     * move one more over the edge of a frame.
     *
     * Here the events only say where the scroll was at which time. Each
     * frame, the place it had a little before the time of the frame is read
     * from them, between two events on a straight line, and the window is
     * sent the way from the place of the frame before.
     *
     *   - The time of a frame goes on by a whole number of frame times, by
     *     the frame clock, as in _stepFling(), and is drawn towards the
     *     clock by a twentieth of what it is off.
     *   - "A little before" is this._lag: the time between two reports and
     *     DELIVERY_MS, so that the report after the time read is there. It
     *     is what the window is behind the fingers, about 9 ms. It follows
     *     the reports by LAG_STEP of a frame time in each frame and no
     *     faster. Set by each report at once, a report 2 ms later than the
     *     others would move the time read back by 2 ms in one frame, a
     *     frame of two thirds of the others: with reports 6 to 8 ms apart,
     *     frames are then between 27% and 140% of their mean (measured).
     *   - When the report after the time read is not there yet, the scroll
     *     is taken to go on as between the last two, for one frame time at
     *     the most. It is never taken back for that: when the reports then
     *     say that it went less far, the window waits for them.
     */
    _stepPan(pan, timeline) {
        const frame = 1000 / (timeline.frame_clock?.get_refresh_rate() || 60);
        const now = GLib.get_monotonic_time() / 1000;
        const frames = pan.steps++ === 0
            ? 1 : Math.max(1, Math.round(timeline.get_delta() / frame));
        pan.clock += frames * frame;
        // The first frame, or the clock of the frames has left the time.
        if (pan.steps === 1 || Math.abs(now - pan.clock) > 3 * frame)
            pan.clock = now;
        else
            pan.clock += (now - pan.clock) * 0.05;
        const want = this._gap + DELIVERY_MS;
        this._lag += Math.max(-LAG_STEP * frame, Math.min(LAG_STEP * frame, want - this._lag));
        const at = pan.clock - this._lag;

        const points = pan.points;
        const last = points[points.length - 1];
        let i = points.length - 1;
        while (i > 1 && points[i - 1].t > at)
            i--;
        // The two events around that time, or the last two.
        const b = points[i];
        const a = points[Math.max(0, i - 1)];
        const span = b.t - a.t;
        let x = last.x;
        let y = last.y;
        let how = 'end';
        if (at < last.t) {
            const share = span > 0 ? Math.max(0, (at - a.t) / span) : 0;
            x = a.x + (b.x - a.x) * share;
            y = a.y + (b.y - a.y) * share;
            how = 'between';
        } else if (!pan.ending && span > 0 && span < 25 && at - last.t < 25) {
            const ahead = Math.min(at - last.t, frame) / span;
            x += (b.x - a.x) * ahead;
            y += (b.y - a.y) * ahead;
            how = 'on';
        }
        // Not back against the way the fingers go: the window is ahead of
        // them by what was taken to go on, and waits.
        if ((x - pan.sentX) * (b.x - a.x) < 0)
            x = pan.sentX;
        if ((y - pan.sentY) * (b.y - a.y) < 0)
            y = pan.sentY;
        this._note('t', now, timeline.get_delta(), frames, at, this._lag, this._gap,
            x - pan.sentX, y - pan.sentY, how);
        if (x !== pan.sentX || y !== pan.sentY) {
            const [px, py, modifiers] = global.get_pointer();
            // The time the scroll was at this place: Firefox measures the
            // speed it goes on with from the way and the time between two
            // events. Times go up, a ms apart at the least.
            pan.sentTime = Math.max(pan.sentTime + 1, pan.ending ? Math.min(at, last.t) : at);
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
     * ms. Started with the next frame, it would leave this one with the
     * rest of the fingers' way alone: 3.8 px between frames of 8 px
     * (measured).
     */
    _endPan(pan, over) {
        const {finish, vx, vy} = pan.ending;
        this._dropPan();
        if (pan.toolkit.own) {
            const [x, y, modifiers] = global.get_pointer();
            this._native.emit('send', 0, 0, finish, x, y, modifiers,
                Math.round((pan.sentTime + 1) * 1000));
            this._logWrite();
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
     * goes on for another 2.3 s (measured).
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
     * It is not the time since the step before, read from the clock when
     * the step runs. The frames of a monitor are shown the same time apart,
     * and Mutter does not start its work for them the same time apart: it
     * starts as late as the work of the last frames allows. With the time
     * of the clock, a step that runs 2 ms late moves the window by a
     * quarter more than its frame, and the next one by as much less. With
     * steps delayed by 0 to 4 ms in the headless shell, the events sent
     * that way are off the mean of their two neighbours by 22% on average
     * and by up to 112% (measured). Counted in whole frames, they are off
     * by nothing.
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
        this._note('f', GLib.get_monotonic_time() / 1000, dt, fling.vy * dt / unit);
        this._send(fling.window, fling.toolkit,
            fling.vx * dt / unit, fling.vy * dt / unit, x, y, modifiers,
            Math.round(fling.time * 1000));
    }

    /**
     * Send a scroll event of (dx, dy) in Clutter's unit to a window.
     *
     * Chromium under Xwayland moves by whole px for each event and drops
     * the rest: with events of 3.6 px each it moves 3 px for each, and
     * ends a sixth short of the others (measured). A window of
     * an X11 client gets events of whole px, and what is left of one goes
     * into the next. Each is a fiftieth of a px over the whole number: on
     * its way through Xwayland the number comes out a little under now and
     * then, and Chromium then drops a whole px.
     *
     * A toolkit with wheel (Visual Studio Code) moves by whole px too,
     * and by one for every toolkit.wheel px of a Chromium page, rounded up.
     * Its window gets the event of the most px for which it moves the whole
     * px wanted: for 3 px that is 7 px of a page, which it takes as
     * ceil(7 / 2.4) = 3. What is left of the px wanted goes into the next
     * event, so the distance is that of the others at any speed. The event
     * is a quarter px over the whole number: the window cuts off what is
     * after the point, and two events it takes as one are then cut to the
     * sum of their whole numbers.
     */
    _send(window, toolkit, dx, dy, x, y, modifiers, timeUs) {
        const wheel = toolkit.wheel ?? 0;
        if (wheel || window.get_client_type() === Meta.WindowClientType.X11) {
            const px = toolkit.px * 10;
            let carry = this._carry;
            if (carry?.window !== window)
                carry = this._carry = {window, x: 0, y: 0};
            const wholeX = Math.trunc(dx * px + carry.x);
            const wholeY = Math.trunc(dy * px + carry.y);
            // px of a Chromium page for the whole px n.
            const page = n => wheel
                ? Math.sign(n) * (Math.ceil(Math.round(Math.abs(n) * wheel * 1000) / 1000) - 1 + 0.25)
                : n + Math.sign(n) * 0.02;
            const sentX = page(wholeX);
            const sentY = page(wholeY);
            carry.x += dx * px - (wheel ? wholeX : sentX);
            carry.y += dy * px - (wheel ? wholeY : sentY);
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
        this._logWrite();
        this._native?.emit('watch', false);
        if (tell && this._native) {
            const [x, y, modifiers] = global.get_pointer();
            this._native.emit('send', 0, 0, BOTH_AXES, x, y, modifiers, 0);
        }
    }
}
