import {
  createMemoryService,
  type MemoryService,
  type MemoryWriteDraft,
  NullMemoryProvider,
} from "@haril/core";
import type { MemoryProvider, Store } from "@haril/core/ports";
import { FakeMemoryProvider, fakeMemoryDeps, Sha256Hasher } from "@haril/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.js";
import { type ManualClock, manualClock, sequentialIds, testRules } from "./support.js";

// core/memory's service over the real Store (MC-T4; memory.md 4.3 to 4.5, 8.2; ADR-0008 D4 to D6; ARCH 8.3, AR-G14):
// writes go through memory_outbox and never through events, delivery is at least once and deduplicated by operationId,
// reads come back empty while the provider is unavailable, memory.degraded is emitted once per transition, and only a
// task whose requires[] has memory waits for it. The provider is the fault fake declared persistent, so writes queue.

// The contract types as the service takes them (state-sqlite depends on @haril/core, not on @haril/contracts).
type MemoryWriteScope = MemoryWriteDraft["scope"];
type RecallRequest = Parameters<MemoryService["recall"]>[0];

const SESSION = "01HMEMSESSION0000000000001";
const CONTENT = "fake content: the parser keeps its tokens in a ring buffer";

let clock: ManualClock;
let store: Store;
let projectId: string;
let epoch: number;
let provider: FakeMemoryProvider;
let scope: MemoryWriteScope;

function acquire(): number {
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.21.0",
    sqliteVersion: "3.53.3",
    ttlMs: 600_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  return grant.value.epoch;
}

function serviceFor(target: MemoryProvider, runtimeEpoch = epoch): MemoryService {
  return createMemoryService({
    store,
    provider: target,
    clock,
    ids: sequentialIds("fake-op"),
    hasher: new Sha256Hasher(),
    epoch: runtimeEpoch,
  });
}

beforeEach(() => {
  clock = manualClock();
  store = openMemoryStore({ clock, ids: sequentialIds(), rules: testRules });
  projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: "D:/demo",
  }).projectId;
  epoch = acquire();
  provider = new FakeMemoryProvider(fakeMemoryDeps(), { persistent: true });
  scope = {
    workspaceId: store.info().storeId,
    projectKey: projectId,
    visibility: "project",
    sessionId: SESSION,
    kind: "decision",
  };
});

afterEach(() => {
  store.close();
});

function draft(content = CONTENT) {
  return { scope, title: "fake ring buffer", content, origin: "haril" as const };
}

function recallRequest(): RecallRequest {
  return { schemaVersion: 1, scope, budgetTokens: 1_000, includePinned: false, maxItems: 5 };
}

function eventsOf(type: string) {
  return store.events.list().filter((event) => event.type === type);
}

function storeCalls(): string[] {
  return provider
    .calls()
    .filter((call) => call.operation === "store")
    .map((call) => call.operationId ?? "");
}

async function recordedTitles(): Promise<string[]> {
  const bundle = await provider.inner.recall(recallRequest());
  return bundle.ok ? bundle.value.items.map((item) => item.title).sort() : [];
}

