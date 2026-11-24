// SPDX-License-Identifier: GPL-3.0-or-later

// The lock screen in the look of the cards.
//
// The shell builds its lock screen (ui/unlockDialog.js) each time the screen
// is locked, which is also what a suspend shows on waking: the wallpaper,
// blurred, a page with the clock, and a page with the password prompt. The
// prompt is made when its page is asked for and destroyed when the clock is
// back. Notifications are listed at the bottom.
//
// The dialog stays the shell's own. This file adds to it:
//   - the style class .kelp-lock, which the rules of the stylesheet's "lock
//     screen" part are written under,
//   - a picture of the wallpaper over the shell's, blurred and mixed toward
//     theme.tint, the colour of the cards,
//   - the clock in the form of the sidebar's: AM or PM small beside the
//     digits, and the date with a comma,
//   - the card material under each notification,
//   - a cursor that blinks in the entry, and beside the entry the icon of
//     the fingerprint reader while it waits,
//   - no wait for a message that is not drawn or no longer true.
//
// Nothing of the shell's is moved or put anywhere else. The prompt is found
// when the shell adds it to its box with add_child(), which is replaced on
// that one box by a function that adds it the same way and then styles it.
//
// Every step is tried on its own. One that throws is reported and left out:
// a lock screen that looks wrong can be unlocked, one without a prompt
// cannot.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {MessageType} from 'resource:///org/gnome/shell/gdm/userVerifier.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Backdrop} from './backdrop.js';
import {CaretBlink} from './caret.js';

// The shell draws its own blurred wallpaper at this share of its brightness.
// It shows until the picture made here is ready, under a scrim of theme.tint
// that brings it to what the picture will have, as far as a scrim can: it
// cannot make the shell's wallpaper brighter.
const SHELL_BRIGHTNESS = 0.65;
// The picture of the wallpaper drawn here is mixed toward theme.tint by
// theme.lockTint. This is the value used when the config has none that is a
// number. At 0.58, which is what the two steps above give together
// (1 - 0.65 * 0.64), the picture has 42% of the wallpaper's brightness and
// looks duller than the wallpaper.
const WALL_TINT = 0.3;
// Its blur in passes (theme.blur goes from 0 to 6).
const WALL_BLUR = 5;
// AM or PM, in percent of the size of the digits: 12px beside 31px in the
// sidebar.
const AMPM_PERCENT = 39;

function parseTint(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    return m ? parseInt(m[1], 16) : 0x16181d;
}

/**
 * The config as the picture of the lock screen's wallpaper reads it: the
 * material with its own strength and blur, opaque, and dark in both styles.
 */
function wallTint(config) {
    const tint = Number(config.values.theme.lockTint);
    return Number.isFinite(tint) ? Math.max(0, Math.min(1, tint)) : WALL_TINT;
}

function wallConfig(config) {
    return {
        get values() {
            const values = config.values;
            return {
                ...values,
                theme: {
                    ...values.theme,
                    tintLight: values.theme.tint,
                    tintStrength: wallTint(config),
                    opacity: 1,
                    blur: WALL_BLUR,
                },
            };
        },
    };
}

/**
 * Ask for the type of the fingerprint reader, at login.
 *
 * The shell asks for it when the first prompt after a login is made, and
 * keeps the answer for the session (gdm/fingerprintManager.js). The answer
 * then comes about 0.35 s after that prompt is on the screen, and the shell
 * starts the prompt again, twice: the entry is shown at 0.13 s, hidden at
 * 0.49 s and fades in again from 0.67 s. Later prompts know the type before
 * they are shown and do not start again.
 *
 * Making the shell's object here makes it ask now, so the first prompt is
 * like the later ones.
 */
export function findFingerprintReader() {
    import('resource:///org/gnome/shell/gdm/fingerprintManager.js')
        .then(m => m.getFingerprintManager())
        .catch(e => console.warn(`kelpshell: lock screen, fingerprint reader: ${e.message}`));
}

