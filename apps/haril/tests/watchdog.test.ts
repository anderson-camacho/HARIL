import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  type RunEvent,
} from "@haril/core";
import type { Clock, NewTurn, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkflowSnapshot } from "../src/commands/workflow-snapshot.js";
import { checkLiveNodes, type WatchdogDeps, watchdogPolicy } from "../src/runtime/watchdog.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// One pass of the watchdog over the real store (docs/modos-y-delegacion.md 3.16): a node seen for the first time is
// scheduled, not judged, and its schedule outlives a restart; a node whose consumer has no live turn left is residual.

const WINDOW = 15 * 60_000;
let now = 1_800_000_000_000;
const clock: Clock = { now: () => now, schedule: () => () => undefined };
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

let sb: Sandbox;
let store: Store;
let epoch: number;

beforeEach(() => {
  sb = makeSandbox();
  store = open();
  epoch = acquire();
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

function open(): Store {
  return openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules,
    isPidAlive: () => false,
  });
}

function acquire(): number {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  return grant.value.epoch;
}

function turn(key: string, role: NewTurn["role"], parentTaskId: string, localId: string): NewTurn {
  const shape = {
    delegator: [2, "plan"],
    executor: [3, "work"],
    auditor: [3, "verify"],
    orchestrator: [1, "plan"],
  } as const;
  const [layer, kind] = shape[role];
  return {
    key,
    threadId: null,
    role,
    layer,
    kind,
    parentTaskId,
    localId,
    goal: `${role} ${localId}`,
    description: "",
    agentRef: `fake:${role}`,
    model: "fake/high-model",
    modelPinned: false,
    difficulty: null,
    difficultyReason: null,
    priority: 5,
    budgetTokens: 1000,
    timeoutMs: 60_000,
    surfaceWrite: [],
    surfaceRead: [],
    dependsOn: [],
  };
}

// A workflow whose orchestrator delegated to d1, and d1 assigned e1.
function tree(): { workflowId: string; delegator: string; executor: string } {
  const projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: sb.root,
  }).projectId;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      goal: "Read the notes",
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy: { mode: "autonomous", stops: [] },
    },
    idempotencyKey: "wf",
    requestHash: "wf",
  });
  const applied = store.commands.applyNext(epoch);
  const workflowId = applied?.workflowId as string;
  const root = applied?.taskIds[0] as string;
  const delegator = store.workflows.applyTurns(epoch, {
    workflowId,
    turns: [turn("d", "delegator", root, "part-1")],
  }).taskIds.d as string;
  const executor = store.workflows.applyTurns(epoch, {
    workflowId,
    turns: [turn("e", "executor", delegator, "step-1")],
  }).taskIds.e as string;
  return { workflowId, delegator, executor };
}

function deps(events: RunEvent[]): WatchdogDeps {
  return {
    store,
    epoch,
    clock,
    policy: watchdogPolicy({ intervalMs: WINDOW }),
    emit: (event) => events.push(event),
    attemptOf: () => undefined,
    strikes: new Map(),
  };
}

function nextCheckOf(workflowId: string, taskId: string): number | null | undefined {
  return store.workflows.tasks(workflowId).find((task) => task.taskId === taskId)?.nextCheckAt;
}

describe("a watchdog pass", () => {
  it("schedules a node it sees for the first time instead of judging it, and the schedule survives a restart", () => {
    const { workflowId, executor } = tree();
    const events: RunEvent[] = [];
    checkLiveNodes(deps(events));
    expect(events).toEqual([]);
    expect(nextCheckOf(workflowId, executor)).toBe(now + WINDOW);

    store.close();
    store = open();
    expect(nextCheckOf(workflowId, executor)).toBe(now + WINDOW);
  });

  it("cancels as residual a node whose consumer has no live turn left", () => {
    const { workflowId, delegator, executor } = tree();
    checkLiveNodes(deps([]));
    now += WINDOW;
    // d1's only turn ends without consuming e1's result: e1 is residual.
    store.tasks.cancel(epoch, delegator, "user_stop");
    const events: RunEvent[] = [];
    const pass = checkLiveNodes(deps(events));

    expect(pass.cancelled.map((task) => task.taskId)).toEqual([executor]);
    expect(store.tasks.get(executor)?.state).toBe("cancelled");
    const closed = store.events.list().find((event) => event.type === "watchdog.closed");
    expect(closed?.payload).toMatchObject({
      workflowId,
      node: "e1",
      by: "d1",
      verdict: "residual",
      action: "cancel",
    });
    expect(String(closed?.payload.text)).toBe(
      "e1 cancelled: residual (nobody waits for its result)",
    );
    expect(events).toContainEqual({
      type: "task.cancelled",
      taskId: executor,
      goal: "executor step-1",
      reason: "residual",
    });
    // WorkflowSnapshot v1 shows the verdict as its own line, which starts with the node's id (the console reads it).
    const snapshot = buildWorkflowSnapshot(store, workflowId, { now });
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        type: "watchdog.closed",
        text: "e1 cancelled: residual (nobody waits for its result)",
      }),
    );
  });

  it("lets a waiting delegator continue when its children have live work", () => {
    const { workflowId, delegator } = tree();
    checkLiveNodes(deps([]));
    now += WINDOW;
    const events: RunEvent[] = [];
    checkLiveNodes(deps(events));
    const verdict = events.find(
      (event) => event.type === "watchdog.checked" && event.node === "d1",
    );
    expect(verdict).toMatchObject({ verdict: "active", action: "continue" });
    expect(store.tasks.get(delegator)?.state).toBe("ready");
    expect(nextCheckOf(workflowId, delegator)).toBe(now + WINDOW);
  });
});
