import { describe, expect, it } from "vitest";
import type { GitSummary } from "../src/git-summary.js";
import type { ConsoleTheme, ThemeColor } from "../src/pi-types.js";
import { type PowerlineInput, powerlineEnabled, powerlineHead } from "../src/powerline.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The folder line of the bar drawn as powerline segments (the Oh My Posh `craver` look): a folder segment and a git
// segment, each a block of the theme's own colour with a powerline arrow after it.

// Code points of the Powerline and Nerd Font glyphs, written out here so the tests do not share the module's constants.
const ARROW = String.fromCodePoint(0xe0b0);
const BRANCH = String.fromCodePoint(0xe0a0);
const FOLDER = String.fromCodePoint(0xf07b);
const ESC = String.fromCharCode(0x1b);
const REVERSE_ON = `${ESC}[7m`;
const REVERSE_OFF = `${ESC}[27m`;
const RESET = `${ESC}[0m`;

const IDENTITY: ConsoleTheme = { fg: (_tone, text) => text, bold: (text) => text };
// Colours that cannot be read back from the text: only the name of the token shows.
const TAGGED: ConsoleTheme = { fg: (tone, text) => `{${tone}:${text}}`, bold: (text) => text };

const RGB: Record<ThemeColor, readonly [number, number, number]> = {
  accent: [167, 139, 250],
  text: [226, 229, 238],
  muted: [141, 149, 168],
  dim: [75, 112, 88],
  success: [119, 255, 165],
  error: [255, 101, 118],
  warning: [245, 194, 107],
};

// What Pi's theme does with a truecolor terminal: `ESC[38;2;r;g;bm` text `ESC[39m`.
const TRUECOLOR: ConsoleTheme = {
  fg: (tone, text) => `${ESC}[38;2;${RGB[tone].join(";")}m${text}${ESC}[39m`,
  bold: (text) => `${ESC}[1m${text}${ESC}[22m`,
};
const PALETTE256: ConsoleTheme = {
  fg: (tone, text) => `${ESC}[38;5;${RGB[tone][0]}m${text}${ESC}[39m`,
  bold: (text) => text,
};
const ANSI16: ConsoleTheme = {
  fg: (tone, text) => `${ESC}[${tone === "warning" ? 93 : 33}m${text}${ESC}[39m`,
  bold: (text) => text,
};

const SOME: GitSummary = { staged: 1, modified: 2, untracked: 3 };
const CLEAN: GitSummary = { staged: 0, modified: 0, untracked: 0 };

function input(overrides: Partial<PowerlineInput> = {}): PowerlineInput {
  return { folder: "~/dev/haril", branch: "feat/powerline", git: SOME, ...overrides };
}

function plain(line: string): string {
  return stripAnsi(line);
}

// The escape sequences of a line, each from its "[" to the end of the line segment up to the next escape.
function sequences(line: string): string[] {
  return line.split(ESC).slice(1);
}

