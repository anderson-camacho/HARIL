import type { QuotaSnapshot, Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import {
  type ManualClock,
  manualClock,
  sequentialIds,
  testRules,
  workflowIntake,
  TEST_PROJECT_ROOT,
} from "./support.js";

// Quota and cooldowns in the store (docs/modos-y-delegacion.md 3.11, 4.2; phase F6): each sampling of a provider is one
// batch of quota_samples rows, the newest batch of each provider is the evidence while it is fresh, a 402 or 429 starts
// a cooldown that a shorter one never shortens, and a workflow turn that heard a provider error is retried once on the
// same task (another model, or after a cooldown) without a new turn of its thread.

let clock: ManualClock;
let store: Store;
let projectId: string;
let epoch: number;
let keySeq = 0;

beforeEach(() => {
  clock = manualClock();
  store = openMemoryStore({ clock, ids: sequentialIds(), rules: testRules });
  projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: TEST_PROJECT_ROOT,
  }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.21.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
});

afterEach(() => {
  store.close();
});

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

const SAMPLED: QuotaSnapshot = {
  ok: true,
  sampledAt: 0,
  source: "cliproxyapi-management/v0",
  accounts: [
    {
      credentialRef: "acct-111111111111",
      kind: "antigravity",
      prefix: "Gemini1",
      windows: [
        { name: "5h", usedPct: 83, resetsAt: 7_200_000 },
        { name: "7d", usedPct: 40, resetsAt: 600_000_000 },
      ],
      note: null,
    },
    {
      credentialRef: "acct-222222222222",
      kind: "xai",
      prefix: null,
      windows: [],
      note: "no usage probe for xai",
    },
  ],
};

describe("quota samples", () => {
  it("records one batch per sampling and returns each provider's newest batch while it is fresh", () => {
    clock.set(1_000);
    store.quota.recordSnapshot("cliproxy", { ...SAMPLED, sampledAt: 1_000 });
    clock.set(2_000);
    const batch = store.quota.recordSnapshot("cliproxy", { ...SAMPLED, sampledAt: 2_000 });
    const rows = store.quota.latest(0);
    expect(rows.every((row) => row.batchId === batch)).toBe(true);
    expect(rows).toEqual([
      {
        provider: "cliproxy",
        batchId: batch,
        credentialRef: "acct-111111111111",
        kind: "antigravity",
        prefix: "Gemini1",
        window: "5h",
        usedPct: 83,
        resetsAt: 7_200_000,
        sampledAt: 2_000,
        source: "cliproxyapi-management/v0",
        note: null,
      },
      expect.objectContaining({ prefix: "Gemini1", window: "7d", usedPct: 40 }),
      // An account with no window is kept, its windows unknown ("sin dato").
      expect.objectContaining({ credentialRef: "acct-222222222222", window: "5h", usedPct: null }),
      expect.objectContaining({
        credentialRef: "acct-222222222222",
        window: "7d",
        note: "no usage probe for xai",
      }),
    ]);
    // A batch older than the freshness limit is no evidence.
    expect(store.quota.latest(2_001)).toEqual([]);
  });

  it("records an unavailable provider as rows without an account, with its reason", () => {
    store.quota.recordSnapshot("cliproxy", {
      ok: false,
      sampledAt: 5,
      reason: "unauthorized",
      detail: "the management API refused the key",
    });
    expect(store.quota.latest(0)).toEqual([
      expect.objectContaining({
        credentialRef: null,
        window: "5h",
        usedPct: null,
        note: "unauthorized: the management API refused the key",
      }),
      expect.objectContaining({ credentialRef: null, window: "7d", usedPct: null }),
    ]);
  });
});

describe("model cooldowns", () => {
  it("keeps the later end of an active cooldown, and lists only the active ones", () => {
    clock.set(1_000);
    store.quota.setCooldown({ model: "cliproxy/Gemini1/m", until: 100_000, reason: "quota" });
    expect(
      store.quota.setCooldown({
        model: "cliproxy/Gemini1/m",
        until: 50_000,
        reason: "rate_limited",
      }),
    ).toEqual({ model: "cliproxy/Gemini1/m", until: 100_000, reason: "quota" });
    store.quota.setCooldown({ model: "cliproxy/other", until: 2_000, reason: "rate_limited" });
    expect(store.quota.cooldowns(1_500).map((row) => row.model)).toEqual([
      "cliproxy/Gemini1/m",
      "cliproxy/other",
    ]);
    expect(store.quota.cooldowns(2_000).map((row) => row.model)).toEqual(["cliproxy/Gemini1/m"]);
    // An ended cooldown is replaced by a new one, even a shorter one.
    clock.set(200_000);
    expect(
      store.quota.setCooldown({
        model: "cliproxy/Gemini1/m",
        until: 210_000,
        reason: "rate_limited",
      }),
    ).toEqual({ model: "cliproxy/Gemini1/m", until: 210_000, reason: "rate_limited" });
  });
});

