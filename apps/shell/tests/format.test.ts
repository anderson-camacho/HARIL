import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { fit, pad, visibleText, wrap } from "../src/format.js";

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
    for (let columns = 1; columns <= 16; columns++) {
      const cut = fit(hidden, columns);
      expect(cut).not.toMatch(/\p{Cf}|[\u{D800}-\u{DFFF}]/u);
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
