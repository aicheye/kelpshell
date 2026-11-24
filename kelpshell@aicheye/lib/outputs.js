// SPDX-License-Identifier: GPL-3.0-or-later

// What follows a change of the output device.
//
// When the default output becomes another device (chosen in the output menu,
// a Bluetooth speaker that connects or goes away, headphones plugged into
// the machine), two things happen:
//
//   - Every media player is paused, so what played on the speaker does not
//     go on from the laptop, or the other way round. This is the MPRIS
//     Pause call, which does nothing to a player that is not playing.
//   - EasyEffects loads the output preset that was loaded when this device
//     was last the output. A preset is made for one speaker: the correction
//     of one played through another is wrong for both.
//
// Which preset belongs to which device is not configured, it is followed.
// At a change of device EasyEffects is asked which preset it has loaded
// (easyeffects --last-loaded-preset output). That one is stored for the
// device that was the output until now, and the one stored for the new
// device is loaded. A device met for the first time keeps the preset that
// is loaded.
//
// The device the loaded preset belongs to is stored too. So a login with
// the device of the last session leaves the preset alone, whatever was
// chosen for it since the last change, and a login with another device is
// a change of device like any other.
//
// EasyEffects is asked, and its settings file is not read: on 2026-11-22
// version 8.2.8 had not written a preset loaded 20 seconds earlier to
// ~/.config/easyeffects/db/easyeffectsrc.
//
// A device is the sink's name. For a sink with several ports (the machine's
// own card: speakers and the headphone jack) the port is part of it. A
// Bluetooth sink has one port and keeps its name through a change of its
// profile, so a call does not count as another device.
//
// The file is $XDG_STATE_HOME/kelpshell/outputs.json:
//   {"last": the device the loaded preset belongs to,
//    "presets": {device: preset name}}
//
// EasyEffects sends what it has processed to the default output itself, so
// the default stays the real device while it runs. Its own sink as the
// default is not a device here. The easyeffects program is run only while
// that sink is there: without a running EasyEffects the same command would
// start one. A preset that is due then is loaded when the sink appears.
//
// This runs for as long as the extension is enabled, in the session and on
// the lock screen: a speaker can go away while the screen is locked.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gvc from 'gi://Gvc';

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

import {DEFAULTS} from './config.js';

const EFFECTS_SINK = 'easyeffects_sink';
const EFFECTS_PROGRAM = 'easyeffects';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const SAVE_DELAY_MS = 1000;
// An easyeffects program that has not answered by then is stopped.
const ASK_TIMEOUT_MS = 5000;

