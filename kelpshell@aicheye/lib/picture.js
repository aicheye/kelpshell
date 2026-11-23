// A small picture of an image file or of image data, with its proportions
// kept: the files of the downloads pile and the images of the clipboard
// list.
//
// St.Icon is not used for these. It draws a GFileIcon or a GBytesIcon as a
// square of the icon size, so a picture of 640 x 400 was squeezed to 56 x 56.
//
// The image is decoded off the main thread, at twice the size it is shown
// at, and kept in a small cache, so a pile that is drawn again after the
// folder changed shows its pictures at once.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const CACHE_SIZE = 48;
const cache = new Map();   // key -> St.ImageContent, the oldest first

/** Forget every decoded picture. */
export function clearPictures() {
    cache.clear();
}

function remember(key, content) {
    cache.delete(key);
    cache.set(key, content);
    while (cache.size > CACHE_SIZE)
        cache.delete(cache.keys().next().value);
}

function decode(stream, size, cancellable) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, size, size, true, cancellable,
            (_source, result) => {
                try {
                    let pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(result);
                    pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;
                    const width = pixbuf.get_width();
                    const height = pixbuf.get_height();
                    const content = St.ImageContent.new_with_preferred_size(width, height);
                    // A GLib.Bytes made here from a copy of the pixels. One
                    // that another function returned is not passed on, see
                    // the clipboard callback in lib/clipboard.js.
                    content.set_bytes(
                        global.stage.context.get_backend().get_cogl_context(),
                        new GLib.Bytes(pixbuf.get_pixels()),
                        pixbuf.get_has_alpha()
                            ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                        width, height, pixbuf.get_rowstride());
                    resolve(content);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function openFile(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.read_async(GLib.PRIORITY_LOW, cancellable, (_f, result) => {
            try {
                resolve(file.read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * An actor that shows the picture in `file` (a Gio.File) or in `bytes` (a
 * GLib.Bytes), scaled to fit in width x height stage pixels.
 *
 * key: names the picture in the cache. It has to change when the picture
 * does.
 * hug: the actor takes the size of the scaled picture. Without it the actor
 * is width x height, with the picture in its middle.
 * fallback: called with the actor when the picture cannot be read.
 * loaded: called with the actor when a picture that had to be decoded is
 * shown, which with hug changes the actor's size.
 */
export function picture({
    key, file = null, bytes = null, width, height, hug = false, fallback = null, loaded = null,
}) {
    const actor = new Clutter.Actor({
        width, height,
        content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
    });
    actor.set_content_scaling_filters(
        Clutter.ScalingFilter.TRILINEAR, Clutter.ScalingFilter.LINEAR);
    const show = content => {
        actor.set_content(content);
        if (!hug)
            return;
        const [, w, h] = content.get_preferred_size();
        const k = Math.min(width / w, height / h);
        actor.set_size(Math.round(w * k), Math.round(h * k));
    };
    const known = cache.get(key);
    if (known) {
        show(known);
        return actor;
    }

    const cancellable = new Gio.Cancellable();
    let alive = true;
    actor.connect('destroy', () => {
        alive = false;
        cancellable.cancel();
    });
    (async () => {
        try {
            const stream = file
                ? await openFile(file, cancellable)
                : Gio.MemoryInputStream.new_from_bytes(bytes);
            const content = await decode(stream, 2 * Math.max(width, height), cancellable);
            stream.close_async(GLib.PRIORITY_LOW, null, null);
            remember(key, content);
            if (alive) {
                show(content);
                loaded?.(actor);
            }
        } catch (e) {
            if (alive && !cancellable.is_cancelled())
                fallback?.(actor);
        }
    })();
    return actor;
}
