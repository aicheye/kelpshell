// SPDX-License-Identifier: GPL-3.0-or-later

// What is being recorded, shared or listened to, and marks for it on the
// screen.
//
// Four things are followed:
//
//   recording   the shell's own screen recorder is running
//   sharing     an app has a screen cast: a call that shares the screen, a
//               recorder of its own, a remote desktop
//   microphone  an app records sound
//   camera      an app has a camera open
//
// The sidebar shows them in its privacy card (PrivacyCard in sidebar.js),
// with a button to stop a recording, to stop sharing and to mute the
// microphone.
//
// While the screen is recorded or shared, what is shown to others is marked
// on the screen itself: a glow along the edges of a monitor, an outline on a
// window, and everything around an area is darkened. Red is a recording,
// purple is sharing. The marks are for the person at the screen and are not
// in the recording:
//
// - The glow is painted by the native module after Mutter has made the
//   picture for every cast (native/capture.c). Without the module it is not
//   drawn at all, because a cast of a monitor would show it.
// - The darkening is around the area, and a cast of the area shows the
//   area. It is as the shell's own, which it takes the place of so that it
//   can come and go over MARK_MS.
// - The outline of a window is a child of the window's actor, so it is under
//   whatever covers the window. A cast of that window paints the actor again
//   into a buffer of its own, and the outline leaves itself out of every
//   paint that does not go to a monitor (OnScreen). A cast of the whole
//   monitor the window is on does show it.
//
// Which monitor, area or window a cast shows is read by the native module
// too. Without it the card still shows that the screen is shared.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gvc from 'gi://Gvc';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {holdInPlace} from './castplace.js';
import {visibleRect} from './crop.js';

const MARK_MS = 200;

// The colours of the marks, and of the chips in the card (stylesheet).
const TONES = {
    record: [224, 27, 36],
    cast: [192, 97, 203],
};

// The glow of a monitor reaches GLOW px in from each edge, where its
// opacity is GLOW_PEAK.
const GLOW = 40;
const GLOW_PEAK = 0.65;
// How dark everything around a recorded or shared area is: black at 30%,
// as the shell has it.
const SHADE = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 77});
// The outline of a window, px.
const OUTLINE = 3;

// Apps that record sound only to show its level.
const LEVEL_METERS = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

const STREAM_IFACE = 'org.gnome.Mutter.ScreenCast.Stream';

// Lets its actor be painted into the picture of a monitor only. A screen
// cast of a window, a cast that paints the stage for itself, a screenshot
// and a clone in the sidebar paint into a framebuffer of their own.
const OnScreen = GObject.registerClass(
class KelpOnScreen extends Clutter.Effect {
    vfunc_paint(node, paintContext, _flags) {
        const framebuffer = paintContext.get_framebuffer();
        if (global.stage.peek_stage_views().some(view => view.get_framebuffer() === framebuffer))
            this.actor.continue_paint(paintContext);
    }
});

const contents = new Map();   // key -> St.ImageContent

/**
 * A picture of one colour whose alpha falls from `peak` to 0 over `size` px.
 * shape 'column': from the top row down, one px wide. 'row': from the left
 * column on, one px high. Two samples for each px.
 */
function glow(tone, shape, size, peak, power) {
    const key = `${tone}:${shape}:${size}`;
    let content = contents.get(key);
    if (content)
        return content;
    const n = size * 2;
    const [w, h] = shape === 'column' ? [1, n] : [n, 1];
    const [r, g, b] = TONES[tone];
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const d = shape === 'column' ? y + 0.5 : x + 0.5;
            const a = peak * Math.max(0, 1 - d / n) ** power;
            // Premultiplied.
            data.set([r * a, g * a, b * a, 255 * a].map(Math.round), (y * w + x) * 4);
        }
    }
    content = picture(data, w, h);
    contents.set(key, content);
    return content;
}

/** Premultiplied RGBA bytes as a content. */
function picture(data, w, h) {
    const content = St.ImageContent.new_with_preferred_size(w, h);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(),
        new GLib.Bytes(data), Cogl.PixelFormat.RGBA_8888_PRE, w, h, w * 4);
    return content;
}

