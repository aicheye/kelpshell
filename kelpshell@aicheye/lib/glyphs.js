// SPDX-License-Identifier: GPL-3.0-or-later

// Emoji, emoticons and symbols for the picker (lib/clipboard.js): what there
// is to choose from, which of them were used last, and the grid that shows
// them.
//
// The emoji are read from data/emoji.txt, which dev/emoji-data.py writes
// from the emoji table of GTK: those the emoji font of the system draws as
// one glyph (1900 of 1906 with Apple Color Emoji, all 1906 with Noto Color
// Emoji), each with its name and its search words. The file is read once, when the extension is enabled, and
// not when the picker opens.
//
// What was chosen is kept, the newest first, and shown as the first section
// of its page. The file is $XDG_STATE_HOME/kelpshell/glyphs.json.
//
// The grid makes buttons for the rows that are in view only, and gives them
// to other cells as it is scrolled. With a button for each of the 1900 emoji
// St would compute 1900 styles the first time the page is shown.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {KineticScroll} from './kinetic.js';

const VERTICAL = Clutter.Orientation.VERTICAL;

const SAVE_DELAY_MS = 1000;
const FOUND = 80;           // emoji shown for a search
const TITLE = 24;           // px, the height of the title of a section
const AHEAD = 40;           // px over and under the view that have their buttons too

// The numbers of the groups in data/emoji.txt.
const GROUPS = new Map([
    [0, 'Smileys'], [1, 'People'], [3, 'Animals and nature'], [4, 'Food and drink'],
    [5, 'Travel and places'], [6, 'Activities'], [7, 'Objects'], [8, 'Symbols'], [9, 'Flags'],
]);

/** The sections of the emoji page, with the pictures Adwaita has for them. */
export const SECTION_ICONS = {
    'Recent': 'emoji-recent-symbolic',
    'Smileys': 'emoji-people-symbolic',
    'People': 'emoji-body-symbolic',
    'Animals and nature': 'emoji-nature-symbolic',
    'Food and drink': 'emoji-food-symbolic',
    'Travel and places': 'emoji-travel-symbolic',
    'Activities': 'emoji-activities-symbolic',
    'Objects': 'emoji-objects-symbolic',
    'Symbols': 'emoji-symbols-symbolic',
    'Flags': 'emoji-flags-symbolic',
};

/**
 * The pages. columns and cell (px, the height of a row) lay out the grid,
 * recent is how many of the last used are shown.
 *
 * An emoticon takes as many of the six columns as its text needs
 * (GlyphGrid._span). With two columns as wide as the longest emoticon,
 * ":-)" would stand alone in 159 px.
 */
export const PAGES = {
    emoji: {columns: 8, cell: 38, recent: 16},
    kaomoji: {columns: 6, cell: 34, recent: 6},
    symbols: {columns: 8, cell: 36, recent: 16},
};

const KAOMOJI = [
    ['Classic', [':-)', ';-)', ':-D', ':-P', ':-(', ":'(", ':-O', ':-/', ':-|', 'XD', '<3', '^_^']],
    ['Happy', ['(◕‿◕)', '(＾▽＾)', '(≧◡≦)', 'ヽ(•‿•)ノ', '\\(^o^)/', '(*^_^*)', 'ʕ•ᴥ•ʔ',
        '(づ｡◕‿‿◕｡)づ', '(☞ﾟヮﾟ)☞', '☜(ﾟヮﾟ☜)']],
    ['Sad', ['(╥﹏╥)', '(ಥ﹏ಥ)', '(T_T)', '(｡•́︿•̀｡)', '(>_<)', 'm(_ _)m']],
    ['Angry', ['(╯°□°）╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '(ノಠ益ಠ)ノ彡┻━┻', 'ಠ_ಠ', 'ಠ益ಠ', '(¬_¬)',
        '(ง •̀_•́)ง']],
    ['Other', ['¯\\_(ツ)_/¯', '( ͡° ͜ʖ ͡°)', '(•_•)', '( •_•)>⌐■-■', '(⌐■_■)', 'ʘ‿ʘ', 'o_O',
        '(-_-) zzz', '(～￣▽￣)～', '(｡♥‿♥｡)']],
];

