// SPDX-License-Identifier: GPL-3.0-or-later

// Changes to the stock shell: hide the top bar, replace the overview with
// the launcher, stack workspaces vertically, move notification banners, and
// re-anchor the calendar and quick settings popups to the sidebar.
// Everything here is undone in disable().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ShadowBin} from './backdrop.js';
import {SWIPE_FINGERS as LAUNCHER_FINGERS} from './launcher.js';
import {Overrides} from './overrides.js';
import {holdTransitions} from './settle.js';
import {pointerDelta} from './swipe.js';
import {endRehearsal} from './warm.js';

// The shell's time for its own opening animation (STARTUP_ANIMATION_TIME in layout.js).
const STARTUP_MS = 500;

// The swipe that slides the workspaces, as in the shell's swipeTracker.js:
// its least number of fingers, and the touchpad units travelled before the
// axis is decided.
const WORKSPACE_FINGERS = 3;
const WORKSPACE_SWIPE_DISTANCE = 16;
// Fingers that rested this long before lifting have no velocity, as in
// lib/tiling.js.
const WORKSPACE_REST_MS = 80;

// px between the edges of a tiled window and the edges of a banner over it.
const BANNER_INSET = 12;

const BANNER_ALIGN = {
    left: Clutter.ActorAlign.START,
    center: Clutter.ActorAlign.CENTER,
    right: Clutter.ActorAlign.END,
};

export class Tweaks {
    constructor(config, backdrop) {
        this._config = config;
        this._backdrop = backdrop;
        this._menus = new Map();   // menu -> original anchoring
        this._sources = new Set(); // sidebar actors a popup was opened from
        this._menuWraps = new Map();   // popup content box -> {wrapper, bin}
        this._overrides = new Overrides();
        this._cornerHooks = new Map();   // hot corner -> id of its 'trigger' handler
        // Called when the Super key is tapped or a hot corner is hit, with
        // the monitor of that corner, or -1 for the key.
        this.onSuper = null;
    }

    enable() {
        // A hidden chrome actor still reserves its screen edge, and the shell
        // shows the panel again after every fullscreen change. Turn both off
        // in the layout manager's record for the panel.
        const panelBox = Main.layoutManager.panelBox;
        this._panelRecord = Main.layoutManager._trackedActors?.find(a => a.actor === panelBox);
        if (this._panelRecord) {
            this._panelSaved = {
                affectsStruts: this._panelRecord.affectsStruts,
                trackFullscreen: this._panelRecord.trackFullscreen,
            };
            this._panelRecord.affectsStruts = false;
            this._panelRecord.trackFullscreen = false;
        }
        panelBox.hide();
        panelBox.connectObject('notify::visible', () => {
            if (panelBox.visible)
                panelBox.hide();
        }, this);
        Main.layoutManager._queueUpdateRegions();

        this._applySettings();
        this._replaceOverview();
        Main.layoutManager.connectObject(
            'hot-corners-changed', () => this._hookHotCorners(), this);
        this._hookHotCorners();

        this._bannerAlign = Main.messageTray.bannerAlignment;
        this.apply();

        // Notification banners get the card material as they appear. The
        // banner slides in, so its position is read again once it has settled.
        // The banner cannot be wrapped (the message tray owns it), so its
        // shadow is a flat sibling under it. See .kelp-shadow in the stylesheet.
        const bannerBin = Main.messageTray._bannerBin;
        bannerBin?.connectObject(
            'child-added', (_bin, banner) => {
                if (banner === this._bannerShadow)
                    return;
                this._bannerShadow?.destroy();
                const shadow = new St.Widget({
                    style_class: 'kelp-shadow kelp-shadow-banner',
                    x_expand: true,
                    y_expand: true,
                });
                this._bannerShadow = shadow;
                this._banner = banner;
                bannerBin.insert_child_below(shadow, banner);
                banner.add_style_class_name('kelp-banner');
                // A tiled window is layout.gap from the screen edge. The
                // banner is BANNER_INSET further in, so its edges do not
                // lie on the window's edges.
                const margin =
                    `margin: ${this._config.values.layout.gap + BANNER_INSET}px;`;
                shadow.style = margin;
                this._backdrop.attach(banner, `${margin} `);
                banner.connectObject('destroy', () => {
                    if (this._banner === banner)
                        this._banner = null;
                    // The shadow of an earlier banner went when this one
                    // was added.
                    if (this._bannerShadow === shadow) {
                        this._bannerShadow = null;
                        shadow.destroy();
                    }
                }, this);
            },
            'transitions-completed', () => {
                if (this._banner)
                    this._backdrop.update(this._banner);
            },
            this);
        // The banner's own animation starts once its first frame is drawn,
        // see settle.js. The message tray creates the transitions after it
        // has added the banner, so they are looked for before the next
        // frame. Without this the first banner after a login takes a step
        // of 35% of the way in one frame.
        bannerBin?.connectObject('child-added', (_bin, banner) => {
            if (banner === this._bannerShadow || this._bannerHoldId)
                return;
            this._bannerHoldId = global.compositor.get_laters().add(
                Meta.LaterType.BEFORE_REDRAW, () => {
                    this._bannerHoldId = 0;
                    holdTransitions(bannerBin, ['opacity', 'y', 'scale-x', 'scale-y']);
                    return GLib.SOURCE_REMOVE;
                });
        }, this);

        this._styleMenus(true);

        // The shell is dark unless the "color-scheme" setting is
        // "prefer-light", so with the light style of Settings ("default")
        // it stays dark. With this session value it is light for "default"
        // too and dark for "prefer-dark". The shell then loads its own
        // light theme and this extension's stylesheet-light.css.
        this._colorScheme = Main.sessionMode.colorScheme;
        Main.sessionMode.colorScheme = 'prefer-light';
        St.Settings.get().notify('color-scheme');
    }