describe("a workflow turn's provider retry", () => {
  function startAndClaim(): { taskId: string; runId: string } {
    store.commands.enqueue({
      type: "workflow.start",
      projectId,
      args: {
        intake: workflowIntake(TEST_PROJECT_ROOT),
        goal: "Answer from the notes",
        model: "cliproxy/Gemini1/m",
        agent: "fake:orchestrate",
        autonomy: { mode: "autonomous", stops: [] },
        budgetTokens: 50_000,
        timeoutMs: 600_000,
      },
      idempotencyKey: `k-${++keySeq}`,
      requestHash: `h-${keySeq}`,
    });
    const applied = store.commands.applyNext(epoch);
    const taskId = applied?.taskIds[0] as string;
    const claimed = store.tasks.claimTask(epoch, taskId);
    if (claimed === undefined) throw new Error("not claimed");
    return { taskId, runId: claimed.runId };
  }

  it("returns the task to ready on another model, closes its run and counts the retry", () => {
    const { taskId, runId } = startAndClaim();
    expect(store.workflows.providerRetries(taskId)).toBe(0);
    store.workflows.retryTurn(epoch, {
      runId,
      model: "cliproxy/Gemini2/m",
      cooldownUntil: null,
      retryReason: "route_failover",
      error: { code: "provider.retried", message: "HTTP 429 from cliproxy/Gemini1/m" },
    });
    const task = store.tasks.get(taskId);
    expect(task).toMatchObject({ state: "ready", model: "cliproxy/Gemini2/m" });
    expect(store.workflows.providerRetries(taskId)).toBe(1);
    expect(store.events.list({ aggregateId: taskId }).map((event) => event.type)).toContain(
      "task.retried",
    );
    // The retried task is claimed again: a second run of the same task, no new turn.
    const again = store.tasks.claimTask(epoch, taskId);
    expect(again?.runId).not.toBe(runId);
    expect(store.workflows.tasks(store.workflows.list()[0]?.workflowId ?? "")).toHaveLength(1);
  });

  it("waits blocked with a cooldown, and the promotion makes it ready once the cooldown ended", () => {
    clock.set(10_000);
    const { taskId, runId } = startAndClaim();
    store.workflows.retryTurn(epoch, {
      runId,
      model: "cliproxy/Gemini1/m",
      cooldownUntil: 70_000,
      retryReason: "transient",
      error: { code: "provider.retried", message: "HTTP 429 and no other model" },
    });
    const turnOf = () => store.workflows.tasks(store.workflows.list()[0]?.workflowId ?? "")[0];
    expect(turnOf()).toMatchObject({
      state: "blocked",
      blockReason: "cooldown",
      cooldownUntil: 70_000,
    });
    store.tasks.promote();
    expect(turnOf()?.state).toBe("blocked");
    clock.set(70_000);
    expect(store.tasks.promote().ready.map((item) => item.taskId)).toEqual([taskId]);
    expect(turnOf()).toMatchObject({ state: "ready", blockReason: null, cooldownUntil: null });
  });

  it("defers a ready turn to a cooldown and changes a ready turn's model at its launch", () => {
    const { taskId, runId } = startAndClaim();
    store.workflows.retryTurn(epoch, {
      runId,
      model: "cliproxy/Gemini1/m",
      cooldownUntil: null,
      retryReason: "transient",
      error: { code: "provider.retried", message: "transient" },
    });
    store.workflows.setTurnModel(epoch, taskId, "cliproxy/Gemini3/m");
    expect(store.tasks.get(taskId)?.model).toBe("cliproxy/Gemini3/m");
    store.workflows.deferTurn(epoch, taskId, 99_000);
    expect(store.tasks.get(taskId)).toMatchObject({ state: "blocked" });
    // Only a ready turn is deferred or changed.
    expect(caught(() => store.workflows.deferTurn(epoch, taskId, 99_000)).code).toBe(
      "store.conflict",
    );
    expect(caught(() => store.workflows.setTurnModel(epoch, taskId, "x/y")).code).toBe(
      "store.conflict",
    );
  });

  it("refuses a run that is no longer its task's claim", () => {
    const { runId } = startAndClaim();
    store.runs.complete({
      runId,
      outcome: "failed",
      error: { code: "provider_error", message: "x" },
      endCause: "exit",
    });
    expect(
      caught(() =>
        store.workflows.retryTurn(epoch, {
          runId,
          model: "cliproxy/Gemini2/m",
          cooldownUntil: null,
          retryReason: "route_failover",
          error: { code: "provider.retried", message: "late" },
        }),
      ).code,
    ).toBe("store.stale");
  });
});
