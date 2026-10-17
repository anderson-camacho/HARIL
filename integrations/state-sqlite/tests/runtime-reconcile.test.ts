import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, openStore } from "../src/index.js";
import {
  type ManualClock,
  makeTempDir,
  manualClock,
  removeTempDir,
  sequentialIds,
  testRules,
} from "./support.js";

// Runtime takeover by liveness (M1 fix c) and reconciliation of orphaned attempts (M1 fix d, M1-T7).
const TTL = 1000;
const MAX_INFRA_RESTARTS = 3;
let dir: string;

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function grant(store: Store, pid: number, ttlMs = TTL) {
  return store.runtime.acquire({ pid, nodeVersion: "v24.19.0", sqliteVersion: "3.53.3", ttlMs });
}

// Each open of the file store gets its own identifier prefix, so reopened runtimes never collide.
function openFile(clock: ManualClock, isPidAlive: (pid: number) => boolean, generation: number) {
  return openStore({
    dataDir: dir,
    clock,
    ids: sequentialIds(`g${generation}`),
    rules: testRules,
    isPidAlive,
  });
}

function enqueue(store: Store, projectId: string, goal: string, maxAttempts = 1): string {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn: [], agent: "fake:succeed", maxAttempts, timeoutMs: 1000 },
    idempotencyKey: `k-${goal}`,
    requestHash: `h-${goal}`,
  });
  store.commands.applyNext(1);
  const task = store.tasks.list().find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task.taskId;
}

describe("runtime takeover by liveness (M1 fix c)", () => {
  it("takes over an unexpired lease whose pid is dead", () => {
    const store = openMemoryStore({
      clock: manualClock(),
      ids: sequentialIds(),
      rules: testRules,
      isPidAlive: () => false,
    });
    expect(grant(store, 100).ok).toBe(true);
    const next = grant(store, 200);
    expect(next.ok && next.value.epoch).toBe(2);
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "active", pid: 200 });
    store.close();
  });

  it("stays busy while the holder is alive and the lease has not expired", () => {
    const store = openMemoryStore({
      clock: manualClock(),
      ids: sequentialIds(),
      rules: testRules,
      isPidAlive: () => true,
    });
    grant(store, 100);
    expect(grant(store, 200).ok).toBe(false);
    store.close();
  });

  it("[INV-15] takes over an expired lease even when its pid is still alive", () => {
    const clock = manualClock();
    const store = openMemoryStore({
      clock,
      ids: sequentialIds(),
      rules: testRules,
      isPidAlive: () => true,
    });
    grant(store, 100);
    clock.advance(TTL + 1);
    const next = grant(store, 200);
    expect(next.ok && next.value.epoch).toBe(2);
    store.close();
  });
});

describe("reconciliation of orphaned attempts (M1 fix d)", () => {
  it("[INV-06] returns a task left running by a crashed runtime to ready, without charging an attempt", () => {
    const clock = manualClock();
    const crashed = openFile(clock, () => true, 1);
    const project = crashed.projects.register({ slug: "demo", name: "Demo", rootPath: dir });
    expect(grant(crashed, 100).ok).toBe(true);
    const taskId = enqueue(crashed, project.projectId, "A");
    const claimed = crashed.tasks.claimNext(1);
    expect(claimed?.taskId).toBe(taskId);
    crashed.close(); // kill -9: the lease is never released

    const next = openFile(clock, () => false, 2);
    const takeover = grant(next, 200);
    if (!takeover.ok) throw new Error("takeover refused");
    const recovered = next.runtime.reconcile(takeover.value.epoch, MAX_INFRA_RESTARTS);

    expect(recovered).toEqual([
      {
        taskId,
        goal: "A",
        runId: claimed?.runId,
        outcome: "ready",
        infraRestarts: 1,
        maxInfraRestarts: MAX_INFRA_RESTARTS,
      },
    ]);
    expect(next.tasks.get(taskId)).toMatchObject({
      state: "ready",
      retryReason: "orphaned",
      attempt: 1,
      attemptsUsed: 0,
      infraRestarts: 1,
    });
    expect(next.metrics.snapshot().runsByStatus.orphaned).toBe(1);
    expect(next.events.list({ taskId }).map((event) => event.type)).toContain("task.orphaned");

    const again = next.tasks.claimNext(takeover.value.epoch);
    expect(again).toMatchObject({ taskId, attempt: 2 });
    next.runs.complete({
      runId: again?.runId ?? "",
      outcome: "succeeded",
      result: { summary: "done" },
    });
    expect(next.tasks.get(taskId)).toMatchObject({ state: "completed" });
    next.close();
  });

  it("leaves a task of the current epoch alone", () => {
    const store = openMemoryStore({
      clock: manualClock(),
      ids: sequentialIds(),
      rules: testRules,
      isPidAlive: () => true,
    });
    const project = store.projects.register({ slug: "demo", name: "Demo", rootPath: dir });
    const grantResult = grant(store, 100);
    if (!grantResult.ok) throw new Error("lease refused");
    enqueue(store, project.projectId, "A");
    store.tasks.claimNext(grantResult.value.epoch);
    expect(store.runtime.reconcile(grantResult.value.epoch, MAX_INFRA_RESTARTS)).toEqual([]);
    store.close();
  });

  it("[INV-06] fails the task on the fourth orphaning, with reason infra_restarts_exhausted", () => {
    const clock = manualClock();
    const first = openFile(clock, () => false, 1);
    const project = first.projects.register({ slug: "demo", name: "Demo", rootPath: dir });
    expect(grant(first, 100).ok).toBe(true);
    const taskId = enqueue(first, project.projectId, "A");
    first.tasks.claimNext(1);
    first.close();

    // Epochs 2 to 5 each take over a dead runtime, reconcile, and (except the last) claim again and crash.
    for (let generation = 2; generation <= 5; generation++) {
      const store = openFile(clock, () => false, generation);
      const acquired = grant(store, 100 + generation);
      if (!acquired.ok) throw new Error("takeover refused");
      const recovered = store.runtime.reconcile(acquired.value.epoch, MAX_INFRA_RESTARTS);
      if (generation < 5) {
        expect(recovered).toMatchObject([
          { taskId, outcome: "ready", infraRestarts: generation - 1 },
        ]);
        store.tasks.claimNext(acquired.value.epoch);
        store.close();
      } else {
        expect(recovered).toMatchObject([{ taskId, outcome: "failed", infraRestarts: 4 }]);
        expect(store.tasks.get(taskId)).toMatchObject({ state: "failed", attemptsUsed: 0 });
        expect(store.events.list({ taskId }).map((event) => event.type)).toContain("task.failed");
        store.close();
      }
    }
  });
});

