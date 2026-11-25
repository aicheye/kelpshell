// SPDX-License-Identifier: GPL-3.0-or-later

// A recording of one window. The shell's recorder takes a monitor or an
// area, and what it records is that place on the screen. This one records
// the window itself, also while another window covers it or the strip
// scrolls it away.
//
// Mutter makes a screen cast of the window (RecordWindow), and
// gst-launch-1.0 writes it to a file, as a process of its own: the shell
// has its recorder in a process of its own for the same reason, a fault in
// an encoder does not end the session. The pipeline is the shell's software
// one, H.264 in MP4 with openh264enc where that is installed and VP8 in
// WebM otherwise.
//
// Mutter's cast of a window is as large as the monitor, with the window's
// buffer in its upper left corner, and says in the metadata of each frame
// where the window is. The encoders do not read that, so the part of the
// window that is drawn is cut out by videocrop, with the numbers of the
// moment the recording starts. A window that is resized afterwards is
// recorded in the same rectangle.

import Gettext from 'gettext';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {visibleRect} from './crop.js';

const BUS = 'org.gnome.Mutter.ScreenCast';
const FRAMERATE = 30;
// After the interrupt the file is finished within this long, or the
// process is ended.
const FINISH_MS = 5000;

const H264 = {
    extension: 'mp4',
    encode: [
        'openh264enc', 'deblocking=off', 'background-detection=false', 'complexity=low',
        'adaptive-quantization=false', 'qp-max=26', 'qp-min=26', 'slice-mode=auto', '!',
        'queue', '!', 'h264parse', '!',
        'mp4mux', 'fragment-duration=500', 'fragment-mode=first-moov-then-finalise',
    ],
};
const VP8 = {
    extension: 'webm',
    encode: [
        'vp8enc', 'cpu-used=16', 'max-quantizer=17', 'deadline=1', 'keyframe-mode=disabled',
        'static-threshold=1000', 'buffer-size=20000', '!',
        'queue', '!', 'webmmux',
    ],
};