/**
 * The picture of the lock screen's wallpaper, made in the session, before
 * the first lock that needs it.
 *
 * The picture is a file in the cache, named after the wallpaper and the
 * values it is made from. A lock that does not find it reads and blurs the
 * wallpaper while the lock screen comes down. In the headless shell, with a
 * 6016 x 3900 wallpaper and two monitors, the shell then draws no frame for
 * 0.8 to 1.2 s, and the next frame has the lock screen down: the 250 ms of
 * the shell's animation are over (measured). With the file in the cache the
 * first frame of the animation is 11 to 17% of the way, as on every later
 * lock.
 *
 * This is the same object the lock screen makes its picture with, kept for
 * the length of the session. It makes the file after a login, and again when
 * the wallpaper, the colour scheme or the monitors change, which it watches
 * itself, and when the config changes, which refresh() is called for.
 */
export class LockPicture {
    constructor(config) {
        this._wall = new Backdrop(wallConfig(config), {live: false});
    }

    enable() {
        this._wall.enable();
    }

    refresh() {
        this._wall.refreshSoon(50);
    }

    disable() {
        this._wall.disable();
    }
}

export class LockScreen {
    constructor(config, backdrop) {
        this._config = config;
        this._backdrop = backdrop;
        this._dialog = null;
        this._writing = false;
        this._wall = null;
        this._blinks = new Set();
        // prompt -> what gives it back as the shell made it, see disable().
        this._promptUndo = new Map();
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    }

    enable() {
        const dialog = Main.screenShield?._dialog;
        if (!dialog)
            return;
        this._dialog = dialog;
        dialog.connectObject('destroy', () => (this._dialog = null), this);
        dialog.add_style_class_name('kelp-lock');
        for (const [name, step] of [
            ['wallpaper', () => this._addScrim()],
            ['clock', () => this._styleClock()],
            ['prompt', () => this._hookPrompt()],
            ['keys', () => this._hookKeys()],
            ['notifications', () => this._hookNotifications()],
        ]) {
            try {
                step();
            } catch (e) {
                console.warn(`kelpshell: lock screen, ${name}: ${e.message}`);
            }
        }
    }

    /**
     * strip: take the look off the dialog. Without it the dialog keeps what
     * it has: on an unlock it is still on the screen while it moves away.
     */
    disable(strip) {
        const dialog = this._dialog;
        this._dialog = null;
        if (!dialog)
            return;
        dialog.disconnectObject(this);
        for (const actor of [this._time, this._date, this._list, this._methods])
            actor?.disconnectObject(this);
        for (const blink of this._blinks)
            blink.destroy();
        this._blinks.clear();
        // The pictures stay as they are drawn.
        this._wall?.disable();
        this._wall = null;
        if (strip) {
            dialog.remove_style_class_name('kelp-lock');
            this._scrim?.destroy();
            this._wallBox?.destroy();
            if (this._promptBox)
                delete this._promptBox.add_child;
            // A prompt that is shown now stays, without what was done to it.
            for (const undo of this._promptUndo.values()) {
                for (const step of undo.reverse()) {
                    try {
                        step();
                    } catch (e) {
                        console.warn(`kelpshell: lock screen, prompt: ${e.message}`);
                    }
                }
            }
            delete dialog._onKeyPress;
            // Setting the text again drops the markup.
            for (const label of [this._time, this._date])
                label?.clutter_text.set_text(label.text);
        }
        this._promptUndo.clear();
        this._scrim = this._wallBox = this._promptBox = null;
        this._time = this._date = this._list = this._methods = this._methodIcon = null;
    }

    /** After a change of the config. */
    restyle() {
        if (this._scrim)
            this._scrim.style = this._scrimStyle();
        this._wall?.refresh();
    }

    // ---- wallpaper ----
    //
    // The shell draws the wallpaper under its own blur. That wallpaper has
    // been seen black after Space, Escape, Space: the screen was the scrim
    // over black, rgb(8, 9, 11). It does not happen in the headless shell,
    // with one monitor or two, a stand-in for the login service or the real
    // one, so the cause is not known. The lock screen has a wallpaper of
    // its own over the shell's: the picture lib/backdrop.js makes for the
    // material, with the values above, one per monitor. It does not depend
    // on the shell's wallpaper actors.
    //
    // The scrim stays under it. It is what shows until the picture is made
    // (the first lock after a change of wallpaper decodes the file), and
    // when no picture can be made.