// Authority of an orphaned run (ARCH 13.2 CP1 and CP4): its virtual keys are revoked and its open budget
// reservations are settled exactly once. Both happen in the reconciliation transaction.
describe("reconciliation of an orphaned run's authority (CP1, CP4)", () => {
  it("[CP1] revokes the virtual keys of an orphaned run and returns the task to ready", () => {
    const clock = manualClock();
    const crashed = openFile(clock, () => true, 1);
    const project = crashed.projects.register({ slug: "demo", name: "Demo", rootPath: dir });
    expect(grant(crashed, 100).ok).toBe(true);
    const taskId = enqueue(crashed, project.projectId, "A");
    const claimed = crashed.tasks.claimNext(1);
    const budgetId = crashed.budgets.ensure({
      scopeType: "project",
      scopeId: project.projectId,
      projectId: project.projectId,
      hardLimit: 1000,
    }).budgetId;
    crashed.virtualKeys.issue({
      runId: claimed?.runId ?? "",
      keyHash: "hash-cp1",
      routeGrant: { providerId: "p" },
      budgetIds: [budgetId],
      expiresAt: clock.now() + 60_000,
    });
    crashed.close(); // CP1: the key row exists, no effect intent was recorded

    const next = openFile(clock, () => false, 2);
    const takeover = grant(next, 200);
    if (!takeover.ok) throw new Error("takeover refused");
    next.runtime.reconcile(takeover.value.epoch, MAX_INFRA_RESTARTS);

    expect(next.virtualKeys.findActiveByHash("hash-cp1")).toBeUndefined();
    expect(next.virtualKeys.revoke(claimed?.runId ?? "", "again")).toBe(0);
    expect(next.tasks.get(taskId)).toMatchObject({ state: "ready", attemptsUsed: 0 });
    next.close();
  });

  it("[CP4] settles an open reservation of an orphaned run at its upper bound, exactly once", () => {
    const clock = manualClock();
    const crashed = openFile(clock, () => true, 1);
    const project = crashed.projects.register({ slug: "demo", name: "Demo", rootPath: dir });
    expect(grant(crashed, 100).ok).toBe(true);
    enqueue(crashed, project.projectId, "A");
    const claimed = crashed.tasks.claimNext(1);
    const budgetId = crashed.budgets.ensure({
      scopeType: "project",
      scopeId: project.projectId,
      projectId: project.projectId,
      hardLimit: 1000,
    }).budgetId;
    const reservation = crashed.budgets.reserve({
      budgetIds: [budgetId],
      amount: 300,
      idempotencyKey: "cp4-reserve",
      runId: claimed?.runId ?? "",
      taskId: claimed?.taskId ?? "",
      routeId: "route-paid",
    });
    expect(reservation.ok).toBe(true);
    crashed.close(); // CP4: mid-turn, the reservation is open and no usage was reported

    const next = openFile(clock, () => false, 2);
    const takeover = grant(next, 200);
    if (!takeover.ok) throw new Error("takeover refused");
    next.runtime.reconcile(takeover.value.epoch, MAX_INFRA_RESTARTS);

    // Route cost kind is not in the ledger, so the reservation is charged at its upper bound, unreconciled.
    expect(next.budgets.get(budgetId)).toMatchObject({ spent: 300, reserved: 0 });
    expect(next.budgets.usageSummary({ projectId: project.projectId })).toMatchObject({
      settled: 1,
      unreconciled: 1,
    });

    // A second reconciliation finds nothing open: the totals and the ledger do not move.
    expect(next.runtime.reconcile(takeover.value.epoch, MAX_INFRA_RESTARTS)).toEqual([]);
    expect(next.budgets.get(budgetId)).toMatchObject({ spent: 300, reserved: 0 });
    expect(next.budgets.usageSummary({ projectId: project.projectId })?.settled).toBe(1);
    expect(next.budgets.release(reservation.ok ? reservation.reservationId : "")).toBe(
      "already_settled",
    );
    next.close();
  });
});
