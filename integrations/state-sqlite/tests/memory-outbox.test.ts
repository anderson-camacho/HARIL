import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OutboxEnqueue, Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, openStore, readMemoryStatus, type StoreError } from "../src/index.js";
import { migrate } from "../src/migrate.js";
import { MIGRATION_0001 } from "../src/migrations/0001_init.js";
import { MIGRATION_0002 } from "../src/migrations/0002_budgets.js";
import { MIGRATION_0003 } from "../src/migrations/0003_task_model.js";
import { MIGRATION_0004 } from "../src/migrations/0004_approvals.js";
import { MIGRATION_0005 } from "../src/migrations/0005_approval_model.js";
import {
  type ManualClock,
  makeTempDir,
  manualClock,
  removeTempDir,
  sequentialIds,
  testRules,
} from "./support.js";

// The memory module of the Store (MC-T4; task-store.md 4.10, DATA_MODEL 5.7, memory.md 4.4): migration 0006, the
// outbox protocol, the provider state the CLI reads without a runtime, and the tasks that wait for memory.

const SESSION = "01HMEMSESSION0000000000001";
const OTHER_SESSION = "01HMEMSESSION0000000000002";
const BEFORE_0006 = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
];

let clock: ManualClock;
let store: Store;
let projectId: string;
let epoch: number;

function acquire(target: Store): number {
  const grant = target.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.21.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  return grant.value.epoch;
}

beforeEach(() => {
  clock = manualClock();
  store = openMemoryStore({ clock, ids: sequentialIds(), rules: testRules });
  projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: "D:/demo",
  }).projectId;
  epoch = acquire(store);
});

afterEach(() => {
  store.close();
});

function row(operationId: string, extra: Partial<OutboxEnqueue> = {}): OutboxEnqueue {
  return {
    operationId,
    projectId,
    op: "store",
    payload: { schemaVersion: 1, operationId, title: `fake title ${operationId}` },
    schemaVersion: 1,
    sessionId: SESSION,
    ...extra,
  };
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

function eventsOf(type: string) {
  return store.events.list().filter((event) => event.type === type);
}

function planTask(localId: string, requires: readonly string[]) {
  return {
    localId,
    dependsOn: [],
    goal: `goal ${localId}`,
    description: "",
    priority: 0,
    kind: "work",
    agent: "fake:succeed",
    requires,
    context: [],
    surface: { write: [], read: [] },
    budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 0 },
    timeoutMs: 1000,
    maxAttempts: 1,
    acceptance: [],
  };
}

describe("migration 0006 (memory_outbox, memory_refs)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it("applies on a database the earlier migrations created, and keeps its rows", () => {
    const db = new DatabaseSync(join(dir, "haril.db"));
    migrate(db, clock, sequentialIds("old"), BEFORE_0006);
    db.prepare(
      "INSERT INTO projects (project_id, slug, name, root_path, created_at) VALUES ('p-old', 'old', 'Old', 'D:/old', 1)",
    ).run();
    db.close();

    const opened = openStore({ dataDir: dir, clock, ids: sequentialIds(), rules: testRules });
    try {
      expect(opened.info().schemaVersion).toBe(9);
      expect(opened.projects.list().map((project) => project.slug)).toEqual(["old"]);
      expect(opened.memory.status()).toEqual({
        provider: null,
        persistent: null,
        lastState: null,
        lastStateAt: null,
        lastError: null,
        outbox: {
          pending: 0,
          sending: 0,
          needsReview: 0,
          dead: 0,
          delivered: 0,
          oldestPendingAt: null,
        },
      });
    } finally {
      opened.close();
    }
  });
});