    /** The dark tint in both styles: the clock on it is always light. */
    _scrimStyle() {
        const t = parseTint(this._config.values.theme.tint);
        const alpha = Math.max(0, 1 - (1 - wallTint(this._config)) / SHELL_BRIGHTNESS);
        return `background-color: rgba(${t >> 16}, ${(t >> 8) & 255}, ${t & 255}, ${alpha.toFixed(3)});`;
    }

    _addScrim() {
        const dialog = this._dialog;
        const under = dialog._backgroundGroup;
        if (!under || under.get_parent() !== dialog)
            return;
        this._scrim = new St.Widget({reactive: false, style: this._scrimStyle()});
        // The dialog is as large as its wallpapers together, one per monitor.
        this._scrim.add_constraint(new Clutter.BindConstraint({
            source: dialog, coordinate: Clutter.BindCoordinate.SIZE,
        }));
        dialog.insert_child_above(this._scrim, under);

        this._wallBox = new Clutter.Actor({reactive: false, visible: false});
        dialog.insert_child_above(this._wallBox, this._scrim);
        this._wall = new Backdrop(wallConfig(this._config), {live: false});
        this._wall.enable();
        this._wall.onChanged(() => this._buildWall());
        // A picture from an earlier lock is found at once.
        this._wall.refresh();
    }

    /** One picture per monitor, in the dialog's coordinates, which are the stage's. */
    _buildWall() {
        const box = this._wallBox;
        if (!box || !this._wall)
            return;
        // A monitor whose picture is not made yet shows the scrim: after a
        // change of the monitors the pictures come one by one.
        const monitors = Main.layoutManager.monitors.filter(m => this._wall.hasPictureOn(m));
        const key = JSON.stringify(monitors.map(m => [m.x, m.y, m.width, m.height]));
        if (key === this._wallKey)
            return;
        this._wallKey = key;
        box.destroy_all_children();
        box.visible = monitors.length > 0;
        for (const m of monitors) {
            // Clipped: St lets a background image run past a node that has
            // no border and no colour.
            const picture = new St.Widget({
                reactive: false, clip_to_allocation: true,
                x: m.x, y: m.y, width: m.width, height: m.height,
            });
            box.add_child(picture);
            this._wall.attach(picture);
        }
    }

    // ---- clock ----

    _styleClock() {
        const clock = this._dialog._clock;
        this._time = clock?._time ?? null;
        this._date = clock?._date ?? null;
        // The shell writes both again every minute.
        this._time?.connectObject('notify::text', () => this._markTime(), this);
        this._date?.connectObject('notify::text', () => this._writeDate(), this);
        this._markTime();
        this._writeDate();
    }

    /**
     * "5:31 AM": what is not between the first and the last digit is drawn
     * small and in the secondary colour. A 24 hour clock has no such part.
     */
    _markTime() {
        const label = this._time;
        if (!label || this._writing)
            return;
        const m = /^(\D*)(\d.*\d)(\D*)$/.exec(label.text ?? '');
        if (!m || !(m[1] || m[3]))
            return;
        const esc = text => GLib.markup_escape_text(text, -1);
        const small = text => text
            ? `<span size="${AMPM_PERCENT}%" alpha="78%">${esc(text)}</span>` : '';
        this._write(() => label.clutter_text.set_markup(small(m[1]) + esc(m[2]) + small(m[3])));
    }

    /** The shell's date is "Sunday November 22". The sidebar's has a comma. */
    _writeDate() {
        const label = this._date;
        if (!label || this._writing)
            return;
        const text = GLib.DateTime.new_now_local().format('%A, %B %-e');
        if (text)
            this._write(() => (label.text = text));
    }

    /** Writing a label notifies its text, which is what called here. */
    _write(fn) {
        this._writing = true;
        try {
            fn();
        } finally {
            this._writing = false;
        }
    }

    // ---- prompt ----
    //
    // The picture, the name, the entry and the messages are on the
    // wallpaper, as the clock is: there is no card under them, and the
    // entry does not have the card material. The entry has a fill of a
    // quarter black, which the stylesheet gives it, and every text has a
    // shadow: the wallpaper keeps most of its brightness.

