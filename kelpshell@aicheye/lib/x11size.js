// SPDX-License-Identifier: GPL-3.0-or-later

// X11 windows after a change of the monitors.
//
// Xwayland has one scale for all its windows, the highest scale of a
// monitor. It changes when the only monitor with that scale comes or goes:
// the lid of a laptop at scale 2 that closes beside a monitor at scale 1.
// Mutter 51 then leaves a window that keeps its place on the screen at the
// pixel size of the old scale. A fullscreen video in VLC, which runs under
// Xwayland, shows a quarter of its picture after the lid has closed, or is
// drawn in a quarter of the monitor after the lid has opened.
//
// After every change of the monitors each X11 window is sent the rectangle
// Mutter has for it, through the native module (native/x11size.c, built by
// dev/build-native.sh), which has the measurements. Without the module
// nothing is done.
//
// It is sent twice: 1 px of the screen less high at once, and as it is
// SETTLE_MS later.
// Qt lays a window out again only for a size that differs from the one it
// expects, and the size after the change is the one it expects. Qt also
// drops a size when the next one is already waiting, so the two are sent
// apart.
//
// This runs for as long as the extension is enabled, in the session and on
// the lock screen: the lid can close while the screen is locked.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ms between the two sizes, see above.
const SETTLE_MS = 150;

// The module's object. lib/decorations.js loads the modules when the
// session part of the extension is first enabled, which is after enable()
// here, so it is looked for at each use until it is found.
let source = null;

function native() {
    if (source)
        return source;
    try {
        const type = GObject.type_from_name('KelpX11Size');
        if (type)
            source = GObject.Object.new(type);
    } catch (e) {
        console.warn(`kelpshell: X11 size module: ${e.message}`);
    }
    return source;
}

export class X11Size {
    enable() {
        this._laterId = 0;
        this._settleId = 0;
        Main.layoutManager.connectObject('monitors-changed', () => this._queue(), this);
    }

    disable() {
        Main.layoutManager.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
    }

    /**
     * Before the next frame, and not now: the tiling gives its windows
     * their places on the new monitors in another handler of this signal,
     * and Mutter sends a window whose place has changed its size itself.
     */
    _queue() {
        this._laterId ||= global.compositor.get_laters().add(
            Meta.LaterType.BEFORE_REDRAW, () => {
                this._laterId = 0;
                this._resync(1);
                if (this._settleId)
                    GLib.source_remove(this._settleId);
                this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
                    this._settleId = 0;
                    this._resync(0);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Send every X11 window its rectangle, trim px of the screen less high. */
    _resync(trim) {
        const module = native();
        if (!module)
            return;
        for (const win of global.display.list_all_windows()) {
            if (win.get_client_type() === Meta.WindowClientType.X11)
                module.emit('resync', win, trim);
        }
    }
}
