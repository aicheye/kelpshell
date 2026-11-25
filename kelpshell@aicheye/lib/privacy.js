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
// on the screen itself: a glow along the edges of a monitor, a frame around
// an area, an outline on a window. Red is a recording, purple is sharing.
// The marks are for the person at the screen and are not in the recording:
//
// - The glow and the frame are painted by the native module after Mutter has
//   made the picture for every cast (native/capture.c). Without the module
//   they are not drawn at all, because a cast of a monitor would show them.
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

import {visibleRect} from './crop.js';

const MARK_MS = 200;

// The colours of the marks, and of the chips in the card (stylesheet).
const TONES = {
    record: [224, 27, 36],
    cast: [192, 97, 203],
};

// The glow of a monitor reaches GLOW px in from each edge.
const GLOW = 40;
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
 * The upper left corner of a frame: a quarter of a ring `width` px wide
 * whose outer radius is `radius` px, in a square of that side. Two samples
 * for each px, and each edge of the ring is one sample wide.
 */
function arc(color, radius, width) {
    const key = `arc:${color.red},${color.green},${color.blue},${color.alpha}:${radius}:${width}`;
    let content = contents.get(key);
    if (content)
        return content;
    const n = radius * 2;
    const data = new Uint8Array(n * n * 4);
    const part = v => Math.min(1, Math.max(0, v));
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            // From the middle of the ring's circle, in samples.
            const d = Math.hypot(n - x - 0.5, n - y - 0.5);
            const a = color.alpha / 255 * part(n - d + 0.5) * part(d - (n - 2 * width) + 0.5);
            data.set([color.red * a, color.green * a, color.blue * a, 255 * a].map(Math.round),
                (y * n + x) * 4);
        }
    }
    content = picture(data, n, n);
    contents.set(key, content);
    return content;
}

/**
 * The frame of an area, from the ring around the focused window
 * (focusRing): its width, its radius, and how far its outer edge is from
 * the area, all in px of the stage. The area has square corners and the
 * frame round ones, so the frame is outside the area by so much that the
 * middle of its line goes through the corners of the area: that is
 * (radius - width / 2) * (1 - 1 / sqrt(2)) from the area to the middle of
 * the line.
 */
export function frameSpec(config) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const width = Math.max(1, Math.round(config.values.focusRing.width)) * scale;
    const radius = Math.max(width, Math.round(config.values.focusRing.radius) * scale);
    const reach = Math.round((radius - width / 2) * (1 - Math.SQRT1_2) + width / 2);
    return {width, radius, reach};
}

/**
 * A frame along the edge of its own box, with round corners: four lines
 * and four corners (arc), each an actor of its own, so the native module
 * repaints their places and not the whole box.
 */
export const Frame = GObject.registerClass(
class KelpFrame extends Clutter.Actor {
    _init(color, width, radius, props = {}) {
        super._init(props);
        this._color = color;
        this._width = width;
        this._radius = radius;
        this._lines = [0, 1, 2, 3].map(() => new Clutter.Actor({background_color: color}));
        this._corners = [[false, false], [true, false], [false, true], [true, true]].map(
            ([flipX, flipY]) => piece(null, 0, 0, 0, 0, flipX, flipY));
        for (const child of [...this._lines, ...this._corners])
            this.add_child(child);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [w, h] = [Math.round(box.get_width()), Math.round(box.get_height())];
        const t = this._width;
        // A box that is smaller than two corners has smaller ones.
        const r = Math.max(t, Math.min(this._radius, Math.floor(w / 2), Math.floor(h / 2)));
        if (r !== this._r) {
            this._r = r;
            const content = arc(this._color, r, t);
            for (const corner of this._corners)
                corner.content = content;
        }
        const place = (child, x, y, width, height) => child.allocate(new Clutter.ActorBox({
            x1: x, y1: y, x2: x + Math.max(0, width), y2: y + Math.max(0, height),
        }));
        place(this._lines[0], r, 0, w - 2 * r, t);
        place(this._lines[1], r, h - t, w - 2 * r, t);
        place(this._lines[2], 0, r, t, h - 2 * r);
        place(this._lines[3], w - t, r, t, h - 2 * r);
        place(this._corners[0], 0, 0, r, r);
        place(this._corners[1], w - r, 0, r, r);
        place(this._corners[2], 0, h - r, r, r);
        place(this._corners[3], w - r, h - r, r, r);
    }
});

