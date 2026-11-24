// SPDX-License-Identifier: GPL-3.0-or-later

// The clipboard history: a list of what was copied lately, opened with
// Super+V. Enter puts the chosen entry on the clipboard and pastes it into
// the window that has the focus.
//
// The list works like the one of Windows. It opens at the text cursor of
// the focused window, or at the pointer when the window does not report a
// text cursor, and it does not take the keyboard: the window keeps the
// focus, and its text cursor stays where it is. A dialog that took the
// keyboard would take the focus from the window, and its text cursor would
// be gone while the list was open. The keys of the list (Up, Down, Enter,
// Delete, Escape) are held as global shortcuts for as long as it is open.
// Every other key goes to the window, and the list stays open: the shell
// does not see the keys a window is given. A move of the text cursor is not
// taken as a sign of typing: a terminal reports its cursor late, after a
// paste, and that would close the list as soon as it is opened again.
//
// The list is placed again whenever its height changes while it is open
// (_place). Something copied just before Super+V is read from the clipboard
// after the list has opened, and its row makes a list that is over the text
// cursor one row taller: placed only once, it would reach down over the
// cursor.
//
// Text and images are kept, the newest first. An entry that is copied again
// moves to the top. Nothing is written to disk: the list lasts as long as
// the shell process, and it is kept across the lock screen, which takes
// this part of the extension down.
//
// What a password manager copies is left out. Such a program marks its
// selection with the type x-kde-passwordManagerHint.
//
// The paste is a key press on a virtual keyboard: Ctrl+V, or Ctrl+Shift+V
// for a terminal.
//
// The text cursor of Firefox. Mutter 51 keeps a rectangle that a client
// sends until the surface that has the keyboard next commits
// (update_cursor_location in meta-wayland-text-input.c). Firefox draws in a
// subsurface, and its main surface commits when a field gets the focus and
// at some key presses, not when a page is drawn. GTK 3, which sends the
// rectangle for Firefox, sends the one it has when a field gets the focus,
// and Firefox gives GTK a new one at a key press only. So after a press on
// a field of a page the shell has the rectangle of the field that had the
// focus before, the URL bar for one, and the real one arrives two key
// presses later or not at all (measured with Firefox 160). A rectangle that
// came with the focus of a field of such a program is not used, see
// _onTextFocus(), and the list opens at the pointer. An empty commit from
// the input method makes GTK send the real rectangle, but Mutter does not
// pass it on: the main surface does not commit.
//
// The picker. The list is one page of four, as in the emoji panel of Windows:
// emoji, emoticons, symbols and the clipboard, with a row of tabs at the
// top. Super+V opens the clipboard, Super+period the emoji. Tab and
// Shift+Tab go from page to page. On the first three pages the arrow keys
// move through a grid, Enter puts the chosen one at the text cursor, and
// the picker stays open for the next. Letters, digits and Space typed there
// are held too: they search the page. What is chosen goes to the text field
// as a commit of the input method, so the clipboard keeps what it holds.
// Where the window has no text field the shell knows of, it is copied and
// pasted. lib/glyphs.js has the pages and the grid.
//
// The picker takes the pages from that panel and not its look: the tabs are
// one row of equal parts with a fill on the one shown, and the search of a
// page is shown in a field like the one of the launcher.
//
// With nothing copied the clipboard page shows a picture and one line, and
// the keys of the list are not held.
//
// The list also opens over the launcher, at the text cursor of its search
// field, and Enter then puts the text of the entry into that field. The
// launcher is a popup, so the shortcut and the keys of the list are allowed
// in the popup mode there. The launcher holds the grab, so a press, a
// pointer motion and a scroll on the list go to the launcher, which hands
// them over (press, hover, scroll). The pages of the grid are searched
// there as they are over a window: the letters are held, and the search
// field of the launcher gets them again when the picker is closed or shows
// the clipboard.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {CaretBar} from './caret.js';
import {GlyphGrid, Glyphs, PAGES, SECTION_ICONS} from './glyphs.js';
import {KineticScroll} from './kinetic.js';
import {picture} from './picture.js';
import {easeSettled} from './settle.js';
import {endRehearsal} from './warm.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING', 'TEXT'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
const SECRET_TYPE = 'x-kde-passwordManagerHint';

