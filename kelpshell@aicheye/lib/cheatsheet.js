// The shortcut sheet: the keys Kelpshell binds, drawn as key caps in groups.
//
// The keys are read from the config each time the sheet opens, so it shows
// the bindings in effect. An action with no key is left out.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {easeSettled} from './settle.js';
import {endRehearsal} from './warm.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

// One list per column of the sheet. A row is a label and one or two actions.
// Two actions share a row and, when they use the same modifiers, the caps
// for those modifiers. 'range' is the first and last of a numbered run.
// 'keys' is a fixed accelerator for a key the config does not set.
const COLUMNS = [
    [
        {title: 'Focus', rows: [
            {label: 'Column left, right', actions: ['focus-left', 'focus-right']},
            {label: 'Window up, down', actions: ['focus-up', 'focus-down']},
            {label: 'First, last column', actions: ['focus-first', 'focus-last']},
            {label: 'Switch windows', keys: ['<Alt>Tab']},
        ]},
        {title: 'Move', rows: [
            {label: 'Column left, right', actions: ['move-left', 'move-right']},
            {label: 'Window up, down', actions: ['move-up', 'move-down']},
            {label: 'To first, last', actions: ['move-first', 'move-last']},
            {label: 'Into or out of a stack',
                actions: ['consume-or-expel-left', 'consume-or-expel-right']},
            {label: 'To the left, right side', actions: ['align-left', 'align-right']},
            {label: 'To the middle', actions: ['align-center']},
        ]},
    ],
    [
        {title: 'Size', rows: [
            {label: 'Cycle width', actions: ['cycle-width']},
            {label: 'Narrower, wider', actions: ['width-decrease', 'width-increase']},
            {label: 'Shorter, taller', actions: ['height-decrease', 'height-increase']},
            {label: 'Full width', actions: ['maximize-column']},
            {label: 'Fullscreen', actions: ['fullscreen']},
            {label: 'Centre', actions: ['center-column']},
        ]},
        {title: 'Window', rows: [
            {label: 'Float or tile', actions: ['toggle-float']},
            {label: 'Minimize', actions: ['minimize-window']},
            {label: 'Close', actions: ['close-window']},
            {label: 'Reopen closed', actions: ['reopen-closed']},
        ]},
    ],
    [
        {title: 'Workspaces', rows: [
            {label: 'Previous, next', actions: ['workspace-up', 'workspace-down']},
            {label: 'Go to', range: ['workspace-1', 'workspace-9']},
            {label: 'Send window', actions: ['move-to-workspace-up', 'move-to-workspace-down']},
            {label: 'Send window to', range: ['move-to-workspace-1', 'move-to-workspace-9']},
        ]},
        {title: 'Shell', rows: [
            {label: 'Launcher', actions: ['launcher']},
            {label: 'Clipboard', actions: ['clipboard']},
            {label: 'Emoji and symbols', actions: ['emoji']},
            {label: 'Terminal', actions: ['terminal']},
            {label: 'Files', actions: ['files']},
            {label: 'Sidebar', actions: ['toggle-sidebar']},
            {label: 'Shortcuts', actions: ['shortcuts']},
        ]},
    ],
];

