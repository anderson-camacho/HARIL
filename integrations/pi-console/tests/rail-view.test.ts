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
