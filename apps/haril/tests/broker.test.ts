import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { canTransition, checkAcceptance, checkPlanSubmission } from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { type Broker, startBroker, type UpstreamClient } from "@haril/gateway";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHarilBroker } from "../src/broker.js";
import { run } from "../src/cli.js";
import { harness, makeSandbox, parseJson, type Sandbox } from "./helpers.js";

// The Broker end to end: real file store, the OpenAI-compatible adapter, and the fake upstream server (M2-T2).
const UPSTREAM_KEY = "upstream-test-key-0123456789";
const MESSAGES = [{ role: "user", content: "hi" }];
// Documented input estimate: UTF-8 bytes of the serialized messages divided by 3, rounded up (BR-5).
const INPUT_ESTIMATE = Math.ceil(Buffer.byteLength(JSON.stringify(MESSAGES), "utf8") / 3);

class ManualClock implements Clock {
  private time = 1_700_000_000_000;
  now(): number {
    return this.time;
  }
  schedule(): () => void {
    return () => undefined;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (piece: string) => {
          text += piece;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function chatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: "m1", messages: MESSAGES, max_tokens: 1000, ...overrides });
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function portOf(): number {
  return Number(new URL(broker.url).port);
}

let sb: Sandbox;
let clock: ManualClock;
let store: Store;
let upstream: FakeOpenAiServer;
let broker: Broker;
let projectId: string;
let projectBudget: string;
let epoch: number;
let seq = 0;
let closed = new Set<string>();

beforeEach(async () => {
  sb = makeSandbox();
  clock = new ManualClock();
  let n = 0;
  store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => `id-${String(++n).padStart(6, "0")}` },
    rules: { canTransition, checkPlan: checkPlanSubmission, checkAcceptance },
  });
  projectId = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.19.0",
    sqliteVersion: "3.53.3",
    ttlMs: 600_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
  projectBudget = store.budgets.ensure({
    scopeType: "project",
    scopeId: projectId,
    projectId,
    hardLimit: 1000,
  }).budgetId;
  upstream = await startFakeOpenAiServer({
    apiKey: UPSTREAM_KEY,
    models: ["m1", "m2"],
    completion: { textChunks: ["hi"], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  });
  broker = await startHarilBroker({
    store,
    clock,
    providers: [{ id: "upstream", baseUrl: upstream.baseUrl, apiKey: UPSTREAM_KEY }],
    timeoutMs: 5000,
  });
  closed = new Set();
});

afterEach(async () => {
  if (!closed.has("broker")) await broker.close();
  await upstream.close();
  if (!closed.has("store")) store.close();
  sb.cleanup();
});

// A real run and a task budget of the given size. Every key needs a run, a task and budgets.
function scopeFor(taskLimit: number): {
  runId: string;
  taskId: string;
  taskBudget: string;
} {
  seq += 1;
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: {
      goal: `goal ${seq}`,
      dependsOn: [],
      agent: "fake:succeed",
      maxAttempts: 1,
      timeoutMs: 1000,
    },
    idempotencyKey: `k-${seq}`,
    requestHash: `h-${seq}`,
  });
  store.commands.applyNext(epoch);
  store.tasks.promote();
  const claimed = store.tasks.claimNext(epoch);
  if (claimed === undefined) throw new Error("no task to claim");
  const taskBudget = store.budgets.ensure({
    scopeType: "task",
    scopeId: claimed.taskId,
    projectId,
    hardLimit: taskLimit,
  });
  return { runId: claimed.runId, taskId: claimed.taskId, taskBudget: taskBudget.budgetId };
}

function issue(
  scope: { runId: string; taskId: string; taskBudget: string },
  overrides: { models?: string[]; ttlMs?: number; maxTokensPerRequest?: number } = {},
): string {
  return broker.issueKey({
    runId: scope.runId,
    providerId: "upstream",
    taskId: scope.taskId,
    projectId,
    models: overrides.models ?? ["m1"],
    maxTokensPerRequest: overrides.maxTokensPerRequest ?? 500,
    budgetIds: [scope.taskBudget, projectBudget],
    ttlMs: overrides.ttlMs ?? 60_000,
  });
}

function taskBudget(id: string) {
  return store.budgets.get(id);
}

function upstreamChats(): number {
  return upstream.requests.filter((r) => r.path === "/v1/chat/completions").length;
}

