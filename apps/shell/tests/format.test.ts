import { visibleWidth } from "@earendil-works/pi-tui";
import { visibleText } from "@haril/core";
import { describe, expect, it } from "vitest";
import { fit, pad, wrap } from "../src/format.js";

// fit and wrap are the render boundary (LD-T5): every line of the frame passes through one of them before the theme
// colors it. Text from the store, an agent or the CLI leaves them as plain text: no control character survives.

const HOSTILE =
  "a\x1b[2Jb\x1b]0;title\x07c\x1b]52;c;ZmFrZS1jbGlw\x07d\x1b[8me\rf\tg\u009bh\u007fi\u0000j";
const DEFUSED = "a?[2Jb?]0;title?c?]52;c;ZmFrZS1jbGlw?d?[8me?f g?h?i?j";

// C0 controls (ESC, BEL, CR, NUL...), DEL and C1 controls.
function hasControl(text: string): boolean {
  return [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

describe("fit and wrap keep the frame plain (LD-T5)", () => {
  it("replace every control character one for one, and a tab with a space", () => {
    expect(fit(HOSTILE, 200)).toBe(DEFUSED);
    expect(DEFUSED).toHaveLength(HOSTILE.length);
    expect(wrap(HOSTILE, 200)).toEqual([DEFUSED]);
  });

  it("never return a control character, cut or wrapped", () => {
    for (const line of [fit(HOSTILE, 12), ...wrap(HOSTILE, 9), ...wrap(`x ${HOSTILE} y`, 7)]) {
      expect(hasControl(line)).toBe(false);
    }
  });

  it("count a defused sequence as the cells it now takes, so a cut line still fits", () => {
    const cut = fit(HOSTILE, 12);
    expect(cut).toBe("a?[2Jb?]0;t…");
    for (const line of wrap(HOSTILE, 9)) expect(line.length).toBeLessThanOrEqual(9);
  });

  it("never cut a line wider than asked, even when a wide character straddles the cut", () => {
    for (const text of ["ああああ", "aあbいcう", "テーマ名がとても長い場合のテスト", "x界y"]) {
      for (let columns = 0; columns <= 12; columns++) {
        const cut = fit(text, columns);
        expect(visibleWidth(cut)).toBeLessThanOrEqual(columns);
        if (visibleWidth(text) > columns && columns > 0) expect(cut).toContain("…");
      }
    }
    // The cut takes exactly the columns: a wide character that does not fit leaves a space.
    expect(visibleWidth(fit("ああああ", 4))).toBe(4);
  });

  it("wrap keeps line breaks, LF or CRLF, as breaks", () => {
    expect(wrap("one\r\ntwo\nthree", 80)).toEqual(["one", "two", "three"]);
    expect(wrap("one\n\nthree", 80)).toEqual(["one", "", "three"]);
  });
});

describe("visibleText keeps only what the screen shows (LD-T6b-2)", () => {
  it("turns every Unicode format character but the zero-width joiner into ?, one per code point", () => {
    // Zero-width space, right-to-left override, byte-order mark, soft hyphen, word joiner and two tag characters.
    const hidden = "do\u{200B}it\u{202E}!\u{FEFF}\u{AD}\u{2060}\u{E0041}\u{E007F}";
    expect(visibleText(hidden)).toBe("do?it?!?????");
    // An emoji sequence keeps its joiner and its variation selector.
    const emoji = "\u{1F468}\u{200D}\u{1F469} \u{2764}\u{FE0F}";
    expect(visibleText(emoji)).toBe(emoji);
  });

  it("defuses control characters as fit does and turns a lone surrogate into ?", () => {
    expect(visibleText("a\x1b[2Jb\tc")).toBe("a?[2Jb c");
    expect(visibleText("x\ud83d")).toBe("x?");
    expect(visibleText("\ude00y")).toBe("?y");
    expect(visibleText("\u{D83D}\u{DE00}")).toBe("\u{1F600}");
  });
});

// Format characters and lone surrogates draw nothing or reorder the text around them, so a goal in a plan could carry
// words its approver never sees. The render boundary shows each one as "?", like a control character (LD-T6c).
describe("the render boundary shows what the screen draws (LD-T6c)", () => {
  // Zero-width space, right-to-left override and pop, byte-order mark, two tag characters and a lone surrogate.
  const hidden = "do\u{200B}it\u{202E}ti\u{202C}!\u{FEFF}\u{E0041}\u{E007F}\ud83d";
  const shown = "do?it?ti?!????";
  const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

  it("fit and wrap turn every format character but the joiner, and every lone surrogate, into ?", () => {
    expect(fit(hidden, 200)).toBe(shown);
    expect(wrap(hidden, 200)).toEqual([shown]);
    expect(wrap(`a\u{200B}b\n${hidden}`, 200)).toEqual(["a?b", shown]);
  });

  it("a cut line never keeps a format character and still fits its cells", () => {
    const planted = [
      "\u{200B}",
      "\u{202E}",
      "\u{202C}",
      "\u{FEFF}",
      "\u{E0041}",
      "\u{E007F}",
      "\ud83d",
    ];
    for (let columns = 1; columns <= 16; columns++) {
      const cut = fit(hidden, columns);
      for (const char of planted) expect(cut).not.toContain(char);
      expect(visibleWidth(cut)).toBeLessThanOrEqual(columns);
    }
    expect(fit(hidden, 6)).toBe("do?it…");
  });

  it("an emoji sequence keeps its joiners, whole or not at all", () => {
    expect(fit(`team ${family}`, 20)).toBe(`team ${family}`);
    expect(wrap(`team ${family}`, 20)).toEqual([`team ${family}`]);
    expect(fit(`team ${family} x`, 7)).toBe("team … ");
  });

  it("pad gives exactly the cells asked, over the text as the screen shows it", () => {
    expect(pad("a\u{E0041}b", 6)).toBe("a?b   ");
    expect(pad("do\u{200B}it\u{202E}", 8)).toBe("do?it?  ");
    expect(pad(`bot${family}`, 8)).toBe(`bot${family}   `);
    for (const text of ["abc", "abcdefgh", "a\u{E0041}b\u{E0042}c", `bot${family}x`, "ああああ"]) {
      for (const width of [1, 3, 5, 8, 13]) expect(visibleWidth(pad(text, width))).toBe(width);
    }
    // A text as wide as the column or wider is cut so one space still separates it from the next.
    expect(pad("abcdefgh", 5)).toBe("abcd ");
    expect(pad("ああああ", 5)).toBe("ああ ");
  });
});

// Each code point of an inclusive range, as a string.
function range(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, offset) =>
    String.fromCodePoint(first + offset),
  );
}