const MOD_LABELS = {
    super: 'Super', mod4: 'Super',
    control: 'Ctrl', ctrl: 'Ctrl', primary: 'Ctrl',
    shift: 'Shift',
    alt: 'Alt', mod1: 'Alt',
    meta: 'Meta', hyper: 'Hyper',
};
const MOD_ORDER = ['Super', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Hyper'];

const KEY_LABELS = {
    left: '←', right: '→', up: '↑', down: '↓',
    return: '↵', space: 'Space', tab: 'Tab', escape: 'Esc',
    backspace: '⌫', delete: 'Del',
    page_up: 'PgUp', page_down: 'PgDn', home: 'Home', end: 'End',
    minus: '−', equal: '=', plus: '+',
    bracketleft: '[', bracketright: ']',
    slash: '/', backslash: '\\', question: '?',
    comma: ',', period: '.', semicolon: ';', apostrophe: "'", grave: '`',
};

/** '<Super><Control>Left' gives {mods: ['Super', 'Ctrl'], key: '←'}. */
export function parseAccel(accel) {
    const mods = [];
    const key = String(accel).replace(/<([^>]+)>/g, (_m, mod) => {
        const label = MOD_LABELS[mod.toLowerCase()] ?? mod;
        if (!mods.includes(label))
            mods.push(label);
        return '';
    }).trim();
    if (!key)
        return null;
    mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    const label = KEY_LABELS[key.toLowerCase()] ??
        (key.length === 1 ? key.toUpperCase() : key.replace(/_/g, ' '));
    return {mods, key: label};
}

function cap(text, key = false) {
    return new St.Label({
        text,
        style_class: key ? 'kelp-keycap kelp-keycap-key' : 'kelp-keycap',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function joiner(text) {
    return new St.Label({
        text,
        style_class: 'kelp-keycap-join',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export class Cheatsheet {
    constructor({config, backdrop}) {
        this._config = config;
        this._backdrop = backdrop;
        this.isOpen = false;
        this._built = null;      // the shortcuts the sheet was built for, as JSON
    }

    enable() {
        this._overlay = new St.Widget({
            style_class: 'kelp-sheet-overlay',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            visible: false,
            opacity: 0,
        });
        this._overlay.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        // Any key closes the sheet, except a modifier on its own: the keys
        // on the sheet are tried with Super held.
        this._overlay.connect('key-press-event', (_a, event) => {
            const symbol = event.get_key_symbol();
            if (symbol >= Clutter.KEY_Shift_L && symbol <= Clutter.KEY_Hyper_R)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });

        this._surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-sheet',
            orientation: VERTICAL,
        });
        this._box = this._backdrop.wrap(this._surface, 'kelp-shadow-launcher', {
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._overlay.add_child(this._box);
        Main.layoutManager.addTopChrome(this._overlay);
    }

    disable() {
        this.close(false);
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = this._box = this._surface = null;
        this._built = null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    /** The sheet with its rows and the size it has on monitor. */
    _lay(monitor) {
        // Built again only for other shortcuts. Until 2026-11-22 the sheet
        // was built on every opening: 26 ms in open(), a frame of 23 ms,
        // and 20 ms of styles computed by St two frames into the animation.
        const built = JSON.stringify(this._config.values.keybindings);
        if (built !== this._built) {
            this._build();
            this._built = built;
        }
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
    }

    /**
     * For lib/warm.js: the sheet as it opens, not shown. null while it is
     * open.
     */
    rehearse() {
        const monitor = Main.layoutManager.primaryMonitor;
        // Visible after a close for as long as it fades.
        if (this.isOpen || !monitor || !this._overlay || this._overlay.visible)
            return null;
        this._lay(monitor);
        return {actor: this._overlay, isOpen: () => this.isOpen};
    }

    open() {
        if (this.isOpen)
            return;
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        endRehearsal(this._overlay);
        const grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        if (!grab)
            return;
        this._grab = grab;
        this.isOpen = true;

        this._lay(monitor);
        this._overlay.show();
        this._overlay.grab_key_focus();

        // A sheet wider or taller than the monitor is drawn smaller.
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, , width, height] = this._box.get_preferred_size();
        const fit = Math.min(1,
            (monitor.width - 48 * s) / Math.max(1, width),
            (monitor.height - 48 * s) / Math.max(1, height));

        this._overlay.remove_all_transitions();
        this._box.remove_all_transitions();
        this._box.set_pivot_point(0.5, 0.5);
        this._box.set_scale(0.96 * fit, 0.96 * fit);
        // Once the first frame is drawn, see settle.js.
        easeSettled(this._overlay, {
            opacity: 255,
            duration: 130,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        easeSettled(this._box, {
            scale_x: fit,
            scale_y: fit,
            duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    close(animate = true) {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        Main.popModal(this._grab);
        this._grab = null;
        this._overlay.remove_all_transitions();
        if (!animate) {
            this._overlay.opacity = 0;
            this._overlay.hide();
            return;
        }
        this._overlay.ease({
            opacity: 0,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._overlay.hide(),
        });
    }

    // ---- content ----

    _build() {
        this._surface.destroy_all_children();
        const columns = new St.BoxLayout({style_class: 'kelp-sheet-columns'});
        for (const groups of COLUMNS) {
            const column = new St.BoxLayout({orientation: VERTICAL, style_class: 'kelp-sheet-column'});
            for (const group of groups) {
                const rows = group.rows.map(row => this._row(row)).filter(Boolean);
                if (rows.length === 0)
                    continue;
                const box = new St.BoxLayout({orientation: VERTICAL, style_class: 'kelp-sheet-group'});
                box.add_child(new St.Label({text: group.title, style_class: 'kelp-sheet-title'}));
                for (const row of rows)
                    box.add_child(row);
                column.add_child(box);
            }
            if (column.get_n_children() > 0)
                columns.add_child(column);
        }
        this._surface.add_child(columns);
    }

    /** The first key bound to an action, parsed, or null. */
    _accel(name) {
        const accels = this._config.values.keybindings[name];
        const first = Array.isArray(accels) ? accels.find(a => typeof a === 'string') : null;
        return first ? parseAccel(first) : null;
    }

    _row({label, actions, range, keys}) {
        let combos;
        let join = null;
        if (keys) {
            combos = keys.map(parseAccel);
        } else if (range) {
            combos = range.map(name => this._accel(name));
            if (combos.includes(null))
                return null;
            join = '–';
        } else {
            combos = actions.map(name => this._accel(name)).filter(Boolean);
        }
        if (combos.length === 0)
            return null;

        const caps = new St.BoxLayout({
            style_class: 'kelp-sheet-caps',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        const sameMods = combos.every(c => c.mods.join('+') === combos[0].mods.join('+'));
        if (sameMods) {
            // Modifiers once, then each key.
            for (const mod of combos[0].mods)
                caps.add_child(cap(mod));
            combos.forEach((c, i) => {
                if (i > 0 && join)
                    caps.add_child(joiner(join));
                caps.add_child(cap(c.key, true));
            });
        } else {
            combos.forEach((c, i) => {
                if (i > 0)
                    caps.add_child(joiner(join ?? '/'));
                for (const mod of c.mods)
                    caps.add_child(cap(mod));
                caps.add_child(cap(c.key, true));
            });
        }

        const row = new St.BoxLayout({style_class: 'kelp-sheet-row'});
        row.add_child(new St.Label({
            text: label,
            style_class: 'kelp-sheet-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(caps);
        return row;
    }
}
