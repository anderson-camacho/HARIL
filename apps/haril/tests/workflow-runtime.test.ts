import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_AUTONOMY,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationLimits,
  type RunEvent,
} from "@haril/core";
import type { AgentRuntime, AgentSpec, Clock, Store, WorkflowAutonomy } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkflowSnapshot } from "../src/commands/workflow-snapshot.js";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { WorkflowView } from "../src/runtime/workflow-view.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// The runtime that runs three-layer workflows (docs/modos-y-delegacion.md 3.3 to 3.9, phase F2), hermetic: the fake
// workflow agents inside FakeAgentRuntime, the real SQLite store in a sandbox, the real concurrent loop. Each scenario is
// scripted in the workflow's goal ([fake:...] directives) and checked in the store: the tree, the limits, the rework,
// the continuations, the gates and a restart after a crash.

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

let sb: Sandbox;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(isPidAlive: (pid: number) => boolean = () => true): Store {
  const store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules,
    isPidAlive,
  });
  stores.push(store);
  return store;
}

let keySeq = 0;

function startWorkflow(
  store: Store,
  goal: string,
  autonomy: WorkflowAutonomy = AUTONOMOUS,
  limits: Partial<DelegationLimits> = {},
): void {
  const projectId =
    store.projects.list()[0]?.projectId ??
    store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(store.projects.list()[0]?.rootPath as string),
      goal,
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy,
      limits,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: `wf-${++keySeq}`,
    requestHash: `wf-${keySeq}`,
  });
}

// Live agents by role and by parent thread, as the agent runtime sees them start and settle.
interface Peaks {
  executors: number;
  auditors: number;
  delegators: number;
  writers: number;
  childrenOfOrchestrator: number;
  childrenOfDelegator: number;
  attempts: number;
}

function tracked(inner: AgentRuntime, store: Store, peaks: Peaks): AgentRuntime {
  const live = new Map<
    string,
    { role: string; parentThread: string | null; parentRole: string | null; writes: boolean }
  >();
  const record = () => {
    const values = [...live.values()];
    const count = (role: string) => values.filter((item) => item.role === role).length;
    peaks.executors = Math.max(peaks.executors, count("executor"));
    peaks.auditors = Math.max(peaks.auditors, count("auditor"));
    peaks.delegators = Math.max(peaks.delegators, count("delegator"));
    peaks.writers = Math.max(peaks.writers, values.filter((item) => item.writes).length);
    const perParent = new Map<string, { role: string | null; count: number }>();
    for (const item of values) {
      if (item.role === "auditor" || item.parentThread === null) continue;
      const entry = perParent.get(item.parentThread) ?? { role: item.parentRole, count: 0 };
      perParent.set(item.parentThread, { role: entry.role, count: entry.count + 1 });
    }
    for (const { role, count: children } of perParent.values()) {
      if (role === "orchestrator")
        peaks.childrenOfOrchestrator = Math.max(peaks.childrenOfOrchestrator, children);
      if (role === "delegator")
        peaks.childrenOfDelegator = Math.max(peaks.childrenOfDelegator, children);
    }
  };
  return {
    start: async (spec: AgentSpec) => {
      const started = await inner.start(spec);
      if (!started.ok || spec.delegation === undefined) return started;
      const input = spec.delegation;
      const tasks = store.workflows.tasks(input.workflowId);
      const task = tasks.find((row) => row.taskId === spec.taskId);
      const parent = tasks.find((row) => row.taskId === task?.parentTaskId);
      live.set(spec.runId, {
        role: input.role,
        parentThread: parent?.threadId ?? null,
        parentRole: parent?.role ?? null,
        writes: (task?.surfaceWrite.length ?? 0) > 0,
      });
      peaks.attempts += 1;
      record();
      void started.value.settled.then(() => live.delete(spec.runId));
      return started;
    },
  };
}

interface RunSetup {
  readonly limits?: DelegationLimits;
  // Milliseconds per minute of the fake turns' drawn time.
  readonly msPerMinute?: number;
  readonly pid?: number;
  readonly wrap?: (store: Store) => Store;
}

