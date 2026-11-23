// When the display goes off on the lock screen.
//
// The shell (ui/screenShield.js) ends every lock the same way: the lock
// screen comes down, 300 ms later the screen fades to black in 300 ms, and
// then the shell reports the screen saver as active. gnome-settings-daemon
// turns the display off the moment it hears that (handle_screensaver_active
// in its power plugin, with no setting for it). A key pressed after a lock
// met the fade to black or a display that was switching off, and the lock
// screen came back at once (the user, 2026-11-22).
//
// Here a lock leaves the lock screen on the screen, and the fade to black
// and the report follow when nothing was pressed or moved for BLANK_AFTER
// seconds. From then on it is the shell's own course: a key takes the black
// away, and the power plugin turns the display off again after 30 seconds
// without input (its SCREENSAVER_TIMEOUT_BLANK).
//
// This is for the lock that comes down with an animation: the Lock button,
// Super+L, the Lock method on D-Bus. The others stay as the shell does
// them: the one before a suspend, where the shell delays the suspend until
// the screen saver is reported active, the one that ends the shell's 10
// second fade of an idle session, the one logind asks for (loginctl
// lock-session), and a screen saver without a lock (an account with no
// password), which the shell takes away again on the first input.
//
// Until the report, org.gnome.ScreenSaver says "not active" on D-Bus while
// the session is locked. The lock itself is reported to logind (LockedHint)
// at once, as before.
//
// This runs for as long as the extension is enabled, in the session and on
// the lock screen: the lock starts in the session.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Seconds without input on the lock screen before the display goes off.
const BLANK_AFTER = 15;
// The fade to black before it, in ms. Input during the fade ends it.
const FADE = 1000;

export class LockPower {
    enable() {
        const shield = Main.screenShield;
        if (typeof shield?._lockScreenShown !== 'function' ||
            typeof shield._activateFade !== 'function' ||
            typeof shield._setActive !== 'function' ||
            !shield._shortLightbox || !shield._longLightbox)
            return;
        this._shield = shield;
        this._monitor = global.backend.get_core_idle_monitor();
        this._sleeping = false;
        this._watch = 0;
        // The shell calls this._lockScreenShown() by name, so the one put on
        // the object is called in place of the class's.
        shield._lockScreenShown = params => this._shown(params);
        shield.connectObject(
            'active-changed', () => this._sync(),
            'locked-changed', () => this._sync(), this);
        shield._loginManager?.connectObject(
            'prepare-for-sleep', (_manager, about) => this._onSleep(about), this);
    }

    disable() {
        const shield = this._shield;
        if (!shield)
            return;
        this._shield = null;
        delete shield._lockScreenShown;
        shield.disconnectObject(this);
        shield._loginManager?.disconnectObject(this);
        this._disarm();
        // A lock that still waits here would never be reported.
        if (this._waits(shield))
            this._report(shield);
    }

    /** Locked, with the lock screen up, and not yet reported as active. */
    _waits(shield) {
        return shield._isLocked && !shield._isActive &&
            shield._lockScreenState === MessageTray.State.SHOWN;
    }

    /** What the shell does at the end of a lock without an animation. */
    _report(shield) {
        shield._activateFade(shield._shortLightbox, 0);
        shield._setActive(true);
    }

    /** In place of the shell's _lockScreenShown(). */
    _shown(params) {
        const shield = this._shield;
        const stock = Object.getPrototypeOf(shield)._lockScreenShown;
        let wait = false;
        try {
            // _isLocked: the shell sets it after this call in a lock
            // without an animation, and not at all without a password.
            wait = shield._isLocked && !this._sleeping && !shield._isGreeter &&
                !shield._isActive && !shield._longLightbox.active;
        } catch (e) {
            console.warn(`kelpshell: lock, display: ${e.message}`);
        }
        if (!wait) {
            stock.call(shield, params);
            return;
        }
        // The shell's own function without the fade, and with the report
        // taken out for the length of the call: the rest of it (the
        // pointer, the state, the signal) stays the shell's.
        shield._setActive = () => {};
        try {
            stock.call(shield, {fadeToBlack: false, animateFade: false});
        } finally {
            delete shield._setActive;
        }
        this._arm();
    }

    _arm() {
        if (this._watch)
            return;
        // Called each time the time without input passes BLANK_AFTER, and at
        // once when it already has.
        this._watch = this._monitor.add_idle_watch(BLANK_AFTER * 1000, () => this._blank());
    }

    _disarm() {
        if (this._watch)
            this._monitor.remove_watch(this._watch);
        this._watch = 0;
    }

    _blank() {
        const shield = this._shield;
        // Not during an unlock: a fingerprint is not input, so the time
        // without input can run out while the lock screen moves away.
        if (!shield || !this._waits(shield) || shield._shortLightbox.visible)
            return;
        // At its end the shell reports the screen saver as active. Input
        // before that takes the black away, and this is called again after
        // the next BLANK_AFTER seconds without input.
        shield._activateFade(shield._shortLightbox, FADE);
    }

    _sync() {
        const shield = this._shield;
        if (shield && (!shield._isLocked || shield._isActive))
            this._disarm();
    }

    /**
     * The shell holds the suspend back until the screen saver is reported
     * active. Its own handler of this signal runs first and locks; a lock
     * screen that was already up and waiting here is reported now.
     */
    _onSleep(about) {
        this._sleeping = about;
        const shield = this._shield;
        if (about && shield && this._waits(shield)) {
            this._disarm();
            this._report(shield);
        }
    }
}
