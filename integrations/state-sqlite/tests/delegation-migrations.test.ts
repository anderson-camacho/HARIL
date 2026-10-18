import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { migrate } from "../src/migrate.js";
import { MIGRATION_0001 } from "../src/migrations/0001_init.js";
import { MIGRATION_0002 } from "../src/migrations/0002_budgets.js";
import { MIGRATION_0003 } from "../src/migrations/0003_task_model.js";
import { MIGRATION_0004 } from "../src/migrations/0004_approvals.js";
import { MIGRATION_0005 } from "../src/migrations/0005_approval_model.js";
import { MIGRATION_0006 } from "../src/migrations/0006_memory.js";
import {
  fixedClock,
  makeTempDir,
  manualClock,
  removeTempDir,
  sequentialIds,
  testRules,
} from "./support.js";

// Migrations 0007 (delegation tables, the orders and usage logs, the new task columns) and 0008 (task_dependencies
// rebuilt to admit kind 'settled'), docs/modos-y-delegacion.md 4.1, 4.2 and 4.5.

const BEFORE_0007 = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
  MIGRATION_0006,
];

const NEW_TABLES = [
  "audits",
  "delegations",
  "model_cooldowns",
  "orders",
  "quota_samples",
  "usage_log",
  "workflows",
];

const NEW_TASK_COLUMNS = [
  "workflow_id",
  "layer",
  "role",
  "thread_id",
  "difficulty",
  "difficulty_reason",
  "model_pinned",
  "next_check_at",
  "local_id",
  "delegation_id",
];

let dir: string;

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function raw(): DatabaseSync {
  return new DatabaseSync(join(dir, "haril.db"));
}

