import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MemoryWrite,
  MemoryWriteScope,
  ScopeRef,
  SummarizeWrite,
  Visibility,
} from "@haril/contracts";
import { outboxTransitionOf } from "@haril/core";
import type { MemoryFailure, MemoryResult } from "@haril/core/ports";
import { cancelSignal, fakeMemoryDeps } from "@haril/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngramMemoryProvider, type EngramMemoryProviderOptions } from "../src/index.js";
import { FakeEngramServer } from "../testing/fake-engram-server.js";

// The Engram adapter beyond the contract suite: what it sends (ADR-0008 T8: explicit project and session, never
// all_projects, capture_prompt false), how each answer maps to a typed failure (memory.md 4.4; MEMORY.md 4.2 [S]),
// its own deadline, the ambiguous write (R-O6), the identity of the serve (ADR-0008 D4), and that it never contacts
// a reserved port such as 7437.

const WORKSPACE = "01HWORKSPACE00000000000001";
const PROJECT = "01HPROJECT0000000000000001";
const SESSION = "01HSESSION0000000000000001";
const SCOPE: ScopeRef = {
  workspaceId: WORKSPACE,
  projectKey: PROJECT,
  visibility: "project",
  sessionId: SESSION,
};
const ENGRAM_PROJECT = `${WORKSPACE}:${PROJECT}`;

let server: FakeEngramServer;
let dataRoot = "";
let operations = 0;
const deps = () => fakeMemoryDeps("mem");

beforeEach(async () => {
  dataRoot = mkdtempSync(join(tmpdir(), "haril-engram-provider-"));
  server = new FakeEngramServer();
  await server.start();
});

