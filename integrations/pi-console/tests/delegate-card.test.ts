import { describe, expect, it } from "vitest";
import {
  cardClick,
  cardKey,
  cardProblem,
  createCard,
  readAutonomy,
  renderCard,
  selectedStops,
  workflowStartArgs,
} from "../src/delegate-card.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The /delegate card (3.13, 7.5): the one human confirmation of a workflow. It shows the goal, the orchestrator's model
// and the autonomy decided for this run: what the message said about stops, read with a closed vocabulary, or no stop
// when it said nothing, so the workflow starts working at once. The human toggles stops and confirms; the card builds
// the exact `haril workflow start` arguments, always with real agents (--agent orchestrator).

const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };
const MODEL = "fake-gw/fake-high-model";

describe("reading the autonomy from the message", () => {
  it("runs without stops when the message says nothing, so the workflow does not wait", () => {
    expect(readAutonomy("Change the button color and test it")).toEqual({
      said: false,
      stops: [],
    });
  });

  it("runs without stops when the message says so, in English or Spanish", () => {
    for (const text of [
      "Refactor the parser, don't stop",
      "do it autonomously",
      "Cambia el color y no pares",
      "hazlo sin paradas",
      "Hazlo en modo autónomo",
    ]) {
      expect(readAutonomy(text), text).toEqual({ said: true, stops: [] });
    }
  });

  it("reads the stops the message names", () => {
    expect(readAutonomy("stop after the plan and stop at the end").stops).toEqual([
      "after_plan",
      "at_end",
    ]);
    expect(readAutonomy("para al final y si falla una auditoría").stops).toEqual([
      "at_end",
      "on_audit_failure",
    ]);
    expect(readAutonomy("stop at 80% of the budget").stops).toEqual(["on_budget_pct:80"]);
    expect(readAutonomy("para al 50 % del presupuesto").stops).toEqual(["on_budget_pct:50"]);
    expect(readAutonomy("use after_node:part-1 and before_merge").stops).toEqual([
      "after_node:part-1",
      "before_merge",
    ]);
  });

  it("lets a named stop win over a no-stop phrase", () => {
    expect(readAutonomy("don't stop, except at the end").stops).toEqual(["at_end"]);
  });

  it("ignores an out-of-range budget", () => {
    expect(readAutonomy("stop at 150% of the budget")).toEqual({
      said: false,
      stops: [],
    });
  });
});