const MAX_TEXT = 500000;            // characters
const MAX_IMAGE = 16 * 1024 * 1024; // bytes
const ROW_TEXT = 240;               // characters of an entry shown in its row
const ROW_IMAGE = [260, 64];        // px, the most room an image has in its row
const WIDTH = 340;                  // px
const GAP = 8;                      // px between the text cursor and the list
const PASTE_DELAY_MS = 40;
// How often the pointer is read while the list is open, for a press
// outside it.
const WATCH_MS = 50;

// A rectangle of the text cursor that arrives within this many microseconds
// of the focus was sent with it: 230 to 410 were measured. One a key press
// brought arrived 200 ms or more after the focus.
const WITH_FOCUS_US = 2000;
const GRID_HEIGHT = 228;            // px, the grid of a page: six rows of emoji
// px between the edge of the picker and what is in it: 1 of border and 10
// of padding (.kelp-card, .kelp-launcher).
const INSET = 11;
// The pages, in the order of their tabs.
const TABS = [
    {name: 'emoji', title: 'Emoji', icon: 'emoji-people-symbolic'},
    {name: 'kaomoji', title: 'Emoticons', label: ';-)'},
    {name: 'symbols', title: 'Symbols', icon: 'emoji-symbols-symbolic'},
    {name: 'clipboard', title: 'Clipboard', icon: 'edit-paste-symbolic'},
];
// Keys that search a page of the grid.
const SEARCH_KEYS = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;

// Window classes of programs built on Gecko, see _onTextFocus().
const GECKO = ['firefox', 'mozilla', 'librewolf', 'floorp', 'waterfox', 'thunderbird',
    'icecat', 'zen-browser', 'zen_browser'];
const GECKO_NAMES = ['zen', 'zen-alpha', 'zen-beta', 'zen-twilight'];

function isGecko(win) {
    const wmClass = (win.get_wm_class() ?? '').toLowerCase();
    return GECKO_NAMES.includes(wmClass) || GECKO.some(name => wmClass.includes(name));
}

// Window classes that paste with Ctrl+Shift+V.
const TERMINALS = ['ghostty', 'kitty', 'alacritty', 'foot', 'wezterm', 'ptyxis', 'kgx',
    'gnome-terminal', 'console', 'tilix', 'konsole', 'terminator', 'blackbox', 'xterm'];

// Kept across disable and enable.
let saved = [];

// What tells two entries apart. For an image it is a checksum of its data.
function textKey(text) {
    return `t:${text}`;
}

function imageKey(data) {
    return `i:${GLib.compute_checksum_for_data(GLib.ChecksumType.SHA1, data)}`;
}

export class Clipboard {
    constructor({config, backdrop, launcher, dir}) {
        this._config = config;
        this._backdrop = backdrop;
        this._launcher = launcher;
        this._glyphs = new Glyphs(dir);
        this._tab = 'clipboard';  // the page that is shown
        this._query = '';         // what was typed on a page of the grid
        this._skip = null;        // the key of a text the picker copied itself
        this._inLauncher = false; // the open list belongs to the launcher
        this._entries = [];
        this._selected = 0;
        this._serial = 0;
        this._pasteId = 0;
        this._watchId = 0;
        this._keys = new Map();   // mutter action id -> {name, accel, run}
        this._caret = null;       // {focus, rect}: the text cursor last reported
        // Meta.Window -> {stale}: whether the rectangle the window has sent
        // is the one of another field.
        this._fields = new WeakMap();
        this._textIn = null;      // {win, serial, time}: the last focus of a text field
        this._windowSerial = 0;   // changes of the focused window so far
        this._keySet = '';        // which keys are held: 'grid', 'list' or 'empty'
        this._at = null;          // {anchor, monitor}: where the open list belongs
        this.isOpen = false;
    }

