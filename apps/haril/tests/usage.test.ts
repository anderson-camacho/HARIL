import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { AppendUsageInput, Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type Harness, harness, makeSandbox, parseJson, type Sandbox } from "./helpers.js";

// `haril usage log|summary|verify|export` (docs/modos-y-delegacion.md 4.5 and 6): read-only views of the orders and
// usage logs, one line per row like `haril events`, filterable by time range and kind, and the hash-chain check.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 18, 10, 0, 0);
const RULES = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

let sb: Sandbox;
let h: Harness;
let now: number;

function clockAt(): Clock {
  return { now: () => now, schedule: () => () => undefined };
}

function seedStore(): Store {
  let counter = 0;
  return openStore({
    dataDir: sb.dataDir,
    clock: clockAt(),
    ids: { next: () => `seed-${String(++counter).padStart(4, "0")}` },
    rules: RULES,
  });
}

function usageRow(change: Partial<AppendUsageInput> = {}): AppendUsageInput {
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
    durationMs: 60_000,
    difficultyEst: "easy",
    outcome: "completed",
    retries: 0,
    ...change,
  };
}

// An order at T0 and three usage rows an hour apart; "now" is T0 + 4h.
function seed(): void {
  const store = seedStore();
  try {
    now = T0;
    const order = store.usageLog.appendOrder({
      mode: "delegacion",
      source: "cli",
      text: "Change the primary button color",
      preview: "Change the primary button color",
    });
    now = T0 + HOUR;
    store.usageLog.appendUsage(usageRow({ runId: "run-1", orderId: order.record.orderId }));
    now = T0 + 2 * HOUR;
    store.usageLog.appendUsage(
      usageRow({
        runId: null,
        kind: "chat",
        role: null,
        layer: null,
        mode: "accion",
        modelServed: "fake/mid-model",
        difficultyEst: null,
        sessionId: "session-1",
      }),
    );
    now = T0 + 3 * HOUR;
    store.usageLog.appendUsage(usageRow({ runId: "run-3", tokensIn: null, tokensOut: null }));
    now = T0 + 4 * HOUR;
  } finally {
    store.close();
  }
}

beforeEach(() => {
  sb = makeSandbox();
  now = T0 + 4 * HOUR;
  sb = { ...sb, host: { ...sb.host, clock: clockAt() } };
});

afterEach(() => {
  sb.cleanup();
});

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