export class Outputs {
    /** settings: returns the "sound" section of the configuration, or null. */
    constructor(settings) {
        this._settings = settings;
        this._dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'kelpshell']);
        this.path = GLib.build_filenamev([this._dir, 'outputs.json']);
        this._map = new Map();
        this._saveId = 0;
    }

    enable() {
        this._key = null;      // the device that is the output
        this._owner = null;    // the device the loaded preset belongs to
        this._stream = null;
        this._asking = null;   // the cancellable of a question to EasyEffects
        this._read();
        // With PULSE_SERVER set the audio server is not this session's own,
        // and neither is the EasyEffects whose sink it shows: the program
        // run from here would not reach it and would start another. The
        // tests of dev/headless.sh run that way.
        this._program = GLib.getenv('PULSE_SERVER')
            ? null : GLib.find_program_in_path(EFFECTS_PROGRAM);

        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'state-changed', () => this._sync(),
            'default-sink-changed', () => this._sync(),
            // The sink of an EasyEffects that was started later.
            'stream-added', () => this._sync(),
            this);
        this._sync();
    }

    disable() {
        this._control?.disconnectObject(this);
        this._stream?.disconnectObject(this);
        this._control = this._stream = null;
        this._asking?.cancel();
        this._asking = null;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._write();
        }
    }

    get _values() {
        return this._settings() ?? DEFAULTS.sound;
    }

    /** The device a sink stands for, or null where it is none. */
    _keyOf(stream) {
        const name = stream?.get_name();
        if (!name || name === EFFECTS_SINK)
            return null;
        // get_port() logs a critical for a sink without ports.
        const port = stream.get_ports().length > 1 ? stream.get_port()?.port : null;
        return port ? `${name}:${port}` : name;
    }

    _sync() {
        const control = this._control;
        if (!control)
            return;
        const stream = control.get_state() === Gvc.MixerControlState.READY
            ? control.get_default_sink() : null;
        if (stream !== this._stream) {
            this._stream?.disconnectObject(this);
            this._stream = stream;
            // Headphones plugged into the machine are another port of the
            // same sink.
            stream?.connectObject('notify::port', () => this._sync(), this);
        }
        // No output for a moment, between a device that went away and the
        // one that follows it: the device before still counts.
        const key = this._keyOf(stream);
        if (!key)
            return;
        if (key !== this._key) {
            // The first device after a start is not a change.
            const changed = this._key !== null;
            this._key = key;
            if (changed && this._values.pauseOnOutputChange)
                this._pause();
        }
        this._match();
    }

    // ---- players ----

    _pause() {
        const bus = Gio.DBus.session;
        bus.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, null,
            (_bus, result) => {
                let names;
                try {
                    [names] = bus.call_finish(result).deepUnpack();
                } catch (e) {
                    console.warn(`kelpshell: output change, players: ${e.message}`);
                    return;
                }
                for (const name of names) {
                    if (!name.startsWith(MPRIS_PREFIX))
                        continue;
                    bus.call(
                        name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', 'Pause',
                        null, null, Gio.DBusCallFlags.NO_AUTO_START, 2000, null,
                        (_b, res) => {
                            // A player that cannot pause answers with an error.
                            try {
                                bus.call_finish(res);
                            } catch {
                            }
                        });
                }
            });
    }

    // ---- presets ----

    _effectsRunning() {
        return this._control.get_sinks().some(sink => sink.get_name() === EFFECTS_SINK);
    }

    /**
     * Bring the loaded preset and the device together, when the device is
     * not the one the loaded preset belongs to.
     */
    _match() {
        const key = this._key;
        if (this._asking || !key || key === this._owner || !this._program ||
            !this._values.presetPerOutput || !this._effectsRunning())
            return;
        this._ask(loaded => {
            // null: EasyEffects did not answer. The next change asks again.
            if (!this._control || loaded === null)
                return;
            if (loaded) {
                if (this._owner)
                    this._map.set(this._owner, loaded);
                if (!this._map.has(key))
                    this._map.set(key, loaded);
            }
            const preset = this._map.get(key);
            if (preset && preset !== loaded)
                this._load(preset);
            this._owner = key;
            this._save();
            // Another device became the output while EasyEffects was asked.
            if (this._key !== key)
                this._match();
        });
    }

    /** Call done with the name of the loaded output preset, '' for none, null on failure. */
    _ask(done) {
        const cancellable = this._asking = new Gio.Cancellable();
        let proc;
        const finish = answer => {
            if (this._asking !== cancellable)
                return;
            this._asking = null;
            GLib.source_remove(timeoutId);
            done(answer);
        };
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ASK_TIMEOUT_MS, () => {
            proc?.force_exit();
            cancellable.cancel();
            return GLib.SOURCE_CONTINUE;
        });
        try {
            proc = Gio.Subprocess.new(
                [this._program, '--last-loaded-preset', 'output'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`kelpshell: could not ask EasyEffects for its preset: ${e.message}`);
            finish(null);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (_proc, result) => {
            let answer = null;
            try {
                const [, out] = proc.communicate_utf8_finish(result);
                if (proc.get_successful())
                    answer = (out ?? '').trim();
            } catch {
                // Stopped after ASK_TIMEOUT_MS, or the extension was disabled.
            }
            finish(answer);
        });
    }

    _load(preset) {
        try {
            Gio.Subprocess.new(
                [this._program, '--load-preset', preset],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`kelpshell: could not load the preset "${preset}": ${e.message}`);
        }
    }

    // ---- the stored state ----

    _read() {
        this._map.clear();
        try {
            const [ok, bytes] = GLib.file_get_contents(this.path);
            if (!ok)
                return;
            const parsed = JSON.parse(new TextDecoder().decode(bytes)) ?? {};
            if (typeof parsed.last === 'string' && parsed.last)
                this._owner = parsed.last;
            for (const [key, value] of Object.entries(parsed.presets ?? {})) {
                if (typeof value === 'string' && value)
                    this._map.set(key, value);
            }
        } catch (e) {
            // No file yet is the usual case.
            if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
                console.warn(`kelpshell: ${this.path}: ${e.message}`);
        }
    }

    _save() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._write();
            return GLib.SOURCE_REMOVE;
        });
    }

    _write() {
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            const keys = [...this._map.keys()].sort();
            const text = JSON.stringify({
                last: this._owner,
                presets: Object.fromEntries(keys.map(k => [k, this._map.get(k)])),
            }, null, 2);
            GLib.file_set_contents(this.path, `${text}\n`);
        } catch (e) {
            console.warn(`kelpshell: could not write ${this.path}: ${e.message}`);
        }
    }
}