describe("store.memory.enqueue", () => {
  it("queues pending rows due now, each with its operation id and a memory.outbox.enqueued event", () => {
    expect(store.memory.enqueue(epoch, [row("fake-op-1"), row("fake-op-2")])).toEqual({
      enqueued: 2,
      deduped: 0,
    });
    expect(store.memory.get("fake-op-1")).toMatchObject({
      operationId: "fake-op-1",
      projectId,
      op: "store",
      status: "pending",
      attempts: 0,
      nextAttemptAt: clock.now(),
      sessionId: SESSION,
      lastError: null,
      receipt: null,
    });
    expect(eventsOf("memory.outbox.enqueued").map((event) => event.payload)).toEqual([
      { operationId: "fake-op-1", op: "store" },
      { operationId: "fake-op-2", op: "store" },
    ]);
  });

  it("[MEM-04] the same operation id and payload is deduplicated; another payload under it is a conflict", () => {
    store.memory.enqueue(epoch, [row("fake-op-1")]);
    expect(store.memory.enqueue(epoch, [row("fake-op-1")])).toEqual({ enqueued: 0, deduped: 1 });
    const error = caught(() =>
      store.memory.enqueue(epoch, [row("fake-op-1", { payload: { other: true } })]),
    );
    expect(error.code).toBe("store.conflict");
    expect(store.memory.status().outbox.pending).toBe(1);
  });

  it("one outbox row per source row", () => {
    const source = { table: "decisions", id: "fake-decision-1" };
    store.memory.enqueue(epoch, [row("fake-op-1", { source })]);
    expect(store.memory.enqueue(epoch, [row("fake-op-2", { source })])).toEqual({
      enqueued: 0,
      deduped: 1,
    });
    expect(store.memory.get("fake-op-2")).toBeUndefined();
  });

  it("is fenced by the runtime epoch", () => {
    store.runtime.release(epoch, true);
    expect(caught(() => store.memory.enqueue(epoch, [row("fake-op-1")])).code).toBe("store.fenced");
  });
});

describe("store.memory.claimDue", () => {
  it("[ST-29] claims due rows in outbox order, one attempt more each, and skips a row not due without blocking", () => {
    store.memory.enqueue(epoch, [row("fake-op-1"), row("fake-op-2"), row("fake-op-3")]);
    const [first] = store.memory.claimDue(epoch, 1);
    store.memory.markFailed(epoch, {
      operationId: first?.operationId ?? "",
      code: "Unavailable",
      to: "pending",
      nextAttemptAt: clock.now() + 5_000,
    });

    const claimed = store.memory.claimDue(epoch, 5);
    expect(claimed.map((entry) => entry.operationId)).toEqual(["fake-op-2", "fake-op-3"]);
    expect(claimed.every((entry) => entry.status === "sending" && entry.attempts === 1)).toBe(true);
    expect(store.memory.nextDueAt()).toBe(clock.now() + 5_000);

    clock.advance(5_000);
    expect(store.memory.claimDue(epoch, 5)).toMatchObject([
      { operationId: "fake-op-1", attempts: 2, status: "sending" },
    ]);
  });

  it("[MEM-11] claims a summarize only once no other row of its session is waiting", () => {
    store.memory.enqueue(epoch, [
      row("fake-op-store"),
      row("fake-op-summary", { op: "summarize" }),
      row("fake-op-other", { sessionId: OTHER_SESSION }),
    ]);
    const [stored] = store.memory.claimDue(epoch, 1);
    expect(stored?.operationId).toBe("fake-op-store");
    // The store row is sending: the summarize of its session waits, the other session's row does not.
    expect(store.memory.claimDue(epoch, 5).map((entry) => entry.operationId)).toEqual([
      "fake-op-other",
    ]);
    store.memory.markFailed(epoch, {
      operationId: "fake-op-store",
      code: "SessionEnded",
      to: "needs_review",
    });
    expect(store.memory.claimDue(epoch, 5)).toEqual([]);
    store.memory.markFailed(epoch, {
      operationId: "fake-op-other",
      code: "Unsupported",
      to: "dead",
    });
    expect(store.memory.claimDue(epoch, 5)).toEqual([]);
  });

  it("is fenced by the runtime epoch", () => {
    store.memory.enqueue(epoch, [row("fake-op-1")]);
    expect(caught(() => store.memory.claimDue(epoch + 1, 1)).code).toBe("store.fenced");
  });
});

