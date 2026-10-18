import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppendUsageInput, Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";
import { createUsageLogFacet } from "../src/usage-log.js";
import {
  type ManualClock,
  makeTempDir,
  manualClock,
  removeTempDir,
  sequentialIds,
  testRules,
} from "./support.js";

// The orders and usage logs (docs/modos-y-delegacion.md 4.5, R-L1): append-only, hash-chained, written without a lease
// (P14), readable by time range and kind, and verifiable: editing or deleting a row by hand is found at its position.

const GENESIS = "0".repeat(64);
const HOUR = 3_600_000;

let dir: string;
let clock: ManualClock;
let store: Store;

beforeEach(() => {
  dir = makeTempDir();
  clock = manualClock(Date.UTC(2026, 9, 18, 10, 0, 0));
  store = openStore({ dataDir: dir, clock, ids: sequentialIds("log"), rules: testRules });
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// A second connection to the same file: what someone editing the database by hand would do.
function byHand(work: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(dir, "haril.db"));
  try {
    work(db);
  } finally {
    db.close();
  }
}

function run(change: Partial<AppendUsageInput> = {}): AppendUsageInput {
  return {
    kind: "agent_run",
    workflowId: "wf-1",
    taskId: "task-1",
    runId: "run-1",
    layer: 3,
    role: "executor",
    mode: "delegacion",
    provider: "fake",
    modelRequested: "fake/fast-model",
    modelServed: "fake/fast-model",
    tokensIn: 1200,
    tokensOut: 300,
    startedAt: clock.now() - 60_000,
    endedAt: clock.now(),
    durationMs: 60_000,
    difficultyEst: "easy",
    difficultyReason: "one file",
    outcome: "completed",
    retries: 0,
    ...change,
  };
}

describe("store.usageLog.appendOrder", () => {
  it("stores the hash, the length and the preview of an order, never its text", () => {
    const text = "Change the primary button color and test it";
    const { record, created } = store.usageLog.appendOrder({
      mode: "delegacion",
      source: "cli",
      text,
      preview: text,
      projectId: "p-1",
    });
    expect(created).toBe(true);
    expect(record).toMatchObject({
      seq: 1,
      ts: clock.now(),
      mode: "delegacion",
      source: "cli",
      textSha256: sha256(text),
      textChars: text.length,
      preview: text,
      projectId: "p-1",
      sessionId: null,
      prevHash: GENESIS,
    });
    byHand((db) => {
      const row = db.prepare("SELECT * FROM orders").get() as Record<string, unknown>;
      expect(Object.keys(row)).not.toContain("text");
      expect(Object.values(row).filter((value) => value === text)).toEqual([text]);
    });
  });

  it("chains each row to the previous one with sha256(prevHash + canonical JSON of the row)", () => {
    const first = store.usageLog.appendOrder({
      mode: "cli",
      source: "cli",
      text: "a",
      preview: "a",
    });
    clock.advance(1_000);
    const second = store.usageLog.appendOrder({
      mode: "plan",
      source: "chat",
      text: "b",
      preview: null,
    });
    expect(second.record.prevHash).toBe(first.record.hash);
    byHand((db) => {
      const row = db.prepare("SELECT * FROM orders WHERE seq = 2").get() as Record<string, unknown>;
      const { hash, ...rest } = row;
      expect(hash).toBe(sha256(`${first.record.hash}${testRules.canonicalJson(rest)}`));
    });
  });

  it("returns the first row for a repeated idempotency key and appends nothing", () => {
    const first = store.usageLog.appendOrder({
      mode: "accion",
      source: "chat",
      text: "hello",
      preview: "hello",
      sessionId: "s-1",
      idempotencyKey: "s-1:m-1",
    });
    const again = store.usageLog.appendOrder({
      mode: "accion",
      source: "chat",
      text: "hello",
      preview: "hello",
      sessionId: "s-1",
      idempotencyKey: "s-1:m-1",
    });
    expect(again).toEqual({ record: first.record, created: false });
    expect(store.usageLog.orders()).toHaveLength(1);
  });

  it("refuses a preview longer than 200 characters", () => {
    expect(() =>
      store.usageLog.appendOrder({
        mode: "cli",
        source: "cli",
        text: "x",
        preview: "p".repeat(201),
      }),
    ).toThrow(/preview/);
  });
});

describe("store.usageLog.appendUsage", () => {
  it("keeps tokens that were not reported as null, never 0", () => {
    const { record } = store.usageLog.appendUsage(
      run({ tokensIn: null, tokensOut: null, tokensCached: null }),
    );
    expect(record).toMatchObject({ tokensIn: null, tokensOut: null, tokensCached: null, seq: 1 });
    expect(store.usageLog.usage()[0]).toMatchObject({ tokensIn: null, tokensOut: null });
  });

  it("links a row to its order and refuses an unknown order", () => {
    const order = store.usageLog.appendOrder({
      mode: "cli",
      source: "cli",
      text: "x",
      preview: "x",
    });
    const { record } = store.usageLog.appendUsage(run({ orderId: order.record.orderId }));
    expect(record.orderId).toBe(order.record.orderId);
    expect(() => store.usageLog.appendUsage(run({ orderId: "no-such-order" }))).toThrow(/order/);
    expect(store.usageLog.usage()).toHaveLength(1);
  });

  it("is append-only: an UPDATE or DELETE by SQL is refused by the triggers", () => {
    store.usageLog.appendUsage(run());
    store.usageLog.appendOrder({ mode: "cli", source: "cli", text: "x", preview: "x" });
    byHand((db) => {
      expect(() => db.exec("UPDATE usage_log SET tokens_in = 1")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM usage_log")).toThrow(/append-only/);
      expect(() => db.exec("UPDATE orders SET preview = 'y'")).toThrow(/append-only/);
      expect(() => db.exec("DELETE FROM orders")).toThrow(/append-only/);
    });
  });

  it("needs no runtime lease (P14)", () => {
    expect(store.runtime.leaseSummary()).toEqual({ status: "none" });
    expect(store.usageLog.appendUsage(run()).created).toBe(true);
  });
});

describe("store.usageLog reads", () => {
  beforeEach(() => {
    store.usageLog.appendUsage(run({ runId: "r-1", modelServed: "fake/fast-model", layer: 3 }));
    clock.advance(HOUR);
    store.usageLog.appendUsage(
      run({
        runId: "r-2",
        kind: "chat",
        role: null,
        layer: null,
        mode: "accion",
        modelServed: "fake/mid-model",
        difficultyEst: null,
      }),
    );
    clock.advance(HOUR);
    store.usageLog.appendUsage(
      run({
        runId: "r-3",
        workflowId: "wf-2",
        layer: 2,
        role: "delegator",
        difficultyEst: "hard",
        modelServed: "fake/mid-model",
      }),
    );
  });

  it("filters by a time range, from inclusive and to exclusive", () => {
    const start = Date.UTC(2026, 9, 18, 10, 0, 0);
    expect(store.usageLog.usage({ from: start + HOUR }).map((row) => row.runId)).toEqual([
      "r-2",
      "r-3",
    ]);
    expect(store.usageLog.usage({ to: start + HOUR }).map((row) => row.runId)).toEqual(["r-1"]);
    expect(
      store.usageLog.usage({ from: start + HOUR, to: start + 2 * HOUR }).map((row) => row.runId),
    ).toEqual(["r-2"]);
  });

  it("filters by kind, model, workflow, layer, mode and difficulty", () => {
    const runs = (filter: Parameters<Store["usageLog"]["usage"]>[0]) =>
      store.usageLog.usage(filter).map((row) => row.runId);
    expect(runs({ kind: "chat" })).toEqual(["r-2"]);
    expect(runs({ kind: "agent_run" })).toEqual(["r-1", "r-3"]);
    expect(runs({ model: "fake/mid-model" })).toEqual(["r-2", "r-3"]);
    expect(runs({ workflowId: "wf-2" })).toEqual(["r-3"]);
    expect(runs({ layer: 3 })).toEqual(["r-1"]);
    expect(runs({ mode: "accion" })).toEqual(["r-2"]);
    expect(runs({ difficulty: "hard" })).toEqual(["r-3"]);
  });

  it("keeps the newest rows under a limit, oldest first", () => {
    expect(store.usageLog.usage({ limit: 2 }).map((row) => row.runId)).toEqual(["r-2", "r-3"]);
  });

  it("summarizes by model and by UTC day, counting unreported tokens apart", () => {
    store.usageLog.appendUsage(
      run({ runId: "r-4", tokensIn: null, tokensOut: 50, modelServed: "fake/fast-model" }),
    );
    expect(store.usageLog.summary("model")).toEqual([
      {
        key: "fake/fast-model",
        rows: 2,
        tokensIn: 1200,
        tokensOut: 350,
        tokensInUnreported: 1,
        tokensOutUnreported: 0,
        durationMs: 120_000,
        retries: 0,
        approved: 0,
        rejected: 0,
      },
      expect.objectContaining({ key: "fake/mid-model", rows: 2, tokensIn: 2400 }),
    ]);
    expect(store.usageLog.summary("day").map((row) => [row.key, row.rows])).toEqual([
      ["2026-10-18", 4],
    ]);
    expect(store.usageLog.summary("layer").map((row) => [row.key, row.rows])).toEqual([
      ["2", 1],
      ["3", 2],
      [null, 1],
    ]);
  });
});

describe("store.usageLog.verify", () => {
  function fill(): void {
    for (let index = 1; index <= 5; index++) {
      store.usageLog.appendUsage(run({ runId: `r-${index}`, tokensIn: index * 100 }));
      store.usageLog.appendOrder({
        mode: "cli",
        source: "cli",
        text: `order ${index}`,
        preview: `order ${index}`,
      });
      clock.advance(1_000);
    }
  }

  it("passes on an untouched log, and on an empty one", () => {
    expect(store.usageLog.verify()).toEqual({
      ok: true,
      orders: { table: "orders", rows: 0, ok: true, firstBroken: null },
      usage: { table: "usage_log", rows: 0, ok: true, firstBroken: null },
    });
    fill();
    expect(store.usageLog.verify()).toMatchObject({
      ok: true,
      orders: { rows: 5, ok: true },
      usage: { rows: 5, ok: true },
    });
  });

  it("finds a row changed by hand at its position", () => {
    fill();
    byHand((db) => {
      db.exec("DROP TRIGGER usage_log_no_update");
      db.exec("UPDATE usage_log SET tokens_in = 1 WHERE seq = 3");
    });
    const report = store.usageLog.verify();
    expect(report.ok).toBe(false);
    expect(report.usage).toMatchObject({
      ok: false,
      firstBroken: { seq: 3, reason: "hash_mismatch" },
    });
    expect(report.orders.ok).toBe(true);
  });

  it("finds a row deleted by hand at the row after it", () => {
    fill();
    byHand((db) => {
      db.exec("DROP TRIGGER orders_no_delete");
      db.exec("DELETE FROM orders WHERE seq = 2");
    });
    expect(store.usageLog.verify().orders).toMatchObject({
      ok: false,
      firstBroken: { seq: 3, reason: "sequence_gap" },
    });
  });

  it("finds a deletion hidden by renumbering the rows after it", () => {
    fill();
    byHand((db) => {
      db.exec("DROP TRIGGER usage_log_no_delete");
      db.exec("DROP TRIGGER usage_log_no_update");
      db.exec("DELETE FROM usage_log WHERE seq = 2");
      db.exec("UPDATE usage_log SET seq = seq - 1 WHERE seq > 2");
    });
    expect(store.usageLog.verify().usage).toMatchObject({
      ok: false,
      firstBroken: { seq: 2, reason: "prev_hash_mismatch" },
    });
  });

  it("finds the newest rows deleted by hand through the recorded head", () => {
    fill();
    byHand((db) => {
      db.exec("DROP TRIGGER usage_log_no_delete");
      db.exec("DELETE FROM usage_log WHERE seq = 5");
    });
    expect(store.usageLog.verify().usage).toMatchObject({
      ok: false,
      firstBroken: { seq: 5, reason: "head_mismatch" },
    });
  });

  it("keeps verifying after the store is reopened", () => {
    fill();
    store.close();
    store = openStore({ dataDir: dir, clock, ids: sequentialIds("again"), rules: testRules });
    store.usageLog.appendUsage(run({ runId: "r-after" }));
    expect(store.usageLog.verify()).toMatchObject({ ok: true, usage: { rows: 6 } });
  });

  it("finds a chain whose every row and head were deleted, through the started marker", () => {
    fill();
    byHand((db) => {
      db.exec("DROP TRIGGER usage_log_no_delete");
      db.exec("DELETE FROM usage_log");
      db.exec("DELETE FROM meta WHERE key = 'usage_log.head'");
    });
    expect(store.usageLog.verify().usage).toMatchObject({
      ok: false,
      rows: 0,
      firstBroken: { reason: "head_mismatch" },
    });
  });

  it("reads the chains and their heads in one snapshot: an append from another connection in between is no alarm", () => {
    fill();
    // A second store on the same file appends while verify() is between its row reads and its head read.
    const other = openStore({ dataDir: dir, clock, ids: sequentialIds("other"), rules: testRules });
    const db = new DatabaseSync(join(dir, "haril.db"));
    try {
      let appended = 0;
      const racing = new Proxy(db, {
        get(target, property) {
          if (property === "prepare") {
            return (sql: string) => {
              if (sql.includes("FROM meta WHERE key") && appended < 2) {
                appended += 1;
                other.usageLog.appendUsage(run({ runId: `race-${appended}` }));
                other.usageLog.appendOrder({
                  mode: "cli",
                  source: "cli",
                  text: "x",
                  preview: null,
                });
              }
              return target.prepare(sql);
            };
          }
          // Native getters (isTransaction) need the real connection as their receiver.
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const facet = createUsageLogFacet({
        db: racing,
        clock,
        ids: sequentialIds("verify"),
        rules: testRules,
        transaction: (work) => work(),
      });
      expect(facet.verify()).toMatchObject({ ok: true, usage: { rows: 5 }, orders: { rows: 5 } });
      expect(appended).toBeGreaterThan(0);
      // The rows appended meanwhile are verified by the next call.
      expect(facet.verify()).toMatchObject({ ok: true, usage: { rows: 7 } });
    } finally {
      db.close();
      other.close();
    }
  });
});
