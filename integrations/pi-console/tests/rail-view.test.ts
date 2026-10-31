import { describe, expect, it } from "vitest";
import { CARD_CONTENT_WIDTH, CARD_TEXT_X, RAIL_BODY_WIDTH } from "../src/rail-metrics.js";
import { type DockCard, flatView, railHitAt, railRows } from "../src/rail-view.js";
import { stripAnsi, textWidth } from "../src/text.js";

// A view is data (cards and buttons); the rail draws it and the left dock reads it flat. What a menu or a click needs
// comes from the data, never from the rows that were drawn.

const CARDS: DockCard[] = [
  { title: "Engram · ok", rows: ["3.6.0 · copia de HARIL", "  anidada", ""] },
  { title: "Proceso de memoria · no disponible", rows: ["haril: store locked"] },
  {
    title: "Acciones",
    rows: [],
    buttons: [
      { label: "Comprobar e instalar Engram", action: "tools:ensure" },
      { label: "Reinstalar Engram (forzar)", action: "tools:force" },
    ],
  },
];

describe("the flat form of cards", () => {
  it("keeps each title, indents its rows, and names the line of each button with its label", () => {
    const { lines, actions } = flatView(CARDS);
    expect(lines).toEqual([
      "Engram · ok",
      "  3.6.0 · copia de HARIL",
      "    anidada",
      "",
      "",
      "Proceso de memoria · no disponible",
      "  haril: store locked",
      "",
      "Acciones",
      "▸ Comprobar e instalar Engram",
      "▸ Reinstalar Engram (forzar)",
    ]);
    expect(actions).toEqual([
      { line: 9, action: "tools:ensure", label: "Comprobar e instalar Engram" },
      { line: 10, action: "tools:force", label: "Reinstalar Engram (forzar)" },
    ]);
    // The label is carried by the action: it is what the keyboard menu reads, whatever the rows look like.
    for (const action of actions) expect(lines[action.line]).toBe(`▸ ${action.label}`);
  });

  it("has no lines and no actions without cards", () => {
    expect(flatView([])).toEqual({ lines: [], actions: [] });
  });
});

describe("cards as rows of the rail", () => {
  const drawn = railRows({ title: "Memoria", lines: [], cards: CARDS }, false);
  const plain = drawn.rows.map(stripAnsi);

  it("draws a box for each card, each row the width of the rail's body", () => {
    // Engram: 5 rows (border, 3 text rows, border); the process: 4; the actions: 8 (two buttons of three rows).
    expect(plain).toHaveLength(5 + 4 + 8);
    expect(new Set(plain.map(textWidth))).toEqual(new Set([RAIL_BODY_WIDTH]));
    // The top border of each card names it, and the rule fills the rest of the card's width.
    const tops = plain.filter((row) => row.includes("╭─ ")).map((row) => row.trim());
    expect(tops.map((row) => row.replace(/ ─+╮$/u, ""))).toEqual([
      "╭─ Engram · ok",
      "╭─ Proceso de memoria",
      "╭─ Acciones",
    ]);
  });

  it("aligns one hit with each row: the three rows of a button share its action", () => {
    expect(drawn.hits).toHaveLength(drawn.rows.length);
    const label = plain.findIndex((row) => row.includes("▸ Comprobar e instalar Engram"));
    expect(drawn.hits.slice(label - 1, label + 2)).toEqual(Array(3).fill("tools:ensure"));
    const second = plain.findIndex((row) => row.includes("▸ Reinstalar Engram (forzar)"));
    expect(drawn.hits.slice(second - 1, second + 2)).toEqual(Array(3).fill("tools:force"));
    // Everything else runs nothing: borders, titles and text.
    const runnable = new Set([label - 1, label, label + 1, second - 1, second, second + 1]);
    for (const [index, hit] of drawn.hits.entries()) {
      if (!runnable.has(index)) expect([index, hit]).toEqual([index, undefined]);
    }
  });

  it("moves the state of a title that is too long into the card's first row", () => {
    expect(plain.some((row) => row.includes("│ no disponible"))).toBe(true);
    expect(plain.some((row) => row.includes("Proceso de memoria · no disponible"))).toBe(false);
  });

  it("cuts a row that is wider than the card, and draws a title with no state as it is", () => {
    const rows = railRows(
      {
        title: "x",
        lines: [],
        cards: [{ title: "T".repeat(80), rows: ["r".repeat(80)] }],
      },
      false,
    ).rows.map(stripAnsi);
    expect(rows.every((row) => textWidth(row) === RAIL_BODY_WIDTH)).toBe(true);
    expect(rows[0]).toContain("…");
    expect(rows[1]).toContain(`${"r".repeat(CARD_CONTENT_WIDTH - 1)}…`);
  });
});

