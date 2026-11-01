import { describe, expect, it } from "vitest";
import { runFactoryAction } from "../src/factory-actions.js";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import {
  type FactoryState,
  factoryKey,
  factoryModelArrived,
  initialFactoryState,
} from "../src/factory-state.js";
import { renderFactoryScreen } from "../src/factory-view.js";
import { plainText, textWidth } from "../src/text.js";
import { model, QUOTA } from "./factory-fixture.js";

const ESC = "\u001b";
const screen = (state: FactoryState, width = 120, rows = 40, g = UNICODE_FACTORY_GLYPHS): string =>
  renderFactoryScreen(state, width, rows, g).lines.map(plainText).join("\n");

function opened(): FactoryState {
  return factoryModelArrived({ ...initialFactoryState(), tab: "modelos" }, model());
}

describe("the Modelos tab", () => {
  it("draws a card per account with each group's models, bars, resets and age", () => {
    const text = screen(opened());
    expect(text).toContain("Anti1 · antigravity · ultra");
    expect(text).toContain("hace 3 min");
    expect(text).toContain("Claude and GPT");
    expect(text).toContain("claude-opus-4-6-thinking, gpt-6.1-sol");
    expect(text).toContain("90 %");
    expect(text).toContain("reinicia en 1 h");
    expect(text).toContain("Éxitos 12");
    expect(text).toContain("Fallos 1");
    expect(text).toContain("Agentes: e1");
    expect(text).toContain("Evitada: pasó el 80 %");
  });

  it("tells apart an estimate, a stale value, and what cannot be known", () => {
    const text = screen({ ...opened(), selection: { ...opened().selection, modelos: 1 } }, 130, 60);
    expect(text).toContain("~12.300 tokens");
    expect(text).toContain("Sin lectura: falta la clave de gestión");
    expect(text).toContain("55 %");
    expect(text).toContain("antigua");
    expect(text).toContain("El proveedor no permite ver este dato");
    expect(text).toContain("No aplica");
    expect(text).toContain("other: Sin lectura");
  });

  it("never writes a percentage for an estimate", () => {
    const state = factoryModelArrived(
      { ...initialFactoryState(), tab: "modelos" },
      model({
        quota: { ...QUOTA, accounts: [QUOTA.accounts[1] as (typeof QUOTA.accounts)[number]] },
      }),
    );
    const estimateLine = screen(state)
      .split("\n")
      .find((line) => line.includes("~12.300"));
    expect(estimateLine).not.toContain("%");
  });

  it("moves between its views with [ and ]", () => {
    const monitor = factoryKey(opened(), "]").state;
    expect(monitor.modelosView).toBe("monitor");
    expect(screen(monitor)).toContain("5h[");
    const history = factoryKey(monitor, "]").state;
    expect(history.modelosView).toBe("historial");
    const cache = factoryKey(history, "]").state;
    expect(cache.modelosView).toBe("cache");
    expect(factoryKey(cache, "]").state.modelosView).toBe("cuentas");
  });

  it("charts a pool with the switch threshold as a red line", () => {
    const history = { ...opened(), modelosView: "historial" as const };
    const lines = renderFactoryScreen(history, 100, 24, UNICODE_FACTORY_GLYPHS).lines;
    const text = lines.map(plainText).join("\n");
    expect(text).toContain("Anti1 Gemini");
    expect(text).toContain("umbral 80 %");
    expect(text).toMatch(/[⠁-⣿]/);
    const limit = lines.find((line) => plainText(line).includes("╌╌╌╌╌╌"));
    expect(limit).toBeDefined();
    expect(screen({ ...history, selection: { ...history.selection, modelos: 2 } })).toContain(
      "Sin lecturas guardadas",
    );
  });

  it("shows the prompt cache only where it was reported", () => {
    const text = screen({ ...opened(), modelosView: "cache" });
    expect(text).toContain("40 %");
    expect(text).toContain("4.000 de 10.000 tokens de entrada");
    expect(text).toContain("no informa tokens en caché");
  });

  it("re-reads with r, without asking, and reports the answer", async () => {
    const transition = factoryKey(opened(), "r");
    expect(transition.effect).toMatchObject({ kind: "reread" });
    const runs: (readonly string[])[] = [];
    const answer = await runFactoryAction(
      { kind: "reread", label: "leer la cuota" },
      {
        run: async (args) => {
          runs.push(args);
          return { ok: true, code: 0, stdout: "{}", stderr: "" };
        },
        ensureRuntime: async () => undefined,
        refusal: () => "no",
      },
    );
    expect(runs).toEqual([["quota", "--json"]]);
    expect(answer).toContain("Cuota leída");
  });

  it("opens an account's detail, and Esc goes back", () => {
    const detail = factoryKey(opened(), "\r").state;
    expect(detail.detail).toBe(true);
    expect(screen(detail)).toContain("referencia acct-aaa");
    expect(factoryKey(detail, ESC).state.detail).toBe(false);
  });

  it("stays inside its width at every size and view, with and without Unicode", () => {
    for (const view of ["cuentas", "monitor", "historial", "cache"] as const) {
      for (const g of [UNICODE_FACTORY_GLYPHS, ASCII_FACTORY_GLYPHS]) {
        for (const width of [1, 5, 20, 40, 79, 120, 200]) {
          for (const rows of [1, 4, 8, 24]) {
            const { lines } = renderFactoryScreen(
              { ...opened(), modelosView: view },
              width,
              rows,
              g,
            );
            expect(lines.length).toBeLessThanOrEqual(rows);
            for (const line of lines) expect(textWidth(plainText(line))).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });
});
