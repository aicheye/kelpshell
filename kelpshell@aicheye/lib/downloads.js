// The downloads pile of the sidebar: the newest files of the downloads
// folder lying on each other, the newest on top. It has no card around it.
//
// It follows the downloads stack of the macOS Dock:
//
//   - Under the pointer the pile spreads out upwards: the five newest
//     files lie to the left and to the right in turn, each a little higher
//     than the one before and turned a few degrees, so that they lie
//     partly on each other. The newest is the lowest. The folder stands
//     upright over them, in the middle. The file under the pointer grows,
//     stands upright, and its name is shown next to the sidebar.
//   - A file can be dragged out of the spread pile and dropped on a
//     window, which gets it as a file (lib/dragout.js).
//   - A click on a file opens it. A right or middle click shows it in the
//     file manager.
//   - A click on the folder opens a grid of the eleven newest files next to
//     the sidebar, with the folder itself as the last tile. The tiles are
//     dragged and clicked like the files of the pile.
//
// With the sidebar collapsed the pile spreads too, into one column straight
// up: the cards are 52 px wide there, which is room for one file. The files
// are smaller (36 px, 46 px under the pointer) and less turned, and
// everything else is the same. Until 2026-11-21 the collapsed pile did not
// spread: it showed the name of its top file and a click opened the grid.
//
// The folder is XDG_DOWNLOAD_DIR, or sidebar.downloadsDir. It is watched,
// and a file that arrives grows in on top of the pile while the whole pile
// jumps once, as the stack in the Dock does: up 16 px (10 px collapsed) and
// down again, landing with small bounces. A spread pile does not jump,
// because the pointer is on one of its files. Files a browser is
// still writing (.part, .crdownload) and hidden files are left out. The
// newest file is the one whose status changed last: a browser renames a
// finished download, which sets that time, and some keep the modification
// time the server reported.
//
// A picture is shown as itself (lib/picture.js). Any other file shows its
// thumbnail from the thumbnail cache the file manager uses, or else the icon
// of its type. A file that has no thumbnail there gets one made, by the
// thumbnailer the system has for its type, as the file manager does it
// (DownloadsCard._thumbnail).
//
// Until 2026-11-23 no thumbnail was made here. A PDF then showed the icon of
// its type from the moment it was downloaded: the file manager makes the
// thumbnail when it shows the folder, and nothing changes in the downloads
// folder at that time, so the pile was not drawn again either (the user:
// "pdf download thumbnails aren't loading even though they show in the
// downloads folder").
//
// History, all of 2026-11-21:
//
//   - The pile was inside a card, and nothing could be dragged out of it.
//   - The pile spread out into a row of four files and the folder, which
//     left 35 px for each in the 164 px of the sidebar. Then it rose into
//     one column of five, 256 px straight up from the pile.
//   - After the grid had been opened and closed, the row stayed open with
//     the pointer somewhere else. The grid takes the pointer with a grab,
//     and the pile and the file that was clicked are sent no leave event,
//     so St kept their hover set. The card now clears it (_dropHover).
//   - The pile spread out into two upright columns of three, the folder at
//     the top right. Files of different shapes in a grid looked uneven, and
//     the folder weighed on one side.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {makeFileDraggable} from './dragout.js';
import {picture} from './picture.js';
import {easeSettled} from './settle.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

const ATTRIBUTES = 'standard::name,standard::display-name,standard::is-hidden,' +
    'standard::content-type,standard::icon,standard::size,' +
    'time::changed,time::modified,thumbnail::path';
const PARTIAL = /\.(part|crdownload|download|partial|tmp|aria2)$/i;
const PICTURES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
    'image/svg+xml', 'image/avif'];
const MAX_PICTURE = 40 * 1024 * 1024;   // bytes: a larger picture shows the icon of its type

