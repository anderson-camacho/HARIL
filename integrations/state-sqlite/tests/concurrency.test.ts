import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type StoreError } from "../src/index.js";
import { type ChildRun, startChild } from "./crash/child-process.js";
import { makeTempDir, removeTempDir, testRules } from "./support.js";

// Deviation, INV-02 (two independent tasks running at the same time): not tested here. The MVP runtime runs one task at
// a time by design (apps/haril/src/runtime/run-loop.ts, M1-D6: concurrency 1); concurrent executors are M4 (docs/MVP.md
// section 7). A test would only restate the sequential loop, so the invariant is deferred with that reason in
// tests/INVARIANTS.md.
//
// Several real processes against one store file (TEST_STRATEGY 6: INV-01, INV-03, INV-15). The runtime's lease is
// held by the parent test; the children claim, reserve or enqueue with that epoch, as the runtime and the CLI do.
// Every child is a fresh Node process, so the locks, the busy timeout and the transactions are the real ones.
// The parent uses the real clock: the lease expiry is compared with the children's clocks, so both must share a time.
const SUITE_OPTIONS = { timeout: 60_000 };
const LEASE_TTL_MS = 30_000;
let dir = "";
const dbPath = () => join(dir, "haril.db");
const children: ChildRun[] = [];
const stores: Store[] = [];

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.child.kill("SIGKILL");
    await child.exited;
  }
  for (const store of stores.splice(0)) store.close();
  removeTempDir(dir);
});

function openAt(): Store {
  const store = openStore({
    dataDir: dir,
    clock: { now: () => Date.now(), schedule: () => () => undefined },
    ids: { next: () => randomUUID() },
    rules: testRules,
  });
  stores.push(store);
  return store;
}

function acquire(store: Store): number {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: LEASE_TTL_MS,
  });
  if (!grant.ok) throw new Error(`lease refused: ${grant.error.message}`);
  return grant.value.epoch;
}

function projectOf(store: Store): string {
  return store.projects.register({ slug: "demo", name: "Demo", rootPath: "D:/demo" }).projectId;
}

function enqueueTasks(store: Store, projectId: string, count: number): void {
  for (let n = 0; n < count; n += 1) {
    const key = randomUUID();
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: {
        goal: `goal ${n}`,
        dependsOn: [],
        agent: "fake:succeed",
        maxAttempts: 1,
        timeoutMs: 1000,
      },
      idempotencyKey: key,
      requestHash: key,
    });
  }
}

// Applies every queued command with the lease epoch, as the runtime does; returns how many were applied.
function applyAll(store: Store, epoch: number): number {
  let applied = 0;
  for (
    let next = store.commands.applyNext(epoch);
    next !== undefined;
    next = store.commands.applyNext(epoch)
  ) {
    expect(next.outcome).toBe("applied");
    applied += 1;
  }
  return applied;
}

// Waits for a child; a non-zero exit fails with the child's stderr in the message.
async function expectCleanExit(child: ChildRun): Promise<void> {
  const code = await child.exited;
  expect({ code, stderr: child.stderr() }).toEqual({ code: 0, stderr: "" });
}

