import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, openStore, type StoreError } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// tasks.promote, tasks.claimNext and runs.complete (M1-T5).
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

function enqueueTask(goal: string, dependsOn: string[] = [], maxAttempts = 1): void {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn, agent: "fake:succeed", maxAttempts, timeoutMs: 1000 },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  store.commands.applyNext(epoch);
}

function taskId(goal: string): string {
  const task = store.tasks.list().find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task.taskId;
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

describe("tasks.promote", () => {
  it("moves a pending task to ready once its dependency has completed", () => {
    enqueueTask("A");
    enqueueTask("B", [taskId("A")]);
    const claimed = store.tasks.claimNext(epoch);
    store.runs.complete({
      runId: claimed?.runId ?? "",
      outcome: "succeeded",
      result: { summary: "ok" },
    });
    expect(store.tasks.promote()).toEqual({
      ready: [{ taskId: taskId("B"), goal: "B" }],
      blocked: [],
    });
    expect(store.tasks.get(taskId("B"))?.state).toBe("ready");
  });

  it("blocks a pending task whose dependency failed, with block reason dep_failed", () => {
    enqueueTask("A");
    enqueueTask("B", [taskId("A")]);
    const claimed = store.tasks.claimNext(epoch);
    store.runs.complete({
      runId: claimed?.runId ?? "",
      outcome: "failed",
      error: { code: "fake.failed", message: "boom" },
      endCause: "exit",
    });
    expect(store.tasks.promote().blocked).toEqual([{ taskId: taskId("B"), goal: "B" }]);
    expect(store.tasks.get(taskId("B"))).toMatchObject({
      state: "blocked",
      blockReason: "dep_failed",
    });
    expect(store.events.list().map((event) => event.type)).toContain("task.blocked");
  });

  it("propagates dep_failed transitively to every dependent (M1 fix b)", () => {
    enqueueTask("A");
    enqueueTask("B", [taskId("A")]);
    enqueueTask("C", [taskId("B")]);
    const claimed = store.tasks.claimNext(epoch);
    store.runs.complete({
      runId: claimed?.runId ?? "",
      outcome: "failed",
      error: { code: "x", message: "y" },
      endCause: "exit",
    });
    store.tasks.promote();
    expect(store.tasks.get(taskId("B"))?.state).toBe("blocked");
    expect(store.tasks.get(taskId("C"))).toMatchObject({
      state: "blocked",
      blockReason: "dep_failed",
    });
  });
});

describe("tasks.claimNext", () => {
  it("returns undefined when no task is ready", () => {
    expect(store.tasks.claimNext(epoch)).toBeUndefined();
  });

  it("claims the highest priority ready task, then the oldest", () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: {
        plan: {
          schemaVersion: 1,
          tasks: [planTask("low", 1), planTask("high-first", 5), planTask("high-second", 5)],
        },
      },
      idempotencyKey: "plan-1",
      requestHash: "plan-1",
    });
    store.commands.applyNext(epoch);
    expect(store.tasks.claimNext(epoch)?.goal).toBe("Goal high-first");
    expect(store.tasks.claimNext(epoch)?.goal).toBe("Goal high-second");
    expect(store.tasks.claimNext(epoch)?.goal).toBe("Goal low");
  });

  it("moves the task to running, counts the attempt and records the claim", () => {
    enqueueTask("A", [], 2);
    const claimed = store.tasks.claimNext(epoch);
    expect(claimed).toMatchObject({
      goal: "A",
      attempt: 1,
      maxAttempts: 2,
      attemptsUsed: 0,
      runtimeEpoch: epoch,
    });
    expect(claimed?.claimEpoch).toBe(1);
    expect(store.tasks.get(taskId("A"))).toMatchObject({
      state: "running",
      attempt: 1,
      claimEpoch: 1,
    });
    expect(store.events.list().map((event) => event.type)).toContain("task.claimed");
  });

  it("is atomic across connections: two stores never claim the same task", () => {
    const dir = mkdtempSync(join(tmpdir(), "haril-claim-"));
    try {
      const first = openStore({
        dataDir: dir,
        clock: fixedClock(),
        ids: sequentialIds("a"),
        rules: testRules,
      });
      const second = openStore({
        dataDir: dir,
        clock: fixedClock(),
        ids: sequentialIds("b"),
        rules: testRules,
      });
      const project = first.projects.register({ slug: "demo", name: "Demo", rootPath: "D:/demo" });
      const grant = first.runtime.acquire({
        pid: 1,
        nodeVersion: "v24.19.0",
        sqliteVersion: "3.53.3",
        ttlMs: 60_000,
      });
      if (!grant.ok) throw new Error("lease not granted");
      for (const goal of ["X", "Y"]) {
        first.commands.enqueue({
          type: "task.create",
          projectId: project.projectId,
          args: { goal, dependsOn: [], agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
          idempotencyKey: `key-${goal}`,
          requestHash: `hash-${goal}`,
        });
        first.commands.applyNext(grant.value.epoch);
      }
      const a = first.tasks.claimNext(grant.value.epoch);
      const b = second.tasks.claimNext(grant.value.epoch);
      const none = second.tasks.claimNext(grant.value.epoch);
      expect(a?.taskId).not.toBe(b?.taskId);
      expect(none).toBeUndefined();
      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runs.complete", () => {
  it("persists the result before the task becomes completed", () => {
    enqueueTask("A");
    const claimed = store.tasks.claimNext(epoch);
    const result = store.runs.complete({
      runId: claimed?.runId ?? "",
      outcome: "succeeded",
      result: { summary: "fake agent succeeded" },
    });
    expect(result).toMatchObject({ taskState: "completed", attemptsUsed: 0 });
    expect(store.tasks.get(taskId("A"))).toMatchObject({
      state: "completed",
      result: { summary: "fake agent succeeded" },
    });
    expect(store.events.list().map((event) => event.type)).toContain("task.completed");
  });

  it("returns a failed attempt to ready as a transient retry while attempts remain", () => {
    enqueueTask("A", [], 2);
    const first = store.tasks.claimNext(epoch);
    const result = store.runs.complete({
      runId: first?.runId ?? "",
      outcome: "failed",
      error: { code: "fake.failed", message: "boom" },
      endCause: "exit",
    });
    expect(result).toMatchObject({ taskState: "ready", attemptsUsed: 1, retryReason: "transient" });
    expect(store.tasks.get(taskId("A"))).toMatchObject({
      state: "ready",
      retryReason: "transient",
      attemptsUsed: 1,
    });
    expect(store.events.list().map((event) => event.type)).toContain("task.retried");
  });

  it("fails the task when the last attempt fails", () => {
    enqueueTask("A", [], 2);
    const first = store.tasks.claimNext(epoch);
    store.runs.complete({
      runId: first?.runId ?? "",
      outcome: "failed",
      error: { code: "fake.failed", message: "boom" },
      endCause: "exit",
    });
    const second = store.tasks.claimNext(epoch);
    expect(second?.attempt).toBe(2);
    const result = store.runs.complete({
      runId: second?.runId ?? "",
      outcome: "failed",
      error: { code: "fake.failed", message: "boom" },
      endCause: "exit",
    });
    expect(result).toMatchObject({ taskState: "failed", attemptsUsed: 2 });
    expect(store.tasks.get(taskId("A"))?.state).toBe("failed");
    expect(store.events.list().map((event) => event.type)).toContain("task.failed");
  });

  it("refuses to complete a run that is no longer the current claim with store.stale", () => {
    enqueueTask("A");
    const claimed = store.tasks.claimNext(epoch);
    const outcome = { runId: claimed?.runId ?? "", outcome: "succeeded" as const, result: {} };
    store.runs.complete(outcome);
    expect(caught(() => store.runs.complete(outcome)).code).toBe("store.stale");
  });
});

function planTask(localId: string, priority: number) {
  return {
    localId,
    dependsOn: [],
    goal: `Goal ${localId}`,
    description: "",
    priority,
    kind: "work",
    agent: "fake:succeed",
    requires: [],
    context: [],
    surface: { write: [], read: [] },
    budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 1000 },
    timeoutMs: 1000,
    maxAttempts: 1,
    acceptance: [],
  };
}