    /**
     * GNOME settings that are set while the extension is enabled. Edge
     * tiling is off: dragging a window to a screen edge would show the
     * half-screen preview and then resize the window on drop. The hot
     * corner follows launcher.hotCorner: the shell's hot corner toggles the
     * overview, and that call opens the launcher, see _replaceOverview.
     */
    _applySettings() {
        this._hotCorner = !!this._config.values.launcher.hotCorner;
        this._overrides.apply([
            {
                schema: 'org.gnome.mutter', key: 'edge-tiling',
                value: GLib.Variant.new_boolean(false),
            },
            {
                schema: 'org.gnome.desktop.interface', key: 'enable-hot-corners',
                value: GLib.Variant.new_boolean(this._hotCorner),
            },
        ]);
    }

    /**
     * The shell's hot corner plays its ripple only while the overview is
     * opening or closing, and here the overview never opens: the corner
     * opens the launcher. The ripple is played from here, on the same
     * trigger and under the conditions the shell checks before it toggles
     * the overview. The shell makes its corners again when the monitors or
     * the setting change.
     *
     * A corner triggers on two pointer barriers, as long as the top bar is
     * high. The shell makes a corner without them and adds them when the
     * top bar gets its allocation. A hidden bar gets none, so a corner made
     * while the bar is hidden has no barriers and never triggers: that is
     * every corner of a session that starts with the extension enabled.
     * Those corners get their barriers here.
     */
    _hookHotCorners() {
        for (const corner of this._cornerHooks.keys()) {
            if (!corner._pressureBarrier)
                this._cornerHooks.delete(corner);
        }
        const size = Main.layoutManager.panelBox.height;
        for (const corner of Main.layoutManager.hotCorners) {
            const barrier = corner?._pressureBarrier;
            if (!barrier)
                continue;
            if (!corner._verticalBarrier && size > 0)
                corner.setBarrierSize(size);
            if (this._cornerHooks.has(corner))
                continue;
            this._cornerHooks.set(corner, barrier.connect('trigger', () => {
                if (corner._monitor?.inFullscreen ||
                    !Main.overview.shouldToggleByCornerOrButton())
                    return;
                corner._ripples?.playAnimation(corner._x, corner._y);
            }));
        }
    }

