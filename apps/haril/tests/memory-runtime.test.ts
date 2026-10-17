import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  createMemoryService,
  type RunEvent,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import {
  FakeAgentRuntime,
  FakeMemoryProvider,
  fakeMemoryDeps,
  Sha256Hasher,
} from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryLeftLine } from "../src/runtime/memory.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// Memory in the runtime (MC-T4; ARCH 7.5, 8.3; memory.md 4.4 R-O7, 4.5): without memory configured the runtime uses the
// Null provider and records it; with a provider that is down, only the tasks whose requires[] has memory wait as
// blocked(memory_unavailable), and the others run (PROMPT sec20 "memoria temporalmente inaccesible").
const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
let sb: Sandbox;
let store: Store;
let projectId: string;

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
    isPidAlive: () => true,
  });
  projectId = store.projects.register({ slug: "mem", name: "Memory", rootPath: sb.root }).projectId;
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

function enqueuePlan(): void {
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
          timeoutMs: 120_000,
          maxAttempts: 1,
          acceptance: [],
        })),
      },
    },
    idempotencyKey: "fake-key-plan",
    requestHash: "fake-hash-plan",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Writes an earlier runtime queued for a persistent provider and left for the next one.
async function queueWritesFromAnEarlierRuntime(count: number): Promise<void> {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 600_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  const earlier = createMemoryService({
    store,
    provider: new FakeMemoryProvider(fakeMemoryDeps(), { persistent: true }),
    clock,
    ids: { next: () => randomUUID() },
    hasher: new Sha256Hasher(),
    epoch: grant.value.epoch,
  });
  for (let index = 1; index <= count; index += 1) {
    const queued = await earlier.enqueueWrite({
      scope: {
        workspaceId: store.info().storeId,
        projectKey: projectId,
        visibility: "project",
        sessionId: "01HMEMSESSION0000000000001",
        kind: "discovery",
      },
      title: `fake write ${index}`,
      content: `fake content ${index}`,
      origin: "haril",
    });
    if (!queued.ok || !queued.value.queued) throw new Error("the write was not queued");
  }
  store.runtime.release(grant.value.epoch, true);
}

function taskByGoal(goal: string) {
  const task = store.tasks.list().find((candidate) => candidate.goal === goal);
  return task === undefined ? undefined : store.tasks.get(task.taskId);
}

describe("memory in the runtime (MC-T4)", () => {
  it("without memory configured, records the Null provider as active and blocks nothing", async () => {
    enqueuePlan();
    const result = await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: () => undefined,
    });
    expect(result.kind).toBe("idle");
    expect(taskByGoal("goal plain")?.state).toBe("completed");
    expect(taskByGoal("goal recall")?.state).toBe("completed");
    expect(store.memory.status()).toMatchObject({
      provider: "null",
      persistent: false,
      lastState: "active",
    });
  });

  it("with the provider down, only the task that requires memory waits as blocked(memory_unavailable)", async () => {
    enqueuePlan();
    const provider = new FakeMemoryProvider(fakeMemoryDeps(), { persistent: true });
    provider.makeUnavailable();
    const events: RunEvent[] = [];
    const result = await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      memory: { provider, ids: { next: () => randomUUID() }, hasher: new Sha256Hasher() },
      onEvent: (event) => events.push(event),
    });
    expect(result.kind).toBe("idle");
    expect(taskByGoal("goal plain")?.state).toBe("completed");
    expect(taskByGoal("goal recall")).toMatchObject({
      state: "blocked",
      blockReason: "memory_unavailable",
    });
    expect(events).toContainEqual({
      type: "task.blocked",
      taskId: taskByGoal("goal recall")?.taskId,
      goal: "goal recall",
      reason: "memory_unavailable",
    });
    if (result.kind === "idle") expect(result.summary.blocked).toHaveLength(1);
    expect(store.memory.status()).toMatchObject({ provider: "in-memory", lastState: "degraded" });
    expect(store.events.list().filter((event) => event.type === "memory.degraded")).toHaveLength(1);
  });

  it("[MC-T4 fix] renews the lease while memory drains at start, so a slow provider cannot let it lapse", async () => {
    await queueWritesFromAnEarlierRuntime(4);
    const lapses: number[] = [];
    // Each write takes 150 ms; the lease of this runtime lasts 300 ms unless it is renewed.
    class SlowProvider extends FakeMemoryProvider {
      override async store(...args: Parameters<FakeMemoryProvider["store"]>) {
        const lease = store.runtime.leaseSummary();
        if (lease.status !== "active" || lease.expiresAt <= Date.now()) lapses.push(Date.now());
        await sleep(150);
        return super.store(...args);
      }
    }
    const result = await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      leaseTtlMs: 300,
      memory: {
        provider: new SlowProvider(fakeMemoryDeps(), { persistent: true }),
        ids: { next: () => randomUUID() },
        hasher: new Sha256Hasher(),
      },
      onEvent: () => undefined,
    });
    expect(result.kind).toBe("idle");
    expect(store.memory.status().outbox).toMatchObject({ delivered: 4, pending: 0 });
    expect(lapses).toEqual([]);
  });

  it("[MC-T4 fix] an idle exit with memory down reports the tasks that wait for it and the queued writes", async () => {
    enqueuePlan();
    await queueWritesFromAnEarlierRuntime(2);
    const provider = new FakeMemoryProvider(fakeMemoryDeps(), { persistent: true });
    provider.makeUnavailable();
    const result = await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      memory: { provider, ids: { next: () => randomUUID() }, hasher: new Sha256Hasher() },
      onEvent: () => undefined,
    });
    expect(result).toMatchObject({
      kind: "idle",
      memory: { state: "degraded", waitingForMemory: 1, queuedWrites: 2 },
    });
    if (result.kind === "busy") throw new Error("the lease was not taken");
    expect(memoryLeftLine(result.memory)).toBe(
      "memory degraded: 1 task waits for memory and 2 writes are queued; they resume on the next haril start or haril run",
    );
  });

  it("an idle exit with nothing left for memory says nothing about it", async () => {
    const result = await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: () => undefined,
    });
    if (result.kind === "busy") throw new Error("the lease was not taken");
    expect(result.memory).toEqual({ state: "active", waitingForMemory: 0, queuedWrites: 0 });
    expect(memoryLeftLine(result.memory)).toBeUndefined();
    expect(memoryLeftLine({ state: "degraded", waitingForMemory: 2, queuedWrites: 0 })).toBe(
      "memory degraded: 2 tasks wait for memory; they resume on the next haril start or haril run",
    );
    expect(memoryLeftLine({ state: "active", waitingForMemory: 0, queuedWrites: 1 })).toBe(
      "memory active: 1 write is queued; it resumes on the next haril start or haril run",
    );
  });
});
