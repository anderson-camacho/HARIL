import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// Token budgets, reservations, commits and virtual keys (M2-T2, ADR-0005 BR-3, BR-5, BR-8, BR-12).
let store: Store;
let projectId: string;
let epoch: number;
let seq = 0;

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

// A real run, so that the foreign keys of virtual_keys and budget_ledger point at existing rows.
function claimRun(): { taskId: string; runId: string } {
  seq += 1;
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: {
      goal: `goal ${seq}`,
      dependsOn: [],
      agent: "fake:succeed",
      maxAttempts: 1,
      timeoutMs: 1000,
    },
    idempotencyKey: `k-${seq}`,
    requestHash: `h-${seq}`,
  });
  store.commands.applyNext(epoch);
  store.tasks.promote();
  const claimed = store.tasks.claimNext(epoch);
  if (claimed === undefined) throw new Error("no task to claim");
  return { taskId: claimed.taskId, runId: claimed.runId };
}

interface Scope {
  readonly taskId: string;
  readonly runId: string;
  readonly projectBudget: string;
  readonly taskBudget: string;
}

function scope(projectLimit: number, taskLimit: number): Scope {
  const { taskId, runId } = claimRun();
  const project = store.budgets.ensure({
    scopeType: "project",
    scopeId: projectId,
    projectId,
    hardLimit: projectLimit,
  });
  const task = store.budgets.ensure({
    scopeType: "task",
    scopeId: taskId,
    projectId,
    hardLimit: taskLimit,
  });
  return { taskId, runId, projectBudget: project.budgetId, taskBudget: task.budgetId };
}

function reserve(s: Scope, amount: number, key: string) {
  return store.budgets.reserve({
    budgetIds: [s.projectBudget, s.taskBudget],
    amount,
    idempotencyKey: key,
    runId: s.runId,
    taskId: s.taskId,
    routeId: "route-a",
  });
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

describe("budgets.ensure", () => {
  it("creates a budget once and returns the same budget on repeat", () => {
    const first = store.budgets.ensure({
      scopeType: "project",
      scopeId: projectId,
      projectId,
      hardLimit: 1000,
    });
    const again = store.budgets.ensure({
      scopeType: "project",
      scopeId: projectId,
      projectId,
      hardLimit: 5,
    });
    expect(again.budgetId).toBe(first.budgetId);
    expect(again.hardLimit).toBe(1000);
    expect(first).toMatchObject({ spent: 0, reserved: 0, overrun: 0, scopeType: "project" });
  });
});

describe("budgets.reserve", () => {
  it("reserves the amount on every budget it names", () => {
    const s = scope(1000, 100);
    const result = reserve(s, 30, "req-1");
    expect(result.ok).toBe(true);
    expect(store.budgets.get(s.projectBudget)).toMatchObject({ reserved: 30, spent: 0 });
    expect(store.budgets.get(s.taskBudget)).toMatchObject({ reserved: 30, spent: 0 });
  });

  it("is all-or-nothing: a task budget with room does not keep a reservation the project refused", () => {
    const s = scope(20, 100);
    const result = reserve(s, 30, "req-2");
    expect(result).toEqual({ ok: false, reason: "insufficient", budgetId: s.projectBudget });
    expect(store.budgets.get(s.projectBudget)).toMatchObject({ reserved: 0, spent: 0 });
    expect(store.budgets.get(s.taskBudget)).toMatchObject({ reserved: 0, spent: 0 });
    expect(store.budgets.usageSummary()).toBeNull();
  });

  it("refuses a budget that does not exist", () => {
    const s = scope(1000, 100);
    const result = store.budgets.reserve({
      budgetIds: [s.projectBudget, "missing"],
      amount: 1,
      idempotencyKey: "req-3",
      runId: s.runId,
      taskId: s.taskId,
      routeId: "route-a",
    });
    expect(result).toEqual({ ok: false, reason: "unknown_budget", budgetId: "missing" });
    expect(store.budgets.get(s.projectBudget)).toMatchObject({ reserved: 0 });
  });

  it("refuses a reused idempotency key with a store conflict", () => {
    const s = scope(1000, 100);
    reserve(s, 10, "req-4");
    expect(caught(() => reserve(s, 10, "req-4")).code).toBe("store.conflict");
  });
});

describe("budgets.commit", () => {
  it("commits the raw usage and releases the rest of the reservation", () => {
    const s = scope(1000, 100);
    const reserved = reserve(s, 40, "req-5");
    if (!reserved.ok) throw new Error("reservation refused");
    const result = store.budgets.commit({
      reservationId: reserved.reservationId,
      usage: { inputTokens: 12, outputTokens: 7 },
      upperBound: 40,
      modelRequested: "m1",
      modelServed: "m1",
    });
    expect(result).toBe("committed");
    expect(store.budgets.get(s.taskBudget)).toMatchObject({ spent: 19, reserved: 0 });
    expect(store.budgets.get(s.projectBudget)).toMatchObject({ spent: 19, reserved: 0 });
    expect(store.budgets.usageSummary()).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      settled: 1,
      unreconciled: 0,
    });
  });

  it("without usage, charges the upper bound as unreconciled and never zero", () => {
    const s = scope(1000, 100);
    const reserved = reserve(s, 40, "req-6");
    if (!reserved.ok) throw new Error("reservation refused");
    store.budgets.commit({
      reservationId: reserved.reservationId,
      usage: null,
      upperBound: 25,
      modelRequested: "m1",
      modelServed: null,
    });
    expect(store.budgets.get(s.taskBudget)).toMatchObject({ spent: 25, reserved: 0 });
    expect(store.budgets.usageSummary()).toMatchObject({ unreconciled: 1 });
  });

  it("is idempotent: a second commit of the same reservation changes nothing", () => {
    const s = scope(1000, 100);
    const reserved = reserve(s, 40, "req-7");
    if (!reserved.ok) throw new Error("reservation refused");
    const input = {
      reservationId: reserved.reservationId,
      usage: { inputTokens: 5, outputTokens: 5 },
      upperBound: 40,
      modelRequested: "m1",
      modelServed: "m1",
    };
    expect(store.budgets.commit(input)).toBe("committed");
    expect(store.budgets.commit(input)).toBe("already_settled");
    expect(store.budgets.get(s.taskBudget)).toMatchObject({ spent: 10, reserved: 0 });
  });

  it("records usage above the reservation as overrun and keeps spent + reserved within the hard limit", () => {
    const s = scope(50, 100);
    const reserved = reserve(s, 40, "req-8");
    if (!reserved.ok) throw new Error("reservation refused");
    store.budgets.commit({
      reservationId: reserved.reservationId,
      usage: { inputTokens: 60, outputTokens: 30 },
      upperBound: 40,
      modelRequested: "m1",
      modelServed: "m1",
    });
    expect(store.budgets.get(s.projectBudget)).toMatchObject({
      spent: 50,
      reserved: 0,
      overrun: 40,
    });
  });

  it("refuses to settle an unknown reservation", () => {
    expect(
      store.budgets.commit({
        reservationId: "nope",
        usage: null,
        upperBound: 1,
        modelRequested: "m1",
        modelServed: null,
      }),
    ).toBe("unknown_reservation");
  });
});

