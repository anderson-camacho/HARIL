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

// MC-T2 (ORCHESTRATION 7.3, ARCH 7.6): the output a verification rejects is kept with the run, the task returns to ready
// as verify_failed, and the claim of the next attempt carries the checks and the output.
describe("verification retries (MC-T2)", () => {
  const CHECKS = [
    { kind: "output_contains", text: "done" },
    { blockId: "b", checkId: "c" },
    { kind: "file_exists", path: "notes.md" },
  ] as const;
  const FAILED = {
    verified: false,
    checks: [
      { kind: "output_contains", ok: false, detail: "output does not contain text" },
      { kind: "file_exists", ok: true, detail: "file exists" },
    ],
  };
  const OUTPUT = { text: "not yet", model: "e2e/m", warnings: [] };

  // `output` null: a run kept before MC-T2, whose error holds no output.
  function rejectRun(runId: string, output: Record<string, unknown> | null = OUTPUT) {
    return store.runs.complete({
      runId,
      outcome: "failed",
      error: { code: "verification_failed", message: "verification failed: output_contains" },
      endCause: "exit",
      verification: FAILED,
      ...(output === null ? {} : { output }),
    });
  }

  function claim() {
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimed");
    return claimed;
  }

  // The payload of the newest task.failed event.
  function failedPayload() {
    return store.events
      .list()
      .filter((event) => event.type === "task.failed")
      .at(-1)?.payload;
  }

  it("keeps the rejected output with the evidence and returns the task to ready as verify_failed", () => {
    enqueue("rejected once", CHECKS, 2);
    const first = claim();
    expect(first.rejectedAttempt).toBeNull();
    expect(rejectRun(first.runId)).toMatchObject({
      taskState: "ready",
      attemptsUsed: 1,
      retryReason: "verify_failed",
    });
    const detail = store.tasks.get(taskId("rejected once"));
    expect(detail).toMatchObject({ state: "ready", retryReason: "verify_failed", result: null });
    expect(detail?.error).toEqual({
      code: "verification_failed",
      message: "verification failed: output_contains",
      attempt: 1,
      verification: FAILED,
      output: OUTPUT,
    });
    const retried = store.events.list().find((event) => event.type === "task.retried");
    expect(retried?.payload).toMatchObject({
      code: "verification_failed",
      retryReason: "verify_failed",
    });
  });

  it("keeps a transient failure transient, with no rejected attempt on the next claim", () => {
    enqueue("flaky", CHECKS, 2);
    const first = claim();
    expect(
      store.runs.complete({
        runId: first.runId,
        outcome: "failed",
        error: { code: "timeout", message: "the attempt exceeded its timeout" },
        endCause: "timeout",
      }),
    ).toMatchObject({ taskState: "ready", retryReason: "transient" });
    expect(store.tasks.get(taskId("flaky"))?.retryReason).toBe("transient");
    expect(claim().rejectedAttempt).toBeNull();
  });

  it("hands the next attempt the checks of the task with their evidence, and the rejected output", () => {
    enqueue("rejected then retried", CHECKS, 3);
    const first = claim();
    rejectRun(first.runId);
    const second = claim();
    expect(second.attempt).toBe(2);
    // The block verifier reference is not a check: the evidence pairs with the task's checks in their order.
    expect(second.rejectedAttempt).toEqual({
      attempt: 1,
      checks: [
        {
          kind: "output_contains",
          text: "done",
          ok: false,
          detail: "output does not contain text",
        },
        { kind: "file_exists", path: "notes.md", ok: true, detail: "file exists" },
      ],
      output: OUTPUT,
    });
    // A later failure for another reason does not erase the evidence: the claim after it still carries attempt 1, so
    // the attempt that may spend the last verification retry knows what to fix.
    store.runs.complete({
      runId: second.runId,
      outcome: "failed",
      error: { code: "agent.failed", message: "boom" },
      endCause: "exit",
    });
    expect(claim().rejectedAttempt).toEqual({
      attempt: 1,
      checks: [
        {
          kind: "output_contains",
          text: "done",
          ok: false,
          detail: "output does not contain text",
        },
        { kind: "file_exists", path: "notes.md", ok: true, detail: "file exists" },
      ],
      output: OUTPUT,
    });
  });

  it("carries the newest rejection across verify, transient and verify failures", () => {
    enqueue("verify transient verify", CHECKS, 5);
    rejectRun(claim().runId);
    const second = claim();
    store.runs.complete({
      runId: second.runId,
      outcome: "failed",
      error: { code: "timeout", message: "the attempt exceeded its timeout" },
      endCause: "timeout",
    });
    const third = claim();
    expect(third.rejectedAttempt?.attempt).toBe(1);
    expect(
      rejectRun(third.runId, { text: "third try", model: "e2e/m", warnings: [] }),
    ).toMatchObject({ taskState: "ready", retryReason: "verify_failed" });
    const fourth = claim();
    expect(fourth.rejectedAttempt).toMatchObject({ attempt: 3, output: { text: "third try" } });
    // Two verification retries were granted (after attempts 1 and 3): the next rejection fails the task.
    expect(rejectRun(fourth.runId)).toMatchObject({
      taskState: "failed",
      failureReason: "verification_exhausted",
      verifyRetries: 2,
    });
  });

  it("carries the rejection past a run that ended without being charged, and says when no output was kept", () => {
    enqueue("rejected then stopped", CHECKS, 2);
    rejectRun(claim().runId, null);
    const stopped = claim();
    store.runs.cancel(stopped.runId, "shutdown");
    const next = claim();
    expect(next.rejectedAttempt).toMatchObject({ attempt: 1, output: null });
    expect(next.rejectedAttempt?.checks).toHaveLength(2);
  });

  // ORCHESTRATION 7.3: at most 2 verification retries are granted, inside maxAttempts.
  it("grants at most two verification retries, even with attempts left", () => {
    enqueue("never passes", CHECKS, 5);
    expect(rejectRun(claim().runId)).toMatchObject({
      taskState: "ready",
      retryReason: "verify_failed",
    });
    expect(rejectRun(claim().runId)).toMatchObject({
      taskState: "ready",
      retryReason: "verify_failed",
    });
    expect(rejectRun(claim().runId)).toMatchObject({
      taskState: "failed",
      attemptsUsed: 3,
      maxAttempts: 5,
      retryReason: null,
      failureReason: "verification_exhausted",
      verifyRetries: 2,
    });
    const detail = store.tasks.get(taskId("never passes"));
    expect(detail).toMatchObject({
      state: "failed",
      attemptsUsed: 3,
      retryReason: null,
      failureReason: "verification_exhausted",
      verifyRetries: 2,
    });
    expect(detail?.error?.output).toEqual(OUTPUT);
    expect(failedPayload()).toEqual({
      attempt: 3,
      attemptsUsed: 3,
      code: "verification_failed",
      reason: "verification_exhausted",
      verifyRetries: 2,
    });
  });

  // executor.md DR-05: the reason is the same when the last attempt is also the one that uses up the retries.
  it("says verification_exhausted on the last attempt too, and nothing when only the attempts ran out", () => {
    enqueue("three attempts", CHECKS, 3);
    rejectRun(claim().runId);
    rejectRun(claim().runId);
    expect(rejectRun(claim().runId)).toMatchObject({
      taskState: "failed",
      attemptsUsed: 3,
      failureReason: "verification_exhausted",
    });
    expect(failedPayload()).toMatchObject({ reason: "verification_exhausted", verifyRetries: 2 });

    enqueue("two attempts", CHECKS, 2);
    rejectRun(claim().runId);
    expect(rejectRun(claim().runId)).toMatchObject({
      taskState: "failed",
      failureReason: null,
      verifyRetries: 1,
    });
    expect(failedPayload()).toEqual({ attempt: 2, attemptsUsed: 2, code: "verification_failed" });
    expect(store.tasks.get(taskId("two attempts"))).toMatchObject({
      failureReason: null,
      verifyRetries: 1,
    });
  });

  it("does not count a transient retry against the verification retries", () => {
    enqueue("mixed", CHECKS, 4);
    rejectRun(claim().runId);
    store.runs.complete({
      runId: claim().runId,
      outcome: "failed",
      error: { code: "agent.failed", message: "boom" },
      endCause: "exit",
    });
    expect(rejectRun(claim().runId)).toMatchObject({
      taskState: "ready",
      retryReason: "verify_failed",
    });
  });
});
