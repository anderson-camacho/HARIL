import { describe, expect, it } from "vitest";
import { GoalForm, goalArgs } from "../src/goal.js";

// The goal form of the shell (LD-T5) and its argv: a plan task queued through `haril task add --kind plan`. Pure:
// no process runs here; app-actions.test.ts runs the form against a fixture haril.

describe("goalArgs (LD-T5 argv)", () => {
  const target = { slug: "demo", dataDir: "/data/haril" };

  it("builds a plan task for the planner with its model and the data dir the shell was given", () => {
    expect(
      goalArgs({ goal: "  Plan the release  ", agent: "planner", model: "qwen-test" }, target),
    ).toEqual({
      ok: true,
      args: [
        "task",
        "add",
        "Plan the release",
        "--project",
        "demo",
        "--kind",
        "plan",
        "--agent",
        "planner",
        "--model",
        "qwen-test",
        "--data-dir",
        "/data/haril",
      ],
    });
  });

  it("never passes a model to the simulated planner and omits the data dir when none is known", () => {
    expect(
      goalArgs(
        { goal: "Offline plan", agent: "fake:plan", model: "qwen-test" },
        { slug: "demo", dataDir: undefined },
      ),
    ).toEqual({
      ok: true,
      args: [
        "task",
        "add",
        "Offline plan",
        "--project",
        "demo",
        "--kind",
        "plan",
        "--agent",
        "fake:plan",
      ],
    });
  });

  it("refuses an empty goal and a planner without a model, before any process runs", () => {
    expect(goalArgs({ goal: "  ", agent: "fake:plan", model: "" }, target)).toEqual({
      ok: false,
      message: "goal is required",
    });
    const noModel = goalArgs({ goal: "Needs model", agent: "planner", model: " " }, target);
    expect(noModel.ok).toBe(false);
    expect(!noModel.ok && noModel.message).toMatch(/model/);
  });
});

describe("GoalForm", () => {
  it("starts on planner with the default model when one is known, else on fake:plan", () => {
    const withModel = new GoalForm({ projectSlug: "demo", defaultModel: "qwen-test" });
    expect(withModel.values()).toEqual({ goal: "", agent: "planner", model: "qwen-test" });
    const without = new GoalForm({ projectSlug: "demo", defaultModel: undefined });
    expect(without.values()).toEqual({ goal: "", agent: "fake:plan", model: "" });
  });

  it("types the goal, moves between fields and changes the agent", () => {
    const form = new GoalForm({ projectSlug: "demo", defaultModel: "qwen-test" });
    for (const key of "Ship it") form.handleInput(key);
    expect(form.values().goal).toBe("Ship it");
    form.next();
    expect(form.field).toBe("agent");
    form.handleInput("\x1b[B");
    expect(form.values().agent).toBe("fake:plan");
    form.previous();
    expect(form.field).toBe("goal");
    const lines = form.lines().join("\n");
    expect(lines).toContain("Plan a goal for project demo");
    expect(lines).toContain("Ship it");
    expect(lines).toContain("(planner only)");
  });
});

describe("the goal sent is the goal shown (LD-T6b-2)", () => {
  it("goalArgs sends format characters, controls and lone surrogates as ?", () => {
    const built = goalArgs(
      { goal: "do\u{200B}it\u{202E}\x1b[2J\u{E0041}\ud83d", agent: "fake:plan", model: "" },
      { slug: "demo", dataDir: undefined },
    );
    expect(built.ok && built.args[2]).toBe("do?it??[2J??");
  });

  it("the form shows the goal as it will be sent", () => {
    const form = new GoalForm({ projectSlug: "demo", defaultModel: undefined });
    form.handleInput("\x1b[200~do\u{200B}it\u{E0041}\x1b[201~");
    expect(form.lines().join("\n")).toContain("goal    do?it?_");
  });
});