const SYMBOLS = [
    ['Punctuation', '… — – • · « » ‹ › “ ” ‘ ’ „ ¡ ¿ § ¶ † ‡ ‰ ′ ″ © ® ™ ° №'],
    ['Currency', '€ £ ¥ ¢ ₹ ₽ ₩ ₪ ₫ ₺ ₴ ₦ ₱ ฿ ₿ ¤'],
    ['Arrows', '← ↑ → ↓ ↔ ↕ ↖ ↗ ↘ ↙ ⇐ ⇑ ⇒ ⇓ ⇔ ↩ ↪ ↵ ➜ ⟶'],
    ['Math', '± × ÷ ≠ ≈ ≡ ≤ ≥ ∞ √ ∑ ∏ ∫ ∂ ∆ ∇ ∈ ∉ ∩ ∪ ⊂ ⊃ ∧ ∨ ¬ ∀ ∃ ∅ ∝ ∴ ½ ⅓ ¼ ¾ ¹ ² ³ ⁿ'],
    ['Greek', 'α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω'],
    ['Shapes', '■ □ ▪ ▫ ● ○ ◆ ◇ ▲ △ ▼ ▽ ▶ ◀ ★ ☆ ♠ ♣ ♥ ♦ ✓ ✗ ♪ ♫ ☐ ☑ ☒'],
    ['Latin', 'À Á Â Ã Ä Å Æ Ç È É Ê Ë Ì Í Î Ï Ñ Ò Ó Ô Õ Ö Ø Ù Ú Û Ü ß ' +
        'à á â ã ä å æ ç è é ê ë ì í î ï ñ ò ó ô õ ö ø ù ú û ü ÿ œ Œ'],
];

