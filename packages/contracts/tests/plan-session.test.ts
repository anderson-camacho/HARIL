import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { PlanSchema, SessionSchema } from "../src/index.js";

const ULID_PROJECT = "01BX5ZZKBKACTAV9WEVGEMMVRZ";
const ULID_RUN = "01CZ7W0GKTQXGWP6E4G8D1YB3S";
const ULID_SESSION = "01DZ8W0HKTQXGWP6E4G8D1YB4T";

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

describe("PlanSchema", () => {
  it("accepts a valid plan with one task", () => {
    expect(Value.Check(PlanSchema, validPlan)).toBe(true);
  });

  it("accepts a plan task that declares a dependency on a local id", () => {
    const plan = {
      ...validPlan,
      tasks: [
        validPlanTask,
        { ...validPlanTask, localId: "tests", dependsOn: ["write-contracts"] },
      ],
    };
    expect(Value.Check(PlanSchema, plan)).toBe(true);
  });

  it("rejects an unknown top-level key", () => {
    expect(Value.Check(PlanSchema, { ...validPlan, projectId: ULID_PROJECT })).toBe(false);
  });

  it("rejects an unknown key inside a plan task", () => {
    const plan = { ...validPlan, tasks: [{ ...validPlanTask, state: "pending" }] };
    expect(Value.Check(PlanSchema, plan)).toBe(false);
  });

  it("rejects a plan without tasks", () => {
    expect(Value.Check(PlanSchema, { schemaVersion: 1 })).toBe(false);
  });

  it("rejects a plan task with an unknown kind", () => {
    const plan = { ...validPlan, tasks: [{ ...validPlanTask, kind: "magic" }] };
    expect(Value.Check(PlanSchema, plan)).toBe(false);
  });
});

describe("SessionSchema", () => {
  it("accepts a session bound to one run", () => {
    expect(Value.Check(SessionSchema, { sessionId: ULID_SESSION, runId: ULID_RUN })).toBe(true);
  });

  it("rejects an unknown key", () => {
    const session = { sessionId: ULID_SESSION, runId: ULID_RUN, agentPid: 42 };
    expect(Value.Check(SessionSchema, session)).toBe(false);
  });

  it("rejects a session without a run", () => {
    expect(Value.Check(SessionSchema, { sessionId: ULID_SESSION })).toBe(false);
  });

  it("rejects an id that is not a 26-character ULID", () => {
    expect(Value.Check(SessionSchema, { sessionId: "nope", runId: ULID_RUN })).toBe(false);
  });
});