describe("GET /v1/models", () => {
  it("lists only the granted models and does not ask the upstream", async () => {
    const key = issue(scopeFor(100));
    const reply = await send(portOf(), {
      method: "GET",
      path: "/v1/models",
      headers: bearer(key),
    });
    expect(reply.status).toBe(200);
    expect(parseJson<{ data: { id: string }[] }>([reply.text]).data.map((m) => m.id)).toEqual([
      "m1",
    ]);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("POST /v1/chat/completions", () => {
  it("commits the raw usage, releases the rest and overrides max_tokens", async () => {
    const scope = scopeFor(100);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false }),
    });
    expect(reply.status).toBe(200);
    expect(
      parseJson<{ choices: { message: { content: string } }[] }>([reply.text]).choices[0]?.message
        .content,
    ).toBe("hi");
    // min(requested 1000, grant 500, budget left after the input estimate 100 - 11)
    const forwarded = upstream.requests.at(-1)?.body as { max_tokens: number };
    expect(forwarded.max_tokens).toBe(100 - INPUT_ESTIMATE);
    expect(taskBudget(scope.taskBudget)).toMatchObject({ spent: 19, reserved: 0 });
  });

  it("streams the deltas, the usage chunk and [DONE], and commits the raw usage", async () => {
    const scope = scopeFor(100);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: true, messages: MESSAGES }),
    });
    expect(reply.status).toBe(200);
    expect(String(reply.headers["content-type"])).toContain("text/event-stream");
    expect(reply.text).toContain('"content":"hi"');
    expect(reply.text).toContain('"usage"');
    expect(reply.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const upstreamBody = upstream.requests.at(-1)?.body as {
      stream_options: { include_usage: boolean };
    };
    expect(upstreamBody.stream_options.include_usage).toBe(true);
    expect(taskBudget(scope.taskBudget)).toMatchObject({ spent: 19, reserved: 0 });
  });

  it("without usage from the upstream, charges the upper bound as unreconciled", async () => {
    upstream.setCompletion({ textChunks: ["abc"], usage: null });
    const scope = scopeFor(100);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false }),
    });
    expect(reply.status).toBe(200);
    // input estimate plus the output estimate of "abc" (3 bytes, one token)
    expect(taskBudget(scope.taskBudget)).toMatchObject({
      spent: INPUT_ESTIMATE + 1,
      reserved: 0,
    });
    expect(store.budgets.usageSummary({ projectId })).toMatchObject({ unreconciled: 1 });
  });

  it("answers 402 insufficient_quota without contacting the upstream when the budget cannot hold the reservation", async () => {
    const key = issue(scopeFor(5));
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false }),
    });
    expect(reply.status).toBe(402);
    expect(JSON.parse(reply.text)).toMatchObject({ error: { type: "insufficient_quota" } });
    expect(upstreamChats()).toBe(0);
  });

  it("cuts a stream at the reservation with an insufficient_quota event and [DONE]", async () => {
    upstream.setCompletion({
      textChunks: Array.from({ length: 6 }, () => "x".repeat(30)),
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const scope = scopeFor(40);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: true }),
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("insufficient_quota");
    expect(reply.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // In flight 30 bytes count as 8 tokens (bytes / 4); the fourth chunk would take the output to 30, past the 29 left
    expect(reply.text.split("x".repeat(30))).toHaveLength(4);
    const budget = taskBudget(scope.taskBudget);
    // Settlement bound: input + 90 bytes / 3 = 41, capped at the 40-token reservation
    expect(budget).toMatchObject({ spent: 40, reserved: 0 });
    expect((budget?.spent ?? 0) + (budget?.reserved ?? 0)).toBeLessThanOrEqual(40);
    expect(store.budgets.usageSummary({ projectId })).toMatchObject({ unreconciled: 1 });
  });

  it("bills an upstream failure before any output as the unreconciled upper bound", async () => {
    upstream.setCompletion({ status: 500, body: { error: { message: "boom" } } });
    const scope = scopeFor(100);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false }),
    });
    expect(reply.status).toBe(502);
    expect(taskBudget(scope.taskBudget)).toMatchObject({ spent: INPUT_ESTIMATE, reserved: 0 });
  });

  it("refuses a model that is not granted with 403 before anything else", async () => {
    const key = issue(scopeFor(100));
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ model: "m2" }),
    });
    expect(reply.status).toBe(403);
    expect(upstreamChats()).toBe(0);
  });

  it("refuses a body over 1 MiB with 413", async () => {
    const key = issue(scopeFor(100));
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: JSON.stringify({
        model: "m1",
        messages: [{ role: "user", content: "x".repeat(1024 * 1024) }],
      }),
    });
    expect(reply.status).toBe(413);
    expect(upstreamChats()).toBe(0);
  });
});