// ASCII hidden in variation selectors, one per byte: bytes 0-15 in U+FE00-FE0F, the others in U+E0100-E01EF. A
// terminal draws none of them, so after a visible letter the whole text vanishes.
function smuggle(text: string): string {
  return [...text]
    .map((char) => {
      const byte = char.charCodeAt(0);
      return String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16);
    })
    .join("");
}

// Invisible code points that are not format characters: Unicode marks them default-ignorable, and pi-tui counts them
// as no cell (LD-T6c). The ranges are listed by hand, not with the property the code uses.
describe("the render boundary shows default-ignorable code points as ? too (LD-T6c)", () => {
  const ignorable: readonly (readonly [string, number, number])[] = [
    ["variation selectors 1-16", 0xfe00, 0xfe0f],
    ["variation selectors 17-256", 0xe0100, 0xe01ef],
    ["combining grapheme joiner", 0x034f, 0x034f],
    ["Khmer inherent vowels", 0x17b4, 0x17b5],
    ["Mongolian free variation selectors", 0x180b, 0x180d],
    ["Mongolian free variation selector four", 0x180f, 0x180f],
    ["Hangul choseong filler", 0x115f, 0x115f],
    ["Hangul jungseong filler", 0x1160, 0x1160],
    ["Hangul filler", 0x3164, 0x3164],
    ["halfwidth Hangul filler", 0xffa0, 0xffa0],
    ["unassigned specials", 0xfff0, 0xfff8],
    ["unassigned after the tags", 0xe0080, 0xe0fff],
  ];

  it("a run of variation selectors after a letter shows as one ? each", () => {
    const hidden = `S${smuggle("rm -rf ~ and push secrets")}`;
    expect([...hidden]).toHaveLength(26);
    expect(fit(hidden, 80)).toBe(`S${"?".repeat(25)}`);
    expect(wrap(`Plan: ${hidden}`, 80)).toEqual([`Plan: S${"?".repeat(25)}`]);
    expect(visibleText(`A${"\u{FE0F}".repeat(5)}`)).toBe("A?????");
  });

  it.each(ignorable)("%s: each code point shows as ?", (_name, first, last) => {
    for (const char of range(first, last)) {
      expect(fit(`a${char}b`, 10)).toBe("a?b");
      expect(pad(`a${char}b`, 4)).toBe("a?b ");
    }
  });

  it("keeps the emoji presentation selector after an emoji, and only one", () => {
    // Heart, keycaps 1 and #, copyright: each with U+FE0F; smiling face with the text selector U+FE0E.
    for (const kept of [
      "\u{2764}\u{FE0F}",
      "\u{31}\u{FE0F}\u{20E3}",
      "\u{23}\u{FE0F}\u{20E3}",
      "\u{A9}\u{FE0F}",
      "\u{263A}\u{FE0E}",
    ]) {
      expect(fit(kept, 10)).toBe(kept);
    }
    expect(fit("\u{2764}\u{FE0F}\u{FE0F}\u{FE0F}", 10)).toBe("\u{2764}\u{FE0F}??");
  });
});

