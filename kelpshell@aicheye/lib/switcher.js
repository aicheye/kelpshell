// SPDX-License-Identifier: GPL-3.0-or-later

// The window switcher (Alt+Tab, Super+Tab): one card with a live thumbnail
// of every window, most recently used first. Each item shows the app icon,
// the window title, the app name and the workspace the window is on. It replaces the shell's app
// switcher, which groups windows by app and shows icons only. On a strip of
// columns the thing to pick is a window, and it is easier to recognise by
// its picture.
//
// Hold the modifier and press Tab or the arrow keys to move. Releasing the
// modifier focuses the selection and the strip scrolls to it. W or F4 closes
// the selected window. Alt+` (switch-group) lists the focused app's windows.
//
// Key handling, the grab and the release detection come from the shell's
// SwitcherPopup. This file supplies the list and the look.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';

import {ShadowBin} from './backdrop.js';
import {Thumbnail} from './corners.js';
import {easeSettled} from './settle.js';
import {steadyLine} from './text.js';
import {isHelper} from './tiling.js';

const VERTICAL = Clutter.Orientation.VERTICAL;
const BINDINGS = [
    'switch-applications', 'switch-applications-backward',
    'switch-windows', 'switch-windows-backward',
    'switch-group', 'switch-group-backward',
];
const THUMB_HEIGHT = 176;      // px, before it is reduced to fit the monitor
const THUMB_MIN_HEIGHT = 48;
const THUMB_MAX_ASPECT = 1.7;  // a thumbnail is at most this much wider than high
const ITEM_MIN_WIDTH = 72;     // px, so a narrow window still has room for its icon
const FADE_MS = 90;
const SELECT_MS = 140;         // the selected thumbnail grows over this long
const UNSELECTED_SCALE = 0.9;
const ICON_SIZE = 32;          // px, the app icon over the thumbnail's bottom edge
const RING_WIDTH = 2;          // px, .kelp-switcher-ring border in stylesheet-dark.css
const UNSELECTED_OPACITY = 150;

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** Windows in most-recently-used order, as the shell's own switcher lists them. */
function recentWindows() {
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
        .map(w => w.is_attached_dialog() ? w.get_transient_for() : w)
        .filter((w, i, a) => w && !w.skip_taskbar && !isHelper(w) && a.indexOf(w) === i);
}

