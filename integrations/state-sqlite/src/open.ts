import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, Ids, Store, StoreGate, StoreRules } from "@haril/core/ports";
import { withBusyRetry } from "./busy.js";
import {
  configureConnection,
  DB_FILE_NAME,
  isForeignApplication,
  probeSqliteVersion,
  readApplicationId,
  readUserVersion,
  SYNCHRONOUS_FULL,
  WAL_AUTOCHECKPOINT_PAGES,
} from "./connection.js";
import { foreignApplicationError, StoreError } from "./errors.js";
import { evaluateGates, hasErrorGate, type RuntimeVersions } from "./gates.js";
import { checkDataLocation } from "./location.js";
import { KNOWN_SCHEMA_VERSION, migrate } from "./migrate.js";
import { SqliteStore } from "./store.js";

export interface OpenStoreOptions {
  // Directory that holds haril.db; created on open when every gate passes.
  readonly dataDir: string;
  readonly clock: Clock;
  readonly ids: Ids;
  // Core rules injected by the composition root (transition table, plan checks).
  readonly rules: StoreRules;
  // Test hook: overrides the detected Node and SQLite versions (M1-D1, INV-16).
  readonly runtime?: Partial<RuntimeVersions>;
  // Liveness of a lease holder's pid, injected by the composition root (M1 fix c). Absent: every pid is alive.
  readonly isPidAlive?: (pid: number) => boolean;
  // Environment read by the OneDrive part of the location gate (INV-13). Absent: process.env.
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface OpenMemoryStoreOptions {
  readonly clock: Clock;
  readonly ids: Ids;
  readonly rules: StoreRules;
  readonly runtime?: Partial<RuntimeVersions>;
  readonly isPidAlive?: (pid: number) => boolean;
}

// Opens (and migrates) the file database. The gates run before any directory or file is created; the location gate
// runs first, so a refused data root (OneDrive, UNC, WSL) never gets a directory (INV-13).
export function openStore(options: OpenStoreOptions): Store {
  const location = checkDataLocation(options.dataDir, options.env ?? process.env);
  const versions = resolveVersions(options.runtime);
  const gates = [location, ...evaluateGates(versions)];
  if (hasErrorGate(gates)) throw gateError(gates);
  mkdirSync(options.dataDir, { recursive: true });
  const file = join(options.dataDir, DB_FILE_NAME);
  const walPath = join(options.dataDir, `${DB_FILE_NAME}-wal`);
  // Each attempt opens its own connection: openConnection closes the one it was given when it fails.
  return withBusyRetry(() =>
    openConnection(new DatabaseSync(file), options, versions, gates, "wal", walPath),
  );
}

// Same store over ":memory:", for the contract suite (M1-D3). Nothing touches the disk.
export function openMemoryStore(options: OpenMemoryStoreOptions): Store {
  const versions = resolveVersions(options.runtime);
  const gates = evaluateGates(versions);
  if (hasErrorGate(gates)) throw gateError(gates);
  const db = new DatabaseSync(":memory:");
  return openConnection(db, options, versions, gates, "memory", null);
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
  options: OpenMemoryStoreOptions,
  versions: RuntimeVersions,
  gates: readonly StoreGate[],
  journalMode: "wal" | "memory",
  walPath: string | null,
): Store {
  const { clock, ids, rules } = options;
  try {
    const pragmas = configureConnection(db, journalMode);
    const journalOk = pragmas.journalMode === (journalMode === "wal" ? "wal" : "memory");
    const checkpointOk = pragmas.walAutocheckpoint === WAL_AUTOCHECKPOINT_PAGES;
    if (
      !journalOk ||
      pragmas.synchronous !== SYNCHRONOUS_FULL ||
      !pragmas.foreignKeys ||
      !checkpointOk
    ) {
      throw new StoreError(
        "store.gate_failed",
        "the connection PRAGMAs did not stick (journal_mode, synchronous, foreign_keys, wal_autocheckpoint). Remedy: move the data directory to a local disk (INV-13).",
        { gate: "pragmas", pragmas },
      );
    }
    const applicationId = readApplicationId(db);
    if (isForeignApplication(applicationId)) throw foreignApplicationError(applicationId);
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
      rules,
      isPidAlive: options.isPidAlive ?? (() => true),
      storeId,
      sqliteVersion: versions.sqliteVersion,
      gates,
      walPath,
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
