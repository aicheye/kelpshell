// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

import {Config} from './lib/config.js';
import {settleNow} from './lib/settle.js';
import {Animator} from './lib/spring.js';
import {Tiling, dropSavedLayout} from './lib/tiling.js';
import {Keybindings} from './lib/keybindings.js';
import {Backdrop} from './lib/backdrop.js';
import {setServes} from './lib/crop.js';
import {Decorations} from './lib/decorations.js';
import {Dialogs} from './lib/dialogs.js';
import {Tweaks} from './lib/tweaks.js';
import {Sidebar} from './lib/sidebar.js';
import {Launcher} from './lib/launcher.js';
import {Clipboard} from './lib/clipboard.js';
import {clearPictures} from './lib/picture.js';
import {Switcher} from './lib/switcher.js';
import {Cheatsheet} from './lib/cheatsheet.js';
import {LockPicture, LockScreen, findFingerprintReader} from './lib/lockscreen.js';
import {Rehearsal} from './lib/warm.js';
import {Scroll} from './lib/scroll.js';
import {LockPower} from './lib/lockpower.js';
import {LockHold} from './lib/lockhold.js';
import {LidLock} from './lib/lidlock.js';
import {Outputs} from './lib/outputs.js';
import {Privacy} from './lib/privacy.js';
import {Shot} from './lib/shot.js';
import {X11Size} from './lib/x11size.js';