/** The words of a text, in lower case and without accents. */
function wordsOf(text) {
    return text.toLowerCase().normalize('NFD').replace(/[\p{M}'\u2019]/gu, '')
        .split(/[^\p{L}\p{N}]+/u).filter(w => w);
}

// A fit of at least IN_A_ROW has the typed letters in a row in the word, and
// one of at least WHOLE is the whole word with a slip.
const IN_A_ROW = 60;
const WHOLE = 30;

/**
 * How well a typed word fits a word of an emoji, 0 for not at all:
 *
 *   100  the word itself
 *    90  the start of the word ("thum" for "thumbs")
 *    60  inside the word, from three letters ("ball" for "football")
 *    40  the word with one slip, from four letters: a wrong letter, one too
 *        many, one missing, or two swapped ("hart" for "heart", "smlie"
 *        for "smile")
 *    35  the word with two slips, from eight letters
 *    20  the start of the word with one slip ("brithd" for "birthday"), or
 *        the word with up to two of its letters left out, from three
 *        letters ("hrt" for "heart")
 *    15  the start of the word with two slips
 *
 * With a slip or with letters left out the first letter has to be right.
 */
function fit(typed, word) {
    if (word === typed)
        return 100;
    if (word.startsWith(typed))
        return 90;
    const n = typed.length;
    if (n < 3)
        return 0;
    if (word.includes(typed))
        return IN_A_ROW;
    if (word[0] !== typed[0])
        return 0;
    let most = 0;
    if (n >= 8)
        most = 2;
    else if (n >= 4)
        most = 1;
    if (most > 0) {
        const [whole, start] = slips(typed, word, most);
        if (whole <= most)
            return 45 - 5 * whole;
        if (start <= most)
            return 25 - 5 * start;
    }
    return leftOut(typed, word) <= 2 ? 20 : 0;
}

/**
 * The fewest slips between typed and word, and between typed and a start
 * of word (the optimal string alignment distance), looked at up to most:
 * a word more than most longer than typed has Infinity for the first.
 */
function slips(typed, word, most) {
    const n = typed.length;
    const m = Math.min(word.length, n + most);
    let before = null;
    let last = Array.from({length: m + 1}, (_, j) => j);
    for (let i = 1; i <= n; i++) {
        const row = [i];
        for (let j = 1; j <= m; j++) {
            const same = typed[i - 1] === word[j - 1];
            let d = Math.min(last[j] + 1, row[j - 1] + 1, last[j - 1] + (same ? 0 : 1));
            if (i > 1 && j > 1 && typed[i - 1] === word[j - 2] && typed[i - 2] === word[j - 1])
                d = Math.min(d, before[j - 2] + 1);
            row.push(d);
        }
        before = last;
        last = row;
    }
    return [m === word.length ? last[m] : Infinity, Math.min(...last)];
}

/**
 * How many letters of word stand between the letters of typed, when typed
 * is in word with its letters in order. Infinity when it is not.
 */
function leftOut(typed, word) {
    let at = 0;
    let out = 0;
    for (const letter of typed) {
        const next = word.indexOf(letter, at);
        if (next < 0)
            return Infinity;
        out += next - at;
        at = next + 1;
    }
    return out;
}

/** What the pages show, and what was used last. */
export class Glyphs {
    /** dir: the directory of the extension, a Gio.File. */
    constructor(dir) {
        this._file = dir.get_child('data').get_child('emoji.txt');
        this._stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'kelpshell']);
        this._statePath = GLib.build_filenamev([this._stateDir, 'glyphs.json']);
        this._emoji = [];       // {text, name, group, words, named, joined}
        this._recent = {emoji: [], kaomoji: [], symbols: []};
        this._saveId = 0;
        this._enabled = false;
        // Called when the emoji have been read.
        this.onLoaded = null;
    }

    enable() {
        this._enabled = true;
        this._file.load_contents_async(null, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                if (this._enabled)
                    this._parse(new TextDecoder().decode(bytes));
            } catch (e) {
                console.warn(`kelpshell: ${this._file.get_path()}: ${e.message}`);
            }
        });
        Gio.File.new_for_path(this._statePath).load_contents_async(null, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                for (const page of Object.keys(this._recent)) {
                    const list = parsed?.[page];
                    if (this._enabled && Array.isArray(list))
                        this._recent[page] = list.filter(t => typeof t === 'string').slice(0, 32);
                }
            } catch (e) {
                // No file yet is the usual case.
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`kelpshell: ${this._statePath}: ${e.message}`);
            }
        });
    }

    disable() {
        this._enabled = false;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
    }

    _parse(text) {
        const emoji = [];
        for (const line of text.split('\n')) {
            const [group, glyph, name, words] = line.split('\t');
            if (!glyph || !name)
                continue;
            const named = wordsOf(name);
            emoji.push({
                text: glyph, name, group: Number(group),
                // The words of the name, then the search words.
                words: [...named, ...wordsOf(words ?? '')],
                named: named.length,
                // "thumbsup" for "thumbs up".
                joined: named.join(''),
            });
        }
        this._emoji = emoji;
        this.onLoaded?.();
    }

    /**
     * The sections of a page, each {title, items: [{text, name}]}. With a
     * query, the emoji whose name or search words fit every word of it
     * (see fit), and the sections of the other pages whose title does.
     */
    sections(page, query = '') {
        const words = wordsOf(query);
        if (page === 'emoji' && words.length > 0)
            return this._found(words);
        let sections;
        if (page === 'emoji') {
            sections = [...GROUPS].map(([group, title]) => ({
                title, items: this._emoji.filter(e => e.group === group),
            }));
        } else if (page === 'kaomoji') {
            sections = KAOMOJI.map(([title, list]) => ({
                title, items: list.map(text => ({text, name: text})),
            }));
        } else {
            sections = SYMBOLS.map(([title, list]) => ({
                title, items: list.split(' ').map(text => ({text, name: text})),
            }));
        }
        if (words.length > 0) {
            sections = sections.filter(s => {
                const title = wordsOf(s.title);
                return words.every(typed => title.some(word => fit(typed, word) > 0));
            });
        } else {
            const names = new Map(sections.flatMap(s => s.items).map(i => [i.text, i.name]));
            const recent = this._recent[page]
                .filter(text => names.has(text))
                .slice(0, PAGES[page].recent)
                .map(text => ({text, name: names.get(text)}));
            if (recent.length > 0)
                sections.unshift({title: 'Recent', items: recent});
        }
        sections = sections.filter(s => s.items.length > 0);
        return sections.length > 0 ? sections : [{title: 'Nothing found', items: []}];
    }

    /**
     * The emoji for the typed words, the best first. Each typed word counts
     * with the word of the emoji it fits best, and a word of the name counts
     * for more than a search word, the first word of the name for most. An
     * emoji whose name is what was typed is the first.
     *
     * An emoji is as good as the worst of its fits. Those with every typed
     * word in a row in a word are always shown. Those that need a slip in
     * a whole word are shown when the first kind fills less than one row
     * ("hart" finds four charts, and then the hearts), and the others
     * (the start of a word with a slip, letters left out) when there is
     * nothing else: after "piza" has found the pizza it does not go on to
     * the pirate flag.
     */
    _found(words) {
        const all = words.join('');
        const kinds = [[], [], []];
        for (const e of this._emoji) {
            let score = e.joined === all ? 50 : 0;
            let worst = 100;
            for (const typed of words) {
                let best = 0;
                let bestFit = 0;
                if (e.named > 1 && e.joined.startsWith(typed)) {
                    bestFit = 90;
                    best = bestFit + 20;
                }
                e.words.forEach((word, i) => {
                    const f = fit(typed, word);
                    if (f === 0)
                        return;
                    let bonus = 0;
                    if (i === 0)
                        bonus = 20;
                    else if (i < e.named)
                        bonus = 10;
                    const sum = f + bonus;
                    if (sum > best) {
                        best = sum;
                        bestFit = f;
                    }
                });
                worst = Math.min(worst, bestFit);
                if (best === 0)
                    break;
                score += best;
            }
            if (worst >= IN_A_ROW)
                kinds[0].push({e, score});
            else if (worst >= WHOLE)
                kinds[1].push({e, score});
            else if (worst > 0)
                kinds[2].push({e, score});
        }
        const [inARow, whole, other] = kinds;
        // The order of the file among equals.
        for (const kind of kinds)
            kind.sort((a, b) => b.score - a.score);
        let hits = inARow;
        if (hits.length < PAGES.emoji.columns)
            hits = [...hits, ...whole];
        if (hits.length === 0)
            hits = other;
        const items = hits.slice(0, FOUND).map(h => h.e);
        return [{title: items.length > 0 ? '' : 'Nothing found', items}];
    }

    /** text of a page was chosen: it is the first of the last used. */
    used(page, text) {
        const list = this._recent[page];
        if (!list)
            return;
        this._recent[page] = [text, ...list.filter(t => t !== text)].slice(0, 32);
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        try {
            GLib.mkdir_with_parents(this._stateDir, 0o755);
            const bytes = new TextEncoder().encode(JSON.stringify(this._recent));
            Gio.File.new_for_path(this._statePath).replace_contents_bytes_async(
                new GLib.Bytes(bytes), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                null, (file, result) => {
                    try {
                        file.replace_contents_finish(result);
                    } catch (e) {
                        console.warn(`kelpshell: ${this._statePath}: ${e.message}`);
                    }
                });
        } catch (e) {
            console.warn(`kelpshell: ${this._statePath}: ${e.message}`);
        }
    }
}

