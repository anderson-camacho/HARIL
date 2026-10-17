import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  MAX_INFRA_RESTARTS,
  type RunEvent,
} from "@haril/core";
import type { Clock, Ids, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUntilIdle } from "../../src/runtime/run-loop.js";

// Crash points of the runtime (ARCH 13.2, TEST_STRATEGY 4.4), exercised with a real process that dies hard.
// Covered (MC-T2, criterion 10 of the MVP): CP1, CP3, CP4 and CP8.
// Deferred (MC-D1): CP2, CP5 and CP6 need an effects table and the write-effects milestone. The only real agent
// of the MVP is read-only, so there is no effect to inspect, confirm or revert.
// The children are in ./child.mjs. Each one kills itself with SIGKILL and leaves a marker file first, so these
// tests can tell a crash at the right point from a child that failed to load.

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "child.mjs");
// The loader is shared with the store's multi-process tests (integrations/state-sqlite/tests/crash/register.mjs).
const REGISTER = pathToFileURL(
  join(
    HERE,
    "..",
    "..",
    "..",
    "..",
    "integrations",
    "state-sqlite",
    "tests",
    "crash",
    "register.mjs",
  ),
).href;
const KEY_HASH = "crash-key";
const rules = { canTransition, checkPlan: checkPlanSubmission, checkAcceptance, canonicalJson };
const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
// A child starts Node, loads the workspace sources and runs to its crash point: well past the 5 s default under
// the full suite, which runs every file in parallel.
const CRASH_OPTIONS = { timeout: 60_000 };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "haril-crash-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Runs a child to its crash point and reports whether it reached the point and died abnormally.
function crashAt(point: "cp1" | "cp3" | "cp4" | "cp8"): {
  reached: boolean;
  abnormal: boolean;
  stderr: string;
} {
  const child = spawnSync(process.execPath, ["--import", REGISTER, CHILD, dir, point], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    reached: existsSync(join(dir, `reached-${point}`)),
    abnormal: child.status !== 0 || child.signal !== null,
    stderr: child.stderr,
  };
}

// Reopens the store as the runtime does after a crash: the dead pid's lease is taken over at once.
function reopenAfterCrash(): Store {
  return openStore({
    dataDir: dir,
    clock,
    ids: { next: () => randomUUID() } satisfies Ids,
    rules,
    isPidAlive: () => false,
  });
}

// The runtime's start-up recovery: take the lease, then reconcile orphaned attempts.
function takeOverAndReconcile(store: Store) {
  const grant = store.runtime.acquire({
    pid: 4242,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("takeover refused");
  return store.runtime.reconcile(grant.value.epoch, MAX_INFRA_RESTARTS);
}

describe(
  "[CP1] killed after the claim and the key row, before any effect intent",
  CRASH_OPTIONS,
  () => {
    it("[INV-06] returns the task to ready without charging an attempt, and revokes the run's key", () => {
      expect(crashAt("cp1")).toMatchObject({ reached: true, abnormal: true });
      const store = reopenAfterCrash();
      const recovered = takeOverAndReconcile(store);
      expect(recovered).toMatchObject([{ outcome: "ready", infraRestarts: 1 }]);
      const taskId = recovered[0]?.taskId ?? "";
      expect(store.tasks.get(taskId)).toMatchObject({
        state: "ready",
        attemptsUsed: 0,
        retryReason: "orphaned",
      });
      expect(store.virtualKeys.findActiveByHash(KEY_HASH)).toBeUndefined();
      store.close();
    });
  },
);

describe("[CP3] killed when the agent starts, before it confirms", CRASH_OPTIONS, () => {
  it("[INV-06] orphans the run, adds one infra restart, and the same runtime completes the task", async () => {
    expect(crashAt("cp3")).toMatchObject({ reached: true, abnormal: true });
    const store = reopenAfterCrash();
    const events: RunEvent[] = [];
    await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: 4343,
      nodeVersion: process.version,
      onEvent: (event) => events.push(event),
    });
    const recovered = events.find((event) => event.type === "task.recovered");
    expect(recovered).toMatchObject({ type: "task.recovered", infraRestarts: 1 });
    const taskId = recovered?.type === "task.recovered" ? recovered.taskId : "";
    expect(store.metrics.snapshot().runsByStatus.orphaned).toBe(1);
    // The orphan charged no attempt, so the rerun is the first charged attempt.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.claimed", taskId, attempt: 1 }),
    );
    expect(store.tasks.get(taskId)).toMatchObject({ state: "completed", infraRestarts: 1 });
    store.close();
  });
});

describe("[CP4] killed mid-turn with an open budget reservation", CRASH_OPTIONS, () => {
  it("settles the reservation at its upper bound, flagged unreconciled, exactly once", () => {
    expect(crashAt("cp4")).toMatchObject({ reached: true, abnormal: true });
    const store = reopenAfterCrash();
    const projectId = store.projects.list()[0]?.projectId ?? "";
    const budgetId = store.budgets.ensure({
      scopeType: "project",
      scopeId: projectId,
      projectId,
      hardLimit: 1000,
    }).budgetId;
    expect(store.budgets.get(budgetId)).toMatchObject({ spent: 0, reserved: 300 });

    takeOverAndReconcile(store);

    expect(store.budgets.get(budgetId)).toMatchObject({ spent: 300, reserved: 0 });
    expect(store.budgets.usageSummary({ projectId })).toMatchObject({
      settled: 1,
      unreconciled: 1,
    });
    expect(store.virtualKeys.findActiveByHash(KEY_HASH)).toBeUndefined();
    // A second reconciliation finds nothing open and changes nothing.
    expect(takeOverAndReconcile(store)).toEqual([]);
    expect(store.budgets.get(budgetId)).toMatchObject({ spent: 300, reserved: 0 });
    expect(store.budgets.usageSummary({ projectId })?.settled).toBe(1);
    store.close();
  });
});

describe("[CP8] killed halfway through a migration", CRASH_OPTIONS, () => {
  it("[INV-12] leaves the schema, the applied versions and the seeded rows as they were", () => {
    expect(crashAt("cp8")).toMatchObject({ reached: true, abnormal: true });
    const raw = new DatabaseSync(join(dir, "haril.db"));
    expect(raw.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
    ]);
    // The table of the interrupted step was rolled back with its transaction.
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").all()).toEqual([]);
    // The rows of the committed step are intact.
    expect(raw.prepare("SELECT value FROM meta WHERE key = 'store_id'").get()).toBeDefined();
    expect(raw.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    raw.close();

    // The release opens the same file and applies the remaining migrations.
    const store = reopenAfterCrash();
    expect(store.info().schemaVersion).toBeGreaterThan(1);
    expect(store.projects.list()).toEqual([]);
    store.close();
  });
});
