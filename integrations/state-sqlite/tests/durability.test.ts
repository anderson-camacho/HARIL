import { statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { killWriter, startWriter, waitUntil } from "./crash/writer-process.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// Durability of the file store under a crash (INV-09) and a bounded WAL with a long reader (INV-14).
const WAL_AUTOCHECKPOINT_PAGES = 1000;
const KILL_ROUNDS = 5;
let dir = "";
const dbPath = () => join(dir, "haril.db");

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

function createProject(store: Store): string {
  return store.projects.register({ slug: "demo", name: "Demo", rootPath: "D:/demo" }).projectId;
}

// Raw read of the file, outside the store: the same check an operator runs on a copy of the database.
function integrityOf(path: string): string {
  const connection = new DatabaseSync(path);
  try {
    const row = connection.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return row.integrity_check;
  } finally {
    connection.close();
  }
}

// Random pause between the child's first confirmed commit and the kill, so the kill lands at varied points.
function randomPauseMs(): number {
  return 20 + Math.floor(Math.random() * 380);
}

describe("store durability", () => {
  it("[INV-14] wal_autocheckpoint is 1000 pages and reads back on open", () => {
    const store = openAt();
    expect(store.info().pragmas.walAutocheckpoint).toBe(WAL_AUTOCHECKPOINT_PAGES);
    store.close();
  });

  it("[INV-09] kill -9 during committed writes keeps integrity_check ok and every confirmed task present", async () => {
    const store = openAt();
    const projectId = createProject(store);
    store.close();

    const confirmed: string[] = [];
    for (let round = 1; round <= KILL_ROUNDS; round += 1) {
      const writer = startWriter(dir, projectId);
      await writer.ready;
      // Let the child commit at least one task before the kill, then kill at a random moment after that.
      await waitUntil(() => writer.confirmed.length > 0);
      await new Promise((resolve) => setTimeout(resolve, randomPauseMs()));
      confirmed.push(...(await killWriter(writer)));

      expect(integrityOf(dbPath()), `round ${round}`).toBe("ok");

      const reopened = openAt();
      for (const taskId of confirmed) {
        expect(reopened.tasks.get(taskId), `round ${round}: ${taskId}`).toBeDefined();
      }
      reopened.close();
    }
    expect(confirmed.length).toBeGreaterThan(0);
  }, 120_000);

  it("[INV-14] a long reader pins the WAL, writes keep going, and a checkpoint after the reader ends bounds it", () => {
    const store = openAt();
    const pageSize = (() => {
      const connection = new DatabaseSync(dbPath());
      try {
        return (connection.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      } finally {
        connection.close();
      }
    })();
    const bound = WAL_AUTOCHECKPOINT_PAGES * pageSize;
    const walPath = `${dbPath()}-wal`;

    // A read transaction that stays open: it pins the snapshot, so the WAL cannot be reset past it.
    const reader = new DatabaseSync(dbPath());
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM events").get();

    const payload = { text: "x".repeat(40_000) };
    for (let n = 0; n < 200; n += 1) {
      store.events.append({
        aggregateType: "task",
        aggregateId: `t-${n}`,
        type: "task.progress",
        actorKind: "system",
        actorId: "haril",
        payload,
      });
    }
    // Writes went on past the auto-checkpoint size: the reader kept the WAL from being reset.
    expect(statSync(walPath).size).toBeGreaterThan(bound);

    reader.exec("COMMIT");
    reader.close();

    const { walBytes } = store.maintenance.checkpoint();
    expect(walBytes).not.toBeNull();
    expect(walBytes ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(bound);
    expect(statSync(walPath).size).toBeLessThanOrEqual(bound);
    store.close();
  }, 60_000);
});
