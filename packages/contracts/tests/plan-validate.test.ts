import { describe, expect, it } from "vitest";
import { validatePlanSchema } from "../src/index.js";

const validPlanTask = {
  localId: "write-contracts",
  dependsOn: [],
  goal: "Write contracts",
  description: "Schemas for the domain",
  priority: 0,
  kind: "work",
  agent: "developer-block",
  requires: [],
  context: [],
  surface: { write: ["packages/contracts/**"], read: [] },
  budget: { maxCostMicros: 0, maxTokens: 1000, maxWallMs: 60000 },
  timeoutMs: 60000,
  maxAttempts: 1,
  acceptance: [],
};

const validPlan = {
  schemaVersion: 1,
  tasks: [validPlanTask],
};

describe("validatePlanSchema", () => {
  it("returns the typed plan when the value is a valid plan", () => {
    expect(validatePlanSchema(validPlan)).toEqual({ ok: true, plan: validPlan });
  });

  it("reports an invalid field as '<instance path>: <message>'", () => {
    const result = validatePlanSchema({
      ...validPlan,
      tasks: [{ ...validPlanTask, kind: "dance" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((error) => error.startsWith("/tasks/0/kind: "))).toBe(true);
  });

  it("reports an unknown top-level key", () => {
    const result = validatePlanSchema({ ...validPlan, projectId: "01BX5ZZKBKACTAV9WEVGEMMVRZ" });
    expect(result.ok).toBe(false);
  });

  it("reports a plan without tasks", () => {
    const result = validatePlanSchema({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a value that is not an object", () => {
    const result = validatePlanSchema(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
