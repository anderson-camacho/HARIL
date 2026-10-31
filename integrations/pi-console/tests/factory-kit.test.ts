import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ASCII_FACTORY_GLYPHS,
  FACTORY_TOKENS,
  factoryBoxRow,
  factoryFrameBottom,
  factoryFrameTop,
  factoryGlyphs,
  factoryProgressBar,
  factoryStatusDot,
  factoryText,
  UNICODE_FACTORY_GLYPHS,
} from "../src/factory-kit.js";
import { stripAnsi, textWidth } from "../src/text.js";

const BACKGROUND_SGR = new RegExp(`${String.fromCharCode(27)}\\[(?:[0-9;]*;)?48;[25];`);
const COLOR_ENV = ["NO_COLOR", "TERM", "PI_TRUE_COLOR"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of COLOR_ENV) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of COLOR_ENV) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the factory's colors", () => {
  it("keeps the reference palette's tokens, in the reference's order", () => {
    expect(Object.entries(FACTORY_TOKENS)).toEqual([
      ["text", "#e6edf3"],
      ["muted", "#8b949e"],
      ["green", "#7ee787"],
      ["blue", "#79c0ff"],
      ["orange", "#ffa657"],
      ["red", "#ff7b72"],
      ["purple", "#d2a8ff"],
      ["dim", "#484f58"],
      ["line", "#30363d"],
      ["yellow", "#f2cc60"],
      ["cyan", "#56d4dd"],
    ]);
  });

  it("paints every token as its exact RGB in truecolor", () => {
    const expected: Record<keyof typeof FACTORY_TOKENS, string> = {
      text: "230;237;243",
      muted: "139;148;158",
      green: "126;231;135",
      blue: "121;192;255",
      orange: "255;166;87",
      red: "255;123;114",
      purple: "210;168;255",
      dim: "72;79;88",
      line: "48;54;61",
      yellow: "242;204;96",
      cyan: "86;212;221",
    };
    for (const [token, rgb] of Object.entries(expected)) {
      expect(factoryText("x", token as keyof typeof FACTORY_TOKENS)).toBe(
        `\u001b[38;2;${rgb}mx\u001b[0m`,
      );
    }
  });

  it("falls back to the 256-color cube under PI_TRUE_COLOR=0", () => {
    process.env.PI_TRUE_COLOR = "0";
    // #79c0ff: r 121 -> 2, g 192 -> 4, b 255 -> 5, so 16 + 72 + 24 + 5.
    expect(factoryText("x", "blue")).toBe("\u001b[38;5;117mx\u001b[0m");
  });

  it("draws plain text under NO_COLOR and TERM=dumb", () => {
    process.env.NO_COLOR = "1";
    expect(factoryText("x", "green")).toBe("x");
    delete process.env.NO_COLOR;
    process.env.TERM = "dumb";
    expect(factoryText("x", "green")).toBe("x");
  });

  it("never shows a control character or an escape another source wrote", () => {
    expect(stripAnsi(factoryText("a\u001b[31mb\u0007c", "text"))).toBe("ab?c");
  });
});