afterEach(async () => {
  await server.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

function provider(overrides: Partial<EngramMemoryProviderOptions> = {}): EngramMemoryProvider {
  return new EngramMemoryProvider(deps(), {
    engramVersion: "3.4.0",
    harilDataDir: dataRoot,
    connect: async () => ({
      ok: true,
      value: {
        baseUrl: server.url,
        token: server.token,
        instanceId: server.instanceId,
        dataDir: null,
      },
    }),
    ...overrides,
  });
}

function write(fields: Partial<MemoryWrite> & { scope?: MemoryWriteScope } = {}): MemoryWrite {
  operations += 1;
  const content = fields.content ?? "fake engram content";
  return {
    schemaVersion: 1,
    operationId: `fake-op-${operations}`,
    scope: fields.scope ?? { ...SCOPE, kind: "discovery" },
    title: fields.title ?? "fake engram title",
    content,
    contentSha256: deps().hasher.sha256(content),
    origin: "haril",
    ...(fields.topicKey === undefined ? {} : { topicKey: fields.topicKey }),
  };
}

function summary(text: string): SummarizeWrite {
  operations += 1;
  return {
    schemaVersion: 1,
    operationId: `fake-op-${operations}`,
    scope: SCOPE,
    session: { provider: "engram", sessionId: SESSION },
    text,
    textSha256: deps().hasher.sha256(text),
  };
}

async function failureOf(call: MemoryResult<unknown>): Promise<MemoryFailure> {
  const result = await call;
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result.error;
}

// A loopback port nothing listens on: bound once, then released.
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("what the Engram adapter sends", () => {
  it("names the project and the session on every scoped request, never all_projects, and never captures the prompt", async () => {
    const memory = provider();
    const stored = await memory.store(write({ content: "zqxwire one" }));
    expect(stored.ok).toBe(true);
    await memory.search({
      schemaVersion: 1,
      scope: SCOPE,
      text: "zqxwire",
      matchMode: "all",
      limit: 5,
    });
    await memory.recall({
      schemaVersion: 1,
      scope: SCOPE,
      budgetTokens: 1000,
      query: "zqxwire",
      includePinned: true,
      maxItems: 5,
    });
    await memory.summarize(summary("fake wire summary"));
    const scoped = server.requests.filter((request) => request.route !== "health");
    expect(scoped.length).toBeGreaterThan(4);
    for (const request of scoped) {
      expect(request.query).not.toHaveProperty("all_projects");
      const project =
        request.query.project ??
        request.query.expected_project ??
        (request.body as { project?: string } | undefined)?.project;
      if (request.route !== "sessions.end" && request.route !== "observations.save-result") {
        expect(project, `${request.method} ${request.path}`).toBe(ENGRAM_PROJECT);
      }
      expect(request.authorization).toBe(`Bearer ${server.token}`);
    }
    const adds = server.requests.filter((request) => request.route === "observations.add");
    expect(adds).toHaveLength(1);
    expect(adds[0]?.body).toMatchObject({
      session_id: SESSION,
      project: ENGRAM_PROJECT,
      scope: "project",
      type: "discovery",
      operation_id: "fake-op-1",
      capture_prompt: false,
    });
    expect(adds[0]?.body).not.toHaveProperty("current_prompt");
  });

  it("maps a convention to Engram's policy type and the _knowledge key with personal visibility to its own project", async () => {
    const visibilities: Visibility[] = ["project", "personal"];
    const memory = provider({ visibilities });
    const knowledge: MemoryWriteScope = {
      ...SCOPE,
      projectKey: "_knowledge",
      visibility: "personal",
      kind: "convention",
    };
    const stored = await memory.store(
      write({ scope: knowledge, topicKey: "convention/zqxnaming" }),
    );
    expect(stored.ok).toBe(true);
    const add = server.requests.find((request) => request.route === "observations.add");
    expect(add?.body).toMatchObject({
      project: `${WORKSPACE}:_knowledge`,
      scope: "personal",
      type: "policy",
      topic_key: "convention/zqxnaming",
    });
    const record = await memory.get(
      { provider: "engram", providerRef: String(stored.ok ? stored.value.providerRef : "") },
      knowledge,
    );
    expect(record.ok && record.value.kind).toBe("convention");
    expect(record.ok && record.value.scope.projectKey).toBe("_knowledge");
  });

  it("redacts <private> and truncates to valid UTF-8 before sending, and the receipt says so", async () => {
    const memory = provider();
    const content = `<private>fake-hidden-value</private>${"€".repeat(20_000)}`;
    const stored = await memory.store(write({ content }));
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value).toMatchObject({ truncated: true, redacted: true, limitBytes: 50_000 });
    const add = server.requests.find((request) => request.route === "observations.add");
    const sent = (add?.body as { content?: string } | undefined)?.content ?? "";
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(50_000);
    expect(sent).not.toContain("fake-hidden-value");
    expect(sent.startsWith("[REDACTED]€")).toBe(true);
  });
});

describe("how each answer maps to a typed failure", () => {
  it("a refused connection, a 5xx and a 401 are retryable Unavailable", async () => {
    const port = await closedPort();
    const refused = provider({
      connect: async () => ({
        ok: true,
        value: {
          baseUrl: `http://127.0.0.1:${port}`,
          token: "fake-token",
          instanceId: "fake-instance",
          dataDir: null,
        },
      }),
    });
    const down = await failureOf(refused.open(SCOPE));
    expect(down).toMatchObject({ code: "Unavailable", retryable: true });

    const memory = provider();
    server.setFault("search", "5xx");
    const busy = await failureOf(
      memory.search({ schemaVersion: 1, scope: SCOPE, text: "x y z", matchMode: "all", limit: 1 }),
    );
    expect(busy).toMatchObject({ code: "Unavailable", retryable: true });
    server.clearFaults();

    const wrongToken = new EngramMemoryProvider(deps(), {
      engramVersion: "3.4.0",
      harilDataDir: dataRoot,
      connect: async () => ({
        ok: true,
        value: {
          baseUrl: server.url,
          token: "fake-other-token",
          instanceId: server.instanceId,
          dataDir: null,
        },
      }),
    });
    const stored = await memory.store(write());
    const ref = {
      provider: "engram",
      providerRef: stored.ok ? (stored.value.providerRef ?? "") : "",
    };
    const unauthorized = await failureOf(
      wrongToken.forget({
        schemaVersion: 1,
        operationId: "fake-op-forget-1",
        ref,
        mode: "soft",
        expectedScope: SCOPE,
      }),
    );
    expect(unauthorized).toMatchObject({ code: "Unavailable", retryable: true });
  });

  it("an unknown record is NotFound, a session of another project ScopeMismatch, an ended one SessionEnded", async () => {
    const memory = provider();
    const missing = await failureOf(memory.get({ provider: "engram", providerRef: "999" }, SCOPE));
    expect(missing.code).toBe("NotFound");
    expect((await memory.open(SCOPE)).ok).toBe(true);
    const crossed = await failureOf(memory.open({ ...SCOPE, projectKey: "fake-project-b" }));
    expect(crossed.code).toBe("ScopeMismatch");
    server.endSessionOutside(SESSION, "fake ended elsewhere");
    const ended = await failureOf(memory.store(write()));
    expect(ended.code).toBe("SessionEnded");
  });

  it("an ambiguous store is resolved through save-result before it answers", async () => {
    const memory = provider();
    server.setFault("observations.add", "ambiguous", { times: 1 });
    const stored = await memory.store(write({ content: "zqxresolved" }));
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value.outcome).toBe("created");
    expect(server.stored().filter((row) => row.content === "zqxresolved")).toHaveLength(1);
    expect(server.requests.map((request) => request.route)).toContain("observations.save-result");
  });

  it("a write whose ledger entry expired (410) is an unknown result: non-retryable Unavailable, so the row goes to review", async () => {
    const memory = provider();
    const lost = write({ content: "zqxexpired" });
    server.expireOperations(lost.operationId);
    const failure = await failureOf(memory.store(lost));
    expect(failure).toMatchObject({ code: "Unavailable", retryable: false });
    expect(failure.details?.unknownResult).toBe(true);
    expect(outboxTransitionOf(failure, 1)).toBe("needs_review");

    server.setFault("observations.add", "ambiguous", { times: 1 });
    const second = write({ content: "zqxexpired lookup" });
    const pending = memory.store(second);
    // The answer is lost and the ledger forgets the operation before the lookup asks for it.
    server.expireOperations(second.operationId);
    const unresolved = await failureOf(pending);
    expect(unresolved).toMatchObject({ code: "Unavailable", retryable: false });
  });

  it("a slow write times out at its own deadline, and its retry with the same operationId writes once", async () => {
    const slow = new FakeEngramServer({ slowMs: 300 });
    await slow.start();
    try {
      const memory = provider({
        callDeadlineMs: 2000,
        requestTimeoutMs: 100,
        connect: async () => ({
          ok: true,
          value: {
            baseUrl: slow.url,
            token: slow.token,
            instanceId: slow.instanceId,
            dataDir: null,
          },
        }),
      });
      expect((await memory.open(SCOPE)).ok).toBe(true);
      slow.setFault("observations.add", "slow", { times: 1 });
      const late = write({ content: "zqxlate" });
      const started = Date.now();
      const failure = await failureOf(memory.store(late));
      expect(failure).toMatchObject({ code: "Unavailable", retryable: true });
      expect(Date.now() - started).toBeLessThan(1500);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const retried = await memory.store(late);
      expect(retried.ok && retried.value.outcome).toBe("created");
      expect(slow.stored().filter((row) => row.content === "zqxlate")).toHaveLength(1);
    } finally {
      await slow.close();
    }
  });

  it("no call outlives its deadline, even when every request hangs", async () => {
    const slow = new FakeEngramServer({ slowMs: 5000 });
    await slow.start();
    try {
      const memory = provider({
        callDeadlineMs: 250,
        connect: async () => ({
          ok: true,
          value: {
            baseUrl: slow.url,
            token: slow.token,
            instanceId: slow.instanceId,
            dataDir: null,
          },
        }),
      });
      slow.setFault("all", "slow");
      const started = Date.now();
      const failure = await failureOf(memory.store(write()));
      expect(failure).toMatchObject({ code: "Unavailable", retryable: true });
      expect(failure.details?.timeout).toBe(true);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await slow.close();
    }
  });

  it("a call cancelled in flight answers at once with details.cancelled", async () => {
    const slow = new FakeEngramServer({ slowMs: 3000 });
    await slow.start();
    try {
      const memory = provider({
        connect: async () => ({
          ok: true,
          value: {
            baseUrl: slow.url,
            token: slow.token,
            instanceId: slow.instanceId,
            dataDir: null,
          },
        }),
      });
      expect((await memory.open(SCOPE)).ok).toBe(true);
      slow.setFault("observations.add", "slow");
      const signal = cancelSignal();
      const started = Date.now();
      const pending = memory.store(write(), { signal });
      setTimeout(() => signal.cancel(), 50);
      const failure = await failureOf(pending);
      expect(failure).toMatchObject({ code: "Unavailable", retryable: true });
      expect(failure.details?.cancelled).toBe(true);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await slow.close();
    }
  });

  it("maps each status of the answer table", async () => {
    const cases: readonly (readonly [number, unknown, MemoryFailure["code"], boolean])[] = [
      [400, { error: "bad request" }, "contract.invalid", false],
      [404, { error: "session_not_found" }, "NotFound", false],
      [409, { error: "ambiguous_project" }, "ScopeMismatch", false],
      [409, { error: "session_project_conflict" }, "ScopeMismatch", false],
      [409, { error: "session_already_ended" }, "SessionEnded", false],
      [410, { error: "operation_expired" }, "Unavailable", false],
      [413, { error: "too large" }, "contract.invalid", false],
      [429, { error: "busy" }, "Unavailable", true],
      [500, { error: "SQLITE_BUSY" }, "Unavailable", true],
      [503, { error: "restarting" }, "Unavailable", true],
    ];
    for (const [status, body, code, retryable] of cases) {
      const fetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", version: "3.4.0", instance_id: "fake-instance" });
        }
        return Response.json(body, { status });
      };
      const memory = provider({
        fetch,
        connect: async () => ({
          ok: true,
          value: {
            baseUrl: server.url,
            token: "fake-token",
            instanceId: "fake-instance",
            dataDir: null,
          },
        }),
      });
      const failure = await failureOf(memory.open(SCOPE));
      expect({ status, code: failure.code, retryable: failure.retryable }).toEqual({
        status,
        code,
        retryable,
      });
    }
  });
});

