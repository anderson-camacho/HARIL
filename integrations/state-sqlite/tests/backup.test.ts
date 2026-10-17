import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type StoreError } from "../src/index.js";
import { killWriter, startWriter, waitUntil } from "./crash/writer-process.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// maintenance.backup (ST-30, RF-018, INV-11): VACUUM INTO to a temporary file, verification, then the rename.
let dir = "";

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(() => {
  removeTempDir(dir);
});

function openAt(dataDir = dir): Store {
  return openStore({
    dataDir,
    clock: fixedClock(),
    ids: sequentialIds(),
    rules: testRules,
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

// Opens a copy read-only, the way an operator would, and checks it outside the store.
function withCopy<T>(path: string, read: (copy: DatabaseSync) => T): T {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    return read(copy);
  } finally {
    copy.close();
  }
}

// The cross-table rule the schema guarantees: a task row and its task.created event are written in one transaction,
// so every task has exactly one creation event and every creation event has its task.
function assertCoherent(path: string): number {
  return withCopy(path, (copy) => {
    const integrity = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(integrity.integrity_check).toBe("ok");
    const orphanTasks = copy
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
         WHERE (SELECT COUNT(*) FROM events e WHERE e.type = 'task.created' AND e.aggregate_id = t.task_id) <> 1`,
      )
      .get() as { n: number };
    const orphanEvents = copy
      .prepare(
        `SELECT COUNT(*) AS n FROM events e
         WHERE e.type = 'task.created' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = e.aggregate_id)`,
      )
      .get() as { n: number };
    expect(orphanTasks.n).toBe(0);
    expect(orphanEvents.n).toBe(0);
    return (copy.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  });
}

describe("maintenance.backup [INV-11]", () => {
  it("[INV-11] refuses an existing destination and leaves it untouched", () => {
    const store = openAt();
    const dest = join(dir, "backup.db");
    writeFileSync(dest, "keep me");

    const error = caught(() => store.maintenance.backup(dest));
    expect(error.code).toBe("store.io");
    expect(readFileSync(dest, "utf8")).toBe("keep me");
    store.close();
  });

  it("[INV-11] writes a verified copy and reports its path, size and quick check", () => {
    const store = openAt();
    for (let n = 0; n < 3; n += 1) {
      store.events.append({
        aggregateType: "task",
        aggregateId: `t-${n}`,
        type: "task.progress",
        actorKind: "system",
        actorId: "haril",
        payload: { n },
      });
    }
    const dest = join(dir, "backup.db");
    const report = store.maintenance.backup(dest);
    store.close();

    expect(report.path).toBe(dest);
    expect(report.quickCheckOk).toBe(true);
    expect(report.size).toBe(statSync(dest).size);
    expect(report.size).toBeGreaterThan(0);
    expect(
      withCopy(
        dest,
        (copy) => (copy.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
      ),
    ).toBe(3);
    // The temporary file is renamed away: nothing but the store and the backup remain.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("[INV-11] a backup taken while another process writes is coherent and restorable", async () => {
    const seed = openAt();
    const projectId = seed.projects.register({
      slug: "demo",
      name: "Demo",
      rootPath: "D:/demo",
    }).projectId;
    seed.close();

    // Opened before the writer starts: every open runs BEGIN IMMEDIATE (migrate), which would queue behind a child
    // that writes back to back. Once open, the backup only reads, so it runs next to the writer without waiting.
    const store = openAt();
    const writer = startWriter(dir, projectId);
    await writer.ready;
    let lastCopy = "";
    let lastCount = 0;
    try {
      for (let round = 1; round <= 3; round += 1) {
        // Wait until the writer has committed more tasks, so each backup is taken during writes.
        const target = writer.confirmed.length + 5;
        await waitUntil(() => writer.confirmed.length >= target);
        const dest = join(dir, `backup-${round}.db`);
        const report = store.maintenance.backup(dest);
        expect(report.quickCheckOk).toBe(true);
        lastCount = assertCoherent(dest);
        expect(lastCount).toBeGreaterThan(0);
        lastCopy = dest;
      }
    } finally {
      store.close();
      await killWriter(writer);
    }

    // Restorable: the copy, put in its own data directory, opens as a store with the same tasks.
    const restoredDir = join(dir, "restored");
    mkdirSync(restoredDir);
    copyFileSync(lastCopy, join(restoredDir, "haril.db"));
    const restored = openAt(restoredDir);
    expect(restored.tasks.list()).toHaveLength(lastCount);
    restored.close();
  }, 120_000);
});
