import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// `haril usage record --stdin` (docs/modos-y-delegacion.md 4.5, P14, P15): the console's way to log each order and
// each model use of its chat. One JSON row arrives on stdin, never in argv; the command checks it, keeps the order's
// hash, length and redacted preview (never its text), appends the row without a runtime lease, and the hash chain still
// verifies.

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
let stdin: string;

function clockAt(): Clock {
  return { now: () => now, schedule: () => () => undefined };
}

function openSeedStore(): Store {
  let counter = 0;
  return openStore({
    dataDir: sb.dataDir,
    clock: clockAt(),
    ids: { next: () => `seed-${String(++counter).padStart(4, "0")}` },
    rules: RULES,
  });
}

function createStore(): void {
  openSeedStore().close();
}

beforeEach(() => {
  sb = makeSandbox();
  now = T0;
  stdin = "";
  sb = { ...sb, host: { ...sb.host, clock: clockAt(), readStdin: () => stdin } };
});

afterEach(() => {
  sb.cleanup();
});

async function record(row: unknown, extra: string[] = []): Promise<number> {
  stdin = typeof row === "string" ? row : JSON.stringify(row);
  h = harness();
  return await run(["usage", "record", "--stdin", "--json", ...extra], h.io, sb.host);
}

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

const ORDER = {
  kind: "order",
  mode: "consulta",
  text: "Explain how the runtime claims a task",
  sessionId: "session-fake-1",
  idempotencyKey: "session-fake-1:input:1",
};