    /**
     * The monitor of the hot corner the pointer is pushed into, or -1. The
     * shell's corner calls overview.toggle() with nothing that says which
     * corner it was, and each monitor can have one. Without this the
     * launcher would open on the monitor of the last click, which can be
     * another one.
     */
    _cornerMonitor() {
        const [x, y] = global.get_pointer();
        for (const corner of Main.layoutManager.hotCorners) {
            if (corner?._monitor && Math.abs(x - corner._x) <= 2 && Math.abs(y - corner._y) <= 2)
                return corner._monitor.index;
        }
        return -1;
    }

    _unhookHotCorners() {
        for (const [corner, id] of this._cornerHooks)
            corner._pressureBarrier?.disconnect(id);
        this._cornerHooks.clear();
    }

    /**
     * The overview's window picker, app grid and search repeat what the
     * minimap and the launcher do, so the overview never opens. The Super
     * key, which toggles it, toggles the launcher. Its methods are replaced
     * on the instance, so deleting them in disable() brings the originals
     * back.
     */
    _replaceOverview() {
        const overview = Main.overview;
        if (Main.layoutManager._startingUp)
            this._openSession();
        if (overview.visible)
            overview.hide();
        overview.toggle = () => this.onSuper?.(this._cornerMonitor());
        overview.show = () => {};
        // The three-finger swipe up enters the overview without show().
        if (overview._swipeTracker)
            overview._swipeTracker.enabled = false;
        // Super also closes the launcher, which holds a modal grab.
        Main.wm.allowKeybinding('overlay-key', Shell.ActionMode.NORMAL |
            Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP);
    }

    /**
     * The start of a session: every monitor fades from the shell's grey
     * system background to the desktop, at the same time.
     *
     * Left alone, the shell starts a session in the overview. That hides the
     * windows and the wallpaper of the primary monitor behind the overview's
     * dark background, and keeps the wallpaper of every other monitor hidden
     * until the overview's opening animation is over, about 1.7 s. Those
     * wallpapers then fade in over another second.
     *
     * The extension is enabled at some point during that. Measured in
     * GNOME 51, it is after 'startup-prepared', while the overview's
     * animation runs. The case before 'startup-prepared' is handled too:
     * there the shell is told the session has no overview, and it fades the
     * desktop in itself.
     */
    _openSession() {
        const layout = Main.layoutManager;
        const ui = layout.uiGroup;
        // Everything the shell draws is in this group. While it is
        // transparent every monitor shows the grey behind it. The shell
        // removes its grey when its own animation ends, so this one stays
        // until the fade is over.
        ui.opacity = 0;
        const backdrop = new Background.SystemBackground();
        backdrop.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        global.stage.insert_child_below(backdrop, null);
        this._startupBackdrop = backdrop;

        // The shell keeps the wallpapers of the other monitors hidden and
        // clips the windows to the primary monitor until its animation is
        // over, and it starts a session without an overview at 75% size.
        const reveal = () => {
            ui.set_scale(1, 1);
            global.window_group.remove_clip();
            for (const manager of layout._bgManagers ?? []) {
                const actor = manager.backgroundActor;
                actor.remove_all_transitions();
                actor.show();
                actor.opacity = 255;
            }
        };

        if (Main.sessionMode.hasOverview) {
            Main.sessionMode.hasOverview = false;
            this._startupOverview = true;
        }
        if (Main.overview.visible) {
            // The overview is opening. Its group is made transparent, and
            // the windows it hid are shown, until _replaceOverview() has
            // closed it.
            layout.overviewGroup.opacity = 0;
            Main.overview.connectObject('hidden', () => this._showOverviewGroup(), this);
            global.window_group.show();
            global.top_window_group.show();
            reveal();
            ui.ease({
                opacity: 255,
                duration: STARTUP_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this._endSessionOpening(),
            });
            this._stopOverviewOpening();
        } else {
            layout.connectObject('startup-prepared', () => {
                ui.opacity = 0;
                reveal();
            }, this);
        }
        layout.connectObject('startup-complete', () => {
            // The shell has just set the other monitors' wallpapers to
            // transparent, to fade them in over a second.
            reveal();
            this._restoreStartupOverview();
            if (!ui.get_transition('opacity'))
                this._endSessionOpening();
        }, this);
    }

