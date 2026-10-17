import { describe, expect, it } from "vitest";
import { visibleText } from "../src/index.js";

// The visible-text rule (LD-T6c, moved to the Core in LD-T7c): the shell's render boundary and the CLI's human-readable
// output show text from the store, an agent or a person as the terminal draws it. Each control character and each
// invisible code point becomes "?"; what emoji sequences and scripts need is kept.

describe("visibleText", () => {
  it("turns every control character into ? one for one, and a tab into a space", () => {
    const hostile = "a\x1b[2Jb\x1b]52;c;ZmFrZS1jbGlw\x07c\rd\tg\u009bh\u007fi\u0000j";
    expect(visibleText(hostile)).toBe("a?[2Jb?]52;c;ZmFrZS1jbGlw?c?d g?h?i?j");
  });

  // MC-T1 fix: the Unicode line and paragraph separators break a line in some renderers and in a model's reading, so
  // a caller that keeps line breaks splits on them first; whatever is left of them shows as "?".
  it("turns the line separator and the paragraph separator into ?", () => {
    expect(visibleText("one\u{2028}two\u{2029}three")).toBe("one?two?three");
  });

  it("turns format characters, tag characters and lone surrogates into ?, one per code point", () => {
    expect(visibleText("ok\u{202E}txt.exe")).toBe("ok?txt.exe");
    expect(visibleText("do\u{200B}it\u{FEFF}\u{E0041}\u{E007F}")).toBe("do?it???");
    expect(visibleText("x\ud83d")).toBe("x?");
    expect(visibleText(`A${"\u{FE0F}".repeat(3)}`)).toBe("A???");
  });

  it("keeps emoji sequences, joiners where they join and the marks of every script", () => {
    for (const kept of [
      "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
      "\u{2764}\u{FE0F}",
      "\u{0915}\u{094D}\u{200D}\u{0937}",
      "Tie\u{0302}\u{0301}ng Vie\u{0323}\u{0302}t",
      "\u{1F600}",
    ]) {
      expect(visibleText(kept)).toBe(kept);
    }
    expect(visibleText("x\u{200D}y")).toBe("x?y");
  });
});
