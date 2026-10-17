import { randomUUID } from "node:crypto";
import type { ControlEvent } from "@haril/control";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  type RunEvent,
} from "@haril/core";
import type { Clock, PlanProposer, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { createPlanProposals, type PlanProposals } from "../src/runtime/plan-proposals.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// The planner, hermetic lane (LD-T4): a kind plan task runs fake:plan, which proposes its plan through the host handler.
// The plan waits as a requested approval; once granted, the runtime queues it and its tasks run. A plan attempt that
// proposes nothing, or whose plan the host refuses, fails like any other attempt.
const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
let sb: Sandbox;
const stores: Store[] = [];
let keySeq = 0;

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
    clock,
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

function projectOf(store: Store): string {
  return store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
}

// Queues and applies nothing: the loop applies the task.create on its first turn.
function addPlanTask(store: Store, projectId: string, maxAttempts = 1): void {
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: {
      goal: "Document the CLI",
      dependsOn: [],
      kind: "plan",
      agent: "fake:plan",
      maxAttempts,
      timeoutMs: 5_000,
    },
    idempotencyKey: `plan-${++keySeq}`,
    requestHash: `plan-${keySeq}`,
  });
}

interface LoopSetup {
  readonly proposals?: PlanProposals;
  readonly proposePlan?: PlanProposer;
  readonly notified?: ControlEvent[];
}

function loop(store: Store, events: RunEvent[], setup: LoopSetup) {
  const notified = setup.notified ?? [];
  return runUntilIdle({
    store,
    agentRuntime: new FakeAgentRuntime({
      clock,
      ...(setup.proposePlan === undefined ? {} : { proposePlan: setup.proposePlan }),
    }),
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: (event) => events.push(event),
    idleExitMs: 0,
    pollMs: 50,
    shutdown: createShutdown(),
    ...(setup.proposals === undefined ? {} : { planProposals: setup.proposals }),
    control: {
      start: async () => undefined,
      close: async () => undefined,
      notify: (event) => notified.push(event),
      subscriberCount: () => 0,
      onNudge: () => () => undefined,
    },
  });
}

function onlyTask(store: Store) {
  const [task] = store.tasks.list();
  if (task === undefined) throw new Error("expected one task");
  return task;
}

