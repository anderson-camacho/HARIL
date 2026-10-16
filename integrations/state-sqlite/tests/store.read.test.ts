import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// Read queries used by `haril status` and `haril project init` (M1-T3, M1-T4). Rows that only the
// scheduler writes (tasks, runtime_leases) are inserted through a second connection to the file.
let dir = "";
let store: Store;

beforeEach(() => {
  dir = makeTempDir();
  store = openStore({ dataDir: dir, clock: fixedClock(), ids: sequentialIds(), rules: testRules });
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function rawWrite(action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(dir, "haril.db"));
  try {
    action(db);
  } finally {
    db.close();
  }
}

function insertTask(
  db: DatabaseSync,
  row: { taskId: string; projectId: string; goal: string; state: string; seq: number },
): void {
  db.prepare(
    `INSERT INTO tasks (task_id, project_id, goal, description, kind, agent_ref, budget_max_cost_micros,
       budget_max_tokens, budget_max_wall_ms, timeout_ms, max_attempts, state, created_seq, created_at, updated_at)
     VALUES (?, ?, ?, '', 'work', 'fake:succeed', 0, 1000, 60000, 60000, 1, ?, ?, ?, ?)`,
  ).run(row.taskId, row.projectId, row.goal, row.state, row.seq, row.seq, row.seq);
}

describe("projects with a manifest (projects.register and getByRootPath)", () => {
  it("stores the manifest hash and text and returns them with the record", () => {
    const project = store.projects.register({
      projectId: "PRJ-ALPHA",
      slug: "alpha",
      name: "Alpha",
      rootPath: "/work/alpha",
      manifestSha256: "abc123",
      manifestJson: '{"schemaVersion":1}',
    });
    expect(project.projectId).toBe("PRJ-ALPHA");
    expect(project.manifestSha256).toBe("abc123");
    expect(store.projects.getBySlug("alpha")?.manifestSha256).toBe("abc123");
  });

  it("uses a generated project id and a null manifest hash when none is given", () => {
    const project = store.projects.register({ slug: "beta", name: "Beta", rootPath: "/work/beta" });
    expect(project.projectId).toMatch(/^id-/);
    expect(project.manifestSha256).toBeNull();
  });

  it("finds a project by its canonical root path", () => {
    store.projects.register({ slug: "gamma", name: "Gamma", rootPath: "/work/gamma" });
    expect(store.projects.getByRootPath("/work/gamma")?.slug).toBe("gamma");
    expect(store.projects.getByRootPath("/work/unknown")).toBeUndefined();
  });
});

describe("tasks.list", () => {
  it("is empty until the scheduler applies the queue", () => {
    expect(store.tasks.list()).toEqual([]);
  });

  it("lists tasks in creation order and filters by project", () => {
    const alpha = store.projects.register({ slug: "alpha", name: "Alpha", rootPath: "/a" });
    const beta = store.projects.register({ slug: "beta", name: "Beta", rootPath: "/b" });
    rawWrite((db) => {
      insertTask(db, {
        taskId: "T-2",
        projectId: alpha.projectId,
        goal: "second",
        state: "ready",
        seq: 2,
      });
      insertTask(db, {
        taskId: "T-1",
        projectId: alpha.projectId,
        goal: "first",
        state: "failed",
        seq: 1,
      });
      insertTask(db, {
        taskId: "T-3",
        projectId: beta.projectId,
        goal: "other",
        state: "ready",
        seq: 3,
      });
    });

    const all = store.tasks.list();
    expect(all.map((task) => task.taskId)).toEqual(["T-1", "T-2", "T-3"]);
    expect(store.tasks.list({ projectId: alpha.projectId }).map((task) => task.goal)).toEqual([
      "first",
      "second",
    ]);
    expect(all[0]).toMatchObject({
      taskId: "T-1",
      projectId: alpha.projectId,
      state: "failed",
      agentRef: "fake:succeed",
      createdAt: 1,
    });
  });
});

describe("runtime.leaseSummary", () => {
  it("reports none before the first runtime starts", () => {
    expect(store.runtime.leaseSummary()).toEqual({ status: "none" });
  });

  it("reports the active lease, then released once it ends", () => {
    rawWrite((db) => {
      db.prepare(
        `INSERT INTO runtime_leases (instance_id, pid, pid_started_at, started_at, heartbeat_at, expires_at,
           status, clean_exit, released_at, node_version, sqlite_version)
         VALUES ('inst-1', 4242, 100, 100, 100, 200, 'active', NULL, NULL, 'v24.21.0', '3.53.3')`,
      ).run();
    });
    expect(store.runtime.leaseSummary()).toMatchObject({
      status: "active",
      instanceId: "inst-1",
      pid: 4242,
      nodeVersion: "v24.21.0",
      sqliteVersion: "3.53.3",
    });

    rawWrite((db) => {
      db.prepare(
        "UPDATE runtime_leases SET status = 'released', clean_exit = 1, released_at = 300 WHERE instance_id = 'inst-1'",
      ).run();
    });
    expect(store.runtime.leaseSummary()).toMatchObject({
      status: "released",
      instanceId: "inst-1",
    });
  });
});