describe("haril usage record", () => {
  it("refuses to run before the store exists, and never creates it", async () => {
    expect(await record(ORDER)).toBe(2);
    expect(h.err.join("\n")).toMatch(/store not initialized/);
    expect(existsSync(join(sb.dataDir, "haril.db"))).toBe(false);
  });

  it("needs --stdin: the row never travels in argv", async () => {
    createStore();
    expect(await invoke(["usage", "record"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/--stdin/);
  });

  it("appends an order with its hash, length and redacted preview, never its text", async () => {
    createStore();
    const text = `Read the config, the key is sk-${"a1".repeat(12)} and then summarize`;
    expect(await record({ ...ORDER, text })).toBe(0);
    const reply = parseJson<{ table: string; id: string; created: boolean }>(h.out);
    expect(reply).toMatchObject({ table: "orders", created: true });
    const store = openSeedStore();
    try {
      const [order] = store.usageLog.orders();
      expect(order?.orderId).toBe(reply.id);
      expect(order?.mode).toBe("consulta");
      expect(order?.source).toBe("chat");
      expect(order?.sessionId).toBe("session-fake-1");
      expect(order?.textChars).toBe(text.length);
      expect(order?.preview).toContain("[redacted]");
      expect(order?.preview).not.toContain("a1a1a1");
      expect(JSON.stringify(order)).not.toContain(text);
    } finally {
      store.close();
    }
  });

  it("cuts the preview to 200 characters (P15)", async () => {
    createStore();
    expect(await record({ ...ORDER, text: "word ".repeat(100) })).toBe(0);
    const store = openSeedStore();
    try {
      const [order] = store.usageLog.orders();
      expect(Array.from(order?.preview ?? "").length).toBeLessThanOrEqual(200);
      expect(order?.textChars).toBe(500);
    } finally {
      store.close();
    }
  });

  it("appends a chat usage row linked to its order, with null for unreported tokens", async () => {
    createStore();
    expect(await record(ORDER)).toBe(0);
    const orderId = parseJson<{ id: string }>(h.out).id;
    now = T0 + 5_000;
    const usage = {
      kind: "chat",
      mode: "consulta",
      orderId,
      sessionId: "session-fake-1",
      provider: "haril-gw",
      modelRequested: "Gemini1/gemini-3-flash",
      modelServed: "gemini-3-flash",
      tokensIn: 1200,
      tokensOut: 340,
      tokensCached: null,
      tokensReasoning: 20,
      startedAt: T0 + 1_000,
      endedAt: T0 + 4_500,
      durationMs: 3_500,
      outcome: "stop",
      idempotencyKey: "session-fake-1:message:1",
    };
    expect(await record(usage)).toBe(0);
    expect(parseJson<{ table: string; created: boolean }>(h.out)).toMatchObject({
      table: "usage_log",
      created: true,
    });
    const store = openSeedStore();
    try {
      const [row] = store.usageLog.usage();
      expect(row).toMatchObject({
        kind: "chat",
        mode: "consulta",
        orderId,
        modelRequested: "Gemini1/gemini-3-flash",
        modelServed: "gemini-3-flash",
        tokensIn: 1200,
        tokensOut: 340,
        tokensCached: null,
        tokensReasoning: 20,
        durationMs: 3_500,
        outcome: "stop",
        simulated: false,
      });
    } finally {
      store.close();
    }
  });

  it("keeps the first row for a repeated idempotency key", async () => {
    createStore();
    expect(await record(ORDER)).toBe(0);
    const first = parseJson<{ id: string }>(h.out).id;
    expect(await record(ORDER)).toBe(0);
    expect(parseJson<{ id: string; created: boolean }>(h.out)).toEqual({
      table: "orders",
      id: first,
      created: false,
    });
    const store = openSeedStore();
    try {
      expect(store.usageLog.orders()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("links the order to the project named by --project", async () => {
    createStore();
    const projectDir = projectRoot(sb, "proj");
    expect(
      await invoke(["project", "init", projectDir, "--name", "Proj", "--slug", "proj", "--yes"]),
    ).toBe(0);
    expect(await record(ORDER, ["--project", "proj"])).toBe(0);
    expect(await record({ ...ORDER, idempotencyKey: "other" }, ["--project", "nope"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/no project with slug "nope"/);
    const store = openSeedStore();
    try {
      const [order] = store.usageLog.orders();
      expect(order?.projectId).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("refuses rows it cannot trust, and appends nothing", async () => {
    createStore();
    const bad: unknown[] = [
      "not json",
      "[]",
      { ...ORDER, kind: "agent_run" },
      { ...ORDER, mode: "everything" },
      { ...ORDER, source: "workflow" },
      { ...ORDER, text: "" },
      { ...ORDER, extra: "field" },
      { ...ORDER, sessionId: "has spaces in it" },
      { ...ORDER, sessionId: `Bearer ${"x".repeat(20)}` },
      { ...ORDER, idempotencyKey: 42 },
      { kind: "chat", mode: "accion", tokensIn: -1, tokensOut: 2 },
      { kind: "chat", mode: "accion", tokensIn: 1.5, tokensOut: 2 },
      { kind: "chat", mode: "accion", tokensOut: 2 },
      { kind: "chat", mode: "accion", tokensIn: 1, tokensOut: 2, durationMs: "3s" },
      {
        kind: "chat",
        mode: "accion",
        tokensIn: 1,
        tokensOut: 2,
        modelServed: `key=${"z9".repeat(20)}`,
      },
      { kind: "chat", mode: "accion", tokensIn: 1, tokensOut: 2, outcome: "line\nbreak" },
    ];
    for (const row of bad) {
      expect(await record(row), JSON.stringify(row)).toBe(2);
      expect(h.err.join("\n")).toMatch(/^haril: /);
    }
    const store = openSeedStore();
    try {
      expect(store.usageLog.orders()).toHaveLength(0);
      expect(store.usageLog.usage()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("refuses a usage row whose order does not exist", async () => {
    createStore();
    expect(
      await record({ kind: "chat", mode: "accion", orderId: "missing", tokensIn: 1, tokensOut: 2 }),
    ).toBe(2);
    expect(h.err.join("\n")).toMatch(/unknown order/);
  });

  it("leaves both chains verifiable after console rows", async () => {
    createStore();
    expect(await record(ORDER)).toBe(0);
    const orderId = parseJson<{ id: string }>(h.out).id;
    for (let index = 0; index < 3; index++) {
      now += 1_000;
      expect(
        await record({
          kind: "chat",
          mode: "accion",
          orderId,
          tokensIn: 10 + index,
          tokensOut: null,
          idempotencyKey: `message-${index}`,
        }),
      ).toBe(0);
    }
    expect(await invoke(["usage", "verify"])).toBe(0);
    expect(h.out).toEqual(["orders: 1 row, chain ok", "usage_log: 3 rows, chain ok"]);
    expect(await invoke(["usage", "log", "--kind", "chat"])).toBe(0);
    expect(h.out).toHaveLength(3);
    expect(h.out[0]).toMatch(/usage\.chat .* mode=accion .*tokensOut=unreported/);
  });

  it("prints one plain line without --json", async () => {
    createStore();
    stdin = JSON.stringify(ORDER);
    expect(await invoke(["usage", "record", "--stdin"])).toBe(0);
    expect(h.out).toEqual([expect.stringMatching(/^order \S+ recorded$/)]);
  });
});