function names(db: DatabaseSync, type: "table" | "view" | "index" | "trigger"): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name").all(type) as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe("migrations 0007 and 0008 on a fresh database", () => {
  it("reach the current schema with the delegation tables, the model_stats view and the new task columns", () => {
    const store = openStore({
      dataDir: dir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    try {
      expect(store.info().schemaVersion).toBe(15);
    } finally {
      store.close();
    }
    const db = raw();
    try {
      expect(names(db, "table")).toEqual(expect.arrayContaining(NEW_TABLES));
      expect(names(db, "view")).toContain("model_stats");
      expect(columns(db, "tasks")).toEqual(expect.arrayContaining(NEW_TASK_COLUMNS));
      expect(names(db, "trigger")).toEqual(
        expect.arrayContaining([
          "orders_no_update",
          "orders_no_delete",
          "usage_log_no_update",
          "usage_log_no_delete",
          "audits_no_update",
          "audits_no_delete",
          "delegations_no_update",
          "delegations_no_delete",
        ]),
      );
      const kinds = db
        .prepare(
          "SELECT version, name, kind FROM schema_migrations WHERE version >= 7 ORDER BY version",
        )
        .all();
      expect(kinds).toEqual([
        { version: 7, name: "delegation", kind: "additive" },
        { version: 8, name: "settled_deps", kind: "incompatible" },
        { version: 9, name: "model_stats_once", kind: "additive" },
        { version: 10, name: "delegation_runtime", kind: "additive" },
        { version: 11, name: "process_gone", kind: "additive" },
        { version: 12, name: "process_identity", kind: "additive" },
        { version: 13, name: "quota_batches", kind: "additive" },
        { version: 14, name: "worktrees", kind: "additive" },
        { version: 15, name: "run_commands", kind: "additive" },
      ]);
    } finally {
      db.close();
    }
  });

  it("admits a settled dependency and still refuses an unknown dependency kind", () => {
    const store = openStore({
      dataDir: dir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    const projectId = store.projects.register({ slug: "p", name: "P", rootPath: "D:/p" }).projectId;
    store.close();
    const db = raw();
    try {
      const insertTask = db.prepare(
        "INSERT INTO tasks (task_id, project_id, goal, description, kind, agent_ref, budget_max_cost_micros, budget_max_tokens, budget_max_wall_ms, timeout_ms, max_attempts, state, created_seq, created_at, updated_at) VALUES (?, ?, 'g', '', 'work', 'fake:succeed', 0, 0, 0, 1000, 1, 'pending', ?, 1, 1)",
      );
      insertTask.run("t-1", projectId, 1);
      insertTask.run("t-2", projectId, 2);
      const insertDep = db.prepare(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)",
      );
      insertDep.run("t-2", "t-1", "settled");
      expect(() => insertDep.run("t-1", "t-2", "whenever")).toThrow(/CHECK/);
      expect(db.prepare("SELECT kind FROM task_dependencies").all()).toEqual([{ kind: "settled" }]);
    } finally {
      db.close();
    }
  });
});

describe("migrations 0007 and 0008 on a database at schema 6", () => {
  it("apply without losing tasks or dependencies, and keep the dependency index and foreign keys", () => {
    const db = raw();
    migrate(db, manualClock(), sequentialIds("old"), BEFORE_0007);
    db.exec(`
      INSERT INTO projects (project_id, slug, name, root_path, created_at) VALUES ('p-old', 'old', 'Old', 'D:/old', 1);
      INSERT INTO tasks (task_id, project_id, goal, description, kind, agent_ref, budget_max_cost_micros, budget_max_tokens, budget_max_wall_ms, timeout_ms, max_attempts, state, created_seq, created_at, updated_at)
        VALUES ('t-a', 'p-old', 'A', '', 'work', 'fake:succeed', 0, 0, 0, 1000, 1, 'ready', 1, 1, 1),
               ('t-b', 'p-old', 'B', '', 'work', 'fake:succeed', 0, 0, 0, 1000, 1, 'pending', 2, 1, 1);
      INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('t-b', 't-a');
    `);
    db.close();

    const store = openStore({
      dataDir: dir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    try {
      expect(store.info().schemaVersion).toBe(15);
      expect(store.tasks.get("t-b")).toMatchObject({
        goal: "B",
        state: "pending",
        dependsOn: ["t-a"],
      });
    } finally {
      store.close();
    }

    const after = raw();
    try {
      expect(
        after.prepare("SELECT task_id, depends_on_task_id, kind FROM task_dependencies").all(),
      ).toEqual([{ task_id: "t-b", depends_on_task_id: "t-a", kind: "completed" }]);
      expect(names(after, "index")).toContain("ix_task_deps_reverse");
      expect(after.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        after
          .prepare(
            "SELECT workflow_id, layer, role, thread_id, model_pinned FROM tasks WHERE task_id = 't-a'",
          )
          .get(),
      ).toEqual({ workflow_id: null, layer: null, role: null, thread_id: null, model_pinned: 0 });
    } finally {
      after.close();
    }
  });
});

describe("tasks.promote with settled dependencies (3.7)", () => {
  let store: Store;
  let projectId: string;
  let epoch: number;
  let keySeq = 0;

  beforeEach(() => {
    store = openStore({
      dataDir: dir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    projectId = store.projects.register({
      slug: "demo",
      name: "Demo",
      rootPath: "D:/demo",
    }).projectId;
    const grant = store.runtime.acquire({
      pid: 1,
      nodeVersion: "v24.21.0",
      sqliteVersion: "3.53.3",
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    epoch = grant.value.epoch;
  });

  afterEach(() => {
    store.close();
  });

  function enqueueTask(goal: string, dependsOn: string[] = []): string {
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: { goal, dependsOn, agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
      idempotencyKey: `k-${++keySeq}`,
      requestHash: `h-${keySeq}`,
    });
    store.commands.applyNext(epoch);
    const task = store.tasks.list().find((candidate) => candidate.goal === goal);
    if (task === undefined) throw new Error(`no task "${goal}"`);
    return task.taskId;
  }

  // The store exposes no settled dependency yet outside the delegation module, so the test sets the kind directly.
  function makeSettled(taskId: string): void {
    const db = raw();
    try {
      db.prepare("UPDATE task_dependencies SET kind = 'settled' WHERE task_id = ?").run(taskId);
    } finally {
      db.close();
    }
  }

  function finishFirstClaim(outcome: "succeeded" | "failed"): void {
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimable");
    if (outcome === "succeeded") {
      store.runs.complete({ runId: claimed.runId, outcome, result: { ok: true } });
    } else {
      store.runs.complete({
        runId: claimed.runId,
        outcome,
        error: { code: "fake.failed", message: "boom" },
        endCause: "exit",
      });
    }
  }

  it("readies a task once a settled dependency failed, where a completed dependency would block it", () => {
    const child = enqueueTask("child");
    const continuation = enqueueTask("continuation", [child]);
    const strict = enqueueTask("strict", [child]);
    makeSettled(continuation);
    finishFirstClaim("failed");

    const result = store.tasks.promote();

    expect(result.ready.map((task) => task.goal)).toEqual(["continuation"]);
    expect(result.blocked.map((task) => task.goal)).toEqual(["strict"]);
    expect(store.tasks.get(continuation)).toMatchObject({ state: "ready" });
    expect(store.tasks.get(strict)).toMatchObject({ state: "blocked", blockReason: "dep_failed" });
  });

  it("counts a dependency blocked by an earlier failure as settled", () => {
    const root = enqueueTask("root");
    const middle = enqueueTask("middle", [root]);
    const continuation = enqueueTask("continuation", [middle]);
    makeSettled(continuation);
    finishFirstClaim("failed");

    store.tasks.promote();

    expect(store.tasks.get(middle)).toMatchObject({ state: "blocked", blockReason: "dep_failed" });
    expect(store.tasks.get(continuation)).toMatchObject({ state: "ready" });
  });

  it("keeps a task pending while a settled dependency still runs, and readies it after a success", () => {
    const child = enqueueTask("child");
    const continuation = enqueueTask("continuation", [child]);
    makeSettled(continuation);
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimable");

    expect(store.tasks.promote()).toEqual({ ready: [], blocked: [] });
    expect(store.tasks.get(continuation)).toMatchObject({ state: "pending" });

    store.runs.complete({ runId: claimed.runId, outcome: "succeeded", result: { ok: true } });
    expect(store.tasks.promote().ready.map((task) => task.goal)).toEqual(["continuation"]);
  });
});

describe("the 0008 copy keeps the declaration order", () => {
  it("copies task_dependencies in rowid order, and refuses any other recorded checksum of 0008", () => {
    const db = raw();
    migrate(db, manualClock(), sequentialIds("old"), BEFORE_0007);
    db.exec(`
      INSERT INTO projects (project_id, slug, name, root_path, created_at) VALUES ('p-old', 'old', 'Old', 'D:/old', 1);
      INSERT INTO tasks (task_id, project_id, goal, description, kind, agent_ref, budget_max_cost_micros, budget_max_tokens, budget_max_wall_ms, timeout_ms, max_attempts, state, created_seq, created_at, updated_at)
        VALUES ('t-z', 'p-old', 'Z', '', 'work', 'fake:succeed', 0, 0, 0, 1000, 1, 'ready', 1, 1, 1),
               ('t-a', 'p-old', 'A', '', 'work', 'fake:succeed', 0, 0, 0, 1000, 1, 'ready', 2, 1, 1),
               ('t-m', 'p-old', 'M', '', 'work', 'fake:succeed', 0, 0, 0, 1000, 1, 'pending', 3, 1, 1);
      INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('t-m', 't-z');
      INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('t-m', 't-a');
    `);
    db.close();
    const store = openStore({
      dataDir: dir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    store.close();
    const after = raw();
    try {
      expect(
        after
          .prepare("SELECT depends_on_task_id AS dep FROM task_dependencies ORDER BY rowid")
          .all(),
      ).toEqual([{ dep: "t-z" }, { dep: "t-a" }]);
    } finally {
      after.close();
    }
    const reopened = openStore({
      dataDir: dir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    reopened.close();
    // An applied migration is never edited, so no earlier text of 0008 is accepted: the first text (never released, so
    // no database recorded it) is refused like any other checksum.
    for (const checksum of [
      "1e317b000746f60b688ffa61ed8e83f5de6081e8488be97bb81a9411f0fe2b6c",
      "f".repeat(64),
    ]) {
      const tampered = raw();
      tampered.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 8").run(checksum);
      tampered.close();
      expect(() =>
        openStore({ dataDir: dir, clock: fixedClock(), ids: sequentialIds(), rules: testRules }),
      ).toThrow(/different checksum/);
    }
  });
});

describe("the results a continuation receives from its settled dependencies (3.7)", () => {
  it("names a child that failed, was blocked or completed, with the failure's code and message", () => {
    const dataDir = makeTempDir();
    const store = openStore({
      dataDir,
      clock: fixedClock(),
      ids: sequentialIds(),
      rules: testRules,
    });
    try {
      const projectId = store.projects.register({
        slug: "p",
        name: "P",
        rootPath: dataDir,
      }).projectId;
      const grant = store.runtime.acquire({
        pid: 1,
        nodeVersion: "v24.21.0",
        sqliteVersion: store.info().sqliteVersion,
        ttlMs: 60_000,
      });
      if (!grant.ok) throw new Error("lease not granted");
      const epoch = grant.value.epoch;
      let key = 0;
      const add = (goal: string, dependsOn: string[] = []): string => {
        store.commands.enqueue({
          type: "task.create",
          projectId,
          args: { goal, dependsOn, agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
          idempotencyKey: `k-${++key}`,
          requestHash: `h-${key}`,
        });
        store.commands.applyNext(epoch);
        return store.tasks.list().find((task) => task.goal === goal)?.taskId as string;
      };
      const good = add("good");
      const bad = add("bad");
      const after = add("after bad", [bad]);
      const continuation = add("continuation", [good, bad, after]);
      const db = new DatabaseSync(join(dataDir, "haril.db"));
      db.prepare("UPDATE task_dependencies SET kind = 'settled' WHERE task_id = ?").run(
        continuation,
      );
      db.close();
      for (const outcome of ["succeeded", "failed"] as const) {
        const claimed = store.tasks.claimNext(epoch);
        if (claimed === undefined) throw new Error("nothing claimable");
        if (outcome === "succeeded") {
          store.runs.complete({ runId: claimed.runId, outcome, result: { summary: "fine" } });
        } else {
          store.runs.complete({
            runId: claimed.runId,
            outcome,
            error: { code: "fake.failed", message: "boom" },
            endCause: "exit",
          });
        }
      }
      store.tasks.promote();
      const claimed = store.tasks.claimNext(epoch);
      expect(claimed?.taskId).toBe(continuation);
      expect(claimed?.dependencyResults).toEqual([
        { taskId: good, goal: "good", result: { summary: "fine" } },
        {
          taskId: bad,
          goal: "bad",
          result: null,
          failure: { state: "failed", code: "fake.failed", message: "boom" },
        },
        {
          taskId: after,
          goal: "after bad",
          result: null,
          failure: { state: "blocked", code: "dep_failed", message: "a task it depends on failed" },
        },
      ]);
    } finally {
      store.close();
      removeTempDir(dataDir);
    }
  });
});
