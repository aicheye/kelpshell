// SPDX-License-Identifier: GPL-3.0-or-later

// A blinking text cursor for an St.Entry.
//
// St.Entry has no blinking cursor of its own in GNOME 51: the cursor of a
// field with the focus is a bar that stays. This follows GTK and the
// cursor-blink keys of org.gnome.desktop.interface. The cursor is shown for
// half of cursor-blink-time and hidden for the other half, starts again
// shown at every change of the text, and stays shown once
// cursor-blink-timeout seconds have passed without one.
//
// lib/launcher.js has the same for its own field, written before this file.
//
// CaretBar is the same cursor as an actor of its own, for a field that is a
// label: the picker (lib/clipboard.js) shows what is typed without taking
// the keyboard, and a ClutterText draws its cursor only with the key focus.

import GLib from 'gi://GLib';
import St from 'gi://St';

export class CaretBlink {
    /** settings: a Gio.Settings of org.gnome.desktop.interface. */
    constructor(entry, settings) {
        this._text = entry.clutter_text;
        this._settings = settings;
        this._id = 0;
        this._text.connectObject(
            'key-focus-in', () => this.restart(),
            'key-focus-out', () => this.stop(),
            'text-changed', () => this.restart(),
            'destroy', () => this._clear(),
            this);
        this.restart();
    }

    /** Show the cursor and blink from the beginning. */
    restart() {
        this.stop();
        if (!this._text.has_key_focus() || !this._settings.get_boolean('cursor-blink'))
            return;
        const text = this._text;
        const half = Math.max(100, this._settings.get_int('cursor-blink-time') / 2);
        const end = GLib.get_monotonic_time() / 1000 +
            this._settings.get_int('cursor-blink-timeout') * 1000;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, half, () => {
            if (GLib.get_monotonic_time() / 1000 >= end) {
                this._id = 0;
                text.cursor_visible = true;
                return GLib.SOURCE_REMOVE;
            }
            // A selection has no cursor to hide.
            const rests = text.cursor_position === text.selection_bound;
            text.cursor_visible = rests ? !text.cursor_visible : true;
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        this._clear();
        this._text.cursor_visible = true;
    }

    _clear() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }

    destroy() {
        this._text.disconnectObject(this);
        this._clear();
    }
}

/**
 * A text cursor that is an actor: a bar one pixel wide, as high as the row
 * it is put in. It blinks by the same settings as CaretBlink.
 */
export class CaretBar {
    /** settings: a Gio.Settings of org.gnome.desktop.interface. */
    constructor(settings) {
        this._settings = settings;
        this._id = 0;
        this.actor = new St.Widget({style_class: 'kelp-caret', y_expand: true});
        this.actor.connect('destroy', () => this._clear());
    }

    /** Show the cursor and blink from the beginning. */
    restart() {
        this.stop();
        if (!this._settings.get_boolean('cursor-blink'))
            return;
        const actor = this.actor;
        const half = Math.max(100, this._settings.get_int('cursor-blink-time') / 2);
        const end = GLib.get_monotonic_time() / 1000 +
            this._settings.get_int('cursor-blink-timeout') * 1000;
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, half, () => {
            if (GLib.get_monotonic_time() / 1000 >= end) {
                this._id = 0;
                actor.opacity = 255;
                return GLib.SOURCE_REMOVE;
            }
            // The opacity and not hide(): the text beside it stays in place.
            actor.opacity = actor.opacity ? 0 : 255;
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Stop blinking, with the cursor shown. */
    stop() {
        this._clear();
        this.actor.opacity = 255;
    }

    _clear() {
        if (this._id)
            GLib.source_remove(this._id);
        this._id = 0;
    }
}