    _hookPrompt() {
        const box = this._dialog._promptBox;
        if (!box)
            return;
        this._promptBox = box;
        // The ways to unlock that need no typing (a fingerprint reader, a
        // smart card). The shell lists them as icons with a text in the
        // bottom left corner of the monitor, and fills and empties that
        // list as the login service reports them.
        this._methods = this._dialog._authIndicatorButton?._iconsBox ?? null;
        this._methods?.connectObject(
            'child-added', () => this._syncMethod(),
            'child-removed', () => this._syncMethod(), this);
        const prompt = this._dialog._authPrompt;
        if (prompt?.get_parent() === box)
            this._stylePrompt(prompt);

        // The shell adds one thing to this box, the prompt, each time the
        // prompt page is shown. It is added as the shell does it, and then
        // styled.
        box.add_child = actor => {
            Clutter.Actor.prototype.add_child.call(box, actor);
            this._stylePrompt(actor);
        };
    }

    _stylePrompt(prompt) {
        const undo = [];
        this._promptUndo.set(prompt, undo);
        prompt.connect('destroy', () => this._promptUndo.delete(prompt));
        try {
            this._fitPrompt(prompt, undo);
            // Not after the unlock. The prompt has two entries, for text
            // that is shown and for text that is not, and puts one of them
            // in its row.
            if (this._dialog) {
                for (const entry of [prompt._textEntry, prompt._passwordEntry]) {
                    if (!entry)
                        continue;
                    // The cursor of a GTK field: one pixel wide, blinking.
                    const size = entry.clutter_text.cursor_size;
                    entry.clutter_text.cursor_size = 1;
                    undo.push(() => (entry.clutter_text.cursor_size = size));
                    const blink = new CaretBlink(entry, this._interface);
                    this._blinks.add(blink);
                    entry.connect('destroy', () => this._blinks.delete(blink));
                }
                this._addMethodIcon(prompt, undo);
                this._hookMessages(prompt, undo);
            }
        } catch (e) {
            console.warn(`kelpshell: lock screen, prompt: ${e.message}`);
        }
    }

    /**
     * The icon of the first way to unlock without typing, to the right of
     * the entry. The shell's own list, in the corner of the monitor, is
     * too far from the entry to be seen: it is not drawn (see the
     * stylesheet), and this icon follows it.
     *
     * The icon is in the empty actor the shell puts after the entry, which
     * it keeps as wide as the back button on the other side, 30px, so that
     * the entry stays in the middle. That actor gets a layout that places
     * the icon in it.
     */
    _addMethodIcon(prompt, undo) {
        const slot = prompt._mainBox?.get_last_child();
        if (!slot || slot instanceof St.Widget || slot.get_n_children() > 0)
            return;
        const icon = new St.Icon({
            style_class: 'kelp-lock-method',
            visible: false,
            x_expand: true, y_expand: true,
            // At the far side of the 30px: 8px from the entry.
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER,
        });
        const layout = slot.layout_manager;
        slot.layout_manager = new Clutter.BinLayout();
        slot.add_child(icon);
        undo.push(() => {
            icon.destroy();
            slot.layout_manager = layout;
        });
        this._methodIcon = icon;
        icon.connect('destroy', () => {
            if (this._methodIcon === icon)
                this._methodIcon = null;
        });
        this._syncMethod();
    }

    _syncMethod() {
        const icon = this._methodIcon;
        if (!icon)
            return;
        const first = this._methods?.get_children().find(child => child.icon_name);
        if (first)
            icon.icon_name = first.icon_name;
        icon.visible = !!first;
    }