/** A call to Mutter's screen cast service, which is in this process. */
function call(path, iface, method, params = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(BUS, path, iface, method, params, null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** The exit of a program, true for 0. */
function runs(argv) {
    return new Promise(resolve => {
        try {
            const process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            process.wait_async(null, () => resolve(process.get_successful()));
        } catch {
            resolve(false);
        }
    });
}

export class WindowRecorder {
    constructor(config) {
        this._config = config;
        this._format = null;     // H264 or VP8, once the programs are found
        this._session = null;    // the path of the screen cast session
        this._process = null;
        this._path = null;
        this._ended = null;      // called when a recording ends by itself
    }

    /** Look for the programs. Until they are found, available is false. */
    async probe() {
        if (!GLib.find_program_in_path('gst-launch-1.0') ||
            !GLib.find_program_in_path('gst-inspect-1.0'))
            return;
        const has = name => runs(['gst-inspect-1.0', '--exists', name]);
        if (!await has('pipewiresrc') || !await has('videocrop'))
            return;
        if (await has('openh264enc') && await has('mp4mux'))
            this._format = H264;
        else if (await has('vp8enc') && await has('webmmux'))
            this._format = VP8;
    }

    get available() {
        return this._format !== null;
    }

    get active() {
        return this._session !== null;
    }

    /**
     * Start recording a window. Resolves with the path of the file once
     * the cast is there and the pipeline is started. ended(path) is called
     * if the recording ends by itself, when the window closes for example:
     * path is the file, or null if nothing was written.
     */
    async start(win, drawCursor, ended) {
        if (!this.available || this.active)
            throw new Error('no window recording can start now');
        const crop = this._crop(win);
        const [session] = (await call('/org/gnome/Mutter/ScreenCast', BUS, 'CreateSession',
            new GLib.Variant('(a{sv})', [{}]))).deepUnpack();
        this._session = session;
        this._ended = ended;
        try {
            const [stream] = (await call(session, `${BUS}.Session`, 'RecordWindow',
                new GLib.Variant('(a{sv})', [{
                    'window-id': new GLib.Variant('t', win.get_id()),
                    'cursor-mode': new GLib.Variant('u', drawCursor ? 1 : 0),
                    'is-recording': new GLib.Variant('b', true),
                }]))).deepUnpack();
            const node = new Promise(resolve => {
                this._signalId = Gio.DBus.session.signal_subscribe(BUS, `${BUS}.Stream`,
                    'PipeWireStreamAdded', stream, null, Gio.DBusSignalFlags.NONE,
                    (_c, _s, _p, _i, _n, params) => resolve(params.deepUnpack()[0]));
            });
            await call(session, `${BUS}.Session`, 'Start');
            this._path = this._newPath();
            this._launch(await node, crop);
        } catch (e) {
            this._close();
            throw e;
        }
        return this._path;
    }

    /** Finish the file. Resolves with its path, or null if there is none. */
    stop() {
        if (!this.active)
            return Promise.resolve(null);
        this._ended = null;
        return new Promise(resolve => {
            const process = this._process;
            if (!process) {
                this._close();
                resolve(null);
                return;
            }
            // With -e, an interrupt ends the stream, and the file is
            // finished before the process exits.
            this._whenExited = resolve;
            process.send_signal(2);
            this._killId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FINISH_MS, () => {
                this._killId = 0;
                process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /** End a recording without waiting for its file. */
    destroy() {
        this._ended = null;
        this._whenExited = null;
        this._process?.force_exit();
        this._close();
    }

    /**
     * What videocrop takes off the cast, in px of the cast: the cast has
     * the size of the window's monitor and the window's buffer at 0, 0.
     * The part that is left is the part of the window that is drawn
     * (lib/crop.js), with an even width and height, which H.264 needs.
     */
    _crop(win) {
        const monitor = Main.layoutManager.monitors[win.get_monitor()];
        // The cast has the px of the monitor's own scale, rounded up, where
        // the stage has logical px. Where the stage has the px of the
        // monitors, St has the scale and the cast has the stage's px.
        const physical = St.ThemeContext.get_for_stage(global.stage).scale_factor > 1;
        const scale = physical ? 1 : Math.ceil(global.display.get_monitor_scale(monitor.index));
        const shown = visibleRect(this._config, win);
        const buffer = win.get_buffer_rect();
        const even = v => Math.max(2, Math.floor(v / 2) * 2);
        const left = Math.max(0, shown.x - buffer.x) * scale;
        const top = Math.max(0, shown.y - buffer.y) * scale;
        const width = even(Math.min(shown.width * scale, monitor.width * scale - left));
        const height = even(Math.min(shown.height * scale, monitor.height * scale - top));
        return {
            left, top,
            right: monitor.width * scale - left - width,
            bottom: monitor.height * scale - top - height,
        };
    }

    /** The file of a recording, named as the shell names its own. */
    _newPath() {
        const text = Gettext.domain('gnome-shell').gettext;
        const now = GLib.DateTime.new_now_local();
        const name = text('Screencast From %d %t')
            .replace('%d', now.format('%Y-%m-%d')).replace('%t', now.format('%H-%M-%S'));
        const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ||
            GLib.get_home_dir();
        const dir = GLib.build_filenamev([videos, text('Screencasts')]);
        GLib.mkdir_with_parents(dir, 0o755);
        return GLib.build_filenamev([dir, `${name}.${this._format.extension}`]);
    }

    _launch(node, crop) {
        const threads = Math.min(Math.max(1, GLib.get_num_processors()), 64);
        const argv = [
            'gst-launch-1.0', '-e', '-q',
            'pipewiresrc', `path=${node}`, 'do-timestamp=true', 'keepalive-time=1000',
            'resend-last=true', '!',
            `video/x-raw,max-framerate=${FRAMERATE}/1`, '!',
            'videocrop', `left=${crop.left}`, `top=${crop.top}`,
            `right=${crop.right}`, `bottom=${crop.bottom}`, '!',
            'videoconvert', 'chroma-mode=none', 'dither=none', 'matrix-mode=output-only',
            `n-threads=${threads}`, '!',
            'queue', '!',
            ...this._format.encode, '!',
            'filesink', `location=${this._path}`,
        ];
        const process = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._process = process;
        process.wait_async(null, () => {
            if (this._process !== process)
                return;
            const path = this._written();
            const [whenExited, ended] = [this._whenExited, this._ended];
            this._close();
            whenExited?.(path);
            ended?.(path);
        });
    }

    /** The path of the file if something is in it. */
    _written() {
        try {
            const info = Gio.File.new_for_path(this._path).query_info(
                'standard::size', Gio.FileQueryInfoFlags.NONE, null);
            return info.get_size() > 0 ? this._path : null;
        } catch {
            return null;
        }
    }

    /** The cast and everything that is kept for the recording. */
    _close() {
        if (this._killId)
            GLib.source_remove(this._killId);
        this._killId = 0;
        if (this._signalId)
            Gio.DBus.session.signal_unsubscribe(this._signalId);
        this._signalId = 0;
        if (this._session)
            call(this._session, `${BUS}.Session`, 'Stop').catch(() => {});
        this._session = null;
        this._process = null;
        this._whenExited = null;
        this._ended = null;
        this._path = null;
    }
}