// A card may tint some of its rows (the ACT tab marks a failed event); the text and the width stay the same.
describe("the tone of a row", () => {
  // The rail draws in colour only when the terminal does: pin it, whatever the environment of the test run.
  function withColour<T>(run: () => T): T {
    const color = process.env.NO_COLOR;
    const term = process.env.TERM;
    try {
      delete process.env.NO_COLOR;
      process.env.TERM = "xterm-256color";
      return run();
    } finally {
      if (color === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = color;
      if (term === undefined) delete process.env.TERM;
      else process.env.TERM = term;
    }
  }

  const rows = ["#2 task.failed · hace 1 min", "#1 task.started · hace 2 min", "Sin más."];
  const draw = (card: DockCard) => railRows({ title: "x", lines: [], cards: [card] }, false);

  it("tints the row it names and no other, without changing what is written", () => {
    withColour(() => {
      const plain = draw({ title: "Actividad · 2", rows });
      const tinted = draw({
        title: "Actividad · 2",
        rows,
        tones: ["error", undefined, "muted"],
      });
      expect(tinted.rows.map(stripAnsi)).toEqual(plain.rows.map(stripAnsi));
      expect(tinted.rows[1]).not.toBe(plain.rows[1]);
      expect(tinted.rows[2]).toBe(plain.rows[2]);
      expect(tinted.rows[3]).not.toBe(plain.rows[3]);
      // The borders are not touched.
      expect(tinted.rows[0]).toBe(plain.rows[0]);
      expect(tinted.rows[4]).toBe(plain.rows[4]);
    });
  });

  it("follows its row when a long title gives its state to the card's first row", () => {
    withColour(() => {
      const title = "Proceso de memoria · no disponible";
      const plain = draw({ title, rows: ["haril: store locked"] });
      const tinted = draw({ title, rows: ["haril: store locked"], tones: ["error"] });
      // Row 1 is the state moved into the card; row 2 is the original first row, the one that was tinted.
      expect(tinted.rows[1]).toBe(plain.rows[1]);
      expect(tinted.rows[2]).not.toBe(plain.rows[2]);
      expect(tinted.rows.map(stripAnsi)).toEqual(plain.rows.map(stripAnsi));
    });
  });

  it("leaves the flat form alone: the left dock reads text only", () => {
    expect(flatView([{ title: "T", rows: ["a", "b"], tones: ["error", "muted"] }]).lines).toEqual([
      "T",
      "  a",
      "  b",
    ]);
  });
});

// Several chips share the same three rows, so a row can carry one action for each column range instead of a single
// action for the whole row (cells), and a click is resolved against the cells by its column.
describe("chips in a card", () => {
  const CHIPS_CARD: DockCard = {
    title: "Acciones",
    rows: [],
    chips: [
      { label: "1h", name: "Última hora", action: "a:hour" },
      { label: "1d", name: "Último día", action: "a:day" },
      { label: "Rango", name: "Rango…", action: "a:range", active: true },
      { label: "Todo", name: "Todo", action: "a:all" },
    ],
    buttons: [{ label: "Actualizar", action: "a:refresh" }],
  };
  const view = (ascii: boolean) =>
    railRows({ title: "Actividad", lines: [], cards: [CHIPS_CARD] }, ascii);

  it("reads flat as one line for each chip, with the words of its menu entry, then the buttons", () => {
    const { lines, actions } = flatView([CHIPS_CARD]);
    expect(lines).toEqual([
      "Acciones",
      "▸ Última hora",
      "▸ Último día",
      "▸ Rango…",
      "▸ Todo",
      "▸ Actualizar",
    ]);
    expect(actions).toEqual([
      { line: 1, action: "a:hour", label: "Última hora" },
      { line: 2, action: "a:day", label: "Último día" },
      { line: 3, action: "a:range", label: "Rango…" },
      { line: 4, action: "a:all", label: "Todo" },
      { line: 5, action: "a:refresh", label: "Actualizar" },
    ]);
  });

  it("draws the chips in one row of boxes, above the buttons, each row the width of the rail's body", () => {
    const drawn = view(false);
    const rows = drawn.rows.map(stripAnsi);
    // Border, three rows of chips, a button of three rows and the border.
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map(textWidth))).toEqual(new Set([RAIL_BODY_WIDTH]));
    expect(rows[1]).toContain("╭────╮ ╭────╮ ╭───────╮ ╭──────╮");
    expect(rows[2]).toContain("│ 1h │ │ 1d │ │ Rango │ │ Todo │");
    expect(rows[5]).toContain("▸ Actualizar");
    // The labels are the chips' own short words; the long ones are the menu's.
    expect(rows.join("\n")).not.toContain("Última hora");
  });

  it("aligns cells with the chip rows and one action with each row of the button", () => {
    const drawn = view(false);
    expect(drawn.hits).toHaveLength(drawn.rows.length);
    const cells = {
      cells: [
        { from: 0, to: 6, action: "a:hour" },
        { from: 7, to: 13, action: "a:day" },
        { from: 14, to: 23, action: "a:range" },
        { from: 24, to: 32, action: "a:all" },
      ],
    };
    expect(drawn.hits).toEqual([
      undefined,
      cells,
      cells,
      cells,
      "a:refresh",
      "a:refresh",
      "a:refresh",
      undefined,
    ]);
  });

  it("resolves a click by its column: a chip, from its first border to its last; never a gap or the margins", () => {
    const { hits } = view(false);
    const at = (x: number) => railHitAt(hits[2], x);
    const first = CARD_TEXT_X;
    expect(at(first - 1)).toBeUndefined();
    expect(at(first)).toBe("a:hour");
    expect(at(first + 5)).toBe("a:hour");
    expect(at(first + 6)).toBeUndefined();
    expect(at(first + 7)).toBe("a:day");
    expect(at(first + 12)).toBe("a:day");
    expect(at(first + 13)).toBeUndefined();
    expect(at(first + 14)).toBe("a:range");
    expect(at(first + 22)).toBe("a:range");
    expect(at(first + 23)).toBeUndefined();
    expect(at(first + 24)).toBe("a:all");
    expect(at(first + 31)).toBe("a:all");
    // The spare column after the last chip, the card's padding and its border, and the rail's margin and separator.
    expect(at(first + 32)).toBeUndefined();
    expect(at(first + CARD_CONTENT_WIDTH)).toBeUndefined();
    expect(at(RAIL_BODY_WIDTH)).toBeUndefined();
    expect(at(0)).toBeUndefined();
    // The same three rows answer the same way; the top and bottom borders of the card answer nothing.
    for (const row of [1, 2, 3]) expect(railHitAt(hits[row], first + 8)).toBe("a:day");
    expect(railHitAt(hits[0], first + 8)).toBeUndefined();
    expect(railHitAt(hits[7], first + 8)).toBeUndefined();
  });

  it("keeps a single action for the whole row for a button, whatever the column", () => {
    const { hits } = view(false);
    for (const x of [0, CARD_TEXT_X, 20, RAIL_BODY_WIDTH]) {
      expect(railHitAt(hits[5], x)).toBe("a:refresh");
    }
    expect(railHitAt(undefined, 10)).toBeUndefined();
  });

  it("draws and answers the same in ASCII", () => {
    const ascii = view(true);
    const plain = ascii.rows.map(stripAnsi);
    expect(new Set(plain.map(textWidth))).toEqual(new Set([RAIL_BODY_WIDTH]));
    expect(plain[2]).toContain("| 1h | | 1d | | Rango | | Todo |");
    expect(plain.join("")).not.toMatch(/[╭╮╰╯─│▸]/u);
    expect(ascii.hits).toEqual(view(false).hits);
  });

  it("draws the rows of a card before its chips, and keeps those rows without a hit", () => {
    const drawn = railRows(
      {
        title: "x",
        lines: [],
        cards: [{ ...CHIPS_CARD, rows: ["Filtro: Todo"], buttons: undefined }],
      },
      false,
    );
    const plain = drawn.rows.map(stripAnsi);
    expect(plain[1]).toContain("Filtro: Todo");
    expect(plain[3]).toContain("│ 1h │");
    expect(drawn.hits[1]).toBeUndefined();
    expect(railHitAt(drawn.hits[3], CARD_TEXT_X + 8)).toBe("a:day");
  });
});

describe("a view with only lines", () => {
  it("is one box titled with the view, and a line with an action stays clickable", () => {
    const drawn = railRows(
      {
        title: "Memoria",
        lines: ["Elige una opción:", "1. abrir carpeta"],
        actions: [{ line: 1, action: "open-folder" }],
      },
      false,
    );
    const plain = drawn.rows.map(stripAnsi);
    expect(plain[0]).toContain("╭─ Memoria ");
    expect(plain[2]).toContain("1. abrir carpeta");
    expect(drawn.hits).toEqual([undefined, undefined, "open-folder", undefined]);
  });

  it("draws nothing for a view without lines (MAIN has no view of its own)", () => {
    expect(railRows({ title: "Principal", lines: [] }, false)).toEqual({ rows: [], hits: [] });
  });
});