    _endSessionOpening() {
        Main.layoutManager.uiGroup.opacity = 255;
        this._startupBackdrop?.destroy();
        this._startupBackdrop = null;
    }

    /**
     * The shell blocks input and key bindings until the last part of the
     * overview's opening animation is over, a second after it starts. The
     * parts are stopped, so that is now. The shell starts them at the first
     * frame, which can be after the extension is enabled, so this is called
     * again when the overview has closed.
     */
    _stopOverviewOpening() {
        const controls = Main.overview._overview?.controls;
        for (const actor of [controls, controls?._searchEntryBin, controls?.dash])
            actor?.remove_all_transitions();
    }

    _showOverviewGroup() {
        Main.overview.disconnectObject(this);
        Main.layoutManager.overviewGroup.opacity = 255;
        if (Main.layoutManager._startingUp)
            this._stopOverviewOpening();
    }

    _restoreStartupOverview() {
        if (this._startupOverview)
            Main.sessionMode.hasOverview = true;
        this._startupOverview = false;
    }

    _restoreOverview() {
        const overview = Main.overview;
        this._restoreStartupOverview();
        this._showOverviewGroup();
        if (this._startupBackdrop) {
            Main.layoutManager.uiGroup.remove_transition('opacity');
            this._endSessionOpening();
        }
        delete overview.toggle;
        delete overview.show;
        if (overview._swipeTracker)
            overview._swipeTracker.enabled = true;
        Main.wm.allowKeybinding('overlay-key',
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
    }

    /**
     * The shell's three-finger swipe switches workspaces along one axis.
     * With workspaces stacked vertically it takes vertical swipes and the
     * strip takes horizontal ones. With workspaces in a row both would want
     * the horizontal swipe, so the shell's gesture is detached and the strip
     * keeps it. Super + scroll switches workspaces either way.
     *
     * The shell's gesture takes a swipe of three fingers or more. Here
     * four-finger swipes are kept from it while they open the launcher
     * (gestures.launcherSwipe), and the others slide the workspaces as far
     * as the pointer would move, see _onWorkspaceSwipe.
     *
     * how is 'vertical', 'detached', or 'stock' for the shell's own
     * connection.
     */
    _syncWorkspaceGesture(how) {
        const tracker = Main.wm._workspaceAnimation?._swipeTracker;
        const gesture = tracker?._touchpadGesture;
        if (!gesture?._handleEvent || how === this._workspaceGesture)
            return;
        this._workspaceGesture = how;
        // A swipe that slides the workspaces now ends where it began.
        if (this._workspaceSwipe?.handling && tracker._state && typeof tracker._interrupt === 'function')
            tracker._interrupt();
        this._workspaceSwipe = null;
        global.stage.disconnectObject(gesture);
        if (how === 'detached')
            return;
        const handle = gesture._handleEvent.bind(gesture);
        if (how === 'stock') {
            global.stage.connectObject('event::touchpad', handle, gesture);
            return;
        }
        // Without the tracker's handlers of this version, the shell's own
        // gesture with its own distance.
        const own = ['_beginTouchpadGesture', '_updateTouchpadGesture', '_endTouchpadGesture']
            .every(name => typeof tracker[name] === 'function');
        global.stage.connectObject('event::touchpad', (actor, event) => {
            if (this._isLauncherSwipe(event))
                return Clutter.EVENT_PROPAGATE;
            return own ? this._onWorkspaceSwipe(tracker, gesture, event) : handle(actor, event);
        }, gesture);
        tracker.orientation = Clutter.Orientation.VERTICAL;
    }

    /**
     * A swipe up or down slides the workspaces as far as the pointer would
     * move for the same movement of the fingers, see lib/swipe.js.
     *
     * The shell's gesture (TouchpadSwipeGesture in swipeTracker.js) tells
     * its tracker the movement in touchpad units, and that 300 of them are
     * one workspace: 5.1 px per unit on a monitor 1440 px high, whatever
     * the speed of the pointer is set to. This is that gesture with
     * the movement in px and the px from one workspace to the next as the
     * length, which the workspace animation gives the tracker when the
     * swipe begins (tracker.distance). Which swipes it takes, the axis and
     * the fling at the end are the shell's.
     *
     * Fingers that rest before they lift leave the workspaces at the
     * nearer one. The shell's tracker keeps the speed of the last movement
     * however long ago that was (EventHistory.trim() drops nothing when
     * every entry is old), so a slow drag of a tenth of the way, held and
     * let go, would go on to the next workspace.
     */
    _onWorkspaceSwipe(tracker, gesture, event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;
        const phase = event.get_gesture_phase();
        if (phase === Clutter.TouchpadGesturePhase.BEGIN)
            this._workspaceSwipe = {handling: false, ignored: false, dx: 0, dy: 0, monitor: -1, moved: 0};
        const s = this._workspaceSwipe;
        if (!s || s.ignored ||
            event.get_touchpad_gesture_finger_count() < WORKSPACE_FINGERS ||
            (gesture._allowedModes & Main.actionMode) === 0 || !gesture.enabled)
            return Clutter.EVENT_PROPAGATE;

        const time = event.get_time();
        if (!s.handling) {
            const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();
            s.dx += dx;
            s.dy += dy;
            if (Math.hypot(s.dx, s.dy) < WORKSPACE_SWIPE_DISTANCE)
                return Clutter.EVENT_PROPAGATE;
            if (Math.abs(s.dx) > Math.abs(s.dy)) {
                s.ignored = true;
                return Clutter.EVENT_PROPAGATE;
            }
            s.handling = true;
            const [x, y] = event.get_coords();
            s.monitor = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({x, y, width: 1, height: 1}));
            tracker._beginTouchpadGesture(gesture, time, x, y);
        }

        if (phase === Clutter.TouchpadGesturePhase.END ||
            phase === Clutter.TouchpadGesturePhase.CANCEL) {
            this._workspaceSwipe = null;
            if (time - s.moved > WORKSPACE_REST_MS)
                tracker._history?.reset?.();
            tracker._endTouchpadGesture(gesture, time, tracker.distance);
            return Clutter.EVENT_PROPAGATE;
        }
        s.moved = time;
        const [, py] = pointerDelta(event, s.monitor, this._config);
        const natural = gesture._touchpadSettings?.get_boolean('natural-scroll');
        tracker._updateTouchpadGesture(gesture, time, natural ? -py : py, tracker.distance);
        return Clutter.EVENT_STOP;
    }

