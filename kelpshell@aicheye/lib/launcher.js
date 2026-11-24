// SPDX-License-Identifier: GPL-3.0-or-later

// The launcher: one text field that searches apps, open windows and system
// actions, evaluates arithmetic, and runs commands prefixed with ">".
//
// It also searches what GNOME's search providers offer (files, settings,
// browser history, and the rest of Settings > Search), opens a typed web
// address, and offers the query as a web search.
//
// The rows are in three parts, in this order: local results, the web search,
// provider results. Provider results arrive after the others, and each
// answer is added at the end, so a row never moves once it is shown.
//
// Enter opens the selected result. Ctrl+Enter opens a new window of an app
// that is already running. Escape or a click outside closes it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as RemoteSearch from 'resource:///org/gnome/shell/ui/remoteSearch.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {easeSettled} from './settle.js';
import {endRehearsal} from './warm.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

// The four-finger swipe that opens and closes the launcher. Distances are in
// touchpad units as libinput reports them without acceleration, the units
// lib/tiling.js and the shell's own gestures use.
export const SWIPE_FINGERS = 4;
const SWIPE_DISTANCE = 16;      // units before the axis is decided, as in lib/tiling.js
const SWIPE_UNITS = 150;        // units of travel from closed to open; the shell's overview swipe takes 300
const SWIPE_VELOCITY_MS = 120;  // the release velocity is measured over this long
const SWIPE_REST_MS = 80;       // fingers that rested this long before lifting have no velocity
const SWIPE_FLICK = 0.1;        // units/ms: a faster release opens or closes whatever the travel

// Search providers are asked this long after the last key, so a word typed
// fast is one request and not one for each letter.
const PROVIDER_DELAY_MS = 150;
const PROVIDER_MIN_CHARS = 2;
const PER_PROVIDER = 3;
// A provider result can open in a window that is already there. The wait
// for a new window is shorter than after starting an app.
const PROVIDER_WINDOW_MS = 4000;
// The launcher does arithmetic itself.
const SKIPPED_PROVIDERS = ['org.gnome.Calculator.desktop'];

// A web address without a scheme: a host with a dot and letters after it.
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i;

