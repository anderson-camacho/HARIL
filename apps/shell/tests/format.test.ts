import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { fit, visibleText, wrap } from "../src/format.js";

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

  it("defuses control characters as plain does and turns a lone surrogate into ?", () => {
    expect(visibleText("a\x1b[2Jb\tc")).toBe("a?[2Jb c");
    expect(visibleText("x\ud83d")).toBe("x?");
    expect(visibleText("\ude00y")).toBe("?y");
    expect(visibleText("\u{D83D}\u{DE00}")).toBe("\u{1F600}");
  });
});
