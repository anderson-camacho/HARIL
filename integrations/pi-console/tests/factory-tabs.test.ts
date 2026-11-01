import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASCII_FACTORY_GLYPHS, UNICODE_FACTORY_GLYPHS } from "../src/factory-kit.js";
import {
  FACTORY_TABS,
  type FactoryState,
  type FactoryTab,
  factoryFeedEnded,
  factoryKey,
  factoryModelArrived,
  initialFactoryState,
} from "../src/factory-state.js";
import type { FactoryModel } from "../src/factory-types.js";
import { renderFactoryScreen } from "../src/factory-view.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { model, NOW, TASKS, task, workflow } from "./factory-fixture.js";

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

function on(tab: FactoryTab, data: FactoryModel = model()): FactoryState {
  return { ...factoryModelArrived(initialFactoryState(), data), tab };
}

function press(state: FactoryState, ...keys: readonly string[]): FactoryState {
  return keys.reduce((current, key) => factoryKey(current, key).state, state);
}

function lines(state: FactoryState, width = 120, rows = 40, g = UNICODE_FACTORY_GLYPHS): string[] {
  return renderFactoryScreen(state, width, rows, g).lines.map(stripAnsi);
}

function text(state: FactoryState, width = 120, rows = 40): string {
  return lines(state, width, rows).join("\n");
}

const DATA_TABS: readonly FactoryTab[] = ["avance", "actividades", "tablero", "agentes"];

// Every view of the four tabs with data: rows and detail, sub-views and scopes.
function everyView(): FactoryState[] {
  const views: FactoryState[] = [];
  for (const tab of DATA_TABS) {
    const state = on(tab);
    views.push(state, press(state, "\r"));
  }
  const inbox = on("actividades");
  for (let step = 0; step < 5; step++) {
    const moved = press(inbox, ...Array.from({ length: step }, () => "]"));
    views.push(moved, press(moved, "\r"));
  }
  views.push(press(inbox, "e"), press(inbox, "e", "\r"));
  const avance = on("avance");
  for (let step = 0; step < 4; step++) {
    const moved = press(avance, ...Array.from({ length: step }, () => "]"));
    views.push(moved, press(moved, "\r"));
  }
  views.push(press(on("agentes"), "t"));
  views.push(press(on("tablero"), "/", "c", "a"));
  views.push(press(on("tablero"), "c"));
  const empty = model({
    workflows: [],
    tasks: [],
    agents: [],
    edges: [],
    events: [],
    humanRequests: [],
  });
  for (const tab of DATA_TABS) views.push(on(tab, empty));
  return views;
}