/**
 * A grid of sections that scrolls. activate(item) is called for a press on
 * a cell, scrolled() when other rows have come into view.
 */
export class GlyphGrid {
    constructor({activate, scrolled}) {
        this._activate = activate;
        this._scrolled = scrolled;
        this._starts = [];        // {title, y, first}: where each section begins
        this._items = [];
        // {title, y, height}, or a row of cells: {first, count, cells, y,
        // height}, where cells has {at, span} in columns for each of them.
        this._rows = [];
        this._columns = 1;
        this._cell = 1;
        this._page = '';
        this._width = 0;
        this._height = 0;
        this._buttons = new Map();  // index of an item -> its button
        this._titles = new Map();   // index of a row -> its label
        this._spareButtons = [];
        this._spareTitles = [];
        this.selected = 0;

        this._canvas = new St.Widget({layout_manager: new Clutter.FixedLayout(), x_expand: true});
        const box = new St.BoxLayout({orientation: VERTICAL});
        box.add_child(this._canvas);
        this.actor = new St.ScrollView({
            style_class: 'kelp-glyph-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: box,
        });
        this._adjustment = this.actor.vadjustment;
        this._adjustment.connect('notify::value', () => this._sync());
        // Goes on after a swipe on the touchpad.
        this._kinetic = new KineticScroll(this.actor);
    }

