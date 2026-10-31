import { describe, expect, it } from "vitest";
import { CARD_CONTENT_WIDTH, RAIL_BODY_WIDTH } from "../src/rail-metrics.js";
import { type DockCard, flatView, railRows } from "../src/rail-view.js";
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