describe("the planner in the runtime (LD-T4)", () => {
  it("proposes a plan that waits for approval, and runs the plan's tasks once it is granted", async () => {
    const store = open();
    const projectId = projectOf(store);
    addPlanTask(store, projectId);
    const proposals = createPlanProposals(store);
    const events: RunEvent[] = [];
    const notified: ControlEvent[] = [];

    const first = await loop(store, events, {
      proposals,
      proposePlan: proposals.propose,
      notified,
    });

    const planTask = onlyTask(store);
    expect(first.kind).toBe("idle");
    if (first.kind !== "idle") return;
    expect(first.summary).toMatchObject({ completed: [planTask.taskId], failed: [] });
    expect(planTask.state).toBe("completed");
    const [approval] = store.approvals.list({ status: "requested" });
    expect(approval).toBeDefined();
    if (approval === undefined) return;
    expect(approval.projectId).toBe(projectId);
    expect(approval.requestedBy).not.toBe("cli");
    expect(store.tasks.get(planTask.taskId)?.result?.summary).toContain(approval.approvalId);
    // The event comes while the attempt runs, before the task completes.
    const types = events.map((event) => event.type);
    expect(types.indexOf("approval.requested")).toBeLessThan(types.indexOf("task.completed"));
    expect(events).toContainEqual({
      type: "approval.requested",
      approvalId: approval.approvalId,
      taskId: planTask.taskId,
      created: true,
    });
    // Subscribers learn the event type and the task id, never the approval or its plan.
    expect(notified).toContainEqual({ eventType: "approval.requested", taskId: planTask.taskId });
    for (const event of notified) expect(Object.keys(event).sort()).not.toContain("approvalId");

    open().approvals.decide({
      approvalId: approval.approvalId,
      outcome: "granted",
      decidedBy: "ana",
    });
    const secondEvents: RunEvent[] = [];
    const second = await loop(store, secondEvents, {
      proposals,
      proposePlan: proposals.propose,
    });

    expect(second.kind).toBe("idle");
    const planned = store.tasks.list().filter((task) => task.taskId !== planTask.taskId);
    const subjectTasks = (approval.subject as { tasks: unknown[] }).tasks;
    expect(planned).toHaveLength(subjectTasks.length);
    expect(planned.length).toBeGreaterThanOrEqual(2);
    expect(planned.every((task) => task.state === "completed")).toBe(true);
    expect(secondEvents).toContainEqual(
      expect.objectContaining({ type: "approval.applied", outcome: "granted" }),
    );
    if (second.kind === "idle") expect(second.summary.failed).toEqual([]);
  }, 20_000);

  it("fails the plan task when the agent runtime has no proposer, and records no approval", async () => {
    const store = open();
    addPlanTask(store, projectOf(store));
    const events: RunEvent[] = [];

    await loop(store, events, { proposals: createPlanProposals(store) });

    expect(onlyTask(store).state).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.failed", code: "fake.no_proposer" }),
    );
    expect(store.approvals.list()).toEqual([]);
  });

  it("fails the plan task with the reason when the host refuses its plan", async () => {
    const store = open();
    addPlanTask(store, projectOf(store));
    const events: RunEvent[] = [];

    await loop(store, events, {
      proposals: createPlanProposals(store),
      proposePlan: () => ({ ok: false, reason: "invalid plan: simulated refusal" }),
    });

    const task = onlyTask(store);
    expect(task.state).toBe("failed");
    expect(store.tasks.get(task.taskId)?.error).toEqual({
      code: "plan.refused",
      message: "invalid plan: simulated refusal",
    });
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("fails a plan attempt that succeeds without a recorded proposal as plan.not_proposed, with retries", async () => {
    const store = open();
    addPlanTask(store, projectOf(store), 2);
    const events: RunEvent[] = [];

    // The agent believes it proposed, but nothing reached the host: the run loop saw no proposal for the run.
    await loop(store, events, {
      proposals: createPlanProposals(store),
      proposePlan: () => ({ ok: true, approvalId: "never-recorded", created: true }),
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.retrying", code: "plan.not_proposed" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.failed", code: "plan.not_proposed" }),
    );
    expect(onlyTask(store).state).toBe("failed");
  });

  it("fails a plan attempt as plan.not_proposed when the loop tracks no proposals at all", async () => {
    const store = open();
    addPlanTask(store, projectOf(store));
    const events: RunEvent[] = [];

    await loop(store, events, {
      proposePlan: () => ({ ok: true, approvalId: "never-recorded", created: true }),
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.failed", code: "plan.not_proposed" }),
    );
  });

  it("refuses a proposal from a run whose window the loop did not open", async () => {
    const store = open();
    addPlanTask(store, projectOf(store));
    const events: RunEvent[] = [];
    // A handler the loop does not track: the attempt is never opened in it, so its proposal is refused.
    const outside = createPlanProposals(store);

    await loop(store, events, {
      proposals: createPlanProposals(store),
      proposePlan: outside.propose,
    });

    const task = onlyTask(store);
    expect(store.tasks.get(task.taskId)?.error).toMatchObject({ code: "plan.refused" });
    expect(store.approvals.list()).toEqual([]);
  });
});

describe("createPlanProposals (LD-T4)", () => {
  const plan = (goal: string) => ({
    schemaVersion: 1,
    tasks: [
      {
        localId: "only",
        dependsOn: [],
        goal,
        description: "",
        priority: 5,
        kind: "work",
        agent: "fake:succeed",
        requires: [],
        context: [],
        surface: { write: [], read: [] },
        budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 1000 },
        timeoutMs: 1000,
        maxAttempts: 1,
        acceptance: [],
      },
    ],
  });

  it("records a plan only for an open plan attempt, reports it once, and says whether the run proposed", () => {
    const store = open();
    const projectId = projectOf(store);
    const proposals = createPlanProposals(store);
    const context = { projectId, taskId: "task-1", runId: "run-1" };

    const closed = proposals.propose(context, plan("Survey"));
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.reason).toContain("not a running plan task");

    const recorded: unknown[] = [];
    const close = proposals.open(context, (proposal) => recorded.push(proposal));
    const first = proposals.propose(context, plan("Survey"));
    expect(first).toMatchObject({ ok: true, created: true });
    const again = proposals.propose(context, plan("Survey"));
    expect(again).toMatchObject({ ok: true, created: false });
    if (!first.ok) return;
    expect(again).toMatchObject({ approvalId: first.approvalId });
    expect(store.approvals.get(first.approvalId)).toMatchObject({
      status: "requested",
      requestedBy: "run-1",
      projectId,
    });
    expect(recorded).toEqual([
      { approvalId: first.approvalId, taskId: "task-1", created: true },
      { approvalId: first.approvalId, taskId: "task-1", created: false },
    ]);
    expect(close()).toBe(true);
    // A closed window refuses late calls.
    expect(proposals.propose(context, plan("Late")).ok).toBe(false);
  });

  it("refuses an invalid plan with the plan.submit reason, a foreign task or project, and records nothing", () => {
    const store = open();
    const projectId = projectOf(store);
    const proposals = createPlanProposals(store);
    const context = { projectId, taskId: "task-1", runId: "run-1" };
    const close = proposals.open(context, () => undefined);

    const invalid = proposals.propose(context, { schemaVersion: 2, tasks: [] });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toContain("invalid plan");
    const nested = proposals.propose(context, {
      ...plan("Nested"),
      tasks: [{ ...plan("Nested").tasks[0], kind: "plan" }],
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.reason).toContain('has kind "plan"');
    expect(proposals.propose({ ...context, taskId: "task-2" }, plan("Other")).ok).toBe(false);
    expect(proposals.propose({ ...context, projectId: "elsewhere" }, plan("Other")).ok).toBe(false);

    expect(close()).toBe(false);
    expect(store.approvals.list()).toEqual([]);
  });
});

