import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { ClaimedTask, Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitWorkflowAttempt } from "../src/runtime/workflow-turns.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// One workflow turn from claim to close against the real store (docs/modos-y-delegacion.md 3.5, 3.7, 4.5): what its
// agent_run usage row counts, and what the turns it creates are told.

const clock: Clock = { now: () => Date.now(), schedule: () => () => undefined };
const MODEL = "cliproxy/test-model";
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
  });
  projectId = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

function lease(pid: number): number {
  const grant = store.runtime.acquire({
    pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("no lease");
  return grant.value.epoch;
}

// A real-agent workflow: the orchestrator's first turn, ready.
function startWorkflow(epoch: number): { workflowId: string; taskId: string } {
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      goal: "Report the facts of the fixture",
      model: MODEL,
      agent: "orchestrator",
      autonomy: { mode: "autonomous", stops: [] },
      budgetTokens: 100_000,
    },
    idempotencyKey: "start",
    requestHash: "start",
  });
  const applied = store.commands.applyNext(epoch);
  return { workflowId: applied?.workflowId as string, taskId: applied?.taskIds[0] as string };
}

// What the Broker records for one model call of a run: a reservation on the project and task budgets, then its commit.
function spend(claimed: ClaimedTask, key: string, input: number, output: number): void {
  const project = store.budgets.ensure({
    scopeType: "project",
    scopeId: projectId,
    projectId,
    hardLimit: 1_000_000,
  }).budgetId;
  const task = store.budgets.ensure({
    scopeType: "task",
    scopeId: claimed.taskId,
    projectId,
    hardLimit: claimed.maxTokens,
  }).budgetId;
  const reserved = store.budgets.reserve({
    budgetIds: [project, task],
    amount: input + output,
    idempotencyKey: key,
    runId: claimed.runId,
    taskId: claimed.taskId,
    routeId: MODEL,
  });
  if (!reserved.ok) throw new Error("reservation refused");
  store.budgets.commit({
    reservationId: reserved.reservationId,
    usage: { inputTokens: input, outputTokens: output },
    upperBound: input + output,
    modelRequested: MODEL,
    modelServed: MODEL,
  });
}

describe("the agent_run usage row of a workflow turn", () => {
  it("counts the tokens of its own run only, so a turn rerun after a recovery is not counted twice", () => {
    const first = lease(4242);
    const { workflowId, taskId } = startWorkflow(first);
    const crashed = store.tasks.claimTask(first, taskId);
    if (crashed === undefined) throw new Error("not claimed");
    spend(crashed, "crashed-1", 1_000, 200);
    // The runtime dies with the turn in flight; the next one recovers it and runs it again.
    store.runtime.release(first, false);
    const second = lease(4343);
    expect(store.runtime.reconcile(second, 3)).toEqual([
      expect.objectContaining({ taskId, outcome: "ready" }),
    ]);
    const rerun = store.tasks.claimTask(second, taskId);
    if (rerun === undefined) throw new Error("not claimed again");
    expect(rerun.runId).not.toBe(crashed.runId);
    spend(rerun, "rerun-1", 300, 40);
    spend(rerun, "rerun-2", 350, 10);

    commitWorkflowAttempt(
      { store, epoch: second, clock },
      { claimed: rerun, workflowId, startedAt: clock.now() },
      // A real agent reports no usage of its own: the row reads the Broker's ledger.
      { status: "succeeded", summary: "aborted", model: MODEL },
      { action: { tool: "haril_abort", input: { reason: "nothing to do" } }, refusals: [] },
    );

    const rows = store.usageLog.usage({ workflowId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: rerun.runId,
      tokensIn: 650,
      tokensOut: 50,
      simulated: false,
    });
    expect(store.usageLog.verify().ok).toBe(true);
  });
});