// A control character, or a code point that reorders text (a bidi override or isolate).
function hasHiddenCharacter(text: string): boolean {
  return [...text].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

describe("powerlineEnabled", () => {
  it("is on unless HARIL_POWERLINE turns it off", () => {
    expect(powerlineEnabled({})).toBe(true);
    expect(powerlineEnabled({ HARIL_POWERLINE: "" })).toBe(true);
    expect(powerlineEnabled({ HARIL_POWERLINE: "on" })).toBe(true);
    expect(powerlineEnabled({ HARIL_POWERLINE: "1" })).toBe(true);
    expect(powerlineEnabled({ HARIL_POWERLINE: "anything else" })).toBe(true);
  });

  it("is off for off, 0 and false, in any case and with spaces around", () => {
    for (const value of ["off", "OFF", " Off ", "0", "false", "FALSE"]) {
      expect(powerlineEnabled({ HARIL_POWERLINE: value }), value).toBe(false);
    }
  });
});

describe("the powerline segments", () => {
  it("draws the folder and the git segment, each followed by an arrow, with the branch and the counts", () => {
    const head = powerlineHead(input(), 200, TAGGED);
    expect(head).toBeDefined();
    expect(plain(head?.line ?? "")).toBe(
      `{accent: ${FOLDER} ~/dev/haril }{accent:${ARROW}}{warning: ${BRANCH} feat/powerline +1 ~2 ?3 }{warning:${ARROW}}`,
    );
  });

  it("prints a segment as reverse video on the theme's colour, and closes it", () => {
    const line = powerlineHead(input(), 200, TAGGED)?.line ?? "";
    expect(line.startsWith(`${REVERSE_ON}{accent:`)).toBe(true);
    expect(line.split(REVERSE_ON)).toHaveLength(3);
    expect(line.split(REVERSE_OFF)).toHaveLength(3);
    expect(line.endsWith(RESET)).toBe(true);
  });

  it("measures the head by the columns it takes", () => {
    const head = powerlineHead(input(), 200, TRUECOLOR);
    expect(head?.width).toBe(textWidth(plain(head?.line ?? "")));
  });

  it("names the changes with + for staged, ~ for modified and ? for untracked, and leaves out what is zero", () => {
    const counts = (git: GitSummary | undefined) =>
      plain(powerlineHead(input({ git }), 200, IDENTITY)?.line ?? "");
    expect(counts({ staged: 4, modified: 0, untracked: 0 })).toContain(" feat/powerline +4 ");
    expect(counts({ staged: 0, modified: 7, untracked: 0 })).toContain(" feat/powerline ~7 ");
    expect(counts({ staged: 0, modified: 0, untracked: 12 })).toContain(" feat/powerline ?12 ");
    expect(counts(CLEAN)).toContain(` ${BRANCH} feat/powerline ${ARROW}`);
    expect(counts(undefined)).toContain(` ${BRANCH} feat/powerline ${ARROW}`);
  });

  it("colours the git segment by its state: success when clean, warning with changes, muted when unknown", () => {
    const tone = (git: GitSummary | undefined) =>
      (powerlineHead(input({ git }), 200, TAGGED)?.line ?? "").match(/\{(\w+):[^}]*feat/)?.[1];
    expect(tone(CLEAN)).toBe("success");
    expect(tone(SOME)).toBe("warning");
    expect(tone(undefined)).toBe("muted");
  });

  it("has no git segment outside a repository", () => {
    const head = powerlineHead(input({ branch: null, git: undefined }), 200, TAGGED);
    expect(plain(head?.line ?? "")).toBe(`{accent: ${FOLDER} ~/dev/haril }{accent:${ARROW}}`);
    expect(plain(powerlineHead(input({ branch: "" }), 200, TAGGED)?.line ?? "")).not.toContain(
      BRANCH,
    );
  });
});

describe("the colours come from the theme", () => {
  it("joins two segments with an arrow in the first one's colour over the second one's, for a truecolor theme", () => {
    const line = powerlineHead(input(), 200, TRUECOLOR)?.line ?? "";
    const [r, g, b] = RGB.warning;
    const [ar, ag, ab] = RGB.accent;
    expect(line).toContain(`${ESC}[48;2;${r};${g};${b}m${ESC}[38;2;${ar};${ag};${ab}m${ARROW}`);
    // The last arrow stands on the terminal's own background.
    expect(line.endsWith(`${ESC}[38;2;${r};${g};${b}m${ARROW}${ESC}[39m${RESET}`)).toBe(true);
    expect(line.split(`${ESC}[48;`)).toHaveLength(2);
  });

  it("does the same with a 256-colour theme and with the 16 basic colours", () => {
    const palette = powerlineHead(input(), 200, PALETTE256)?.line ?? "";
    expect(palette).toContain(
      `${ESC}[48;5;${RGB.warning[0]}m${ESC}[38;5;${RGB.accent[0]}m${ARROW}`,
    );
    const basic = powerlineHead(input(), 200, ANSI16)?.line ?? "";
    expect(basic).toContain(`${ESC}[103m${ESC}[33m${ARROW}`);
  });

  it("sets no background of its own when the theme's colour cannot be read back", () => {
    for (const theme of [IDENTITY, TAGGED]) {
      const line = powerlineHead(input(), 200, theme)?.line ?? "";
      expect(sequences(line).some((item) => /^\[(48;|49m|4\d|10\d)/.test(item))).toBe(false);
      expect(plain(line)).toContain(ARROW);
    }
  });

  it("picks no colour of its own: the foregrounds are the theme's and the one background is a token's colour", () => {
    const line = powerlineHead(input(), 200, TRUECOLOR)?.line ?? "";
    const colours = (kind: string) =>
      new Set(
        sequences(line)
          .filter((item) => item.startsWith(`[${kind};2;`))
          .map((item) => item.slice(`[${kind};`.length, item.indexOf("m"))),
      );
    const rgb = (tone: ThemeColor) => `2;${RGB[tone].join(";")}`;
    expect(colours("38")).toEqual(new Set([rgb("accent"), rgb("warning")]));
    expect(colours("48")).toEqual(new Set([rgb("warning")]));
  });
});

describe("the width", () => {
  const INPUTS: PowerlineInput[] = [
    input(),
    input({ git: undefined }),
    input({ git: CLEAN }),
    input({ branch: null, git: undefined }),
    input({ branch: "b".repeat(500) }),
    input({ folder: `~/${"deep/".repeat(40)}project` }),
    input({ folder: "日本語のフォルダ/プロジェクト", branch: "機能/ブランチ" }),
  ];

  it("never exceeds the width, in 20, 40, 80 and 200 columns and in every width from 0 to 260", () => {
    for (const theme of [IDENTITY, TRUECOLOR]) {
      for (const item of INPUTS) {
        for (let width = 0; width <= 260; width++) {
          const head = powerlineHead(item, width, theme);
          if (head === undefined) continue;
          const drawn = textWidth(plain(head.line));
          expect(drawn, `width ${width}`).toBe(head.width);
          expect(drawn, `width ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("has nothing to draw in a width that cannot hold a segment", () => {
    for (const width of [-1, 0, 1, 2, 3]) {
      expect(powerlineHead(input(), width, IDENTITY), `width ${width}`).toBeUndefined();
    }
    expect(powerlineHead(input(), 4, IDENTITY)).toBeDefined();
  });

  it("gives way from the least needed part: the counts, then the branch name, the git segment, the folder", () => {
    const at = (width: number) => plain(powerlineHead(input(), width, IDENTITY)?.line ?? "");
    const full = powerlineHead(input(), 500, IDENTITY)?.width ?? 0;
    expect(at(full)).toContain("+1 ~2 ?3");
    // One column less: the counts go (they take 9 with their space), the whole branch name stays.
    expect(at(full - 1)).not.toContain("+1");
    expect(at(full - 1)).toContain("feat/powerline");
    const noCounts = full - 9;
    expect(at(noCounts)).toContain("feat/powerline");
    // Less: the branch name is cut with an ellipsis, then dropped, the arrow-and-icon segment staying.
    const cut = at(noCounts - 1);
    expect(cut).toContain(BRANCH);
    expect(cut).toContain("…");
    expect(cut).not.toContain("feat/powerline");
    const iconOnly = ` ${FOLDER} ~/dev/haril ${ARROW} ${BRANCH} ${ARROW}`;
    expect(at(textWidth(iconOnly))).toBe(iconOnly);
    // Less still: the git segment goes, then the folder is cut from its start, keeping the name of the folder.
    const folderOnly = ` ${FOLDER} ~/dev/haril ${ARROW}`;
    expect(at(textWidth(folderOnly))).toBe(folderOnly);
    const shortened = at(12);
    expect(shortened).toContain("…");
    expect(shortened).toContain("haril");
    expect(shortened).not.toContain(BRANCH);
  });

  it("keeps the end of a long folder, the part that names it", () => {
    const head = powerlineHead(input({ folder: "~/one/two/three/four/five/haril" }), 24, IDENTITY);
    expect(plain(head?.line ?? "")).toMatch(/…\S*haril/);
  });
});

describe("text it does not trust", () => {
  const BIDI = String.fromCodePoint(0x202e, 0x2066);
  const HOSTILE = [
    `evil${ESC}[31m red ${ESC}]0;title${String.fromCharCode(7)}name\nnext${String.fromCharCode(0)}${String.fromCharCode(0x9b)}${BIDI}`,
    `${ESC}[2J${ESC}[Hclear`,
    "tab\tseparated\r\nlines",
  ];

  it("shows control characters, escape sequences and bidi marks as plain text", () => {
    for (const hostile of HOSTILE) {
      const head = powerlineHead(input({ folder: hostile, branch: hostile }), 200, TRUECOLOR);
      const line = head?.line ?? "";
      expect(hasHiddenCharacter(plain(line))).toBe(false);
      expect(line).not.toContain(`${ESC}]`);
      expect(line).not.toContain(`${ESC}[2J`);
    }
  });

  it("cuts a branch of any length to the width", () => {
    const head = powerlineHead(input({ branch: "x".repeat(10_000) }), 80, TRUECOLOR);
    expect(head?.width ?? 0).toBeLessThanOrEqual(80);
    expect(plain(head?.line ?? "")).toContain("…");
  });
});
