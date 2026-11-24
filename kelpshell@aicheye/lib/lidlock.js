// SPDX-License-Identifier: GPL-3.0-or-later

// A lock when the lid closes.
//
// Stock GNOME locks at a lid close only through the suspend: logind
// suspends, and the shell locks before that (_prepareForSleep in
// ui/screenShield.js). A lid close is followed by no suspend
//
// - for 30 seconds after a resume (logind's HoldoffTimeoutSec),
// - for 8 seconds after a change of the monitors (the power plugin of
//   gnome-settings-daemon holds a handle-lid-switch inhibitor for its
//   LID_CLOSE_SAFETY_TIMEOUT), which includes unplugging a dock.
//
// logind suspends at the end of that time when the lid is still closed. A
// lid opened again before the end left the session open (the user,
// 2026-11-23: six closes within a minute of unplugging the dock, one of
// them locked).
//
// Here the lid itself locks, without an animation, as the shell does before
// a suspend. The screen saver is then reported active at once and the power
// plugin turns the display off. logind's suspend is not changed: when it
// follows, the shell's lock before it finds the screen locked.
//
// Not with another display in use: Mutter turns the laptop's panel off
// then and the session goes on there, and logind ignores the lid as well
// (HandleLidSwitchDocked=ignore).
//
// Like the lock before a suspend, this follows Settings > Privacy >
// Screen Lock > Automatic Screen Lock (org.gnome.desktop.screensaver
// lock-enabled).

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class LidLock {
    /** wanted: returns false when the config turns this off. */
    constructor(wanted) {
        this._wanted = wanted;
    }

    enable() {
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.screensaver'});
        // Mutter emits this when UPower's LidIsClosed changes. Its monitor
        // manager connected first, so the panel is already off here when
        // another display takes over.
        global.backend.connectObject(
            'lid-is-closed-changed', (_backend, closed) => this._onLid(closed), this);
    }

    disable() {
        global.backend.disconnectObject(this);
        this._settings = null;
    }

    /** The laptop's panel is still in use, so no other display is. */
    _panelOn() {
        return global.backend.get_monitor_manager().get_is_builtin_display_on();
    }

    _onLid(closed) {
        if (!closed)
            return;
        try {
            const shield = Main.screenShield;
            if (!shield || shield.locked || this._wanted() === false ||
                !this._settings.get_boolean('lock-enabled') || !this._panelOn())
                return;
            shield.lock(false);
        } catch (e) {
            console.warn(`kelpshell: lock at lid close: ${e.message}`);
        }
    }
}
