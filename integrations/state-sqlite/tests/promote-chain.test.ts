import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// tasks.promote propagates dep_failed transitively (M1 fix b): a pending task behind a failed, cancelled
// or dep_failed-blocked dependency becomes blocked(dep_failed) in the same promote call.
let store: Store;
let projectId: string;
let epoch: number;
let keySeq = 0;

beforeEach(() => {
  store = openMemoryStore({
    clock: fixedClock(),
    ids: sequentialIds(),
    rules: testRules,
    isPidAlive: () => true,
  });
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

function enqueueTask(goal: string, dependsOn: string[] = []): string {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn, agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  store.commands.applyNext(epoch);
  return taskIdOf(goal);
}

function taskIdOf(goal: string): string {
  const task = store.tasks.list().find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task.taskId;
}

function failFirstClaim(): void {
  const claimed = store.tasks.claimNext(epoch);
  if (claimed === undefined) throw new Error("nothing claimable");
  store.runs.complete({
    runId: claimed.runId,
    outcome: "failed",
    error: { code: "fake.failed", message: "boom" },
    endCause: "exit",
  });
}

describe("tasks.promote transitive dep_failed (M1 fix b)", () => {
  it("[INV-04] blocks a three-level chain behind a failed root in one promote call", () => {
    const a = enqueueTask("A");
    const b = enqueueTask("B", [a]);
    const c = enqueueTask("C", [b]);
    failFirstClaim();

    const result = store.tasks.promote();

    expect(result.blocked.map((task) => task.goal).sort()).toEqual(["B", "C"]);
    expect(store.tasks.get(b)).toMatchObject({ state: "blocked", blockReason: "dep_failed" });
    expect(store.tasks.get(c)).toMatchObject({ state: "blocked", blockReason: "dep_failed" });
  });

  it("[INV-04] keeps a task pending while its dependency is neither failed nor completed", () => {
    enqueueTask("A");
    const b = enqueueTask("B");
    const joined = enqueueTask("J", [b]);
    failFirstClaim();

    store.tasks.promote();

    expect(store.tasks.get(joined)).toMatchObject({ state: "pending", blockReason: null });
  });
});