    /**
     * The shell (gdm/userVerifier.js) puts the messages of the login
     * service in a queue, gives each at least two seconds on the screen,
     * and waits for the end of the queue before it sends a password and
     * before it unlocks. Two of them make the lock screen wait for nothing:
     *
     *   - "(or place finger on reader)", a hint, queued each time the
     *     reader starts to wait. The stylesheet does not draw it. With it
     *     in the queue, a finger put on the reader in the two seconds after
     *     the prompt came up fades the entry out and leaves the lock screen
     *     standing until the two seconds are over. Hints are not queued
     *     here.
     *   - "Failed to match fingerprint", then a match a moment later: the
     *     entry fades out and the warning stays for the rest of its two
     *     seconds. When the login service reports success, the queue is
     *     emptied, which takes the message off and lets the unlock run. A
     *     queue with a text of the login service that is not an error (a
     *     password about to expire) is left: the shell waits so that it
     *     can be read.
     */
    _hookMessages(prompt, undo) {
        const verifier = prompt._userVerifier;
        if (typeof verifier?._queueMessage !== 'function' ||
            typeof verifier._clearMessageQueue !== 'function')
            return;
        // The shell calls this._queueMessage() by name.
        verifier._queueMessage = args => {
            if (args?.messageType === MessageType.HINT)
                return;
            Object.getPrototypeOf(verifier)._queueMessage.call(verifier, args);
        };
        const id = prompt.connect('verification-complete', () => {
            try {
                const queue = verifier._messageQueue ?? [];
                if (queue.length > 0 && !queue.some(m => m.type === MessageType.INFO))
                    verifier._clearMessageQueue();
            } catch (e) {
                console.warn(`kelpshell: lock screen, messages: ${e.message}`);
            }
        });
        undo.push(() => {
            delete verifier._queueMessage;
            prompt.disconnect(id);
        });
    }

    /**
     * The prompt as high as what is in it.
     *
     * The shell's class gives the prompt a height of 550px, which a
     * stylesheet cannot take away (see the stylesheet), so the class is
     * changed.
     *
     * Under the entry the shell keeps an empty line, a label with no text,
     * for as long as the Caps Lock warning is not shown, and the message
     * comes under that. Without the line the message is the one line under
     * the entry, and the warning adds its own when it shows.
     */
    _fitPrompt(prompt, undo) {
        prompt.remove_style_class_name('login-dialog-prompt-layout');
        prompt.add_style_class_name('kelp-lock-prompt');
        undo.push(() => {
            prompt.remove_style_class_name('kelp-lock-prompt');
            prompt.add_style_class_name('login-dialog-prompt-layout');
        });
        const rows = prompt._inputWell?.get_children() ?? [];
        const line = rows[rows.indexOf(prompt._capsLockWarningLabel) - 1];
        if (line instanceof St.Label && !line.style_class && !line.text) {
            line.set_height(0);
            undo.push(() => line.set_height(-1));
        }
    }

    // ---- keys ----

    /**
     * A key pressed on the clock page shows the prompt, and the shell
     * types that key into the entry when it prints something. That is
     * right for the first letter of a password typed at the clock. A
     * space prints something too, so Space to get past the clock leaves a
     * space in the entry, shown as one dot. That space is taken out again.
     *
     * The shell calls this._onKeyPress() by name each time, so the one of
     * this dialog can be put in front of its own.
     */
    _hookKeys() {
        const dialog = this._dialog;
        if (typeof dialog._onKeyPress !== 'function')
            return;
        dialog._onKeyPress = () => {
            let atClock = false;
            try {
                atClock = dialog._activePage !== dialog._promptBox && !dialog._promptBox?.visible;
            } catch {
            }
            const result = Object.getPrototypeOf(dialog)._onKeyPress.call(dialog);
            try {
                if (atClock && dialog._keyController.get_key()[1] === Clutter.KEY_space) {
                    const entry = dialog._authPrompt?._entry;
                    if (entry?.text === ' ')
                        entry.text = '';
                }
            } catch (e) {
                console.warn(`kelpshell: lock screen, space: ${e.message}`);
            }
            return result;
        };
    }

    // ---- notifications ----

    _hookNotifications() {
        const list = this._dialog._notificationsBox?._notificationBox;
        if (!list)
            return;
        this._list = list;
        // One child per app with notifications, and one per media player.
        for (const child of list.get_children())
            this._backdrop.attach(child);
        list.connectObject('child-added', (_list, child) => {
            try {
                this._backdrop.attach(child);
            } catch (e) {
                console.warn(`kelpshell: lock screen, notification: ${e.message}`);
            }
        }, this);
    }
}
