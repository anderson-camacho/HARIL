import { resolve } from "node:path";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import {
  type ManualClock,
  manualClock,
  sequentialIds,
  testRules,
  workflowIntake,
} from "./support.js";

// The worktrees of workflows that write (docs/modos-y-delegacion.md 3.10, phase F8; migration 0014): one per executor
// thread and one integration worktree per workflow, recorded so a restart reuses them, the snapshot names their
// branches and the startup sweep removes those of ended workflows. Every write is fenced by the runtime epoch.

let clock: ManualClock;
let store: Store;
let epoch: number;
let workflowId: string;
const projectRoot = resolve("demo");

beforeEach(() => {
  clock = manualClock();
  store = openMemoryStore({ clock, ids: sequentialIds(), rules: testRules });
  const projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: projectRoot,
  }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.21.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(projectRoot),
      goal: "Change the button",
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy: { mode: "autonomous", stops: [] },
      limits: {},
      baseBranch: "main",
      baseSha: "a".repeat(40),
    },
    idempotencyKey: "k-1",
    requestHash: "h-1",
  });
  const applied = store.commands.applyNext(epoch);
  if (applied?.outcome !== "applied" || applied.workflowId === undefined) {
    throw new Error("workflow.start rejected");
  }
  workflowId = applied.workflowId;
});

afterEach(() => {
  store.close();
});

const executor = (threadId: string) => ({
  kind: "executor" as const,
  threadId,
  path: `D:/data/worktrees/w1/${threadId}`,
  branch: `haril/w1/task/${threadId}`,
  baseSha: "a".repeat(40),
});

describe("store.worktrees", () => {
  it("records an executor worktree once per thread and returns the same record again", () => {
    const first = store.worktrees.record(epoch, { workflowId, ...executor("t1") });
    expect(first).toMatchObject({
      workflowId,
      kind: "executor",
      threadId: "t1",
      branch: "haril/w1/task/t1",
      headSha: null,
      mergedAt: null,
      state: "active",
    });
    const again = store.worktrees.record(epoch, { workflowId, ...executor("t1") });
    expect(again.worktreeId).toBe(first.worktreeId);
    expect(store.worktrees.list({ workflowId })).toHaveLength(1);
    expect(store.events.list().map((event) => event.type)).toContain("worktree.created");
  });

  it("keeps one integration worktree per workflow", () => {
    const integration = {
      workflowId,
      kind: "integration" as const,
      threadId: null,
      path: "D:/data/worktrees/w1/integration",
      branch: "haril/w1/integration",
      baseSha: "a".repeat(40),
    };
    const first = store.worktrees.record(epoch, integration);
    expect(store.worktrees.record(epoch, integration).worktreeId).toBe(first.worktreeId);
    expect(store.worktrees.list({ workflowId, kind: "integration" })).toHaveLength(1);
  });

  it("records the head commit, the merge into the integration branch and the removal", () => {
    const record = store.worktrees.record(epoch, { workflowId, ...executor("t1") });
    store.worktrees.setHead(epoch, record.worktreeId, "b".repeat(40));
    clock.advance(10);
    store.worktrees.markMerged(epoch, record.worktreeId, "c".repeat(40));
    expect(store.worktrees.get(record.worktreeId)).toMatchObject({
      headSha: "b".repeat(40),
      mergeSha: "c".repeat(40),
      mergedAt: clock.now(),
      state: "active",
    });
    store.worktrees.markRemoved(epoch, record.worktreeId);
    expect(store.worktrees.get(record.worktreeId)).toMatchObject({
      state: "removed",
      removedAt: clock.now(),
    });
    expect(store.worktrees.list({ state: "active" })).toHaveLength(0);
    // A removed worktree made again becomes active, with the same record.
    expect(store.worktrees.record(epoch, { workflowId, ...executor("t1") })).toMatchObject({
      worktreeId: record.worktreeId,
      state: "active",
      removedAt: null,
    });
  });

  it("records an executor branch's last verified commit apart from its head (migration 0016)", () => {
    const record = store.worktrees.record(epoch, { workflowId, ...executor("t1") });
    expect(record.verifiedSha).toBeNull();
    store.worktrees.setVerified(epoch, record.worktreeId, "d".repeat(40));
    expect(store.worktrees.get(record.worktreeId)).toMatchObject({
      verifiedSha: "d".repeat(40),
      headSha: null,
    });
    store.worktrees.setVerified(epoch, record.worktreeId, "e".repeat(40));
    expect(store.worktrees.list({ workflowId })[0]?.verifiedSha).toBe("e".repeat(40));
    expect(() => store.worktrees.setVerified(epoch + 1, record.worktreeId, "f".repeat(40))).toThrow(
      expect.objectContaining({ code: "store.fenced" }),
    );
    expect(() => store.worktrees.setVerified(epoch, "nope", "f".repeat(40))).toThrow(
      expect.objectContaining({ code: "store.not_found" }),
    );
  });

  it("refuses a write from a stale epoch and a worktree of an unknown workflow", () => {
    expect(
      (() => {
        try {
          store.worktrees.record(epoch + 1, { workflowId, ...executor("t2") });
        } catch (error) {
          return (error as StoreError).code;
        }
        return "none";
      })(),
    ).toBe("store.fenced");
    expect(
      (() => {
        try {
          store.worktrees.record(epoch, { workflowId: "nope", ...executor("t3") });
        } catch (error) {
          return (error as StoreError).code;
        }
        return "none";
      })(),
    ).toBe("store.not_found");
  });
});