/**
 * The upper left corner of a place that is shown with round corners, as a
 * window is: black at `shade` (0 to 1) where the place is outside the
 * curve of `radius` px, and around the curve a ring `width` px wide of
 * `color` (a Cogl.Color, or null for no ring). The picture is radius + width
 * px square, and the corner of the place is `width` px in from its upper
 * left. Two samples for each px, and each edge is one sample wide.
 */
export function cornerPicture(radius, shade, color = null, width = 0) {
    const tint = color ? [color.red, color.green, color.blue, color.alpha] : [0, 0, 0, 0];
    const key = `corner:${radius}:${shade}:${tint.join(',')}:${width}`;
    let content = contents.get(key);
    if (content)
        return content;
    const n = (radius + width) * 2;
    const data = new Uint8Array(n * n * 4);
    const part = v => Math.min(1, Math.max(0, v));
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            // From the middle of the curve's circle, in samples.
            const d = Math.hypot(n - x - 0.5, n - y - 0.5);
            const outside = part(d - 2 * radius + 0.5);
            const inArea = x >= 2 * width && y >= 2 * width;
            const ring = tint[3] / 255 * outside * part(n - d + 0.5);
            const dark = inArea ? shade * outside : 0;
            // The ring over the shade, premultiplied.
            data.set([tint[0] * ring, tint[1] * ring, tint[2] * ring,
                255 * (ring + dark * (1 - ring))].map(Math.round), (y * n + x) * 4);
        }
    }
    content = picture(data, n, n);
    contents.set(key, content);
    return content;
}

/** An actor that shows a picture at a place, mirrored where asked. */
export function piece(content, x, y, width, height, flipX = false, flipY = false) {
    const actor = new Clutter.Actor({x, y, width, height, content});
    actor.set_content_scaling_filters(Clutter.ScalingFilter.LINEAR, Clutter.ScalingFilter.LINEAR);
    actor.set_pivot_point(0.5, 0.5);
    if (flipX)
        actor.scale_x = -1;
    if (flipY)
        actor.scale_y = -1;
    return actor;
}

/** The glow along the four edges of a monitor, inside it. */
function monitorMark(monitor, tone) {
    const {width, height} = monitor;
    const actor = new Clutter.Actor({
        x: monitor.x, y: monitor.y, width, height, clip_to_allocation: true,
    });
    const column = glow(tone, 'column', GLOW, GLOW_PEAK, 3);
    const row = glow(tone, 'row', GLOW, GLOW_PEAK, 3);
    // The strips lie over each other in the corners, where two edges glow.
    actor.add_child(piece(column, 0, 0, width, GLOW));
    actor.add_child(piece(column, 0, height - GLOW, width, GLOW, false, true));
    actor.add_child(piece(row, 0, 0, GLOW, height));
    actor.add_child(piece(row, width - GLOW, 0, GLOW, height, true, false));
    return actor;
}

// The whole stage but one place, darkened: four rectangles around the
// place. With a radius the place has round corners, as a window has: the
// corners are darkened outside the curve (cornerPicture).
const Surround = GObject.registerClass(
class KelpSurround extends Clutter.Actor {
    _init() {
        super._init();
        this._sides = [0, 1, 2, 3].map(() => new Clutter.Actor({background_color: SHADE}));
        this._corners = [[false, false], [true, false], [false, true], [true, true]].map(
            ([flipX, flipY]) => piece(null, 0, 0, 0, 0, flipX, flipY));
        for (const child of [...this._sides, ...this._corners])
            this.add_child(child);
        this._key = '';
        Shell.util_set_hidden_from_pick(this, true);
    }

    /** The place: x, y, width, height on the stage, and its corner radius. */
    setPlace(rect, radius = 0) {
        const key = `${rect.x},${rect.y},${rect.width},${rect.height},${radius}`;
        if (key === this._key)
            return;
        this._key = key;
        const [width, height] = global.stage.get_size();
        const [x1, y1] = [Math.max(0, rect.x), Math.max(0, rect.y)];
        const x2 = Math.max(x1, Math.min(width, rect.x + rect.width));
        const y2 = Math.max(y1, Math.min(height, rect.y + rect.height));
        const set = (actor, x, y, w, h) => {
            actor.set_position(x, y);
            actor.set_size(Math.max(0, w), Math.max(0, h));
        };
        set(this._sides[0], 0, 0, width, y1);
        set(this._sides[1], 0, y2, width, height - y2);
        set(this._sides[2], 0, y1, x1, y2 - y1);
        set(this._sides[3], x2, y1, width - x2, y2 - y1);
        const r = Math.max(0, Math.min(radius, Math.floor((x2 - x1) / 2), Math.floor((y2 - y1) / 2)));
        if (r !== this._radius) {
            this._radius = r;
            const content = r > 0 ? cornerPicture(r, SHADE.alpha / 255) : null;
            for (const corner of this._corners)
                corner.content = content;
        }
        set(this._corners[0], x1, y1, r, r);
        set(this._corners[1], x2 - r, y1, r, r);
        set(this._corners[2], x1, y2 - r, r, r);
        set(this._corners[3], x2 - r, y2 - r, r, r);
    }
});

