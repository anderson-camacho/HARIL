import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { BackupReport, StoreMaintenance } from "@haril/core/ports";
import { StoreError } from "./errors.js";

// Maintenance of the database file (ST-30, INV-11, INV-14). Runs outside any transaction: VACUUM INTO and
// wal_checkpoint must not share a connection with an open statement.
export interface MaintenanceOptions {
  readonly db: DatabaseSync;
  // The WAL file of the database; null for an in-memory store.
  readonly walPath: string | null;
}

export function createMaintenance(options: MaintenanceOptions): StoreMaintenance {
  return {
    backup: (destPath) => backupTo(options.db, destPath),
    checkpoint: () => ({ walBytes: checkpointWal(options.db, options.walPath) }),
  };
}

// A backup is written to a temporary file beside the destination and renamed only after it passes integrity_check.
// The existence check refuses an overwrite; the rename is the only write to the destination itself.
function backupTo(db: DatabaseSync, destPath: string): BackupReport {
  if (existsSync(destPath)) {
    throw new StoreError(
      "store.io",
      `backup destination ${destPath} already exists; a backup never overwrites a file`,
      {
        path: destPath,
      },
    );
  }
  const temporary = `${destPath}.${randomUUID()}.tmp`;
  try {
    db.prepare("VACUUM INTO ?").run(temporary);
    if (!copyPassesIntegrity(temporary)) {
      throw new StoreError(
        "store.io",
        `backup of ${destPath} failed integrity_check and was discarded`,
        {
          path: destPath,
        },
      );
    }
    renameSync(temporary, destPath);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof StoreError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new StoreError("store.io", `backup to ${destPath} failed: ${reason}`, { path: destPath });
  }
  return { path: destPath, size: statSync(destPath).size, quickCheckOk: true };
}

// Opens the copy read-only, the way an operator would check it, and reads its integrity.
function copyPassesIntegrity(path: string): boolean {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const row = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return row.integrity_check === "ok";
  } finally {
    copy.close();
  }
}

// TRUNCATE resets the WAL to zero bytes when no reader pins it. A reader still active leaves the WAL as it is:
// that is reported through walBytes, not as an error, because the next checkpoint after the reader ends succeeds.
function checkpointWal(db: DatabaseSync, walPath: string | null): number | null {
  if (walPath === null) return null;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new StoreError("store.io", `checkpoint failed: ${reason}`, { walPath });
  }
  return existsSync(walPath) ? statSync(walPath).size : 0;
}
