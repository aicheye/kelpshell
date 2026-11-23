// Keybindings from the config file.
//
// Mutter refuses to grab an accelerator that a GNOME setting already uses, so
// conflicting combos are removed from those settings while the extension is
// enabled and put back on disable. The originals are also written to
// ~/.local/state/kelpshell/keybindings.json, so a crash cannot lose them: the
// next enable restores from that file first.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SCHEMAS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
    // The emoji typing of IBus is on Super+period and Super+semicolon. IBus
    // is given the keys of a window with a text field before Mutter looks
    // at its own shortcuts, so a combo left here never reaches the
    // extension while a text field has the focus (seen 2026-11-22 with
    // Super+period for the picker: the accelerator was held and never ran).
    'org.freedesktop.ibus.panel.emoji',
];

const MOD_ALIASES = {
    primary: 'ctrl', control: 'ctrl', ctrl: 'ctrl',
    super: 'super', mod4: 'super',
    alt: 'alt', mod1: 'alt',
    shift: 'shift', meta: 'meta', hyper: 'hyper',
};

/** '<Super><Control>Left' and '<Primary><Super>left' both give 'ctrl+super+left'. */
export function normalizeAccel(accel) {
    const mods = [];
    const key = String(accel).replace(/<([^>]+)>/g, (_m, mod) => {
        const m = mod.toLowerCase();
        mods.push(MOD_ALIASES[m] ?? m);
        return '';
    }).trim().toLowerCase();
    if (!key)
        return '';
    return [...new Set(mods)].sort().concat(key).join('+');
}

export class Keybindings {
    /**
     * @param {Config} config
     * @param {object} actions - name -> {run, modes?, repeat?}
     */
    constructor(config, actions) {
        this._config = config;
        this._actions = actions;
        this._grabs = new Map();     // mutter action id -> {name, run}
        this._timeouts = new Set();
        this._backupPath = GLib.build_filenamev(
            [GLib.get_user_state_dir(), 'kelpshell', 'keybindings.json']);
        this.failed = [];
    }

    enable() {
        this._restoreOverrides();
        this._overrideConflicts();
        global.display.connectObject('accelerator-activated',
            (_d, action) => this._grabs.get(action)?.run(), this);
        // Mutter applies the settings changes from an idle; grab after it,
        // then retry what failed (gnome-settings-daemon releases its grabs
        // asynchronously).
        this._later(80, () => this._grabAll());
        this._later(600, () => this._grabAll());
        this._later(2500, () => {
            this._grabAll();
            if (this.failed.length) {
                Main.notify('Kelpshell',
                    `Shortcuts held by another extension or setting: ${this.failed.join(', ')}`);
            }
        });
    }

    disable() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        global.display.disconnectObject(this);
        for (const [action, grab] of this._grabs) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(grab.name, Shell.ActionMode.NONE);
        }
        this._grabs.clear();
        this._restoreOverrides();
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _wanted() {
        const wanted = [];
        const bindings = this._config.values.keybindings;
        for (const [name, accels] of Object.entries(bindings)) {
            if (!this._actions[name] || !Array.isArray(accels))
                continue;
            for (const accel of accels) {
                if (typeof accel === 'string' && normalizeAccel(accel))
                    wanted.push({name, accel});
            }
        }
        return wanted;
    }

    _grabAll() {
        const held = new Set([...this._grabs.values()].map(g => g.accel));
        this.failed = [];
        for (const {name, accel} of this._wanted()) {
            if (held.has(accel))
                continue;
            const spec = this._actions[name];
            const flags = spec.repeat
                ? Meta.KeyBindingFlags.NONE : Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
            const action = global.display.grab_accelerator(accel, flags);
            if (action === Meta.KeyBindingAction.NONE) {
                this.failed.push(accel);
                continue;
            }
            const bindingName = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(bindingName, spec.modes ?? Shell.ActionMode.NORMAL);
            this._grabs.set(action, {name: bindingName, accel, run: spec.run});
            held.add(accel);
        }
    }

    _overrideConflicts() {
        const ours = new Set(this._wanted().map(w => normalizeAccel(w.accel)));
        const source = Gio.SettingsSchemaSource.get_default();
        const backup = {};
        const changes = [];
        for (const id of SCHEMAS) {
            const schema = source.lookup(id, true);
            if (!schema)
                continue;
            const settings = new Gio.Settings({settings_schema: schema});
            for (const key of schema.list_keys()) {
                if (schema.get_key(key).get_value_type().dup_string() !== 'as')
                    continue;
                const current = settings.get_strv(key);
                const kept = current.filter(a => !ours.has(normalizeAccel(a)));
                if (kept.length === current.length)
                    continue;
                backup[id] ??= {};
                backup[id][key] = {
                    value: current,
                    user: settings.get_user_value(key) !== null,
                };
                changes.push(() => settings.set_strv(key, kept));
            }
        }
        if (changes.length === 0)
            return;
        // Write the backup before touching anything.
        GLib.mkdir_with_parents(GLib.path_get_dirname(this._backupPath), 0o755);
        GLib.file_set_contents(this._backupPath, JSON.stringify(backup, null, 2));
        for (const change of changes)
            change();
        Gio.Settings.sync();
    }

    _restoreOverrides() {
        let backup;
        try {
            const [ok, bytes] = GLib.file_get_contents(this._backupPath);
            if (!ok)
                return;
            backup = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return;
        }
        const source = Gio.SettingsSchemaSource.get_default();
        for (const [id, keys] of Object.entries(backup)) {
            const schema = source.lookup(id, true);
            if (!schema)
                continue;
            const settings = new Gio.Settings({settings_schema: schema});
            for (const [key, saved] of Object.entries(keys)) {
                if (!schema.has_key(key))
                    continue;
                if (saved.user)
                    settings.set_strv(key, saved.value);
                else
                    settings.reset(key);
            }
        }
        Gio.Settings.sync();
        GLib.unlink(this._backupPath);
    }
}
