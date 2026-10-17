import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  type RunEvent,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// The idle wait of `haril start` (LD-T1, ARCH 4.2): the runtime keeps its lease and watches the queue until
// idleExitMs passes with nothing to do; a runtime.stop applied during an attempt cancels that attempt uncharged.
const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
let sb: Sandbox;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules: { canTransition, checkPlan: checkPlanSubmission, checkAcceptance, canonicalJson },
    // Every pid is alive: a lease can only be taken over once it expires.
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

function projectOf(store: Store): string {
  return store.projects.register({ slug: "idle", name: "Idle", rootPath: sb.root }).projectId;
}

function enqueueTask(store: Store, projectId: string, goal: string, agent: string): void {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn: [], agent, maxAttempts: 1, timeoutMs: 120_000 },
    idempotencyKey: `k-${goal}`,
    requestHash: `h-${goal}`,
  });
}

describe("idle wait (LD-T1)", () => {
  it("renews the lease while it waits, so a second runtime cannot take it over before the window passes", async () => {
    const store = open();
    const other = open();
    const run = runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: () => undefined,
      idleExitMs: 2_500,
      pollMs: 50,
      leaseTtlMs: 600,
      shutdown: createShutdown(),
    });

    // Past the TTL of the first acquire (600 ms): only the heartbeat keeps the lease from expiring.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const grab = other.runtime.acquire({
      pid: process.pid + 1,
      nodeVersion: process.version,
      sqliteVersion: other.info().sqliteVersion,
      ttlMs: 600,
    });
    expect(grab.ok).toBe(false);

    const result = await run;
    expect(result.kind).toBe("idle");
  }, 15_000);

  it("runs a task queued during the window, then exits once the window has passed", async () => {
    const store = open();
    const projectId = projectOf(store);
    const started = Date.now();
    const run = runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: () => undefined,
      idleExitMs: 1_000,
      pollMs: 50,
      shutdown: createShutdown(),
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    enqueueTask(open(), projectId, "Late", "fake:succeed");
    const result = await run;

    expect(result.kind).toBe("idle");
    if (result.kind === "busy") throw new Error("the lease was busy");
    expect(result.summary.completed).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  }, 15_000);

  it("a stop applied while an attempt runs cancels it: the task returns to ready uncharged and the lease is released", async () => {
    const store = open();
    const projectId = projectOf(store);
    enqueueTask(store, projectId, "Slow", "fake:slow:60000");
    const events: RunEvent[] = [];
    const run = runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: (event) => events.push(event),
      idleExitMs: 120_000,
      pollMs: 50,
      shutdown: createShutdown(),
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    store.commands.enqueue({
      type: "runtime.stop",
      args: {},
      idempotencyKey: "stop",
      requestHash: "stop",
    });
    const result = await run;

    expect(result.kind).toBe("stopped");
    if (result.kind === "busy") throw new Error("the lease was busy");
    expect(result.summary.failed).toEqual([]);
    expect(events).toContainEqual({ type: "runtime.stopping", reason: "command" });
    expect(events.some((event) => event.type === "task.returned")).toBe(true);
    const task = store.tasks.list().find((candidate) => candidate.goal === "Slow");
    expect(store.tasks.get(task?.taskId ?? "")).toMatchObject({
      state: "ready",
      retryReason: "orphaned",
      attemptsUsed: 0,
      infraRestarts: 0,
    });
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "released" });
  }, 15_000);
});
