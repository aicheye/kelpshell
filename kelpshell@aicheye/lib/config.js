// Text configuration: ~/.config/kelpshell/config.jsonc, merged over DEFAULTS.
// The file is watched, so saving it applies the change without a restart.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULTS = {
    sidebar: {
        width: 164,           // px, expanded card width
        collapsedWidth: 52,   // px, collapsed card width
        margin: 10,           // px between screen edge and cards
        gap: 8,               // px between cards
        collapsed: false,
        previewDelay: 350,    // ms hover before a window thumbnail shows
        notifications: 3,     // rows shown in the notification card
        system: true,         // processor, memory, disk and network meters
        downloads: true,      // the pile of the newest files in the downloads folder
        downloadsDir: '',     // empty: XDG_DOWNLOAD_DIR
        // Icons that fill the status row up to four places, in this order:
        // 'powerMode', 'bluetooth', 'nightLight'.
        statusFill: ['powerMode', 'bluetooth'],
    },
    layout: {
        gap: 10,
        presetWidths: [0.33333, 0.5, 0.66667],
        defaultWidth: 0.5,
        rememberWidths: true, // a new window opens at the width last set for its app
        centerSingleColumn: true,
        centerColumns: true,  // columns narrower than the view together sit in the middle
        centerFocusedColumn: 'never',   // 'never' | 'always'
        verticalWorkspaces: true,
        scrollSecondary: false,   // false: a secondary monitor fits its columns and never scrolls
        float: [],            // wm_class substrings that never tile
    },
    focusRing: {
        enabled: true,
        width: 2,
        radius: 15,       // corner radius of the windows the ring surrounds
        color: 'rgba(255,255,255,0.55)',
    },
    windows: {
        clipCorners: true,    // cut every window's corners to focusRing.radius
        outline: true,        // a one pixel outline on every window
        unfocusedScale: 0.98, // a tiled window without focus is drawn this much smaller; 1 turns it off
        // Wayland windows whose frame the shell replaces, by wm_class
        // substring. top, right, bottom, left: the thickness in px of the
        // frame the client draws, cut off when the client cannot be told
        // to leave it out. titlebar: draw a title bar. See lib/crop.js.
        crop: [{match: 'spotify', top: 26, right: 5, bottom: 5, left: 5, titlebar: true}],
    },
    animation: {
        stiffness: 800,       // spring stiffness; omega = sqrt(stiffness)
        damping: 1.0,         // 1 = critically damped, below 1 overshoots
    },
    theme: {
        tint: '#16181d',      // colour the blurred wallpaper is mixed toward, dark style
        tintLight: '#f1f2f4', // the same in the light style
        opacity: 0.95,        // of the cards: 1 = opaque
        tintStrength: 0.72,   // 0 = raw blurred wallpaper, 1 = flat tint
        saturation: 1.6,      // wallpaper colour boost before tinting
        blur: 6,              // number of half-resolution blur passes
        liveBlur: true,       // the sidebar's cards blur the windows under them; false: windows fade out under the sidebar
        liveBlurTint: 0.7,    // how far the blurred windows are mixed toward the tint; 1 = no blur to see
        shade: 0.5,           // with liveBlur: how far windows are darkened towards black at the edge of the monitor; 0 = off, 1 = black
        shadeRamp: 0.25,      // where the blur starts to lessen, as a share of the width under the sidebar
        lockTint: 0.3,        // how far the lock screen's wallpaper is mixed toward the tint; 0 = the blurred wallpaper as it is
    },
    launcher: {
        width: 640,
        maxResults: 8,        // apps, windows and actions; other rows come after these
        searchProviders: true,  // files, settings and the rest of Settings > Search
        hotCorner: true,      // the pointer pushed into the top left corner opens it
        webSearch: 'https://www.google.com/search?q=%s',  // %s is the query; '' turns it off
    },
    scroll: {
        speed: 1,             // touchpad scroll distance, as a factor on what the touchpad reports
        likeFirefox: true,    // every window scrolls as far, and goes on as long, as Firefox
        // Windows whose toolkit is not found by itself, by wm_class substring:
        // {match: 'name', toolkit: 'firefox' | 'gtk4' | 'chromium' | 'none'}.
        apps: [],
    },
    clipboard: {
        size: 25,             // entries kept
        paste: true,          // paste the chosen entry into the focused window; false: only copy it
    },
    notifications: {
        bannerPosition: 'right',   // 'left' | 'center' | 'right'
    },
    lock: {
        onLidClose: true,     // closing the lid locks at once when the laptop's panel is the only display, also when no suspend follows
    },
    sound: {
        pauseOnOutputChange: true,  // another output device pauses the media players
        presetPerOutput: true,      // and loads the EasyEffects preset last used with it
    },
    commands: {
        terminal: '',         // empty: first of ptyxis, kgx, gnome-terminal, ...
        files: 'nautilus --new-window',
    },
    gestures: {
        swipeScroll: true,    // three-finger horizontal swipe scrolls the strip
        launcherSwipe: true,  // four-finger swipe up opens the launcher, down closes it
        sensitivity: 1,       // 1: a swipe of 1200 touchpad units scrolls one view width
    },
    keybindings: {
        'focus-left': ['<Super>a', '<Super>Left'],
        'focus-right': ['<Super>d', '<Super>Right'],
        'focus-up': ['<Super>w', '<Super>Up'],
        'focus-down': ['<Super>s', '<Super>Down'],
        'focus-first': ['<Super>Home'],
        'focus-last': ['<Super>End'],
        'move-left': ['<Super><Control>a', '<Super><Control>Left'],
        'move-right': ['<Super><Control>d', '<Super><Control>Right'],
        'move-up': ['<Super><Control>w', '<Super><Control>Up'],
        'move-down': ['<Super><Control>s', '<Super><Control>Down'],
        'move-first': ['<Super><Control>Home'],
        'move-last': ['<Super><Control>End'],
        'consume-or-expel-left': ['<Super>bracketleft'],
        'consume-or-expel-right': ['<Super>bracketright'],
        'cycle-width': ['<Super>r'],
        'width-decrease': ['<Super>minus'],
        'width-increase': ['<Super>equal'],
        'height-decrease': ['<Super><Shift>minus'],
        'height-increase': ['<Super><Shift>equal'],
        'maximize-column': ['<Super>f'],
        'fullscreen': ['<Super><Shift>f'],
        'center-column': ['<Super>c'],
        // The window in focus to a side of the screen, or to its middle.
        'align-left': ['<Super><Shift>a'],
        'align-right': ['<Super><Shift>d'],
        'align-center': ['<Super><Shift>w'],
        'minimize-window': ['<Super><Shift>s'],
        'toggle-float': ['<Super>t'],
        'close-window': ['<Super>q'],
        'reopen-closed': ['<Super><Shift>t'],
        'workspace-up': ['<Super>Page_Up'],
        'workspace-down': ['<Super>Page_Down'],
        'move-to-workspace-up': ['<Super><Control>Page_Up'],
        'move-to-workspace-down': ['<Super><Control>Page_Down'],
        'workspace-1': ['<Super>1'],
        'workspace-2': ['<Super>2'],
        'workspace-3': ['<Super>3'],
        'workspace-4': ['<Super>4'],
        'workspace-5': ['<Super>5'],
        'workspace-6': ['<Super>6'],
        'workspace-7': ['<Super>7'],
        'workspace-8': ['<Super>8'],
        'workspace-9': ['<Super>9'],
        'move-to-workspace-1': ['<Super><Control>1'],
        'move-to-workspace-2': ['<Super><Control>2'],
        'move-to-workspace-3': ['<Super><Control>3'],
        'move-to-workspace-4': ['<Super><Control>4'],
        'move-to-workspace-5': ['<Super><Control>5'],
        'move-to-workspace-6': ['<Super><Control>6'],
        'move-to-workspace-7': ['<Super><Control>7'],
        'move-to-workspace-8': ['<Super><Control>8'],
        'move-to-workspace-9': ['<Super><Control>9'],
        'launcher': ['<Super>space'],
        'clipboard': ['<Super>v'],
        'emoji': ['<Super>period'],
        'terminal': ['<Super>Return'],
        'files': ['<Super>e'],
        'toggle-sidebar': ['<Super>b'],
        'shortcuts': ['<Super>slash'],
    },
};