describe("the card", () => {
  it("lists the usual stops plus any the message named, checked as read", () => {
    const card = createCard("Fix it; stop at 75% of the budget", MODEL);
    expect(card.stops.map((row) => [row.stop, row.on])).toEqual([
      ["after_plan", false],
      ["at_end", false],
      ["on_audit_failure", false],
      ["on_budget_pct:75", true],
    ]);
    expect(selectedStops(card)).toEqual(["on_budget_pct:75"]);
  });

  it("builds haril workflow start with real agents, the model and the stops", () => {
    const card = createCard("Change the primary button color; stop after the plan", MODEL);
    expect(workflowStartArgs(card, "fake-proj")).toEqual([
      "workflow",
      "start",
      "--goal",
      "Change the primary button color; stop after the plan",
      "--model",
      MODEL,
      "--agent",
      "orchestrator",
      "--stop-at",
      "after_plan",
      "--project",
      "fake-proj",
      "--intake-stdin",
      "--json",
    ]);
  });

  it("passes --autonomous when no stop is checked, also when the message says nothing", () => {
    for (const goal of ["Refactor, don't stop", "Refactor the parser"]) {
      const args = workflowStartArgs(createCard(goal, MODEL), "fake-proj");
      expect(args, goal).toContain("--autonomous");
      expect(args, goal).not.toContain("--stop-at");
      expect(args, goal).toContain("--project");
    }
  });

  it("toggles stops with the keyboard and starts on Enter", () => {
    let card = createCard("Goal", MODEL);
    let step = cardKey(card, "\u001b[B");
    card = step.card;
    step = cardKey(card, " ");
    card = step.card;
    expect(selectedStops(card)).toEqual(["at_end"]);
    step = cardKey(card, "a");
    expect(selectedStops(step.card)).toEqual([]);
    step = cardKey(step.card, "a");
    expect(selectedStops(step.card)).toEqual(["after_plan"]);
    expect(cardKey(step.card, "\r").effect).toBe("start");
    expect(cardKey(step.card, "\u001b").effect).toBe("cancel");
    expect(cardKey(step.card, "m").effect).toBe("choose-model");
    expect(cardKey(step.card, "z").handled).toBe(false);
  });

  it("refuses to start without a model", () => {
    const card = createCard("Goal", undefined);
    expect(cardProblem(card)).toMatch(/model/);
    expect(cardKey(card, "\r").effect).toBeUndefined();
    expect(cardProblem(createCard("Goal", MODEL))).toBeUndefined();
  });

  it("draws the goal, the model, the autonomy, the stops and the keys, within the width", () => {
    const card = createCard("Change the primary button color and leave it tested", MODEL);
    for (const width of [60, 100]) {
      const { lines } = renderCard(card, width, THEME);
      const text = lines.map(stripAnsi).join("\n");
      expect(text).toContain("DELEGATE");
      expect(text).toContain("Change the primary button");
      expect(text).toContain(MODEL);
      expect(text).toContain("real agents");
      expect(text).toMatch(/\[ \] after_plan/);
      expect(text).toMatch(/\[ \] at_end/);
      expect(text).toMatch(/autonomous/);
      expect(text).toContain("only you remove them");
      expect(text).toContain("Quota");
      expect(text).toMatch(/Enter.*Start/);
      for (const line of lines) expect(textWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
    }
    expect(
      renderCard(createCard("Go, don't stop", MODEL), 100, THEME).lines.map(stripAnsi).join("\n"),
    ).toMatch(/autonomous/);
  });

  it("shows implementation preflight as policy evidence rather than completed execution", () => {
    const card = createCard("Implement the plan", MODEL, {
      baseBranch: "main",
      testCommand: "npm test",
    });
    const text = renderCard(card, 100, THEME).lines.map(stripAnsi).join("\n");
    expect(text).toContain("Implementation");
    expect(text).toContain("main");
    expect(text).toContain("npm test");
    expect(text).toMatch(/not run|pending/i);
    expect(text).not.toContain("read-only for now");
  });

  it("acts on clicks: a stop row toggles it, the buttons start, cancel or choose the model", () => {
    const card = createCard("Goal", MODEL);
    const { hits } = renderCard(card, 100, THEME);
    const atEnd = hits.find((hit) => hit.target.kind === "stop" && hit.target.index === 1);
    expect(atEnd).toBeDefined();
    const toggled = cardClick(card, atEnd?.target ?? { kind: "cancel" });
    expect(selectedStops(toggled.card)).toEqual(["at_end"]);
    for (const kind of ["start", "cancel", "model"] as const) {
      const hit = hits.find((item) => item.target.kind === kind);
      expect(hit, kind).toBeDefined();
    }
    expect(cardClick(card, { kind: "start" }).effect).toBe("start");
    expect(cardClick(card, { kind: "model" }).effect).toBe("choose-model");
    expect(cardClick(card, { kind: "cancel" }).effect).toBe("cancel");
  });

  it("keeps a margin on both sides and makes the hit boxes follow it", () => {
    const card = createCard("Goal", MODEL);
    const { lines, hits } = renderCard(card, 80, THEME);
    for (const line of lines) {
      const plain = stripAnsi(line);
      expect(plain.startsWith("   ")).toBe(true);
      expect(textWidth(plain)).toBeLessThanOrEqual(77);
    }
    const start = hits.find((hit) => hit.target.kind === "start");
    expect(start?.start).toBeGreaterThanOrEqual(3);
    const row = stripAnsi(lines[start?.row ?? 0] ?? "");
    expect(row.slice(start?.start, start?.end)).toBe("[Enter Start]");
  });
});