    /** px, the room the grid has. */
    setSize(width, height) {
        this._width = width;
        this._height = height;
        this.actor.set_size(width, height);
    }

    /** sections: [{title, items}]. page: its name, a key of PAGES. */
    setContent(page, sections) {
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._page = page;
        this._columns = PAGES[page].columns;
        this._cell = PAGES[page].cell * s;
        this._items = [];
        this._rows = [];
        this._starts = [];
        let y = 0;
        for (const section of sections) {
            this._starts.push({title: section.title, y, first: this._items.length});
            if (section.title) {
                this._rows.push({title: section.title, y, height: TITLE * s});
                y += TITLE * s;
            }
            let row = null;
            let used = 0;
            for (const [i, item] of section.items.entries()) {
                const span = this._span(item.text);
                if (!row || used + span > this._columns) {
                    row = {first: this._items.length + i, count: 0, cells: [], y, height: this._cell};
                    this._rows.push(row);
                    y += this._cell;
                    used = 0;
                }
                row.cells.push({at: used, span});
                row.count++;
                used += span;
            }
            this._items.push(...section.items);
        }
        this._canvas.set_height(y);
        for (const [index, button] of this._buttons)
            this._spare(index, button);
        for (const [row, label] of this._titles) {
            label.hide();
            this._spareTitles.push(label);
            this._titles.delete(row);
        }
        this.selected = 0;
        this._kinetic.stop();
        this._adjustment.value = 0;
        this._sync();
    }

    /**
     * How many columns a cell takes: one, or for an emoticon as many as its
     * text needs. The width of the text is an estimate, 8 px for a
     * character and 13 for a wide one, at the 12.5 px of the page.
     */
    _span(text) {
        if (this._page !== 'kaomoji')
            return 1;
        const s = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let width = 20;
        for (const character of text) {
            const c = character.codePointAt(0);
            // A mark that is drawn on the character before it.
            if ((c >= 0x300 && c <= 0x36f) || (c >= 0x1dc0 && c <= 0x1dff))
                continue;
            // Kana, ideographs and full width forms, but not half width kana.
            width += c >= 0x2e80 && !(c >= 0xff61 && c <= 0xff9f) ? 13 : 8;
        }
        const column = this._width / s / this._columns;
        return Math.max(1, Math.min(this._columns, Math.ceil(width / column)));
    }

    get current() {
        return this._items[this.selected] ?? null;
    }

    /** The title of the section at the top of the view. */
    get section() {
        const top = this._adjustment.value + 1;
        return this._starts.findLast(s => s.y <= top)?.title ?? '';
    }

    hasSection(title) {
        return this._starts.some(s => s.title === title);
    }

    /** Bring a section to the top of the view, with its first cell chosen. */
    showSection(title) {
        const start = this._starts.find(s => s.title === title);
        if (!start)
            return;
        this.select(start.first, false);
        const most = Math.max(0, this._canvas.height - this._height);
        this._adjustment.value = Math.min(start.y, most);
        this._scrolled?.();
    }

    /** The index of the item whose button is actor or holds it, or -1. */
    indexOf(actor) {
        for (let a = actor; a && a !== this.actor; a = a.get_parent()) {
            if (a._kelpIndex !== undefined && a.get_parent() === this._canvas)
                return a.visible ? a._kelpIndex : -1;
        }
        return -1;
    }

