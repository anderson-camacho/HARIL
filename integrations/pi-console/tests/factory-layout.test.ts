import { describe, expect, it } from "vitest";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import {
  type FactoryState,
  type FactoryTab,
  factoryKey,
  factoryModelArrived,
  initialFactoryState,
} from "../src/factory-state.js";
import type { FactoryModel } from "../src/factory-types.js";
import { renderFactoryScreen } from "../src/factory-view.js";
import { plainText, textWidth } from "../src/text.js";
import { model, NOW, task, workflow } from "./factory-fixture.js";

// What a person reads as misaligned: columns that touch, a heading away from its line, a map whose lines do not meet.

function on(tab: FactoryTab, data: FactoryModel = model()): FactoryState {
  return { ...factoryModelArrived(initialFactoryState(), data), tab };
}

function press(state: FactoryState, ...keys: readonly string[]): FactoryState {
  return keys.reduce((current, key) => factoryKey(current, key).state, state);
}

function screen(state: FactoryState, width = 120, rows = 34, g = UNICODE_FACTORY_GLYPHS): string[] {
  return renderFactoryScreen(state, width, rows, g).lines.map(plainText);
}

// A workflow whose root delegated one part, and that part as many tasks as asked.
function oneTopic(leaves: number): FactoryModel {
  const leafRows = Array.from({ length: leaves }, (_, index) =>
    task({
      id: `t-leaf-${index}`,
      agent: `e${index}`,
      delegatedBy: "d1",
      title: `Leaf number ${index}`,
      column: "hechas",
    }),
  );
  return model({
    tasks: [
      task({ id: "t-root", agent: "o1", delegatedBy: null, title: "The goal" }),
      task({ id: "t-part", agent: "d1", delegatedBy: "o1", title: "The part" }),
      ...leafRows,
    ],
    agents: [],
    edges: [],
    humanRequests: [],
  });
}

function mapOf(data: FactoryModel, width = 120, rows = 34, g = UNICODE_FACTORY_GLYPHS): string[] {
  return screen(press(on("tablero", data), "]"), width, rows, g);
}

describe("the Tablero's plan table", () => {
  it("leaves a space between columns when a title or a state fills its own", () => {
    const data = model({
      workflows: [workflow()],
      tasks: [
        task({
          id: "t-long",
          title: "A title long enough to fill the whole of its column and then some more words",
          explanation: {
            code: "ready_stopped",
            what: "Detenida por una parada del flujo",
            why: "Se detuvo.",
            systemAction: "Espera.",
            needsHuman: true,
            until: null,
          },
        }),
      ],
    });
    const row = screen(on("tablero", data)).find((line) => line.includes("Detenida por una"));
    expect(row).toBeDefined();
    expect(row).toMatch(/… Detenida/);
    expect(row).toMatch(/… 1\/3/);
  });
});

describe("the Tablero's mind map", () => {
  it("puts a lone part on the goal's row, joined by a straight line", () => {
    for (const rows of [33, 34]) {
      const lines = mapOf(oneTopic(2), 120, rows);
      const row = lines.find((line) => line.includes("The goal"));
      expect(row).toContain("The part");
      expect(row).toMatch(/The part[^│]*│─+.*The goal/);
    }
  });

  it("joins the leaves with square lines, never a diagonal", () => {
    const text = mapOf(oneTopic(6)).join("\n");
    expect(text).not.toMatch(/[╲╱]/);
    expect(text).toMatch(/Leaf number 0 ─+╮/);
    expect(text).toMatch(/Leaf number 5 ─+╯/);
  });

  it("shows every leaf that fits and counts the rest", () => {
    const fits = mapOf(oneTopic(14)).join("\n");
    for (let index = 0; index < 14; index++) expect(fits).toContain(`Leaf number ${index}`);
    const short = mapOf(oneTopic(40), 120, 20).join("\n");
    expect(short).toMatch(/\+ \d+ más/);
  });

  it("stays inside the window in ASCII, without box-drawing lines", () => {
    for (const leaves of [0, 1, 5, 40]) {
      const lines = mapOf(oneTopic(leaves), 80, 20, ASCII_FACTORY_GLYPHS);
      expect(lines).toHaveLength(20);
      for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(80);
      expect(lines.join("\n")).not.toMatch(/[╮╯┤├┬┴]/);
    }
  });
});

describe("the Conexiones tab", () => {
  it("names the roles in the person's language in the chain", () => {
    const text = screen(on("conexiones")).join("\n");
    expect(text).toContain("orquestador");
    expect(text).not.toContain("orchestrator");
  });

  it("shows the whole age of a trace's event, apart from its text", () => {
    const state = on(
      "conexiones",
      model({
        events: [
          {
            at: NOW,
            type: "worktree.committed",
            text: "a long text that fills all of its column and goes on and on and on and on and on and on and on",
            workflowId: "wf-stop",
            agent: "o1",
          },
        ],
      }),
    );
    expect(screen(state).join(" ")).toMatch(/… +hace un momento/);
  });

  it("puts each name of the sequence over its own lifeline", () => {
    const state = press(on("conexiones"), "]", "]", "]");
    const lines = screen({ ...state, selection: { ...state.selection, conexiones: 1 } });
    const head = lines.findIndex((line) => /\bo1\b/.test(line) && /\bd1\b/.test(line));
    const line = lines[head] ?? "";
    const below = lines[head + 2] ?? "";
    for (const code of ["o1", "d1"]) {
      const at = line.indexOf(code);
      const around = [...below].slice(at, at + code.length).join("");
      expect(around, code).toMatch(/[┃┆]/);
    }
  });
});

describe("the Modelos monitor", () => {
  it("separates the 5-hour meter from the weekly one", () => {
    const row = screen(press(on("modelos"), "]")).find((line) => line.includes("Anti1 Gemini"));
    expect(row).toMatch(/\] 7d\[/);
  });
});
