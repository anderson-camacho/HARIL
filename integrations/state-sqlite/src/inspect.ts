import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoreGate } from "@haril/core/ports";
import { DB_FILE_NAME, probeSqliteVersion, readUserVersion } from "./connection.js";
import { evaluateGates, type RuntimeVersions } from "./gates.js";
import { KNOWN_SCHEMA_VERSION } from "./migrate.js";

export interface StoreInspection {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly initialized: boolean;
  readonly sqliteVersion: string;
  readonly schemaVersion: number | null;
  readonly gates: readonly StoreGate[];
  readonly error?: string;
}

export interface InspectStoreOptions {
  readonly dataDir: string;
  readonly runtime?: Partial<RuntimeVersions>;
}

// Read-only description of the store for `haril doctor`. It never creates the directory or the database.
export function inspectStore(options: InspectStoreOptions): StoreInspection {
  const sqliteVersion = options.runtime?.sqliteVersion ?? probeSqliteVersion();
  const nodeVersion = options.runtime?.nodeVersion ?? process.version;
  const gates = evaluateGates({ nodeVersion, sqliteVersion });
  const dbPath = join(options.dataDir, DB_FILE_NAME);
  const base = { dataDir: options.dataDir, dbPath, sqliteVersion };

  if (!existsSync(dbPath)) {
    return { ...base, initialized: false, schemaVersion: null, gates };
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const schemaVersion = readUserVersion(db);
    const extra: StoreGate[] =
      schemaVersion > KNOWN_SCHEMA_VERSION
        ? [
            {
              name: "user_version",
              status: "error",
              detail: `schema ${schemaVersion} is newer than this release knows (${KNOWN_SCHEMA_VERSION}). Remedy: update HARIL.`,
            },
          ]
        : [];
    return { ...base, initialized: true, schemaVersion, gates: [...gates, ...extra] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, initialized: true, schemaVersion: null, gates, error: message };
  } finally {
    db?.close();
  }
}