const ANY = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export default class Kelpshell extends Extension {
    /**
     * metadata.json names two session modes, "user" and "unlock-dialog", so
     * the shell keeps the extension enabled while the screen is locked and
     * its stylesheet stays loaded. Everything of the session (the sidebar,
     * the tiling, the key bindings) is still taken down for that time, as
     * the shell does when it disables an extension that names "user" alone:
     * actors added to the shell's chrome are drawn over the lock screen.
     * What runs there is lib/lockscreen.js, and the three parts that
     * enable() starts for both modes.
     *
     * The session comes back from a lock as it was left: the work areas
     * are held (lib/lockhold.js), the tiling keeps its strips
     * (Tiling.disable) and the sidebar its width.
     */
    enable() {
        // When the session ends, the shell destroys its actors and then
        // still runs timers and signal handlers for a moment, without
        // disabling its extensions. Each of ours that runs then meets
        // actors that are gone: 30 to 100 errors in the journal at every
        // logout, each written with its stack. This signal comes before
        // the actors go.
        this._ended = false;
        Main.layoutManager.uiGroup.connectObject('destroy', () => this._end(), this);

        if (GLib.getenv('KELPSHELL_DEBUG'))
            globalThis.kelp = this;

        // In both modes: a lock starts in the session and ends on the lock
        // screen.
        try {
            this.lockPower = new LockPower();
            this.lockPower.enable();
        } catch (e) {
            console.warn(`kelpshell: lock, display: ${e.message}`);
        }

        // The lid can close in either mode; on the lock screen it finds the
        // screen locked.
        try {
            this.lidLock = new LidLock(() => (this.config ?? this.lockConfig)?.values.lock.onLidClose);
            this.lidLock.enable();
        } catch (e) {
            console.warn(`kelpshell: lock at lid close: ${e.message}`);
        }

        // In both modes too: a speaker can go away while the screen is locked.
        try {
            this.outputs = new Outputs(() => (this.config ?? this.lockConfig)?.values.sound);
            this.outputs.enable();
        } catch (e) {
            console.warn(`kelpshell: output devices: ${e.message}`);
        }

        // In both modes too: the lid can close while the screen is locked.
        try {
            this.x11Size = new X11Size();
            this.x11Size.enable();
        } catch (e) {
            console.warn(`kelpshell: X11 window sizes: ${e.message}`);
        }

        // Before the first lock, so that its prompt is like the later ones.
        findFingerprintReader();

        this._userOn = this._lockOn = false;
        this._kept = null;   // what a lock keeps for the unlock, see _disableUser
        Main.sessionMode.connectObject('updated', () => this._syncMode(), this);
        this._syncMode();
    }

    _syncMode() {
        if (this._ended)
            return;
        if (Main.sessionMode.isLocked) {
            this._disableUser(true);
            this._enableLock();
        } else {
            // The lock screen is still on the screen for a moment, moving
            // away: it keeps its look.
            this._disableLock(false);
            this._enableUser();
        }
    }

    _enableLock() {
        if (this._lockOn)
            return;
        this._lockOn = true;
        this.lockConfig = new Config();
        this.lockConfig.enable();
        this.lockBackdrop = new Backdrop(this.lockConfig, {live: false});
        this.lockBackdrop.enable();
        // Now, and not after the wait of enable(): the cards are on the
        // screen in the first frame.
        this.lockBackdrop.refresh();
        this.lock = new LockScreen(this.lockConfig, this.lockBackdrop);
        this.lock.enable();
        this.lockConfig.onChanged(() => {
            this.lockBackdrop.refresh();
            this.lock.restyle();
        });
    }

    /** strip: take the look off a lock screen that is still shown. */
    _disableLock(strip) {
        if (!this._lockOn)
            return;
        this._lockOn = false;
        this.lock.disable(strip);
        this.lockBackdrop.disable();
        this.lockConfig.disable();
        this.lock = this.lockBackdrop = this.lockConfig = null;
    }

    _enableUser() {
        if (this._userOn)
            return;
        this._userOn = true;
        // What a lock kept for this, see _disableUser.
        const kept = this._kept;
        this._kept = null;
        try {
            this._startUser(kept);
        } catch (e) {
            // A part did not start. The parts that did are taken down
            // again: the session is then the shell's own, and not half of
            // each. The next change of the session mode tries again.
            console.error('kelpshell: could not start', e);
            this._disableUser();
            kept?.hold.release();
            Main.notifyError('Kelpshell', `Could not start: ${e.message}`);
        }
    }

    /** kept: what a lock kept for the unlock, or null. */
    _startUser(kept) {
        kept?.hold.releasePanel();

        this.config = new Config();
        this.config.enable();

        this.animator = new Animator(this.config);
        this.animator.enable();

        this.backdrop = new Backdrop(this.config);
        this.backdrop.enable();

        // So that a lock finds the picture of its wallpaper made.
        this.lockPicture = new LockPicture(this.config);
        this.lockPicture.enable();

        this.tweaks = new Tweaks(this.config, this.backdrop);
        this.tweaks.enable();

        this.dialogs = new Dialogs(this.backdrop);
        this.dialogs.enable();

        // Before the tiling: it asks which windows have no frame to cut.
        this.decorations = new Decorations(this.config, this.path);
        this.decorations.enable();

        // After the decorations, which load the native modules.
        this.scroll = new Scroll(this.config);
        this.scroll.enable();
        setServes(win => this.decorations.serves(win));

        this.tiling = new Tiling(this.config, this.animator);
        // Before it is enabled: its edge fade asks the glass for a layer.
        this.tiling.glass = this.backdrop.glass;
        this.tiling.enable();
        // The colour windows are darkened towards under the sidebar follows
        // the style, which the backdrop reports.
        this.backdrop.onChanged(() => {
            this.tiling?.fade?.sync();
            // The ring and the outline of the windows have a colour for
            // each style.
            this.tiling?.ring?.restyle();
            this.tiling?.corners?.syncAll();
            this.shot?.sync();
        });
        this.decorations.onChanged(() => this._syncFrames());

        this.launcher = new Launcher(this);
        this.launcher.enable();
        // The Super key opens the launcher in place of the overview. From a
        // hot corner it opens on that corner's monitor.
        this.tweaks.onSuper = monitor => {
            if (this.launcher.isOpen || Main.actionMode === Shell.ActionMode.NORMAL) {
                if (!this.launcher.isOpen)
                    this.tiling.setActiveMonitor(monitor);
                this.launcher.toggle();
            }
        };

        this.clipboard = new Clipboard(this);
        this.clipboard.enable();

        this.switcher = new Switcher(this);
        this.switcher.enable();

        this.cheatsheet = new Cheatsheet(this);
        this.cheatsheet.enable();

        // After the decorations, which load the native modules, and before
        // the sidebar, which has a card for it.
        this.privacy = new Privacy(this.config);
        this.privacy.tiling = this.tiling;
        this.privacy.enable();
        this.shot = new Shot(this.config, this.backdrop, this.privacy, this.tiling);
        this.shot.enable();

        this.sidebar = new Sidebar(this);
        this.sidebar.launcher = this.launcher;
        this.shot.sidebar = this.sidebar;
        this.sidebar.enable(kept?.sidebar);
        // The sidebar has its own strut now.
        kept?.hold.releaseStrut();
        // With the work area and the room of the sidebar as they stay.
        this.tiling.adopt();
        this.sidebar.windowsAdopted();

        this.keys = new Keybindings(this.config, this._actions());
        this.keys.enable();

        this.config.onChanged(() => this._reload());
        this._reportConfigError();

        // The popups are drawn once before their first use, see lib/warm.js.
        this.rehearsal = new Rehearsal();
        this.rehearsal.add('launcher', () => this.launcher?.rehearse());
        this.rehearsal.add('shortcuts', () => this.cheatsheet?.rehearse());
        this.rehearsal.add('clipboard', () => this.clipboard?.rehearse());
        this.rehearsal.add('calendar', () =>
            this.tweaks?.rehearseMenu('dateMenu', this.sidebar?.calendarSource, 0));
        this.rehearsal.add('quick settings', () =>
            this.tweaks?.rehearseMenu('quickSettings', this.sidebar?.quickSettingsSource, 1));
        this.rehearsal.add('outputs', () => this.sidebar?.rehearseOutputs());
        this.rehearsal.add('background apps', () => this.sidebar?.rehearseBackground());
        this.rehearsal.enable();
        // The material is an inline style of the cards.
        this.backdrop.onChanged(() => this.rehearsal?.restart());
    }

    /**
     * The shell is ending. The parts that run by themselves are stopped
     * while their actors are still there: the sidebar with its timers, the
     * edge fade and the live blur. The output devices go away one by one
     * as the session ends, which is not a change to pause players for or to
     * load a preset for. Nothing is put back as it was before the
     * extension: the whole of disable() makes the shell 40 to 120 ms slower
     * to end (measured), with the last frame standing on the screen for
     * that time.
     */
    _end() {
        this._ended = true;
        for (const stop of [
            () => this.privacy?.disable(),
            () => this.sidebar?.disable(),
            () => this.tiling?.fade?.disable(),
            () => this.backdrop?.glass?.disable(),
            () => this.outputs?.disable(),
            () => this.lidLock?.disable(),
            () => this.x11Size?.disable(),
        ]) {
            try {
                stop();
            } catch (e) {
                console.warn(`kelpshell: at the end of the session: ${e.message}`);
            }
        }
    }

    disable() {
        // The shell is ending, see _end().
        if (this._ended)
            return;
        Main.layoutManager.uiGroup.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        if (globalThis.kelp === this)
            delete globalThis.kelp;
        this._disableUser();
        this._disableLock(true);
        // Disabled while the screen is locked: nothing comes back.
        clearPictures();
        this._kept?.hold.release();
        this._kept = null;
        dropSavedLayout();
        this.lockPower?.disable();
        this.lockPower = null;
        this.lidLock?.disable();
        this.lidLock = null;
        this.outputs?.disable();
        this.outputs = null;
        this.x11Size?.disable();
        this.x11Size = null;
    }

    /**
     * lock: the screen is being locked, and _enableUser() runs again at
     * the unlock. The windows keep their frames and stay drawn at their
     * places, and the sidebar comes back as it was: collapsed, or shown
     * over a fullscreen window.
     */
    _disableUser(lock = false) {
        if (!this._userOn)
            return;
        this._userOn = false;
        const kept = lock && this.sidebar
            ? {hold: new LockHold(), sidebar: this.sidebar.state, strut: this.sidebar.strutRect}
            : null;
        // Every part is taken down, also after one of them has failed, and
        // when some were never started (see _enableUser): the top bar and
        // the shell's own key bindings come back in any case.
        for (const step of [
            // Before the popups it has clones of.
            () => this.rehearsal?.disable(),
            // The sidebar gives the status icons back to the top bar, so it
            // goes before the tweaks that show the bar again.
            () => this.keys?.disable(),
            () => this.sidebar?.disable(),
            () => this.shot?.disable(),
            () => this.privacy?.disable(),
            () => this.cheatsheet?.disable(),
            () => this.switcher?.disable(),
            () => this.clipboard?.disable(),
            // A lock keeps the decoded pictures: the downloads pile shows
            // them in its first frame after the unlock.
            () => {
                if (!lock)
                    clearPictures();
            },
            () => {
                if (this.tweaks)
                    this.tweaks.onSuper = null;
            },
            () => this.launcher?.disable(),
            () => this.tiling?.disable(lock),
            () => setServes(null),
            () => this.scroll?.disable(),
            () => this.decorations?.disable(),
            () => this.dialogs?.disable(),
            () => this.tweaks?.disable(),
            () => kept?.hold.take(kept.strut),
            () => this.lockPicture?.disable(),
            () => this.backdrop?.disable(),
            () => settleNow(),
            () => this.animator?.disable(),
            () => this.config?.disable(),
        ]) {
            try {
                step();
            } catch (e) {
                console.error('kelpshell: while disabling', e);
            }
        }
        this._kept = kept;
        this.rehearsal = null;
        this.keys = this.sidebar = this.launcher = this.tiling = this.switcher = null;
        this.cheatsheet = this.decorations = this.clipboard = null;
        this.tweaks = this.backdrop = this.lockPicture = this.animator = this.config = null;
        this.dialogs = this.scroll = this.privacy = this.shot = null;
    }

    _reportConfigError() {
        if (this.config.error)
            Main.notifyError('Kelpshell', `config.jsonc: ${this.config.error}`);
    }

    _reload() {
        this._reportConfigError();
        this.keys.disable();
        this.keys.enable();
        this.tweaks.apply();
        this.scroll.apply();
        this.backdrop.refresh();
        this.lockPicture.refresh();
        this.tiling.fade.sync();
        this.sidebar.setCollapsed(this.config.values.sidebar.collapsed);
        this.sidebar.reposition(true);
        this.tiling.ring.restyle();
        this.privacy.sync();
        this.shot.sync();
        this.decorations.apply();
        this._syncFrames();
    }

    /** After a change of which windows are cut or have a title bar drawn. */
    _syncFrames() {
        this.tiling.corners.syncAll();
        this.tiling.titlebars.syncAll();
        this.tiling.layoutAll(true);
    }

    _spawn(command) {
        try {
            Util.trySpawnCommandLine(command);
        } catch (e) {
            Main.notifyError('Kelpshell', `Could not run "${command}": ${e.message}`);
        }
    }

    _terminal() {
        const configured = this.config.values.commands.terminal;
        if (configured)
            return configured;
        for (const name of ['ptyxis --new-window', 'kgx', 'gnome-terminal', 'ghostty',
            'kitty', 'alacritty', 'foot', 'xterm']) {
            if (GLib.find_program_in_path(name.split(' ')[0]))
                return name;
        }
        return 'xterm';
    }

    _actions() {
        const t = this.tiling;
        const ws = {};
        for (let i = 1; i <= 9; i++) {
            ws[`workspace-${i}`] = {run: () => t.gotoWorkspace(i - 1), modes: ANY};
            ws[`move-to-workspace-${i}`] = {run: () => t.moveToWorkspace(i - 1)};
        }
        return {
            'focus-left': {run: () => t.focusColumn(-1), repeat: true},
            'focus-right': {run: () => t.focusColumn(1), repeat: true},
            'focus-up': {run: () => t.focusRow(-1), repeat: true},
            'focus-down': {run: () => t.focusRow(1), repeat: true},
            'focus-first': {run: () => t.focusEdge(false)},
            'focus-last': {run: () => t.focusEdge(true)},
            'move-left': {run: () => t.moveColumn(-1), repeat: true},
            'move-right': {run: () => t.moveColumn(1), repeat: true},
            'move-up': {run: () => t.moveRow(-1), repeat: true},
            'move-down': {run: () => t.moveRow(1), repeat: true},
            'move-first': {run: () => t.moveColumnToEdge(false)},
            'move-last': {run: () => t.moveColumnToEdge(true)},
            'consume-or-expel-left': {run: () => t.consumeOrExpel(-1)},
            'consume-or-expel-right': {run: () => t.consumeOrExpel(1)},
            'cycle-width': {run: () => t.cycleWidth()},
            'width-decrease': {run: () => t.adjustWidth(-0.1), repeat: true},
            'width-increase': {run: () => t.adjustWidth(0.1), repeat: true},
            'height-decrease': {run: () => t.adjustHeight(-0.15), repeat: true},
            'height-increase': {run: () => t.adjustHeight(0.15), repeat: true},
            'maximize-column': {run: () => t.maximizeColumn()},
            'fullscreen': {run: () => t.toggleFullscreen()},
            'center-column': {run: () => t.centerColumn()},
            'align-left': {run: () => t.alignColumn('left')},
            'align-right': {run: () => t.alignColumn('right')},
            'align-center': {run: () => t.alignColumn('middle')},
            'minimize-window': {run: () => t.minimizeWindow()},
            'toggle-float': {run: () => t.toggleFloat()},
            'close-window': {run: () => t.closeWindow()},
            'reopen-closed': {run: () => t.reopenClosed()},
            'workspace-up': {run: () => t.switchWorkspace(-1), modes: ANY, repeat: true},
            'workspace-down': {run: () => t.switchWorkspace(1), modes: ANY, repeat: true},
            'move-to-workspace-up': {run: () => t.moveToWorkspaceBy(-1)},
            'move-to-workspace-down': {run: () => t.moveToWorkspaceBy(1)},
            ...ws,
            'terminal': {run: () => this._spawn(this._terminal())},
            'files': {run: () => this._spawn(this.config.values.commands.files)},
            'launcher': {run: () => this.launcher.toggle(), modes: ANY | Shell.ActionMode.POPUP},
            // The list takes no grab, so the key closes it again in the
            // same mode. Of the popups it opens over the launcher only:
            // Clipboard.open() refuses the others.
            'clipboard': {
                run: () => this.clipboard.toggle(),
                modes: Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP,
            },
            // The same picker, on its page of emoji.
            'emoji': {
                run: () => this.clipboard.toggle('emoji'),
                modes: Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP,
            },
            'toggle-sidebar': {run: () => this.sidebar.toggleCollapsed(), modes: ANY},
            'shortcuts': {run: () => this.cheatsheet.toggle(), modes: ANY | Shell.ActionMode.POPUP},
        };
    }
}
