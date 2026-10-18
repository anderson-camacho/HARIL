import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock, Ids } from "@haril/core/ports";
import { HARIL_APPLICATION_ID } from "./connection.js";
import { StoreError } from "./errors.js";
import { MIGRATION_0001 } from "./migrations/0001_init.js";
import { MIGRATION_0002 } from "./migrations/0002_budgets.js";
import { MIGRATION_0003 } from "./migrations/0003_task_model.js";
import { MIGRATION_0004 } from "./migrations/0004_approvals.js";
import { MIGRATION_0005 } from "./migrations/0005_approval_model.js";
import { MIGRATION_0006 } from "./migrations/0006_memory.js";
import { MIGRATION_0007 } from "./migrations/0007_delegation.js";
import { MIGRATION_0008 } from "./migrations/0008_settled_deps.js";
import { MIGRATION_0009 } from "./migrations/0009_model_stats_once.js";
import { MIGRATION_0010 } from "./migrations/0010_delegation_runtime.js";
import type { Migration } from "./migrations/types.js";

// Known migrations, in order. Adding one is an additive change; never edit an applied one (INV-12).
const KNOWN_MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
  MIGRATION_0004,
  MIGRATION_0005,
  MIGRATION_0006,
  MIGRATION_0007,
  MIGRATION_0008,
  MIGRATION_0009,
  MIGRATION_0010,
];
export const KNOWN_SCHEMA_VERSION = Math.max(...KNOWN_MIGRATIONS.map((m) => m.version));
const STORE_RELEASE = "0.1.0";

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// One transaction per migration (BEGIN IMMEDIATE), taken only for a pending one: an open of a current schema reads
// without a write lock, so it never waits for another writer (ARCH 8.4). A known version with a different checksum
// is corruption. `migrations` defaults to the release's list. It is a test-only seam (ARCH 13.2 CP8): the crash
// harness applies a list whose step kills the process, and production code always calls migrate with the default.
export function migrate(
  db: DatabaseSync,
  clock: Clock,
  ids: Ids,
  migrations: readonly Migration[] = KNOWN_MIGRATIONS,
): void {
  for (const migration of migrations) {
    if (isAppliedUnchanged(db, migration)) continue;
    applyOne(db, migration, clock, ids);
  }
}

// Read-only check (no transaction, so no lock). A pending migration returns false and is applied under the lock,
// where applyOne checks the row again.
function isAppliedUnchanged(db: DatabaseSync, migration: Migration): boolean {
  const applied = appliedChecksum(db, migration.version);
  if (applied === undefined) return false;
  const checksum = checksumOf(migration.sql);
  if (!knownChecksum(migration, applied)) throw checksumMismatch(migration, checksum, applied);
  return true;
}

function knownChecksum(migration: Migration, applied: string): boolean {
  return (
    applied === checksumOf(migration.sql) || (migration.previousChecksums ?? []).includes(applied)
  );
}

function checksumMismatch(migration: Migration, expected: string, found: string): StoreError {
  return new StoreError(
    "store.migration_failed",
    `migration ${migration.name} was applied with a different checksum. Remedy: restore the last backup; the database was changed outside HARIL.`,
    { version: migration.version, expected, found },
  );
}

function applyOne(db: DatabaseSync, migration: Migration, clock: Clock, ids: Ids): void {
  const checksum = checksumOf(migration.sql);
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied = appliedChecksum(db, migration.version);
    if (applied !== undefined) {
      db.exec("ROLLBACK");
      if (!knownChecksum(migration, applied)) throw checksumMismatch(migration, checksum, applied);
      return;
    }
    if (migration.version === 1) {
      // A fresh database claims the HRIL application id; a foreign one was refused by the gates.
      db.exec(`PRAGMA application_id = ${HARIL_APPLICATION_ID}`);
    }
    db.exec(migration.sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, kind, applied_at, applied_by_release) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(migration.version, migration.name, checksum, migration.kind, clock.now(), STORE_RELEASE);
    if (migration.version === 1) seedMeta(db, clock, ids);
    db.exec(`PRAGMA user_version = ${migration.version}`);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    if (error instanceof StoreError) throw error;
    throw new StoreError(
      "store.migration_failed",
      `migration ${migration.name} failed and was rolled back. Remedy: restore the last backup and report the release.`,
      { version: migration.version, cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function appliedChecksum(db: DatabaseSync, version: number): string | undefined {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (table === undefined) return undefined;
  const row = db.prepare("SELECT checksum FROM schema_migrations WHERE version = ?").get(version) as
    | { checksum: string }
    | undefined;
  return row?.checksum;
}

function seedMeta(db: DatabaseSync, clock: Clock, ids: Ids): void {
  const now = clock.now();
  const insert = db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)");
  insert.run("store_id", ids.next(), now);
  insert.run("created_at", String(now), now);
  insert.run("created_by_release", STORE_RELEASE, now);
}
