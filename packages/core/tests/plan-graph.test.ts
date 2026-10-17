import type { Plan, PlanTask } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import {
  PLAN_LIMITS,
  type PlanGraphIssue,
  topologicalOrder,
  validatePlanGraph,
} from "../src/domain/plan-graph.js";

// Each builder returns a structurally complete PlanTask; tests vary only the fields they exercise.
function task(
  localId: string,
  dependsOn: string[] = [],
  kind: PlanTask["kind"] = "work",
): PlanTask {
  return {
    localId,
    dependsOn,
    goal: `Goal of ${localId}`,
    description: "",
    priority: 0,
    kind,
    agent: "developer-block",
    requires: [],
    context: [],
    surface: { write: [], read: [] },
    budget: { maxCostMicros: 0, maxTokens: 1000, maxWallMs: 60000 },
    timeoutMs: 60000,
    maxAttempts: 1,
    acceptance: [],
  };
}

function plan(tasks: PlanTask[]): Plan {
  return { schemaVersion: 1, tasks };
}

const codesOf = (issues: readonly PlanGraphIssue[]): string[] => issues.map((i) => i.code);

describe("validatePlanGraph", () => {
  it("reports no issues for a valid acyclic plan", () => {
    const valid = plan([task("write"), task("test", ["write"]), task("release", ["test"])]);
    expect(validatePlanGraph(valid)).toEqual([]);
  });

  it("reports unknown_dependency for a dependency on a missing local id", () => {
    const issues = validatePlanGraph(plan([task("a"), task("b", ["ghost"])]));
    expect(issues).toEqual([expect.objectContaining({ code: "unknown_dependency", taskId: "b" })]);
    expect(issues[0]?.message).toContain("ghost");
  });

  it("reports duplicate_task_id once for each repeated local id", () => {
    const issues = validatePlanGraph(plan([task("a"), task("a"), task("a")]));
    expect(issues.filter((i) => i.code === "duplicate_task_id")).toEqual([
      expect.objectContaining({ code: "duplicate_task_id", taskId: "a" }),
    ]);
  });

  it("reports cycle with the path of the cycle", () => {
    const issues = validatePlanGraph(plan([task("a", ["b"]), task("b", ["a"])]));
    expect(issues).toEqual([expect.objectContaining({ code: "cycle", path: ["a", "b", "a"] })]);
    expect(issues[0]?.message).toContain("a -> b -> a");
  });

  it("reports a self-dependency as a cycle", () => {
    const issues = validatePlanGraph(plan([task("a", ["a"])]));
    expect(issues).toEqual([expect.objectContaining({ code: "cycle", path: ["a", "a"] })]);
  });

  it("reports too_many_tasks above the limit of 50 and accepts exactly 50", () => {
    expect(PLAN_LIMITS.maxTasksPerPlan).toBe(50);
    const fifty = Array.from({ length: 50 }, (_, i) => task(`t${i}`));
    const fiftyOne = Array.from({ length: 51 }, (_, i) => task(`t${i}`));
    expect(codesOf(validatePlanGraph(plan(fifty)))).toEqual([]);
    expect(codesOf(validatePlanGraph(plan(fiftyOne)))).toEqual(["too_many_tasks"]);
  });

  it("reports nested_plan_task for a task whose kind is plan", () => {
    const issues = validatePlanGraph(plan([task("a"), task("b", [], "plan")]));
    expect(issues).toEqual([expect.objectContaining({ code: "nested_plan_task", taskId: "b" })]);
  });

  // LD-T4: a planner agent runs only plan tasks, and a plan may not hold a plan task, so a plan may not hold a planner.
  it("reports nested_plan_task for a task that names a planner agent, once per task", () => {
    const planner = { ...task("p"), agent: "planner" };
    const fakePlanner = { ...task("f"), agent: "fake:plan" };
    const both = { ...task("both", [], "plan"), agent: "fake:plan" };
    const issues = validatePlanGraph(plan([task("a"), planner, fakePlanner, both]));
    expect(issues).toEqual([
      expect.objectContaining({ code: "nested_plan_task", taskId: "p" }),
      expect.objectContaining({ code: "nested_plan_task", taskId: "f" }),
      expect.objectContaining({ code: "nested_plan_task", taskId: "both" }),
    ]);
    expect(issues[0]?.message).toContain('planner agent "planner"');
  });

  // LD-T7c: the real analyst only reads; a task of it that lists files to write could never write them.
  it("reports read_only_agent_writes for an analyst task with a write surface, once per task", () => {
    const writes = {
      ...task("draft"),
      agent: "analyst",
      surface: { write: ["CONTRIBUTING.md"], read: [] },
    };
    const reads = {
      ...task("survey"),
      agent: "analyst",
      surface: { write: [], read: ["README.md"] },
    };
    const issues = validatePlanGraph(plan([reads, writes]));
    expect(issues).toEqual([
      expect.objectContaining({ code: "read_only_agent_writes", taskId: "draft" }),
    ]);
    expect(issues[0]?.message).toContain('"analyst"');
    expect(issues[0]?.message).toContain("CONTRIBUTING.md");
    expect(issues[0]?.message).toContain("result");
  });

  it("keeps the write surface of simulated and other agents", () => {
    const surface = { write: ["CONTRIBUTING.md"], read: [] };
    const fake = { ...task("fake"), agent: "fake:succeed", surface };
    const block = { ...task("block"), agent: "developer-block", surface };
    expect(validatePlanGraph(plan([fake, block]))).toEqual([]);
  });

  it("keeps reporting other codes when one rule fails", () => {
    const issues = validatePlanGraph(plan([task("a", ["ghost"], "plan"), task("a")]));
    expect(codesOf(issues).sort()).toEqual(
      ["duplicate_task_id", "nested_plan_task", "unknown_dependency"].sort(),
    );
  });
});

describe("topologicalOrder", () => {
  it("orders dependencies first and breaks ties by plan order", () => {
    const sample = plan([
      task("write"),
      task("test", ["write"]),
      task("docs"),
      task("release", ["test", "docs"]),
    ]);
    expect(topologicalOrder(sample)).toEqual(["write", "test", "docs", "release"]);
  });

  it("is deterministic across calls", () => {
    const sample = plan([task("b"), task("a"), task("c", ["a", "b"])]);
    expect(topologicalOrder(sample)).toEqual(topologicalOrder(sample));
    expect(topologicalOrder(sample)).toEqual(["b", "a", "c"]);
  });

  it("returns null for a cycle", () => {
    expect(topologicalOrder(plan([task("a", ["b"]), task("b", ["a"])]))).toBeNull();
  });

  it("returns null when a dependency is unknown", () => {
    expect(topologicalOrder(plan([task("a", ["ghost"])]))).toBeNull();
  });
});
