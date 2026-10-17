import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// commands.applyNext (M1-T5): the queue is applied in one transaction per command, with rejections recorded.
const EXAMPLE_VALID = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));
const EXAMPLE_CYCLE = fileURLToPath(new URL("../../../examples/plan.cycle.json", import.meta.url));

let store: Store;
let projectId: string;
let epoch: number;
let keySeq = 0;

beforeEach(() => {
  store = openMemoryStore({ clock: fixedClock(), ids: sequentialIds(), rules: testRules });
  projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: "D:/demo",
  }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.19.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
});

afterEach(() => {
  store.close();
});

function enqueueTask(goal: string, dependsOn: string[] = [], agent = "fake:succeed"): string {
  return store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn, agent, maxAttempts: 1, timeoutMs: 1000 },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  }).commandId;
}

function _taskPlan(tasks: Array<{ localId: string; dependsOn?: string[]; priority?: number }>) {
  return {
    schemaVersion: 1,
    tasks: tasks.map((task) => ({
      localId: task.localId,
      dependsOn: task.dependsOn ?? [],
      goal: `Goal ${task.localId}`,
      description: "",
      priority: task.priority ?? 5,
      kind: "work",
      agent: "fake:succeed",
      requires: [],
      context: [],
      surface: { write: [], read: [] },
      budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 1000 },
      timeoutMs: 1000,
      maxAttempts: 1,
      acceptance: [],
    })),
  };
}

function enqueuePlan(plan: unknown): string {
  return store.commands.enqueue({
    type: "plan.submit",
    projectId,
    args: { plan },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  }).commandId;
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

describe("commands.applyNext", () => {
  it("returns undefined when nothing is queued", () => {
    expect(store.commands.applyNext(epoch)).toBeUndefined();
  });

  it("applies task.create without dependencies as a ready task", () => {
    const commandId = enqueueTask("Write the docs");
    const applied = store.commands.applyNext(epoch);
    expect(applied).toMatchObject({ commandId, type: "task.create", outcome: "applied" });
    const [task] = store.tasks.list();
    expect(task).toMatchObject({ goal: "Write the docs", state: "ready" });
    expect(store.commands.listQueued()).toHaveLength(0);
    const types = store.events.list().map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["command.applied", "task.created"]));
  });

  it("creates a task with an existing dependency as pending", () => {
    enqueueTask("First");
    store.commands.applyNext(epoch);
    const [first] = store.tasks.list();
    enqueueTask("Second", [first?.taskId ?? ""]);
    store.commands.applyNext(epoch);
    const second = store.tasks.list().find((task) => task.goal === "Second");
    expect(second?.state).toBe("pending");
  });

  it("rejects task.create with an unknown dependency and creates nothing", () => {
    enqueueTask("Orphan", ["missing-task"]);
    const applied = store.commands.applyNext(epoch);
    expect(applied?.outcome).toBe("rejected");
    expect(applied?.reason).toMatch(/unknown/);
    expect(store.tasks.list()).toHaveLength(0);
    expect(store.events.list().map((event) => event.type)).toContain("command.rejected");
    expect(store.commands.listQueued()).toHaveLength(0);
  });

  it("applies plan.submit: the plan tasks are created, the root ones ready", () => {
    const commandId = enqueuePlan(JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")));
    const applied = store.commands.applyNext(epoch);
    expect(applied).toMatchObject({ commandId, type: "plan.submit", outcome: "applied" });
    expect(applied?.planId).toBeDefined();
    expect(applied?.taskIds).toHaveLength(4);
    const states = Object.fromEntries(store.tasks.list().map((task) => [task.goal, task.state]));
    expect(states).toEqual({
      "Survey the README structure": "ready",
      "Draft the new README section": "pending",
      "Insert the section into README.md": "pending",
      "Verify the README change": "pending",
    });
    expect(store.events.list().map((event) => event.type)).toEqual(
      expect.arrayContaining(["plan.submitted"]),
    );
  });

  it("applies plan.submit with a default model: every task of the plan gets it (LD-T7a)", () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: { plan: JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")), defaultModel: "e2e-model" },
      idempotencyKey: `k-${++keySeq}`,
      requestHash: `h-${keySeq}`,
    });
    expect(store.commands.applyNext(epoch)?.outcome).toBe("applied");
    const models = store.tasks.list().map((task) => store.tasks.get(task.taskId)?.model);
    expect(models).toEqual(["e2e-model", "e2e-model", "e2e-model", "e2e-model"]);
    const submitted = store.events.list().find((event) => event.type === "plan.submitted");
    expect(submitted?.payload).toMatchObject({ taskCount: 4, defaultModel: "e2e-model" });
  });

  it("applies plan.submit without a default model: the tasks name no model", () => {
    enqueuePlan(JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")));
    store.commands.applyNext(epoch);
    const models = store.tasks.list().map((task) => store.tasks.get(task.taskId)?.model);
    expect(models).toEqual([null, null, null, null]);
    const submitted = store.events.list().find((event) => event.type === "plan.submitted");
    expect(submitted?.payload).not.toHaveProperty("defaultModel");
  });

  it.each([
    ["a blank string", "  "],
    ["a number", 7],
  ])(
    "rejects plan.submit whose default model is %s, and creates nothing",
    (_name, defaultModel) => {
      store.commands.enqueue({
        type: "plan.submit",
        projectId,
        args: { plan: JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")), defaultModel },
        idempotencyKey: `k-${++keySeq}`,
        requestHash: `h-${keySeq}`,
      });
      const applied = store.commands.applyNext(epoch);
      expect(applied?.outcome).toBe("rejected");
      expect(applied?.reason).toBe("defaultModel must be a non-empty model id");
      expect(store.tasks.list()).toHaveLength(0);
    },
  );

  it("[INV-05] re-validates a plan with a cycle, rejects it and creates nothing", () => {
    enqueuePlan(JSON.parse(readFileSync(EXAMPLE_CYCLE, "utf8")));
    const applied = store.commands.applyNext(epoch);
    expect(applied?.outcome).toBe("rejected");
    expect(applied?.reason).toMatch(/cycle/);
    expect(store.tasks.list()).toHaveLength(0);
  });

  it("applies the oldest queued command first", () => {
    const first = enqueueTask("One");
    const second = enqueueTask("Two");
    expect(store.commands.applyNext(epoch)?.commandId).toBe(first);
    expect(store.commands.applyNext(epoch)?.commandId).toBe(second);
  });

  it("[INV-07] is fenced when the epoch is no longer the active lease", () => {
    enqueueTask("Never applied");
    const error = caught(() => store.commands.applyNext(epoch + 99));
    expect(error.code).toBe("store.fenced");
    expect(store.commands.listQueued()).toHaveLength(1);
  });
});