describe("request guards", () => {
  it("answers 401 without a key, with an unknown key, with a revoked key and with an expired key", async () => {
    const scope = scopeFor(100);
    const key = issue(scope);
    const path = "/v1/chat/completions";
    expect((await send(portOf(), { path, body: chatBody() })).status).toBe(401);
    expect(
      (await send(portOf(), { path, headers: bearer("not-a-key"), body: chatBody() })).status,
    ).toBe(401);
    const expiring = issue(scopeFor(100), { ttlMs: 1000 });
    clock.advance(1000);
    expect(
      (await send(portOf(), { path, headers: bearer(expiring), body: chatBody() })).status,
    ).toBe(401);
    broker.revokeRun(scope.runId);
    expect((await send(portOf(), { path, headers: bearer(key), body: chatBody() })).status).toBe(
      401,
    );
    expect(upstreamChats()).toBe(0);
  });

  it("answers 403 to any Origin header", async () => {
    const key = issue(scopeFor(100));
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: { ...bearer(key), origin: "https://evil.example" },
      body: chatBody(),
    });
    expect(reply.status).toBe(403);
    expect(upstreamChats()).toBe(0);
  });

  it("answers 421 to a Host other than the loopback address and port, and accepts localhost", async () => {
    const key = issue(scopeFor(100));
    const wrong = await send(portOf(), {
      path: "/v1/models",
      method: "GET",
      headers: { ...bearer(key), host: "evil.test" },
    });
    expect(wrong.status).toBe(421);
    const localhost = await send(portOf(), {
      path: "/v1/models",
      method: "GET",
      headers: { ...bearer(key), host: `localhost:${portOf()}` },
    });
    expect(localhost.status).toBe(200);
  });

  it("answers 421 when the Host header is missing", async () => {
    const key = issue(scopeFor(100));
    // Raw HTTP/1.1 without a Host line: Node's client always adds one, so the request is written by hand.
    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect(portOf(), "127.0.0.1", () => {
        socket.write(
          `GET /v1/models HTTP/1.1

Authorization: Bearer ${key}

Connection: close



`,
        );
      });
      let head = "";
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)));
      socket.on("error", reject);
    });
    // Node's parser refuses an HTTP/1.1 request without Host (400) before the broker's own check (421).
    expect([400, 421]).toContain(status);
    expect(upstreamChats()).toBe(0);
  });
});

describe("secrets", () => {
  it("never writes the plaintext key to the database; only its SHA-256 hash", async () => {
    const scope = scopeFor(100);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false }),
    });
    expect(reply.status).toBe(200);
    await broker.close();
    closed.add("broker");
    store.close();
    closed.add("store");
    const hash = createHash("sha256").update(key, "utf8").digest("hex");
    const files = readdirSync(sb.dataDir).map((name) => readFileSync(join(sb.dataDir, name)));
    expect(files.length).toBeGreaterThan(0);
    for (const bytes of files) {
      expect(bytes.includes(Buffer.from(key, "utf8"))).toBe(false);
      expect(bytes.includes(Buffer.from(UPSTREAM_KEY, "utf8"))).toBe(false);
    }
    expect(files.some((bytes) => bytes.includes(Buffer.from(hash, "utf8")))).toBe(true);
  });
});

describe("upstream stream release (M2-T6)", () => {
  it("returns the upstream stream once a completed reply has been sent, so no request deadline stays armed", async () => {
    const released: string[] = [];
    // A stand-in upstream whose stream records its own cleanup: a completed reply must run it.
    const stream: UpstreamClient = {
      chatRaw() {
        return (async function* () {
          try {
            yield {
              json: { choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] },
              outputBytes: 2,
              usage: null,
              finishReason: "stop",
              error: null,
            };
          } finally {
            released.push("upstream");
          }
        })();
      },
    };
    const own = await startBroker({
      resolveUpstream: () => stream,
      ledger: store,
      clock,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const scope = scopeFor(100);
      const key = own.issueKey({
        runId: scope.runId,
        providerId: "stand-in",
        taskId: scope.taskId,
        projectId,
        models: ["m1"],
        maxTokensPerRequest: 500,
        budgetIds: [scope.taskBudget, projectBudget],
        ttlMs: 60_000,
      });
      const reply = await send(Number(new URL(own.url).port), {
        path: "/v1/chat/completions",
        headers: bearer(key),
        body: chatBody({ messages: MESSAGES }),
      });
      expect(reply.status).toBe(200);
      expect(released).toEqual(["upstream"]);
    } finally {
      await own.close();
    }
  });
});

