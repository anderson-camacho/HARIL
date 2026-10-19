import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_DELEGATION_LIMITS,
} from "@haril/core";
import type { Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimWorkflowTurns } from "../src/runtime/workflow-scheduler.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// The surface locks between workflows that write in the same project (docs/modos-y-delegacion.md 3.10.1, phase F8): a
// writer in flight holds its surface for every other workflow of the project, whatever state its own workflow is in. A
// workflow that waits for the human still has its attempts in flight; their surfaces stay held until they end.

let sb: Sandbox;
const stores: Store[] = [];
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

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
    clock: { now: () => Date.now(), schedule: () => () => undefined },
    ids: { next: () => randomUUID() },
    rules,
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

// Starts a writing workflow on the project and gives it one executor turn that writes `surface`; answers the workflow.
function writingWorkflow(store: Store, epoch: number, projectId: string, surface: string[]) {
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(store.projects.list()[0]?.rootPath as string),
      goal: `Write ${surface.join(", ")}`,
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy: { mode: "autonomous", stops: [] },
      limits: DEFAULT_DELEGATION_LIMITS,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
      baseBranch: "main",
      baseSha: BASE_SHA,
    },
    idempotencyKey: `wf-${randomUUID()}`,
    requestHash: "h",
  });
  store.commands.applyNext(epoch);
  const workflow = store.workflows.list()[0];
  if (workflow === undefined) throw new Error("no workflow");
  const root = store.workflows.tasks(workflow.workflowId)[0];
  store.workflows.applyTurns(epoch, {
    workflowId: workflow.workflowId,
    turns: [
      {
        key: "e1",
        threadId: null,
        role: "executor",
        layer: 3,
        kind: "work",
        parentTaskId: root?.taskId ?? null,
        localId: "step-1",
        goal: "Write it",
        description: "",
        agentRef: "fake:execute",
        model: "fake/high-model",
        modelPinned: false,
        difficulty: "medium",
        difficultyReason: "one file",
        priority: 5,
        budgetTokens: 20_000,
        timeoutMs: 60_000,
        surfaceWrite: surface,
        surfaceRead: [],
        dependsOn: [],
      },
    ],
  });
  store.tasks.promote();
  return workflow;
}

function executorOf(store: Store, workflowId: string) {
  return store.workflows.tasks(workflowId).find((task) => task.role === "executor");
}

describe("the surface locks between workflows of one project", () => {
  it("keep a paused workflow's writer in flight holding its surface", () => {
    const store = open();
    const projectId = store.projects.register({
      slug: "demo",
      name: "Demo",
      rootPath: sb.root,
    }).projectId;
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    const epoch = grant.value.epoch;
    const first = writingWorkflow(store, epoch, projectId, ["src/**"]);
    // Only the executor is ready: the orchestrator's own turn is claimed out of the way first.
    const firstRoot = store.workflows.tasks(first.workflowId)[0];
    if (firstRoot !== undefined) store.tasks.claimTask(epoch, firstRoot.taskId);
    const firstExecutor = executorOf(store, first.workflowId);
    if (firstExecutor === undefined) throw new Error("no executor");
    expect(store.tasks.claimTask(epoch, firstExecutor.taskId)).toBeDefined();
    // The first workflow now waits for the human; its executor is still writing.
    store.workflows.setState(epoch, {
      workflowId: first.workflowId,
      state: "awaiting_human",
      reason: "after_plan",
    });

    const second = writingWorkflow(store, epoch, projectId, ["src/app.ts"]);
    const secondRoot = store.workflows.tasks(second.workflowId)[0];
    if (secondRoot !== undefined) store.tasks.claimTask(epoch, secondRoot.taskId);
    const claimed = claimWorkflowTurns(store, epoch, { limits: DEFAULT_DELEGATION_LIMITS });
    expect(claimed.map((claim) => claim.workflowId)).not.toContain(second.workflowId);
    expect(executorOf(store, second.workflowId)?.state).toBe("ready");
    store.runtime.release(epoch, true);
  });
});
