import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blankRow,
  boxFrame,
  button,
  card,
  inset,
  plainBox,
  railGlyphs,
} from "../src/rail-cards.js";
import {
  BUTTON_LABEL_WIDTH,
  BUTTON_WIDTH,
  CARD_CONTENT_WIDTH,
  CARD_TEXT_X,
  CARD_WIDTH,
  RAIL_BODY_WIDTH,
  RAIL_MARGIN,
  RAIL_WIDTH,
} from "../src/rail-metrics.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The boxes of the right rail: a card (a titled section), a button (one action) and a plain box (the tab header).
// Every row a helper returns is exactly as wide as its box, and the box never pushes out of its column.

const plain = (rows: readonly string[]): string[] => rows.map(stripAnsi);
const widths = (rows: readonly string[]): number[] => plain(rows).map((row) => textWidth(row));

describe("the rail's metrics", () => {
  it("share the 40 columns of the rail among the separator, the margins, the card and its content", () => {
    expect(RAIL_WIDTH).toBe(40);
    // Column 0 is the rail's own separator, so a row has the rest.
    expect(RAIL_BODY_WIDTH).toBe(39);
    expect(RAIL_MARGIN).toBe(1);
    expect(CARD_WIDTH).toBe(RAIL_WIDTH - 3);
    expect(CARD_WIDTH).toBe(37);
    expect(CARD_CONTENT_WIDTH).toBe(CARD_WIDTH - 4);
    expect(CARD_CONTENT_WIDTH).toBe(33);
    expect(BUTTON_WIDTH).toBe(CARD_CONTENT_WIDTH);
    expect(BUTTON_LABEL_WIDTH).toBe(BUTTON_WIDTH - 4);
    expect(BUTTON_LABEL_WIDTH).toBe(29);
    // The separator, the margin, the border and the padding come before the first character of a card's content.
    expect(CARD_TEXT_X).toBe(4);
    expect(RAIL_MARGIN + CARD_WIDTH + RAIL_MARGIN).toBe(RAIL_BODY_WIDTH);
  });
});

describe("a card", () => {
  it("draws rounded corners, its title in the top border and a row for each text", () => {
    const rows = plain(card("Engram", ["ok", "3.6.0"]));
    expect(rows).toEqual([
      `╭─ Engram ${"─".repeat(CARD_WIDTH - 5 - "Engram".length)}╮`,
      `│ ${"ok".padEnd(CARD_CONTENT_WIDTH)} │`,
      `│ ${"3.6.0".padEnd(CARD_CONTENT_WIDTH)} │`,
      `╰${"─".repeat(CARD_WIDTH - 2)}╯`,
    ]);
  });

  it("is exactly as wide as the slot whatever its text", () => {
    const rows = card("Proceso de memoria · NO GUARDA", [
      "",
      "short",
      "x".repeat(200),
      "日本語のテキストが長く続きます、とても長く続きます、とても長く",
      "🧠 emoji 🧠 emoji 🧠 emoji 🧠 emoji 🧠 emoji",
      "con tildes: ñandú, café, año",
    ]);
    expect(new Set(widths(rows))).toEqual(new Set([CARD_WIDTH]));
    // A long row is cut with an ellipsis, inside its borders.
    const long = plain(rows)[3] ?? "";
    expect(long.startsWith("│ xxx")).toBe(true);
    expect(long.endsWith("… │")).toBe(true);
  });

  it("cuts a title that does not fit the border, and keeps one that does", () => {
    const room = CARD_WIDTH - 6;
    const fits = plain(card("t".repeat(room), []))[0] ?? "";
    expect(fits).toBe(`╭─ ${"t".repeat(room)} ─╮`);
    const cut = plain(card("t".repeat(room + 1), []))[0] ?? "";
    expect(textWidth(cut)).toBe(CARD_WIDTH);
    expect(cut).toBe(`╭─ ${"t".repeat(room - 1)}… ─╮`);
    const wide = plain(card("日".repeat(40), []))[0] ?? "";
    expect(textWidth(wide)).toBe(CARD_WIDTH);
    expect(wide).toContain("…");
  });

  it("draws a plain top border when it has no title", () => {
    expect(plain(card("", []))).toEqual([
      `╭${"─".repeat(CARD_WIDTH - 2)}╮`,
      `╰${"─".repeat(CARD_WIDTH - 2)}╯`,
    ]);
  });

  it("is made of separate tones: border, title and body are not one run", () => {
    const saved = { noColor: process.env.NO_COLOR, term: process.env.TERM };
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    try {
      const [top, body] = card("Engram", ["ok"]);
      // Truecolor foregrounds of the matrix palette: teal borders, cyan title, text body.
      expect(top).toContain("38;2;119;255;165m╭─ ");
      expect(top).toContain("38;2;38;238;104mEngram");
      expect(body).toContain("38;2;119;255;165m│ ");
      expect(body).toContain("38;2;198;244;210m");
      // Every run has the panel's background, so the card does not show the rail's base through it.
      expect(top).toContain("48;2;6;20;10m");
    } finally {
      if (saved.noColor !== undefined) process.env.NO_COLOR = saved.noColor;
      if (saved.term === undefined) delete process.env.TERM;
      else process.env.TERM = saved.term;
    }
  });
});

