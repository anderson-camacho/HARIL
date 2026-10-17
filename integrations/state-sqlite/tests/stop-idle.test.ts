import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import {
  type ManualClock,
  makeTempDir,
  manualClock,
  removeTempDir,
  sequentialIds,
  testRules,
} from "./support.js";

// Parada ordenada and salida por ocio at the store (ARCH 4.2, 4.3): runtime.stop needs no project, a run cancelled
// by a shutdown is not charged, and the lease is released only when no command waits in the queue.
let dir: string;
let clock: ManualClock;

beforeEach(() => {
  dir = makeTempDir();
  clock = manualClock();
});

afterEach(() => {
  removeTempDir(dir);
});

function open(prefix = "id"): Store {
  return openStore({
    dataDir: dir,
    clock,
    ids: sequentialIds(prefix),
    rules: testRules,
    isPidAlive: () => true,
  });
}

function acquire(store: Store) {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: "v24.21.0",
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  return grant.value.epoch;
}

describe("runtime.stop (ARCH 4.3)", () => {
  it("is applied without a project and leaves the lease held", () => {
    const store = open();
    const epoch = acquire(store);
    store.commands.enqueue({
      type: "runtime.stop",
      args: {},
      idempotencyKey: "stop-1",
      requestHash: "stop-1",
    });

    const applied = store.commands.applyNext(epoch);
    expect(applied).toMatchObject({ type: "runtime.stop", outcome: "applied", taskIds: [] });
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "active" });
    store.close();
  });

  it("rejects arguments it does not take", () => {
    const store = open();
    const epoch = acquire(store);
    store.commands.enqueue({
      type: "runtime.stop",
      args: { now: true },
      idempotencyKey: "stop-2",
      requestHash: "stop-2",
    });

    expect(store.commands.applyNext(epoch)).toMatchObject({
      type: "runtime.stop",
      outcome: "rejected",
      reason: expect.stringContaining("runtime.stop"),
    });
    store.close();
  });
});

describe("idle release (ARCH 4.2: the queue is checked in the same transaction as the release)", () => {
  it("refuses to release while a command is queued, and releases once the queue is empty", () => {
    const store = open();
    const epoch = acquire(store);
    store.commands.enqueue({
      type: "runtime.stop",
      args: {},
      idempotencyKey: "late",
      requestHash: "late",
    });

    expect(store.runtime.releaseIfIdle(epoch)).toBe(false);
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "active" });

    store.commands.applyNext(epoch);
    expect(store.runtime.releaseIfIdle(epoch)).toBe(true);
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "released" });
    store.close();
  });
});

describe("cancelRun on a shutdown (ARCH 4.2 step 3)", () => {
  it("returns the task to ready as an orphan, charges no attempt and no infra restart, and closes the run as cancelled", () => {
    const store = open();
    const epoch = acquire(store);
    const projectId = store.projects.register({ slug: "p", name: "P", rootPath: dir }).projectId;
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: {
        goal: "Slow",
        dependsOn: [],
        agent: "fake:slow:60000",
        maxAttempts: 1,
        timeoutMs: 120_000,
      },
      idempotencyKey: "slow",
      requestHash: "slow",
    });
    store.commands.applyNext(epoch);
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimed");

    const returned = store.runs.cancel(claimed.runId, "shutdown");
    expect(returned).toMatchObject({
      taskState: "ready",
      retryReason: "orphaned",
      attemptsUsed: 0,
    });
    expect(store.tasks.get(claimed.taskId)).toMatchObject({
      state: "ready",
      retryReason: "orphaned",
      attemptsUsed: 0,
      infraRestarts: 0,
    });
    expect(store.metrics.snapshot().runsByStatus).toMatchObject({ cancelled: 1 });
    expect(store.metrics.snapshot().orphanedRecoveries).toBe(0);
    store.close();
  });
});
