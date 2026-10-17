import { describe, expect, it } from "vitest";
import { checkTaskKind, isPlannerAgent, PLANNER_AGENT_REFS } from "../src/domain/task-kind.js";

// Task kinds at creation (LD-T4): a plan task runs on a planner agent, and a planner agent runs only plan tasks.
// verify and summarize have no agent of their own yet, so a task.create cannot ask for them.

describe("checkTaskKind", () => {
  it("treats an absent kind as work", () => {
    expect(checkTaskKind(undefined, "fake:succeed")).toEqual({ ok: true, kind: "work" });
    expect(checkTaskKind("work", "analyst")).toEqual({ ok: true, kind: "work" });
  });

  it("accepts a plan task on the planner and on its hermetic stand-in", () => {
    expect(PLANNER_AGENT_REFS).toEqual(["planner", "fake:plan"]);
    expect(checkTaskKind("plan", "planner")).toEqual({ ok: true, kind: "plan" });
    expect(checkTaskKind("plan", "fake:plan")).toEqual({ ok: true, kind: "plan" });
  });

  it("rejects a plan task on any other agent and names the planner agents", () => {
    const result = checkTaskKind("plan", "fake:succeed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('"fake:succeed"');
      expect(result.reason).toContain("planner");
      expect(result.reason).toContain("fake:plan");
    }
    expect(checkTaskKind("plan", "analyst").ok).toBe(false);
  });

  it("rejects a planner agent on a work task", () => {
    for (const agent of ["planner", "fake:plan"]) {
      const result = checkTaskKind("work", agent);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(`"${agent}" runs only plan tasks`);
    }
    expect(checkTaskKind(undefined, "fake:plan").ok).toBe(false);
  });

  it("rejects the kinds a task.create cannot ask for", () => {
    for (const kind of ["verify", "summarize", "bogus", 3, null]) {
      const result = checkTaskKind(kind, "fake:succeed");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('task kind must be "work" or "plan"');
    }
  });

  it("isPlannerAgent matches exactly the planner references", () => {
    expect(isPlannerAgent("planner")).toBe(true);
    expect(isPlannerAgent("fake:plan")).toBe(true);
    expect(isPlannerAgent("fake:planner")).toBe(false);
    expect(isPlannerAgent("analyst")).toBe(false);
  });
});
