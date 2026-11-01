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
  type RunEvent,
} from "@haril/core";
import type { Clock, Store, WorkflowAutonomy } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { withStoreState } from "../src/runtime/model-context.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { claimWorkflowTurns } from "../src/runtime/workflow-scheduler.js";
import type { DelegationOptions } from "../src/runtime/workflow-view.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// Cooldown and retry on provider errors (docs/modos-y-delegacion.md 3.11, phase F6), hermetic: the fake workflow agents
// answer a scripted provider error ([fake:provider=<target>:<status>] in the goal) and the real loop and store decide. A
// 402 or 429 cools the model down and retries the turn once on another eligible model or account; a transient error is
// retried once on the same model; nothing is retried after the turn's deciding call was accepted; a pinned model is never
// replaced (it waits); and with no eligible model the turn stops, explained, until capacity returns.

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
const FIRST = "cliproxy/Acct1/fast";
const SECOND = "cliproxy/Acct2/fast";

// Every class tries the same models in order, with no success rate needed.
function classesOf(order: readonly string[]): DifficultyTable["classes"] {
  return Object.fromEntries(
    DIFFICULTIES.map((name) => [name, { minSuccessRate: 0, order: [...order] }]),
  ) as unknown as DifficultyTable["classes"];
}

let sb: Sandbox;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
  stores.push(store);
  return store;
}

let keySeq = 0;
function startWorkflow(store: Store, goal: string): void {
  const projectId =
    store.projects.list()[0]?.projectId ??
    store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(store.projects.list()[0]?.rootPath as string),
      goal,
      model: ORCHESTRATOR,
      agent: "fake:orchestrate",
      autonomy: AUTONOMOUS,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: `wf-${++keySeq}`,
    requestHash: `wf-${keySeq}`,
  });
}

// Two accounts serve the children's model; the table tries the first account, then the second.
function twoAccounts(maxWaitMs = DEFAULT_QUOTA_POLICY.maxWaitMs): DelegationOptions {
  const order = [FIRST, SECOND];
  const models: Omit<ModelSelectionContext, "now" | "largeTaskTokens"> = {
    catalog: [ORCHESTRATOR, FIRST, SECOND].map((ref) => ({
      ref,
      quotaKey: ref.split("/").slice(0, 2).join("/"),
      hasKey: true,
      coolingUntil: null,
    })),
    allow: {},
    pinned: {},
    quota: {},
    table: { classes: classesOf(order), models: {} },
    stats: {},
    policy: { ...DEFAULT_QUOTA_POLICY, maxWaitMs },
  };
  return { models };
}

async function run(store: Store, delegation: DelegationOptions) {
  const events: RunEvent[] = [];
  const tools = createDelegationTools({ store, clock, options: delegation });
  const agents = new FakeAgentRuntime({ clock, delegationTools: tools.call });
  const result = await runUntilIdle({
    store,
    agentRuntime: agents,
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: (event) => events.push(event),
    idleExitMs: 0,
    pollMs: 20,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation,
  });
  return { result, events };
}

function threadTasks(
  store: Store,
  label: (task: { localId: string | null; role: string }) => boolean,
) {
  const [workflow] = store.workflows.list();
  if (workflow === undefined) throw new Error("no workflow");
  return { workflow, tasks: store.workflows.tasks(workflow.workflowId).filter(label) };
}

