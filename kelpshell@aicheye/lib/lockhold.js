// SPDX-License-Identifier: GPL-3.0-or-later

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Keeps the work areas as they are while the screen is locked.
 *
 * A lock takes the sidebar and the tweaks down (extension.js). Left at
 * that, the sidebar's strut goes with it, and the top bar reserves its edge
 * of the screen again. Mutter then makes every window fit the new work
 * area: on a 1920x1080 monitor a tile goes from y 10 and 1060 px high to
 * y 32 and 1048 px. After the unlock the tiling starts before the sidebar,
 * with a work area as wide as the monitor, and again when the sidebar has
 * its strut. A full-width window is asked for 1900 px and then for 1726 px,
 * and is drawn shrinking from one to the other over 0.3 s.
 *
 * While this holds, an empty actor reserves what the sidebar's strut did,
 * and the top bar reserves nothing. No window is moved or resized by the
 * lock, so the tiling finds every frame where it left it.
 */
export class LockHold {
    constructor() {
        this._strut = null;
        this._panel = null;
    }

    /**
     * rect: the sidebar's strut, read before the sidebar is disabled. Call
     * this after the sidebar and the tweaks are disabled. The shell reads
     * its struts before the next frame, so it sees no state in between.
     */
    take(rect) {
        if (rect) {
            this._strut = new St.Widget({reactive: false});
            this._strut.set_position(rect.x, rect.y);
            this._strut.set_size(rect.width, rect.height);
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true, trackFullscreen: false});
            // The monitors can change while the screen is locked. The
            // strut would then lie where no sidebar will be.
            Main.layoutManager.connectObject('monitors-changed', () => this.releaseStrut(), this);
        }
        const record = Main.layoutManager._trackedActors?.find(
            a => a.actor === Main.layoutManager.panelBox);
        if (record) {
            this._panel = {record, affectsStruts: record.affectsStruts};
            record.affectsStruts = false;
            Main.layoutManager._queueUpdateRegions();
        }
    }

    /**
     * Before the tweaks are enabled again: they keep what the top bar's
     * record holds then, to put it back when the extension is disabled.
     */
    releasePanel() {
        if (!this._panel)
            return;
        this._panel.record.affectsStruts = this._panel.affectsStruts;
        this._panel = null;
        Main.layoutManager._queueUpdateRegions();
    }

    /** Once the sidebar has its own strut again. */
    releaseStrut() {
        if (!this._strut)
            return;
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.removeChrome(this._strut);
        this._strut.destroy();
        this._strut = null;
    }

    release() {
        this.releasePanel();
        this.releaseStrut();
    }
}