    enable() {
        this._entries = saved;
        this._selection = global.display.get_selection();
        this._selection.connectObject('owner-changed',
            (_s, type) => this._onOwnerChanged(type), this);
        // The text cursor of the focused window, in stage coordinates, from
        // clients that have the text-input protocol.
        Main.inputMethod.connectObject('cursor-location-changed',
            (_im, rect) => this._onCaret(rect), this);
        this._watchTextFocus();
        global.display.connectObject(
            'accelerator-activated', (_d, action) => this._keys.get(action)?.run(),
            'notify::focus-window', () => {
                this._windowSerial++;
                if (this.isOpen)
                    this.close();
            },
            this);

        this._list = new St.BoxLayout({orientation: VERTICAL, style_class: 'kelp-clipboard-list'});
        this._scroll = new St.ScrollView({
            style_class: 'kelp-clipboard-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._list,
        });
        // Goes on after a swipe on the touchpad, as the grid does.
        this._kinetic = new KineticScroll(this._scroll);
        // Shown in place of the list while nothing has been copied.
        this._empty = new St.BoxLayout({
            orientation: VERTICAL, style_class: 'kelp-clipboard-empty', x_expand: true,
        });
        const centred = {x_align: Clutter.ActorAlign.CENTER};
        this._empty.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic', style_class: 'kelp-clipboard-empty-icon', ...centred,
        }));
        this._empty.add_child(new St.Label({
            text: 'Nothing copied yet', style_class: 'kelp-clipboard-empty-title', ...centred,
        }));

        // The tabs, one beside the other over the whole width: a picture
        // or a short text each. The one that is shown has a fill, as a
        // chosen row has. The panel of Windows has its tabs at the left
        // with a line under the one shown, then a title ("Clipboard") with
        // a "Clear all" button: that look is not taken over.
        this._tabs = new St.BoxLayout({style_class: 'kelp-picker-tabs'});
        this._tabButtons = new Map();
        for (const tab of TABS) {
            const button = new St.Button({
                style_class: 'kelp-picker-tab',
                x_expand: true,
                child: tab.icon
                    ? new St.Icon({icon_name: tab.icon, style_class: 'kelp-picker-tab-icon'})
                    : new St.Label({text: tab.label, style_class: 'kelp-picker-tab-label'}),
            });
            button._kelpTab = tab.name;
            button.connect('clicked', () => this._showTab(tab.name));
            this._tabs.add_child(button);
            this._tabButtons.set(tab.name, button);
        }
        // On the pages of the grid: what was typed to search the page, in
        // a field that looks like the one of the launcher. It is a label:
        // the window keeps the keyboard, and the letters are held as
        // shortcuts (_grabKeys). The text cursor is an actor beside the
        // label, after what was typed, or before the hint of an empty
        // field as in a GTK entry.
        this._title = new St.Label({
            style_class: 'kelp-picker-query', y_align: Clutter.ActorAlign.CENTER,
        });
        this._field = new St.BoxLayout({style_class: 'kelp-picker-field'});
        this._field.add_child(new St.Icon({
            icon_name: 'system-search-symbolic', style_class: 'kelp-launcher-search-icon',
        }));
        this._field.add_child(this._title);
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._cursor = new CaretBar(this._interface);
        this._field.add_child(this._cursor.actor);
        // Under the list of the clipboard.
        this._hint = new St.Label({
            style_class: 'kelp-launcher-hint', text: 'Enter to paste   Delete to remove',
        });

        this._grid = new GlyphGrid({
            activate: item => this._insert(item),
            scrolled: () => this._syncSections(),
        });
        // Under the emoji: a picture for each section, as the emoji chooser
        // of GTK has. A press brings the section up, and the one in view
        // has the fill.
        this._sections = new St.BoxLayout({style_class: 'kelp-picker-sections'});
        this._sectionButtons = new Map();
        for (const [title, icon] of Object.entries(SECTION_ICONS)) {
            const button = new St.Button({
                style_class: 'kelp-picker-section',
                x_expand: true,
                child: new St.Icon({icon_name: icon, style_class: 'kelp-picker-tab-icon'}),
            });
            button._kelpSection = title;
            button.connect('clicked', () => this._grid.showSection(title));
            this._sections.add_child(button);
            this._sectionButtons.set(title, button);
        }
        this._glyphs.onLoaded = () => {
            if (this.isOpen && this._tab === 'emoji')
                this._fill();
        };
        this._glyphs.enable();

        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-launcher kelp-clipboard',
            orientation: VERTICAL,
            reactive: true,
        });
        surface.add_child(this._tabs);
        surface.add_child(this._field);
        surface.add_child(this._empty);
        surface.add_child(this._scroll);
        surface.add_child(this._hint);
        surface.add_child(this._grid.actor);
        surface.add_child(this._sections);
        this._box = this._backdrop.wrap(surface, 'kelp-shadow-launcher', {
            visible: false, opacity: 0, reactive: true,
        });
        Main.layoutManager.addTopChrome(this._box);
        // The height it reports before it has been laid out can be wrong
        // (see open()), and the list is placed by its height when it opens
        // over the text cursor.
        this._box.connect('notify::height', () => this._place());
        this._launcher.guest = this;
    }

    disable() {
        this._launcher.guest = null;
        this.close(false);
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = 0;
        this._serial++;
        this._selection.disconnectObject(this);
        this._selection = null;
        Main.inputMethod.disconnectObject(this);
        this._unwatchTextFocus();
        global.display.disconnectObject(this);
        Main.layoutManager.removeChrome(this._box);
        this._box.destroy();
        this._box = this._list = this._scroll = this._empty = this._grid = null;
        this._tabs = this._field = this._title = this._hint = null;
        this._cursor = this._interface = null;
        this._sections = this._sectionButtons = null;
        this._tabButtons = null;
        this._glyphs.onLoaded = null;
        this._glyphs.disable();
        this._keyboard = null;
        this._caret = null;
        saved = this._entries;
    }

    // ---- the text cursor ----

    /**
     * Calls _onTextFocus() when a text field of a window gets or loses the
     * focus. The shell's input method has no signal for it: it keeps the
     * field in _currentFocus, which is made a property with a setter here
     * for as long as the extension is enabled.
     */
    _watchTextFocus() {
        const im = Main.inputMethod;
        let focus = im._currentFocus;
        Object.defineProperty(im, '_currentFocus', {
            configurable: true,
            enumerable: true,
            get: () => focus,
            set: value => {
                focus = value;
                try {
                    this._onTextFocus(value);
                } catch (e) {
                    console.warn(`kelpshell: text focus: ${e.message}`);
                }
            },
        });
    }

    _unwatchTextFocus() {
        const im = Main.inputMethod;
        const focus = im._currentFocus;
        delete im._currentFocus;
        im._currentFocus = focus;
    }

    /**
     * A text field got the focus (focus) or lost it (null).
     *
     * A client sends the rectangle of its text cursor again with every
     * focus. A program built on Gecko has one rectangle for its window and
     * sets it at a key press only, so what it sends with the focus is the
     * rectangle of the field that had the focus before (see the top of the
     * file). It is marked stale here until a rectangle arrives on its own,
     * which one does after a key press in the field.
     *
     * Not when the window itself got the focus back: the field is then the
     * one it was, and what was true of the rectangle before still is.
     */
    _onTextFocus(focus) {
        if (!focus) {
            // A client has to send it again with the next focus.
            this._caret = null;
            return;
        }
        const win = global.display.focus_window;
        const last = this._textIn;
        this._textIn = {win, serial: this._windowSerial, time: GLib.get_monotonic_time()};
        if (!win)
            return;
        const sameWindow = last && last.win === win && last.serial === this._windowSerial;
        if (!sameWindow) {
            if (!this._fields.has(win))
                this._fields.set(win, {stale: false});
            return;
        }
        this._fields.set(win, {stale: true});
    }

    /** The focused window has sent the rectangle of its text cursor. */
    _onCaret(rect) {
        const win = global.display.focus_window;
        const field = win ? this._fields.get(win) : null;
        const withFocus = this._textIn &&
            GLib.get_monotonic_time() - this._textIn.time < WITH_FOCUS_US;
        if (field && !withFocus)
            field.stale = false;
        this._caret = {
            focus: Main.inputMethod.currentFocus,
            rect: {
                x: rect.get_x(), y: rect.get_y(),
                width: rect.get_width(), height: rect.get_height(),
            },
        };
    }

    // ---- the list ----

    _max() {
        const n = Number(this._config.values.clipboard.size);
        return Number.isFinite(n) ? Math.max(1, Math.min(200, Math.round(n))) : 25;
    }

    _onOwnerChanged(type) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        // An answer that arrives after the next copy is dropped.
        const serial = ++this._serial;
        const types = this._selection.get_mimetypes(type);
        if (types.includes(SECRET_TYPE))
            return;
        const clipboard = St.Clipboard.get_default();
        if (types.some(t => TEXT_TYPES.includes(t))) {
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                if (serial !== this._serial || !text || !text.trim() || text.length > MAX_TEXT)
                    return;
                // What the picker copied to paste an emoji is not an entry.
                const key = textKey(text);
                if (key === this._skip) {
                    this._skip = null;
                    return;
                }
                this._add({kind: 'text', key, text});
            });
            return;
        }
        const mime = IMAGE_TYPES.find(t => types.includes(t));
        if (!mime)
            return;
        clipboard.get_content(St.ClipboardType.CLIPBOARD, mime, (_c, bytes) => {
            const size = bytes?.get_size() ?? 0;
            if (serial !== this._serial || size === 0 || size > MAX_IMAGE)
                return;
            // The GLib.Bytes of this callback is only read here, and only
            // with get_size() and get_data(). In GNOME Shell 51.1
            // bytes.hash() ends the shell with a segmentation fault, and
            // GLib.compute_checksum_for_bytes(bytes) with a double free.
            // The entry keeps a GLib.Bytes of its own, made from the copy.
            const data = bytes.get_data();
            this._add({kind: 'image', key: imageKey(data), mime, bytes: new GLib.Bytes(data)});
        });
    }

    _add(entry) {
        this._entries = [entry, ...this._entries.filter(e => e.key !== entry.key)]
            .slice(0, this._max());
        saved = this._entries;
        if (this.isOpen)
            this._render(0);
    }

    _remove(index) {
        if (!this._entries[index])
            return;
        this._entries = this._entries.filter((_e, i) => i !== index);
        saved = this._entries;
        this._render(Math.min(index, this._entries.length - 1));
    }

    _clear() {
        this._entries = saved = [];
        this._render(0);
    }

    // ---- the popup ----

    /** tab: the page to open, a name of TABS. Open on that page already: close. */
    toggle(tab = 'clipboard') {
        if (!this.isOpen)
            this.open(tab);
        else if (this._tab === tab)
            this.close();
        else
            this._showTab(tab);
    }

    /**
     * Where the list opens: the rectangle of the text cursor, or a point at
     * the pointer where the window has not reported one that can be used.
     * Both in stage coordinates.
     */
    _anchor() {
        const focus = Main.inputMethod.currentFocus;
        const win = global.display.focus_window;
        const caret = this._caret;
        if (focus && win) {
            const frame = win.get_frame_rect();
            const inside = (x, y) => x >= frame.x && x <= frame.x + frame.width &&
                y >= frame.y && y <= frame.y + frame.height;
            // A client can report a rectangle it never updates. One
            // outside its own window is not used, and neither is one
            // without a height: Firefox sends 0, 0, 0, 0 for its URL bar
            // before a key is pressed there, the corner of its window. Nor
            // is the one a program built on Gecko sent for another field.
            const stale = this._fields.get(win)?.stale && isGecko(win);
            const r = caret?.focus === focus ? caret.rect : null;
            if (r && !stale && r.height > 0 && inside(r.x, r.y))
                return r;
        }
        const [x, y] = global.get_pointer();
        return {x, y, width: 0, height: 0};
    }

    /**
     * For lib/warm.js: the picker with the clipboard page and the grid both
     * in it, not shown.
     */
    rehearse() {
        const monitor = Main.layoutManager.primaryMonitor;
        // Visible after a close for as long as it fades.
        if (this.isOpen || !monitor || !this._box || this._box.visible)
            return null;
        this._size(monitor);
        this._tab = 'emoji';
        this._query = '';
        this._render(0);
        const none = this._entries.length === 0;
        this._empty.visible = none;
        this._scroll.visible = !none;
        this._box.set_position(monitor.x, monitor.y);
        this._box.set_scale(1, 1);
        // Drawn at all only when it is not see-through, see lib/warm.js.
        this._box.opacity = 255;
        return {actor: this._box, isOpen: () => this.isOpen};
    }

    /** The width of the picker and the room of its grid on a monitor. */
    _size(monitor) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = Math.min(WIDTH * s, monitor.width - 16 * s);
        this._box.set_width(width);
        this._grid.setSize(width - 2 * INSET * s, GRID_HEIGHT * s);
    }

    open(tab = 'clipboard') {
        // Over the launcher, and not over another popup.
        const inLauncher = this._launcher.typing;
        if (this.isOpen || (!inLauncher && Main.actionMode !== Shell.ActionMode.NORMAL))
            return;
        this._inLauncher = inLauncher;
        const anchor = inLauncher ? this._launcher.caret() : this._anchor();
        const index = global.display.get_monitor_index_for_rect(new Mtk.Rectangle({
            x: Math.round(anchor.x), y: Math.round(anchor.y), width: 1, height: 1,
        }));
        const monitor = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        endRehearsal(this._box);
        this.isOpen = true;
        this._at = {anchor, monitor};

        this._size(monitor);
        this._tab = TABS.some(t => t.name === tab) ? tab : 'clipboard';
        this._query = '';
        // Shows the page and places the picker too.
        this._render(0);

        this._box.remove_all_transitions();
        this._box.show();
        // Again now that the list is shown: hidden, the first time after
        // the extension was enabled, it reported 16 px more than the height
        // it then had (137 against 121 with two rows, in the headless shell).
        // At a display scale of 2 it still reports 1 px too many for each
        // row until it has been laid out once, so it is also placed again
        // whenever its height changes (see enable()).
        this._place();
        this._box.set_pivot_point(0, 0);
        this._box.set_scale(0.96, 0.96);
        this._box.opacity = 0;
        // Once the first frame is drawn, see settle.js.
        easeSettled(this._box, {
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._grabKeys();
        this._watch();
    }

    /**
     * Put the open list where it belongs for the height it has now: under
     * the text cursor, its left edge at the cursor, or over the cursor
     * where the monitor has no room below.
     */
    _place() {
        if (!this.isOpen || !this._at)
            return;
        const {anchor, monitor} = this._at;
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, , width, height] = this._box.get_preferred_size();
        const gap = GAP * s;
        let x = anchor.x;
        let y = anchor.y + anchor.height + gap;
        if (y + height > monitor.y + monitor.height - gap)
            y = anchor.y - height - gap;
        x = Math.max(monitor.x + gap, Math.min(x, monitor.x + monitor.width - width - gap));
        y = Math.max(monitor.y + gap, Math.min(y, monitor.y + monitor.height - height - gap));
        this._box.set_position(Math.round(x), Math.round(y));
    }

    close(animate = true) {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        this._at = null;
        this._ungrabKeys();
        if (this._watchId)
            GLib.source_remove(this._watchId);
        this._watchId = 0;
        this._cursor.stop();
        this._box.remove_all_transitions();
        if (!animate) {
            this._box.opacity = 0;
            this._box.hide();
            return;
        }
        this._box.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._box.hide(),
        });
    }

    /**
     * The keys of the list, as global shortcuts while it is open. The
     * window keeps the keyboard, so the keys cannot be read as key presses
     * on the list.
     */
    _grabKeys() {
        const all = {
            'Tab': () => this._nextTab(1),
            '<Shift>Tab': () => this._nextTab(-1),
            'Escape': () => this.close(),
        };
        let keys;
        if (this._tab !== 'clipboard') {
            this._keySet = 'grid';
            const insert = () => this._insert(this._grid.current);
            keys = {
                ...all,
                'Left': () => this._grid.move(-1, 0),
                'Right': () => this._grid.move(1, 0),
                'Up': () => this._grid.move(0, -1),
                'Down': () => this._grid.move(0, 1),
                'Return': insert,
                'KP_Enter': insert,
            };
            for (const key of SEARCH_KEYS) {
                keys[key] = () => this._type(key);
                // With Shift too, or a capital letter went to the window.
                if (key >= 'a')
                    keys[`<Shift>${key}`] = keys[key];
            }
            keys['space'] = () => this._type(' ');
            // Held only while there is something to take back: with
            // nothing typed the keys delete in the window.
            if (this._query) {
                keys['BackSpace'] = () => this._type(null);
                keys['<Control>BackSpace'] = () => this._typeBack();
            }
        } else if (this._entries.length === 0) {
            // With nothing to choose, the window keeps the other keys.
            this._keySet = 'empty';
            keys = all;
        } else {
            this._keySet = 'list';
            keys = {
                ...all,
                'Down': () => this._select(this._selected + 1),
                'Up': () => this._select(this._selected - 1),
                'Return': () => this._activate(this._selected),
                'KP_Enter': () => this._activate(this._selected),
                'Delete': () => this._remove(this._selected),
                '<Shift>Delete': () => this._clear(),
            };
        }
        for (const [accel, run] of Object.entries(keys)) {
            const action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.NONE);
            if (action === Meta.KeyBindingAction.NONE)
                continue;
            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name,
                this._inLauncher ? Shell.ActionMode.POPUP : Shell.ActionMode.NORMAL);
            this._keys.set(action, {name, accel, run});
        }
    }

    _ungrabKeys() {
        for (const [action, key] of this._keys) {
            global.display.ungrab_accelerator(action);
            Main.wm.allowKeybinding(key.name, Shell.ActionMode.NONE);
        }
        this._keys.clear();
    }

    /**
     * Close on a press outside the list. Such a press goes to the window
     * under it and not to the shell, so the buttons are read from the
     * pointer.
     */
    _watch() {
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WATCH_MS, () => {
            const [x, y, mods] = global.get_pointer();
            if (!(mods & BUTTONS))
                return GLib.SOURCE_CONTINUE;
            const [bx, by] = this._box.get_transformed_position();
            const [bw, bh] = this._box.get_transformed_size();
            if (x >= bx && x < bx + bw && y >= by && y < by + bh)
                return GLib.SOURCE_CONTINUE;
            this._watchId = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * A press that the launcher received while it held the grab. True when
     * the press was on the list.
     */
    press(actor, button) {
        if (!this.isOpen || !actor || !this._box.contains(actor))
            return false;
        for (let a = actor; a && a !== this._box; a = a.get_parent()) {
            if (a._kelpTab) {
                this._showTab(a._kelpTab);
                return true;
            }
            if (a._kelpSection) {
                this._grid.showSection(a._kelpSection);
                return true;
            }
        }
        if (this._tab !== 'clipboard') {
            const at = this._grid.indexOf(actor);
            if (at >= 0 && button === Clutter.BUTTON_PRIMARY) {
                this._grid.select(at, false);
                this._insert(this._grid.current);
            }
            return true;
        }
        const index = this._list.get_children().findIndex(row => row.contains(actor));
        if (index < 0)
            return true;
        if (button === Clutter.BUTTON_MIDDLE)
            this._remove(index);
        else if (button === Clutter.BUTTON_PRIMARY)
            this._activate(index);
        return true;
    }

    /** A pointer motion that the launcher received while it held the grab. */
    hover(actor) {
        if (!this.isOpen || !actor)
            return;
        if (this._tab !== 'clipboard') {
            const at = this._grid.indexOf(actor);
            if (at >= 0 && at !== this._grid.selected)
                this._grid.select(at, false);
            return;
        }
        const index = this._list.get_children().findIndex(row => row.contains(actor));
        if (index >= 0 && index !== this._selected)
            this._select(index);
    }

    /**
     * A scroll that the launcher received while it held the grab. True when
     * it was over the picker. The view of the page is given the event, so
     * it scrolls as it does over a window, and lib/kinetic.js sees it.
     */
    scroll(actor, event) {
        if (!this.isOpen || !actor || !this._box.contains(actor))
            return false;
        const view = this._tab === 'clipboard' ? this._scroll : this._grid.actor;
        if (view.visible)
            view.event(event, false);
        return true;
    }

    // ---- the pages ----

    _showTab(tab) {
        this._tab = TABS.some(t => t.name === tab) ? tab : 'clipboard';
        this._query = '';
        this._syncPage();
    }

    _nextTab(step) {
        const at = TABS.findIndex(t => t.name === this._tab);
        this._showTab(TABS[(at + step + TABS.length) % TABS.length].name);
    }

    /** Show the page of this._tab, with the keys that belong to it. */
    _syncPage() {
        const tab = TABS.find(t => t.name === this._tab);
        const grid = tab.name !== 'clipboard';
        const empty = this._entries.length === 0;
        for (const [name, button] of this._tabButtons) {
            if (name === tab.name)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        this._field.visible = grid;
        this._title.text = this._query || `Search ${tab.title.toLowerCase()}`;
        if (this._query) {
            this._title.remove_style_pseudo_class('insensitive');
            this._field.set_child_above_sibling(this._cursor.actor, this._title);
        } else {
            this._title.add_style_pseudo_class('insensitive');
            this._field.set_child_below_sibling(this._cursor.actor, this._title);
        }
        // Shown again at every key, as in a GTK entry.
        if (this.isOpen && this._field.visible)
            this._cursor.restart();
        else
            this._cursor.stop();
        this._empty.visible = !grid && empty;
        this._scroll.visible = !grid && !empty;
        this._hint.visible = !grid && !empty;
        this._grid.actor.visible = grid;
        // Not for a search: what was found is one list.
        this._sections.visible = tab.name === 'emoji' && !this._query;
        if (grid)
            this._fill();
        // Another page, the first entry, the last one removed, or the first
        // letter of a search: other keys.
        let set = 'list';
        if (grid)
            set = 'grid';
        else if (empty)
            set = 'empty';
        const backSpace = [...this._keys.values()].some(k => k.accel === 'BackSpace');
        if (this.isOpen && this._keys.size > 0 &&
            (set !== this._keySet || (grid && backSpace !== (this._query !== '')))) {
            this._ungrabKeys();
            this._grabKeys();
        }
        this._place();
    }

    _fill() {
        this._grid.setContent(this._tab, this._glyphs.sections(this._tab, this._query));
    }

    /** The picture of the section in view has the fill. */
    _syncSections() {
        if (!this._sections?.visible)
            return;
        const current = this._grid.section;
        for (const [title, button] of this._sectionButtons) {
            button.visible = this._grid.hasSection(title);
            if (title === current)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
    }

    /** A key that searches the page: a character, or null for BackSpace. */
    _type(character) {
        this._query = character === null
            ? this._query.slice(0, -1)
            : (this._query + character).trimStart();
        this._syncPage();
    }

    /** Control+BackSpace: take back the last word, as a GTK entry does. */
    _typeBack() {
        this._query = this._query.replace(/\S*\s*$/, '');
        this._syncPage();
    }

    /**
     * Put an emoji, an emoticon or a symbol at the text cursor. The picker
     * stays open for the next one.
     */
    _insert(item) {
        if (!item || !this.isOpen || !PAGES[this._tab])
            return;
        const text = item.text;
        this._glyphs.used(this._tab, text);
        if (this._inLauncher) {
            if (this._launcher.typing)
                this._launcher.insert(text);
            return;
        }
        // To the text field of the window, as an input method does.
        if (Main.inputMethod.currentFocus) {
            Main.inputMethod.commit(text);
            return;
        }
        // The window has no text field the shell knows of: by the clipboard.
        const target = global.display.focus_window;
        if (!target)
            return;
        this._skip = textKey(text);
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._pasteLater(target);
    }

    _select(index) {
        const rows = this._list.get_children();
        const n = rows.length;
        if (n === 0)
            return;
        this._selected = ((index % n) + n) % n;
        rows.forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        ensureActorVisibleInScrollView(this._scroll, rows[this._selected]);
    }

    _render(selected) {
        if (!this._list)
            return;
        this._list.destroy_all_children();
        this._entries.forEach((entry, index) => {
            let child;
            if (entry.kind === 'image') {
                const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                child = picture({
                    key: entry.key, bytes: entry.bytes,
                    width: ROW_IMAGE[0] * s, height: ROW_IMAGE[1] * s, hug: true,
                    // A wide picture is less high than the room it was given.
                    loaded: () => this._place(),
                });
                child.x_expand = true;
                child.x_align = Clutter.ActorAlign.START;
            } else {
                child = new St.Label({
                    text: entry.text.slice(0, ROW_TEXT * 4).replace(/\s+/g, ' ').trim()
                        .slice(0, ROW_TEXT),
                    style_class: 'kelp-clip-text',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                child.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            }
            const row = new St.Button({
                style_class: 'kelp-result kelp-clip',
                child,
                x_expand: true,
                button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE,
            });
            row.connect('clicked', (_b, button) => {
                if (button === 2)
                    this._remove(index);
                else
                    this._activate(index);
            });
            // Motion and not hover, as in the launcher.
            row.connect('motion-event', () => {
                if (this._selected !== index)
                    this._select(index);
                return Clutter.EVENT_PROPAGATE;
            });
            this._list.add_child(row);
        });
        this._selected = Math.max(0, selected);
        this._select(this._selected);
        // Places the picker too.
        this._syncPage();
    }

    // ---- paste ----

    _activate(index) {
        const entry = this._entries[index];
        if (!entry || !this.isOpen)
            return;
        const target = global.display.focus_window;
        const inLauncher = this._inLauncher;
        this.close();
        const clipboard = St.Clipboard.get_default();
        if (entry.kind === 'text')
            clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        else
            clipboard.set_content(St.ClipboardType.CLIPBOARD, entry.mime, entry.bytes);
        if (inLauncher) {
            // The search field takes text only. An image is on the
            // clipboard now and the field is left as it is.
            if (this._config.values.clipboard.paste !== false && entry.kind === 'text' &&
                this._launcher.typing)
                this._launcher.insert(entry.text);
            return;
        }
        if (this._config.values.clipboard.paste !== false)
            this._pasteLater(target);
    }

    /** Paste into target after the release of the key or button that chose. */
    _pasteLater(target) {
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            if (target && global.display.focus_window === target)
                this._sendPaste(target);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPaste(win) {
        const wmClass = (win.get_wm_class() ?? '').toLowerCase();
        const terminal = TERMINALS.some(name => wmClass.includes(name));
        const keys = terminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        try {
            this._keyboard ??= global.stage.context.get_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            const now = () => GLib.get_monotonic_time();
            for (const key of keys)
                this._keyboard.notify_keyval(now(), key, Clutter.KeyState.PRESSED);
            for (const key of [...keys].reverse())
                this._keyboard.notify_keyval(now(), key, Clutter.KeyState.RELEASED);
        } catch (e) {
            console.warn(`kelpshell: paste: ${e.message}`);
        }
    }
}
