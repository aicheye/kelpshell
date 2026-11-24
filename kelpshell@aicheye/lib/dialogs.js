// SPDX-License-Identifier: GPL-3.0-or-later

// The shell's prompts in the look of the cards: the authentication prompt,
// the keyring, network and disk password prompts, the audio device prompt,
// the power off and log out prompts, the run prompt, the permission prompts
// and the "not responding" prompt on a window.
//
// All of them are built from one class of the shell, Dialog in ui/dialog.js:
// a box with the style class "modal-dialog" that holds the content and the
// row of buttons. Until 2026-11-23 they were drawn as the shell theme has
// them, a grey box (#36363a) over a dark vignette, next to the cards of the
// sidebar and the launcher (the user: "some prompts are not in the kelpshell
// style").
//
// Here the box of every prompt moves into a wrapper that draws the card
// material and the shadow under it, as lib/tweaks.js does for the calendar
// and quick settings popups (see ShadowBin in lib/backdrop.js for why the
// box does not draw them itself). The box gets the style class
// "kelp-dialog", and the stylesheet gives the buttons, the text fields and
// the rows in it the look of the launcher. The dim under a prompt is the
// flat one of the shortcut sheet.
//
// The shell makes a prompt when it needs one, so the box is wrapped as its
// Dialog is put together. The power off prompt is made when the shell
// starts, and the run prompt is kept after its first use: the ones that are
// there already are wrapped in enable().

import Clutter from 'gi://Clutter';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ShadowBin} from './backdrop.js';
import {holdTransitions} from './settle.js';

// How far the screen under a prompt is darkened towards black: the value
// of .kelp-sheet-overlay in the stylesheet. The shell's own is a vignette
// from 0.5 in the middle of the screen to 0.85 in its corners.
const DIM = 0.36;

export class Dialogs {
    constructor(backdrop) {
        this._backdrop = backdrop;
        this._wrapped = new Map();   // Dialog -> {wrapper, box}
        this._injections = new InjectionManager();
    }

    enable() {
        const dialogs = this;
        // _createDialog() makes the box. The Dialog adds the box to itself
        // right after it, and is then added to its parent: the box is
        // wrapped at that point, before anything in it is shown or has the
        // key focus.
        //
        // In an overridden method `this` is the object the method is
        // called on.
        /* eslint-disable no-invalid-this */
        this._injections.overrideMethod(Dialog.Dialog.prototype, '_createDialog',
            original => function () {
                original.call(this);
                const id = this.connect('parent-set', () => {
                    this.disconnect(id);
                    dialogs._wrap(this);
                });
            });
        this._injections.overrideMethod(ModalDialog.ModalDialog.prototype, '_fadeOpen',
            original => function () {
                original.call(this);
                dialogs._opened(this);
            });
        /* eslint-enable no-invalid-this */
        for (const actor of Main.layoutManager.modalDialogGroup.get_children()) {
            if (actor.dialogLayout instanceof Dialog.Dialog)
                this._wrap(actor.dialogLayout);
        }
    }

    disable() {
        this._injections.clear();
        for (const dialog of [...this._wrapped.keys()])
            this._unwrap(dialog);
    }

    /** Run change(), which takes the box of dialog off the stage and puts it back. */
    _keepFocus(box, change) {
        const focus = global.stage.key_focus;
        const inside = focus && box.contains(focus);
        change();
        if (inside)
            focus.grab_key_focus();
    }

    /**
     * dialog._dialog is the wrapper from here on. The shell's prompt on a
     * window that does not respond is scaled and faded through that field
     * (ui/closeDialog.js), and the material has to go with the box. Nothing
     * else in the shell reads the field once the Dialog is made.
     */
    _wrap(dialog) {
        const box = dialog._dialog;
        if (!box || this._wrapped.has(dialog) || box.get_parent() !== dialog)
            return;
        const wrapper = new ShadowBin({
            style_class: 'kelp-shadow kelp-shadow-dialog',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._keepFocus(box, () => {
            dialog.remove_child(box);
            wrapper.set_child(box);
            dialog.add_child(wrapper);
        });
        wrapper.setMaterial(this._backdrop);
        box.add_style_class_name('kelp-dialog');
        dialog._dialog = wrapper;
        this._wrapped.set(dialog, {wrapper, box});
        dialog.connectObject('destroy', () => this._wrapped.delete(dialog), this);
    }

    _unwrap(dialog) {
        const {wrapper, box} = this._wrapped.get(dialog);
        this._wrapped.delete(dialog);
        dialog.disconnectObject(this);
        box.remove_style_class_name('kelp-dialog');
        this._keepFocus(box, () => {
            wrapper.set_child(null);
            dialog.add_child(box);
        });
        dialog._dialog = box;
        // What the shell has set on the wrapper through the field.
        box.set_pivot_point(...wrapper.get_pivot_point());
        box.set_scale(...wrapper.get_scale());
        wrapper.clearMaterial();
        wrapper.destroy();
    }

    /**
     * A prompt has started to fade in. The shell has set the vignette under
     * it in the same call, with no animation of its own: the dim fades in
     * with the prompt.
     */
    _opened(modal) {
        if (!this._wrapped.has(modal.dialogLayout))
            return;
        modal._lightbox?.get_effect('radial')?.set({brightness: 1 - DIM, sharpness: 0});
        // The fade starts once the first frame of the prompt is drawn, see
        // settle.js.
        holdTransitions(modal, ['opacity']);
    }
}
