#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Write stylesheet-light.css from stylesheet-dark.css.

stylesheet-dark.css holds the dark style and is the only file to edit. The shell
loads stylesheet-light.css in its place while the light style is on, so that
file repeats every rule with the colours changed:

  rgba(255, 255, 255, a)  ->  rgba(0, 0, 0, a)
  #ffffff                 ->  #101114
  #f4f4f6                 ->  #1c1e22

A declaration followed by /* light: VALUE */ gets VALUE. One followed by
/* light: keep */ is copied as it is, and so is everything between
/* light: keep begin */ and /* light: keep end */.

Run after every change of stylesheet-dark.css:  dev/light-css.py
"""
import re
from pathlib import Path

DIR = Path(__file__).resolve().parent.parent / 'kelpshell@aicheye'
MARK = re.compile(r'\s*/\* light: (.*?) \*/')


def convert(text):
    out = []
    keep = False
    comment = False
    for line in text.splitlines():
        mark = MARK.search(line)
        value = mark.group(1) if mark else None
        if value == 'keep begin':
            keep = True
            continue
        if value == 'keep end':
            keep = False
            continue
        code = MARK.sub('', line)
        starts = code.lstrip().startswith(('/*', '*'))
        if comment or starts:
            comment = '*/' not in code if (comment or '/*' in code) else False
            out.append(code)
            continue
        if keep or value == 'keep':
            out.append(code)
        elif value is not None:
            out.append(re.sub(r':\s*[^;]*;', f': {value};', code, count=1))
        else:
            code = code.replace('rgba(255, 255, 255,', 'rgba(0, 0, 0,')
            code = code.replace('#ffffff', '#101114').replace('#f4f4f6', '#1c1e22')
            out.append(code)
    return '\n'.join(out) + '\n'


def main():
    dark = (DIR / 'stylesheet-dark.css').read_text()
    head = ('/* Made by dev/light-css.py from stylesheet-dark.css: the same rules '
            'with the colours\n   of the light style. Edit stylesheet-dark.css and '
            'run the script again. */\n\n')
    (DIR / 'stylesheet-light.css').write_text(head + convert(dark))


if __name__ == '__main__':
    main()
