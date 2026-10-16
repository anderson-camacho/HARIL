import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/index.js";
import { fixedClock, sequentialIds, testRules } from "./support.js";

// Acceptance checks and verification evidence in the store (criterion 8, M3-D7).
let store: Store;
let projectId: string;
let epoch: number;
let keySeq = 0;

const CHECK = { kind: "output_contains", text: "done" } as const;

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

function enqueue(goal: string, acceptance: unknown, maxAttempts = 1): void {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn: [], agent: "fake:say:done", maxAttempts, timeoutMs: 1000, acceptance },
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  store.commands.applyNext(epoch);
}

function taskId(goal: string): string {
  const task = store.tasks.list().find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task.taskId;
}

describe("acceptance in task.create", () => {
  it("persists the checks and hands them to the runtime on claim", () => {
    enqueue("with checks", [CHECK]);
    const claimed = store.tasks.claimNext(epoch);
    expect(claimed?.acceptance).toEqual([CHECK]);
  });

  it("defaults to no checks when the command has no acceptance", () => {
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: { goal: "bare", dependsOn: [], agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
      idempotencyKey: "bare",
      requestHash: "bare",
    });
    store.commands.applyNext(epoch);
    expect(store.tasks.claimNext(epoch)?.acceptance).toEqual([]);
  });

  it("rejects a malformed check with a reason that names acceptance", () => {
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: {
        goal: "bad",
        dependsOn: [],
        agent: "fake:succeed",
        maxAttempts: 1,
        timeoutMs: 1000,
        acceptance: [{ kind: "output_contains", text: "" }],
      },
      idempotencyKey: "bad",
      requestHash: "bad",
    });
    const applied = store.commands.applyNext(epoch);
    expect(applied?.outcome).toBe("rejected");
    expect(applied?.reason ?? "").toContain("acceptance");
  });
});

describe("verification evidence", () => {
  it("keeps the evidence of a verification_failed attempt on the task", () => {
    enqueue("fails check", [CHECK]);
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimed");
    const verification = {
      verified: false,
      checks: [{ kind: "output_contains", ok: false, detail: "output does not contain text" }],
    };
    store.runs.complete({
      runId: claimed.runId,
      outcome: "failed",
      error: { code: "verification_failed", message: "verification failed: output_contains" },
      endCause: "exit",
      verification,
    });
    const detail = store.tasks.get(taskId("fails check"));
    expect(detail?.state).toBe("failed");
    expect(detail?.error?.code).toBe("verification_failed");
    expect(detail?.error?.verification).toEqual(verification);
  });

  it("counts verified and unverified completions in the metrics", () => {
    enqueue("verified one", [CHECK]);
    enqueue("unverified one", []);
    const first = store.tasks.claimNext(epoch);
    const second = store.tasks.claimNext(epoch);
    if (first === undefined || second === undefined) throw new Error("nothing claimed");
    store.runs.complete({
      runId: first.runId,
      outcome: "succeeded",
      result: { summary: "done", verification: { verified: true, checks: [] } },
    });
    store.runs.complete({
      runId: second.runId,
      outcome: "succeeded",
      result: { summary: "done", verification: { verified: false, checks: [] } },
    });
    const snapshot = store.metrics.snapshot();
    expect(snapshot.verifiedCompletions).toBe(1);
    expect(snapshot.unverifiedCompletions).toBe(1);
  });
});

describe("acceptance through plan.submit", () => {
  it("keeps the checks of a plan task until the runtime claims it", () => {
    store.commands.enqueue({
      type: "plan.submit",
      projectId,
      args: {
        plan: {
          schemaVersion: 1,
          tasks: [
            {
              localId: "a",
              dependsOn: [],
              goal: "planned",
              description: "",
              priority: 5,
              kind: "work",
              agent: "fake:say:done",
              requires: [],
              context: [],
              surface: { write: [], read: [] },
              budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 1000 },
              timeoutMs: 1000,
              maxAttempts: 1,
              acceptance: [CHECK],
            },
          ],
        },
      },
      idempotencyKey: "plan-acceptance",
      requestHash: "plan-acceptance",
    });
    expect(store.commands.applyNext(epoch)?.outcome).toBe("applied");
    expect(store.tasks.claimNext(epoch)?.acceptance).toEqual([CHECK]);
  });
});
