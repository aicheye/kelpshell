// SPDX-License-Identifier: GPL-3.0-or-later

// The apps that run without a window, as the desktop portal reports them:
// the list the shell shows as "Background Apps" in quick settings. The
// portal knows the sandboxed apps only (Flatpak and Snap).

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

const BUS_NAME = 'org.freedesktop.background.Monitor';
const OBJECT_PATH = '/org/freedesktop/background/monitor';

/** What tells one list from another. */
function keyOf(apps) {
    return JSON.stringify(apps.map(a => [a.id, a.name, a.message]));
}

export class BackgroundApps {
    /**
     * apps: the list of an earlier one (the apps property), which this one
     * has from the start. The portal answers some frames after this is
     * made, and after a lock of the screen the list is to be there in the
     * first frame.
     */
    constructor(apps = null) {
        this._listeners = [];
        this._proxy = null;
        // {id, app, name, message}, by name.
        this.apps = apps ?? [];
        this._key = keyOf(this.apps);
        // The portal has answered once, or the list was given: a change
        // from now on is one the user sees happen.
        this._settled = !!apps;
        this._cancellable = new Gio.Cancellable();
        // The portal owns the name while it runs. It is not started for
        // this.
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            BUS_NAME, OBJECT_PATH, BUS_NAME, this._cancellable, (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch {
                    return;
                }
                this._proxy.connectObject(
                    'g-properties-changed', () => this._sync(),
                    'notify::g-name-owner', () => this._sync(), this);
                this._sync();
            });
        // An app that was installed since is found now.
        Shell.AppSystem.get_default().connectObject(
            'installed-changed', () => this._sync(), this);
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        this._proxy = null;
        this._listeners = [];
    }

    /**
     * fn(seen) is called when the list has changed. seen: the list before
     * was shown as the list, so the change can be animated. false for the
     * portal's first answer.
     */
    onChanged(fn) {
        this._listeners.push(fn);
    }

    _sync() {
        const reported =
            this._proxy?.get_cached_property('BackgroundApps')?.recursiveUnpack() ?? [];
        const system = Shell.AppSystem.get_default();
        // One entry for an app, also when several instances of it run. An
        // app with no desktop file has no name and no icon to show.
        const byId = new Map();
        for (const entry of reported) {
            const id = entry.app_id;
            if (typeof id !== 'string')
                continue;
            let item = byId.get(id);
            if (!item) {
                const app = system.lookup_app(`${id}.desktop`);
                if (!app)
                    continue;
                item = {id, app, name: app.get_name(), message: ''};
                byId.set(id, item);
            }
            if (typeof entry.message === 'string' && entry.message)
                item.message = entry.message;
        }
        const apps = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
        const key = keyOf(apps);
        const seen = this._settled;
        this._settled = true;
        if (key === this._key)
            return;
        this._key = key;
        this.apps = apps;
        for (const fn of this._listeners)
            fn(seen);
    }

    /**
     * Ask an app to quit, as the shell's own list does: through its "quit"
     * action, and with `flatpak kill` when it has none.
     */
    quit(id) {
        const app = this.apps.find(a => a.id === id)?.app;
        if (!app)
            return;
        app.activate_action('quit', null, 0, -1, null, (_app, result) => {
            try {
                app.activate_action_finish(result);
            } catch {
                this._kill(id);
            }
        });
    }

    _kill(id) {
        try {
            Gio.Subprocess.new(
                ['flatpak', 'kill', id],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`kelpshell: could not stop ${id}: ${e.message}`);
        }
    }
}