// U+200D joins emoji and forms the half-forms of Indic scripts; anywhere else it draws nothing (LD-T6c).
describe("the zero-width joiner is kept only where it joins (LD-T6c)", () => {
  it("a joiner after a letter, or a run of them, shows as ?", () => {
    expect(fit(`a${"\u{200D}".repeat(10)}b`, 20)).toBe(`a${"?".repeat(10)}b`);
    expect(fit("x\u{200D}y", 10)).toBe("x?y");
    expect(fit("\u{200D}start", 10)).toBe("?start");
    // After an emoji only the first joiner joins.
    expect(fit("\u{1F468}\u{200D}\u{200D}\u{1F469}", 10)).toBe("\u{1F468}\u{200D}?\u{1F469}");
    // After a selector that was itself shown as ?, the joiner joins nothing.
    expect(fit("S\u{FE0F}\u{200D}T", 10)).toBe("S??T");
  });

  it("keeps the joiner of emoji sequences and of a Devanagari half-form", () => {
    for (const kept of [
      // Man, woman, girl.
      "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
      // Rainbow flag: white flag, U+FE0F, joiner, rainbow.
      "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
      // Eye in speech bubble.
      "\u{1F441}\u{FE0F}\u{200D}\u{1F5E8}\u{FE0F}",
      // Man golfing, medium skin tone: the joiner follows the skin tone modifier.
      "\u{1F3CC}\u{1F3FD}\u{200D}\u{2642}\u{FE0F}",
      // Woman technologist, dark skin tone.
      "\u{1F469}\u{1F3FF}\u{200D}\u{1F4BB}",
      // Devanagari ka, virama, joiner, ssa: the half-form of ka.
      "\u{0915}\u{094D}\u{200D}\u{0937}",
    ]) {
      expect(fit(kept, 20)).toBe(kept);
      expect(wrap(kept, 20)).toEqual([kept]);
    }
  });
});

// What the screen draws stays as it is: emoji with their modifiers and the scripts whose marks are not ignorable.
describe("visible text of every script passes the boundary unchanged (LD-T6c)", () => {
  it.each([
    ["flag of Japan", "\u{1F1EF}\u{1F1F5}"],
    ["thumbs up, medium skin tone", "\u{1F44D}\u{1F3FD}"],
    ["CJK", "\u{6F22}\u{5B57}"],
    ["Hangul syllables", "\u{D55C}\u{AD6D}\u{C5B4}"],
    ["Hangul jamo", "\u{1100}\u{1161}\u{11A8}"],
    ["Bengali", "\u{09AC}\u{09BE}\u{0982}\u{09B2}\u{09BE}"],
    ["Tamil", "\u{0BA4}\u{0BAE}\u{0BBF}\u{0BB4}\u{0BCD}"],
    ["Thai", "\u{0E20}\u{0E32}\u{0E29}\u{0E32}\u{0E44}\u{0E17}\u{0E22}"],
    ["Arabic", "\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629}"],
    ["Hebrew with nikud", "\u{05E9}\u{05B8}\u{05C1}\u{05DC}\u{05D5}\u{05B9}\u{05DD}"],
    ["Vietnamese with combining marks", "Tie\u{0302}\u{0301}ng Vie\u{0323}\u{0302}t"],
  ])("%s", (_name, text) => {
    expect(visibleText(text)).toBe(text);
    expect(fit(text, 40)).toBe(text);
  });
});
