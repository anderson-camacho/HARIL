import type { EventRecord, Store, TaskRecord } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.js";
import { type ManualClock, manualClock, sequentialIds, testRules } from "./support.js";

// events.list filters (M1-T6) and metrics.snapshot, which must equal what the event log alone implies.
let clock: ManualClock;
let store: Store;
let projectId: string;
let epoch: number;
let keySeq = 0;

beforeEach(() => {
  clock = manualClock();
  store = openMemoryStore({
    clock,
    ids: sequentialIds(),
    rules: testRules,
    isPidAlive: () => false,
  });
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

function enqueue(goal: string, agent: string, maxAttempts: number): string {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn: [], agent, maxAttempts, timeoutMs: 1000 },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  store.commands.applyNext(epoch);
  return taskOf(goal).taskId;
}

function taskOf(goal: string): TaskRecord {
  const task = store.tasks.list().find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task;
}

// Claims the next ready task, lasts `ms`, then settles it as the given outcome.
function attempt(outcome: "succeeded" | "failed", ms: number): void {
  const claimed = store.tasks.claimNext(epoch);
  if (claimed === undefined) throw new Error("nothing claimable");
  clock.advance(ms);
  store.runs.complete(
    outcome === "succeeded"
      ? { runId: claimed.runId, outcome, result: { summary: "ok" } }
      : {
          runId: claimed.runId,
          outcome,
          error: { code: "fake.failed", message: "boom" },
          endCause: "exit",
        },
  );
}

// Scenario: one success, one task that fails and is retried then fails, and one run orphaned by a
// takeover (the dead pid of the first lease) and completed by the new epoch.
function runScenario(): void {
  enqueue("S", "fake:succeed", 1);
  enqueue("R", "fake:fail", 2);
  enqueue("O", "developer-block", 1);
  attempt("succeeded", 30);
  attempt("failed", 10);
  attempt("failed", 20);
  store.tasks.claimNext(epoch); // O starts (attempt 1) and its runtime dies before settling it
  clock.advance(7);
  const takeover = store.runtime.acquire({
    pid: 2,
    nodeVersion: "v24.19.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!takeover.ok) throw new Error("takeover refused");
  store.runtime.reconcile(takeover.value.epoch, 3);
  const again = store.tasks.claimNext(takeover.value.epoch);
  if (again === undefined) throw new Error("orphaned task not claimable");
  clock.advance(5);
  store.runs.complete({ runId: again.runId, outcome: "succeeded", result: { simulated: true } });
}

type Outcome = "completed" | "failed" | "orphaned";
interface AgentRow {
  runs: number;
  completed: number;
  failed: number;
  orphaned: number;
  totalMs: number;
}

// Recomputes the run numbers from the events alone (M1-T6, ACE-11).
function runsFromEvents(events: readonly EventRecord[]) {
  const agentOf = new Map<string, string>();
  const startedAt = new Map<string, number>();
  for (const event of events) {
    if (event.type === "task.claimed" && event.runId !== undefined) {
      agentOf.set(event.runId, event.agentId ?? "");
      startedAt.set(event.runId, event.ts);
    }
  }
  const terminal = events.filter(
    (event) =>
      event.runId !== undefined &&
      ["task.completed", "task.retried", "task.failed", "task.orphaned"].includes(event.type),
  );
  const outcomeOf = (type: string): Outcome =>
    type === "task.completed" ? "completed" : type === "task.orphaned" ? "orphaned" : "failed";
  const perAgent = new Map<string, AgentRow>();
  const rowFor = (agent: string): AgentRow => {
    const row = perAgent.get(agent) ?? {
      runs: 0,
      completed: 0,
      failed: 0,
      orphaned: 0,
      totalMs: 0,
    };
    perAgent.set(agent, row);
    return row;
  };
  for (const agent of agentOf.values()) rowFor(agent).runs++;
  let totalMs = 0;
  for (const event of terminal) {
    const runId = event.runId ?? "";
    const row = rowFor(agentOf.get(runId) ?? "");
    row[outcomeOf(event.type)]++;
    const duration = event.ts - (startedAt.get(runId) ?? event.ts);
    row.totalMs += duration;
    totalMs += duration;
  }
  return {
    completed: events.filter((event) => event.type === "task.completed").length,
    failed: terminal.filter((event) => outcomeOf(event.type) === "failed").length,
    orphaned: terminal.filter((event) => outcomeOf(event.type) === "orphaned").length,
    retries: events.filter((event) => event.type === "task.retried").length,
    orphanedRecoveries: events.filter((event) => event.type === "task.orphaned").length,
    closedRuns: terminal.length,
    totalMs,
    perAgent: [...perAgent.entries()].map(([agentRef, row]) => ({ agentRef, ...row })),
  };
}

// Last state of every task, replayed from the task.* events.
function tasksByStateFromEvents(events: readonly EventRecord[]): Record<string, number> {
  const state = new Map<string, string>();
  for (const event of events) {
    if (event.taskId === undefined) continue;
    switch (event.type) {
      case "task.created":
        state.set(event.taskId, String(event.payload.state));
        break;
      case "task.ready":
        state.set(event.taskId, "ready");
        break;
      case "task.blocked":
        state.set(event.taskId, "blocked");
        break;
      case "task.claimed":
        state.set(event.taskId, "running");
        break;
      case "task.completed":
        state.set(event.taskId, "completed");
        break;
      case "task.retried":
        state.set(event.taskId, "ready");
        break;
      case "task.failed":
        state.set(event.taskId, "failed");
        break;
      case "task.orphaned":
        state.set(event.taskId, String(event.payload.toState));
        break;
    }
  }
  const counts: Record<string, number> = {
    pending: 0,
    ready: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const value of state.values()) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

describe("events.list filters (M1-T6)", () => {
  it("filters by task and by project, and keeps ascending seq order", () => {
    const a = enqueue("A", "fake:succeed", 1);
    enqueue("B", "fake:succeed", 1);
    attempt("succeeded", 1);
    const byTask = store.events.list({ taskId: a });
    expect(byTask.length).toBeGreaterThan(0);
    expect(byTask.every((event) => event.taskId === a)).toBe(true);
    expect(store.events.list({ projectId }).length).toBe(store.events.list().length);
    expect(store.events.list({ projectId: "nobody" })).toEqual([]);
  });

  it("returns the newest `limit` events, oldest first", () => {
    enqueue("A", "fake:succeed", 1);
    enqueue("B", "fake:succeed", 1);
    const all = store.events.list();
    const last = store.events.list({ limit: 2 });
    expect(last.map((event) => event.seq)).toEqual(all.slice(-2).map((event) => event.seq));
  });
});

describe("events.list time range", () => {
  const MINUTE = 60_000;
  const BASE = 1_800_000_000_000;

  // Five events one minute apart, the first at BASE; returns their sequence numbers oldest first.
  function seedMinutes(): number[] {
    return [0, 1, 2, 3, 4].map(
      (minute) =>
        store.events.append({
          aggregateType: "task",
          aggregateId: `t-${minute}`,
          type: minute % 2 === 0 ? "task.failed" : "task.completed",
          actorKind: "system",
          actorId: "test",
          payload: {},
          projectId,
          ts: BASE + minute * MINUTE,
        }).seq,
    );
  }

  const seqs = (filter?: Parameters<Store["events"]["list"]>[0]) =>
    store.events.list(filter).map((event) => event.seq);

  it("keeps events with ts >= from: the lower bound is inclusive", () => {
    const seeded = seedMinutes();
    expect(seqs({ from: BASE + 2 * MINUTE })).toEqual(seeded.slice(2));
    expect(seqs({ from: BASE + 2 * MINUTE + 1 })).toEqual(seeded.slice(3));
  });

  it("keeps events with ts < to: the upper bound is exclusive", () => {
    const seeded = seedMinutes();
    expect(seqs({ from: BASE, to: BASE + 3 * MINUTE })).toEqual(seeded.slice(0, 3));
    expect(seqs({ from: BASE, to: BASE + 3 * MINUTE + 1 })).toEqual(seeded.slice(0, 4));
    // The project registration was stamped by the clock far before BASE, so it is the only event before it.
    expect(seqs({ to: BASE }).some((seq) => seeded.includes(seq))).toBe(false);
    expect(seqs({ to: BASE }).length).toBe(seqs().length - seeded.length);
  });

  it("combines from and to, and an empty or reversed range returns nothing", () => {
    const seeded = seedMinutes();
    expect(seqs({ from: BASE + MINUTE, to: BASE + 4 * MINUTE })).toEqual(seeded.slice(1, 4));
    expect(seqs({ from: BASE + MINUTE, to: BASE + MINUTE })).toEqual([]);
    expect(seqs({ from: BASE + 4 * MINUTE, to: BASE + MINUTE })).toEqual([]);
  });

  it("applies the range together with the project, task and limit filters", () => {
    const seeded = seedMinutes();
    const range = { from: BASE + MINUTE, to: BASE + 5 * MINUTE };
    expect(seqs({ ...range, projectId })).toEqual(seeded.slice(1, 5));
    expect(seqs({ ...range, projectId: "nobody" })).toEqual([]);
    expect(seqs({ ...range, aggregateId: "t-2" })).toEqual([seeded[2]]);
    // `limit` keeps the newest events inside the range, still oldest first.
    expect(seqs({ ...range, limit: 2 })).toEqual(seeded.slice(3, 5));
  });
});

describe("metrics.snapshot (M1-T6)", () => {
  it("counts tasks by state and runs by outcome", () => {
    runScenario();
    const snapshot = store.metrics.snapshot();
    expect(snapshot.tasksByState).toEqual({
      pending: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      completed: 2,
      failed: 1,
      cancelled: 0,
    });
    expect(snapshot.runsByStatus).toMatchObject({ completed: 2, failed: 2, orphaned: 1 });
  });

  it("[INV-10] is recomputable from the event log alone", () => {
    runScenario();
    const snapshot = store.metrics.snapshot();
    const events = store.events.list();
    const derived = runsFromEvents(events);

    expect(snapshot.runsByStatus.completed ?? 0).toBe(derived.completed);
    expect(snapshot.runsByStatus.failed ?? 0).toBe(derived.failed);
    expect(snapshot.runsByStatus.orphaned ?? 0).toBe(derived.orphaned);
    expect(snapshot.retries).toBe(derived.retries);
    expect(snapshot.orphanedRecoveries).toBe(derived.orphanedRecoveries);
    expect(snapshot.closedRuns).toBe(derived.closedRuns);
    expect(snapshot.durationTotalMs).toBe(derived.totalMs);
    expect(snapshot.tasksByState).toMatchObject(tasksByStateFromEvents(events));
    const perAgent = new Map(snapshot.perAgent.map((row) => [row.agentRef, row]));
    expect(perAgent.size).toBe(derived.perAgent.length);
    for (const row of derived.perAgent) {
      expect(perAgent.get(row.agentRef)).toMatchObject({
        runs: row.runs,
        completed: row.completed,
        failed: row.failed,
        orphaned: row.orphaned,
        totalMs: row.totalMs,
      });
    }
  });

  it("scopes the counts to one project", () => {
    runScenario();
    const other = store.projects.register({ slug: "other", name: "Other", rootPath: "D:/other" });
    expect(store.metrics.snapshot(other.projectId).runsByStatus).toEqual({});
    expect(store.metrics.snapshot(projectId).retries).toBe(1);
  });
});