    /** True for a touchpad event that lib/launcher.js handles: a four-finger swipe. */
    _isLauncherSwipe(event) {
        return this._config.values.gestures.launcherSwipe &&
            event.type() === Clutter.EventType.TOUCHPAD_SWIPE &&
            event.get_touchpad_gesture_finger_count() === LAUNCHER_FINGERS;
    }

    /**
     * Give the calendar and quick settings popups the card material. The
     * popup's content box moves into a wrapper that draws the material and
     * the shadow under it (see ShadowBin in lib/backdrop.js for why the box
     * does not draw them itself). The box keeps its border and has no
     * background. The wrapper sits where the box was, inside the popup's
     * bin.
     */
    _styleMenus(on) {
        for (const role of ['dateMenu', 'quickSettings']) {
            const menu = Main.panel.statusArea[role]?.menu;
            const box = menu?.box;
            const bin = menu?._boxPointer?.bin;
            if (!box || !bin)
                continue;
            const wrapped = this._menuWraps.get(box);
            if (on && !wrapped) {
                bin.set_child(null);
                const wrapper = new ShadowBin({
                    style_class: `kelp-shadow kelp-shadow-${role.toLowerCase()}`,
                    child: box,
                });
                bin.set_child(wrapper);
                wrapper.setMaterial(this._backdrop);
                this._menuWraps.set(box, {wrapper, bin});
                box.add_style_class_name('kelp-menu');
            } else if (!on && wrapped) {
                box.remove_style_class_name('kelp-menu');
                wrapped.wrapper.set_child(null);
                wrapped.bin.set_child(box);
                wrapped.wrapper.destroy();
                this._menuWraps.delete(box);
            }
        }
    }

