import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setHarilPalette } from "../src/dashboard-theme.js";
import {
  blankRow,
  boxFrame,
  button,
  card,
  chipRow,
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
      setHarilPalette("matrix");
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

// A row of chips: small bordered boxes side by side, three rows tall, one column apart (the ACT tab's range chips).
describe("a row of chips", () => {
  const chips = (...labels: string[]) => labels.map((label) => ({ label }));
  const ES = ["1h", "1d", "Rango", "Todo"];
  const EN = ["1h", "1d", "Range", "All"];

  it("is three rows tall and exactly the card's content wide, whatever the labels", () => {
    for (const labels of [
      ES,
      EN,
      ["1h", "1d", "Espera", "Todo"],
      ["1h", "1d", "Waiting", "All"],
      ["x".repeat(40), "日本語のテキスト", "🧠🧠🧠🧠", ""],
    ]) {
      for (const ascii of [false, true]) {
        const { rows } = chipRow(chips(...labels), { ascii });
        expect(rows, labels.join()).toHaveLength(3);
        expect(new Set(widths(rows)), `${labels.join()} ascii=${ascii}`).toEqual(
          new Set([CARD_CONTENT_WIDTH]),
        );
      }
    }
  });

  it("draws small rounded boxes side by side, one column apart, left-aligned", () => {
    const { rows, cells } = chipRow(chips(...ES));
    expect(plain(rows)).toEqual([
      "╭────╮ ╭────╮ ╭───────╮ ╭──────╮ ".padEnd(CARD_CONTENT_WIDTH),
      "│ 1h │ │ 1d │ │ Rango │ │ Todo │ ".padEnd(CARD_CONTENT_WIDTH),
      "╰────╯ ╰────╯ ╰───────╯ ╰──────╯ ".padEnd(CARD_CONTENT_WIDTH),
    ]);
    // Each chip spans its borders; the gap between two chips belongs to neither.
    expect(cells).toEqual([
      { from: 0, to: 6 },
      { from: 7, to: 13 },
      { from: 14, to: 23 },
      { from: 24, to: 32 },
    ]);
  });

  it("falls back to + - | in the same widths", () => {
    const { rows, cells } = chipRow(chips(...EN), { ascii: true });
    expect(plain(rows)).toEqual([
      "+----+ +----+ +-------+ +-----+".padEnd(CARD_CONTENT_WIDTH),
      "| 1h | | 1d | | Range | | All |".padEnd(CARD_CONTENT_WIDTH),
      "+----+ +----+ +-------+ +-----+".padEnd(CARD_CONTENT_WIDTH),
    ]);
    expect(cells.at(-1)).toEqual({ from: 24, to: 31 });
    expect(plain(rows).join("")).not.toMatch(/[╭╮╰╯─│]/u);
  });

  it("cuts the widest label with an ellipsis, as a button does, when the chips do not fit", () => {
    const { rows, cells } = chipRow(chips("1h", "x".repeat(40), "y".repeat(40)));
    expect(new Set(widths(rows))).toEqual(new Set([CARD_CONTENT_WIDTH]));
    const middle = plain(rows)[1] ?? "";
    expect(middle).toContain("…");
    expect(middle.startsWith("│ 1h │")).toBe(true);
    // Every chip is still there and the last one ends inside the row.
    expect(cells).toHaveLength(3);
    expect(cells.at(-1)?.to).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    // The cells follow the drawn boxes: each one starts on a corner and ends one column after the other corner.
    const top = plain(rows)[0] ?? "";
    for (const { from, to } of cells) {
      expect(top[from]).toBe("╭");
      expect(top[to - 1]).toBe("╮");
    }
  });

  it("drops the chips that cannot fit even with one-column labels, and never widens", () => {
    const many = chipRow(chips(...Array.from({ length: 9 }, (_unused, index) => `c${index}`)));
    expect(new Set(widths(many.rows))).toEqual(new Set([CARD_CONTENT_WIDTH]));
    expect(many.cells.length).toBeLessThan(9);
    expect(many.cells.length).toBeGreaterThan(3);
    expect(widths(chipRow([]).rows)).toEqual(Array(3).fill(CARD_CONTENT_WIDTH));
    expect(chipRow([]).cells).toEqual([]);
  });

  it("draws the active chip's border and label in the selected tone, and no other chip", () => {
    const saved = { noColor: process.env.NO_COLOR, term: process.env.TERM };
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    try {
      const idle = chipRow(chips(...ES));
      const active = chipRow([
        { label: "1h" },
        { label: "1d" },
        { label: "Rango", active: true },
        { label: "Todo" },
      ]);
      // The text does not change, only the tone of the third chip.
      expect(active.rows.map(stripAnsi)).toEqual(idle.rows.map(stripAnsi));
      const yellow = "38;2;231;207;117m";
      for (const row of active.rows) expect(row).toContain(yellow);
      for (const row of idle.rows) expect(row).not.toContain(yellow);
      // The yellow run is the third chip's own: its top edge, its middle row and its bottom edge.
      expect(active.rows[0]).toContain(`${yellow}╭───────╮`);
      expect(active.rows[1]).toContain(`${yellow}│`);
      expect(active.rows[1]).toContain(`${yellow}Rango`);
      expect(active.rows[2]).toContain(`${yellow}╰───────╯`);
      // Every run keeps the panel's background, so the rail's base does not show through the gaps.
      for (const row of active.rows) expect(row).toContain("48;2;6;20;10m");
    } finally {
      if (saved.noColor !== undefined) process.env.NO_COLOR = saved.noColor;
      if (saved.term === undefined) delete process.env.TERM;
      else process.env.TERM = saved.term;
    }
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