describe("memory writes (RF-127, MEM-03)", () => {
  it("a write to a persistent provider is a pending outbox row first, delivered by the drain", async () => {
    const service = serviceFor(provider);
    await service.start();
    const queued = await service.enqueueWrite(draft());
    expect(queued).toEqual({ ok: true, value: { operationId: "fake-op-000001", queued: true } });
    expect(storeCalls()).toEqual([]);
    expect(store.memory.get("fake-op-000001")).toMatchObject({ status: "pending", op: "store" });

    await service.tick();
    expect(storeCalls()).toEqual(["fake-op-000001"]);
    expect(store.memory.get("fake-op-000001")).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await recordedTitles()).toEqual(["fake ring buffer"]);
    expect(store.memory.refs(projectId)).toMatchObject([
      {
        provider: "in-memory",
        direction: "out",
        kind: "decision",
        origin: "haril",
        operationId: "fake-op-000001",
      },
    ]);
    expect(eventsOf("memory.stored").map((event) => event.payload)).toEqual([
      expect.objectContaining({
        operationId: "fake-op-000001",
        op: "store",
        provider: "in-memory",
        outcome: "created",
        truncated: false,
        redacted: false,
        kind: "decision",
        projectId,
      }),
    ]);
    expect(eventsOf("memory.outbox.flushed").map((event) => event.payload)).toEqual([
      { provider: "in-memory", delivered: 1, remaining: 0 },
    ]);
    // events is never the channel to memory: no event carries the content.
    for (const event of store.events.list()) {
      expect(JSON.stringify(event.payload)).not.toContain("ring buffer");
    }
  });

  it("[CM-04] a provider that does not persist is never queued: Null discards the write", async () => {
    const service = serviceFor(new NullMemoryProvider(fakeMemoryDeps()));
    await service.start();
    const written = await service.enqueueWrite(draft());
    expect(written).toMatchObject({
      ok: true,
      value: { queued: false, receipt: { outcome: "discarded", provider: "null" } },
    });
    expect(store.memory.status().outbox).toMatchObject({ pending: 0, sending: 0, delivered: 0 });
  });

  it("refuses a write the provider cannot take whole, instead of truncating it in silence", async () => {
    const service = serviceFor(provider);
    const oversized = await service.enqueueWrite(draft("x".repeat(50_001)));
    expect(oversized).toMatchObject({ ok: false, error: { code: "contract.invalid" } });
    const invalid = await service.enqueueWrite({ ...draft(), title: "" });
    expect(invalid).toMatchObject({ ok: false, error: { code: "contract.invalid" } });
    expect(store.memory.status().outbox.pending).toBe(0);
  });
});

describe("at-least-once delivery (MEM-04, MEM-16, AR-G14)", () => {
  it("[MC-01] an answer lost after the provider applied the write is redelivered without a duplicate", async () => {
    const service = serviceFor(provider);
    await service.start();
    await service.enqueueWrite(draft());
    provider.ambiguousNext("store");
    await service.tick();
    expect(store.memory.get("fake-op-000001")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "Unavailable",
    });

    clock.advance(60_000);
    await service.tick();
    expect(storeCalls()).toEqual(["fake-op-000001", "fake-op-000001"]);
    expect(store.memory.get("fake-op-000001")).toMatchObject({ status: "delivered", attempts: 2 });
    expect(await recordedTitles()).toEqual(["fake ring buffer"]);
    expect(store.memory.refs(projectId)).toHaveLength(1);
    expect(eventsOf("memory.stored")).toHaveLength(1);
  });

  it("an outage keeps the row pending with its operation id, and the recovery delivers it in order", async () => {
    const service = serviceFor(provider);
    await service.start();
    provider.makeUnavailable();
    await service.enqueueWrite(draft());
    await service.enqueueWrite({ ...draft("fake second content"), title: "fake second" });
    await service.tick();
    expect(store.memory.status().outbox).toMatchObject({ pending: 2, sending: 0 });
    expect(service.state).toBe("degraded");
    // While degraded the outbox is not drained; health is retried with a backoff instead.
    clock.advance(500);
    await service.tick();
    expect(storeCalls()).toEqual(["fake-op-000001"]);

    provider.restore();
    clock.advance(60_000);
    await service.tick();
    expect(service.state).toBe("active");
    expect(storeCalls()).toEqual(["fake-op-000001", "fake-op-000001", "fake-op-000002"]);
    expect(await recordedTitles()).toEqual(["fake ring buffer", "fake second"]);
    expect(eventsOf("memory.outbox.flushed").map((event) => event.payload)).toEqual([
      { provider: "in-memory", delivered: 2, remaining: 0 },
    ]);
  });

  it("[MEM-16] start requeues the rows an earlier runtime left sending and delivers them once", async () => {
    await serviceFor(provider).enqueueWrite(draft());
    store.memory.claimDue(epoch, 1);
    store.runtime.release(epoch, false);
    const next = acquire();

    await serviceFor(provider, next).start();
    expect(store.memory.get("fake-op-000001")).toMatchObject({ status: "delivered", attempts: 2 });
    expect(storeCalls()).toEqual(["fake-op-000001"]);
  });

  it("a failure that a retry cannot fix is not retried: SessionEnded waits for review, Unsupported is dead", async () => {
    const service = serviceFor(provider);
    await service.start();
    await service.enqueueWrite(draft());
    provider.endSession(SESSION);
    await service.tick();
    expect(store.memory.get("fake-op-000001")).toMatchObject({
      status: "needs_review",
      lastError: "SessionEnded",
    });

    await service.enqueueWrite({
      ...draft(),
      scope: { ...scope, sessionId: "01HMEMSESSION0000000000009" },
    });
    provider.failNext("store", {
      code: "Unsupported",
      category: "memory",
      retryable: false,
      message: "fake unsupported",
    });
    await service.tick();
    expect(store.memory.get("fake-op-000002")).toMatchObject({
      status: "dead",
      lastError: "Unsupported",
    });
    expect(service.state).toBe("active");
    expect(eventsOf("memory.degraded")).toHaveLength(0);
  });
});

