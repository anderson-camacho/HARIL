import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, Ids, Store, StoreGate } from "@haril/core/ports";
import {
  configureConnection,
  DB_FILE_NAME,
  HARIL_APPLICATION_ID,
  probeSqliteVersion,
  readApplicationId,
  readUserVersion,
  SYNCHRONOUS_FULL,
} from "./connection.js";
import { StoreError } from "./errors.js";
import { evaluateGates, hasErrorGate, type RuntimeVersions } from "./gates.js";
import { KNOWN_SCHEMA_VERSION, migrate } from "./migrate.js";
import { SqliteStore } from "./store.js";

export interface OpenStoreOptions {
  // Directory that holds haril.db; created on open when every gate passes.
  readonly dataDir: string;
  readonly clock: Clock;
  readonly ids: Ids;
  // Test hook: overrides the detected Node and SQLite versions (M1-D1, INV-16).
  readonly runtime?: Partial<RuntimeVersions>;
}

export interface OpenMemoryStoreOptions {
  readonly clock: Clock;
  readonly ids: Ids;
  readonly runtime?: Partial<RuntimeVersions>;
}

// Opens (and migrates) the file database. The gates run before any directory or file is created.
export function openStore(options: OpenStoreOptions): Store {
  const versions = resolveVersions(options.runtime);
  const gates = evaluateGates(versions);
  if (hasErrorGate(gates)) throw gateError(gates);
  mkdirSync(options.dataDir, { recursive: true });
  const db = new DatabaseSync(join(options.dataDir, DB_FILE_NAME));
  return openConnection(db, options.clock, options.ids, versions, gates, "wal");
}

// Same store over ":memory:", for the contract suite (M1-D3). Nothing touches the disk.
export function openMemoryStore(options: OpenMemoryStoreOptions): Store {
  const versions = resolveVersions(options.runtime);
  const gates = evaluateGates(versions);
  if (hasErrorGate(gates)) throw gateError(gates);
  const db = new DatabaseSync(":memory:");
  return openConnection(db, options.clock, options.ids, versions, gates, "memory");
}

function resolveVersions(runtime?: Partial<RuntimeVersions>): RuntimeVersions {
  return {
    nodeVersion: runtime?.nodeVersion ?? process.version,
    sqliteVersion: runtime?.sqliteVersion ?? probeSqliteVersion(),
  };
}

function gateError(gates: readonly StoreGate[]): StoreError {
  const failed = gates.filter((gate) => gate.status === "error");
  const first = failed[0];
  return new StoreError(
    "store.gate_failed",
    `store gate "${first?.name ?? "unknown"}" failed: ${failed.map((gate) => gate.detail).join(" ")}`,
    { gate: first?.name ?? "unknown", gates: failed },
  );
}

function openConnection(
  db: DatabaseSync,
  clock: Clock,
  ids: Ids,
  versions: RuntimeVersions,
  gates: readonly StoreGate[],
  journalMode: "wal" | "memory",
): Store {
  try {
    const pragmas = configureConnection(db, journalMode);
    const journalOk = pragmas.journalMode === (journalMode === "wal" ? "wal" : "memory");
    if (!journalOk || pragmas.synchronous !== SYNCHRONOUS_FULL || !pragmas.foreignKeys) {
      throw new StoreError(
        "store.gate_failed",
        "the connection PRAGMAs did not stick (journal_mode, synchronous, foreign_keys). Remedy: move the data directory to a local disk (INV-13).",
        { gate: "pragmas", pragmas },
      );
    }
    const applicationId = readApplicationId(db);
    if (applicationId !== 0 && applicationId !== HARIL_APPLICATION_ID) {
      throw new StoreError(
        "store.gate_failed",
        "haril.db belongs to another application (application_id differs). Remedy: point HARIL_HOME or --data-dir at a HARIL data directory.",
        { gate: "application_id", applicationId },
      );
    }
    const userVersion = readUserVersion(db);
    if (userVersion > KNOWN_SCHEMA_VERSION) {
      throw new StoreError(
        "store.gate_failed",
        `haril.db has schema ${userVersion}, newer than this release knows (${KNOWN_SCHEMA_VERSION}). Remedy: update HARIL; a migrated database is never downgraded.`,
        { gate: "user_version", userVersion, known: KNOWN_SCHEMA_VERSION },
      );
    }
    migrate(db, clock, ids);
    const storeId = readMetaValue(db, "store_id");
    return new SqliteStore({
      db,
      clock,
      ids,
      storeId,
      sqliteVersion: versions.sqliteVersion,
      gates,
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

function readMetaValue(db: DatabaseSync, key: string): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) {
    throw new StoreError("store.migration_failed", `meta.${key} is missing after migration`, {
      key,
    });
  }
  return row.value;
}