async function run(store: Store, setup: RunSetup = {}) {
  const events: RunEvent[] = [];
  const peaks: Peaks = {
    executors: 0,
    auditors: 0,
    delegators: 0,
    writers: 0,
    childrenOfOrchestrator: 0,
    childrenOfDelegator: 0,
    attempts: 0,
  };
  const delegation = setup.limits === undefined ? {} : { limits: setup.limits };
  const used = setup.wrap?.(store) ?? store;
  const tools = createDelegationTools({ store: used, clock, options: delegation });
  const msPerMinute = setup.msPerMinute ?? 0.2;
  const agents = new FakeAgentRuntime({
    clock,
    delegationTools: tools.call,
    delegationDelayMs: (cost) => Math.round((cost.durationMs / 60_000) * msPerMinute),
  });
  const result = await runUntilIdle({
    store: used,
    agentRuntime: tracked(agents, store, peaks),
    clock,
    pid: setup.pid ?? process.pid,
    nodeVersion: process.version,
    onEvent: (event) => events.push(event),
    idleExitMs: 0,
    pollMs: 20,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation,
  });
  return { result, events, peaks };
}

function onlyWorkflow(store: Store) {
  const [workflow] = store.workflows.list();
  if (workflow === undefined) throw new Error("no workflow");
  const view = WorkflowView.load(store, workflow.workflowId) as WorkflowView;
  const threads = new Map<string, string[]>();
  for (const task of view.tasks) {
    const label = view.label(task.threadId);
    threads.set(label, [...(threads.get(label) ?? []), task.taskId]);
  }
  return { workflow, view, threads };
}