describe("multi-process invariants", SUITE_OPTIONS, () => {
  it("[INV-01] eight claimers and one admin writer: every ready task is claimed exactly once", async () => {
    const store = openAt();
    const projectId = projectOf(store);
    const epoch = acquire(store);
    const TASKS = 40;
    const ADMIN_WRITES = 40;
    enqueueTasks(store, projectId, TASKS);
    expect(applyAll(store, epoch)).toBe(TASKS);

    const claimers = Array.from({ length: 8 }, () =>
      startChild("claimer.mjs", [dir, String(epoch)]),
    );
    const admin = startChild("admin.mjs", [dir, projectId, String(ADMIN_WRITES)]);
    children.push(...claimers, admin);
    await Promise.all([...claimers, admin].map(expectCleanExit));

    // The admin writes all landed in the queue while the claimers ran; the runtime applies them afterwards.
    expect(store.commands.listQueued()).toHaveLength(ADMIN_WRITES);
    expect(applyAll(store, epoch)).toBe(ADMIN_WRITES);

    const byChildren = claimers.flatMap((claimer) =>
      claimer.lines.filter((line) => line !== "done"),
    );
    const byParent: string[] = [];
    for (
      let claimed = store.tasks.claimNext(epoch);
      claimed !== undefined;
      claimed = store.tasks.claimNext(epoch)
    ) {
      byParent.push(claimed.taskId);
    }

    const claimed = [...byChildren, ...byParent];
    expect(claimed).toHaveLength(TASKS + ADMIN_WRITES);
    expect(new Set(claimed).size).toBe(TASKS + ADMIN_WRITES);
    expect(store.tasks.list({ projectId }).filter((task) => task.state === "ready")).toEqual([]);
    for (const taskId of claimed) {
      expect(store.tasks.get(taskId)).toMatchObject({ state: "running", attempt: 1 });
    }
    store.runtime.release(epoch, true);
  });

  it("[INV-03] six processes reserving against one budget: the hard limit holds and every refusal names it", async () => {
    const store = openAt();
    const projectId = projectOf(store);
    const epoch = acquire(store);
    enqueueTasks(store, projectId, 1);
    applyAll(store, epoch);
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimed");
    const HARD_LIMIT = 1000;
    const AMOUNT = 50;
    const PER_PROCESS = 30;
    const budgetId = store.budgets.ensure({
      scopeType: "project",
      scopeId: projectId,
      projectId,
      hardLimit: HARD_LIMIT,
    }).budgetId;

    const reservers = Array.from({ length: 6 }, (_, index) =>
      startChild("reserver.mjs", [
        dir,
        budgetId,
        claimed.runId,
        claimed.taskId,
        `p${index}`,
        String(PER_PROCESS),
        String(AMOUNT),
      ]),
    );
    children.push(...reservers);
    await Promise.all(reservers.map(expectCleanExit));

    const outcomes = reservers.flatMap((reserver) =>
      reserver.lines.filter((line) => line !== "done"),
    );
    const held = outcomes.filter((line) => line === "ok").length;
    const refused = outcomes.filter((line) => line !== "ok");
    expect(outcomes).toHaveLength(6 * PER_PROCESS);
    // Exactly what fits: 1000 / 50 reservations held; the other ones were refused as insufficient for this budget.
    expect(held).toBe(HARD_LIMIT / AMOUNT);
    expect(refused).toHaveLength(6 * PER_PROCESS - held);
    for (const line of refused) expect(line).toBe(`refused insufficient ${budgetId}`);

    const budget = store.budgets.get(budgetId);
    expect(budget).toMatchObject({ spent: 0, reserved: HARD_LIMIT, overrun: 0 });
    // The ledger sums to what the budget row shows: the reserve entries are exactly the reservations that held.
    const connection = new DatabaseSync(dbPath());
    try {
      const row = connection
        .prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM budget_ledger WHERE budget_id = ? AND kind = 'reserve'",
        )
        .get(budgetId) as { total: number; n: number };
      expect(row).toEqual({ total: HARD_LIMIT, n: held });
    } finally {
      connection.close();
    }
    store.runtime.release(epoch, true);
  });

  it("[INV-15] a runtime whose clock is ten minutes fast takes over a live lease, and the stale one is fenced", async () => {
    const store = openAt();
    const projectId = projectOf(store);
    const staleEpoch = acquire(store);
    const TASKS = 12;
    // Clock offsets are ten minutes, far larger than the 30 s lease, so each offset decides the expiry check alone.
    enqueueTasks(store, projectId, TASKS);
    applyAll(store, staleEpoch);
    // Three attempts are in flight under the stale epoch when another runtime asks for the lease.
    for (let n = 0; n < 3; n += 1) {
      expect(store.tasks.claimNext(staleEpoch)).toBeDefined();
    }

    // A clock ten minutes behind sees the holder's lease as unexpired, and the holder pid is alive: refused.
    const behind = startChild("contender.mjs", [dir, String(-10 * 60_000), "3"]);
    children.push(behind);
    await expectCleanExit(behind);
    expect(behind.lines).toEqual([`busy ${process.pid}`]);

    // A clock ten minutes ahead sees the same lease as expired. The expiry check decides before the pid check
    // (runtime-reconcile.test.ts), so this runtime takes over the live holder. The holder must then be fenced.
    const ahead = startChild("contender.mjs", [dir, String(10 * 60_000), "3"]);
    children.push(ahead);
    await expectCleanExit(ahead);
    expect(ahead.lines).toContain("reconciled 3");
    const acquired = ahead.lines.find((line) => line.startsWith("acquired "));
    const newEpoch = Number(acquired?.split(" ")[1]);
    expect(newEpoch).toBeGreaterThan(staleEpoch);

    // Never two active leases, and the stale epoch can no longer claim.
    const connection = new DatabaseSync(dbPath());
    try {
      const active = connection
        .prepare("SELECT runtime_epoch AS epoch FROM runtime_leases WHERE status = 'active'")
        .all() as { epoch: number }[];
      expect(active).toEqual([{ epoch: newEpoch }]);
    } finally {
      connection.close();
    }
    let staleOutcome = "claimed";
    try {
      store.tasks.claimNext(staleEpoch);
    } catch (error) {
      staleOutcome = (error as StoreError).code;
    }
    expect(staleOutcome).toBe("store.fenced");

    // No double claim: every task has at most one running attempt, and the new holder ended with all of them.
    const readers = new DatabaseSync(dbPath());
    try {
      const duplicates = readers
        .prepare(
          "SELECT task_id FROM runs WHERE status = 'running' GROUP BY task_id HAVING COUNT(*) > 1",
        )
        .all();
      expect(duplicates).toEqual([]);
      const running = readers
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'")
        .get() as {
        n: number;
      };
      expect(running.n).toBe(TASKS);
    } finally {
      readers.close();
    }
  });
});