// An agent (Pi) uses tools through the Broker: the request carries tools and tool messages, and the reply carries
// tool_calls. The Broker is a controlled transparent proxy for these shapes, so none of them may be dropped.
const TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};
const TOOL_HISTORY = [
  { role: "user", content: "read a.ts" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
];

interface ToolCallChunk {
  readonly choices: {
    readonly delta?: {
      readonly tool_calls?: {
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: unknown;
}

function sseChunks(text: string): ToolCallChunk[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice("data: ".length)) as ToolCallChunk);
}

describe("tools through the Broker (Pi agent)", () => {
  it("forwards tools and tool_choice to the upstream unchanged", async () => {
    const key = issue(scopeFor(1000));
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false, messages: TOOL_HISTORY, tools: [TOOL], tool_choice: "auto" }),
    });
    expect(reply.status).toBe(200);
    const forwarded = upstream.requests.at(-1)?.body as Record<string, unknown>;
    expect(forwarded.tools).toEqual([TOOL]);
    expect(forwarded.tool_choice).toBe("auto");
  });

  it("forwards assistant tool_calls and tool messages verbatim", async () => {
    const key = issue(scopeFor(1000));
    await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false, messages: TOOL_HISTORY, tools: [TOOL] }),
    });
    const forwarded = upstream.requests.at(-1)?.body as { messages: unknown };
    expect(forwarded.messages).toEqual(TOOL_HISTORY);
  });

  it("streams tool_calls deltas intact, with the arguments reassembled and finish_reason tool_calls", async () => {
    upstream.setCompletion({
      toolCalls: [
        {
          id: "call_1",
          name: "read_file",
          argumentFragments: ['{"pa', 'th":"a.', 'ts"}'],
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    });
    const scope = scopeFor(1000);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: true, messages: MESSAGES, tools: [TOOL] }),
    });
    expect(reply.status).toBe(200);
    expect(reply.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const chunks = sseChunks(reply.text);
    const calls = chunks.flatMap((chunk) =>
      chunk.choices.flatMap((choice) => choice.delta?.tool_calls ?? []),
    );
    expect(calls[0]?.function?.name).toBe("read_file");
    const args = calls.map((call) => call.function?.arguments ?? "").join("");
    expect(args).toBe('{"path":"a.ts"}');
    const finish = chunks.flatMap((chunk) => chunk.choices.map((c) => c.finish_reason ?? null));
    expect(finish).toContain("tool_calls");
    expect(reply.text).toContain('"usage"');
    expect(taskBudget(scope.taskBudget)).toMatchObject({ spent: 19, reserved: 0 });
  });

  it("returns a non-streamed tool call as message.tool_calls, with usage settled", async () => {
    upstream.setCompletion({
      toolCalls: [{ id: "call_9", name: "read_file", argumentFragments: ['{"path":"b.ts"}'] }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    });
    const scope = scopeFor(1000);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false, messages: MESSAGES, tools: [TOOL] }),
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.text) as {
      choices: { message: { tool_calls: unknown[] }; finish_reason: string }[];
      usage: unknown;
    };
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices[0]?.message.tool_calls).toEqual([
      {
        id: "call_9",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"b.ts"}' },
      },
    ]);
    expect(body.usage).toBeDefined();
    expect(taskBudget(scope.taskBudget)).toMatchObject({ spent: 19, reserved: 0 });
  });

  it("drops fields outside the allowlist and keeps the allowlisted ones", async () => {
    const key = issue(scopeFor(1000));
    await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({
        stream: false,
        user: "someone",
        metadata: { run: "x" },
        logprobs: true,
        temperature: 0.2,
        reasoning_effort: "low",
      }),
    });
    const forwarded = upstream.requests.at(-1)?.body as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("user");
    expect(forwarded).not.toHaveProperty("metadata");
    expect(forwarded).not.toHaveProperty("logprobs");
    expect(forwarded).toMatchObject({ temperature: 0.2, reasoning_effort: "low", stream: false });
  });

  it("refuses tools that are not an array with 400 before contacting the upstream", async () => {
    const key = issue(scopeFor(1000));
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false, tools: "read_file" }),
    });
    expect(reply.status).toBe(400);
    expect(upstreamChats()).toBe(0);
  });

  it("cuts the stream when the streamed tool-call argument bytes reach the reservation", async () => {
    const big = "x".repeat(30);
    upstream.setCompletion({
      toolCalls: [
        { id: "call_1", name: "f", argumentFragments: Array.from({ length: 6 }, () => big) },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const scope = scopeFor(40);
    const key = issue(scope);
    const reply = await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: true }),
    });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("insufficient_quota");
    expect(reply.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    // Input 11 plus the name and the arguments bytes / 4: the fourth fragment takes the output past the 29 left
    expect(reply.text.split(big)).toHaveLength(4);
    expect(taskBudget(scope.taskBudget)).toMatchObject({ spent: 40, reserved: 0 });
  });
});

describe("haril metrics with the ledger", () => {
  it("shows the input and output tokens and the unreconciled count once entries exist", async () => {
    const key = issue(scopeFor(100));
    await send(portOf(), {
      path: "/v1/chat/completions",
      headers: bearer(key),
      body: chatBody({ stream: false }),
    });
    const h = harness();
    expect(await run(["metrics", "--json"], h.io, sb.host)).toBe(0);
    expect(parseJson<{ tokens: unknown }>(h.out).tokens).toEqual({
      input: 12,
      output: 7,
      unreconciled: 0,
    });
  });
});
