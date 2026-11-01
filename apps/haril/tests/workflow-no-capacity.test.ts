import { randomUUID } from "node:crypto";
import { DIFFICULTIES } from "@haril/contracts";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_QUOTA_POLICY,
  type DifficultyTable,
  type ModelSelectionContext,
} from "@haril/core";
import type { Clock, Store, WorkflowAutonomy } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkflowSnapshot } from "../src/commands/workflow-snapshot.js";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { withStoreState } from "../src/runtime/model-context.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { claimWorkflowTurns, settleWorkflows } from "../src/runtime/workflow-scheduler.js";
import type { DelegationOptions } from "../src/runtime/workflow-view.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// A workflow with no model that can run its next turn does not fail any more (feature haril-factory, F6): the turn stops
// with an explanation of what was tried and who holds it, and the workflow goes on by itself when capacity returns.
// maxWorkflowWallMs stays the hard cap.

const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};
const AUTONOMOUS: WorkflowAutonomy = { mode: "autonomous", stops: [] };
const ORCHESTRATOR = "fake/high-model";
const CHILD = "cliproxy/Acct1/fast";

function classesOf(order: readonly string[]): DifficultyTable["classes"] {
  return Object.fromEntries(
    DIFFICULTIES.map((name) => [name, { minSuccessRate: 0, order: [...order] }]),
  ) as unknown as DifficultyTable["classes"];
}

// One model for every child, and no wait allowed: any cooldown of it leaves nothing that can run.
function oneModel(): DelegationOptions {
  const models: Omit<ModelSelectionContext, "now" | "largeTaskTokens"> = {
    catalog: [ORCHESTRATOR, CHILD].map((ref) => ({
      ref,
      quotaKey: ref.split("/").slice(0, 2).join("/"),
      hasKey: true,
      coolingUntil: null,
    })),
    allow: {},
    pinned: {},
    quota: {},
    table: { classes: classesOf([CHILD]), models: {} },
    stats: {},
    policy: { ...DEFAULT_QUOTA_POLICY, maxWaitMs: 0 },
  };
  return { models };
}

let sb: Sandbox;
let store: Store;

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
  const { projectId } = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root });
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(sb.root),
      goal: "Report [fake:parts=1] [fake:steps=1]",
      model: ORCHESTRATOR,
      agent: "fake:orchestrate",
      autonomy: AUTONOMOUS,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: "wf",
    requestHash: "wf",
  });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

async function run(delegation: DelegationOptions): Promise<void> {
  const tools = createDelegationTools({ store, clock, options: delegation });
  await runUntilIdle({
    store,
    agentRuntime: new FakeAgentRuntime({ clock, delegationTools: tools.call }),
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: () => undefined,
    idleExitMs: 0,
    pollMs: 20,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation,
  });
}

function workflowId(): string {
  const [workflow] = store.workflows.list();
  if (workflow === undefined) throw new Error("no workflow");
  return workflow.workflowId;
}

describe("no model can run a turn", () => {
  it("stops the turn with what was tried and when one frees, instead of failing the workflow", async () => {
    const until = Date.now() + 60_000;
    store.quota.setCooldown({ model: CHILD, until, reason: "quota" });
    await run(oneModel());
    const [workflow] = store.workflows.list();
    expect(workflow?.state).toBe("running");
    expect(workflow?.stopReason).toBeNull();
    const snapshot = buildWorkflowSnapshot(store, workflowId(), { now: Date.now() });
    const stopped = snapshot.nodes.find((node) => node.explanation?.code === "blocked_no_capacity");
    expect(stopped?.state).toBe("waiting");
    expect(stopped?.explanation?.why).toContain(CHILD);
    expect(stopped?.explanation?.why).toContain("en enfriamiento");
    expect(stopped?.explanation?.why).toContain("se libera");
    expect(stopped?.explanation?.until).toBe(until);
    expect(stopped?.explanation?.needsHuman).toBe(false);
    expect(stopped?.explanation?.systemAction).toContain("sola");
    // The flow as a whole says so too.
    expect(snapshot.workflow.explanation?.code).toBe("blocked_no_capacity");
  });

  it("goes on by itself when capacity returns", async () => {
    store.quota.setCooldown({ model: CHILD, until: Date.now() + 250, reason: "rate_limited" });
    await run(oneModel());
    expect(store.workflows.list()[0]?.state).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await run(oneModel());
    expect(store.workflows.list()[0]?.state).toBe("completed");
  });

  it("names who holds a model it tried", async () => {
    store.quota.setCooldown({ model: CHILD, until: Date.now() + 60_000, reason: "quota" });
    await run(oneModel());
    const events = store.events.list({ projectId: store.projects.list()[0]?.projectId ?? "" });
    const waiting = events.filter((event) => event.type === "capacity.waiting");
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.at(-1)?.payload).toMatchObject({
      workflowId: workflowId(),
      tried: [{ model: CHILD, cause: "cooldown" }],
      holders: [],
    });
  });

  it("names the running agent that holds the model", async () => {
    store.quota.setCooldown({ model: CHILD, until: Date.now() + 60_000, reason: "quota" });
    await run(oneModel());
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    const epoch = grant.value.epoch;
    const root = store.workflows.tasks(workflowId())[0];
    const turn = (key: string) => ({
      key,
      threadId: null,
      role: "delegator" as const,
      layer: 2 as const,
      kind: "plan" as const,
      parentTaskId: root?.taskId ?? null,
      localId: key,
      goal: key,
      description: "",
      agentRef: "fake:delegate",
      model: CHILD,
      modelPinned: false,
      difficulty: "medium" as const,
      difficultyReason: "test",
      priority: 5,
      budgetTokens: 20_000,
      timeoutMs: 60_000,
      surfaceWrite: [],
      surfaceRead: [],
      dependsOn: [],
    });
    const { taskIds } = store.workflows.applyTurns(epoch, {
      workflowId: workflowId(),
      turns: [turn("holder"), turn("waiter")],
    });
    store.tasks.promote();
    store.tasks.claimTask(epoch, taskIds.holder as string);
    claimWorkflowTurns(store, epoch, withStoreState(store, oneModel()), new Set(), Date.now());
    const waiting = store.events
      .list({ aggregateId: taskIds.waiter as string })
      .filter((event) => event.type === "capacity.waiting");
    expect(waiting.at(-1)?.payload).toMatchObject({
      holders: [{ model: CHILD, agent: "holder" }],
    });
  });

  it("still ends at the workflow's wall time", async () => {
    store.quota.setCooldown({ model: CHILD, until: Date.now() + 60_000, reason: "quota" });
    await run(oneModel());
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    const later: Clock = { ...clock, now: () => Date.now() + 8 * 3_600_000 };
    const ended = settleWorkflows(store, grant.value.epoch, later, oneModel());
    expect(ended).toEqual([{ workflowId: workflowId(), state: "failed", reason: "wall_time" }]);
  });
});