describe("haril usage log", () => {
  it("refuses to run before the store exists, and never creates it", async () => {
    expect(await invoke(["usage", "log"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/store not initialized/);
    expect(existsSync(join(sb.dataDir, "haril.db"))).toBe(false);
  });

  it("prints one line per row, oldest first, orders and usage together", async () => {
    seed();
    expect(await invoke(["usage", "log"])).toBe(0);
    expect(h.out).toHaveLength(4);
    expect(h.out[0]).toMatch(
      /^1 2026-10-18T10:00:00\.000Z order\.cli order:seed-\d+ mode=delegacion chars=31 preview="Change the primary button color"$/,
    );
    expect(h.out[1]).toMatch(
      /^1 2026-10-18T11:00:00\.000Z usage\.agent_run run:run-1 role=executor layer=3 model=fake\/fast-model difficulty=easy tokensIn=1200 tokensOut=300 durationMs=60000 outcome=completed retries=0 workflow=wf-1 order=seed-\d+$/,
    );
    expect(h.out[2]).toMatch(/usage\.chat usage:seed-\d+ mode=accion model=fake\/mid-model/);
    expect(h.out[3]).toMatch(/tokensIn=unreported tokensOut=unreported/);
  });

  it("filters by --since, measured back from now", async () => {
    seed();
    expect(await invoke(["usage", "log", "--since", "2h"])).toBe(0);
    expect(h.out.map((line) => line.split(" ")[2])).toEqual(["usage.chat", "usage.agent_run"]);
    expect(await invoke(["usage", "log", "--since", "30m"])).toBe(0);
    expect(h.out).toEqual([]);
  });

  it("filters by --from (inclusive) and --to (exclusive), as ISO times or epoch milliseconds", async () => {
    seed();
    const from = new Date(T0 + HOUR).toISOString();
    expect(await invoke(["usage", "log", "--from", from, "--to", String(T0 + 3 * HOUR)])).toBe(0);
    expect(h.out.map((line) => line.split(" ")[1])).toEqual([
      "2026-10-18T11:00:00.000Z",
      "2026-10-18T12:00:00.000Z",
    ]);
  });

  it("filters by kind, model, layer, mode and difficulty, and keeps the newest rows under --limit", async () => {
    seed();
    const types = async (args: string[]) => {
      expect(await invoke(["usage", "log", ...args])).toBe(0);
      return h.out.map((line) => line.split(" ")[2]);
    };
    expect(await types(["--kind", "order"])).toEqual(["order.cli"]);
    expect(await types(["--kind", "agent_run"])).toEqual(["usage.agent_run", "usage.agent_run"]);
    expect(await types(["--model", "fake/mid-model"])).toEqual(["usage.chat"]);
    expect(await types(["--layer", "3"])).toEqual(["usage.agent_run", "usage.agent_run"]);
    expect(await types(["--mode", "accion"])).toEqual(["usage.chat"]);
    expect(await types(["--mode", "delegacion"])).toEqual([
      "order.cli",
      "usage.agent_run",
      "usage.agent_run",
    ]);
    expect(await types(["--difficulty", "easy"])).toEqual(["usage.agent_run", "usage.agent_run"]);
    expect(await types(["--limit", "1"])).toEqual(["usage.agent_run"]);
  });

  it("prints a JSON array with the table of each row under --json", async () => {
    seed();
    expect(await invoke(["usage", "log", "--json"])).toBe(0);
    const rows = parseJson<Array<{ table: string; seq: number; tokensIn?: number | null }>>(h.out);
    expect(rows.map((row) => [row.table, row.seq])).toEqual([
      ["orders", 1],
      ["usage_log", 1],
      ["usage_log", 2],
      ["usage_log", 3],
    ]);
    expect(rows[3]?.tokensIn).toBeNull();
  });

  it("refuses a bad time, a bad kind and --since with --from", async () => {
    seed();
    for (const args of [
      ["--since", "2x"],
      ["--since", "2h", "--from", "2026-10-18"],
      ["--from", "yesterday"],
      ["--kind", "everything"],
      ["--layer", "4"],
      ["--limit", "0"],
      ["--difficulty", "brutal"],
    ]) {
      expect(await invoke(["usage", "log", ...args]), args.join(" ")).toBe(2);
      expect(h.err.join("\n")).toMatch(/^haril: /);
    }
  });
});

describe("haril usage summary", () => {
  it("groups by model by default, with totals, in text and in JSON", async () => {
    seed();
    expect(await invoke(["usage", "summary", "--json"])).toBe(0);
    const report = parseJson<{ by: string; orders: number; rows: Array<Record<string, unknown>> }>(
      h.out,
    );
    expect(report.by).toBe("model");
    expect(report.orders).toBe(1);
    expect(report.rows).toEqual([
      expect.objectContaining({
        key: "fake/fast-model",
        rows: 2,
        tokensIn: 1200,
        tokensInUnreported: 1,
      }),
      expect.objectContaining({ key: "fake/mid-model", rows: 1, tokensIn: 1200 }),
    ]);
    expect(await invoke(["usage", "summary", "--by", "day"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/2026-10-18/);
    expect(text).toMatch(/total/);
  });

  it("refuses an unknown grouping", async () => {
    seed();
    expect(await invoke(["usage", "summary", "--by", "color"])).toBe(2);
  });
});

describe("haril usage verify", () => {
  it("passes on an untouched log and fails, naming the row, after an edit by hand", async () => {
    seed();
    expect(await invoke(["usage", "verify"])).toBe(0);
    expect(h.out).toEqual(["orders: 1 row, chain ok", "usage_log: 3 rows, chain ok"]);

    const db = new DatabaseSync(join(sb.dataDir, "haril.db"));
    db.exec("DROP TRIGGER usage_log_no_update");
    db.exec("UPDATE usage_log SET tokens_out = 1 WHERE seq = 2");
    db.close();

    expect(await invoke(["usage", "verify"])).toBe(1);
    expect(h.out.join("\n")).toMatch(
      /usage_log: 3 rows, chain broken at seq 2 \(hash_mismatch: the row was changed after it was written\)/,
    );
    expect(await invoke(["usage", "verify", "--json"])).toBe(1);
    expect(
      parseJson<{ ok: boolean; usage: { firstBroken: { seq: number } } }>(h.out),
    ).toMatchObject({
      ok: false,
      usage: { firstBroken: { seq: 2, reason: "hash_mismatch" } },
    });
  });
});

describe("haril usage export", () => {
  it("writes JSONL that matches the table, hashes included", async () => {
    seed();
    expect(await invoke(["usage", "export", "--format", "jsonl"])).toBe(0);
    const rows = h.out.map((line) => JSON.parse(line) as Record<string, unknown>);
    const store = seedStore();
    try {
      expect(rows).toEqual(store.usageLog.usage().map((row) => ({ ...row })));
    } finally {
      store.close();
    }
  });

  it("writes CSV for the orders, with a header and quoted text", async () => {
    seed();
    expect(await invoke(["usage", "export", "--format", "csv", "--table", "orders"])).toBe(0);
    expect(h.out[0]?.split(",").slice(0, 3)).toEqual(["seq", "orderId", "ts"]);
    expect(h.out).toHaveLength(2);
    expect(h.out[1]).toContain('"Change the primary button color"');
  });

  // A spreadsheet runs a cell that starts with =, +, -, @, a tab or a carriage return as a formula.
  it("neutralizes cells a spreadsheet would run as formulas, and still quotes them", async () => {
    const store = seedStore();
    try {
      now = T0;
      for (const preview of [
        '=HYPERLINK("http://example.invalid","x")',
        "+1",
        "-2",
        "@SUM(A1)",
        "\tx",
      ]) {
        store.usageLog.appendOrder({ mode: "cli", source: "cli", text: preview, preview });
      }
    } finally {
      store.close();
    }
    expect(await invoke(["usage", "export", "--format", "csv", "--table", "orders"])).toBe(0);
    const previews = h.out.slice(1).map((line) => line.split(",").slice(10, 11).join(""));
    expect(h.out[1]).toContain(`"'=HYPERLINK(""http://example.invalid""`);
    expect(previews.slice(1)).toEqual([`"'+1"`, `"'-2"`, `"'@SUM(A1)"`, `"'\tx"`]);
  });

  it("writes to --out, refuses an existing file, and needs --format", async () => {
    seed();
    const out = join(sb.root, "usage.jsonl");
    expect(
      await invoke([
        "usage",
        "export",
        "--format",
        "jsonl",
        "--before",
        String(T0 + 2 * HOUR),
        "--out",
        out,
      ]),
    ).toBe(0);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
    expect(h.out.join("\n")).toMatch(/1 row written/);
    writeFileSync(join(sb.root, "taken.csv"), "x");
    expect(
      await invoke(["usage", "export", "--format", "csv", "--out", join(sb.root, "taken.csv")]),
    ).toBe(2);
    expect(await invoke(["usage", "export"])).toBe(2);
    expect(await invoke(["usage", "export", "--format", "xml"])).toBe(2);
  });
});

describe("haril usage", () => {
  it("prints its usage without a subcommand, and help lists it", async () => {
    expect(await invoke(["usage"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/usage: haril usage log\|summary\|verify\|export/);
    expect(await invoke(["help"])).toBe(0);
    expect(h.out.join("\n")).toContain("haril usage log");
  });
});