describe("the factory's boxes", () => {
  const g = UNICODE_FACTORY_GLYPHS;

  it("draws a titled round frame with the right part flush right", () => {
    const top = stripAnsi(factoryFrameTop(30, "Avance", "1/7", g));
    expect(top).toBe(`╭─ Avance ${"─".repeat(13)} 1/7 ─╮`);
    expect(textWidth(top)).toBe(30);
    expect(stripAnsi(factoryFrameBottom(6, g))).toBe("╰────╯");
  });

  it("colors the frame with the line token and the title with the text token", () => {
    const top = factoryFrameTop(20, "Avance", "", g);
    expect(top).toContain(`\u001b[38;2;48;54;61m╭─`);
    expect(top).toContain(`\u001b[38;2;230;237;243mAvance`);
  });

  it("gives way as the width shrinks and never exceeds it", () => {
    for (let width = 0; width <= 40; width++) {
      const top = stripAnsi(factoryFrameTop(width, "Actividades largas", "derecha", g));
      expect(textWidth(top)).toBe(width);
      expect(textWidth(stripAnsi(factoryFrameBottom(width, g)))).toBe(width);
    }
    // The right part goes first; the title is cut only after that.
    expect(stripAnsi(factoryFrameTop(20, "Conexiones", "derecha larga", g))).toBe(
      "╭─ Conexiones ─────╮",
    );
    expect(stripAnsi(factoryFrameTop(12, "Conexiones", "", g))).toBe("╭─ Conexi… ╮");
  });

  it("draws the ASCII fallback under HARIL_CONSOLE_ASCII", () => {
    expect(factoryGlyphs({ HARIL_CONSOLE_ASCII: "1" })).toBe(ASCII_FACTORY_GLYPHS);
    expect(factoryGlyphs({})).toBe(UNICODE_FACTORY_GLYPHS);
    expect(stripAnsi(factoryFrameTop(14, "Tab", "", ASCII_FACTORY_GLYPHS))).toBe("+- Tab ------+");
    expect(stripAnsi(factoryFrameBottom(4, ASCII_FACTORY_GLYPHS))).toBe("+--+");
    expect(stripAnsi(factoryProgressBar(0.5, 4, ASCII_FACTORY_GLYPHS))).toBe("##--");
    expect(stripAnsi(factoryStatusDot("green", ASCII_FACTORY_GLYPHS))).toBe("*");
    const all = Object.values(ASCII_FACTORY_GLYPHS).join("");
    expect(all).toMatch(/^[\x20-\x7e]*$/);
  });

  it("wraps a composed row in the frame's sides", () => {
    const row = factoryBoxRow([{ text: "hola", token: "muted" }], 10, g);
    expect(stripAnsi(row.text)).toBe("│hola    │");
    expect(row.hits).toEqual([]);
  });

  it("records a segment's hit-box in the row's columns, after the left side", () => {
    const target = { name: "x" };
    const row = factoryBoxRow(
      [
        { text: "ab", token: "muted" },
        { text: "cd", token: "text", target },
      ],
      10,
      g,
    );
    expect(row.hits).toEqual([{ start: 3, end: 5, target }]);
  });

  it("cuts a row that does not fit, keeping its width", () => {
    const row = factoryBoxRow([{ text: "una línea demasiado larga", token: "text" }], 12, g);
    expect(textWidth(stripAnsi(row.text))).toBe(12);
    expect(stripAnsi(row.text)).toContain("…");
  });
});

describe("the factory's progress bar and status dot", () => {
  const g = UNICODE_FACTORY_GLYPHS;

  it("fills by ratio with block glyphs and keeps its cells", () => {
    expect(stripAnsi(factoryProgressBar(0, 4, g))).toBe("░░░░");
    expect(stripAnsi(factoryProgressBar(0.5, 4, g))).toBe("██░░");
    expect(stripAnsi(factoryProgressBar(1, 4, g))).toBe("████");
  });

  it("clamps a ratio out of range or not a number", () => {
    expect(stripAnsi(factoryProgressBar(-1, 4, g))).toBe("░░░░");
    expect(stripAnsi(factoryProgressBar(7, 4, g))).toBe("████");
    expect(stripAnsi(factoryProgressBar(Number.NaN, 4, g))).toBe("░░░░");
    expect(factoryProgressBar(0.5, 0, g)).toBe("");
  });

  it("paints the filled cells in the given token and the empty ones dim", () => {
    const bar = factoryProgressBar(0.5, 2, g, "orange");
    expect(bar).toContain("\u001b[38;2;255;166;87m█");
    expect(bar).toContain("\u001b[38;2;72;79;88m░");
  });

  it("paints a dot in the status's token", () => {
    expect(factoryStatusDot("red", g)).toBe("\u001b[38;2;255;123;114m●\u001b[0m");
  });

  it("paints no background anywhere", () => {
    const drawn = [
      factoryText("x", "text"),
      factoryFrameTop(20, "t", "r", g),
      factoryFrameBottom(20, g),
      factoryBoxRow([{ text: "x", token: "text" }], 20, g).text,
      factoryProgressBar(0.5, 8, g),
      factoryStatusDot("green", g),
    ];
    for (const line of drawn) expect(line).not.toMatch(BACKGROUND_SGR);
  });
});
