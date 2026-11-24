// SPDX-License-Identifier: GPL-3.0-or-later

// The popups, drawn once after a login, before the user opens them.
//
// The first time a popup is shown the shell does work it never does again:
// St matches the stylesheet against every widget in it, draws their
// backgrounds and borders into textures, Pango shapes the text and the
// glyphs are drawn into the glyph cache. The animations wait for that
// (lib/settle.js), so they look the same every time, but the popup comes up
// later. Measured 2026-11-22 on a 144 Hz monitor with eight windows, as the
// time the shell ran nothing else right after the popup was asked for, the
// first time against the later ones: launcher 35 ms against 0 to 17,
// shortcuts 93 against 0, calendar 34 against 0 to 14, quick settings 49
// against 0 (the user: "first interactions are more laggy").
//
// Here each popup is shown once before that, for the two frames the work
// takes, with a clip that has no area: nothing of it is drawn on the screen
// (a screenshot taken meanwhile is the same as one taken before), and
// nothing in it can be picked, so a click goes to the window under it. An
// opacity of 0 would not do: an actor at 0 is not drawn at all. A
// Clutter.Clone of the hidden popup, which draws it without showing it, did
// half of the work only: St computes the styles of what was added in an idle
// callback, for widgets that are mapped, and a clone's source is mapped
// only while it is drawn.
//
// Measured the same way after it, first time against later: launcher 16 ms
// against 0 to 10, shortcuts 31 against 0. What is left is the code of
// open() running for the first time.
//
// One popup is shown at a time, when nothing has been pressed or moved for
// IDLE_MS, so the 10 to 40 ms each takes do not fall into something the user
// is doing. A popup the user has opened before its turn is left out, and one
// the user opens during its turn is given back at once (endRehearsal).
//
// St drops every style it has computed when the stylesheet changes, which a
// change of the colour scheme does, and the styles of a card when its
// material changes, which a change of the wallpaper does. All of them are
// shown again after either (restart).

import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ms after the session has started before the first popup is drawn. The
// shell and the apps that start with the session are busy until then.
const START_MS = 2000;
// ms without input before a popup is drawn.
const IDLE_MS = 400;
// ms from one popup to the next.
const PAUSE_MS = 150;
// ms after which a popup is hidden again whatever has been drawn.
const LIMIT_MS = 500;

// The popup that is shown now: {actor, end()}.
let current = null;

/** actor is about to be shown to the user: its turn here ends now. */
export function endRehearsal(actor) {
    if (current?.actor === actor)
        current.end();
}

export class Rehearsal {
    constructor() {
        this._popups = [];     // {name, prepare}, all of them
        this._queue = [];      // those that wait for their turn
        this._sources = new Set();
        this._startId = 0;
        this._paintId = 0;
        this._watch = 0;
        this._enabled = false;
    }

    /**
     * prepare(): gives the popup the content, the size and the place it has
     * when it is shown, without showing it, and returns {actor, isOpen()},
     * or null when there is nothing to do. isOpen() tells whether the user
     * has the popup open: it is then not hidden again at the end. With
     * inner, an actor inside actor that is hidden too while the popup is
     * closed: it is shown and hidden with it.
     */
    add(name, prepare) {
        this._popups.push({name, prepare});
    }

    enable() {
        this._enabled = true;
        this._monitor = global.backend.get_core_idle_monitor();
        if (Main.layoutManager._startingUp)
            Main.layoutManager.connectObject('startup-complete', () => this._start(), this);
        else
            this._start();
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'changed', () => this._start(), this);
    }

    /** The styles of the popups were dropped: all of them again. */
    restart() {
        if (this._enabled && !Main.layoutManager._startingUp)
            this._start();
    }

    /** All of them, START_MS from now. */
    _start() {
        if (this._startId) {
            GLib.source_remove(this._startId);
            this._sources.delete(this._startId);
        }
        this._startId = this._later(START_MS, () => {
            this._startId = 0;
            this._queue = [...this._popups];
            this._next();
        });
    }

    disable() {
        this._enabled = false;
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        current?.end();
        for (const id of this._sources)
            GLib.source_remove(id);
        this._sources.clear();
        if (this._watch)
            this._monitor.remove_watch(this._watch);
        this._watch = 0;
        this._startId = 0;
        this._queue = [];
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._sources.delete(id);
            if (this._enabled)
                fn();
            return GLib.SOURCE_REMOVE;
        });
        this._sources.add(id);
        return id;
    }

    _next() {
        if (this._queue.length === 0 || current)
            return;
        if (this._monitor.get_idletime() < IDLE_MS) {
            // Called once, when nothing was pressed or moved for IDLE_MS.
            if (!this._watch) {
                this._watch = this._monitor.add_idle_watch(IDLE_MS, () => {
                    this._monitor.remove_watch(this._watch);
                    this._watch = 0;
                    if (this._enabled)
                        this._next();
                });
            }
            return;
        }
        const {name, prepare} = this._queue.shift();
        let popup = null;
        try {
            popup = prepare();
        } catch (e) {
            console.warn(`kelpshell: rehearsal, ${name}: ${e.message}`);
        }
        const actor = popup?.actor;
        // Shown already: the user was faster. A clip of its own is left alone.
        if (!actor || actor.visible || actor.has_clip || !actor.get_stage()) {
            this._later(PAUSE_MS, () => this._next());
            return;
        }
        this._show(actor, popup.isOpen, popup.inner && popup.inner !== actor ? popup.inner : null);
    }

    _show(actor, isOpen, inner) {
        const entry = current = {
            actor,
            end: () => {
                if (current !== entry)
                    return;
                current = null;
                if (this._paintId)
                    global.stage.disconnect(this._paintId);
                this._paintId = 0;
                actor.disconnectObject(this);
                if (!entry.destroyed) {
                    if (!isOpen()) {
                        inner?.hide();
                        actor.hide();
                    }
                    actor.remove_clip();
                }
                if (this._enabled)
                    this._later(PAUSE_MS, () => this._next());
            },
        };
        actor.connectObject('destroy', () => {
            entry.destroyed = true;
            entry.end();
        }, this);
        actor.set_clip(0, 0, 0, 0);
        actor.show();
        inner?.show();
        // A frame lays it out and draws it. St then computes the styles of
        // what was added, in an idle callback, and the frame after that has
        // the layout that follows: the same course as in lib/settle.js.
        this._afterPaint(() => {
            const id = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._sources.delete(id);
                if (current !== entry)
                    return GLib.SOURCE_REMOVE;
                actor.queue_redraw();
                this._afterPaint(entry.end);
                return GLib.SOURCE_REMOVE;
            });
            this._sources.add(id);
        });
        this._later(LIMIT_MS, entry.end);
    }

    _afterPaint(fn) {
        if (this._paintId)
            global.stage.disconnect(this._paintId);
        this._paintId = global.stage.connect('after-paint', () => {
            global.stage.disconnect(this._paintId);
            this._paintId = 0;
            fn();
        });
    }
}