const KEPT = 11;            // files in the grid, which has the folder as a 12th tile
const COLUMNS = 4;
const PILE = 5;             // files in the spread pile
// The sizes of the pile, in px before scaling, with the sidebar expanded and
// collapsed.
//   icon:   a file as it is made, the size of the one under the pointer
//   rest:   a file lying in the pile
//   lying:  files that show in the pile. The others only show when it spreads
//   spread: a file of the spread pile
//   x:      a file of the spread pile lies this far left or right of the middle
//   rise:   each file of the spread pile lies this much higher than the one before
//   folder: the folder stands this far over the last file
//   shift:  every time the pile spreads, each file is moved by a random
//           distance of up to this many px across and up or down
//   turn:   the angles of the spread files are multiplied by this
//   hop:    the pile jumps this high when a file arrives
const EXPANDED = {
    icon: 68, rest: 48, lying: 5, spread: 60, x: 27, rise: 34, folder: 60,
    shift: [6, 4], turn: 1, hop: 16,
};
// One column: the cards are 52 px wide (sidebar.collapsedWidth).
const COLLAPSED = {
    icon: 46, rest: 30, lying: 3, spread: 36, x: 0, rise: 40, folder: 42,
    shift: [3, 3], turn: 0.6, hop: 10,
};
// Degrees each file of the spread pile is turned by, from the newest.
const SPREAD_ANGLES = [-7, 6, 4, -8, 5];
// Every time the pile spreads, each file is turned by up to this many
// degrees more or less than its angle above.
const SPREAD_TURN = 5;
const SPREAD_REACH = 10;    // px around the spread pile that the pointer can be in without closing it
const SPREAD_DELAY = 18;    // ms each file starts to rise after the one before
const TILE_ICON = 56;       // px, a file in the grid
const DRAG_ICON = 56;       // px, the picture that follows the pointer
const PILE_STEP = 8;        // px between two files of the pile
const PILE_PAD = 6;         // px over and under the pile
// Degrees each file of the pile is turned by, from the top one down.
const PILE_ANGLES = [0, -9, 7, -4, 11];
const FAN_MS = 220;
const ARRIVE_MS = 320;
const HOP_UP_MS = 170;
const HOP_DOWN_MS = 380;
const TIP_MS = 100;
const TIP_GAP = 6;          // px between a file of the pile and its name
const RESCAN_MS = 400;      // after the folder last changed

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** What to show for a file: {file, info, time}. size in px before scaling. */
function iconOf(item, size, styleClass) {
    const typeIcon = () => new St.Icon({
        gicon: item.info.get_icon(),
        fallback_icon_name: 'text-x-generic',
        icon_size: size,
        style_class: styleClass,
    });
    const type = item.info.get_content_type() ?? '';
    const thumbnail = item.info.get_attribute_byte_string('thumbnail::path');
    let file = null;
    if (PICTURES.includes(type) && item.info.get_size() <= MAX_PICTURE)
        file = item.file;
    else if (thumbnail)
        file = Gio.File.new_for_path(thumbnail);
    if (!file)
        return typeIcon();
    const px = size * scaleFactor();
    // A thin line around the picture, once there is one. Where the
    // windows under the sidebar are not darkened (theme.shade lessens
    // towards the work area) a white page lies on the blur of a white
    // window with nothing between them.
    const frame = new St.Bin({
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
    });
    const framed = () => frame.add_style_class_name('kelp-file-thumb');
    const shown = picture({
        key: `${file.get_uri()} ${item.time} ${item.info.get_size()}`,
        file, width: px, height: px, hug: true,
        fallback: actor => actor.add_child(typeIcon()),
        loaded: framed,
    });
    frame.child = shown;
    // A picture that was kept is shown at once, and `loaded` is not called.
    if (shown.content)
        framed();
    return new St.Bin({width: px, height: px, child: frame});
}

/**
 * Make the thumbnail of a file and write it to the thumbnail cache. True
 * when it is there. mtime: when the file was modified, in seconds.
 */