const SwitcherList = GObject.registerClass({
    Signals: {
        'item-activated': {param_types: [GObject.TYPE_INT]},
        'item-entered': {param_types: [GObject.TYPE_INT]},
        'item-removed': {param_types: [GObject.TYPE_INT]},
    },
}, class KelpSwitcherList extends ShadowBin {
    _init(windows, backdrop, monitor) {
        super._init({style_class: 'kelp-shadow kelp-shadow-launcher'});
        this._buttons = [];
        this._row = new St.BoxLayout({style_class: 'kelp-switcher-row'});
        // One caption for the whole row: the title of the selected window.
        // It asks for no width, so the card is as wide as the row for every
        // title. The label is given the width of the row, the text is in
        // the middle of it, and a longer title is cut off.
        this._caption = new St.Label({
            style_class: 'kelp-switcher-caption',
            min_width: 0,
            natural_width: 0,
        });
        steadyLine(this._caption);
        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-switcher',
            orientation: VERTICAL,
            reactive: true,
        });
        surface.add_child(this._row);
        surface.add_child(this._caption);
        this.child = surface;
        backdrop.attach(surface);

        const s = scaleFactor();
        // Reduce the thumbnail height until the row fits the monitor.
        const avail = monitor.width - 96 * s;
        let height = THUMB_HEIGHT * s;
        const rowWidth = h => windows.reduce((sum, win) => {
            const frame = win.get_frame_rect();
            const w = Math.min(h * THUMB_MAX_ASPECT, frame.width * h / Math.max(1, frame.height));
            return sum + Math.max(ITEM_MIN_WIDTH * s, w + 2 * RING_WIDTH * s) + 24 * s;
        }, 20 * s);
        while (height > THUMB_MIN_HEIGHT * s && rowWidth(height) > avail)
            height -= 8 * s;

        const tracker = Shell.WindowTracker.get_default();
        for (const win of windows)
            this._row.add_child(this._buildItem(win, tracker.get_window_app(win), height, s));
    }

    _buildItem(win, app, height, s) {
        const frame = win.get_frame_rect();
        const buffer = win.get_buffer_rect();
        const k = Math.min(height / Math.max(1, frame.height),
            height * THUMB_MAX_ASPECT / Math.max(1, frame.width));
        const thumb = new St.Widget({
            style_class: 'kelp-switcher-thumb',
            clip_to_allocation: true,
            width: Math.round(frame.width * k),
            height: Math.round(frame.height * k),
        });
        // The surface and not the window actor: a tiled window's actor is
        // clipped to the view, and a column out of view is clipped to nothing.
        const source = win.get_compositor_private()?.get_first_child();
        if (source) {
            const clone = new Thumbnail({
                source,
                x: Math.round((buffer.x - frame.x) * k),
                y: Math.round((buffer.y - frame.y) * k),
                width: Math.round(buffer.width * k),
                height: Math.round(buffer.height * k),
            });
            thumb.add_child(clone);
        }

        // The thumbnail in a border that takes the accent colour when the
        // item is selected. A window on another workspace has that
        // workspace's number in the corner.
        const ring = new St.Widget({
            style_class: 'kelp-switcher-ring',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            y_expand: true,
        });
        ring.add_child(thumb);
        const workspace = win.is_on_all_workspaces() ? null : win.get_workspace();
        if (workspace && workspace !== global.workspace_manager.get_active_workspace()) {
            const badge = new St.Label({
                text: `${workspace.index() + 1}`,
                style_class: 'kelp-switcher-ws',
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
            });
            ring.add_child(badge);
        }

        // The app icon sits half over the bottom edge of the thumbnail.
        const iconSize = ICON_SIZE;
        const icon = app
            ? app.create_icon_texture(iconSize)
            : new St.Icon({icon_name: 'application-x-executable', icon_size: iconSize});
        icon.set({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            translation_y: Math.round(iconSize * s / 2),
        });
        // Thumbnail and icon grow together when the item is selected.
        const frameBox = new St.Widget({
            height: height + 2 * RING_WIDTH * s,
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            scale_x: UNSELECTED_SCALE,
            scale_y: UNSELECTED_SCALE,
        });
        frameBox.set_pivot_point(0.5, 0.5);
        frameBox.add_child(ring);
        frameBox.add_child(icon);

        const button = new St.Button({
            style_class: 'kelp-switcher-item',
            child: frameBox,
            width: Math.max(ITEM_MIN_WIDTH * s, thumb.width + 2 * RING_WIDTH * s) + 16 * s,
        });
        button._frame = frameBox;
        button._title = win.get_title() || app?.get_name() || '';
        button._thumb = thumb;
        thumb.opacity = UNSELECTED_OPACITY;
        button.connect('clicked', () => this.emit('item-activated', this._buttons.indexOf(button)));
        button.connect('motion-event', () => {
            this.emit('item-entered', this._buttons.indexOf(button));
            return Clutter.EVENT_PROPAGATE;
        });
        this._buttons.push(button);
        return button;
    }

    highlight(index) {
        this._buttons.forEach((button, i) => {
            const selected = i === index;
            if (selected)
                button.add_style_pseudo_class('selected');
            else
                button.remove_style_pseudo_class('selected');
            // The other thumbnails are dimmed and smaller, so the selection
            // stands out.
            button._thumb.ease({
                opacity: selected ? 255 : UNSELECTED_OPACITY,
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            const scale = selected ? 1 : UNSELECTED_SCALE;
            button._frame.ease({
                scale_x: scale,
                scale_y: scale,
                duration: SELECT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
        this._caption.text = this._buttons[index]?._title ?? '';
    }

    removeItem(index) {
        const [button] = this._buttons.splice(index, 1);
        button?.destroy();
        this.emit('item-removed', index);
    }
});

const WindowSwitcher = GObject.registerClass(
class KelpWindowSwitcher extends SwitcherPopup.SwitcherPopup {
    _init(windows, backdrop, monitor) {
        super._init(windows);
        this._monitor = monitor;
        this._switcherList = new SwitcherList(windows, backdrop, monitor);
        for (const win of windows)
            win.connectObject('unmanaging', () => this._removeWindow(win), this);
    }

    // The base class puts the list in the middle of the primary monitor.
    // This is the same placement on the monitor the switcher was opened on.
    vfunc_allocate(box) {
        this.set_allocation(box);
        const m = this._monitor;
        const node = this.get_theme_node();
        const left = node.get_padding(St.Side.LEFT);
        const right = node.get_padding(St.Side.RIGHT);
        const [, height] = this._switcherList.get_preferred_height(m.width - left - right);
        const [, width] = this._switcherList.get_preferred_width(height);
        const x1 = Math.max(m.x + left, m.x + Math.floor((m.width - width) / 2));
        const x2 = Math.min(m.x + m.width - right, x1 + width);
        const y1 = m.y + Math.floor((m.height - height) / 2);
        this._switcherList.allocate(new Clutter.ActorBox({x1, y1, x2, y2: y1 + height}));
    }

    _removeWindow(win) {
        const index = this._items.indexOf(win);
        if (index < 0)
            return;
        win.disconnectObject(this);
        this._items.splice(index, 1);
        this._switcherList.removeItem(index);
    }

    // The base class shows the popup at full opacity in one step.
    _showImmediately() {
        if (this._initialDelayTimeoutId === 0)
            return;
        GLib.source_remove(this._initialDelayTimeoutId);
        this._initialDelayTimeoutId = 0;
        Main.osdWindowManager.hideAll();
        // Once the thumbnails have been drawn, see settle.js.
        easeSettled(this, {
            opacity: 255,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _keyPressHandler(keysym, action) {
        const A = Meta.KeyBindingAction;
        if (action === A.SWITCH_APPLICATIONS || action === A.SWITCH_WINDOWS ||
            action === A.SWITCH_GROUP)
            this._select(this._next());
        else if (action === A.SWITCH_APPLICATIONS_BACKWARD ||
            action === A.SWITCH_WINDOWS_BACKWARD || action === A.SWITCH_GROUP_BACKWARD)
            this._select(this._previous());
        else if (keysym === Clutter.KEY_Right || keysym === Clutter.KEY_Down)
            this._select(this._next());
        else if (keysym === Clutter.KEY_Left || keysym === Clutter.KEY_Up)
            this._select(this._previous());
        else if (keysym === Clutter.KEY_w || keysym === Clutter.KEY_W ||
            keysym === Clutter.KEY_F4)
            this._items[this._selectedIndex]?.delete(global.get_current_time());
        else
            return Clutter.EVENT_PROPAGATE;

        return Clutter.EVENT_STOP;
    }

    _finish(timestamp) {
        const win = this._items[this._selectedIndex];
        if (win)
            Main.activateWindow(win);
        super._finish(timestamp);
    }

    _onDestroy() {
        for (const win of this._items)
            win.disconnectObject(this);
        super._onDestroy();
    }
});

export class Switcher {
    constructor({backdrop, tiling}) {
        this._backdrop = backdrop;
        this._tiling = tiling;
    }

    enable() {
        for (const name of BINDINGS) {
            Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL,
                (_display, _window, _event, binding) => this._start(binding));
        }
    }

    disable() {
        this._popup?.destroy();
        this._popup = null;
        for (const name of BINDINGS) {
            Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL,
                Main.wm._startSwitcher.bind(Main.wm));
        }
    }

    _start(binding) {
        const name = binding.get_name();
        let windows = recentWindows();
        if (name.startsWith('switch-group')) {
            const tracker = Shell.WindowTracker.get_default();
            const app = tracker.get_window_app(global.display.focus_window);
            windows = windows.filter(w => tracker.get_window_app(w) === app);
        }
        this._popup?.destroy();
        // On the monitor that is worked on, as the launcher is.
        const monitor = Main.layoutManager.monitors[this._tiling.activeMonitor] ??
            Main.layoutManager.primaryMonitor;
        const popup = new WindowSwitcher(windows, this._backdrop, monitor);
        this._popup = popup;
        popup.connect('destroy', () => {
            if (this._popup === popup)
                this._popup = null;
        });
        if (!popup.show(binding.is_reversed(), name, binding.get_mask()))
            popup.destroy();
    }
}
