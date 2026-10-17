// What a terminal shows of a text (LD-T6c; in the Core since LD-T7c, so the shell's render boundary and the CLI's
// human-readable output apply one rule). Text from the store, an agent or a person may hold escape sequences that
// would clear the screen, move the cursor, set the title or the clipboard, or hide text, and invisible code points that
// draw nothing or reorder the text around them. Pure: no terminal library.

// An emoji presentation selector (U+FE0E, U+FE0F) that follows no emoji. After one, as in a red heart or a keycap, it
// is part of what is drawn.
const LOOSE_SELECTOR = /(?<!\p{Emoji})[\u{FE0E}\u{FE0F}]/gu;
// Every other invisible code point: a format character (zero-width spaces, bidirectional overrides, tag characters...)
// or another default-ignorable one (the other variation selectors, the Hangul fillers, unassigned specials...), and a
// lone surrogate. The joiner is left to LOOSE_JOINER.
const INVISIBLE =
  /(?![\u{200D}\u{FE0E}\u{FE0F}])[\p{Cf}\p{Default_Ignorable_Code_Point}]|[\u{D800}-\u{DFFF}]/gu;
// A zero-width joiner that joins nothing: one not right after a pictograph, U+FE0F, a skin tone or a combining mark
// (the virama of an Indic half-form). A joiner after a joiner is one of them, so a run keeps at most its first.
const LOOSE_JOINER =
  /(?<!\p{Extended_Pictographic}|\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]|\p{Mn})\u{200D}/gu;

// Text as the screen shows it: each control character (C0 with ESC, CR and LF, DEL, C1) and each invisible code point
// above becomes "?", and a tab a space. Such a code point draws nothing or reorders the text around it, so without this
// a plan could carry words its approver never sees (LD-T6c). It keeps what emoji sequences and scripts need: the
// presentation selector right after an emoji, the joiner where it joins, and the combining marks (accents, nikud,
// viramas), which draw. One "?" per code point: a tag character is two UTF-16 units and no cell, its "?" one unit and
// one cell, so text is measured or padded only once it is shown this way. A caller that keeps line breaks splits the
// text into lines first.
export function visibleText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "\t") out += " ";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += "?";
    else out += char;
  }
  // The joiners are judged last, on the text with every other invisible code point already shown as "?".
  return out.replace(LOOSE_SELECTOR, "?").replace(INVISIBLE, "?").replace(LOOSE_JOINER, "?");
}