describe("a button", () => {
  it("is three rows: a rounded box around its pointer and label", () => {
    expect(plain(button("Reinstalar Engram (forzar)"))).toEqual([
      `╭${"─".repeat(BUTTON_WIDTH - 2)}╮`,
      `│ ${"▸ Reinstalar Engram (forzar)".padEnd(BUTTON_LABEL_WIDTH)} │`,
      `╰${"─".repeat(BUTTON_WIDTH - 2)}╯`,
    ]);
  });

  it("goes on to a second row when the label does not fit one, and cuts only after that", () => {
    // 27 columns of label after the pointer: this one needs two rows, indented under the first word.
    expect(plain(button("Activar o desactivar herramientas de Pi"))).toEqual([
      `╭${"─".repeat(BUTTON_WIDTH - 2)}╮`,
      `│ ${"▸ Activar o desactivar".padEnd(BUTTON_LABEL_WIDTH)} │`,
      `│ ${"  herramientas de Pi".padEnd(BUTTON_LABEL_WIDTH)} │`,
      `╰${"─".repeat(BUTTON_WIDTH - 2)}╯`,
    ]);
    // A label of exactly the room of one row stays a three-row button.
    expect(button("x".repeat(BUTTON_LABEL_WIDTH - 2))).toHaveLength(3);
    expect(button("x".repeat(BUTTON_LABEL_WIDTH - 1))).toHaveLength(4);
  });

  it("cuts a label that does not fit even two rows, and never widens", () => {
    for (const label of ["x".repeat(100), "日本語".repeat(20), "", "🧠".repeat(30)]) {
      const rows = button(label);
      expect(new Set(widths(rows))).toEqual(new Set([BUTTON_WIDTH]));
      // Never more than two rows of label: the button is four rows at the most.
      expect(rows.length).toBeLessThanOrEqual(4);
    }
    const long = plain(button("x".repeat(100)));
    expect(long).toHaveLength(4);
    expect(long[1]).toMatch(/▸ x+ │$/u);
    expect(long[2]).toMatch(/… │$/u);
    expect(plain(button("x".repeat(100), { ascii: true }))[2]).toMatch(/… \|$/u);
  });

  it("fits inside a card, which keeps its own borders around it", () => {
    const framed = plain(boxFrame("Acciones", button("Definir carpeta…")));
    expect(framed).toEqual([
      `╭─ Acciones ${"─".repeat(CARD_WIDTH - 5 - "Acciones".length)}╮`,
      `│ ╭${"─".repeat(BUTTON_WIDTH - 2)}╮ │`,
      `│ │ ${"▸ Definir carpeta…".padEnd(BUTTON_LABEL_WIDTH)} │ │`,
      `│ ╰${"─".repeat(BUTTON_WIDTH - 2)}╯ │`,
      `╰${"─".repeat(CARD_WIDTH - 2)}╯`,
    ]);
  });
});

describe("a plain box", () => {
  it("holds rows with the tone each asks for, as wide as a card", () => {
    const rows = plainBox([
      { text: "▼ Espacio: Principal · Alt+L", tone: "yellow" },
      { text: "tabs" },
    ]);
    expect(plain(rows)).toEqual([
      `╭${"─".repeat(CARD_WIDTH - 2)}╮`,
      `│ ${"▼ Espacio: Principal · Alt+L".padEnd(CARD_CONTENT_WIDTH)} │`,
      `│ ${"tabs".padEnd(CARD_CONTENT_WIDTH)} │`,
      `╰${"─".repeat(CARD_WIDTH - 2)}╯`,
    ]);
  });
});

describe("the margins of the rail", () => {
  it("put one blank column at each side of a card, so a row of the rail is its body wide", () => {
    const rows = card("Engram", ["ok"]).map(inset);
    expect(new Set(widths(rows))).toEqual(new Set([RAIL_BODY_WIDTH]));
    for (const row of plain(rows)) {
      expect(row.startsWith(" ")).toBe(true);
      expect(row.endsWith(" ")).toBe(true);
    }
    expect(textWidth(stripAnsi(blankRow()))).toBe(RAIL_BODY_WIDTH);
  });
});

describe("the ASCII fallback", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HARIL_CONSOLE_ASCII;
    delete process.env.HARIL_CONSOLE_ASCII;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HARIL_CONSOLE_ASCII;
    else process.env.HARIL_CONSOLE_ASCII = saved;
  });

  it("draws + - | and a > pointer, with the same widths", () => {
    const rows = [
      ...card("Engram", ["ok"], { ascii: true }),
      ...boxFrame("Acciones", button("Definir carpeta…", { ascii: true }), { ascii: true }),
      ...plainBox([{ text: "x" }], { ascii: true }),
    ];
    const drawn = plain(rows);
    expect(drawn[0]).toBe(`+- Engram ${"-".repeat(CARD_WIDTH - 5 - "Engram".length)}+`);
    expect(drawn[1]).toBe(`| ${"ok".padEnd(CARD_CONTENT_WIDTH)} |`);
    expect(drawn.join("\n")).toContain(`| ${"> Definir carpeta…".padEnd(BUTTON_LABEL_WIDTH)} |`);
    // Not one rounded corner, rule or pointer of the Unicode set.
    expect(drawn.join("\n")).not.toMatch(/[╭╮╰╯─│▸▼▶▣]/u);
    expect(new Set(widths(rows))).toEqual(new Set([CARD_WIDTH]));
  });

  it("has its markers for the header too", () => {
    expect(railGlyphs(true)).toMatchObject({ open: "v", closed: ">", docked: "#", pointer: ">" });
    expect(railGlyphs(false)).toMatchObject({ open: "▼", closed: "▶", docked: "▣", pointer: "▸" });
    expect(railGlyphs(undefined)).toBe(railGlyphs(false));
  });
});
