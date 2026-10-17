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
});