// The README flow: ask for a plan, run, list the approval, approve it, run again.
describe("haril task add --kind plan, run, approve, run (LD-T4)", () => {
  it("runs a hermetic plan request end to end from the CLI", async () => {
    const init = harness();
    expect(
      run(
        ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
        init.io,
        sb.host,
      ),
    ).toBe(0);
    const add = harness();
    expect(
      run(
        ["task", "add", "Document the CLI", "--kind", "plan", "--agent", "fake:plan"],
        add.io,
        sb.host,
      ),
    ).toBe(0);

    const firstRun = harness();
    expect(await run(["run"], firstRun.io, sb.host)).toBe(0);
    const pending = harness();
    expect(run(["approvals", "--json"], pending.io, sb.host)).toBe(0);
    const [approval] = parseJson<{ approvalId: string; status: string; tasks: number }[]>(
      pending.out,
    );
    expect(approval).toMatchObject({ status: "requested" });
    if (approval === undefined) return;
    expect(firstRun.out.join("\n")).toContain(`approval ${approval.approvalId} requested`);

    const approve = harness();
    expect(
      await run(["approve", approval.approvalId], approve.io, { ...sb.host, user: "ana" }),
    ).toBe(0);
    const secondRun = harness();
    expect(await run(["run"], secondRun.io, sb.host)).toBe(0);

    const status = harness();
    run(["status", "--json"], status.io, sb.host);
    const tasks = parseJson<{ taskList: { state: string }[] }>(status.out).taskList;
    expect(tasks).toHaveLength(1 + approval.tasks);
    expect(tasks.every((task) => task.state === "completed")).toBe(true);
  }, 20_000);
});
