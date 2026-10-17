import { DatabaseSync } from "node:sqlite";
import type { StorePragmas } from "@haril/core/ports";

// Connection setup shared by the store and the read-only inspection.
export const DB_FILE_NAME = "haril.db";
const BUSY_TIMEOUT_MS = 200;
export const SYNCHRONOUS_FULL = 2;
// ARCH 8.4: the WAL is checkpointed automatically every 1000 pages (INV-14). Read back like the other PRAGMAs.
export const WAL_AUTOCHECKPOINT_PAGES = 1000;

// "HRIL" as a big-endian integer (PRAGMA application_id).
export const HARIL_APPLICATION_ID = 0x4852494c;

export function probeSqliteVersion(): string {
  const memory = new DatabaseSync(":memory:");
  try {
    const row = memory.prepare("SELECT sqlite_version() AS version").get() as { version: string };
    return row.version;
  } finally {
    memory.close();
  }
}

// Applies the PRAGMAs and reads them back: a value that did not stick aborts the open (TSK-20).
export function configureConnection(db: DatabaseSync, journalMode: "wal" | "memory"): StorePragmas {
  // First: every later PRAGMA may need a lock (switching to WAL needs an exclusive one), and without the timeout a
  // lock held by the runtime fails the open at once with "database is locked" instead of waiting.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA journal_mode = ${journalMode === "wal" ? "WAL" : "MEMORY"}`);
  db.exec(`PRAGMA synchronous = FULL`);
  db.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA trusted_schema = OFF`);
  return readPragmas(db);
}

export function readPragmas(db: DatabaseSync): StorePragmas {
  const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
  const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  const autocheckpoint = db.prepare("PRAGMA wal_autocheckpoint").get() as {
    wal_autocheckpoint: number;
  };
  return {
    journalMode: journal.journal_mode.toLowerCase(),
    synchronous: sync.synchronous,
    foreignKeys: fk.foreign_keys === 1,
    busyTimeoutMs: busy.timeout,
    walAutocheckpoint: autocheckpoint.wal_autocheckpoint,
  };
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function readApplicationId(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA application_id").get() as { application_id: number };
  return row.application_id;
}
