import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { TaskSchema, TaskStateSchema } from "../src/index.js";

const ULID_TASK = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_PROJECT = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

const validTask = {
  schemaVersion: 1,
  taskId: ULID_TASK,
  projectId: ULID_PROJECT,
  goal: "Define the task contract",
  description: "Pure domain contract for a task",
  dependsOn: [],
  priority: 0,
  kind: "work",
  agent: "developer-block",
  requires: [],
  context: [],
  surface: { write: ["packages/contracts/**"], read: [] },
  budget: { maxCostMicros: 0, maxTokens: 1000, maxWallMs: 60000 },
  timeoutMs: 60000,
  maxAttempts: 1,
  state: "pending",
  evidence: [],
  acceptance: [],
};

const SEVEN_STATES = ["pending", "ready", "running", "blocked", "completed", "failed", "cancelled"];

describe("TaskStateSchema", () => {
  it.each(SEVEN_STATES)("accepts the state %s", (state) => {
    expect(Value.Check(TaskStateSchema, state)).toBe(true);
  });

  it.each(["done", "running_fast", "orphaned", "", "PENDING"])(
    "rejects the unknown state %j",
    (state) => {
      expect(Value.Check(TaskStateSchema, state)).toBe(false);
    },
  );
});

describe("TaskSchema", () => {
  it("accepts a valid pending task", () => {
    expect(Value.Check(TaskSchema, validTask)).toBe(true);
  });

  it("accepts optional phase, blockReason and retryReason when they are in their closed sets", () => {
    const running = { ...validTask, state: "running", phase: "executing" };
    const blocked = { ...validTask, state: "blocked", blockReason: "dep_failed" };
    const ready = { ...validTask, state: "ready", retryReason: "transient" };
    expect(Value.Check(TaskSchema, running)).toBe(true);
    expect(Value.Check(TaskSchema, blocked)).toBe(true);
    expect(Value.Check(TaskSchema, ready)).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(Value.Check(TaskSchema, { ...validTask, extra: true })).toBe(false);
  });

  it("rejects an unknown state", () => {
    expect(Value.Check(TaskSchema, { ...validTask, state: "archived" })).toBe(false);
  });

  it("rejects an unknown blockReason", () => {
    const task = { ...validTask, state: "blocked", blockReason: "whenever" };
    expect(Value.Check(TaskSchema, task)).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(Value.Check(TaskSchema, { ...validTask, kind: "magic" })).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { goal: _goal, ...withoutGoal } = validTask;
    expect(Value.Check(TaskSchema, withoutGoal)).toBe(false);
  });

  it("rejects maxAttempts below 1", () => {
    expect(Value.Check(TaskSchema, { ...validTask, maxAttempts: 0 })).toBe(false);
  });

  it("rejects a taskId that is not a 26-character ULID", () => {
    expect(Value.Check(TaskSchema, { ...validTask, taskId: "short" })).toBe(false);
  });
});