describe("store.memory.markDelivered", () => {
  const receipt = {
    schemaVersion: 1,
    operationId: "fake-op-1",
    provider: "fake-provider",
    providerRef: "fake-ref-1",
    outcome: "created",
    truncated: false,
    redacted: false,
  };
  const ref = {
    projectId: "",
    provider: "fake-provider",
    providerRef: "fake-ref-1",
    direction: "out" as const,
    kind: "decision",
    origin: "haril" as const,
  };
  const stored = {
    type: "memory.stored",
    payload: { operationId: "fake-op-1", outcome: "created" },
  };

  it("[MEM-04] marks the row delivered with its receipt, one pointer and the event, together", () => {
    store.memory.enqueue(epoch, [row("fake-op-1")]);
    store.memory.claimDue(epoch, 1);
    store.memory.markDelivered(epoch, {
      operationId: "fake-op-1",
      receipt,
      provider: "fake-provider",
      refs: [{ ...ref, projectId }],
      event: stored,
    });
    expect(store.memory.get("fake-op-1")).toMatchObject({
      status: "delivered",
      receipt,
      deliveredProvider: "fake-provider",
      deliveredAt: clock.now(),
    });
    expect(store.memory.refs(projectId)).toMatchObject([
      { ...ref, projectId, operationId: "fake-op-1", createdAt: clock.now() },
    ]);
    expect(eventsOf("memory.stored").map((event) => event.payload)).toEqual([stored.payload]);
    expect(store.memory.status().outbox).toMatchObject({ pending: 0, sending: 0, delivered: 1 });
  });

  it("[MC-01] a redelivery that answers the same pointer keeps one memory_refs row", () => {
    store.memory.enqueue(epoch, [row("fake-op-1"), row("fake-op-2")]);
    store.memory.claimDue(epoch, 2);
    for (const operationId of ["fake-op-1", "fake-op-2"]) {
      store.memory.markDelivered(epoch, {
        operationId,
        receipt,
        provider: "fake-provider",
        refs: [{ ...ref, projectId }],
        event: stored,
      });
    }
    expect(store.memory.refs(projectId)).toHaveLength(1);
  });

  it("refuses a row this runtime did not claim", () => {
    store.memory.enqueue(epoch, [row("fake-op-1")]);
    const error = caught(() =>
      store.memory.markDelivered(epoch, {
        operationId: "fake-op-1",
        receipt,
        provider: "fake-provider",
        refs: [],
        event: stored,
      }),
    );
    expect(error.code).toBe("store.stale");
    expect(store.memory.get("fake-op-1")?.status).toBe("pending");
  });
});

describe("store.memory.markFailed", () => {
  it("records the code and the transition, with the event of needs_review and dead", () => {
    store.memory.enqueue(epoch, [row("fake-op-1"), row("fake-op-2"), row("fake-op-3")]);
    store.memory.claimDue(epoch, 3);
    store.memory.markFailed(epoch, {
      operationId: "fake-op-1",
      code: "Unavailable",
      to: "pending",
      nextAttemptAt: clock.now() + 1_000,
    });
    store.memory.markFailed(epoch, {
      operationId: "fake-op-2",
      code: "SessionEnded",
      to: "needs_review",
    });
    store.memory.markFailed(epoch, { operationId: "fake-op-3", code: "Unsupported", to: "dead" });

    expect(store.memory.get("fake-op-1")).toMatchObject({
      status: "pending",
      lastError: "Unavailable",
      nextAttemptAt: clock.now() + 1_000,
    });
    expect(store.memory.get("fake-op-2")).toMatchObject({
      status: "needs_review",
      lastError: "SessionEnded",
    });
    expect(store.memory.get("fake-op-3")).toMatchObject({
      status: "dead",
      lastError: "Unsupported",
    });
    expect(eventsOf("memory.outbox.needs_review").map((event) => event.payload)).toEqual([
      { operationId: "fake-op-2", op: "store", code: "SessionEnded" },
    ]);
    expect(eventsOf("memory.outbox.dead").map((event) => event.payload)).toEqual([
      { operationId: "fake-op-3", op: "store", code: "Unsupported", attempts: 1 },
    ]);
    expect(store.memory.status().outbox).toMatchObject({ pending: 1, needsReview: 1, dead: 1 });
  });
});

describe("store.memory.requeueStale", () => {
  it("[MEM-16] returns the rows an earlier runtime left sending to pending with the same operation id", () => {
    store.memory.enqueue(epoch, [row("fake-op-1"), row("fake-op-2")]);
    store.memory.claimDue(epoch, 1);
    store.runtime.release(epoch, false);
    const next = acquire(store);
    expect(store.memory.requeueStale(next)).toBe(1);
    expect(store.memory.get("fake-op-1")).toMatchObject({ status: "pending", attempts: 1 });
    expect(store.memory.requeueStale(next)).toBe(0);
    expect(store.memory.claimDue(next, 5).map((entry) => entry.operationId)).toEqual([
      "fake-op-1",
      "fake-op-2",
    ]);
  });
});

