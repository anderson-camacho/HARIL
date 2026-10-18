import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "../src/connection.js";
import { openStore, type StoreError } from "../src/index.js";
import { migrate } from "../src/migrate.js";
import { MIGRATION_0001 } from "../src/migrations/0001_init.js";
import { MIGRATION_0002 } from "../src/migrations/0002_budgets.js";
import { MIGRATION_0003 } from "../src/migrations/0003_task_model.js";
import { MIGRATION_0004 } from "../src/migrations/0004_approvals.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// File-backed behaviour: durability across reopen, migrations, immutability and the open gates.
let dir = "";
const dbPath = () => join(dir, "haril.db");

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function open(runtime?: { nodeVersion?: string; sqliteVersion?: string }, target = dir) {
  return openStore({
    dataDir: target,
    clock: fixedClock(),
    ids: sequentialIds(),
    rules: testRules,
    runtime,
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

// Raw connection used only to tamper with the file or to test the triggers from outside the store.
function raw(): DatabaseSync {
  return new DatabaseSync(dbPath());
}

describe("file store lifecycle", () => {
  it("creates the data directory and the database on first open", () => {
    const target = join(dir, "nested", "data");
    const store = open(undefined, target);
    store.close();
    expect(existsSync(join(target, "haril.db"))).toBe(true);
  });

  it("re-opening an existing database is idempotent and keeps the store identity", () => {
    const first = open();
    const storeId = first.info().storeId;
    first.close();

    const second = open();
    expect(second.info().storeId).toBe(storeId);
    expect(second.info().schemaVersion).toBe(10);
    second.close();

    const connection = raw();
    const rows = connection.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get();
    connection.close();
    expect(rows).toEqual({ n: 10 });
  });

  it("keeps committed commands and events across a reopen", () => {
    const first = open();
    first.commands.enqueue({ type: "task.add", args: {}, idempotencyKey: "k", requestHash: "h" });
    first.events.append({
      aggregateType: "task",
      aggregateId: "t",
      type: "task.created",
      actorKind: "system",
      actorId: "haril",
      payload: {},
    });
    first.close();

    const second = open();
    expect(second.commands.listQueued()).toHaveLength(1);
    expect(second.events.list()).toHaveLength(1);
    second.close();
  });

  it("events are append-only: UPDATE and DELETE are aborted by the triggers", () => {
    const store = open();
    store.events.append({
      aggregateType: "task",
      aggregateId: "t",
      type: "task.created",
      actorKind: "system",
      actorId: "haril",
      payload: {},
    });
    store.close();

    const connection = raw();
    expect(() => connection.exec("UPDATE events SET type = 'changed'")).toThrow(/append-only/);
    expect(() => connection.exec("DELETE FROM events")).toThrow(/append-only/);
    connection.close();
  });

  it("[INV-12] a migration whose checksum changed aborts the open", () => {
    open().close();
    const connection = raw();
    connection.exec("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    connection.close();

    const error = caught(() => open());
    expect(error.code).toBe("store.migration_failed");
  });

  it("[INV-12] rows for a newer migration are ignored, not validated or removed", () => {
    open().close();
    const connection = raw();
    connection.exec(
      "INSERT INTO schema_migrations (version, name, checksum, kind, applied_at, applied_by_release) " +
        "VALUES (99, '0099_future', 'future', 'additive', 0, '9.9.9')",
    );
    connection.close();

    const store = open();
    expect(store.info().schemaVersion).toBe(10);
    store.close();

    const check = raw();
    expect(
      check.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 99").get(),
    ).toEqual({
      n: 1,
    });
    check.close();
  });

  it("[INV-12] an approval written at schema 4 reads with no model after the upgrade (LD-T7a)", () => {
    // The release before schema 5: the first four migrations only, with one project and one requested approval.
    const before = raw();
    configureConnection(before, "wal");
    migrate(before, fixedClock(), sequentialIds(), [
      MIGRATION_0001,
      MIGRATION_0002,
      MIGRATION_0003,
      MIGRATION_0004,
    ]);
    before.exec(
      "INSERT INTO projects (project_id, slug, name, root_path, created_at) VALUES ('p-old', 'demo', 'Demo', 'D:/demo', 0)",
    );
    before.exec(
      `INSERT INTO approvals (approval_id, project_id, kind, subject, subject_sha256, status, requested_at, requested_by) VALUES ('a-old', 'p-old', 'plan', '{}', '${"0".repeat(64)}', 'requested', 0, 'cli')`,
    );
    before.close();

    const store = open();
    expect(store.info().schemaVersion).toBe(10);
    expect(store.approvals.get("a-old")).toMatchObject({ approvalId: "a-old", model: null });
    expect(store.approvals.list()).toEqual([expect.objectContaining({ model: null })]);
    store.close();

    // The new column takes a model id or nothing, never a blank one.
    const after = raw();
    expect(() =>
      after.exec("UPDATE approvals SET model = '  ' WHERE approval_id = 'a-old'"),
    ).toThrow(/CHECK/);
    after.close();
  });
});

describe("open gates", () => {
  it("[INV-16] a SQLite below 3.51.3 is refused before any file is created", () => {
    const target = join(dir, "blocked");
    const error = caught(() => open({ sqliteVersion: "3.50.7" }, target));
    expect(error.code).toBe("store.gate_failed");
    expect(error.details).toMatchObject({ gate: "sqlite" });
    expect(error.message).toMatch(/Remedy:/);
    expect(existsSync(target)).toBe(false);
  });

  it("a Node outside the range opens with a warning in the store info (M1-D1)", () => {
    const store = open({ nodeVersion: "v24.19.0" });
    const node = store.info().gates.find((gate) => gate.name === "node");
    expect(node?.status).toBe("warn");
    store.close();
  });

  it("a Node below 24 is refused before any file is created", () => {
    const target = join(dir, "old-node");
    const error = caught(() => open({ nodeVersion: "v22.12.0" }, target));
    expect(error.code).toBe("store.gate_failed");
    expect(existsSync(target)).toBe(false);
  });

  it("a database with a foreign application_id is refused", () => {
    open().close();
    const connection = raw();
    connection.exec("PRAGMA application_id = 42");
    connection.close();

    const error = caught(() => open());
    expect(error.code).toBe("store.gate_failed");
    expect(error.details).toMatchObject({ gate: "application_id" });
  });

  it("[INV-12] a database with a newer user_version is refused and never downgraded (TSK-21)", () => {
    open().close();
    const connection = raw();
    connection.exec("PRAGMA user_version = 99");
    connection.close();

    const error = caught(() => open());
    expect(error.code).toBe("store.gate_failed");
    expect(error.details).toMatchObject({ gate: "user_version" });
  });
});
