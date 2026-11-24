// SPDX-License-Identifier: GPL-3.0-or-later

// Server-side decorations for the windows named in windows.crop.
//
// A Wayland client asks the compositor for a title bar with the
// xdg-decoration protocol, which Mutter does not have. The native module
// (native/decorations.c, built by dev/build-native.sh) adds it to the shell
// for the clients a rule names. Such a client is told that the compositor
// draws its title bar, so it draws no frame of its own, and nothing has to
// be cut from its window: the rule then only says whether the extension
// draws the title bar (titlebar.js).
//
// Without the module, or for a window that was open before the module was
// loaded, the rule cuts the frame the client draws (crop.js).
//
// The two sides share two files in $XDG_RUNTIME_DIR/kelpshell: `decorate`,
// written here, with one rule per line, and `decorated`, written by the
// module, with the process id of every client it serves.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as ShellConfig from 'resource:///org/gnome/shell/misc/config.js';

// The module stays in the shell once loaded, so these outlive this part of
// the extension being disabled and enabled, as it is on every lock of the
// screen.
let loaded = false;
// The windows that were open when the module was loaded, by id. Their
// clients had drawn their frames already.
let before = new Set();

export class Decorations {
    /**
     * @param {Config} config
     * @param {string} path - the directory of the extension
     */
    constructor(config, path) {
        this._config = config;
        this._path = path;
        this._pids = new Set();
        this._listeners = [];
    }

    enable() {
        this._dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'kelpshell']);
        GLib.mkdir_with_parents(this._dir, 0o700);
        // The rules are written first: the module reads them as soon as a
        // client connects.
        this.apply();
        this._load();
        this._file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'decorated']));
        this._monitor = this._file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', () => {
            if (this._read())
                this._listeners.forEach(fn => fn());
        });
        this._read();
    }

    disable() {
        this._monitor?.cancel();
        this._monitor = null;
        // No rules: the module serves no new client.
        GLib.unlink(GLib.build_filenamev([this._dir, 'decorate']));
        this._pids.clear();
        this._listeners = [];
    }

    /** Called when the set of served clients has changed. */
    onChanged(fn) {
        this._listeners.push(fn);
    }

    /** Write the rules for the module, after a change of configuration. */
    apply() {
        const rules = this._config.values.windows.crop;
        const names = (Array.isArray(rules) ? rules : [])
            .map(r => typeof r?.match === 'string' ? r.match.trim().toLowerCase() : '')
            .filter(name => name && !name.includes('\n'));
        try {
            GLib.file_set_contents(
                GLib.build_filenamev([this._dir, 'decorate']), `${names.join('\n')}\n`);
        } catch (e) {
            console.warn(`kelpshell: cannot write the decoration rules: ${e.message}`);
        }
    }

    /**
     * Whether the client of this window was told that the compositor draws
     * its decorations, so the window has no frame of the client's.
     */
    serves(win) {
        return this._pids.has(win.get_pid()) && !before.has(win.get_id());
    }

    _load() {
        if (loaded)
            return;
        const [major] = ShellConfig.PACKAGE_VERSION.split('.');
        const dir = GLib.build_filenamev([this._path, 'native', major]);
        if (!GLib.file_test(GLib.build_filenamev([dir, 'libkelp-decorations.so']),
            GLib.FileTest.EXISTS))
            return;
        before = new Set(global.display.list_all_windows().map(w => w.get_id()));
        Gio.io_modules_load_all_in_directory(dir);
        loaded = true;
    }

    /** Read the served pids. True when they have changed. */
    _read() {
        let text = '';
        try {
            const [, bytes] = this._file.load_contents(null);
            text = new TextDecoder().decode(bytes);
        } catch {
            // No file: the module is not loaded.
        }
        const pids = new Set(text.split('\n').map(Number).filter(pid => pid > 0));
        const same = pids.size === this._pids.size && [...pids].every(pid => this._pids.has(pid));
        this._pids = pids;
        return !same;
    }
}