describe("store.memory.setState", () => {
  it("records the provider state in meta and emits memory.degraded and memory.recovered once per transition", () => {
    expect(
      store.memory.setState(epoch, {
        provider: "fake-provider",
        state: "active",
        persistent: true,
      }),
    ).toBe(true);
    expect(
      store.memory.setState(epoch, {
        provider: "fake-provider",
        state: "active",
        persistent: true,
      }),
    ).toBe(false);
    const down = clock.now();
    store.memory.enqueue(epoch, [row("fake-op-1")]);
    expect(
      store.memory.setState(epoch, {
        provider: "fake-provider",
        state: "degraded",
        persistent: true,
        code: "Unavailable",
      }),
    ).toBe(true);
    expect(
      store.memory.setState(epoch, {
        provider: "fake-provider",
        state: "degraded",
        persistent: true,
        code: "Unavailable",
      }),
    ).toBe(false);
    expect(store.memory.status()).toMatchObject({
      provider: "fake-provider",
      persistent: true,
      lastState: "degraded",
      lastStateAt: down,
      lastError: { code: "Unavailable", at: down },
    });
    clock.advance(2_500);
    store.memory.setState(epoch, { provider: "fake-provider", state: "active", persistent: true });

    expect(eventsOf("memory.degraded").map((event) => event.payload)).toEqual([
      {
        provider: "fake-provider",
        state: "degraded",
        code: "Unavailable",
        since: down,
        outboxDepth: 1,
      },
    ]);
    expect(eventsOf("memory.recovered").map((event) => event.payload)).toEqual([
      { provider: "fake-provider", downMs: 2_500, outboxDepth: 1 },
    ]);
    // The last error stays visible after the recovery.
    expect(store.memory.status()).toMatchObject({
      lastState: "active",
      lastStateAt: down + 2_500,
      lastError: { code: "Unavailable", at: down },
    });
  });
});

describe("store.memory.blockTasks and releaseTasks", () => {
  it("[MEM-08] blocks only the ready tasks whose requires[] has memory, and returns them to ready", () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: {
        plan: { schemaVersion: 1, tasks: [planTask("plain", []), planTask("recall", ["memory"])] },
      },
      idempotencyKey: "fake-key-1",
      requestHash: "fake-hash-1",
    });
    expect(store.commands.applyNext(epoch)?.outcome).toBe("applied");
    const byGoal = (goal: string) => store.tasks.list().find((task) => task.goal === goal);

    expect(store.memory.blockTasks(epoch)).toEqual([
      { taskId: byGoal("goal recall")?.taskId, goal: "goal recall" },
    ]);
    expect(store.tasks.get(byGoal("goal recall")?.taskId ?? "")).toMatchObject({
      state: "blocked",
      blockReason: "memory_unavailable",
    });
    expect(byGoal("goal plain")?.state).toBe("ready");
    expect(store.memory.blockTasks(epoch)).toEqual([]);
    expect(eventsOf("task.blocked").map((event) => event.payload)).toEqual([
      { reason: "memory_unavailable" },
    ]);

    expect(store.memory.releaseTasks(epoch)).toEqual([
      { taskId: byGoal("goal recall")?.taskId, goal: "goal recall" },
    ]);
    expect(byGoal("goal recall")?.state).toBe("ready");
    expect(store.tasks.get(byGoal("goal recall")?.taskId ?? "")?.blockReason).toBeNull();
    expect(store.memory.releaseTasks(epoch)).toEqual([]);
  });
});

describe("store.memory.status", () => {
  it("counts the outbox by status, with the enqueue time of the oldest pending row", () => {
    store.memory.enqueue(epoch, [row("fake-op-1")]);
    const first = clock.now();
    clock.advance(10);
    store.memory.enqueue(epoch, [row("fake-op-2"), row("fake-op-3")]);
    store.memory.claimDue(epoch, 1);
    expect(store.memory.status().outbox).toEqual({
      pending: 2,
      sending: 1,
      needsReview: 0,
      dead: 0,
      delivered: 0,
      oldestPendingAt: first + 10,
    });
    expect(store.memory.nextDueAt()).toBe(first + 10);
  });
});