describe("the factory's tabs stay inside the window", () => {
  it("no line exceeds the width and the height is exact, at every size", () => {
    for (const width of [1, 2, 3, 10, 20, 40, 59, 60, 69, 70, 80, 95, 96, 120, 200]) {
      for (const rows of [1, 2, 4, 5, 6, 8, 12, 14, 18, 24, 30, 40, 60]) {
        for (const state of everyView()) {
          for (const g of [UNICODE_FACTORY_GLYPHS, ASCII_FACTORY_GLYPHS]) {
            const out = lines(state, width, rows, g);
            const where = `${state.tab} ${width}x${rows}`;
            expect(out.length, where).toBe(rows);
            for (const line of out)
              expect(textWidth(line), `${where}: ${line}`).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it("frames each tab at 40, 80 and 120: the same right border on every row", () => {
    for (const width of [40, 80, 120]) {
      for (const tab of DATA_TABS) {
        const body = lines(on(tab), width, 30).slice(2, 28);
        for (const line of body) {
          expect(line.startsWith("│"), `${tab} ${width}: ${line}`).toBe(true);
          expect(line.endsWith("│"), `${tab} ${width}: ${line}`).toBe(true);
          expect(textWidth(line), `${tab} ${width}`).toBe(width);
        }
      }
    }
  });

  it("draws plain text under NO_COLOR, with the selection still visible", () => {
    process.env.NO_COLOR = "1";
    for (const tab of DATA_TABS) {
      const raw = renderFactoryScreen(on(tab), 120, 40, UNICODE_FACTORY_GLYPHS).lines.join("\n");
      expect(raw, tab).not.toContain("\u001b");
    }
    expect(text(on("tablero"))).toContain("›");
    expect(text(on("agentes"))).toContain("›");
    expect(text(on("avance"))).toContain("›");
    expect(text(press(on("actividades"), "]"))).toContain("›");
  });

  it("paints no background on any tab", () => {
    const background = new RegExp(`${String.fromCharCode(27)}\\[(?:[0-9;]*;)?48;[25];`);
    for (const state of everyView()) {
      const raw = renderFactoryScreen(state, 120, 40, UNICODE_FACTORY_GLYPHS).lines.join("\n");
      expect(raw).not.toMatch(background);
    }
  });
});

describe("before the data arrives", () => {
  it("says so on every tab, and says it when the feed stopped", () => {
    for (const tab of FACTORY_TABS) {
      expect(text({ ...initialFactoryState(), tab })).toContain("Sin datos conectados todavía");
    }
    expect(text(factoryFeedEnded(initialFactoryState()))).toContain("haril factory watch");
  });
});

describe("Tablero", () => {
  it("shows the five columns, with dot, role, agent and who delegated", () => {
    const shown = text(on("tablero"));
    for (const label of ["Por hacer 1", "En curso 1", "Detenidas 1", "Errores 1", "Hechas 1"]) {
      expect(shown).toContain(label);
    }
    expect(shown).toContain("● ejecutor");
    expect(shown).toContain("delegó: d1");
    expect(shown).toContain("delegó: tú");
    expect(shown).toContain("Add the receipts");
  });

  it("shows the selected card's plan, an explanation under each non-normal row, and a bar", () => {
    const shown = text(on("tablero"));
    expect(shown).toContain("Plan: Ship the checkout · awaiting_human");
    expect(shown).toContain("└─ Se detuvo en la parada after_plan");
    expect(shown).toContain("└─ Su último intento falló: agent.timeout.");
    expect(shown).toContain("haril workflow continue wf-stop");
    expect(shown).toContain("1/5 cerradas ~20%");
  });

  it("shows a closed workflow's bar without ~", () => {
    const done = model({
      workflows: [workflow({ state: "completed", closedTasks: 5, totalTasks: 5 })],
    });
    expect(text(on("tablero", done))).toContain("5/5 cerradas 100%");
  });

  it("moves through the cards and between columns, and opens the card with Enter", () => {
    let state = on("tablero");
    expect(state.rowCounts.tablero).toBe(TASKS.length);
    state = press(state, "l");
    expect(lines(state, 40, 30).join("\n")).toContain("En curso 1");
    state = press(state, "l");
    expect(lines(state, 40, 30).join("\n")).toContain("Detenidas 1");
    state = press(state, "h");
    expect(lines(state, 40, 30).join("\n")).toContain("En curso 1");
    state = press(state, "\r");
    const detail = text(state);
    expect(detail).toContain("Tablero · detalle");
    expect(detail).toContain("Por qué");
    expect(detail).toContain("Build the cart");
    expect(detail).toContain("12345");
    expect(detail).toContain("Esc volver");
  });

  it("shows one column at a time below 70 columns", () => {
    const shown = lines(on("tablero"), 69, 24).join("\n");
    expect(shown).toContain("Por hacer 1");
    expect(shown).not.toContain("Hechas 1");
    expect(shown).toContain("1/5");
  });

  it("gives way to the progress bar alone when the window is low", () => {
    const shown = text(on("tablero"), 120, 12);
    expect(shown).toContain("1/5 cerradas");
    expect(shown).not.toContain("Plan: Ship");
  });

  it("filters with /, shows the search on the frame, and clears it with Esc", () => {
    const state = press(on("tablero"), "/", "t", "a", "x");
    expect(state.rowCounts.tablero).toBe(1);
    expect(text(state)).toContain("[ tax_ ]");
    expect(text(state)).toContain("Esc limpiar");
    const applied = press(state, "\r");
    expect(applied.filtering).toBe(false);
    expect(text(applied)).toContain("[ tax ]");
    const cleared = press(applied, "\u001b");
    expect(cleared.rowCounts.tablero).toBe(TASKS.length);
    expect(factoryKey(cleared, "\u001b").effect).toBe("close");
  });

  it("offers a new task only where it can run, and hands it to the console", () => {
    expect(text(on("tablero"))).toContain("n nueva");
    expect(factoryKey(on("tablero"), "n").effect).toBe("new-task");
    const readOnly = { ...on("tablero"), readOnly: true };
    expect(text(readOnly)).not.toContain("n nueva");
    const refused = factoryKey(readOnly, "n");
    expect(refused.effect).toBeUndefined();
    expect(text(refused.state)).toContain("solo lectura");
  });

  it("continues a stopped plan after asking", () => {
    const state = on("tablero");
    expect(text(state)).toContain("c continuar");
    const asked = factoryKey(state, "c");
    expect(asked.effect).toBeUndefined();
    expect(text(asked.state)).toContain("¿continuar el flujo «Ship the checkout»? s/n");
    expect(text(asked.state)).toContain("s confirmar");
    expect(factoryKey(asked.state, "n").state.confirm).toBeNull();
    expect(factoryKey(asked.state, "s").effect).toEqual({
      kind: "continue",
      workflowId: "wf-stop",
      projectSlug: "demo",
      label: "continuar el flujo «Ship the checkout»",
    });
  });

  it("offers no continue when no workflow waits", () => {
    const state = on("tablero", model({ workflows: [workflow({ state: "running" })] }));
    expect(text(state)).not.toContain("c continuar");
    expect(factoryKey(state, "c").handled).toBe(false);
  });
});

describe("Actividades", () => {
  it("shows its sub-views, the search field and two-line rows", () => {
    const shown = text(on("actividades"));
    expect(shown).toContain("[Activas 1]");
    expect(shown).toContain("En cola 2");
    expect(shown).toContain("Fallidas 1");
    expect(shown).toContain("Hechas 1");
    expect(shown).toContain("Te necesitan 2");
    expect(shown).toContain("[ Buscar / ]");
    expect(shown).toContain("Build the cart");
    expect(shown).toContain("Trabajando: Está en el intento 1.");
  });

  it("puts what waits in En cola and what failed in Fallidas, with its explanation", () => {
    expect(text(press(on("actividades"), "]"))).toContain("Detenida por una parada");
    const failed = text(press(on("actividades"), "]", "]"));
    expect(failed).toContain("Write the tax rules");
    expect(failed).toContain("agent.timeout");
  });

  it("answers an approval from Te necesitan, asking first", () => {
    const state = press(on("actividades"), "[");
    expect(state.activityView).toBe("te_necesitan");
    const shown = text(state);
    expect(shown).toContain("Plan de 2 tareas: Do it");
    expect(shown).toContain("a aprobar");
    expect(shown).toContain("d negar");
    expect(factoryKey(state, "a").effect).toBeUndefined();
    const approve = factoryKey(factoryKey(state, "a").state, "\r");
    expect(approve.effect).toMatchObject({ kind: "approve", approvalId: "ap-1" });
    const deny = factoryKey(factoryKey(state, "d").state, "s");
    expect(deny.effect).toMatchObject({ kind: "deny", approvalId: "ap-1" });
  });

  it("offers neither answer outside an approval, nor in a read-only mode", () => {
    expect(text(on("actividades"))).not.toContain("a aprobar");
    expect(factoryKey(on("actividades"), "a").handled).toBe(false);
    const readOnly = { ...press(on("actividades"), "["), readOnly: true };
    expect(text(readOnly)).not.toContain("a aprobar");
    expect(factoryKey(readOnly, "a").state.confirm).toBeNull();
    expect(text(factoryKey(readOnly, "a").state)).toContain("solo lectura");
  });

  it("marks what changed since it was last read, and only until it is read", () => {
    const first = on("actividades");
    expect(text(first)).toContain("2 sin leer");
    const changed = factoryModelArrived(
      first,
      model({ tasks: TASKS.map((row) => (row.id === "t-e1" ? { ...row, updatedAt: NOW } : row)) }),
    );
    expect(text(changed)).toContain("3 sin leer");
    expect(text(changed)).toContain("●");
    const read = press(changed, "\r", "\u001b");
    expect(text(read)).toContain("2 sin leer");
  });

  it("shows the event log, newest first, and opens an event", () => {
    const state = press(on("actividades"), "e");
    const shown = text(state);
    expect(shown).toContain("Eventos  2 · 0 fallos");
    expect(shown.indexOf("workflow.awaiting_human")).toBeLessThan(shown.indexOf("run.started"));
    expect(shown).toContain("e bandeja");
    const detail = text(press(state, "\r"));
    expect(detail).toContain("reason=after_plan");
    expect(press(state, "\u001b").eventLog).toBe(false);
  });
});

describe("Agentes", () => {
  it("lists each agent with exact tokens, context, time, model and task", () => {
    const shown = text(on("agentes"));
    for (const head of ["AGENTE", "TOKENS", "CTX", "TIEMPO", "MODELO Y TAREA"]) {
      expect(shown).toContain(head);
    }
    expect(shown).toContain("12345");
    expect(shown).toContain("42%");
    expect(shown).toContain("1:03");
    expect(shown).toContain("fake/mid Build the cart");
    expect(shown).toContain("n/d");
  });

  it("shows the meters from facts", () => {
    const shown = text(on("agentes"));
    expect(shown).toContain("5/20");
    expect(shown).toContain("123456/200000");
  });

  it("toggles between the tree and the list sorted by tokens", () => {
    const tree = text(on("agentes"));
    expect(tree).toContain("└─e3");
    expect(tree.indexOf(" o1")).toBeLessThan(tree.indexOf("e1"));
    const list = press(on("agentes"), "t");
    const flat = text(list);
    expect(flat).toContain("t árbol");
    expect(flat).not.toContain("└─e3");
    expect(flat.indexOf("e1")).toBeLessThan(flat.indexOf(" o1"));
  });

  it("opens an agent with its task's explanation", () => {
    expect(text(press(on("agentes"), "\r"))).toContain("Qué pasa");
  });
});

describe("Avance", () => {
  it("draws the ring, the arcs and the history when there is room", () => {
    const shown = text(on("avance"), 120, 40);
    expect(shown).toContain("~20%");
    expect(shown).toContain("█");
    expect(shown).toContain("▒");
    for (const name of ["Tareas", "Agentes", "Tokens", "Calidad"]) expect(shown).toContain(name);
    expect(shown).toContain("★ Tareas cerradas  1");
    expect(shown).toContain("inicio");
    expect(shown).toContain("ahora");
  });

  it("degrades to bars in a small window, and the layout holds", () => {
    const shown = text(on("avance"), 40, 12);
    expect(shown).toContain("Tareas");
    expect(shown).toContain("~20% 1/5");
    expect(shown).not.toContain("▒");
  });

  it("uses a sparkline when the history has no room for its chart", () => {
    const shown = text(on("avance"), 50, 13);
    expect(shown).toContain("Tareas cerradas");
    expect(shown).toMatch(/[▁▂▃▄▅▆▇█]{10}/);
  });

  it("says Sin pruebas when no fact backs an indicator, never 0", () => {
    const blank = model({
      workflows: [
        workflow({
          closedTasks: 0,
          totalTasks: 0,
          criteria: null,
          tokensBudget: null,
          agentsCap: 0,
        }),
      ],
      tasks: [],
      agents: [],
    });
    for (const size of [
      [120, 40],
      [40, 14],
    ] as const) {
      const shown = text(on("avance", blank), size[0], size[1]);
      expect(shown).toContain("Sin pruebas");
      expect(shown).not.toContain("0%");
    }
  });

  it("moves between the whole project and each workflow", () => {
    const two = model({
      workflows: [
        workflow(),
        workflow({ id: "wf-2", goal: "Other work", closedTasks: 3, totalTasks: 4 }),
      ],
    });
    const state = on("avance", two);
    expect(text(state)).toContain("Proyecto demo · 1/3");
    expect(text(state)).toContain("~44%");
    const second = press(state, "j", "j");
    expect(text(second)).toContain("Other work · 3/3");
    expect(text(second)).toContain("~75%");
  });

  it("lists bars per task, weakest first, with Sin pruebas for those without criteria", () => {
    const shown = text(press(on("avance"), "]"));
    expect(shown).toContain("[Tarea]");
    expect(shown).toContain("50%");
    expect(shown).toContain("100%");
    expect(shown).toContain("Sin pruebas");
    expect(shown.indexOf("e2 Write")).toBeLessThan(shown.indexOf("d1 Plan"));
    expect(shown.indexOf("d1 Plan")).toBeLessThan(shown.indexOf("e1 Build"));
    expect(shown).toContain("Total: 2 de 5 con pruebas");
  });

  it("lists per agent and per model, with ~ for a total that can still grow", () => {
    expect(text(press(on("avance"), "]", "]"))).toContain("[Agente]");
    const models = text(press(on("avance"), "]", "]", "]"));
    expect(models).toContain("[Modelo]");
    expect(models).toContain("fake/mid");
    expect(models).toContain("~20%");
  });
});

describe("the rows follow the data", () => {
  it("keeps the same row selected when a new line changes the order", () => {
    const state = press(on("tablero"), "j", "j");
    const id = "t-o1";
    const next = factoryModelArrived(
      state,
      model({ tasks: [task({ id: "t-new", column: "por_hacer" }), ...TASKS] }),
    );
    expect(next.selection.tablero).toBe(state.selection.tablero + 1);
    expect(text(press(next, "\r"))).toContain("Ship the checkout");
    expect(id).toBe("t-o1");
  });

  it("clamps the selection when the rows are gone", () => {
    const state = press(on("agentes"), "j", "j", "j", "j");
    const next = factoryModelArrived(state, model({ agents: [] }));
    expect(next.selection.agentes).toBe(0);
    expect(next.rowCounts.agentes).toBe(0);
  });
});
