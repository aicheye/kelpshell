// One-line labels that keep their height.

import Pango from 'gi://Pango';

/**
 * Keep a one-line label at the height, and on the baseline, of text in its
 * own font. Pango takes the glyphs a font lacks from other fonts: CJK,
 * Arabic, some symbols. Those fonts have taller lines. A title with such a
 * glyph made its label a few pixels taller and moved the text down, and
 * everything laid out around the label moved with it.
 *
 * The text actor gets the height of a Latin line in its font, and is moved
 * so its baseline is where that line has it. Wrapping is on together with
 * the ellipsis: Clutter then asks Pango for the lines that fit the height,
 * which is one line with an ellipsis, and does not clip the glyphs that
 * reach outside the box.
 */
export function steadyLine(label) {
    const text = label.clutter_text;
    text.ellipsize = Pango.EllipsizeMode.END;
    text.line_wrap = true;
    text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    const sync = () => {
        // Off the stage the label has no style, so no font yet.
        if (!label.get_stage())
            return;
        // On a scaled display the actor lays its text out at the scale of
        // the display, with a scale attribute. The reference line is a copy
        // of the actor's own layout with other text, so it has that
        // attribute and the font, and the two baselines are in the same
        // pixels whatever the scale is. Until 2026-11-21 the reference was
        // given the scale that text.get_resource_scale() returned. For an
        // actor that is not shown that can be 1 while its layout is at 2,
        // and the text was then moved up by one whole baseline: the
        // "Notifications" heading and the title of a drawn title bar sat
        // 11px too high until their next style change.
        const layout = text.get_layout();
        const ref = layout.copy();
        ref.set_text('Ag', -1);
        ref.set_width(-1);
        ref.set_height(-1);
        // The same line with no scale, to find the scale of the layout.
        // The font is read as a string. In Mutter 51 the description that
        // text.get_font_description() returns is freed a second time once
        // GJS collects it, which aborts the shell.
        const plain = text.create_pango_layout('Ag');
        if (text.font_name)
            plain.set_font_description(Pango.FontDescription.from_string(text.font_name));
        const [, refHeight] = ref.get_size();
        const [, plainHeight] = plain.get_size();
        // Scales are multiples of a quarter. The ratio of the two heights
        // is a little off one, because glyph sizes are rounded.
        const scale = plainHeight > 0
            ? Math.max(0.25, Math.round(4 * refHeight / plainHeight) / 4) : 1;
        const height = Math.ceil(refHeight / Pango.SCALE / scale);
        // Not text.height: before the first allocation that is the height
        // of the text on one line, which is this height, and the label
        // would then be left free to wrap.
        if (!text.natural_height_set || text.natural_height !== height)
            text.height = height;
        const baseline = text.text ? layout.get_baseline() : ref.get_baseline();
        text.translation_y = Math.round((ref.get_baseline() - baseline) / Pango.SCALE / scale);
    };
    text.connect('notify::text', sync);
    // The font comes from the stylesheet, on the first style change and on
    // every one after a change of the theme or the scale. St.Label gives
    // the font to the text actor in its own handler of this signal, which
    // runs after handlers added with connect(). With connect() the first
    // height was that of the default font, "Sans 12": 23px for a 15px line,
    // until the next style change two frames later.
    label.connect_after('style-changed', sync);
    text.connect('resource-scale-changed', sync);
}