describe("a provider error in a workflow turn", () => {
  it("cools a 429's model down and retries the turn once on the other account", async () => {
    const store = open();
    startWorkflow(store, "Report [fake:parts=1] [fake:steps=1] [fake:provider=part-1:429]");
    await run(store, twoAccounts());
    const { workflow, tasks } = threadTasks(
      store,
      (task) => task.localId === "part-1" && task.role === "delegator",
    );
    expect(workflow.state).toBe("completed");
    const first = tasks[0];
    expect(first?.model).toBe(SECOND);
    expect(store.workflows.providerRetries(first?.taskId ?? "")).toBe(1);
    const cooldowns = store.quota.cooldowns(Date.now());
    expect(cooldowns.map((row) => [row.model, row.reason])).toEqual([[FIRST, "rate_limited"]]);
    // The retry-after of the 429 decides the end of the cooldown.
    expect((cooldowns[0]?.until ?? 0) - Date.now()).toBeGreaterThan(50_000);
    // Every run left its usage row: the failed one too, with no model served.
    const rows = store.usageLog
      .usage({ workflowId: workflow.workflowId })
      .filter((row) => row.taskId === first?.taskId);
    expect(rows.map((row) => [row.outcome, row.modelRequested, row.modelServed])).toEqual([
      ["provider_retry", FIRST, null],
      ["assigned", SECOND, SECOND],
    ]);
    expect(store.usageLog.verify().ok).toBe(true);
    expect(
      store.events.list({ aggregateId: workflow.workflowId }).map((event) => event.type),
    ).toContain("model.substituted");
  });

  it("retries a transient error once on the same model, with no cooldown", async () => {
    const store = open();
    startWorkflow(store, "Report [fake:parts=1] [fake:steps=1] [fake:provider=part-1/step-1:500]");
    await run(store, twoAccounts());
    const { workflow, tasks } = threadTasks(
      store,
      (task) => task.localId === "step-1" && task.role === "executor",
    );
    expect(workflow.state).toBe("completed");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.model).toBe(FIRST);
    expect(store.workflows.providerRetries(tasks[0]?.taskId ?? "")).toBe(1);
    expect(store.quota.cooldowns(Date.now())).toEqual([]);
  });

  it("never retries a turn whose deciding call was already accepted", async () => {
    const store = open();
    startWorkflow(
      store,
      "Report [fake:parts=1] [fake:steps=1] [fake:provider=orchestrator:429-after-call]",
    );
    await run(store, twoAccounts());
    const [workflow] = store.workflows.list();
    const tasks = store.workflows.tasks(workflow?.workflowId ?? "");
    expect(workflow?.state).toBe("failed");
    expect(store.workflows.providerRetries(tasks[0]?.taskId ?? "")).toBe(0);
    // The call was not applied either: no delegator was created.
    expect(tasks.filter((task) => task.role === "delegator")).toEqual([]);
  });

  it("makes a pinned model wait for its cooldown instead of replacing it", async () => {
    const store = open();
    startWorkflow(store, "Report [fake:parts=1] [fake:steps=1] [fake:provider=orchestrator:429]");
    await run(store, twoAccounts());
    const [workflow] = store.workflows.list();
    const root = store.workflows.tasks(workflow?.workflowId ?? "")[0];
    expect(workflow?.state).toBe("running");
    expect(root).toMatchObject({ model: ORCHESTRATOR, state: "blocked", blockReason: "cooldown" });
    expect((root?.cooldownUntil ?? 0) - Date.now()).toBeGreaterThan(50_000);
  });

  it("stops the turn instead of failing the workflow when no model can run and none frees up in time", async () => {
    const store = open();
    startWorkflow(store, "Report [fake:parts=1] [fake:steps=1] [fake:provider=part-1:402]");
    // A single account, and no wait allowed: once its model cools down nothing else can run.
    const options = twoAccounts(0);
    const models = options.models as Omit<ModelSelectionContext, "now" | "largeTaskTokens">;
    const single: DelegationOptions = {
      models: {
        ...models,
        catalog: models.catalog.filter((entry) => entry.ref !== SECOND),
        table: { classes: classesOf([FIRST]), models: {} },
      },
    };
    await run(store, single);
    const [workflow] = store.workflows.list();
    expect(workflow?.state).toBe("running");
    expect(workflow?.stopReason).toBeNull();
    const part = store.workflows
      .tasks(workflow?.workflowId ?? "")
      .find((task) => task.localId === "part-1");
    expect(part).toMatchObject({ state: "blocked", blockReason: "cooldown" });
    // A 402 cools the model and its account down.
    expect(
      store.quota
        .cooldowns(Date.now())
        .map((row) => row.model)
        .sort(),
    ).toEqual([FIRST, "quota:cliproxy/Acct1"]);
  });
});

describe("a turn's model at its launch", () => {
  it("waits for a cooling pinned model, and replaces a cooling parent's model with the next eligible one", async () => {
    const store = open();
    startWorkflow(store, "Report [fake:parts=1] [fake:steps=1]");
    // As the run loop composes it: the store's cooldowns over the options.
    const options = withStoreState(store, twoAccounts());
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    const epoch = grant.value.epoch;
    store.commands.applyNext(epoch);
    store.tasks.promote();
    // The orchestrator's model (pinned) cools down before its turn starts: the turn waits.
    store.quota.setCooldown({
      model: ORCHESTRATOR,
      until: Date.now() + 120_000,
      reason: "rate_limited",
    });
    expect(claimWorkflowTurns(store, epoch, options)).toEqual([]);
    const [workflow] = store.workflows.list();
    const root = store.workflows.tasks(workflow?.workflowId ?? "")[0];
    expect(root).toMatchObject({ state: "blocked", blockReason: "cooldown", model: ORCHESTRATOR });

    // A child turn created on the first account, whose account cools down before it starts, runs on the second.
    store.workflows.applyTurns(epoch, {
      workflowId: workflow?.workflowId ?? "",
      turns: [
        {
          key: "d1",
          threadId: null,
          role: "delegator",
          layer: 2,
          kind: "plan",
          parentTaskId: root?.taskId ?? null,
          localId: "part-1",
          goal: "Part 1",
          description: "",
          agentRef: "fake:delegate",
          model: FIRST,
          modelPinned: false,
          difficulty: "medium",
          difficultyReason: "two files",
          priority: 5,
          budgetTokens: 20_000,
          timeoutMs: 60_000,
          surfaceWrite: [],
          surfaceRead: [],
          dependsOn: [],
        },
      ],
    });
    store.tasks.promote();
    store.quota.setCooldown({ model: FIRST, until: Date.now() + 120_000, reason: "rate_limited" });
    const claimed = claimWorkflowTurns(store, epoch, options);
    expect(claimed).toHaveLength(1);
    const child = store.workflows
      .tasks(workflow?.workflowId ?? "")
      .find((task) => task.localId === "part-1");
    expect(child).toMatchObject({ model: SECOND, state: "running" });
    store.runtime.release(epoch, true);
  });
});
