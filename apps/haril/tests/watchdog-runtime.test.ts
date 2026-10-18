import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationLimits,
  type RunEvent,
} from "@haril/core";
import type { AgentRuntime, Clock, EventRecord, Store, WorkflowAutonomy } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { makeSandbox, type Sandbox } from "./helpers.js";
import { until } from "./process-helpers.js";

// The 15-minute watchdog in the runtime (docs/modos-y-delegacion.md 3.16, reading L2), on virtual time: the clock the
// loop and the store read is moved by the test, so a 15-minute window passes at once. Code asks, never a model: an
// attempt without progress is closed at its first check and counts as a failed attempt (the rework relaunches it); one
// that shows progress continues and is checked again 15 minutes later; a turn waiting for capacity is never closed;
// and the turns of a workflow that ended (the wall-time backstop) are cancelled at once as residual.

const MINUTE = 60_000;
const WINDOW = 15 * MINUTE;
let offset = 0;
const clock: Clock = {
  now: () => Date.now() + offset,
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
  offset = 0;
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
    rules,
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

function startWorkflow(store: Store, goal: string, limits: Partial<DelegationLimits> = {}): void {
  const projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: sb.root,
  }).projectId;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      goal,
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy: AUTONOMOUS,
      limits,
      budgetTokens: 200_000,
      // The fake turns' own timeouts are real time: far beyond the test, so only the watchdog ends a stalled one.
      timeoutMs: 3_600_000,
    },
    idempotencyKey: "wf-1",
    requestHash: "wf-1",
  });
}

// idleExitMs 0 is haril run: it exits once nothing is claimable. A test whose turns only wait stays up like haril start.
function run(
  store: Store,
  idleExitMs = 0,
  wrap: (agents: AgentRuntime) => AgentRuntime = (agents) => agents,
) {
  const events: RunEvent[] = [];
  const tools = createDelegationTools({ store, clock, options: {} });
  const agents = new FakeAgentRuntime({
    clock,
    delegationTools: tools.call,
    delegationDelayMs: () => 1,
  });
  const done = runUntilIdle({
    store,
    agentRuntime: wrap(agents),
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: (event) => events.push(event),
    idleExitMs,
    pollMs: 10,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation: {},
    watchdog: { intervalMs: WINDOW },
  });
  return { events, done };
}

// Agents whose process takes a while to die once killed, as a real Pi does while taskkill runs.
function slowToDie(delayMs: number): (agents: AgentRuntime) => AgentRuntime {
  return (agents) => ({
    async start(spec) {
      const started = await agents.start(spec);
      if (!started.ok) return started;
      const handle = started.value;
      const later = async (): Promise<void> => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await handle.abort();
      };
      return {
        ok: true,
        value: {
          runId: handle.runId,
          hello: handle.hello,
          settled: handle.settled,
          prompt: (text) => handle.prompt(text),
          abort: later,
          kill: later,
          dispose: () => handle.dispose(),
        },
      };
    },
  });
}

function workflowOf(store: Store) {
  const [workflow] = store.workflows.list();
  if (workflow === undefined) throw new Error("no workflow");
  return workflow;
}

// The workflow's executor turns, none before the runtime applied workflow.start.
function executors(store: Store) {
  const [workflow] = store.workflows.list();
  if (workflow === undefined) return [];
  return store.workflows.tasks(workflow.workflowId).filter((task) => task.role === "executor");
}

function runningExecutor(store: Store) {
  return executors(store).find((task) => task.state === "running");
}

function watchdogEvents(store: Store): EventRecord[] {
  return store.events.list().filter((event) => event.type.startsWith("watchdog."));
}

function runOf(store: Store, taskId: string): string {
  const claimed = store.events
    .list({ taskId })
    .filter((event) => event.type === "task.claimed")
    .pop();
  if (claimed?.runId === undefined) throw new Error(`task ${taskId} was never claimed`);
  return claimed.runId;
}

