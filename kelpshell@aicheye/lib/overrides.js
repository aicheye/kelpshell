// SPDX-License-Identifier: GPL-3.0-or-later

// GNOME settings that are changed while the extension is enabled.
//
// The original value of each key is written to
// ~/.local/state/kelpshell/settings.json before the key is changed. disable()
// puts the values back, and so does the next enable(), so a shell crash
// cannot leave the settings changed.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class Overrides {
    constructor() {
        this._path = GLib.build_filenamev(
            [GLib.get_user_state_dir(), 'kelpshell', 'settings.json']);
    }

    /** list: [{schema, key, value}], value a GLib.Variant of the key's type. */
    apply(list) {
        this.restore();
        const source = Gio.SettingsSchemaSource.get_default();
        const backup = [];
        const changes = [];
        for (const {schema, key, value} of list) {
            const found = source.lookup(schema, true);
            if (!found?.has_key(key))
                continue;
            const settings = new Gio.Settings({settings_schema: found});
            if (settings.get_value(key).equal(value))
                continue;
            const user = settings.get_user_value(key);
            backup.push({schema, key, value: user ? user.print(true) : null});
            changes.push(() => settings.set_value(key, value));
        }
        if (changes.length === 0)
            return;
        // Write the backup before touching anything. A setting that cannot
        // be put back later is left as it is.
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o755);
            GLib.file_set_contents(this._path, JSON.stringify(backup, null, 2));
        } catch (e) {
            console.warn(`kelpshell: settings left unchanged, no backup at ${this._path}: ${e.message}`);
            return;
        }
        for (const change of changes)
            change();
        Gio.Settings.sync();
    }

    restore() {
        let backup;
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path);
            if (!ok)
                return;
            backup = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return;
        }
        const source = Gio.SettingsSchemaSource.get_default();
        for (const entry of Array.isArray(backup) ? backup : []) {
            const {schema, key, value} = entry ?? {};
            if (typeof schema !== 'string' || typeof key !== 'string')
                continue;
            const found = source.lookup(schema, true);
            if (!found?.has_key(key))
                continue;
            const settings = new Gio.Settings({settings_schema: found});
            try {
                if (value === null)
                    settings.reset(key);
                else
                    settings.set_value(key, GLib.Variant.parse(null, value, null, null));
            } catch (e) {
                console.warn(`kelpshell: cannot restore ${schema} ${key}: ${e.message}`);
            }
        }
        Gio.Settings.sync();
        GLib.unlink(this._path);
    }
}