    select(index, reveal = true) {
        if (this._items.length === 0)
            return;
        const next = Math.max(0, Math.min(this._items.length - 1, index));
        this._buttons.get(this.selected)?.remove_style_pseudo_class('selected');
        this.selected = next;
        if (reveal) {
            const row = this._rows[this._rowOf(next)];
            const top = this._adjustment.value;
            if (row.y < top)
                this._adjustment.value = row.y;
            else if (row.y + row.height > top + this._height)
                this._adjustment.value = row.y + row.height - this._height;
        }
        this._buttons.get(next)?.add_style_pseudo_class('selected');
    }

    /** One cell left or right (dx), or one row up or down (dy). */
    move(dx, dy) {
        if (dx) {
            this.select(this.selected + dx);
            return;
        }
        // To the cell of the next row whose middle is nearest.
        const at = this._rowOf(this.selected);
        const middle = cell => cell.at + cell.span / 2;
        const from = middle(this._rows[at].cells[this.selected - this._rows[at].first]);
        for (let r = at + dy; r >= 0 && r < this._rows.length; r += dy) {
            const row = this._rows[r];
            if (!row.count)
                continue;
            let best = 0;
            row.cells.forEach((cell, i) => {
                if (Math.abs(middle(cell) - from) < Math.abs(middle(row.cells[best]) - from))
                    best = i;
            });
            this.select(row.first + best);
            return;
        }
    }

    _rowOf(index) {
        return this._rows.findIndex(r => r.count && index >= r.first && index < r.first + r.count);
    }

    _spare(index, button) {
        button.hide();
        button.remove_style_pseudo_class('selected');
        this._spareButtons.push(button);
        this._buttons.delete(index);
    }

    /** Give the rows in view their buttons, and take those of the others. */
    _sync() {
        const top = this._adjustment.value - AHEAD;
        const bottom = this._adjustment.value + this._height + AHEAD;
        const cellWidth = Math.floor(this._width / this._columns);
        const wanted = new Set();
        const titles = new Set();
        this._rows.forEach((row, r) => {
            if (row.y + row.height <= top || row.y >= bottom)
                return;
            if (!row.count) {
                titles.add(r);
                return;
            }
            for (let i = 0; i < row.count; i++)
                wanted.add(row.first + i);
        });
        for (const [index, button] of this._buttons) {
            if (!wanted.has(index))
                this._spare(index, button);
        }
        for (const [r, label] of this._titles) {
            if (!titles.has(r)) {
                label.hide();
                this._spareTitles.push(label);
                this._titles.delete(r);
            }
        }
        this._rows.forEach((row, r) => {
            if (titles.has(r) && !this._titles.has(r)) {
                const label = this._spareTitles.pop() ?? this._newTitle();
                label.text = row.title;
                label.set_position(0, row.y);
                label.set_size(this._width, row.height);
                label.show();
                this._titles.set(r, label);
            }
            if (!row.count || !wanted.has(row.first))
                return;
            for (let i = 0; i < row.count; i++) {
                const index = row.first + i;
                if (this._buttons.has(index))
                    continue;
                const button = this._spareButtons.pop() ?? this._newButton();
                button._kelpIndex = index;
                button.label = this._items[index].text;
                button.style_class = `kelp-glyph kelp-glyph-${this._page}`;
                button.set_position(row.cells[i].at * cellWidth, row.y);
                button.set_size(row.cells[i].span * cellWidth, row.height);
                if (index === this.selected)
                    button.add_style_pseudo_class('selected');
                button.show();
                this._buttons.set(index, button);
            }
        });
        this._scrolled?.();
    }

    _newTitle() {
        const label = new St.Label({style_class: 'kelp-glyph-title'});
        this._canvas.add_child(label);
        return label;
    }

    _newButton() {
        const button = new St.Button({style_class: 'kelp-glyph'});
        button.connect('clicked', () => {
            const item = this._items[button._kelpIndex];
            if (item) {
                this.select(button._kelpIndex, false);
                this._activate(item);
            }
        });
        // Motion and not hover, as in the launcher.
        button.connect('motion-event', () => {
            if (button._kelpIndex !== this.selected)
                this.select(button._kelpIndex, false);
            return Clutter.EVENT_PROPAGATE;
        });
        this._canvas.add_child(button);
        return button;
    }
}
