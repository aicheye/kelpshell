// SPDX-License-Identifier: GPL-3.0-or-later

// Dragging a file out of the shell and dropping it on a window.
//
// The shell's own drag code (ui/dnd.js) moves a picture of the file with
// the pointer. The native module (native/drag.c) is the Wayland side: while
// the picture is over a window it tells the client of that window that
// files are being dragged over it, and on release it hands them over. See
// that file for why the shell cannot do this by itself.
//
// Without the module (it is built by dev/build-native.sh, for one version
// of the shell) nothing can be dragged, and makeFileDraggable() does
// nothing.

import GObject from 'gi://GObject';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

// The module's object: undefined before it is looked up, null without the
// module. lib/decorations.js loads the modules when the extension is first
// enabled, before anything asks here.
let source;

function native() {
    if (source === undefined) {
        source = null;
        try {
            const type = GObject.type_from_name('KelpDrag');
            if (type)
                source = GObject.Object.new(type);
        } catch (e) {
            console.warn(`kelpshell: drag module: ${e.message}`);
        }
    }
    return source;
}

/** Whether files can be dragged out. */
export function canDragOut() {
    return native() !== null;
}

/**
 * The window at a stage point, with its surface actor. picked: the actor the
 * shell's drag code found there.
 *
 * That actor is not the window. The pick takes actors that are not reactive
 * too, and over a window it finds what the extension draws there: the focus
 * ring, which is in the window group, over the windows. So the pick only
 * says whether the point is on the windows and not on a card, and the
 * window is the topmost one whose frame holds the point.
 */
function windowAt(picked, x, y) {
    if (!picked || !global.window_group.contains(picked))
        return [null, null];
    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
        const actor = actors[i];
        const win = actor.meta_window;
        if (!actor.visible || !win || win.minimized)
            continue;
        const frame = win.get_frame_rect();
        if (x < frame.x || x >= frame.x + frame.width ||
            y < frame.y || y >= frame.y + frame.height)
            continue;
        const surface = actor.get_children().find(
            child => child.constructor.$gtype.name.startsWith('MetaSurface'));
        return surface ? [win, surface] : [null, null];
    }
    return [null, null];
}

/**
 * Let an actor be dragged as a file.
 *
 * file: the Gio.File. picture: makes the actor that follows the pointer.
 * source: the part of the actor that the picture stands for, the actor
 * itself without one. The shell puts the picture over the source when the
 * drag starts, so with a source of the picture's size the point that was
 * pressed stays under the pointer. begin and end are called around the
 * drag, end with whether a window took the file.
 *
 * Returns the shell's draggable, or null without the native module.
 */
export function makeFileDraggable(actor, {file, picture, source: from = null, begin = null, end = null}) {
    const drag = native();
    if (!drag)
        return null;
    actor._delegate = {
        getDragActor: picture,
        getDragActorSource: () => from ?? actor,
    };
    const draggable = DND.makeDraggable(actor, {dragActorOpacity: 235});
    let dropped = false;
    const monitor = {
        dragMotion: event => {
            const [win, surface] = windowAt(event.targetActor, event.x, event.y);
            let x = 0, y = 0;
            if (surface)
                [, x, y] = surface.transform_stage_point(event.x, event.y);
            const wanted = drag.emit('motion', win, x, y, global.get_current_time());
            return wanted ? DND.DragMotionResult.COPY_DROP : DND.DragMotionResult.CONTINUE;
        },
        dragDrop: event => {
            if (!drag.emit('drop'))
                return DND.DragDropResult.CONTINUE;
            // The client has the file. With its picture destroyed the
            // shell ends the drag without moving the picture back.
            dropped = true;
            event.dropActor.destroy();
            return DND.DragDropResult.SUCCESS;
        },
    };
    draggable.connect('drag-begin', () => {
        dropped = false;
        drag.emit('begin', file.get_uri());
        DND.addDragMonitor(monitor);
        begin?.();
    });
    draggable.connect('drag-end', () => {
        DND.removeDragMonitor(monitor);
        drag.emit('cancel');
        end?.(dropped);
    });
    return draggable;
}