    /** Apply the parts that depend on the config. */
    apply() {
        const v = this._config.values;
        Main.messageTray.bannerAlignment =
            BANNER_ALIGN[v.notifications.bannerPosition] ?? Clutter.ActorAlign.END;
        this._setWorkspaceLayout(v.layout.verticalWorkspaces);
        if (!!v.launcher.hotCorner !== this._hotCorner)
            this._applySettings();
    }

    _setWorkspaceLayout(vertical) {
        this._syncWorkspaceGesture(vertical ? 'vertical' : 'detached');
        if (vertical) {
            global.workspace_manager.override_workspace_layout(
                Meta.DisplayCorner.TOPLEFT, false, -1, 1);
        } else {
            global.workspace_manager.override_workspace_layout(
                Meta.DisplayCorner.TOPLEFT, false, 1, -1);
        }
    }

    disable() {
        // The popups go back to their top bar buttons first. Showing the bar
        // further down makes each popup look at its source actor, and the
        // sidebar card it was anchored to is already destroyed.
        for (const [menu, saved] of this._menus) {
            menu.disconnectObject(this);
            menu.close();
            // A popup that was closed a moment ago is still fading out:
            // the Lock button of quick settings closes the popup and locks
            // the screen in one go. Left to fade, it would be drawn for
            // those 150 ms where the lines below put it, at the top left
            // corner of the monitor, and in the shell's grey without the
            // material. So it is hidden.
            const pointer = menu._boxPointer;
            if (pointer?.visible) {
                pointer.remove_all_transitions();
                pointer.hide();
                pointer.opacity = 0;
                pointer.translation_x = pointer.translation_y = 0;
            }
            menu.sourceActor = saved.sourceActor;
            menu._arrowAlignment = saved.alignment;
            menu._boxPointer.setSourceAlignment(0.5);
            menu._boxPointer.updateArrowSide(saved.side);
            menu._boxPointer.style = saved.style;
            saved.anchor?.destroy();
            if (saved.handler)
                saved.handler.record.callback = saved.handler.original;
        }
        this._menus.clear();
        for (const source of this._sources)
            source.disconnectObject(this);
        this._sources.clear();
        this._styleMenus(false);

        // Only what enable() got as far as saving is put back.
        if (this._colorScheme !== undefined) {
            Main.sessionMode.colorScheme = this._colorScheme;
            this._colorScheme = undefined;
            St.Settings.get().notify('color-scheme');
        }
        Main.layoutManager.disconnectObject(this);
        this._unhookHotCorners();
        this._restoreOverview();
        this._overrides.restore();
        Main.messageTray._bannerBin?.disconnectObject(this);
        if (this._bannerHoldId)
            global.compositor.get_laters().remove(this._bannerHoldId);
        this._bannerHoldId = 0;
        // A banner that is on the screen now is the shell's again.
        this._banner?.disconnectObject(this);
        this._banner?.remove_style_class_name('kelp-banner');
        this._bannerShadow?.destroy();
        this._bannerShadow = this._banner = null;
        const panelBox = Main.layoutManager.panelBox;
        panelBox.disconnectObject(this);
        if (this._panelRecord)
            Object.assign(this._panelRecord, this._panelSaved);
        this._panelRecord = null;
        // As the shell shows it: not over a fullscreen window.
        panelBox.visible = !(global.window_group.visible &&
            Main.layoutManager.primaryMonitor?.inFullscreen);
        Main.layoutManager._queueUpdateRegions();

        if (this._bannerAlign !== undefined)
            Main.messageTray.bannerAlignment = this._bannerAlign;
        this._bannerAlign = undefined;
        global.workspace_manager.override_workspace_layout(
            Meta.DisplayCorner.TOPLEFT, false, 1, -1);

        // Workspaces are in a row again: the shell's swipe is horizontal.
        this._syncWorkspaceGesture('stock');
        const tracker = Main.wm._workspaceAnimation?._swipeTracker;
        if (tracker)
            tracker.orientation = Clutter.Orientation.HORIZONTAL;
    }

