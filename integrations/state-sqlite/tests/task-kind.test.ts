import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// Task kinds through the queue (LD-T4): task.create takes an optional kind (work by default, or plan), the store checks
// it against the agent with the Core rule it is given, and the claim hands the kind to the runtime.
let store: Store;
let projectId: string;
let epoch: number;
let keySeq = 0;

beforeEach(() => {
  store = openMemoryStore({ clock: fixedClock(), ids: sequentialIds(), rules: testRules });
  projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: "D:/demo",
  }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.19.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
});

afterEach(() => {
  store.close();
});

function createTask(args: Record<string, unknown>) {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal: "Plan the docs", dependsOn: [], maxAttempts: 1, timeoutMs: 1000, ...args },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  return store.commands.applyNext(epoch);
}

describe("task.create kind", () => {
  it("creates a plan task with a planner agent and the claim carries its kind", () => {
    expect(createTask({ agent: "fake:plan", kind: "plan" })?.outcome).toBe("applied");
    const claimed = store.tasks.claimNext(epoch);
    expect(claimed).toMatchObject({ goal: "Plan the docs", agentRef: "fake:plan", kind: "plan" });
  });

  it("keeps work as the kind of a task.create without one", () => {
    expect(createTask({ agent: "fake:succeed" })?.outcome).toBe("applied");
    expect(store.tasks.claimNext(epoch)?.kind).toBe("work");
  });

  it("carries the kind of a plan's tasks into the claim", () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: {
        plan: {
          schemaVersion: 1,
          tasks: [
            {
              localId: "check",
              dependsOn: [],
              goal: "Check the docs",
              description: "",
              priority: 5,
              kind: "verify",
              agent: "fake:succeed",
              requires: [],
              context: [],
              surface: { write: [], read: [] },
              budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 1000 },
              timeoutMs: 1000,
              maxAttempts: 1,
              acceptance: [],
            },
          ],
        },
      },
      idempotencyKey: `k-${++keySeq}`,
      requestHash: `h-${keySeq}`,
    });
    expect(store.commands.applyNext(epoch)?.outcome).toBe("applied");
    expect(store.tasks.claimNext(epoch)?.kind).toBe("verify");
  });

  it("rejects a plan task on a non-planner agent and a planner agent on a work task, creating nothing", () => {
    const wrongAgent = createTask({ agent: "fake:succeed", kind: "plan" });
    expect(wrongAgent).toMatchObject({ outcome: "rejected" });
    expect(wrongAgent?.reason).toContain("planner");

    const wrongKind = createTask({ agent: "fake:plan" });
    expect(wrongKind).toMatchObject({ outcome: "rejected" });
    expect(wrongKind?.reason).toContain('"fake:plan" runs only plan tasks');
    expect(store.tasks.list()).toHaveLength(0);
  });

  it("rejects a kind a task.create cannot ask for", () => {
    const verify = createTask({ agent: "fake:succeed", kind: "verify" });
    expect(verify).toMatchObject({ outcome: "rejected" });
    expect(verify?.reason).toContain('task kind must be "work" or "plan"');
    expect(store.tasks.list()).toHaveLength(0);
  });
});
