import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
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
});
