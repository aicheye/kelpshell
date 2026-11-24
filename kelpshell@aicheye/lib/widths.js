// SPDX-License-Identifier: GPL-3.0-or-later

// Column widths per app, kept on disk.
//
// When a column's width is set by hand (cycle-width, width-increase and
// -decrease, maximize-column, a resize with the pointer), the width is stored
// under the app of the window that was acted on. The next window of that app
// opens at that width, in this session and after a logout.
//
// The file is $XDG_STATE_HOME/kelpshell/widths.json: an object that maps a
// window class to a share of the view between 0 and 1.

import GLib from 'gi://GLib';

const SAVE_DELAY_MS = 1000;

export class Widths {
    constructor(config) {
        this._config = config;
        this._dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'kelpshell']);
        this.path = GLib.build_filenamev([this._dir, 'widths.json']);
        this._map = new Map();
        this._saveId = 0;
    }

    enable() {
        this._map.clear();
        try {
            const [ok, bytes] = GLib.file_get_contents(this.path);
            if (ok) {
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                for (const [key, value] of Object.entries(parsed ?? {})) {
                    if (typeof value === 'number' && value > 0 && value <= 1)
                        this._map.set(key, value);
                }
            }
        } catch (e) {
            // No file yet is the usual case.
            if (!e.matches?.(GLib.FileError, GLib.FileError.NOENT))
                console.warn(`kelpshell: ${this.path}: ${e.message}`);
        }
    }

    disable() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._write();
        }
    }

    _key(win) {
        return (win.get_wm_class() ?? '').toLowerCase();
    }

    /** The stored share of the view for this window's app, or null. */
    get(win) {
        if (!this._config.values.layout.rememberWidths)
            return null;
        return this._map.get(this._key(win)) ?? null;
    }

    set(win, proportion) {
        const key = this._key(win);
        if (!key || !this._config.values.layout.rememberWidths)
            return;
        const value = Math.round(proportion * 1e5) / 1e5;
        if (this._map.get(key) === value)
            return;
        this._map.set(key, value);
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
            const text = JSON.stringify(
                Object.fromEntries(keys.map(k => [k, this._map.get(k)])), null, 2);
            GLib.file_set_contents(this.path, `${text}\n`);
        } catch (e) {
            console.warn(`kelpshell: could not write ${this.path}: ${e.message}`);
        }
    }
}