    /**
     * Open or close a panel menu next to a sidebar actor.
     * alignment: 0 lines the popup's top up with the actor, 1 its bottom.
     */
    toggleMenu(menu, source, alignment) {
        if (!menu)
            return;
        if (menu.isOpen) {
            menu.close();
            return;
        }
        // Its turn in lib/warm.js ends: it is shown on the screen.
        endRehearsal(menu.actor);
        this._point(menu, source, alignment);
        menu.open();
        // The popup's own animation, once its first frame is drawn. See
        // settle.js.
        holdTransitions(menu._boxPointer,
            ['opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y']);
    }

    /**
     * The top bar button of a popup sets the popup's inline style on every
     * open and close ("max-height" of the work area). The style this file
     * needs is another one, and St drops the style of every actor in the
     * popup, with the backgrounds it has drawn for them, each time the
     * inline style of the popup changes. Opening the calendar then costs
     * one frame of 17 to 19 ms to draw them again, and closing it one of 15
     * to 18 ms for a new layout. The button's handler is replaced by one
     * that only marks the button as active, which is the other thing it
     * does.
     *
     * The handler is found in the signal list the menu keeps (gjs
     * modules/core/_signals.js). Returns what disable() needs to put it
     * back, or null when it was not found.
     */
    _takeButtonHandler(menu) {
        const button = menu.sourceActor;
        const record = Object.values(menu._signalConnections ?? {}).find(c =>
            c.name === 'open-state-changed' && c.callback?.name === 'bound _onOpenStateChanged');
        if (!record || !button)
            return null;
        const original = record.callback;
        record.callback = (_menu, open) => {
            if (open)
                button.add_style_pseudo_class('active');
            else
                button.remove_style_pseudo_class('active');
        };
        return {record, original};
    }

