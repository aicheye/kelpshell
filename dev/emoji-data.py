#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Write kelpshell@aicheye/data/emoji.txt from the emoji table of GTK 4.

The table is in the GTK library (/org/gtk/libgtk/emoji/en.data): every emoji
in the order of the Unicode list, with its name, its search words and its
group. One line is written for each emoji the installed emoji font draws as
one glyph:

  GROUP <tab> EMOJI <tab> NAME <tab> WORDS

GROUP is the number GTK gives: 0 smileys, 1 people, 3 animals and nature,
4 food and drink, 5 travel and places, 6 activities, 7 objects, 8 symbols,
9 flags. Group 2 (skin tones and hair, parts of other emoji) is left out.

Run again after an update of GTK or of the emoji font:  dev/emoji-data.py
"""
import subprocess
from pathlib import Path

import gi
gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import GLib, Pango, PangoCairo  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / 'kelpshell@aicheye' / 'data' / 'emoji.txt'
LIBRARY = '/usr/lib64/libgtk-4.so.1'
RESOURCE = '/org/gtk/libgtk/emoji/en.data'


def main():
    data = subprocess.run(['gresource', 'extract', LIBRARY, RESOURCE],
                          check=True, capture_output=True,
                          stdin=subprocess.DEVNULL).stdout
    table = GLib.Variant.new_from_bytes(
        GLib.VariantType('a(aussasasu)'), GLib.Bytes.new(data), False).unpack()

    context = PangoCairo.FontMap.get_default().create_context()
    layout = Pango.Layout(context)
    # The emoji font of the system, whichever it is (fc-match emoji).
    layout.set_font_description(Pango.FontDescription.from_string('emoji 16'))

    def drawn(text):
        layout.set_text(text, -1)
        if layout.get_unknown_glyphs_count() > 0:
            return False
        line = layout.get_line_readonly(0)
        runs = line.runs if line else []
        return len(runs) == 1 and runs[0].glyphs.num_glyphs == 1

    lines = []
    left_out = []
    for codes, name, _short, words, _more, group in table:
        if group == 2:
            continue
        # Where a skin tone can stand the table has 0 or the lightest tone
        # (U+1F3FB). Without it the emoji is the plain one.
        text = ''.join(chr(c) for c in codes if c != 0 and not 0x1F3FB <= c <= 0x1F3FF)
        if not drawn(text):
            left_out.append(name)
            continue
        own = set(name.lower().split())
        extra = ' '.join(w for w in dict.fromkeys(words) if w not in own)
        lines.append(f'{group}\t{text}\t{name}\t{extra}')
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text('\n'.join(lines) + '\n')
    print(f'{OUT}: {len(lines)} emoji, {len(left_out)} left out: {left_out[:12]}')


main()
