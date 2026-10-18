import { describe, expect, it } from "vitest";
import { type ChatLogDeps, createChatLog } from "../src/chat-log.js";
import type { CliResult } from "../src/cli.js";

// The console's chat log (4.5, P14, P15): every prompt typed in the console is an order row and every model reply a
// usage row with its model, tokens and duration, written through `haril usage record --stdin` (JSON on stdin, never in
// argv). Rows go one at a time, in order; a usage row links to the order of its prompt. Logging never blocks or breaks
// the chat: a failure is retried once, then counted for the bar, and nothing throws.

interface Call {
  readonly args: readonly string[];
  readonly row: Record<string, unknown>;
}

function setup(answers: (call: Call) => CliResult | Promise<CliResult>) {
  const calls: Call[] = [];
  let changes = 0;
  const deps: ChatLogDeps = {
    async run(args, input) {
      const call = { args, row: JSON.parse(input) as Record<string, unknown> };
      calls.push(call);
      return answers(call);
    },
    projectSlug: () => "fake-proj",
    sessionId: () => "session-fake-1",
    retryDelayMs: 0,
    onChange: () => {
      changes++;
    },
  };
  return { calls, deps, log: createChatLog(deps), changes: () => changes };
}

const ok = (table: string, id: string): CliResult => ({
  ok: true,
  code: 0,
  stdout: JSON.stringify({ table, id, created: true }),
  stderr: "",
});

const REPLY = {
  role: "assistant",
  provider: "haril-gw",
  model: "Gemini1/gemini-3-flash",
  responseModel: "gemini-3-flash",
  responseId: "resp-1",
  usage: {
    input: 1200,
    output: 340,
    cacheRead: 100,
    cacheWrite: 0,
    reasoning: 20,
    totalTokens: 1540,
    cost: { total: 0 },
  },
  stopReason: "stop",
  timestamp: 1_000,
  durationMs: 3_500,
};

describe("the chat log", () => {
  it("records each prompt as an order and each reply as a usage row linked to it", async () => {
    const { calls, log } = setup((call) =>
      call.row.kind === "order" ? ok("orders", "order-1") : ok("usage_log", "u-1"),
    );
    log.order("Explain the claim order", "consult");
    log.usage(REPLY, "consult");
    await log.idle();
    expect(calls.map((call) => call.args)).toEqual([
      ["usage", "record", "--stdin", "--json", "--project", "fake-proj"],
      ["usage", "record", "--stdin", "--json", "--project", "fake-proj"],
    ]);
    expect(calls[0]?.row).toEqual({
      kind: "order",
      mode: "consulta",
      source: "chat",
      text: "Explain the claim order",
      sessionId: "session-fake-1",
      idempotencyKey: "session-fake-1:input:1",
    });
    expect(calls[1]?.row).toEqual({
      kind: "chat",
      mode: "consulta",
      orderId: "order-1",
      sessionId: "session-fake-1",
      provider: "haril-gw",
      modelRequested: "Gemini1/gemini-3-flash",
      modelServed: "gemini-3-flash",
      tokensIn: 1200,
      tokensOut: 340,
      tokensCached: 100,
      tokensReasoning: 20,
      costMicros: null,
      startedAt: 1_000,
      endedAt: 4_500,
      durationMs: 3_500,
      outcome: "stop",
      idempotencyKey: "session-fake-1:message:resp-1",
    });
    expect(log.status()).toEqual({ recorded: 2, failed: 0, lastError: undefined });
  });

  it("records tokens a provider did not report as null, never 0", async () => {
    const { calls, log } = setup(() => ok("usage_log", "u-1"));
    log.usage(
      { ...REPLY, usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } },
      "action",
    );
    await log.idle();
    expect(calls[0]?.row).toMatchObject({
      mode: "accion",
      tokensIn: null,
      tokensOut: null,
      tokensCached: null,
    });
  });

  it("drops a model name that is not a plain identifier instead of losing the row", async () => {
    const { calls, log } = setup(() => ok("usage_log", "u-1"));
    log.usage({ ...REPLY, model: "model with spaces", responseModel: undefined }, "plan");
    await log.idle();
    expect(calls[0]?.row).toMatchObject({ modelRequested: null, modelServed: null, mode: "plan" });
  });

  it("skips what is not a reply and empty prompts", async () => {
    const { calls, log } = setup(() => ok("orders", "o"));
    log.usage({ role: "user" }, "action");
    log.usage({ role: "toolResult" }, "action");
    log.order("   ", "action");
    await log.idle();
    expect(calls).toEqual([]);
  });

  it("retries a failed row once, then counts it and says so, without throwing", async () => {
    let attempts = 0;
    const { log, changes } = setup(() => {
      attempts++;
      return { ok: false, code: 2, stdout: "", stderr: "haril: store not initialized\nmore" };
    });
    log.order("hello", "action");
    await log.idle();
    expect(attempts).toBe(2);
    expect(log.status()).toEqual({
      recorded: 0,
      failed: 1,
      lastError: "haril: store not initialized",
    });
    expect(changes()).toBeGreaterThan(0);
  });

  it("keeps going after a CLI that throws, and the next row still goes", async () => {
    let first = true;
    const { calls, log } = setup(() => {
      if (first) {
        first = false;
        throw new Error("spawn EPERM");
      }
      return ok("orders", "o-2");
    });
    log.order("one", "action");
    log.order("two", "action");
    await log.idle();
    expect(log.status().recorded).toBe(2);
    expect(calls.map((call) => call.row.text)).toEqual(["one", "one", "two"]);
  });

  it("does not link a reply to an order that failed", async () => {
    const { calls, log } = setup((call) =>
      call.row.kind === "order"
        ? { ok: false, code: 2, stdout: "", stderr: "no" }
        : ok("usage_log", "u"),
    );
    log.order("hello", "action");
    log.usage(REPLY, "action");
    await log.idle();
    expect(calls.at(-1)?.row.orderId).toBeNull();
  });

  it("leaves --project out when the folder is no project", async () => {
    const { calls, deps } = setup(() => ok("orders", "o"));
    const log = createChatLog({ ...deps, projectSlug: () => undefined });
    log.order("hello", "action");
    await log.idle();
    expect(calls[0]?.args).toEqual(["usage", "record", "--stdin", "--json"]);
  });
});