    /**
     * A popup is placed next to the actor it was opened from only while
     * that actor is shown. The notifications card hides when the last
     * notification is closed, and the calendar opened from it would then
     * go to the top left corner of the screen, still open. When the actor
     * hides, an empty actor of the same place and size takes over as the
     * one the popup follows, so the popup stays where it is. It is kept
     * until the popup is opened again: the popup still needs it while it
     * fades out.
     *
     * The empty actor is given its allocation here. The popup reads the
     * allocation of the actor it follows when it is laid out, and it is
     * laid out before an actor that was added after it. An actor that has
     * never been laid out reports a box from +infinity to -infinity. The
     * popup's place then comes out as NaN, and Clutter refuses that box
     * and gives what is in the popup no size. The calendar and the message
     * list are then drawn without the card under them, and stay on the
     * screen after the popup has closed, because an actor of no size
     * redraws nothing (seen with the calendar open as the last
     * notification was cleared).
     */
    _watchSource(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notify::mapped', () => {
                if (source.mapped)
                    return;
                for (const [menu, saved] of this._menus) {
                    if (menu.sourceActor !== source || !menu.isOpen)
                        continue;
                    // The size from the allocation: a hidden actor reports
                    // its natural size as its transformed size.
                    const [x, y] = source.get_transformed_position();
                    const [width, height] = source.get_allocation_box().get_size();
                    saved.anchor = new St.Widget({reactive: false, x, y, width, height});
                    Main.layoutManager.uiGroup.add_child(saved.anchor);
                    saved.anchor.allocate(new Clutter.ActorBox({
                        x1: x, y1: y, x2: x + width, y2: y + height,
                    }));
                    menu.sourceActor = saved.anchor;
                    menu._boxPointer.setPosition(saved.anchor, menu._arrowAlignment);
                }
            },
            'destroy', () => this._sources.delete(source),
            this);
    }

    /**
     * Inline style for a popup opened from the sidebar.
     *
     * -arrow-rise: the popup's distance from the sidebar, and the least
     * distance the box pointer keeps between the popup and the top and
     * bottom of the work area. Two layout gaps put the popup one gap inside
     * the leftmost window on both axes. At one gap its corner would sit on
     * the window's corner, and the two different radii would touch. The
     * shell theme's own distance is 6px.
     *
     * max-height: the top bar button allows the whole work area. With the
     * top bar hidden that is the monitor height, and a popup that tall is
     * placed with its top above the screen. The limit is the work area less
     * the distance above at each end.
     *
     * margin-bottom: the shell theme's bottom margin for top bar menus
     * (1.75em) would add to the height.
     */
    _styleMenu(menu) {
        const inset = 2 * this._config.values.layout.gap;
        const index = Main.layoutManager.findIndexForActor(menu.sourceActor);
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const maxHeight = Math.floor(area.height / scale) - 2 * inset;
        menu._boxPointer.style =
            `max-height: ${maxHeight}px; margin-bottom: 0; -arrow-rise: ${inset}px;`;
    }

    /** Everything toggleMenu() gives a panel menu before it opens it. */
    _point(menu, source, alignment) {
        this._adopt(menu);
        this._watchSource(source);
        const saved = this._menus.get(menu);
        saved.anchor?.destroy();
        saved.anchor = null;
        menu.sourceActor = source;
        menu._arrowAlignment = alignment;
        menu._boxPointer.setSourceAlignment(alignment);
        menu._boxPointer.updateArrowSide(St.Side.LEFT);
        this._styleMenu(menu);
    }

    /** Keep what disable() puts back on a panel menu, the first time it is used here. */
    _adopt(menu) {
        if (this._menus.has(menu))
            return;
        this._menus.set(menu, {
            sourceActor: menu.sourceActor,
            alignment: menu._arrowAlignment,
            side: menu._boxPointer._userArrowSide,
            style: menu._boxPointer.style,
            handler: this._takeButtonHandler(menu),
        });
        // Where the button's handler could not be replaced, it still
        // sets the popup's inline style on every open and close. This
        // handler is connected after the button's, so it runs after it
        // and puts the style below back both times. Without the close,
        // the popup grows and jumps while it fades out.
        menu.connectObject('open-state-changed', () => {
            // Opened by something else than toggleMenu(), a key of the
            // shell for example, during its turn in lib/warm.js.
            if (menu.isOpen)
                endRehearsal(menu.actor);
            this._styleMenu(menu);
        }, this);
    }

    /**
     * For lib/warm.js: the calendar popup ('dateMenu') or the quick
     * settings popup ('quickSettings') as toggleMenu() opens it next to
     * source, not shown. null while it is open.
     *
     * The arrow side, the place and the style are set as toggleMenu() sets
     * them. The popup is laid out for the side its arrow is on, and St
     * drops the styles of every actor in a popup when the popup's own
     * inline style changes, so a popup shown here as the top bar has it
     * would be laid out and styled again on its first opening: the first
     * show of the quick settings then takes 32 ms of the 34 that opening
     * takes, against 3 later (measured).
     */
    rehearseMenu(role, source, alignment) {
        const menu = Main.panel.statusArea[role]?.menu;
        // Visible after a close for as long as it fades.
        if (!menu?._boxPointer || !source?.mapped || menu.isOpen || menu.actor.visible)
            return null;
        this._point(menu, source, alignment);
        menu._boxPointer.setPosition(source, alignment);
        // The popup of the quick settings is inside another actor, which
        // also holds what dims it under a submenu. Both are hidden while
        // it is closed.
        return {actor: menu.actor, inner: menu._boxPointer, isOpen: () => menu.isOpen};
    }

    toggleDateMenu(source) {
        this.toggleMenu(Main.panel.statusArea.dateMenu?.menu, source, 0);
    }

    toggleQuickSettings(source) {
        this.toggleMenu(Main.panel.statusArea.quickSettings?.menu, source, 1);
    }
}