describe("a three-layer workflow through the runtime", () => {
  it("runs the whole tree to completion: plan, assignments, executors, audits, reports and the final audit", async () => {
    const store = open();
    startWorkflow(store, "Ship the button [fake:parts=2] [fake:steps=3]");
    const { result, events } = await run(store);
    expect(result.kind).toBe("idle");
    const { workflow, view, threads } = onlyWorkflow(store);
    expect(workflow.state).toBe("completed");
    expect(threads.get("orchestrator")).toHaveLength(2);
    expect(threads.get("part-1")).toHaveLength(2);
    expect(threads.get("part-2")).toHaveLength(2);
    for (const part of ["part-1", "part-2"]) {
      for (const step of [1, 2, 3]) {
        expect(threads.get(`${part}/step-${step}`), `${part}/step-${step}`).toHaveLength(1);
        expect(threads.get(`audit of ${part}/step-${step}`)).toHaveLength(1);
      }
    }
    for (const executor of view.tasks.filter((task) => task.role === "executor")) {
      const auditor = view.auditorOf(executor.taskId);
      expect(auditor).toBeDefined();
      expect(auditor?.parentTaskId).toBe(executor.parentTaskId);
      expect(auditor?.auditedTaskId).toBe(executor.taskId);
      expect(auditor?.dependsOn).toContainEqual({ taskId: executor.taskId, kind: "completed" });
      const snapshot = buildWorkflowSnapshot(store, workflow.workflowId, { now: Date.now() });
      const executorNode = snapshot.nodes.find((node) => node.threadId === executor.threadId);
      const auditorNode = snapshot.nodes.find((node) => node.threadId === auditor?.threadId);
      expect(auditorNode).toMatchObject({
        parentId: executorNode?.parentId,
        auditedId: executorNode?.id,
        label: `Auditor of ${executorNode?.id}`,
      });
    }
    expect(threads.get("final audit")).toHaveLength(1);
    expect(view.tasks.every((task) => task.state === "completed")).toBe(true);
    expect(view.audits.filter((audit) => audit.scope === "task")).toHaveLength(6);
    expect(view.finalAudit()?.verdict).toBe("approved");
    // Every attempt left one agent_run row, with its role, layer, model, tokens, time and outcome.
    const usage = store.usageLog.usage({ workflowId: workflow.workflowId });
    expect(usage).toHaveLength(view.tasks.length);
    for (const row of usage) {
      expect(row).toMatchObject({ kind: "agent_run", mode: "delegacion", simulated: true });
      expect(row.role).not.toBeNull();
      expect(row.layer).not.toBeNull();
      expect(row.modelServed).toBe("fake/high-model");
      expect(row.tokensIn).toBeGreaterThan(0);
      expect(row.durationMs).not.toBeNull();
      expect(row.outcome).not.toBeNull();
    }
    expect(usage.filter((row) => row.role === "auditor").map((row) => row.auditVerdict)).toEqual(
      Array(7).fill("approved"),
    );
    expect(store.usageLog.verify().ok).toBe(true);
    expect(events.filter((event) => event.type === "workflow.state")).toEqual([
      {
        type: "workflow.state",
        workflowId: workflow.workflowId,
        state: "completed",
        reason: "read-only consultation; no implementation or tests claimed",
      },
    ]);
    // The continuations received their children's outcomes and the memo; the prompt carried them as data.
    expect(view.delegations.map((row) => row.tool).sort()).toEqual([
      "haril_assign",
      "haril_assign",
      "haril_delegate",
      "haril_request_audit",
    ]);
  });

  it("never runs more agents at once than the limits allow, per role, per thread and for writers", async () => {
    const limits: DelegationLimits = {
      ...DEFAULT_DELEGATION_LIMITS,
      maxActiveChildren: { orchestrator: 2, delegator: 2 },
      maxConcurrent: { executors: 3, auditors: 2, delegators: 2, writers: 1 },
    };
    const store = open();
    startWorkflow(store, "Wide work [fake:parts=3] [fake:steps=5]");
    const { peaks } = await run(store, { limits, msPerMinute: 8 });
    expect(onlyWorkflow(store).workflow.state).toBe("completed");
    expect(peaks.executors).toBeLessThanOrEqual(3);
    expect(peaks.auditors).toBeLessThanOrEqual(2);
    expect(peaks.delegators).toBeLessThanOrEqual(2);
    expect(peaks.writers).toBeLessThanOrEqual(1);
    expect(peaks.childrenOfOrchestrator).toBeLessThanOrEqual(2);
    expect(peaks.childrenOfDelegator).toBeLessThanOrEqual(2);
    // The limits were reached, so the turns did run together.
    expect(peaks.executors).toBeGreaterThanOrEqual(2);
    expect(peaks.delegators).toBe(2);
  });

  // The seed scripts a rejection, an escalation and a stalled attempt, which its timeout ends and the rework relaunches.
  // The timeout must end the one stalled attempt and no other: every other fake turn takes a few milliseconds of drawn
  // time, but under the load of the full suite (every package's tests in parallel, SQLite writes waiting on the disk) a
  // healthy turn has been seen to take more than 400 ms from claim to close, time out, and relaunch once more. 2 s keeps
  // a margin of two orders of magnitude over a healthy turn and still ends the stall early in a test of several seconds;
  // the assertions below stay exact (one failed_retry), so a turn that really hangs or retries twice still fails it.
  it("drains a larger queue within the default limits, with no deadlock", async () => {
    const store = open();
    startWorkflow(store, "Many steps [fake:parts=4] [fake:steps=8] [fake:seed=3]");
    const limits = { ...DEFAULT_DELEGATION_LIMITS, attemptTimeoutMs: 2_000 };
    const { peaks } = await run(store, { msPerMinute: 2, limits });
    const { workflow, view } = onlyWorkflow(store);
    expect(workflow.state).toBe("completed");
    expect(view.tasks.filter((task) => task.role === "executor").length).toBeGreaterThanOrEqual(32);
    expect(peaks.executors).toBeLessThanOrEqual(DEFAULT_DELEGATION_LIMITS.maxConcurrent.executors);
    expect(peaks.auditors).toBeLessThanOrEqual(DEFAULT_DELEGATION_LIMITS.maxConcurrent.auditors);
    expect(peaks.childrenOfDelegator).toBeLessThanOrEqual(
      DEFAULT_DELEGATION_LIMITS.maxActiveChildren.delegator,
    );
    expect(peaks.writers).toBeLessThanOrEqual(1);
    expect(workflow.agentsCreated).toBeLessThanOrEqual(
      DEFAULT_DELEGATION_LIMITS.maxAgentsPerWorkflow,
    );
    const failures = store.usageLog
      .usage({ workflowId: workflow.workflowId })
      .filter((row) => row.outcome === "failed_retry");
    expect(failures).toHaveLength(1);
  });

  it("relaunches a step its auditor rejected once, and a dependent step waits for the approval", async () => {
    const store = open();
    startWorkflow(
      store,
      "Fix the theme [fake:parts=1] [fake:steps=2] [fake:part-1/step-1=reject-once]",
    );
    await run(store);
    const { workflow, view, threads } = onlyWorkflow(store);
    expect(workflow.state).toBe("completed");
    const step1 = threads.get("part-1/step-1") ?? [];
    expect(step1).toHaveLength(2);
    for (const executorId of step1) {
      const executor = view.task(executorId);
      const auditor = view.auditorOf(executorId);
      expect(auditor?.parentTaskId).toBe(executor?.parentTaskId);
      expect(auditor?.auditedTaskId).toBe(executorId);
      expect(auditor?.dependsOn).toContainEqual({ taskId: executorId, kind: "completed" });
    }
    expect(view.audits.filter((audit) => step1.includes(audit.subjectTaskId ?? ""))).toEqual([
      expect.objectContaining({ verdict: "rejected", reworkAction: "retry" }),
      expect.objectContaining({ verdict: "approved", reworkAction: "accept" }),
    ]);
    const thread = view.task(step1[0] as string)?.threadId as string;
    expect(view.rework(thread, DEFAULT_DELEGATION_LIMITS)).toEqual({
      phase: "approved",
      retries: 1,
      escalations: 0,
    });
    // step-2 shares step-1's file: it waited for step-1's approval, not only for its first attempt.
    const approvedAt = view.audits.find(
      (audit) => audit.verdict === "approved" && step1.includes(audit.subjectTaskId ?? ""),
    )?.createdAt as number;
    const step2 = view.task((threads.get("part-1/step-2") ?? [])[0] as string);
    expect(step2?.attempt).toBe(1);
    const claimed = store.events
      .list({ taskId: step2?.taskId as string })
      .find((event) => event.type === "task.claimed");
    expect(claimed?.ts).toBeGreaterThanOrEqual(approvedAt);
    const executorRetries = store.usageLog
      .usage({ workflowId: workflow.workflowId })
      .filter((row) => row.role === "executor")
      .reduce((sum, row) => sum + (row.retries ?? 0), 0);
    expect(executorRetries).toBe(1);
  });

  it("escalates a step rejected twice; the delegator reformulates it and reassigns the step it blocked", async () => {
    const store = open();
    startWorkflow(
      store,
      "Fix the theme [fake:parts=1] [fake:steps=2] [fake:part-1/step-1=reject-twice]",
    );
    await run(store);
    const { workflow, view, threads } = onlyWorkflow(store);
    expect(workflow.state).toBe("completed");
    const step1 = threads.get("part-1/step-1") ?? [];
    expect(step1).toHaveLength(3);
    expect(
      view.audits
        .filter((audit) => step1.includes(audit.subjectTaskId ?? ""))
        .map((audit) => [audit.verdict, audit.reworkAction]),
    ).toEqual([
      ["rejected", "retry"],
      ["rejected", "escalate"],
      ["approved", "accept"],
    ]);
    const thread = view.task(step1[0] as string)?.threadId as string;
    expect(view.rework(thread, DEFAULT_DELEGATION_LIMITS)).toEqual({
      phase: "approved",
      retries: 1,
      escalations: 1,
    });
    // step-2 waited for step-1's approval; the escalation blocked it before it ran, and the reformulation reassigned it.
    const step2 = (threads.get("part-1/step-2") ?? []).map((id) => view.task(id));
    expect(step2.map((task) => [task?.state, task?.attempt])).toEqual([
      ["blocked", 0],
      ["completed", 1],
    ]);
    // The delegator ran three turns: the plan, the reformulation, the report.
    expect(threads.get("part-1")).toHaveLength(3);
  });

  it("runs a parent's continuation after a child failed, and fails the workflow when the final audit rejects it", async () => {
    const limits: DelegationLimits = {
      ...DEFAULT_DELEGATION_LIMITS,
      maxAuditRetries: 0,
      maxEscalationsPerTask: 0,
    };
    const store = open();
    startWorkflow(
      store,
      "Fragile work [fake:parts=2] [fake:steps=1] [fake:part-1/step-1=reject-once]",
    );
    await run(store, { limits });
    const { workflow, view, threads } = onlyWorkflow(store);
    // part-1's step failed for good; part-1 still ran its continuation and reported partial or failed.
    const step = view.task((threads.get("part-1/step-1") ?? [])[0] as string) as NonNullable<
      ReturnType<WorkflowView["task"]>
    >;
    expect(view.rework(step.threadId, limits).phase).toBe("failed");
    const part1 = (threads.get("part-1") ?? []).map((id) => view.task(id));
    expect(part1).toHaveLength(2);
    expect(part1[1]?.state).toBe("failed");
    expect(view.reportOf(part1[1]?.threadId as string)?.status).toBe("failed");
    // The orchestrator's continuation ran after the failed part, asked for the final audit, which rejected the work.
    expect(threads.get("orchestrator")).toHaveLength(2);
    expect(view.finalAudit()?.verdict).toBe("rejected");
    expect(workflow).toMatchObject({ state: "failed", stopReason: "final_audit_rejected" });
  });

  it("stops after the first plan by default, and runs on once the human continues it", async () => {
    const store = open();
    startWorkflow(store, "Careful work [fake:parts=2] [fake:steps=1]", {
      mode: "stops",
      stops: ["after_plan"],
    });
    const first = await run(store);
    const paused = onlyWorkflow(store);
    expect(paused.workflow).toMatchObject({ state: "awaiting_human", stopReason: "after_plan" });
    expect(
      paused.view.tasks
        .filter((task) => task.role === "delegator")
        .every((task) => task.attempt === 0),
    ).toBe(true);
    expect(first.events).toContainEqual({
      type: "workflow.state",
      workflowId: paused.workflow.workflowId,
      state: "awaiting_human",
      reason: "after_plan",
    });
    store.commands.enqueue({
      type: "workflow.continue",
      projectId: paused.workflow.projectId,
      args: { workflowId: paused.workflow.workflowId },
      idempotencyKey: "continue-1",
      requestHash: "continue-1",
    });
    await run(store);
    expect(onlyWorkflow(store).workflow.state).toBe("completed");
  });

  // Feature haril-factory, F0: the "the plan ran and now it just sits there" report. This documents today's behavior,
  // it does not endorse it: the default stop is reached on purpose, and nothing failed.
  it("documents the stuck look: the default after_plan stop parks the plan's children and only the event log names it", async () => {
    const store = open();
    startWorkflow(store, "Careful work [fake:parts=2] [fake:steps=1]", {
      mode: DEFAULT_AUTONOMY.mode,
      stops: [...DEFAULT_AUTONOMY.stops],
    });
    await run(store);

    // The cause: the store says why it stopped. It is neither no_capacity nor a failed dependency.
    const { workflow, view } = onlyWorkflow(store);
    expect(workflow).toMatchObject({ state: "awaiting_human", stopReason: "after_plan" });
    const children = view.tasks.filter((task) => task.role === "delegator");
    expect(children.map((task) => ({ state: task.state, attempt: task.attempt }))).toEqual([
      { state: "ready", attempt: 0 },
      { state: "ready", attempt: 0 },
    ]);
    expect(view.tasks.some((task) => task.state === "failed" || task.state === "blocked")).toBe(
      false,
    );

    // What the user sees: the children queued, and the orchestrator waiting for those same children, which looks like
    // a deadlock. The queue also counts the orchestrator's own pending continuation.
    const snapshot = buildWorkflowSnapshot(store, workflow.workflowId, { now: Date.now() });
    expect(snapshot.workflow.state).toBe("awaiting_human");
    expect(snapshot.totals.queued).toBe(3);
    expect(snapshot.nodes.map((node) => [node.id, node.state, node.waitingReason])).toEqual([
      ["o1", "waiting", "waits for its children"],
      ["d1", "queued", "waits until the workflow continues"],
      ["d2", "queued", "waits until the workflow continues"],
    ]);

    // The gap: the stop reached is only an event line. The workflow header lists the stops it may reach, not the one it
    // reached, and no node names the stop or the way out (haril workflow continue). F2 (explainWait) closes this.
    expect(snapshot.events.at(-1)).toMatchObject({
      type: "workflow.awaiting_human",
      text: "reason=after_plan",
    });
    expect(snapshot.workflow).not.toHaveProperty("stopReason");
    expect(JSON.stringify(snapshot.nodes)).not.toContain("after_plan");
    expect(JSON.stringify(snapshot)).not.toContain("haril workflow continue");
  });

  it("continues after a crash in the middle of the workflow with no work done twice and its rework counts kept", async () => {
    const goal = "Survive a crash [fake:parts=2] [fake:steps=2] [fake:part-2/step-1=reject-once]";
    const crashed = open((pid) => pid !== 4242);
    startWorkflow(crashed, goal);
    // The runtime dies right after the commit that recorded the first relaunch, with other turns in flight.
    let dead = false;
    const dying = (store: Store): Store =>
      new Proxy(store, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (dead) {
            if (typeof value === "function") {
              return () => {
                throw new Error("the runtime process died");
              };
            }
            if (typeof value === "object" && value !== null) {
              return new Proxy(value, {
                get: () => () => {
                  throw new Error("the runtime process died");
                },
              });
            }
          }
          if (property === "transaction") {
            return <T>(work: () => T): T => {
              const out = target.transaction(work);
              const retried = target.workflows
                .list()
                .some((workflow) =>
                  target.workflows
                    .audits(workflow.workflowId)
                    .some((audit) => audit.reworkAction === "retry"),
                );
              if (retried) dead = true;
              return out;
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    await expect(run(crashed, { wrap: dying, pid: 4242, msPerMinute: 4 })).rejects.toThrow(/died/);
    const before = onlyWorkflow(crashed);
    expect(before.workflow.state).toBe("running");
    expect(before.view.tasks.some((task) => task.state === "running")).toBe(true);
    const retriedThread = before.view.audits.find((audit) => audit.reworkAction === "retry");
    expect(retriedThread).toBeDefined();

    const restarted = open((pid) => pid !== 4242);
    const { events } = await run(restarted);
    expect(events.some((event) => event.type === "task.recovered")).toBe(true);
    const { workflow, view, threads } = onlyWorkflow(restarted);
    expect(workflow.state).toBe("completed");
    // One relaunch for the rejected step, no duplicate turn, delegation or verdict anywhere.
    expect(threads.get("part-2/step-1")).toHaveLength(2);
    for (const label of ["part-1/step-1", "part-1/step-2", "part-2/step-2"]) {
      expect(threads.get(label), label).toHaveLength(1);
    }
    expect(threads.get("part-1")).toHaveLength(2);
    expect(threads.get("part-2")).toHaveLength(2);
    expect(threads.get("orchestrator")).toHaveLength(2);
    expect(view.delegations).toHaveLength(4);
    const auditors = view.audits.map((audit) => audit.auditorTaskId);
    expect(new Set(auditors).size).toBe(auditors.length);
    const step = view.task((threads.get("part-2/step-1") ?? [])[0] as string);
    expect(view.rework(step?.threadId as string, DEFAULT_DELEGATION_LIMITS)).toEqual({
      phase: "approved",
      retries: 1,
      escalations: 0,
    });
    const runIds = restarted.usageLog
      .usage({ workflowId: workflow.workflowId })
      .map((row) => row.runId);
    expect(new Set(runIds).size).toBe(runIds.length);
    expect(restarted.usageLog.verify().ok).toBe(true);
  });

  it("leaves standalone tasks in their own lane, one at a time, next to a workflow", async () => {
    const store = open();
    startWorkflow(store, "Side by side [fake:parts=1] [fake:steps=1]");
    const projectId = store.projects.list()[0]?.projectId as string;
    for (const goal of ["standalone A", "standalone B"]) {
      store.commands.enqueue({
        type: "task.create",
        projectId,
        args: { goal, dependsOn: [], agent: "fake:slow:30", maxAttempts: 1, timeoutMs: 5_000 },
        idempotencyKey: goal,
        requestHash: goal,
      });
    }
    const { events } = await run(store);
    expect(onlyWorkflow(store).workflow.state).toBe("completed");
    const standalone = store.tasks.list().filter((task) => task.goal.startsWith("standalone"));
    expect(standalone.map((task) => task.state)).toEqual(["completed", "completed"]);
    // The second standalone task was claimed only after the first completed.
    const order = events
      .filter(
        (event) =>
          (event.type === "task.claimed" || event.type === "task.completed") &&
          event.goal.startsWith("standalone"),
      )
      .map((event) => `${event.type} ${"goal" in event ? event.goal : ""}`);
    expect(order).toEqual([
      "task.claimed standalone A",
      "task.completed standalone A",
      "task.claimed standalone B",
      "task.completed standalone B",
    ]);
  });
});