/** The address to open for text that is one, or null. */
export function asUrl(text) {
    if (/\s/.test(text))
        return null;
    if (/^https?:\/\/\S+$/i.test(text))
        return text;
    if (/^localhost(:\d+)?([/?#]\S*)?$/i.test(text))
        return `http://${text}`;
    return HOST_RE.test(text) ? `https://${text}` : null;
}

/** A path under the home directory, written with ~. Other text is returned as it is. */
function tildePath(text) {
    const home = GLib.get_home_dir();
    return text === home || text.startsWith(`${home}/`) ? `~${text.slice(home.length)}` : text;
}

/** Score how well text matches query (both lower case). 0 means no match. */
function matchScore(query, text) {
    if (!text)
        return 0;
    if (text === query)
        return 120;
    if (text.startsWith(query))
        return 100 - Math.min(20, text.length - query.length) * 0.5;
    const wordStart = text.search(new RegExp(`(^|[\\s\\-_./])${escapeRegExp(query)}`));
    if (wordStart >= 0)
        return 80 - Math.min(20, wordStart) * 0.5;
    const at = text.indexOf(query);
    if (at >= 0)
        return 60 - Math.min(20, at) * 0.5;
    // Letters in order, not adjacent: "gte" matches "gnome text editor".
    let i = 0, gaps = 0, last = -1;
    for (let j = 0; j < text.length && i < query.length; j++) {
        if (text[j] === query[i]) {
            if (last >= 0)
                gaps += j - last - 1;
            last = j;
            i++;
        }
    }
    if (i === query.length && query.length >= 2)
        return Math.max(5, 35 - gaps);
    return 0;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Arithmetic: + - * / % ^, parentheses, and a few functions and constants.
const FUNCTIONS = {
    sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan,
    ln: Math.log, log: Math.log10, abs: Math.abs, round: Math.round,
    floor: Math.floor, ceil: Math.ceil,
};
const CONSTANTS = {pi: Math.PI, e: Math.E};

export function evaluate(expression) {
    const tokens = expression.toLowerCase().replace(/,/g, '.')
        .match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z]+|[-+*/%^()]/g);
    if (!tokens || tokens.join('') !== expression.toLowerCase().replace(/,/g, '.').replace(/\s+/g, ''))
        return null;
    let pos = 0;
    const peek = () => tokens[pos];
    const take = () => tokens[pos++];

    function primary() {
        const t = take();
        if (t === undefined)
            throw new Error('end');
        if (t === '(') {
            const v = sum();
            if (take() !== ')')
                throw new Error('paren');
            return v;
        }
        if (t === '-')
            return -power();
        if (t === '+')
            return power();
        if (/^[a-z]+$/.test(t)) {
            if (t in CONSTANTS)
                return CONSTANTS[t];
            if (t in FUNCTIONS && peek() === '(') {
                take();
                const v = sum();
                if (take() !== ')')
                    throw new Error('paren');
                return FUNCTIONS[t](v);
            }
            throw new Error('name');
        }
        const n = Number(t);
        if (Number.isNaN(n))
            throw new Error('number');
        return n;
    }
    function power() {
        const base = primary();
        if (peek() === '^') {
            take();
            return base ** power();
        }
        return base;
    }
    function product() {
        let v = power();
        while (['*', '/', '%'].includes(peek())) {
            const op = take();
            const r = power();
            if (op === '*')
                v *= r;
            else if (op === '/')
                v /= r;
            else
                v %= r;
        }
        return v;
    }
    function sum() {
        let v = product();
        while (['+', '-'].includes(peek())) {
            const op = take();
            const r = product();
            v = op === '+' ? v + r : v - r;
        }
        return v;
    }
    try {
        const v = sum();
        if (pos !== tokens.length || !Number.isFinite(v))
            return null;
        return v;
    } catch {
        return null;
    }
}

function formatNumber(v) {
    return String(Number(v.toPrecision(12)));
}

export class Launcher {
    constructor({config, backdrop, tiling}) {
        this._config = config;
        this._backdrop = backdrop;
        this._tiling = tiling;
        this._monitor = -1;
        this._results = [];
        this._local = [];
        this._web = [];
        this._remote = [];
        this._selected = 0;
        this._apps = null;
        this._providers = null;
        this._remoteId = 0;
        this._remoteCancel = null;
        this.isOpen = false;
        this._swipe = null;           // the four-finger swipe in progress, see _onTouchpad
        this._progress = 0;           // how far the card is through its opening animation, see _setProgress
        // The clipboard list, which opens over the launcher and is not
        // inside it. The launcher holds the grab, so a press, a pointer
        // motion or a scroll on the list arrives here and is handed to it,
        // and the list is closed with the launcher.
        this.guest = null;
    }

    enable() {
        this._appSystem = Shell.AppSystem.get_default();
        this._appSystem.connectObject('installed-changed', () => {
            this._apps = null;
        }, this);

        this._overlay = new St.Widget({
            style_class: 'kelp-launcher-overlay',
            reactive: true,
            visible: false,
            opacity: 0,
        });
        // A press outside the card closes the launcher, and the focus goes
        // to the window under the pointer, or to the monitor that was
        // pressed. The overlay is taken out of the pick for that: it is
        // still drawn while it fades. The handler never
        // stops the event: St.Button clicks are a Clutter gesture, and a
        // handler that stops the press cancels the gesture, so the result
        // rows would not receive 'clicked'.
        this._overlay.connect('button-press-event', (_a, event) => {
            const actor = global.stage.get_event_actor(event);
            if (this.guest?.press(actor, event.get_button()))
                return Clutter.EVENT_PROPAGATE;
            if (!this._box.contains(actor)) {
                const [x, y] = event.get_coords();
                this.close();
                this._overlay.reactive = false;
                this._tiling.focusAt(x, y);
                this._overlay.reactive = true;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._overlay.connect('motion-event', (_a, event) => {
            this.guest?.hover(global.stage.get_event_actor(event));
            return Clutter.EVENT_PROPAGATE;
        });
        // A scroll over the list arrives here too. Until 2026-11-22 it was
        // not handed over, and the list and the grid did not scroll over
        // the launcher (the user: "i can't scroll").
        this._overlay.connect('scroll-event', (_a, event) => {
            return this.guest?.scroll(global.stage.get_event_actor(event), event)
                ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        });
        // The stage gets the swipes while the launcher is closed. While it
        // is open it holds the grab, and they arrive at the overlay.
        this._touchpad = new Gio.Settings({
            schema_id: 'org.gnome.desktop.peripherals.touchpad',
        });
        this._overlay.connect('event::touchpad', (_a, event) => this._onTouchpad(event));
        global.stage.connectObject('event::touchpad',
            (_a, event) => this._onTouchpad(event), this);
        // For _note(): whether a four-finger swipe reaches the stage at
        // all, before any handler can stop it.
        global.stage.connectObject('captured-event::touchpad', (_a, event) => {
            if (event.type() === Clutter.EventType.TOUCHPAD_SWIPE &&
                event.get_gesture_phase() === Clutter.TouchpadGesturePhase.BEGIN &&
                event.get_touchpad_gesture_finger_count() === SWIPE_FINGERS)
                this._note('reached the stage');
            return Clutter.EVENT_PROPAGATE;
        }, this);

        this._entry = new St.Entry({
            style_class: 'kelp-launcher-entry',
            hint_text: 'Search apps, files and the web',
            primary_icon: new St.Icon({
                icon_name: 'system-search-symbolic',
                style_class: 'kelp-launcher-search-icon',
            }),
            can_focus: true,
            x_expand: true,
        });
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._entry.clutter_text.connect('text-changed', () => this._search());
        // The cursor is solid while it moves and blinks once it rests.
        this._entry.clutter_text.connect('text-changed', () => this._blink());
        this._entry.clutter_text.connect('cursor-changed', () => this._blink());
        this._entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        // Plain Enter does not arrive as a key press: ClutterText consumes it
        // and emits 'activate'. Enter with Ctrl or Shift still reaches _onKey.
        this._entry.clutter_text.connect('activate', () => this._activate(this._selected, false));

        this._list = new St.BoxLayout({orientation: VERTICAL, style_class: 'kelp-launcher-list'});
        this._hint = new St.Label({style_class: 'kelp-launcher-hint'});

        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-launcher',
            orientation: VERTICAL,
            reactive: true,
        });
        surface.add_child(this._entry);
        surface.add_child(this._list);
        surface.add_child(this._hint);
        this._box = this._backdrop.wrap(surface, 'kelp-shadow-launcher');
        this._overlay.add_child(this._box);

        Main.layoutManager.addTopChrome(this._overlay);
    }

    disable() {
        this.close(false);
        this._cancelRemote();
        this._providers = null;
        this._appSystem.disconnectObject(this);
        global.stage.disconnectObject(this);
        this._touchpad = null;
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = this._box = this._entry = this._list = null;
        this._hint = this._interface = null;
        this._apps = null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    /** The card with the size and the place it has on monitor, and the rows of an empty query. */
    _lay(monitor) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min(this._config.values.launcher.width * s, monitor.width - 40 * s);
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._box.set_width(width);
        this._box.set_position(
            Math.round((monitor.width - width) / 2), Math.round(monitor.height * 0.2));

        this._entry.text = '';
        this._search();
    }

    /**
     * For lib/warm.js: the launcher as it opens, not shown. null while it
     * is open.
     */
    rehearse() {
        const monitor = Main.layoutManager.primaryMonitor;
        // Visible after a close for as long as it fades.
        if (this.isOpen || !monitor || !this._overlay || this._overlay.visible)
            return null;
        this._lay(monitor);
        return {actor: this._overlay, isOpen: () => this.isOpen};
    }

    /**
     * Open on the monitor the user works on. With follow, nothing is
     * animated: the card is left where its opening animation starts, for a
     * swipe to move, see _onTouchpad. False when it did not open.
     */
    open(follow = false) {
        if (this.isOpen)
            return false;
        // The monitor the user is working on, as the tiling sees it.
        const monitor = Main.layoutManager.monitors[this._tiling.activeMonitor] ??
            Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;
        endRehearsal(this._overlay);
        const grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        if (!grab)
            return false;
        this._grab = grab;
        this.isOpen = true;
        this._monitor = monitor.index;

        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._lay(monitor);
        this._overlay.show();
        this._entry.grab_key_focus();
        this._blink();

        this._overlay.remove_all_transitions();
        this._box.remove_all_transitions();
        this._box.set_pivot_point(0.5, 0);
        if (follow) {
            // From where a closing fade had it, so the card does not jump.
            this._setProgress(this._overlay.opacity / 255);
            return true;
        }
        this._box.set_scale(0.97, 0.97);
        this._box.translation_y = -10 * s;
        this._progress = 0;
        this._finishOpen();
        return true;
    }

    /**
     * Draw the card p of the way through its opening animation, 0 to 1.
     * The overlay is never at 0: an actor at 0 is not drawn, and the work
     * of drawing the card for the first time would come in a later frame
     * of the swipe.
     */
    _setProgress(p) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._progress = p;
        this._overlay.opacity = Math.max(1, Math.round(255 * p));
        const scale = 0.97 + 0.03 * p;
        this._box.set_scale(scale, scale);
        this._box.translation_y = -10 * s * (1 - p);
    }

    /**
     * Run what is left of the opening animation: all of it from open(),
     * the rest of it when the fingers of a swipe lift.
     */
    _finishOpen() {
        const rest = 1 - this._progress;
        this._progress = 1;
        // Once the first frame is drawn, see settle.js. That waits for a
        // frame, and after a swipe nothing else asks for one: the card was
        // drawn where the fingers left it.
        this._overlay.queue_redraw();
        easeSettled(this._overlay, {
            opacity: 255,
            duration: Math.round(130 * rest),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        easeSettled(this._box, {
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: Math.round(180 * rest),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /**
     * Four fingers moving up open the launcher, and moving down close it.
     * The card follows the fingers through its opening animation, which
     * takes SWIPE_UNITS of travel. When they lift it opens or closes: the
     * way they were moving, or when they had rested, to the nearer end.
     * Without natural scrolling the directions are the other way round, as
     * they are for the shell's gestures.
     *
     * The axis is decided the way lib/tiling.js decides it, so four fingers
     * moving sideways still scroll the strip. The shell's workspace gesture
     * is kept from four-finger swipes in lib/tweaks.js.
     *
     * The launcher opens, and takes its grab, when the direction is known.
     * The rest of that swipe then arrives at the overlay and not at the
     * stage, so this handles the events of both.
     */
    _onTouchpad(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            // A swipe whose end never arrived.
            if (this._swipe?.following)
                this._swipeEnd(this._progress >= 0.5);
            this._swipe = null;
            if (event.get_touchpad_gesture_finger_count() === SWIPE_FINGERS) {
                this._note(`begin: open ${this.isOpen}, action mode ${Main.actionMode}, ` +
                    `enabled ${this._config.values.gestures.launcherSwipe}`);
            }
            if (this._config.values.gestures.launcherSwipe &&
                event.get_touchpad_gesture_finger_count() === SWIPE_FINGERS &&
                (this.isOpen || Main.actionMode === Shell.ActionMode.NORMAL))
                this._swipe = {dx: 0, dy: 0, following: false, wasOpen: false, from: 0, travel: 0, history: []};
            return Clutter.EVENT_PROPAGATE;
        }
        const s = this._swipe;
        if (!s)
            return Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
            // Positive towards open.
            const up = this._touchpad.get_boolean('natural-scroll') ? -dy : dy;
            if (!s.following) {
                s.dx += dx;
                s.dy += up;
                if (Math.hypot(s.dx, s.dy) < SWIPE_DISTANCE)
                    return Clutter.EVENT_PROPAGATE;
                // Sideways, or towards closed with nothing open.
                if (Math.abs(s.dx) > Math.abs(s.dy) || (!this.isOpen && s.dy < 0)) {
                    this._note(`not followed: sideways ${s.dx.toFixed(1)}, ` +
                        `towards open ${s.dy.toFixed(1)}`);
                    this._swipe = null;
                    return Clutter.EVENT_PROPAGATE;
                }
                s.wasOpen = this.isOpen;
                if (this.isOpen) {
                    // The clipboard list is over the launcher and would
                    // not fade with it: close both now.
                    if (this.guest?.isOpen) {
                        if (s.dy < 0)
                            this.close();
                        this._swipe = null;
                        return Clutter.EVENT_STOP;
                    }
                    // It can still be on its way in.
                    this._overlay.remove_all_transitions();
                    this._box.remove_all_transitions();
                    this._setProgress(this._overlay.opacity / 255);
                } else if (!this.open(true)) {
                    this._note('not followed: the launcher did not open');
                    this._swipe = null;
                    return Clutter.EVENT_PROPAGATE;
                }
                s.following = true;
                s.from = this._progress;
                this._note(`followed from ${s.from.toFixed(2)}, was open ${s.wasOpen}`);
            }
            // Travel past either end is not kept, so the card moves as soon
            // as the fingers turn back.
            const p = Math.min(Math.max(s.from + (s.travel + up) / SWIPE_UNITS, 0), 1);
            s.travel = (p - s.from) * SWIPE_UNITS;
            this._setProgress(p);
            const time = event.get_time();
            const last = s.history.at(-1);
            s.history.push({time, pos: (last?.pos ?? 0) + up});
            while (s.history.length > 2 && time - s.history[0].time > SWIPE_VELOCITY_MS)
                s.history.shift();
            return Clutter.EVENT_STOP;
        }

        // END or CANCEL
        this._swipe = null;
        if (!s.following)
            return Clutter.EVENT_PROPAGATE;
        if (phase === Clutter.TouchpadGesturePhase.CANCEL) {
            this._note(`cancelled at ${this._progress.toFixed(2)}`);
            this._swipeEnd(s.wasOpen);
            return Clutter.EVENT_STOP;
        }
        // Release velocity in units/ms, from the last SWIPE_VELOCITY_MS of motion.
        const first = s.history[0];
        const last = s.history.at(-1);
        let velocity = 0;
        if (last && last.time > first.time && event.get_time() - last.time < SWIPE_REST_MS)
            velocity = (last.pos - first.pos) / (last.time - first.time);
        const open = Math.abs(velocity) > SWIPE_FLICK ? velocity > 0 : this._progress >= 0.5;
        this._note(`end at ${this._progress.toFixed(2)}, ${velocity.toFixed(3)} units/ms: ` +
            `${open ? 'open' : 'closed'}`);
        this._swipeEnd(open);
        return Clutter.EVENT_STOP;
    }

    /**
     * A line in the journal for each step of a four-finger swipe, four per
     * swipe. On 2026-11-23 the user reported that the swipe does nothing in
     * a session until Super has been pressed once. In the headless shell it
     * opened the launcher every time: with Clutter swipe events put in the
     * event queue, after a fresh start, after an unlock, with and without a
     * window, on one monitor and two, and before the popups were drawn for
     * the first time. These lines show which step is missing on the user's
     * machine: `journalctl --user -b | grep 'launcher swipe'`.
     */
    _note(text) {
        console.log(`kelpshell: launcher swipe: ${text}`);
    }

    /** The fingers lifted: go the rest of the way to open, or close. */
    _swipeEnd(open) {
        this._swipe = null;
        if (open)
            this._finishOpen();
        else
            this.close();
    }

    close(animate = true) {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        // A swipe that was moving the card has nothing to move now.
        if (this._swipe?.following)
            this._note('closed while it was followed');
        this._swipe = null;
        this.guest?.close(animate);
        this._stopBlink();
        this._cancelRemote();
        Main.popModal(this._grab);
        this._grab = null;
        this._overlay.remove_all_transitions();
        if (!animate) {
            this._overlay.opacity = 0;
            this._overlay.hide();
            return;
        }
        this._overlay.ease({
            opacity: 0,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._overlay.hide(),
        });
    }

    // ---- the search field, for the clipboard list ----

    /** True while the search field has the keyboard: open, with nothing over it. */
    get typing() {
        return this.isOpen && global.stage.key_focus === this._entry.clutter_text;
    }

    /** The text cursor of the search field, in stage coordinates. */
    caret() {
        const field = this._entry.clutter_text;
        const [x, y] = field.get_transformed_position();
        const rect = field.get_cursor_rect();
        return {
            x: x + rect.origin.x, y: y + rect.origin.y,
            width: rect.size.width, height: rect.size.height,
        };
    }

    /** Put text at the text cursor, in place of the selection. The field has one line. */
    insert(text) {
        const field = this._entry.clutter_text;
        field.delete_selection();
        field.insert_text(text.replace(/\s*\n\s*/g, ' ').trim(), field.cursor_position);
    }

    // ---- cursor ----
    // St.Entry has no blinking cursor of its own in GNOME 51. This follows
    // GTK and the cursor-blink keys of org.gnome.desktop.interface: the cursor
    // is shown for half of cursor-blink-time and hidden for the other half,
    // and stays shown once cursor-blink-timeout seconds have passed.

    /** Show the cursor and start blinking from the beginning. */
    _blink() {
        this._stopBlink();
        if (!this.isOpen || !this._interface.get_boolean('cursor-blink'))
            return;
        const half = Math.max(100, this._interface.get_int('cursor-blink-time') / 2);
        const end = GLib.get_monotonic_time() / 1000 +
            this._interface.get_int('cursor-blink-timeout') * 1000;
        const text = this._entry.clutter_text;
        this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, half, () => {
            // A selection has no cursor to hide.
            const rests = text.cursor_position === text.selection_bound;
            if (GLib.get_monotonic_time() / 1000 >= end) {
                this._blinkId = 0;
                text.cursor_visible = true;
                return GLib.SOURCE_REMOVE;
            }
            text.cursor_visible = rests ? !text.cursor_visible : true;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopBlink() {
        if (this._blinkId)
            GLib.source_remove(this._blinkId);
        this._blinkId = 0;
        if (this._entry)
            this._entry.clutter_text.cursor_visible = true;
    }

    // ---- input ----

    _onKey(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._activate(this._selected, ctrl || shift);
            return Clutter.EVENT_STOP;
        default:
            break;
        }
        if (ctrl && (symbol === Clutter.KEY_n || symbol === Clutter.KEY_j)) {
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && (symbol === Clutter.KEY_p || symbol === Clutter.KEY_k)) {
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _select(index) {
        const n = this._results.length;
        if (n === 0)
            return;
        this._selected = ((index % n) + n) % n;
        this._list.get_children().forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        this._hint.text = this._results[this._selected]?.hint ?? '';
    }

    _activate(index, alternate) {
        const result = this._results[index];
        if (!result || !this.isOpen)
            return;
        this.close();
        try {
            result.activate(alternate);
        } catch (e) {
            Main.notifyError('Kelpshell', e.message);
        }
    }

    // ---- search ----

    _loadApps() {
        if (this._apps)
            return this._apps;
        this._apps = [];
        for (const info of this._appSystem.get_installed()) {
            if (!info.should_show())
                continue;
            const app = this._appSystem.lookup_app(info.get_id());
            if (!app)
                continue;
            this._apps.push({
                app,
                name: (app.get_name() ?? '').toLowerCase(),
                generic: (info.get_generic_name() ?? '').toLowerCase(),
                keywords: (info.get_keywords() ?? []).map(k => k.toLowerCase()),
                exec: (info.get_executable() ?? '').split('/').pop().toLowerCase(),
                description: info.get_generic_name() || info.get_description() || '',
            });
        }
        return this._apps;
    }

    _appResult(entry) {
        const app = entry.app;
        const running = app.get_n_windows() > 0;
        return {
            gicon: app.get_icon(),
            title: app.get_name(),
            subtitle: entry.description === app.get_name() ? '' : entry.description,
            kind: running ? 'Running' : 'App',
            hint: running ? 'Enter to switch   Ctrl+Enter for a new window' : 'Enter to open',
            activate: alternate => {
                const fresh = alternate && app.can_open_new_window();
                // A window this opens goes on the launcher's monitor.
                if (fresh || app.get_n_windows() === 0)
                    this._tiling.expectWindow(this._monitor);
                if (fresh)
                    app.open_new_window(-1);
                else
                    app.activate();
            },
        };
    }

    _usageRanks() {
        const ranks = new Map();
        Shell.AppUsage.get_default().get_most_used().forEach((app, i) => ranks.set(app.get_id(), i));
        return ranks;
    }

    _defaultResults(max) {
        const apps = this._loadApps();
        const byId = new Map(apps.map(a => [a.app.get_id(), a]));
        const out = [];
        const seen = new Set();
        const push = app => {
            const entry = byId.get(app.get_id());
            if (entry && !seen.has(app.get_id()) && out.length < max) {
                seen.add(app.get_id());
                out.push(this._appResult(entry));
            }
        };
        AppFavorites.getAppFavorites().getFavorites().forEach(push);
        Shell.AppUsage.get_default().get_most_used().forEach(push);
        for (const entry of apps) {
            if (out.length >= max)
                break;
            push(entry.app);
        }
        return out;
    }

    _systemResults() {
        const sa = SystemActions.getDefault();
        const mk = (title, words, iconName, can, run) => ({title, words, iconName, can, run});
        return [
            mk('Lock', 'lock screen', 'system-lock-screen-symbolic', sa.canLockScreen, () => sa.activateLockScreen()),
            mk('Suspend', 'suspend sleep', 'media-playback-pause-symbolic', sa.canSuspend, () => sa.activateSuspend()),
            mk('Log Out', 'log out logout sign out', 'system-log-out-symbolic', sa.canLogout, () => sa.activateLogout()),
            mk('Restart', 'restart reboot', 'system-reboot-symbolic', sa.canRestart, () => sa.activateRestart()),
            mk('Power Off', 'power off shutdown', 'system-shutdown-symbolic', sa.canPowerOff, () => sa.activatePowerOff()),
        ].filter(a => a.can);
    }

    _query(text) {
        const max = this._config.values.launcher.maxResults;
        const raw = text.trim();
        if (!raw)
            return this._defaultResults(max);

        if (raw.startsWith('>')) {
            const command = raw.slice(1).trim();
            if (!command)
                return [];
            return [{
                gicon: new Gio.ThemedIcon({name: 'utilities-terminal-symbolic'}),
                title: command,
                subtitle: 'Run command',
                kind: 'Command',
                hint: 'Enter to run',
                activate: () => {
                    this._tiling.expectWindow(this._monitor);
                    Util.spawnCommandLine(command);
                },
            }];
        }

        const q = raw.toLowerCase();
        const scored = [];

        const url = asUrl(raw);
        if (url) {
            scored.push({
                score: 190, result: {
                    gicon: this._browserIcon(),
                    title: raw,
                    subtitle: 'Open in the browser',
                    kind: 'Link',
                    hint: 'Enter to open',
                    activate: () => this._openUri(url),
                },
            });
        }

        if (/\d/.test(raw) && /[-+*/%^(]|[a-z]\(/i.test(raw)) {
            const value = evaluate(raw);
            if (value !== null) {
                const textValue = formatNumber(value);
                scored.push({
                    score: 200, result: {
                        gicon: new Gio.ThemedIcon({name: 'accessories-calculator-symbolic'}),
                        title: textValue,
                        subtitle: `${raw} =`,
                        kind: 'Result',
                        hint: 'Enter to copy',
                        activate: () => St.Clipboard.get_default().set_text(
                            St.ClipboardType.CLIPBOARD, textValue),
                    },
                });
            }
        }

        const ranks = this._usageRanks();
        for (const entry of this._loadApps()) {
            let score = Math.max(
                matchScore(q, entry.name),
                matchScore(q, entry.generic) * 0.7,
                matchScore(q, entry.exec) * 0.7,
                ...entry.keywords.map(k => matchScore(q, k) * 0.6));
            if (score <= 0)
                continue;
            const rank = ranks.get(entry.app.get_id());
            if (rank !== undefined)
                score += Math.max(0, 12 - rank);
            if (entry.app.get_n_windows() > 0)
                score += 3;
            scored.push({score, result: this._appResult(entry)});
        }

        const tracker = Shell.WindowTracker.get_default();
        for (const actor of global.get_window_actors()) {
            const win = actor.meta_window;
            if (win.is_skip_taskbar() || win.is_override_redirect())
                continue;
            const title = win.get_title() ?? '';
            const score = matchScore(q, title.toLowerCase()) * 0.75;
            if (score <= 0)
                continue;
            const app = tracker.get_window_app(win);
            const ws = win.get_workspace();
            scored.push({
                score, result: {
                    gicon: app?.get_icon() ?? new Gio.ThemedIcon({name: 'window-symbolic'}),
                    title,
                    subtitle: [app?.get_name(), ws ? `Workspace ${ws.index() + 1}` : null]
                    .filter(Boolean).join('  ·  '),
                    kind: 'Window',
                    hint: 'Enter to switch',
                    activate: () => Main.activateWindow(win),
                },
            });
        }

        for (const action of this._systemResults()) {
            const score = Math.max(...action.words.split(' ').map(w => matchScore(q, w)),
                matchScore(q, action.title.toLowerCase())) * 0.8;
            if (score <= 0)
                continue;
            scored.push({
                score, result: {
                    gicon: new Gio.ThemedIcon({name: action.iconName}),
                    title: action.title,
                    subtitle: 'System',
                    kind: 'Action',
                    hint: 'Enter to confirm',
                    activate: action.run,
                },
            });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, max).map(s => s.result);
    }

    // ---- the web and search providers ----

    _browserIcon() {
        return Gio.AppInfo.get_default_for_uri_scheme('https')?.get_icon() ??
            new Gio.ThemedIcon({name: 'web-browser-symbolic'});
    }

    _openUri(uri) {
        // A browser that is running opens a tab, and no window follows.
        const info = Gio.AppInfo.get_default_for_uri_scheme('https');
        const app = info ? this._appSystem.lookup_app(info.get_id()) : null;
        if (!app || app.get_n_windows() === 0)
            this._tiling.expectWindow(this._monitor);
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    }

    /** The row that sends the query to the search engine. */
    _webResults(text) {
        const raw = text.trim();
        const template = this._config.values.launcher.webSearch;
        if (!raw || raw.startsWith('>') || typeof template !== 'string' || !template.includes('%s'))
            return [];
        return [{
            gicon: new Gio.ThemedIcon({name: 'system-search-symbolic'}),
            title: raw,
            subtitle: 'Search the web',
            kind: 'Web',
            hint: 'Enter to search',
            activate: () => this._openUri(template.replace('%s', encodeURIComponent(raw))),
        }];
    }

    _loadProviders() {
        if (!this._providers) {
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
            this._providers = RemoteSearch.loadRemoteSearchProviders(settings)
                .filter(p => !SKIPPED_PROVIDERS.includes(p.id));
        }
        return this._providers;
    }

    _cancelRemote() {
        if (this._remoteId)
            GLib.source_remove(this._remoteId);
        this._remoteId = 0;
        this._remoteCancel?.cancel();
        this._remoteCancel = null;
    }

    /** Ask the search providers for the text, after a short wait. */
    _searchProviders(text) {
        this._cancelRemote();
        const raw = text.trim();
        if (!this._config.values.launcher.searchProviders ||
            raw.length < PROVIDER_MIN_CHARS || raw.startsWith('>'))
            return;
        const terms = raw.split(/\s+/);
        const cancellable = new Gio.Cancellable();
        this._remoteCancel = cancellable;
        this._remoteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PROVIDER_DELAY_MS, () => {
            this._remoteId = 0;
            for (const provider of this._loadProviders())
                this._askProvider(provider, terms, cancellable).catch(console.error);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _askProvider(provider, terms, cancellable) {
        const ids = await provider.getInitialResultSet(terms, cancellable);
        if (cancellable.is_cancelled() || !ids?.length)
            return;
        const metas = await provider.getResultMetas(
            provider.filterResults(ids, PER_PROVIDER).slice(0, PER_PROVIDER), cancellable);
        if (cancellable.is_cancelled() || !this.isOpen || !metas?.length)
            return;
        const max = this._config.values.launcher.maxResults;
        const room = Math.min(6, Math.max(3, max + 3 - this._local.length)) - this._remote.length;
        const kind = provider.appInfo.get_name();
        const added = metas.slice(0, Math.max(0, room)).map(meta => ({
            icon: () => meta.createIcon(32),
            gicon: provider.appInfo.get_icon(),
            title: meta.name ?? '',
            subtitle: tildePath((meta.description ?? '').replace(/\s+/g, ' ')),
            kind,
            hint: 'Enter to open',
            activate: () => {
                this._tiling.expectWindow(this._monitor, PROVIDER_WINDOW_MS);
                provider.activateResult(meta.id, terms);
            },
        }));
        if (added.length === 0)
            return;
        this._remote.push(...added);
        this._render(this._selected);
    }

    _search() {
        if (!this._list)
            return;
        const text = this._entry.text;
        this._local = this._query(text);
        this._web = this._webResults(text);
        this._remote = [];
        this._render(0);
        this._searchProviders(text);
    }

    /** Draw the rows again and select the one at index. */
    _render(selected) {
        this._results = [...this._local, ...this._web, ...this._remote];
        this._list.destroy_all_children();
        this._results.forEach((result, index) => {
            let icon = null;
            try {
                icon = result.icon?.() ?? null;
            } catch {
            }
            icon ??= new St.Icon({gicon: result.gicon});
            icon.add_style_class_name('kelp-result-icon');
            // A symbolic icon is a flat white shape. At the size of an app
            // icon it is the heaviest thing in the list, so it is drawn
            // smaller, in the middle of the same 32px place.
            if (icon instanceof St.Icon && icon.gicon instanceof Gio.ThemedIcon &&
                icon.gicon.get_names()[0]?.endsWith('-symbolic')) {
                icon.icon_size = 20;
                icon.add_style_class_name('kelp-result-symbol');
            }
            const title = new St.Label({text: result.title, style_class: 'kelp-result-title'});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const text = new St.BoxLayout({
                orientation: VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(title);
            if (result.subtitle) {
                const subtitle = new St.Label({
                    text: result.subtitle, style_class: 'kelp-result-subtitle',
                });
                subtitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                text.add_child(subtitle);
            }
            const kind = new St.Label({
                text: result.kind,
                style_class: 'kelp-result-kind',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const box = new St.BoxLayout({style_class: 'kelp-result-box', x_expand: true});
            box.add_child(icon);
            box.add_child(text);
            box.add_child(kind);
            const row = new St.Button({style_class: 'kelp-result', child: box, x_expand: true});
            row.connect('clicked', () => this._activate(index, false));
            // Motion and not hover: a row that appears under a resting
            // pointer must not take the selection from the first result.
            row.connect('motion-event', () => {
                if (this._selected !== index)
                    this._select(index);
                return Clutter.EVENT_PROPAGATE;
            });
            this._list.add_child(row);
        });
        this._list.visible = this._results.length > 0;
        this._selected = selected;
        this._select(selected);
        if (this._results.length === 0)
            this._hint.text = this._entry.text.trim() ? 'No results' : '';
    }
}