async function makeThumbnail(factory, uri, type, mtime) {
    const call = (start, finish) => new Promise((resolve, reject) => {
        start((_factory, result) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    let pixbuf = null;
    try {
        pixbuf = await call(
            done => factory.generate_thumbnail_async(uri, type, null, done),
            result => factory.generate_thumbnail_finish(result));
    } catch {
        // No thumbnail of this file: an encrypted PDF, a broken video.
    }
    if (!pixbuf) {
        await call(
            done => factory.create_failed_thumbnail_async(uri, mtime, null, done),
            result => factory.create_failed_thumbnail_finish(result));
        return false;
    }
    await call(
        done => factory.save_thumbnail_async(pixbuf, uri, mtime, null, done),
        result => factory.save_thumbnail_finish(result));
    return true;
}

function folderIcon(size, styleClass) {
    return new St.Icon({
        gicon: new Gio.ThemedIcon({names: ['folder-download', 'folder']}),
        icon_size: size,
        style_class: styleClass,
    });
}

// The files of the pile, each a button in the middle of the widget. Where a
// file is drawn is its translation, rotation and scale, so the pile can
// spread out and close again without a new layout. The spread pile is drawn
// over what is above it.
const Pile = GObject.registerClass(
class KelpPile extends St.Widget {
    _init() {
        super._init({x_expand: true, reactive: true, track_hover: true});
        this._layout = EXPANDED;
        this._spread = false;
        this._buttons = [];   // the files, newest first, then the folder if it is there
        this._hovered = null;
        // For each file of the spread pile, from the newest: {x, y, angle}
        // on top of its place and its angle. Drawn again at every spread.
        this._jitter = Array.from({length: PILE}, () => ({x: 0, y: 0, angle: 0}));
        // The room around the spread files. Without it the pointer leaves
        // the pile between two files, and the pile closes.
        this._reach = new Clutter.Actor({reactive: false});
        this.add_child(this._reach);
        // Called when the files of a pile that spreads are in their places.
        this.onLanded = null;
        this._landId = 0;
        this.connect('destroy', () => this._land(0));
    }

    get buttons() {
        return this._buttons;
    }

    /** The folder of the spread pile, or null. */
    get folder() {
        return this._folder ?? null;
    }

    get spread() {
        return this._spread;
    }

    /**
     * The pile is spreading and its files are on the way to their places.
     * They pass under the pointer on that way, see Downloads._syncHover.
     */
    get flying() {
        return this._landId !== 0;
    }

    /** The files are in their places after ms. 0: they are there now. */
    _land(ms) {
        if (this._landId)
            GLib.source_remove(this._landId);
        this._landId = 0;
        if (ms <= 0)
            return;
        this._landId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._landId = 0;
            this.onLanded?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Whether a stage point is on the pile, or on the room around the spread files. */
    holds(x, y) {
        const within = actor => {
            const [ax, ay] = actor.get_transformed_position();
            const box = actor.get_allocation_box();
            return x >= ax && x < ax + box.get_width() && y >= ay && y < ay + box.get_height();
        };
        return within(this) || (this._spread && within(this._reach));
    }

    /**
     * buttons: actors of layout.icon px, the files newest first and then,
     * with hasFolder, the folder, which is only shown in the spread pile.
     * layout: EXPANDED or COLLAPSED. arrived: those that are new.
     */
    setButtons(buttons, layout, hasFolder, arrived = []) {
        for (const button of this._buttons)
            button.destroy();
        this._buttons = buttons;
        this._layout = layout;
        this._folder = hasFolder ? buttons[buttons.length - 1] : null;
        this._hovered = null;
        for (const button of buttons)
            button.set_pivot_point(0.5, 0.5);
        this._restack();
        this._apply(false);
        for (const button of arrived) {
            // A file that does not show in the pile stays hidden.
            const scale = button.scale_x, opacity = button.opacity;
            button.set_scale(0.3 * scale, 0.3 * scale);
            button.opacity = 0;
            button.ease({
                scale_x: scale, scale_y: scale,
                duration: ARRIVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            // Not with EASE_OUT_BACK: that goes past 255, which the opacity
            // takes as a small number, and the file was gone for 150 ms in
            // the middle of growing in (measured 2026-11-21).
            button.ease({
                opacity,
                duration: ARRIVE_MS / 2,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this.queue_relayout();
    }

    /** The newest is drawn last, on top. */
    _restack() {
        for (const button of [...this._buttons].reverse()) {
            if (button.get_parent() !== this)
                this.add_child(button);
            this.set_child_above_sibling(button, null);
        }
    }

    setSpread(spread) {
        if (spread === this._spread)
            return;
        this._spread = spread;
        this._reach.reactive = spread;
        if (spread) {
            const within = limit => (Math.random() * 2 - 1) * limit;
            const [across, up] = this._layout.shift;
            this._jitter = this._jitter.map(() => ({
                x: within(across), y: within(up), angle: within(SPREAD_TURN),
            }));
            // The pile is in its place under the pointer.
            this.remove_transition('translation-y');
            this.translation_y = 0;
        }
        this._apply(true, spread);
        // The last file starts after the others and takes FAN_MS.
        const flight = spread && St.Settings.get().enable_animations
            ? FAN_MS + SPREAD_DELAY * Math.max(0, this._buttons.length - 1) : 0;
        this._land(flight);
        if (spread && flight === 0)
            this.onLanded?.();
    }

    /**
     * Jump once: a file has arrived. Up, then down with the bounces of
     * EASE_OUT_BOUNCE, which starts like a fall.
     */
    hop() {
        this.remove_transition('translation-y');
        this.translation_y = 0;
        this.ease({
            translation_y: -Math.round(this._layout.hop * scaleFactor()),
            duration: HOP_UP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.ease({
                translation_y: 0,
                duration: HOP_DOWN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
            }),
        });
    }

    /** The file under the pointer, or null: it is drawn larger, over the others. */
    setHovered(button) {
        if (button === this._hovered)
            return;
        this._hovered = button;
        this._restack();
        if (button)
            this.set_child_above_sibling(button, null);
        this._apply(true);
    }

    /**
     * px of room the spread pile takes over the pile's own box: up to the
     * top of the folder, which is the highest and has its full size under
     * the pointer. 0 without a folder, when the pile does not spread.
     */
    spreadRoom() {
        if (!this._folder)
            return 0;
        const s = scaleFactor();
        const own = (this._layout.rest + 2 * PILE_PAD) * s;
        return Math.ceil((this._rise() + this._layout.icon / 2) * s - own / 2);
    }

    /** How far the top of the spread pile is over the pile, in px before scaling. */
    _rise() {
        const files = this._folder ? this._buttons.length - 1 : this._buttons.length;
        return Math.max(0, files - 1) * this._layout.rise + (this._folder ? this._layout.folder : 0);
    }

    /** Where the file `button`, the i-th from the newest, comes to rest. */
    _target(button, i) {
        const s = scaleFactor();
        const l = this._layout;
        const folder = button === this._folder;
        const files = this._folder ? this._buttons.length - 1 : this._buttons.length;
        if (this._spread) {
            const hovered = button === this._hovered;
            const scale = hovered ? 1 : l.spread / l.icon;
            const side = k => (k % 2 ? 1 : -1);
            let x, y, angle;
            if (folder) {
                // A little to the side the last file is not on. In one
                // column it is in the middle.
                x = files > 1 && l.x > 0 ? -8 * side(files - 1) : 0;
                y = this._rise();
                angle = 0;
            } else {
                // One file alone is in the middle, under the folder.
                const jitter = this._jitter[i % this._jitter.length];
                x = (files > 1 ? side(i) * l.x : 0) + jitter.x;
                y = i * l.rise + jitter.y;
                angle = hovered ? 0
                    : (SPREAD_ANGLES[i % SPREAD_ANGLES.length] + jitter.angle) * l.turn;
            }
            return {
                translation_x: Math.round(x * s),
                translation_y: -Math.round(y * s),
                rotation_angle_z: angle,
                scale_x: scale, scale_y: scale,
                opacity: 255,
            };
        }
        // The folder is part of the spread pile only, and so are the files
        // past the ones that show in the pile.
        const hidden = folder || i >= l.lying;
        const lying = Math.min(files, l.lying);
        return {
            translation_x: hidden ? 0 : Math.round((i - (lying - 1) / 2) * PILE_STEP * s),
            translation_y: 0,
            rotation_angle_z: hidden ? 0 : PILE_ANGLES[i % PILE_ANGLES.length],
            scale_x: l.rest / l.icon, scale_y: l.rest / l.icon,
            opacity: hidden ? 0 : 255,
        };
    }

    /** staggered: each file starts after the one before. */
    _apply(animate, staggered = false) {
        animate &&= St.Settings.get().enable_animations;
        this._buttons.forEach((button, i) => {
            const to = this._target(button, i);
            button.reactive = to.opacity > 0;
            for (const name of ['translation-x', 'translation-y', 'rotation-angle-z',
                'scale-x', 'scale-y', 'opacity'])
                button.remove_transition(name);
            if (animate) {
                button.ease({
                    ...to,
                    delay: staggered ? i * SPREAD_DELAY : 0,
                    duration: FAN_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                button.set(to);
            }
        });
    }

    /**
     * Where a file is on the stage once it has come to rest:
     * {x, y, width, height}. Its own box is on the way there while the
     * pile spreads and while the file grows.
     */
    restBox(button) {
        const to = this._target(button, this._buttons.indexOf(button));
        const [x, y] = this.get_transformed_position();
        // Not this.width: that is the natural width while a layout is
        // waited for, and putting a file over the others asks for one.
        const box = this.get_allocation_box();
        const size = this._layout.icon * scaleFactor() * to.scale_x;
        return {
            x: x + box.get_width() / 2 + to.translation_x - size / 2,
            y: y + box.get_height() / 2 + to.translation_y - size / 2,
            width: size, height: size,
        };
    }

    // The pile has no padding or border of its own, so its theme node is
    // not asked: St warns when that is done before the widget is on the
    // stage.
    vfunc_get_preferred_width() {
        const size = this._layout.rest * scaleFactor();
        return [size, size];
    }

    vfunc_get_preferred_height() {
        const size = Math.round((this._layout.rest + 2 * PILE_PAD) * scaleFactor());
        return [size, size];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const s = scaleFactor();
        const size = this._layout.icon * s;
        const x = Math.round((box.get_width() - size) / 2);
        const y = Math.round((box.get_height() - size) / 2);
        for (const button of this._buttons)
            button.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + size, y2: y + size}));
        // From the folder down to the pile, which is reactive itself.
        const reach = SPREAD_REACH * s;
        const top = y - Math.round(this._rise() * s) - reach;
        const half = Math.round((this._layout.x + this._layout.shift[0]) * s);
        this._reach.allocate(new Clutter.ActorBox({
            x1: x - half - reach, y1: Math.min(top, 0), x2: x + size + half + reach, y2: 0,
        }));
    }
});

/** The name of the file under the pointer. */
class Tip {
    constructor() {
        this.actor = new St.Label({style_class: 'kelp-tip', visible: false, opacity: 0});
        this.actor.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        // In the group of the shell's own actors, but not tracked as
        // chrome: the name takes no clicks from the window under it.
        Main.uiGroup.add_child(this.actor);
    }

    /**
     * box: the file on the stage, {x, y, width, height}. The name is to its
     * right, TIP_GAP from it, level with its middle.
     *
     * Until 2026-11-22 the name moved up or down, as far as the top and the
     * bottom of its file, to cover less of the file beside it. In the
     * user's picture it stood 14 px over the middle of its file ("this
     * label isn't aligned").
     */
    show(text, box) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const s = scaleFactor();
        this.actor.text = text;
        this.actor.set_width(-1);
        // Shown before it is measured. A label that has never been shown
        // has no style yet and is measured in the font of the shell: the
        // first name after a login was 135 x 33 px where it is 110 x 25,
        // so it was placed for a size it did not have (measured
        // 2026-11-22). It is see-through until the fade below.
        this.actor.show();
        const [, width] = this.actor.get_preferred_width(-1);
        const [, height] = this.actor.get_preferred_height(-1);
        let x = box.x + box.width + TIP_GAP * s;
        x = Math.max(monitor.x + 6 * s, Math.min(x, monitor.x + monitor.width - width - 6 * s));
        let y = box.y + box.height / 2 - height / 2;
        y = Math.max(monitor.y + 6 * s, y);
        this.actor.set_position(Math.round(x), Math.round(y));
        this.actor.remove_all_transitions();
        this.actor.ease({opacity: 255, duration: TIP_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    hide() {
        if (!this.actor.visible)
            return;
        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            duration: TIP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.actor.hide(),
        });
    }

    destroy() {
        this.actor.destroy();
    }
}

/** The grid of the newest files, shown next to the sidebar. */
class Popup {
    constructor(card) {
        this._card = card;
        this._sidebar = card._sidebar;
        this._selected = -1;
        this._tiles = [];
        this.isOpen = false;

        this._overlay = new St.Widget({reactive: true, can_focus: true, visible: false});
        // As in lib/launcher.js: a press outside closes the grid, the focus
        // goes to what was pressed, and the event is not stopped.
        this._overlay.connect('button-press-event', (_a, event) => {
            if (!this._box.contains(global.stage.get_event_actor(event))) {
                const [x, y] = event.get_coords();
                // Closed, the grid takes no events, so the focus goes to
                // what is under it.
                this.close();
                this._sidebar.tiling.focusAt(x, y);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));

        this._grid = new St.Widget({
            layout_manager: new Clutter.GridLayout(),
            style_class: 'kelp-downloads-grid',
        });
        const surface = new St.BoxLayout({
            style_class: 'kelp-card kelp-downloads-popup',
            orientation: VERTICAL,
            reactive: true,
        });
        surface.add_child(this._grid);
        this._box = this._sidebar.backdrop.wrap(surface, 'kelp-shadow-float', {}, true);
        this._overlay.add_child(this._box);
        // The height is only right once the grid has been laid out: see
        // open(). A file that arrives changes it too.
        this._box.connect('notify::height', () => this._place());
        Main.layoutManager.addTopChrome(this._overlay);
    }

    destroy() {
        this.close(false);
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = this._box = this._grid = null;
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (this.isOpen || !monitor)
            return;
        const grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
        if (!grab)
            return;
        this._grab = grab;
        this.isOpen = true;
        this._card.grabbed();
        this.rebuild();

        const s = scaleFactor();
        this._overlay.set_position(monitor.x, monitor.y);
        this._overlay.set_size(monitor.width, monitor.height);
        this._overlay.reactive = true;
        this._anchor = this._card.anchor();
        // Shown before it is placed. Hidden, the grid reports a height of
        // 0 until it has been shown once, so the first time it opened 95 px
        // lower than every time after (seen on 2026-11-21).
        this._overlay.show();
        this._place();
        this._overlay.grab_key_focus();

        this._box.remove_all_transitions();
        this._box.opacity = 0;
        this._box.translation_x = -8 * s;
        // Once the first frame is drawn, see settle.js.
        easeSettled(this._box, {
            opacity: 255,
            translation_x: 0,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        // The tiles grow in one after the other, from the newest.
        if (St.Settings.get().enable_animations) {
            this._tiles.forEach((tile, i) => {
                tile.actor.set_pivot_point(0.5, 0.5);
                tile.actor.set_scale(0.8, 0.8);
                tile.actor.opacity = 0;
                easeSettled(tile.actor, {
                    scale_x: 1, scale_y: 1, opacity: 255,
                    delay: 14 * i,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            });
        }
    }

    /**
     * Next to the cards, level with what it was opened from where the
     * monitor has room.
     */
    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        const anchor = this._anchor;
        if (!this.isOpen || !anchor || !monitor)
            return;
        const s = scaleFactor();
        const [, , , height] = this._box.get_preferred_size();
        const x = this._sidebar.rightEdge + 8 * s - monitor.x;
        const y = Math.max(8 * s, Math.min(
            anchor.y - monitor.y + anchor.height / 2 - height / 2,
            monitor.height - height - 8 * s));
        this._box.set_position(Math.round(x), Math.round(y));
    }

    close(animate = true) {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        this._anchor = null;
        Main.popModal(this._grab);
        this._grab = null;
        // The pointer is over what is under the grid again at once, and
        // not only when the grid has faded.
        this._overlay.reactive = false;
        this._card.released();
        this._box.remove_all_transitions();
        if (!animate) {
            this._overlay.hide();
            return;
        }
        this._box.ease({
            opacity: 0,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._overlay.hide(),
        });
    }

    /** Fill the grid from the card's files. */
    rebuild() {
        this._grid.destroy_all_children();
        this._tiles = [];
        const layout = this._grid.layout_manager;
        const add = (icon, name, run) => {
            const label = new St.Label({text: name, style_class: 'kelp-download-name'});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            const box = new St.BoxLayout({
                orientation: VERTICAL, style_class: 'kelp-download-tile-box',
            });
            icon.x_align = Clutter.ActorAlign.CENTER;
            box.add_child(icon);
            box.add_child(label);
            const actor = new St.Button({
                style_class: 'kelp-download-tile',
                child: box,
                button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
            });
            const index = this._tiles.length;
            actor.connect('clicked', (_b, button) => {
                this.close();
                run(button !== 1);
            });
            actor.connect('motion-event', () => {
                if (this._selected !== index)
                    this._select(index);
                return Clutter.EVENT_PROPAGATE;
            });
            layout.attach(actor, index % COLUMNS, Math.floor(index / COLUMNS), 1, 1);
            this._tiles.push({actor, run});
            return actor;
        };
        for (const item of this._card.items) {
            const icon = iconOf(item, TILE_ICON, 'kelp-download-icon');
            const tile = add(icon, item.info.get_display_name(),
                reveal => (reveal ? this._card.reveal(item.file) : this._card.open(item.file)));
            // The grid covers the monitor and would be what the file is
            // dragged over, so it closes when a drag starts.
            //
            // The picture starts over the tile's icon, which has its size.
            // Until 2026-11-21 it started at the top left corner of the
            // tile, 24 px left of and 10 px over the icon, so it jumped by
            // that much from under the pointer.
            makeFileDraggable(tile, {
                file: item.file,
                source: icon,
                picture: () => iconOf(item, DRAG_ICON, 'kelp-download-icon'),
                begin: () => this.close(false),
            });
        }
        const dir = this._card.dir;
        add(folderIcon(TILE_ICON, 'kelp-download-icon'), dir.get_basename() ?? 'Downloads',
            () => this._card.open(dir));
        this._selected = -1;
    }

    _select(index) {
        const n = this._tiles.length;
        if (n === 0)
            return;
        this._selected = Math.max(0, Math.min(n - 1, index));
        this._tiles.forEach((tile, i) => {
            if (i === this._selected)
                tile.actor.add_style_pseudo_class('selected');
            else
                tile.actor.remove_style_pseudo_class('selected');
        });
    }

    _onKey(event) {
        const at = this._selected;
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
        case Clutter.KEY_Tab:
            this._select(at + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Left:
        case Clutter.KEY_ISO_Left_Tab:
            this._select(at < 0 ? 0 : at - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            this._select(at < 0 ? 0 : at + COLUMNS);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._select(at < 0 ? 0 : at - COLUMNS);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter: {
            const tile = this._tiles[at];
            if (tile) {
                this.close();
                tile.run(false);
            }
            return Clutter.EVENT_STOP;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}

export class DownloadsCard {
    constructor(sidebar) {
        this._sidebar = sidebar;
        this._collapsed = false;
        this._enabled = false;
        this._watched = undefined;   // the path that is watched, null for none
        this._serial = 0;
        this._scanId = 0;
        this._dragging = false;
        this._known = null;     // URIs seen by the last scan, null before the first
        this._tried = new Set();    // "uri mtime" of the files a thumbnail was asked for
        this._making = Promise.resolve();   // ends when the last of them is made
        this.items = [];        // {file, info, time}, newest first
        this.dir = null;

        this._pile = new Pile();
        this._pile.add_style_class_name('kelp-downloads');
        this._pile.visible = false;
        this._pile.connect('notify::hover', () => this._syncSpread());
        this._pile.onLanded = () => this._syncLanded();
        this.actor = this._pile;
        this._tip = new Tip();
        this._popup = new Popup(this);
        this.sync();
    }

    destroy() {
        this._unwatch();
        this._popup.destroy();
        this._tip.destroy();
    }

    setCollapsed(collapsed) {
        this._collapsed = collapsed;
        this._show([]);
    }

    /** After a change of configuration. */
    sync() {
        this._enabled = this._sidebar.config.values.sidebar.downloads !== false;
        const path = this._enabled ? this._path() : null;
        if (path !== this._watched)
            this._watch(path);
        this._syncVisible();
    }

    _path() {
        const set = this._sidebar.config.values.sidebar.downloadsDir;
        if (typeof set === 'string' && set.trim()) {
            const path = set.trim();
            return path === '~' || path.startsWith('~/')
                ? GLib.get_home_dir() + path.slice(1) : path;
        }
        const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        // Without a downloads folder the entry names the home folder.
        return path && path !== GLib.get_home_dir() ? path : null;
    }

    _watch(path) {
        this._unwatch();
        this._watched = path;
        this.dir = path ? Gio.File.new_for_path(path) : null;
        this._known = null;
        this._tried.clear();
        this.items = [];
        if (this.dir) {
            try {
                this._monitor = this.dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
                this._monitor.connect('changed', () => this._scanSoon());
            } catch (e) {
                console.warn(`kelpshell: downloads: ${e.message}`);
            }
            this._scan().catch(console.error);
        }
        this._show([]);
    }

    _unwatch() {
        this._serial++;
        if (this._scanId)
            GLib.source_remove(this._scanId);
        this._scanId = 0;
        this._monitor?.cancel();
        this._monitor = null;
    }

    _scanSoon() {
        if (this._scanId)
            GLib.source_remove(this._scanId);
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_MS, () => {
            this._scanId = 0;
            this._scan().catch(console.error);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _scan() {
        const serial = ++this._serial;
        const dir = this.dir;
        const found = [];
        try {
            const children = await new Promise((resolve, reject) => {
                dir.enumerate_children_async(ATTRIBUTES, Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW, null, (_f, result) => {
                        try {
                            resolve(dir.enumerate_children_finish(result));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const infos = await new Promise((resolve, reject) => {
                    children.next_files_async(100, GLib.PRIORITY_LOW, null, (_e, result) => {
                        try {
                            resolve(children.next_files_finish(result));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                if (serial !== this._serial)
                    return;
                if (infos.length === 0)
                    break;
                for (const info of infos) {
                    const name = info.get_name();
                    if (info.get_is_hidden() || PARTIAL.test(name))
                        continue;
                    found.push({
                        file: dir.get_child(name),
                        info,
                        time: Math.max(
                            info.get_attribute_uint64('time::changed'),
                            info.get_attribute_uint64('time::modified')),
                    });
                }
            }
            children.close_async(GLib.PRIORITY_LOW, null, null);
        } catch (e) {
            // The folder does not exist yet: the pile stays hidden.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`kelpshell: downloads: ${e.message}`);
        }
        if (serial !== this._serial)
            return;
        found.sort((a, b) => b.time - a.time || a.info.get_name().localeCompare(b.info.get_name()));
        const known = this._known;
        this._known = new Set(found.map(item => item.file.get_uri()));
        this.items = found.slice(0, KEPT);
        // A file is not taken from under a drag: the pile is drawn again
        // when the drag has ended.
        if (this._dragging) {
            this._stale = true;
            return;
        }
        // Nothing has arrived on the first scan.
        this._show(known ? this.items.filter(item => !known.has(item.file.get_uri())) : []);
        if (this._popup.isOpen)
            this._popup.rebuild();
        this._thumbnail(this.items);
    }

    /**
     * Have a thumbnail made for each of these files that has none, one
     * after the other, and scan the folder again when one is there: the
     * scan then finds it as the file's "thumbnail::path".
     *
     * The thumbnailer of the file's type runs as its own process, in the
     * sandbox libgnome-desktop puts it in, and the thumbnail goes to
     * ~/.cache/thumbnails/large, where the file manager finds it too. A
     * file is asked for once for each time it was modified. When no
     * thumbnail can be made of it, that is written to the cache, as the
     * file manager does, and it is not tried again.
     */
    _thumbnail(items) {
        for (const item of items) {
            const type = item.info.get_content_type();
            if (!type || PICTURES.includes(type) ||
                item.info.get_attribute_byte_string('thumbnail::path'))
                continue;
            const uri = item.file.get_uri();
            const mtime = item.info.get_attribute_uint64('time::modified');
            const key = `${uri} ${mtime}`;
            if (this._tried.has(key))
                continue;
            this._tried.add(key);
            this._factory ??= GnomeDesktop.DesktopThumbnailFactory.new(
                GnomeDesktop.DesktopThumbnailSize.LARGE);
            const factory = this._factory;
            if (!factory.can_thumbnail(uri, type, mtime))
                continue;
            const dir = this.dir;
            this._making = this._making
                .then(() => makeThumbnail(factory, uri, type, mtime))
                .then(made => {
                    if (made && this.dir === dir)
                        this._scanSoon();
                })
                .catch(e => console.warn(`kelpshell: downloads: thumbnail: ${e.message}`));
        }
    }

    /** One file of the pile: a button that opens it and can be dragged out. */
    _fileButton(item, size) {
        const button = new St.Button({
            style_class: 'kelp-pile-file',
            child: iconOf(item, size, 'kelp-pile-icon'),
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE | St.ButtonMask.SECONDARY,
        });
        button.connect('clicked', (_b, which) => {
            this._tip.hide();
            if (which === 1)
                this.open(item.file);
            else
                this.reveal(item.file);
        });
        this._name(button, item.info.get_display_name());
        makeFileDraggable(button, {
            file: item.file,
            picture: () => iconOf(item, DRAG_ICON, 'kelp-pile-icon'),
            begin: () => {
                this._dragging = true;
                // The pile closes under the file that is carried away.
                this._dropHover();
            },
            end: () => {
                this._dragging = false;
                if (this._stale) {
                    this._stale = false;
                    this._show([]);
                }
                this._pile.sync_hover();
                this._syncSpread();
            },
        });
        return button;
    }

    /** Draw the pile. arrived: the files that grow in. */
    _show(arrived) {
        const layout = this._collapsed ? COLLAPSED : EXPANDED;
        const size = layout.icon;
        const shown = this.items.slice(0, PILE);
        const buttons = shown.map(item => this._fileButton(item, size));
        const fresh = buttons.filter((_button, i) => arrived.includes(shown[i]));
        // The folder is the last of the spread pile.
        const hasFolder = shown.length > 0;
        if (hasFolder) {
            const folder = new St.Button({
                style_class: 'kelp-pile-file',
                child: folderIcon(size, 'kelp-pile-icon'),
            });
            folder.connect('clicked', () => {
                this._tip.hide();
                this._popup.toggle();
            });
            this._name(folder, this.dir.get_basename() ?? 'Downloads');
            buttons.push(folder);
        }
        this._tip.hide();
        this._pile.setButtons(buttons, layout, hasFolder, fresh);
        this._syncSpread();
        this._syncVisible();
        if (fresh.length > 0 && !this._pile.spread)
            this._pile.hop();
    }

    /**
     * The pile is spread while the pointer is over it and nothing is
     * dragged, and for as long as the grid is open. The folder is then
     * drawn as the file under the pointer is: the grid came from it.
     */
    _syncSpread() {
        const open = this._popup?.isOpen;
        const spread = open || (this._pile.hover && !this._dragging);
        this._pile.setSpread(spread);
        if (open) {
            this._pile.setHovered(this._pile.folder);
        } else if (!spread && !this._pile.hover) {
            this._pile.setHovered(null);
            this._tip.hide();
        }
    }

    /**
     * Where the grid opens next to, {x, y, width, height} on the stage: the
     * folder of the spread pile, or the pile.
     */
    anchor() {
        const folder = this._pile.folder;
        if (folder && this._pile.spread)
            return this._pile.restBox(folder);
        const [x, y] = this._pile.get_transformed_position();
        const box = this._pile.get_allocation_box();
        return {x, y, width: box.get_width(), height: box.get_height()};
    }

    /**
     * The grid has taken the pointer. The pile and its files are sent no
     * leave event, so their hover is cleared here. The pile stays spread.
     * Until 2026-11-21 it closed, and the folder that had been clicked was
     * gone while its grid was open.
     */
    grabbed() {
        for (const button of this._pile.buttons)
            button.set_hover(false);
        this._pile.set_hover(false);
        this._tip.hide();
        this._syncSpread();
    }

    /**
     * The grid has closed. The pile closes too, unless the pointer is on
     * it. St only sets the hover when the pointer next moves, and the pile
     * would close and spread again in between.
     */
    released() {
        const [x, y] = global.get_pointer();
        this._pile.setHovered(null);
        this._pile.set_hover(!this._dragging && this._pile.holds(x, y));
        this._syncSpread();
    }

    /**
     * Something else has taken the pointer with a grab: the grid, or a
     * drag. The pile and its files are sent no leave event then, and their
     * hover stays set until the pointer has been over them again. St sets
     * it again by itself when the pointer comes back.
     */
    _dropHover() {
        for (const button of this._pile.buttons)
            button.set_hover(false);
        this._pile.set_hover(false);
        this._pile.setHovered(null);
        this._pile.setSpread(false);
        this._tip.hide();
    }

    /** name: what is shown beside button while the pointer is on it. */
    _name(button, name) {
        button._kelpName = name;
        button.connect('notify::hover', () => this._syncHover(button));
    }

    /**
     * The files of the pile that spreads are in their places: the one the
     * pointer is on now is the one that is named.
     */
    _syncLanded() {
        if (this._dragging || !this._pile.spread)
            return;
        // What the pointer is on now, whatever moved under it.
        for (const button of this._pile.buttons)
            button.sync_hover();
        const button = this._pile.buttons.find(b => b.hover);
        if (button)
            this._syncHover(button);
    }

    /**
     * The file under the pointer is drawn larger and named.
     *
     * Not while the pile spreads. The files leave the pile one after the
     * other and cross what is over it on the way, so a pointer that came
     * to the pile was on a file that was passing: its name came up at the
     * place it was going to, up to 166 px from the pointer, for 30 to
     * 100 ms, and then the name of the next one (measured 2026-11-22; the
     * user: "when i open the download stack for the first time the tooltip
     * is on the wrong item"). A file that is not shown in the lying pile
     * was among them: it becomes reactive at the start, in the middle of
     * the pile. The file the pointer is on once they are in their places
     * is named then, see _syncLanded().
     *
     * A file can report the pointer before the pile does, because the
     * event goes to the file first. The pile is not spread at that moment
     * and spreads right after, so that file waits the same way.
     */
    _syncHover(button) {
        if (this._dragging || !this._pile.spread || this._pile.flying)
            return;
        const name = button._kelpName ?? '';
        if (!button.hover) {
            // The pointer went to another file, which shows its own name,
            // or off the pile, which closes it.
            return;
        }
        // Next to the file. Until 2026-11-22 the name was next to the
        // sidebar, so that it never lay on a file of the other side: up to
        // 83px from a file on the left, which read as belonging to nothing.
        this._pile.setHovered(button);
        const s = scaleFactor();
        const file = this._pile.restBox(button);
        // The picture can be narrower than its place. A framed picture
        // knows its width. A themed icon has about 4px of nothing on each
        // side at this size.
        const picture = button.child?.child?.width;
        const inset = Math.max(0, Math.min(file.width / 2,
            picture > 0 ? (file.width - picture) / 2 : 4 * s));
        this._tip.show(name, {
            x: file.x + inset, y: file.y, width: file.width - 2 * inset, height: file.height,
        });
    }

    _syncVisible() {
        this.actor.visible = this._enabled && this.items.length > 0;
        if (!this.actor.visible) {
            this._popup.close(false);
            this._tip.hide();
        }
        // The room the pile needs has changed with the number of files.
        this._sidebar.syncRoom?.();
    }

    /** px of room over the pile that the spread pile takes, 0 when it does not spread. */
    spreadRoom() {
        return this.actor.visible ? this._pile.spreadRoom() : 0;
    }

    /** Open a file, or the folder, with the program for its type. */
    open(file) {
        try {
            this._sidebar.tiling.expectWindow(this._sidebar.tiling.activeMonitor);
            Gio.AppInfo.launch_default_for_uri(
                file.get_uri(), global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('Kelpshell', e.message);
        }
    }

    /** Show a file in the file manager. */
    reveal(file) {
        this._sidebar.tiling.expectWindow(this._sidebar.tiling.activeMonitor);
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems',
            new GLib.Variant('(ass)', [[file.get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (e) {
                    // No file manager answers: open the folder.
                    this.open(file.get_parent() ?? this.dir);
                }
            });
    }
}