describe("readMemoryStatus (haril memory status without a runtime)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it("is undefined without a database and creates nothing", () => {
    expect(readMemoryStatus(dir)).toBeUndefined();
    expect(readMemoryStatus(join(dir, "missing"))).toBeUndefined();
  });

  it("reads what the store recorded through a read-only connection, leaving haril.db as it was", () => {
    const fileStore = openStore({ dataDir: dir, clock, ids: sequentialIds(), rules: testRules });
    const project = fileStore.projects.register({
      slug: "demo",
      name: "Demo",
      rootPath: "D:/demo",
    });
    const fileEpoch = acquire(fileStore);
    fileStore.memory.setState(fileEpoch, { provider: "null", state: "active", persistent: false });
    fileStore.memory.enqueue(fileEpoch, [row("fake-op-1", { projectId: project.projectId })]);
    const expected = fileStore.memory.status();
    const lease = fileStore.runtime.leaseSummary();
    fileStore.close();
    const before = readFileSync(join(dir, "haril.db"));

    expect(readMemoryStatus(dir)).toEqual({ status: expected, lease });
    expect(readFileSync(join(dir, "haril.db")).equals(before)).toBe(true);
  });

  it("[MC-T4 fix] leaves a closed data dir exactly as it found it: no -wal or -shm stays behind", () => {
    const fileStore = openStore({ dataDir: dir, clock, ids: sequentialIds(), rules: testRules });
    fileStore.memory.setState(acquire(fileStore), {
      provider: "null",
      state: "active",
      persistent: false,
    });
    fileStore.close();
    const before = readdirSync(dir).sort();
    expect(before).toEqual(["haril.db"]);

    expect(readMemoryStatus(dir)?.status.provider).toBe("null");
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("[MC-T4 fix] reads nothing from a zero-byte haril.db and leaves it empty", () => {
    writeFileSync(join(dir, "haril.db"), "");
    expect(readMemoryStatus(dir)).toBeUndefined();
    expect(statSync(join(dir, "haril.db")).size).toBe(0);
    expect(readdirSync(dir)).toEqual(["haril.db"]);
  });

  it("[MC-T4 fix] refuses the database of another application with the store's own gate error", () => {
    const foreign = new DatabaseSync(join(dir, "haril.db"));
    foreign.exec("PRAGMA application_id = 1234; CREATE TABLE fake_table (x INTEGER)");
    foreign.close();
    const error = caught(() => readMemoryStatus(dir));
    expect(error.code).toBe("store.gate_failed");
    expect(error.message).toContain("belongs to another application");
    expect(readdirSync(dir)).toEqual(["haril.db"]);
  });

  it("on a database before migration 0006 reports nothing recorded and leaves its schema alone", () => {
    const db = new DatabaseSync(join(dir, "haril.db"));
    // WAL, as every HARIL store: reading it must not leave its side files either.
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db, clock, sequentialIds("old"), BEFORE_0006);
    db.close();
    expect(readdirSync(dir)).toEqual(["haril.db"]);

    expect(readMemoryStatus(dir)).toEqual({
      status: {
        provider: null,
        persistent: null,
        lastState: null,
        lastStateAt: null,
        lastError: null,
        outbox: {
          pending: 0,
          sending: 0,
          needsReview: 0,
          dead: 0,
          delivered: 0,
          oldestPendingAt: null,
        },
      },
      lease: { status: "none" },
    });
    const check = new DatabaseSync(join(dir, "haril.db"), { readOnly: true });
    try {
      expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    } finally {
      check.close();
    }
  });

  it("with a live writer reads its committed state and leaves its side files to it", () => {
    const fileStore = openStore({ dataDir: dir, clock, ids: sequentialIds(), rules: testRules });
    try {
      fileStore.memory.setState(acquire(fileStore), {
        provider: "fake-provider",
        state: "degraded",
        persistent: true,
        code: "Unavailable",
      });
      const before = readdirSync(dir).sort();
      expect(before).toEqual(["haril.db", "haril.db-shm", "haril.db-wal"]);
      expect(readMemoryStatus(dir)?.status).toMatchObject({
        provider: "fake-provider",
        lastState: "degraded",
      });
      expect(readdirSync(dir).sort()).toEqual(before);
    } finally {
      fileStore.close();
    }
  });
});