describe("degradation (RF-128, MEM-08, ESC-09)", () => {
  it("reads come back empty while the provider is unavailable, and the task goes on", async () => {
    const service = serviceFor(provider);
    await service.start();
    provider.makeUnavailable();
    expect(await service.recall(recallRequest())).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        scope,
        budgetTokens: 1_000,
        usedTokens: 0,
        items: [],
        omittedCount: 0,
        degraded: true,
      },
    });
    expect(
      await service.search({ schemaVersion: 1, scope, text: "ring", matchMode: "all", limit: 5 }),
    ).toEqual({ ok: true, value: { items: [] } });
  });

  it("emits one memory.degraded per transition, and memory.recovered on the way back", async () => {
    const service = serviceFor(provider);
    await service.start();
    provider.makeUnavailable();
    await service.recall(recallRequest());
    await service.recall(recallRequest());
    clock.advance(120_000);
    await service.tick();
    expect(eventsOf("memory.degraded")).toHaveLength(1);
    expect(store.memory.status()).toMatchObject({ provider: "in-memory", lastState: "degraded" });

    provider.restore();
    clock.advance(120_000);
    await service.tick();
    await service.tick();
    expect(eventsOf("memory.recovered")).toHaveLength(1);
    expect(store.memory.status().lastState).toBe("active");

    provider.makeUnavailable();
    await service.recall(recallRequest());
    expect(eventsOf("memory.degraded")).toHaveLength(2);
  });

  it("[MC-04] a task without memory is never blocked; one that requires it waits, then returns to ready", async () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: {
        plan: {
          schemaVersion: 1,
          tasks: ["plain", "recall"].map((localId) => ({
            localId,
            dependsOn: [],
            goal: `goal ${localId}`,
            description: "",
            priority: 0,
            kind: "work",
            agent: "fake:succeed",
            requires: localId === "recall" ? ["memory"] : [],
            context: [],
            surface: { write: [], read: [] },
            budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 0 },
            timeoutMs: 1000,
            maxAttempts: 1,
            acceptance: [],
          })),
        },
      },
      idempotencyKey: "fake-key-1",
      requestHash: "fake-hash-1",
    });
    store.commands.applyNext(epoch);
    const stateOf = (goal: string) => store.tasks.list().find((task) => task.goal === goal)?.state;

    provider.makeUnavailable();
    const service = serviceFor(provider);
    const down = await service.start();
    expect(down.blocked.map((task) => task.goal)).toEqual(["goal recall"]);
    expect((await service.tick()).blocked).toEqual([]);
    expect(stateOf("goal recall")).toBe("blocked");
    expect(stateOf("goal plain")).toBe("ready");

    provider.restore();
    clock.advance(60_000);
    const up = await service.tick();
    expect(up.released.map((task) => task.goal)).toEqual(["goal recall"]);
    expect(stateOf("goal recall")).toBe("ready");
    expect(stateOf("goal plain")).toBe("ready");
  });

  it("a task left blocked by a runtime that stopped degraded is released by the next start with memory up", async () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: {
        plan: {
          schemaVersion: 1,
          tasks: [
            {
              localId: "recall",
              dependsOn: [],
              goal: "goal recall",
              description: "",
              priority: 0,
              kind: "work",
              agent: "fake:succeed",
              requires: ["memory"],
              context: [],
              surface: { write: [], read: [] },
              budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 0 },
              timeoutMs: 1000,
              maxAttempts: 1,
              acceptance: [],
            },
          ],
        },
      },
      idempotencyKey: "fake-key-1",
      requestHash: "fake-hash-1",
    });
    store.commands.applyNext(epoch);
    store.memory.blockTasks(epoch);

    const started = await serviceFor(provider).start();
    expect(started.released.map((task) => task.goal)).toEqual(["goal recall"]);
    expect(store.tasks.list()[0]?.state).toBe("ready");
  });
});