/** Remove // and block comments and trailing commas, leaving strings intact. */
export function stripJsonc(text) {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (j < n && text[j] !== '"') {
                if (text[j] === '\\')
                    j++;
                j++;
            }
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n')
                i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
        } else {
            out += c;
            i++;
        }
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
    const result = {};
    for (const key of Object.keys(base)) {
        const b = base[key];
        const o = over?.[key];
        if (o === undefined)
            result[key] = isPlainObject(b) ? merge(b, {}) : b;
        else if (isPlainObject(b) && isPlainObject(o))
            result[key] = merge(b, o);
        else if (typeof o === typeof b && Array.isArray(o) === Array.isArray(b))
            result[key] = o;
        else
            result[key] = isPlainObject(b) ? merge(b, {}) : b;
    }
    // Keys the defaults do not list are kept only for free-form maps.
    if (isPlainObject(over)) {
        for (const key of Object.keys(over)) {
            if (!(key in base))
                result[key] = over[key];
        }
    }
    return result;
}

export class Config {
    constructor() {
        this._listeners = new Set();
        this._dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'kelpshell']);
        this.path = GLib.build_filenamev([this._dir, 'config.jsonc']);
        this.values = merge(DEFAULTS, {});
        this.error = null;
    }

    enable() {
        // The directory has to exist for the file monitor to see a config
        // file that is created later.
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._load();
        try {
            const file = Gio.File.new_for_path(this._dir);
            this._monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', (_m, changed) => {
                if (changed.get_basename() !== 'config.jsonc')
                    return;
                if (this._reloadId)
                    GLib.source_remove(this._reloadId);
                this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._reloadId = 0;
                    this._load();
                    for (const fn of this._listeners)
                        fn();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.warn(`kelpshell: cannot watch ${this._dir}: ${e.message}`);
        }
    }

    disable() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._listeners.clear();
    }

    onChanged(fn) {
        this._listeners.add(fn);
    }

    /** Read the file. A file that does not parse keeps the previous values. */
    _load() {
        this.error = null;
        let user = {};
        try {
            const [ok, bytes] = GLib.file_get_contents(this.path);
            if (ok)
                user = JSON.parse(stripJsonc(new TextDecoder().decode(bytes)));
        } catch (e) {
            if (e.matches?.(GLib.FileError, GLib.FileError.NOENT)) {
                user = {};
            } else {
                this.error = e.message;
                console.warn(`kelpshell: ${this.path}: ${e.message}`);
                return;
            }
        }
        this.values = merge(DEFAULTS, user);
    }
}