describe("the watchdog in the runtime", () => {
  it("closes an attempt without progress at its first check; it counts as a failed attempt and its relaunch completes the workflow", async () => {
    const store = open();
    startWorkflow(
      store,
      "Read the notes [fake:parts=1] [fake:steps=1] [fake:part-1/step-1=stall-once]",
    );
    const { events, done } = run(store);
    await until(() => runningExecutor(store) !== undefined, "the executor running");
    offset += WINDOW + 1000;

    expect((await done).kind).toBe("idle");
    expect(workflowOf(store).state).toBe("completed");
    const [stalled, relaunch] = executors(store);
    expect(stalled?.state).toBe("failed");
    expect(store.tasks.get(stalled?.taskId ?? "")?.error?.code).toBe("watchdog.idle");
    expect(relaunch?.state).toBe("completed");
    const usage = store.usageLog.usage({ workflowId: workflowOf(store).workflowId });
    expect(usage.find((row) => row.taskId === stalled?.taskId)?.outcome).toBe("closed_idle");
    const closed = watchdogEvents(store).find((event) => event.type === "watchdog.closed");
    expect(closed?.payload).toMatchObject({
      node: "e1",
      by: "d1",
      verdict: "idle",
      action: "close",
    });
    expect(String(closed?.payload.text)).toMatch(/^e1 closed: no progress/);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "watchdog.checked",
        node: "e1",
        verdict: "idle",
        action: "close",
      }),
    );
  }, 30_000);

  it("judges a closed attempt once: while its process dies, it is neither checked again nor closed twice", async () => {
    const store = open();
    startWorkflow(
      store,
      "Read the notes [fake:parts=1] [fake:steps=1] [fake:part-1/step-1=stall-once]",
    );
    const { done } = run(store, 0, slowToDie(300));
    await until(() => runningExecutor(store) !== undefined, "the executor running");
    const stalled = runningExecutor(store);
    offset += WINDOW + 1000;

    expect((await done).kind).toBe("idle");
    expect(workflowOf(store).state).toBe("completed");
    const verdicts = watchdogEvents(store).filter((event) => event.taskId === stalled?.taskId);
    expect(verdicts.map((event) => [event.type, event.payload.verdict])).toEqual([
      ["watchdog.closed", "idle"],
    ]);
  }, 30_000);

  it("lets an attempt that shows progress continue, checks it again 15 minutes later and closes it then if it stopped", async () => {
    const store = open();
    startWorkflow(
      store,
      "Read the notes [fake:parts=1] [fake:steps=1] [fake:part-1/step-1=stall-once]",
    );
    const { done } = run(store);
    await until(() => runningExecutor(store) !== undefined, "the executor running");
    const executor = runningExecutor(store);
    if (executor === undefined) throw new Error("no executor");
    // Its run calls a tool in the window: progress.
    store.events.append({
      aggregateType: "run",
      aggregateId: runOf(store, executor.taskId),
      type: "tool.read",
      actorKind: "system",
      actorId: "runtime",
      payload: { outcome: "ok" },
      runId: runOf(store, executor.taskId),
    });
    offset += WINDOW + 1000;
    await until(
      () =>
        watchdogEvents(store).some(
          (event) => event.payload.node === "e1" && event.payload.verdict === "active",
        ),
      "the first verdict on e1",
    );
    const active = watchdogEvents(store).find(
      (event) => event.payload.node === "e1" && event.payload.verdict === "active",
    );
    expect(String(active?.payload.text)).toMatch(/^e1 active, continues: tool_call/);
    expect(Number(active?.payload.nextCheckAt) - Number(active?.payload.checkedAt)).toBe(WINDOW);
    expect(
      store.workflows
        .tasks(workflowOf(store).workflowId)
        .find((task) => task.taskId === executor.taskId),
    ).toMatchObject({ state: "running", nextCheckAt: active?.payload.nextCheckAt });

    // Fifteen more minutes without progress: closed at the second check.
    offset += WINDOW + 1000;
    expect((await done).kind).toBe("idle");
    expect(store.tasks.get(executor.taskId)?.error?.code).toBe("watchdog.idle");
    expect(workflowOf(store).state).toBe("completed");
  }, 30_000);

  it("never closes a turn that waits for capacity; the workflow's wall time ends it and cancels its turns as residual", async () => {
    const store = open();
    startWorkflow(store, "Read the notes [fake:parts=1] [fake:steps=1]", {
      maxConcurrent: { ...DEFAULT_DELEGATION_LIMITS.maxConcurrent, executors: 0 },
      maxWorkflowWallMs: 40 * MINUTE,
    });
    // Nothing is claimable while the executor waits: the runtime stays up for 50 minutes, as haril start would.
    const { events, done } = run(store, 50 * MINUTE);
    // Ready, held back by the capacity limit, and seen by the watchdog, which scheduled its first check.
    await until(
      () => executors(store).some((task) => task.state === "ready" && task.nextCheckAt !== null),
      "the executor ready, held by the capacity limit",
    );
    offset += WINDOW + 1000;
    await until(
      () => watchdogEvents(store).some((event) => event.payload.node === "e1"),
      "the verdict on the waiting executor",
    );
    const waiting = watchdogEvents(store).find((event) => event.payload.node === "e1");
    expect(waiting?.payload).toMatchObject({ verdict: "active", action: "continue" });
    expect(String(waiting?.payload.text)).toContain("waiting for capacity");
    expect(executors(store)[0]?.state).toBe("ready");

    // Past the wall time the workflow fails, and every turn it left is residual.
    offset += 30 * MINUTE;
    await until(() => workflowOf(store).state === "failed", "the wall time");
    await until(() => executors(store)[0]?.state === "cancelled", "the waiting executor cancelled");
    offset += 60 * MINUTE;
    expect((await done).kind).toBe("idle");
    expect(workflowOf(store)).toMatchObject({ state: "failed", stopReason: "wall_time" });
    const turns = store.workflows.tasks(workflowOf(store).workflowId);
    expect(turns.filter((task) => task.state === "ready" || task.state === "pending")).toEqual([]);
    expect(executors(store)[0]?.state).toBe("cancelled");
    const residual = watchdogEvents(store).find(
      (event) => event.payload.node === "e1" && event.payload.verdict === "residual",
    );
    expect(String(residual?.payload.text)).toMatch(/^e1 cancelled: residual/);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.cancelled", reason: "residual" }),
    );
  }, 30_000);

  it("kills a running attempt at once when its workflow ends, as residual, without waiting for its check", async () => {
    const store = open();
    startWorkflow(
      store,
      "Read the notes [fake:parts=1] [fake:steps=1] [fake:part-1/step-1=stall-once]",
      {
        maxWorkflowWallMs: 20 * MINUTE,
      },
    );
    const { done } = run(store);
    await until(() => runningExecutor(store) !== undefined, "the executor running");
    const executor = runningExecutor(store);
    offset += 21 * MINUTE;

    expect((await done).kind).toBe("idle");
    expect(workflowOf(store)).toMatchObject({ state: "failed", stopReason: "wall_time" });
    expect(store.tasks.get(executor?.taskId ?? "")?.state).toBe("cancelled");
    const usage = store.usageLog.usage({ workflowId: workflowOf(store).workflowId });
    expect(usage.find((row) => row.taskId === executor?.taskId)?.outcome).toBe(
      "cancelled_residual",
    );
    expect(watchdogEvents(store).some((event) => event.payload.verdict === "idle")).toBe(false);
  }, 30_000);
});
