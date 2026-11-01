import { describe, expect, it } from "vitest";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import {
  type FactoryState,
  factoryKey,
  factoryModelArrived,
  initialFactoryState,
} from "../src/factory-state.js";
import type { FactoryModel } from "../src/factory-types.js";
import { renderFactoryScreen } from "../src/factory-view.js";
import { plainText, textWidth } from "../src/text.js";
import { model, NOW } from "./factory-fixture.js";

const screen = (state: FactoryState, width = 120, rows = 34, g = UNICODE_FACTORY_GLYPHS): string =>
  renderFactoryScreen(state, width, rows, g).lines.map(plainText).join("\n");

function opened(overrides: Partial<FactoryModel> = {}): FactoryState {
  const state = factoryModelArrived(
    { ...initialFactoryState(), tab: "conexiones" },
    model(overrides),
  );
  const index = state.model?.agents.findIndex((agent) => agent.code === "e1") ?? 0;
  return { ...state, selection: { ...state.selection, conexiones: index } };
}

describe("the Conexiones tab", () => {
  it("draws the selected agent's chain in round boxes, its action and the trace below", () => {
    const text = screen(opened());
    for (const code of ["o1", "d1", "e1"]) expect(text).toContain(code);
    expect(text).toContain("╭");
    expect(text).toContain("▶ d1 → e1: Build the cart");
    expect(text).toContain("•");
    expect(text).toContain("run.started");
  });

  it("marks an idle link with · and an active one with •", () => {
    const state = opened({
      agents: model().agents.map((agent) =>
        agent.code === "e1" ? { ...agent, status: "waiting" } : agent,
      ),
    });
    const link = screen(state)
      .split("\n")
      .find((line) => line.includes("···"));
    expect(link).toBeDefined();
    expect(link).not.toContain("••");
  });

  it("says whom a waiting agent waits for and why", () => {
    const state = opened({
      agents: model().agents.map((agent) =>
        agent.code === "e1" ? { ...agent, status: "waiting", waitingFor: ["e2"] } : agent,
      ),
    });
    const text = screen(state);
    expect(text).toContain("e1 espera a e2");
    expect(text).toContain("Está en el intento 1.");
  });

  it("lights the delegation path in the tree", () => {
    const tree = { ...opened(), conexionesView: "arbol" as const };
    const text = screen(tree);
    expect(text).toContain("[o1]");
    expect(text).toContain("[d1]");
    expect(text).toContain("[e1]");
    expect(text).toContain("(e2)");
  });

  it("counts what is in flight in the network", () => {
    const text = screen({ ...opened(), conexionesView: "red" as const });
    expect(text).toContain("mensajes en curso");
    expect(text).toMatch(/\d agentes +\d enlaces/);
  });

  it("draws the selected agent's events as a sequence", () => {
    const text = screen({ ...opened(), conexionesView: "secuencia" as const });
    expect(text).toContain("run.started attempt=1");
    expect(text).toContain("┆");
  });

  it("shows a handoff only when one happened", () => {
    expect(screen({ ...opened(), conexionesView: "relevo" as const })).toContain(
      "No hubo ningún relevo",
    );
    const state = opened({
      handoffs: [
        {
          at: NOW - 60_000,
          workflowId: "wf-stop",
          agent: "e1",
          kind: "model",
          from: "fake/low",
          to: "fake/mid",
        },
      ],
    });
    const text = screen({ ...state, conexionesView: "relevo" as const });
    expect(text).toContain("Relevo de modelo de e1");
    expect(text).toContain("fake/low");
    expect(text).toContain("fake/mid");
  });

  it("degrades to an indented tree when it does not fit", () => {
    const text = screen(opened(), 40, 20);
    expect(text).toContain("└─");
    expect(text).not.toContain("▶ d1");
  });

  it("moves between views with [ and ], and between agents with j", () => {
    const state = opened();
    expect(factoryKey(state, "]").state.conexionesView).toBe("arbol");
    expect(factoryKey(state, "[").state.conexionesView).toBe("relevo");
    expect(factoryKey(state, "j").state.selection.conexiones).toBe(state.selection.conexiones + 1);
  });

  it("stays inside its width at every size and view", () => {
    const views = ["cadena", "arbol", "red", "secuencia", "relevo"] as const;
    const withHandoff = opened({
      handoffs: [
        { at: NOW, workflowId: "wf-stop", agent: "e1", kind: "agent", from: "e1", to: "e4" },
      ],
    });
    for (const view of views) {
      for (const g of [UNICODE_FACTORY_GLYPHS, ASCII_FACTORY_GLYPHS]) {
        for (const width of [1, 7, 20, 40, 60, 79, 120, 200]) {
          for (const rows of [1, 4, 6, 9, 24, 60]) {
            const { lines } = renderFactoryScreen(
              { ...withHandoff, conexionesView: view },
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
