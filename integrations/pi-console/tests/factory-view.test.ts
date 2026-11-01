import { describe, expect, it } from "vitest";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import { FACTORY_TABS, type FactoryState, initialFactoryState } from "../src/factory-state.js";
import { FACTORY_TAB_LABELS, renderFactoryScreen } from "../src/factory-view.js";
import { stripAnsi, textWidth } from "../src/text.js";

const BACKGROUND_SGR = new RegExp(`${String.fromCharCode(27)}\\[(?:[0-9;]*;)?48;[25];`);

function plain(state: FactoryState, width: number, rows: number, glyphs = UNICODE_FACTORY_GLYPHS) {
  return renderFactoryScreen(state, width, rows, glyphs).lines.map(stripAnsi);
}

function withRows(rows: number, detail = false): FactoryState {
  const state = initialFactoryState();
  return { ...state, detail, rowCounts: { ...state.rowCounts, avance: rows } };
}

describe("the factory screen", () => {
  it("names the seven tabs", () => {
    expect(FACTORY_TABS.map((tab) => FACTORY_TAB_LABELS[tab])).toEqual([
      "Avance",
      "Actividades",
      "Tablero",
      "Agentes",
      "Conexiones",
      "Modelos",
      "Sistema",
    ]);
  });

  it("draws the tab bar on top, the framed body and the footer at the terminal's height", () => {
    const lines = plain(initialFactoryState(), 120, 24);
    expect(lines).toHaveLength(24);
    for (const tab of FACTORY_TABS) expect(lines[0]).toContain(FACTORY_TAB_LABELS[tab]);
    expect(lines[1]).toContain("╭─ Avance");
    expect(lines[22]).toMatch(/^╰─+╯$/);
    expect(lines[23]).toContain("Esc cerrar");
  });

  it("marks the active tab with more than a color", () => {
    const state: FactoryState = { ...initialFactoryState(), tab: "tablero" };
    expect(plain(state, 120, 24)[0]).toContain("[3 Tablero]");
    expect(plain(state, 80, 24)[0]).toContain("[Tablero]");
  });

  it("says each tab has no data, and shows none", () => {
    for (const tab of FACTORY_TABS) {
      const state: FactoryState = { ...initialFactoryState(), tab };
      const text = plain(state, 80, 24).join("\n");
      expect(text).toContain("Sin datos conectados todavía");
      expect(text).toContain(`╭─ ${FACTORY_TAB_LABELS[tab]}`);
      expect(text).not.toMatch(/\d+ ?%/);
    }
  });

  it("no line exceeds the width, at any width and in every state", () => {
    for (const width of [40, 80, 120, 20, 7, 1]) {
      for (const rows of [24, 6, 3, 2, 1]) {
        for (const state of [
          ...FACTORY_TABS.map((tab) => ({ ...initialFactoryState(), tab })),
          withRows(2),
          withRows(2, true),
        ]) {
          for (const glyphs of [UNICODE_FACTORY_GLYPHS, ASCII_FACTORY_GLYPHS]) {
            const lines = plain(state, width, rows, glyphs);
            expect(lines).toHaveLength(rows);
            for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it("keeps every tab reachable by a click at 40 columns", () => {
    const { hits } = renderFactoryScreen(initialFactoryState(), 40, 24, UNICODE_FACTORY_GLYPHS);
    const tabs = hits.flatMap((hit) => (hit.target.kind === "tab" ? [hit.target.tab] : []));
    expect(tabs).toEqual([...FACTORY_TABS]);
    expect(plain(initialFactoryState(), 40, 24)[0]).toContain("Avance");
  });

  it("each tab's hit-box covers its label on the tab bar", () => {
    const state = initialFactoryState();
    const { hits } = renderFactoryScreen(state, 120, 24, UNICODE_FACTORY_GLYPHS);
    const line = plain(state, 120, 24)[0] ?? "";
    for (const hit of hits) {
      if (hit.target.kind !== "tab") continue;
      expect(hit.row).toBe(0);
      expect(line.slice(hit.start, hit.end)).toContain(FACTORY_TAB_LABELS[hit.target.tab]);
    }
  });

  it("the footer lists only the keys that work now", () => {
    const empty = plain(initialFactoryState(), 120, 24).at(-1) ?? "";
    expect(empty).toContain("pestaña");
    expect(empty).toContain("1-7");
    expect(empty).toContain("Esc cerrar");
    expect(empty).not.toContain("mover");
    expect(empty).not.toContain("Enter");

    const rows = plain(withRows(2), 120, 24).at(-1) ?? "";
    expect(rows).toContain("↑/↓ mover");
    expect(rows).toContain("Enter detalle");

    const detail = plain(withRows(2, true), 120, 24).at(-1) ?? "";
    expect(detail).toContain("Esc volver");
    expect(detail).not.toContain("Esc cerrar");
    expect(detail).not.toContain("mover");
    expect(detail).not.toContain("Enter");
  });

  it("the footer's Esc is clickable and fits at 40 columns", () => {
    const close = renderFactoryScreen(initialFactoryState(), 40, 24, UNICODE_FACTORY_GLYPHS);
    expect(close.hits.some((hit) => hit.row === 23 && hit.target.kind === "close")).toBe(true);
    expect(plain(initialFactoryState(), 40, 24).at(-1)).toContain("Esc cerrar");
    const back = renderFactoryScreen(withRows(2, true), 40, 24, UNICODE_FACTORY_GLYPHS);
    expect(back.hits.some((hit) => hit.row === 23 && hit.target.kind === "back")).toBe(true);
  });

  it("uses plain ASCII for the keys and the frame under the ASCII glyphs", () => {
    const lines = plain(withRows(2), 120, 24, ASCII_FACTORY_GLYPHS);
    expect(lines[1]?.startsWith("+- Avance")).toBe(true);
    expect(lines.at(-1)).toContain("Up/Down mover");
    expect(lines.at(-1)).toContain("Left/Right pestaña");
  });

  it("paints no background", () => {
    const { lines } = renderFactoryScreen(withRows(2), 80, 24, UNICODE_FACTORY_GLYPHS);
    for (const line of lines) expect(line).not.toMatch(BACKGROUND_SGR);
  });

  it("names the detail in the frame's title", () => {
    expect(plain(withRows(2, true), 80, 24)[1]).toContain("Avance · detalle");
  });
});
