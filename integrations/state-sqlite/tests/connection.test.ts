import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { configureConnection } from "../src/connection.js";

// A CLI read can open the store while the runtime holds a lock (seen in CI as "database is locked" from
// `haril status` next to a starting runtime). The busy timeout must apply before any PRAGMA that may need a lock,
// so the open waits for the lock instead of failing at once.

// Shorter than the 200 ms busy timeout the contract allows at most (ST-01), so the wait can succeed.
const HOLD_MS = 120;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// Starts a process that keeps an exclusive lock on a rollback-journal database, and resolves once it holds it.
function holdExclusiveLock(path: string): Promise<{ done: Promise<number | null> }> {
  const script = [
    'const { DatabaseSync } = require("node:sqlite");',
    "const db = new DatabaseSync(process.argv[1]);",
    'db.exec("BEGIN EXCLUSIVE");',
    'process.stdout.write("locked\\n");',
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});`,
    'db.exec("COMMIT");',
    "db.close();",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script, path], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const done = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) resolve({ done });
    });
    child.on("error", reject);
  });
}

describe("configureConnection", () => {
  it("waits for a lock held by another process instead of failing with database is locked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "haril-conn-"));
    dirs.push(dir);
    const path = join(dir, "haril.db");
    const seed = new DatabaseSync(path);
    seed.exec(
      "PRAGMA journal_mode = DELETE; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);",
    );
    seed.close();

    const holder = await holdExclusiveLock(path);
    const db = new DatabaseSync(path);
    try {
      // Switching a rollback-journal database to WAL needs the exclusive lock the other process holds.
      const pragmas = configureConnection(db, "wal");
      expect(pragmas.journalMode).toBe("wal");
      expect(pragmas.busyTimeoutMs).toBeGreaterThan(HOLD_MS);
      expect(pragmas.busyTimeoutMs).toBeLessThanOrEqual(200);
    } finally {
      db.close();
      // The holder must be gone before the directory is removed (Windows keeps open files locked).
      expect(await holder.done).toBe(0);
    }
  });
});
