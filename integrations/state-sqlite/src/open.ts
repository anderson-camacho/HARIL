import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clock, Ids, Store, StoreGate, StoreRules } from "@haril/core/ports";
import {
  configureConnection,
  DB_FILE_NAME,
  HARIL_APPLICATION_ID,
  probeSqliteVersion,
  readApplicationId,
  readUserVersion,
  SYNCHRONOUS_FULL,
  WAL_AUTOCHECKPOINT_PAGES,
} from "./connection.js";
import { StoreError } from "./errors.js";
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

// ARCH 8.4: a busy open is retried with a short, bounded backoff. The busy timeout of each attempt stays at 200 ms
// (ST-01); the whole retry budget is about 2 s, so a lock held longer than that still fails the open with its error.
const BUSY_RETRY_BUDGET_MS = 2000;
const BUSY_BACKOFF_START_MS = 10;
const BUSY_BACKOFF_CAP_MS = 250;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function withBusyRetry<T>(attempt: () => T): T {
  const deadline = Date.now() + BUSY_RETRY_BUDGET_MS;
  let delay = BUSY_BACKOFF_START_MS;
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (!isBusy(error) || Date.now() + delay > deadline) throw error;
      // Synchronous wait: the store API is synchronous and the open runs on the main thread.
      Atomics.wait(sleepCell, 0, 0, delay);
      delay = Math.min(delay * 2, BUSY_BACKOFF_CAP_MS);
    }
  }
}

const BUSY_MESSAGE = /database is locked|SQLITE_BUSY/;

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (BUSY_MESSAGE.test(error.message)) return true;
  // A migration failure wraps the driver message in its details.
  return error instanceof StoreError && BUSY_MESSAGE.test(String(error.details.cause ?? ""));
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