describe("budgets.release", () => {
  it("returns the reserved amount and refuses a second settlement", () => {
    const s = scope(1000, 100);
    const reserved = reserve(s, 30, "req-9");
    if (!reserved.ok) throw new Error("reservation refused");
    expect(store.budgets.release(reserved.reservationId)).toBe("released");
    expect(store.budgets.get(s.taskBudget)).toMatchObject({ spent: 0, reserved: 0 });
    expect(store.budgets.release(reserved.reservationId)).toBe("already_settled");
    expect(store.budgets.release("nope")).toBe("unknown_reservation");
  });
});

describe("virtualKeys", () => {
  const routeGrant = { models: ["m1"], maxTokensPerRequest: 500 };

  it("finds an active key by its hash and never by the plaintext", () => {
    const s = scope(1000, 100);
    store.virtualKeys.issue({
      runId: s.runId,
      keyHash: "hash-a",
      routeGrant,
      budgetIds: [s.taskBudget],
      expiresAt: 5_000,
    });
    expect(store.virtualKeys.findActiveByHash("hash-a")).toMatchObject({
      runId: s.runId,
      routeGrant,
      budgetIds: [s.taskBudget],
      expiresAt: 5_000,
    });
    expect(store.virtualKeys.findActiveByHash("hash-b")).toBeUndefined();
  });

  it("allows one active key per run and rejects a second with a store conflict", () => {
    const s = scope(1000, 100);
    const input = {
      runId: s.runId,
      routeGrant,
      budgetIds: [s.taskBudget],
      expiresAt: 5_000,
    };
    store.virtualKeys.issue({ ...input, keyHash: "hash-c" });
    expect(caught(() => store.virtualKeys.issue({ ...input, keyHash: "hash-d" })).code).toBe(
      "store.conflict",
    );
  });

  it("revokes every active key of a run once and then refuses them", () => {
    const s = scope(1000, 100);
    store.virtualKeys.issue({
      runId: s.runId,
      keyHash: "hash-e",
      routeGrant,
      budgetIds: [s.taskBudget],
      expiresAt: 5_000,
    });
    expect(store.virtualKeys.revoke(s.runId, "run finished")).toBe(1);
    expect(store.virtualKeys.findActiveByHash("hash-e")).toBeUndefined();
    expect(store.virtualKeys.revoke(s.runId, "again")).toBe(0);
    store.virtualKeys.issue({
      runId: s.runId,
      keyHash: "hash-f",
      routeGrant,
      budgetIds: [s.taskBudget],
      expiresAt: 5_000,
    });
    expect(store.virtualKeys.findActiveByHash("hash-f")).toBeDefined();
  });
});

describe("budgets.usageSummary", () => {
  it("is null without ledger entries and filters by project", () => {
    expect(store.budgets.usageSummary({ projectId })).toBeNull();
    const s = scope(1000, 100);
    const reserved = reserve(s, 10, "req-10");
    if (!reserved.ok) throw new Error("reservation refused");
    store.budgets.commit({
      reservationId: reserved.reservationId,
      usage: { inputTokens: 3, outputTokens: 4 },
      upperBound: 10,
      modelRequested: "m1",
      modelServed: "m1",
    });
    expect(store.budgets.usageSummary({ projectId })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      settled: 1,
      unreconciled: 0,
    });
    expect(store.budgets.usageSummary({ projectId: "other" })).toBeNull();
  });
});
