import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { type ChildRun, sleep, startChild } from "./crash/child-process.js";
import { fixedClock, makeTempDir, removeTempDir, sequentialIds, testRules } from "./support.js";

// Opening the store next to another process that writes (ARCH 8.4: busy_timeout 200 ms and bounded retries).
// An open of a current schema takes no write lock; an open that must migrate waits for the lock with a bounded retry.
let dir = "";
const dbPath = () => join(dir, "haril.db");
const children: ChildRun[] = [];

beforeEach(() => {
  dir = makeTempDir();
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.child.kill("SIGKILL");
    await child.exited;
  }
  removeTempDir(dir);
});

function openAt(): Store {
  return openStore({
    dataDir: dir,
    clock: fixedClock(),
    ids: sequentialIds(),
    rules: testRules,
  });
}

describe("opening the store next to a busy writer", () => {
  it("every open of a current database succeeds while another process commits back to back", async () => {
    openAt().close();
    const churn = startChild("churner.mjs", [dbPath(), "10000"]);
    children.push(churn);
    await churn.ready;

    let opened = 0;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      // Any open that throws "database is locked" fails the test here, with its message.
      openAt().close();
      opened += 1;
      await sleep(5);
    }
    expect(opened).toBeGreaterThan(10);
  }, 60_000);

  it("an open that must migrate waits for a lock held for one second instead of failing at once", async () => {
    // A WAL database at user_version 0: the open has a pending migration, so it needs the write lock.
    const seed = new DatabaseSync(dbPath());
    seed.exec("PRAGMA journal_mode = WAL");
    seed.close();
    const holder = startChild("lock-holder.mjs", [dbPath(), "1000"]);
    children.push(holder);
    await holder.ready;

    const store = openAt();
    expect(store.info().schemaVersion).toBeGreaterThan(0);
    store.close();
    expect(await holder.exited).toBe(0);
  }, 60_000);

  it("a write waits for a lock held longer than the busy timeout instead of failing at once", async () => {
    const store = openAt();
    try {
      // Held three times the 200 ms busy timeout, within the retry budget: a single BEGIN IMMEDIATE would fail.
      const holder = startChild("lock-holder.mjs", [dbPath(), "600"]);
      children.push(holder);
      await holder.ready;

      const { projectId } = store.projects.register({ slug: "busy", name: "Busy", rootPath: dir });
      expect(store.projects.getBySlug("busy")?.projectId).toBe(projectId);
      expect(await holder.exited).toBe(0);
    } finally {
      store.close();
    }
  }, 60_000);

  it("a write waits behind another process that commits back to back for longer than the retry budget", async () => {
    const store = openAt();
    try {
      // Seen in CI on Windows as INV-01 failing with "database is locked": SQLite's write lock has no queue, so a
      // waiter rarely lands in the gap between a commit and the next BEGIN IMMEDIATE of a busy writer. With commits
      // slowed to 25 ms (a loaded runner's fsync), the burst lasts 3 s, longer than the 2 s budget without a commit.
      const churn = startChild("churner.mjs", [dbPath(), "3000", "25"]);
      children.push(churn);
      await churn.ready;

      const { projectId } = store.projects.register({
        slug: "burst",
        name: "Burst",
        rootPath: dir,
      });
      expect(store.projects.getBySlug("burst")?.projectId).toBe(projectId);
      expect(await churn.exited).toBe(0);
    } finally {
      store.close();
    }
  }, 60_000);

  it("a write still fails with its error when the lock is held without a commit for longer than the budget", async () => {
    const store = openAt();
    try {
      // No other writer commits, so nothing extends the 2 s budget: a stuck holder does not block the caller longer.
      const holder = startChild("lock-holder.mjs", [dbPath(), "6000"]);
      children.push(holder);
      await holder.ready;

      const started = Date.now();
      expect(() =>
        store.projects.register({ slug: "stuck", name: "Stuck", rootPath: dir }),
      ).toThrow(/database is locked/);
      expect(Date.now() - started).toBeLessThan(6000);
    } finally {
      store.close();
    }
  }, 60_000);
});
