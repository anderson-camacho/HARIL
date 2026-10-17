import { describe, expect, it } from "vitest";
import { checkPlanSubmission } from "../src/domain/index.js";

// plan.submit re-validation (M1-T5): schema, then graph rules, then the dependency order.
// The fixture mirrors examples/plan.valid.json; the core tests stay free of node:* builtins.
interface FixtureTask {
  localId: string;
  dependsOn: string[];
}

function validPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const task = (localId: string, dependsOn: string[], priority: number) => ({
    localId,
    dependsOn,
    goal: `Goal ${localId}`,
    description: "",
    priority,
    kind: "work",
    agent: "developer-block",
    requires: [],
    context: [],
    surface: { write: [], read: [] },
    budget: { maxCostMicros: 0, maxTokens: 20000, maxWallMs: 120000 },
    timeoutMs: 120000,
    maxAttempts: 2,
    acceptance: [],
  });
  return {
    schemaVersion: 1,
    tasks: [
      task("survey-readme", [], 0),
      task("draft-section", ["survey-readme"], 1),
      task("insert-section", ["draft-section"], 2),
      task("verify-readme", ["insert-section"], 3),
    ],
    ...overrides,
  };
}

describe("checkPlanSubmission", () => {
  it("accepts a valid plan and returns the tasks in dependency order", () => {
    const result = checkPlanSubmission(validPlan());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toEqual([
        "survey-readme",
        "draft-section",
        "insert-section",
        "verify-readme",
      ]);
    }
  });

  it("rejects a value that fails the schema with a reason", () => {
    const result = checkPlanSubmission({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tasks/);
  });

  // LD-T7c: the reason reaches the planner through haril_propose_plan, so it can propose again within its window.
  it("refuses an analyst task that writes, with the reason, and accepts the same plan on fake:succeed", () => {
    const withAgent = (agent: string) => {
      const plan = validPlan();
      const tasks = plan.tasks as Record<string, unknown>[];
      tasks[2] = { ...tasks[2], agent, surface: { write: ["README.md"], read: ["README.md"] } };
      return plan;
    };
    const refused = checkPlanSubmission(withAgent("analyst"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toContain('task "insert-section"');
      expect(refused.reason).toContain("read-only agent");
      expect(refused.reason).toContain("README.md");
    }
    expect(checkPlanSubmission(withAgent("fake:succeed")).ok).toBe(true);
  });

  it("rejects a dependency cycle and names the cycle in the reason", () => {
    const plan = validPlan();
    const tasks = plan.tasks as FixtureTask[];
    tasks[0] = { ...tasks[0], dependsOn: ["verify-readme"] } as FixtureTask;
    const result = checkPlanSubmission(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cycle/);
  });
});