/** An actor that shows a picture at a place, mirrored where asked. */
function piece(content, x, y, width, height, flipX = false, flipY = false) {
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
    const column = glow(tone, 'column', GLOW, 0.85, 3);
    const row = glow(tone, 'row', GLOW, 0.85, 3);
    // The strips lie over each other in the corners, where two edges glow.
    actor.add_child(piece(column, 0, 0, width, GLOW));
    actor.add_child(piece(column, 0, height - GLOW, width, GLOW, false, true));
    actor.add_child(piece(row, 0, 0, GLOW, height));
    actor.add_child(piece(row, width - GLOW, 0, GLOW, height, true, false));
    return actor;
}

/**
 * The frame of an area (frameSpec). Nothing of it is on another monitor: a
 * side of the area that is closer to the edge of its monitor than the frame
 * reaches has its line on that edge.
 */
function areaMark(config, monitor, rect, tone) {
    const {width, radius, reach} = frameSpec(config);
    const x1 = Math.max(monitor.x, rect.x - reach);
    const y1 = Math.max(monitor.y, rect.y - reach);
    const x2 = Math.min(monitor.x + monitor.width, rect.x + rect.width + reach);
    const y2 = Math.min(monitor.y + monitor.height, rect.y + rect.height + reach);
    const [r, g, b] = TONES[tone];
    const color = new Cogl.Color({red: r, green: g, blue: b, alpha: 255});
    return new Frame(color, width, radius, {x: x1, y: y1, width: x2 - x1, height: y2 - y1});
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
        this._checking = false;
        global.display.connectObject('window-created', () => this._syncMarks(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._syncMarks(true), this);
        // The shell darkens everything around a recorded area. The line
        // around the area takes its place.
        this._shade = this._native ? Main.screenshotUI._screencastAreaIndicator ?? null : null;
        if (this._shade)
            this._shade.opacity = 0;

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

    /** What is to be marked: key -> {kind, tone, monitor, rect, win}. */
    _wanted() {
        const wanted = new Map();
        if (!this._config.values.privacy.marks)
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
        const wanted = this._wanted();
        for (const [key, mark] of this._marks) {
            if (!rebuild && wanted.get(key)?.tone === mark.tone)
                continue;
            this._marks.delete(key);
            mark.win?.disconnectObject(this);
            if (mark.win)
                fadeOut(mark.actor);
            else
                fadeOut(mark.actor, () => this._rootLeft());
        }
        for (const [key, want] of wanted) {
            if (this._marks.has(key))
                continue;
            let actor = null;
            if (want.kind === 'window')
                actor = this._windowMark(want.win, want.tone);
            else if (this._native && want.kind === 'monitor')
                actor = monitorMark(want.monitor, want.tone);
            else if (this._native)
                actor = areaMark(this._config, want.monitor, want.rect, want.tone);
            if (!actor)
                continue;
            if (want.kind !== 'window') {
                this._ensureRoot().add_child(actor);
                this._painted++;
            }
            fadeIn(actor);
            this._marks.set(key, {actor, tone: want.tone, win: want.win ?? null});
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
     * screen now, among the marks, which are not recorded. The mark of what
     * is recorded (rect: x, y, width, height) is made from now on, before
     * the cast is there, so it comes as the frame of the selection goes.
     */
    handOff(rect, pictures) {
        if (!this._marks)
            return;
        this._pending = rect;
        if (!this._native || !this._config.values.privacy.marks ||
            !St.Settings.get().enable_animations)
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
}