describe("the identity of the serve", () => {
  it("answers Unavailable when the serve on the port is not the instance of HARIL's data dir, or not the pinned version", async () => {
    for (const [instanceId, version] of [
      ["fake-other-instance", "3.4.0"],
      [server.instanceId, "3.3.2"],
    ] as const) {
      const memory = provider({
        engramVersion: version,
        connect: async () => ({
          ok: true,
          value: { baseUrl: server.url, token: server.token, instanceId, dataDir: null },
        }),
      });
      const failure = await failureOf(memory.open(SCOPE));
      expect(failure).toMatchObject({ code: "Unavailable" });
      const health = await memory.health();
      expect(health.state).toBe("degraded");
    }
    expect(server.requests.filter((request) => request.route !== "health")).toEqual([]);
  });

  it("never contacts a reserved port such as 7437, a port 0 or a host that is not 127.0.0.1", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return Response.json({});
    };
    for (const baseUrl of [
      "http://127.0.0.1:7437",
      "http://localhost:7437",
      "http://127.0.0.1:0",
      `http://localhost:${server.port}`,
      `http://192.168.1.10:${server.port}`,
      `https://127.0.0.1:${server.port}`,
    ]) {
      const memory = provider({
        fetch,
        connect: async () => ({
          ok: true,
          value: { baseUrl, token: "fake-token", instanceId: "fake-instance", dataDir: null },
        }),
      });
      const failure = await failureOf(memory.open(SCOPE));
      expect(failure.code, baseUrl).toBe("Unavailable");
      expect((await memory.health()).state).toBe("degraded");
    }
    expect(calls).toEqual([]);
  });
});

describe("health", () => {
  it("is active after a real read, degraded when the read fails while the ping answers, and degraded without a serve", async () => {
    const memory = provider();
    const active = await memory.health();
    expect(active).toMatchObject({
      state: "active",
      realReadOk: true,
      version: "3.4.0",
      instanceId: server.instanceId,
    });
    expect(server.requests.map((request) => request.route)).toContain("search");
    server.setFault("search", "5xx");
    expect(await memory.health()).toMatchObject({ state: "degraded", realReadOk: false });
    server.clearFaults();
    const absent = provider({
      connect: async () => ({
        ok: false,
        error: { code: "memory.serve_unavailable", message: "fake: no serve" },
      }),
    });
    expect(await absent.health()).toMatchObject({ state: "degraded", realReadOk: null });
  });
});