/** The whole stage but an area (x, y, width, height), darkened. */
function areaMark(rect) {
    const actor = new Surround();
    actor.setPlace(rect);
    return actor;
}

/** Destroy a mark, unless it went with the window it was on. */
function drop(actor) {
    if (!actor.kelpGone)
        actor.destroy();
}

function fadeIn(actor) {
    actor.connect('destroy', () => (actor.kelpGone = true));
    actor.opacity = 0;
    actor.ease({opacity: 255, duration: MARK_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}

function fadeOut(actor, done = null) {
    if (actor.kelpGone) {
        done?.();
        return;
    }
    actor.ease({
        opacity: 0,
        duration: MARK_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: () => {
            drop(actor);
            done?.();
        },
    });
}

export class Privacy {
    constructor(config) {
        this._config = config;
        this._listeners = [];
        this.tiling = null;   // set by extension.js
    }

    enable() {
        this._native = null;
        try {
            const type = GObject.type_from_name('KelpCapture');
            if (type)
                this._native = GObject.Object.new(type);
        } catch (e) {
            console.warn(`kelpshell: capture module: ${e.message}`);
        }
        this._native?.connectObject('changed', () => this._syncMarks(), this);

        this._recordingSince = 0;
        this._tickId = 0;
        Main.screenshotUI.connectObject(
            'notify::screencast-in-progress', () => this._syncRecording(), this);

        // Casts that are not recordings of the shell. The shell's own
        // indicator in the top bar knows the ones that started before this.
        this._handles = new Set();
        this._controller = global.backend.get_remote_access_controller();
        this._controller?.connectObject('new-handle', (_c, handle) => this._addHandle(handle), this);
        for (const handle of Main.panel.statusArea.screenSharing?._handles ?? [])
            this._addHandle(handle);

        this._mixer = Volume.getMixerControl();
        this._mixer.connectObject(
            'state-changed', () => this._syncMic(),
            'stream-added', () => this._syncMic(),
            'stream-removed', () => this._syncMic(),
            'stream-changed', () => this._syncMic(),
            'default-source-changed', () => this._syncMic(),
            this);
        this._source = null;
        this.microphone = null;

        this._cameras = Main.panel.statusArea.quickSettings?._camera?._cameraMonitor ??
            new Shell.CameraMonitor();
        this._cameras.connectObject('notify::cameras-in-use', () => this._changed(), this);

        // The marks: key -> {actor, tone, win}. The ones of monitors and
        // areas are children of the root, which the native module paints.
        this._marks = new Map();
        this._closed = new WeakSet();   // windows that are closing
        this._root = null;
        this._painted = 0;       // children of the root, fading ones included
        this._held = false;      // the compositor is kept from unredirecting
        this._pending = null;    // the area of a recording that starts (handOff)
        this._shades = new Set(); // the darkening around each recorded window
        this._castWindows = new Map();   // window id -> 'record' or 'cast'
        this._holds = new Map();         // window id -> {win, release}, see _syncHolds
        this._followId = 0;
        this._checking = false;
        global.display.connectObject('window-created', () => this._syncMarks(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._syncMarks(true), this);
        // The shell's darkening around a recorded area, which is there
        // and gone in one frame. areaMark() takes its place.
        this._shade = Main.screenshotUI._screencastAreaIndicator ?? null;

        this._syncRecording();
        this._syncMic();
        this._syncMarks();
    }

    disable() {
        Main.screenshotUI.disconnectObject(this);
        this._controller?.disconnectObject(this);
        for (const handle of this._handles)
            handle.disconnectObject(this);
        this._handles.clear();
        this._mixer.disconnectObject(this);
        this._source?.disconnectObject(this);
        this._source = null;
        this._cameras.disconnectObject(this);
        this._cameras = null;
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        for (const mark of this._marks.values()) {
            mark.win?.disconnectObject(this);
            drop(mark.actor);
        }
        this._marks.clear();
        this._marks = null;
        for (const hold of this._holds.values()) {
            hold.release();
            this.tiling?.setFullSize(hold.win, false);
        }
        this._holds.clear();
        this._castWindows.clear();
        for (const shade of [...this._shades])
            shade.destroy();
        this._native?.emit('set-root', null);
        this._native?.disconnectObject(this);
        this._native = null;
        this._root?.destroy();
        this._root = null;
        this._hold(false);
        if (this._shade)
            this._shade.opacity = 255;
        this._shade = null;
        this._listeners = [];
    }

    /** Called when what is recorded, shared or listened to changes, and each second of a recording. */
    onChanged(fn) {
        this._listeners.push(fn);
    }

    _changed() {
        this._listeners.forEach(fn => fn());
    }

    /** The configuration has changed. */
    sync() {
        this._syncMarks(true);
    }

    get _marksOn() {
        return !!this._config.values.privacy.marks;
    }

    // ------------------------------------------------------------ recording

    get recording() {
        return Main.screenshotUI.screencast_in_progress;
    }

    /** Whole seconds the recording has run. */
    get recordingSeconds() {
        return this.recording
            ? Math.floor((GLib.get_monotonic_time() - this._recordingSince) / 1e6) : 0;
    }

    stopRecording() {
        Main.screenshotUI.stopScreencast();
    }

    _syncRecording() {
        const on = this.recording;
        if (on && !this._tickId) {
            // A recording that runs already: the shell's own indicator has
            // counted its seconds.
            const passed = Main.panel.statusArea.screenRecording?._secondsPassed ?? 0;
            this._recordingSince = GLib.get_monotonic_time() - passed * 1e6;
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._changed();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (!on)
            this._pending = null;
        this._changed();
        this._syncMarks();
    }

    // -------------------------------------------------------------- sharing

    /** The number of casts that are not the shell's recorder. */
    get sharing() {
        return this._handles.size;
    }

    stopSharing() {
        for (const handle of [...this._handles])
            handle.stop();
    }

    _addHandle(handle) {
        if (handle.is_recording || this._handles.has(handle))
            return;
        this._handles.add(handle);
        handle.connectObject('stopped', () => {
            handle.disconnectObject(this);
            this._handles.delete(handle);
            this._changed();
            this._syncMarks();
            this._checkStreams();
        }, this);
        this._changed();
        this._syncMarks();
    }

    // ----------------------------------------------------------- microphone

    get camera() {
        return this._cameras?.cameras_in_use ?? false;
    }

    toggleMicrophone() {
        this._source?.change_is_muted(!this._source.is_muted);
    }

    /**
     * microphone: 'on' while an app records sound, 'muted' while it does
     * and the microphone is muted, null otherwise. The rule for "an app
     * records" is the one of the shell's own icon.
     */
    _syncMic() {
        const source = this._mixer.get_default_source();
        if (source !== this._source) {
            this._source?.disconnectObject(this);
            this._source = source;
            source?.connectObject('notify::is-muted', () => this._syncMic(), this);
        }
        const used = !!source &&
            this._mixer.get_sources().some(s => s.state === Gvc.MixerStreamState.RUNNING) &&
            this._mixer.get_source_outputs().some(
                output => !LEVEL_METERS.includes(output.get_application_id()));
        let state = null;
        if (used)
            state = source.is_muted ? 'muted' : 'on';
        if (state === this.microphone)
            return;
        this.microphone = state;
        this._changed();
    }

    // ---------------------------------------------------------------- marks

    /** The streams the native module knows, as objects. */
    _streams() {
        if (!this._native)
            return [];
        return this._native.emit('streams').recursiveUnpack().map(
            ([path, , kind, connector, window, x, y, width, height, recording]) =>
                ({path, kind, connector, window, x, y, width, height, recording}));
    }

    /**
     * After a cast has stopped: have the streams forgotten that are gone.
     * A stream that is there answers a read of its Parameters property.
     */
    _checkStreams() {
        if (this._checking)
            return;
        const streams = this._streams();
        if (streams.length === 0)
            return;
        this._checking = true;
        const asked = streams.map(({path}) => new Promise(resolve => {
            Gio.DBus.session.call(
                'org.gnome.Mutter.ScreenCast', path, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [STREAM_IFACE, 'Parameters']), null,
                Gio.DBusCallFlags.NONE, 1000, null, (connection, result) => {
                    try {
                        connection.call_finish(result);
                    } catch {
                        this._native?.emit('forget', path);
                    }
                    resolve();
                });
        }));
        Promise.all(asked).then(() => (this._checking = false));
    }

    /**
     * How a window is shown to others now: 'record' while it is recorded,
     * 'cast' while an app shares it, null otherwise. The sidebar marks the
     * window's icon with it.
     */
    castOf(win) {
        return this._castWindows?.get(win.get_id()) ?? null;
    }

    /** The windows that have a cast, from the streams as they are now. */
    _syncCastWindows() {
        const now = new Map();
        for (const s of this._streams()) {
            if (s.kind !== 'window')
                continue;
            const tone = s.recording ? 'record' : 'cast';
            // As in _wanted(): a stream whose end was missed counts for
            // nothing.
            if (tone === 'record' ? !this.recording : this.sharing === 0)
                continue;
            if (now.get(s.window) !== 'record')
                now.set(s.window, tone);
        }
        const same = now.size === this._castWindows.size &&
            [...now].every(([id, tone]) => this._castWindows.get(id) === tone);
        this._castWindows = now;
        this._syncHolds();
        if (!same)
            this._changed();
    }

    /**
     * A window that an app shares is drawn at full size for as long, and
     * is in the cast where Mutter has it, whole, wherever its tile is on
     * the strip (lib/castplace.js). lib/shot.js does the same for a window
     * it records, with the drawn part at the corner of the picture.
     */
    _syncHolds() {
        const shared = id => this._castWindows.get(id) === 'cast';
        for (const [id, hold] of this._holds) {
            if (shared(id) && hold.win.get_compositor_private())
                continue;
            this._holds.delete(id);
            hold.release();
            // A window that is recorded now is held by lib/shot.js.
            if (!this._castWindows.has(id))
                this.tiling?.setFullSize(hold.win, false);
        }
        for (const id of this._castWindows.keys()) {
            if (!shared(id) || this._holds.has(id))
                continue;
            const win = global.display.list_all_windows().find(w => w.get_id() === id);
            if (!win?.get_compositor_private())
                continue;
            this._holds.set(id, {win, release: holdInPlace(this._config, win, false, false)});
            this.tiling?.setFullSize(win, true);
        }
    }

    /** What is to be marked: key -> {kind, tone, monitor, rect, win}. */
    _wanted() {
        const wanted = new Map();
        if (!this._marksOn)
            return wanted;
        const monitors = Main.layoutManager.monitors;
        const manager = global.backend.get_monitor_manager();
        const add = (key, mark) => {
            // A recording goes over sharing of the same thing.
            if (wanted.get(key)?.tone !== 'record')
                wanted.set(key, mark);
        };
        const streams = this._streams();
        // A recording that the shell has started and whose cast is not
        // there yet (handOff).
        if (this._pending && this.recording)
            streams.push({kind: 'area', recording: true, ...this._pending});
        for (const s of streams) {
            const tone = s.recording ? 'record' : 'cast';
            // A stream whose end was missed marks nothing once the shell
            // says that no recording or cast is left.
            if (tone === 'record' ? !this.recording : this.sharing === 0)
                continue;
            if (s.kind === 'monitor') {
                const monitor = monitors[manager.get_monitor_for_connector(s.connector)];
                if (monitor)
                    add(`monitor:${monitor.index}`, {kind: 'monitor', tone, monitor});
            } else if (s.kind === 'area') {
                const whole = monitors.find(m => m.x === s.x && m.y === s.y &&
                    m.width === s.width && m.height === s.height);
                // The monitor the middle of the area is on.
                const monitor = whole ?? monitors.find(m =>
                    s.x + s.width / 2 >= m.x && s.x + s.width / 2 < m.x + m.width &&
                    s.y + s.height / 2 >= m.y && s.y + s.height / 2 < m.y + m.height);
                if (whole) {
                    add(`monitor:${whole.index}`, {kind: 'monitor', tone, monitor});
                } else if (monitor) {
                    add(`area:${s.x},${s.y},${s.width},${s.height}`,
                        {kind: 'area', tone, monitor, rect: s});
                }
            } else if (s.kind === 'window') {
                const win = global.display.list_all_windows().find(w => w.get_id() === s.window);
                if (win?.get_compositor_private() && !this._closed.has(win))
                    add(`window:${s.window}`, {kind: 'window', tone, win});
            }
        }
        return wanted;
    }

    /** rebuild: every mark is made again, after a change of the monitors. */
    _syncMarks(rebuild = false) {
        if (!this._marks)
            return;
        this._syncCastWindows();
        if (this._shade)
            this._shade.opacity = this._marksOn ? 0 : 255;
        const wanted = this._wanted();
        for (const [key, mark] of this._marks) {
            // The darkening around an area is the same for a recording and
            // for sharing.
            if (!rebuild && wanted.has(key) &&
                (wanted.get(key).tone === mark.tone || (!mark.painted && !mark.win)))
                continue;
            this._marks.delete(key);
            mark.win?.disconnectObject(this);
            if (mark.painted)
                fadeOut(mark.actor, () => this._rootLeft());
            else
                fadeOut(mark.actor);
            if (mark.shade) {
                mark.shade.kelpLeaving = true;
                fadeOut(mark.shade);
            }
        }
        for (const [key, want] of wanted) {
            if (this._marks.has(key))
                continue;
            let actor = null;
            const painted = this._native && want.kind === 'monitor';
            let shade = null;
            if (want.kind === 'window') {
                actor = this._windowMark(want.win, want.tone);
                if (want.tone === 'record')
                    shade = this._windowShade(actor);
            } else if (painted) {
                actor = monitorMark(want.monitor, want.tone);
                this._ensureRoot().add_child(actor);
                this._painted++;
            } else if (want.kind === 'area') {
                // Over everything the stage has, and under what the native
                // module paints.
                actor = areaMark(want.rect);
                global.stage.add_child(actor);
                if (this._root)
                    global.stage.set_child_above_sibling(this._root, null);
            }
            if (!actor)
                continue;
            fadeIn(actor);
            this._marks.set(key,
                {actor, shade, tone: want.tone, win: want.win ?? null, painted});
        }
        // A window that is shown alone on its monitor is otherwise shown
        // without the compositor, and nothing is painted over it.
        this._hold(this._painted > 0);
    }

    /**
     * The shell starts a recording from its panel, and the panel is gone in
     * the next frame, so that the recording does not show it going. Here
     * the last picture of the screen with the panel (pictures: content, x,
     * y, width, height, one for each monitor) fades out over what is on the
     * screen now, where the native module paints, which is not recorded.
     * The mark of what is recorded (rect: x, y, width, height, or null
     * for a window, which has its mark when its cast is there) is made from
     * now on, before the cast is there, so it comes as the panel goes.
     */
    handOff(rect, pictures) {
        if (!this._marks)
            return;
        this._pending = rect;
        if (!this._native || !this._marksOn || !St.Settings.get().enable_animations)
            return;
        const group = new Clutter.Actor();
        for (const props of pictures)
            group.add_child(new Clutter.Actor(props));
        this._ensureRoot().add_child(group);
        this._painted++;
        this._hold(true);
        group.connect('destroy', () => (group.kelpGone = true));
        fadeOut(group, () => this._rootLeft());
    }

    /** The actor the native module paints after the casts have their picture. */
    _ensureRoot() {
        if (!this._root) {
            this._root = new Clutter.Actor();
            global.stage.add_child(this._root);
            Shell.util_set_hidden_from_pick(this._root, true);
        }
        global.stage.set_child_above_sibling(this._root, null);
        this._native.emit('set-root', this._root);
        return this._root;
    }

    /** A mark of the root has faded out and is gone. */
    _rootLeft() {
        if (!this._marks)
            return;
        this._painted--;
        if (this._painted > 0)
            return;
        this._native?.emit('set-root', null);
        this._hold(false);
    }

    _hold(on) {
        if (on === this._held)
            return;
        this._held = on;
        if (on)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    /** An outline on the part of a window that is drawn, in its actor. */
    _windowMark(win, tone) {
        const actor = new St.Widget({
            style_class: `kelp-cast-outline kelp-cast-outline-${tone}`,
            reactive: false,
        });
        actor.add_effect(new OnScreen());
        const place = () => {
            const rect = visibleRect(this._config, win);
            const buffer = win.get_buffer_rect();
            const full = win.is_fullscreen();
            const radius = full || !this._config.values.windows.clipCorners
                ? 0 : this._config.values.focusRing.radius;
            actor.style = `border-width: ${OUTLINE}px; border-radius: ${radius}px;`;
            actor.kelpRadius = radius *
                St.ThemeContext.get_for_stage(global.stage).scale_factor;
            actor.set_position(rect.x - buffer.x, rect.y - buffer.y);
            actor.set_size(rect.width, rect.height);
        };
        win.connectObject(
            'size-changed', place,
            'notify::fullscreen', place,
            'unmanaging', () => {
                this._closed.add(win);
                this._syncMarks();
            },
            this);
        place();
        win.get_compositor_private().add_child(actor);
        Shell.util_set_hidden_from_pick(actor, true);
        return actor;
    }

    /**
     * Everything but a recorded window is darkened, as around a recorded
     * area. The window moves: the darkening is placed before every frame
     * from where the window's outline is drawn, and is gone while the
     * window is not on the screen.
     */
    _windowShade(outline) {
        const shade = new Surround();
        shade.kelpOutline = outline;
        shade.kelpShown = false;
        shade.opacity = 0;
        global.stage.add_child(shade);
        if (this._root)
            global.stage.set_child_above_sibling(this._root, null);
        this._shades.add(shade);
        shade.connect('destroy', () => {
            this._shades.delete(shade);
            this._followShades();
        });
        this._followShades();
        this._placeShades();
        return shade;
    }

    _followShades() {
        const on = this._shades.size > 0;
        if (on && !this._followId) {
            this._followId = global.stage.connect('before-update', () => this._placeShades());
        } else if (!on && this._followId) {
            global.stage.disconnect(this._followId);
            this._followId = 0;
        }
    }

    _placeShades() {
        for (const shade of this._shades) {
            const outline = shade.kelpOutline;
            const shown = !outline.kelpGone && outline.mapped && !shade.kelpLeaving;
            if (shown) {
                const [x, y] = outline.get_transformed_position();
                const [width, height] = outline.get_transformed_size();
                if (Number.isFinite(x + y + width + height)) {
                    shade.setPlace({
                        x: Math.round(x), y: Math.round(y),
                        width: Math.round(width), height: Math.round(height),
                    }, outline.kelpRadius ?? 0);
                }
            }
            if (shown !== shade.kelpShown && !shade.kelpLeaving) {
                shade.kelpShown = shown;
                shade.ease({
                    opacity: shown ? 255 : 0,
                    duration: MARK_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }
}
