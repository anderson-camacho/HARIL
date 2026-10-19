import type { ClaimedTask, Store } from "@haril/core/ports";
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

// The emergency stop at the store (docs/modos-y-delegacion.md 3.14): runtime.stop {mode: "now"} halts the runtime,
// stops every workflow, cancels their turns and the running standalone tasks, and ends each cancelled run's keys and
// open reservations, all in the command's transaction. runtime.resume lifts the halt; workflow.stop stops one workflow;
// tasks.cancel and runs.cancel cancel one task. The runs' recorded processes and their activity are read back for the
// startup sweep and the watchdog (3.16).

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
  epoch = acquire();
});

afterEach(() => {
  store.close();
});

function acquire(): number {
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.21.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  return grant.value.epoch;
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

function command(type: string, args: Record<string, unknown>, project: string | null = projectId) {
  store.commands.enqueue({
    type,
    ...(project === null ? {} : { projectId: project }),
    args,
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  const applied = store.commands.applyNext(epoch);
  if (applied === undefined) throw new Error("nothing applied");
  return applied;
}

function startWorkflow(goal: string): { workflowId: string; rootTaskId: string } {
  const applied = command("workflow.start", {
    goal,
    intake: workflowIntake(TEST_PROJECT_ROOT),
    model: "fake/high-model",
    agent: "fake:orchestrate",
    autonomy: { mode: "autonomous", stops: [] },
    budgetTokens: 50_000,
    timeoutMs: 600_000,
  });
  if (applied.workflowId === undefined) throw new Error(`rejected: ${applied.reason}`);
  return { workflowId: applied.workflowId, rootTaskId: applied.taskIds[0] as string };
}

function addTask(goal: string): string {
  const applied = command("task.create", {
    goal,
    dependsOn: [],
    agent: "fake:slow:60000",
    maxAttempts: 2,
    timeoutMs: 120_000,
  });
  return applied.taskIds[0] as string;
}

function claim(taskId: string): ClaimedTask {
  const claimed = store.tasks.claimTask(epoch, taskId);
  if (claimed === undefined) throw new Error(`could not claim ${taskId}`);
  return claimed;
}

// A delegator turn pending on an executor turn, both under the workflow's root: a tree with every live state.
function grow(workflowId: string, rootTaskId: string) {
  const result = store.workflows.applyTurns(epoch, {
    workflowId,
    turns: [
      {
        key: "exec",
        threadId: null,
        role: "executor",
        layer: 3,
        kind: "work",
        parentTaskId: rootTaskId,
        localId: "e1",
        goal: "Read the notes",
        description: "",
        agentRef: "fake:execute",
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
      },
      {
        key: "audit",
        threadId: null,
        role: "auditor",
        layer: 3,
        kind: "verify",
        parentTaskId: "exec",
        localId: null,
        goal: "Review e1",
        description: "",
        agentRef: "fake:audit",
        model: "fake/high-model",
        modelPinned: false,
        difficulty: null,
        difficultyReason: null,
        priority: 5,
        budgetTokens: 1000,
        timeoutMs: 60_000,
        surfaceWrite: [],
        surfaceRead: [],
        dependsOn: [{ on: "exec", kind: "completed" }],
      },
    ],
  });
  return { executor: result.taskIds.exec as string, auditor: result.taskIds.audit as string };
}

// One open model call of a run: the Broker's reservation on the project and task budgets.
function openReservation(claimed: ClaimedTask, amount = 4000): string[] {
  const project = store.budgets.ensure({
    scopeType: "project",
    scopeId: projectId,
    projectId,
    hardLimit: 1_000_000,
  });
  const task = store.budgets.ensure({
    scopeType: "task",
    scopeId: claimed.taskId,
    projectId,
    hardLimit: 100_000,
  });
  const reserved = store.budgets.reserve({
    budgetIds: [project.budgetId, task.budgetId],
    amount,
    idempotencyKey: `reserve-${claimed.runId}-${++keySeq}`,
    runId: claimed.runId,
    taskId: claimed.taskId,
    routeId: "route-1",
  });
  if (!reserved.ok) throw new Error("reservation refused");
  return [project.budgetId, task.budgetId, reserved.reservationId];
}

function stateOf(taskId: string): string | undefined {
  return store.tasks.get(taskId)?.state;
}

function eventTypes(): string[] {
  return store.events.list().map((event) => event.type);
}

describe("runtime.stop {mode: now}: the emergency stop", () => {
  it("halts the runtime, stops every workflow, cancels their turns and the running standalone tasks, and settles their reservations", () => {
    const first = startWorkflow("Ship the button");
    const second = startWorkflow("Write the tests");
    const root = claim(first.rootTaskId);
    const tree = grow(first.workflowId, first.rootTaskId);
    const running = addTask("Slow standalone");
    const waiting = addTask("Waiting standalone");
    const standalone = claim(running);
    const [projectBudget, taskBudget, reservationId] = openReservation(standalone);
    store.virtualKeys.issue({
      runId: standalone.runId,
      keyHash: "f".repeat(64),
      routeGrant: {},
      budgetIds: [projectBudget as string, taskBudget as string],
      expiresAt: clock.now() + 60_000,
    });
    openReservation(root, 3000);

    const applied = command("runtime.stop", { mode: "now" }, null);

    expect(applied.outcome).toBe("applied");
    expect(applied.args).toEqual({ mode: "now" });
    expect(new Set(applied.workflowIds)).toEqual(new Set([first.workflowId, second.workflowId]));
    expect(new Set(applied.taskIds)).toEqual(
      new Set([first.rootTaskId, tree.executor, tree.auditor, second.rootTaskId, running]),
    );
    expect(store.runtime.haltState()).toEqual({ halted: true, since: clock.now() });
    for (const workflowId of [first.workflowId, second.workflowId]) {
      expect(store.workflows.get(workflowId)).toMatchObject({
        state: "stopped",
        stopReason: "user_stop",
        endedAt: clock.now(),
      });
    }
    for (const taskId of [first.rootTaskId, tree.executor, tree.auditor, second.rootTaskId]) {
      expect(stateOf(taskId), taskId).toBe("cancelled");
    }
    // A running standalone task is cancelled with its run; a waiting one keeps waiting.
    expect(stateOf(running)).toBe("cancelled");
    expect(stateOf(waiting)).toBe("ready");
    expect(store.metrics.snapshot().runsByStatus).toMatchObject({ cancelled: 2 });
    // Its open reservations are settled at their upper bound and its key is revoked.
    expect(store.budgets.get(projectBudget as string)).toMatchObject({ reserved: 0, spent: 7000 });
    expect(store.budgets.get(taskBudget as string)).toMatchObject({ reserved: 0, spent: 4000 });
    expect(store.budgets.release(reservationId as string)).toBe("already_settled");
    expect(store.virtualKeys.findActiveByHash("f".repeat(64))).toBeUndefined();
    // Every cancellation is an event with its reason, and so is the stop.
    const cancelled = store.events.list().filter((event) => event.type === "task.cancelled");
    expect(cancelled).toHaveLength(5);
    expect(cancelled.every((event) => event.payload.reason === "user_stop")).toBe(true);
    expect(eventTypes()).toEqual(
      expect.arrayContaining(["workflow.stopped", "stop.requested", "runtime.halted"]),
    );
  });

  it("claims nothing while halted, and a second stop changes nothing", () => {
    startWorkflow("Ship the button");
    const waiting = addTask("Waiting standalone");
    command("runtime.stop", { mode: "now" }, null);

    expect(store.tasks.claimNext(epoch)).toBeUndefined();
    expect(store.tasks.claimTask(epoch, waiting)).toBeUndefined();
    const before = store.events.list().length;
    const again = command("runtime.stop", { mode: "now" }, null);
    expect(again).toMatchObject({ outcome: "applied", taskIds: [], workflowIds: [] });
    expect(store.runtime.haltState().halted).toBe(true);
    // Only the command's own events: no task, workflow or halt event repeats.
    const added = store.events
      .list()
      .slice(before)
      .map((event) => event.type);
    expect(added).toEqual(["stop.requested", "command.applied"]);
  });

  it("is read back by the CLI with its status, the tasks it cancelled and the workflows it stopped", () => {
    const { workflowId, rootTaskId } = startWorkflow("Ship the button");
    store.commands.enqueue({
      type: "runtime.stop",
      args: { mode: "now" },
      idempotencyKey: "stop-now",
      requestHash: "stop-now",
    });
    const queued = store.commands.listQueued()[0];
    if (queued === undefined) throw new Error("not queued");
    expect(store.commands.get(queued.commandId)).toMatchObject({
      type: "runtime.stop",
      status: "queued",
      taskIds: [],
      appliedAt: null,
    });
    store.commands.applyNext(epoch);
    expect(store.commands.get(queued.commandId)).toEqual({
      commandId: queued.commandId,
      type: "runtime.stop",
      status: "applied",
      taskIds: [rootTaskId],
      workflowIds: [workflowId],
      reason: null,
      appliedAt: clock.now(),
    });
    expect(store.commands.get("no-such-command")).toBeUndefined();
  });

  it("rejects a mode it does not know", () => {
    expect(command("runtime.stop", { mode: "later" }, null)).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("runtime.stop"),
    });
    expect(store.runtime.haltState().halted).toBe(false);
  });
});

describe("runtime.resume", () => {
  it("lifts the halt: waiting standalone tasks run again, cancelled work stays cancelled", () => {
    const { rootTaskId } = startWorkflow("Ship the button");
    const waiting = addTask("Waiting standalone");
    command("runtime.stop", { mode: "now" }, null);

    expect(command("runtime.resume", {}, null)).toMatchObject({ outcome: "applied" });
    expect(store.runtime.haltState()).toEqual({ halted: false, since: null });
    expect(stateOf(rootTaskId)).toBe("cancelled");
    expect(store.tasks.claimNext(epoch)?.taskId).toBe(waiting);
    expect(eventTypes()).toContain("runtime.resumed");
  });

  it("changes nothing when the runtime is not halted, and takes no arguments", () => {
    expect(command("runtime.resume", {}, null)).toMatchObject({ outcome: "applied" });
    expect(eventTypes()).not.toContain("runtime.resumed");
    expect(command("runtime.resume", { force: true }, null)).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("runtime.resume"),
    });
  });
});

describe("workflow.stop", () => {
  it("stops one workflow and cancels its turns only; repeating it is harmless", () => {
    const target = startWorkflow("Ship the button");
    const other = startWorkflow("Write the tests");
    claim(target.rootTaskId);
    const tree = grow(target.workflowId, target.rootTaskId);
    const otherRun = claim(other.rootTaskId);

    const applied = command("workflow.stop", { workflowId: target.workflowId });
    expect(applied).toMatchObject({
      outcome: "applied",
      workflowId: target.workflowId,
      workflowIds: [target.workflowId],
    });
    expect(new Set(applied.taskIds)).toEqual(
      new Set([target.rootTaskId, tree.executor, tree.auditor]),
    );
    expect(store.workflows.get(target.workflowId)).toMatchObject({
      state: "stopped",
      stopReason: "user_stop",
    });
    expect(store.workflows.get(other.workflowId)?.state).toBe("running");
    expect(stateOf(other.rootTaskId)).toBe("running");
    expect(store.runtime.haltState().halted).toBe(false);
    // The other workflow's run goes on: it can still complete.
    expect(
      store.runs.complete({
        runId: otherRun.runId,
        outcome: "succeeded",
        result: { summary: "ok" },
      }).taskState,
    ).toBe("completed");

    expect(command("workflow.stop", { workflowId: target.workflowId })).toMatchObject({
      outcome: "applied",
      taskIds: [],
      workflowIds: [],
    });
  });

  it("rejects a workflow of another project or none", () => {
    expect(command("workflow.stop", { workflowId: "nope" })).toMatchObject({
      outcome: "rejected",
      reason: expect.stringContaining("nope"),
    });
    expect(command("workflow.stop", {})).toMatchObject({ outcome: "rejected" });
  });
});

describe("tasks.cancel and runs.cancel", () => {
  it("cancels a waiting task and a running one with its run, once; a task that ended is left alone", () => {
    const { workflowId, rootTaskId } = startWorkflow("Ship the button");
    const root = claim(rootTaskId);
    const tree = grow(workflowId, rootTaskId);

    expect(store.tasks.cancel(epoch, tree.auditor, "residual")).toEqual({
      taskId: tree.auditor,
      projectId,
      goal: "Review e1",
      workflowId,
      from: "pending",
      runId: null,
    });
    expect(store.tasks.cancel(epoch, rootTaskId, "residual")).toMatchObject({
      from: "running",
      runId: root.runId,
    });
    expect(stateOf(rootTaskId)).toBe("cancelled");
    expect(store.tasks.cancel(epoch, rootTaskId, "residual")).toBeUndefined();
    const reasons = store.events
      .list()
      .filter((event) => event.type === "task.cancelled")
      .map((event) => event.payload.reason);
    expect(reasons).toEqual(["residual", "residual"]);
    // The run closed with the cancellation: completing it now is stale.
    expect(
      caught(() =>
        store.runs.complete({
          runId: root.runId,
          outcome: "succeeded",
          result: { summary: "late" },
        }),
      ).code,
    ).toBe("store.stale");
  });

  it("is fenced by the runtime epoch", () => {
    const { rootTaskId } = startWorkflow("Ship the button");
    store.runtime.release(epoch, true);
    expect(caught(() => store.tasks.cancel(epoch, rootTaskId, "user_stop")).code).toBe(
      "store.fenced",
    );
  });

  it("runs.cancel with user_stop cancels the task and settles the run's reservations, without a retry", () => {
    const taskId = addTask("Slow standalone");
    const claimed = claim(taskId);
    const [projectBudget] = openReservation(claimed);

    expect(store.runs.cancel(claimed.runId, "user_stop")).toMatchObject({
      taskId,
      taskState: "cancelled",
      attemptsUsed: 0,
    });
    expect(store.tasks.get(taskId)).toMatchObject({ state: "cancelled", attemptsUsed: 0 });
    expect(store.budgets.get(projectBudget as string)).toMatchObject({ reserved: 0, spent: 4000 });
    expect(caught(() => store.runs.cancel(claimed.runId, "user_stop")).code).toBe("store.stale");
  });
});

describe("recorded processes and run activity", () => {
  it("records a running run's process and lists the open runs a dead runtime left", () => {
    const taskId = addTask("Slow standalone");
    const claimed = claim(taskId);
    store.runs.recordProcess(epoch, claimed.runId, { pid: 4242, startedAt: clock.now() - 5 });

    const own = {
      runId: claimed.runId,
      taskId,
      projectId,
      runtimeEpoch: epoch,
      runStatus: "running",
      pid: 4242,
      startedAt: clock.now() - 5,
      boot: null,
    };
    expect(store.runs.processes()).toEqual([own]);
    // The same run is not an orphan of this epoch, but it is of the next runtime's.
    expect(store.runs.processes({ excludeEpoch: epoch })).toEqual([]);
    clock.advance(120_000);
    const next = acquire();
    expect(store.runs.processes({ excludeEpoch: next })).toEqual([own]);
  });

  it("keeps a Linux process's boot ticks with its run, so a later check compares them instead of wall clocks", () => {
    const claimed = claim(addTask("Linux agent"));
    const boot = { bootId: "0f1e2d3c-test-boot", ticks: 987_654 };
    store.runs.recordProcess(epoch, claimed.runId, { pid: 4343, startedAt: clock.now(), boot });
    expect(store.runs.processes()).toMatchObject([{ runId: claimed.runId, pid: 4343, boot }]);
  });

  it("lists a run a stop just cancelled while its process may still be dying", () => {
    const taskId = addTask("Slow standalone");
    const claimed = claim(taskId);
    store.runs.recordProcess(epoch, claimed.runId, { pid: 77, startedAt: clock.now() });
    clock.advance(1000);
    const stopAt = clock.now();
    command("runtime.stop", { mode: "now" }, null);

    expect(store.runs.processes()).toEqual([]);
    expect(store.runs.processes({ endedSince: stopAt })).toMatchObject([
      { runId: claimed.runId, pid: 77, runStatus: "cancelled" },
    ]);
    expect(store.runs.processes({ endedSince: stopAt + 1 })).toEqual([]);
  });

  it("keeps listing every run with a recorded process, open or ended, until its process is verified gone", () => {
    const stopped = claim(addTask("Stopped long ago"));
    store.runs.recordProcess(epoch, stopped.runId, { pid: 77, startedAt: clock.now() });
    const live = claim(addTask("Still running"));
    store.runs.recordProcess(epoch, live.runId, { pid: 78, startedAt: clock.now() });
    startWorkflow("Unrelated");
    store.runs.cancel(stopped.runId, "user_stop");
    // An hour later the stop's kill may have failed: the cancelled run still names a process nobody verified.
    clock.advance(3_600_000);

    const unverified = () => store.runs.processes({ unverified: true }).map((item) => item.runId);
    expect(unverified()).toEqual([stopped.runId, live.runId]);
    // The runtime's own open runs are left out of its startup sweep; its closed ones are not.
    expect(
      store.runs.processes({ unverified: true, excludeEpoch: epoch }).map((item) => item.runId),
    ).toEqual([stopped.runId]);

    // A mark names the process it verified: a mismatch marks nothing.
    expect(
      store.runs.markProcessesGone([{ runId: stopped.runId, pid: 99, startedAt: 0 }], clock.now()),
    ).toBe(0);
    expect(unverified()).toEqual([stopped.runId, live.runId]);
    expect(
      store.runs.markProcessesGone(
        [{ runId: stopped.runId, pid: 77, startedAt: 12_345 }],
        clock.now(),
      ),
    ).toBe(0);
    const record = store.runs.processes({ unverified: true })[0];
    if (record === undefined) throw new Error("no record");
    expect(store.runs.markProcessesGone([record], clock.now())).toBe(1);
    expect(unverified()).toEqual([live.runId]);
    // Marking it again changes nothing, and the open run stays listed as before.
    expect(store.runs.markProcessesGone([record], clock.now())).toBe(0);
    expect(store.runs.processes().map((item) => item.runId)).toEqual([live.runId]);
  });

  it("records the commands a run started next to its agent, lists both and marks each gone on its own", () => {
    const claimed = claim(addTask("Runs the tests"));
    store.runs.recordProcess(epoch, claimed.runId, { pid: 500, startedAt: clock.now() });
    store.runs.recordCommand(epoch, claimed.runId, { pid: 501, startedAt: clock.now() + 1 });
    store.runs.recordCommand(epoch, claimed.runId, { pid: 502, startedAt: clock.now() + 2 });
    const pids = (filter?: Parameters<typeof store.runs.processes>[0]) =>
      store.runs.processes(filter).map((item) => item.pid);
    expect(pids()).toEqual([500, 501, 502]);
    expect(store.runs.processes()[1]).toMatchObject({
      runId: claimed.runId,
      runStatus: "running",
      pid: 501,
    });
    expect(
      store.runs.markProcessesGone(
        [{ runId: claimed.runId, pid: 501, startedAt: clock.now() + 1 }],
        clock.now(),
      ),
    ).toBe(1);
    expect(pids({ unverified: true })).toEqual([500, 502]);
    // A dead runtime's commands are orphans of the next one, like its agents.
    clock.advance(120_000);
    const next = acquire();
    expect(pids({ unverified: true, excludeEpoch: next })).toEqual([500, 502]);
    expect(
      caught(() => store.runs.recordCommand(epoch, claimed.runId, { pid: 1, startedAt: 1 })).code,
    ).toBe("store.fenced");
  });

  it("refuses to record a process under another epoch", () => {
    const claimed = claim(addTask("Slow standalone"));
    store.runtime.release(epoch, true);
    expect(
      caught(() => store.runs.recordProcess(epoch, claimed.runId, { pid: 1, startedAt: 1 })).code,
    ).toBe("store.fenced");
  });

  it("reports a run's tokens since a time, its open model calls and its newest tool call", () => {
    const claimed = claim(addTask("Slow standalone"));
    const since = clock.now();
    expect(store.runs.activity(claimed.runId, since)).toEqual({
      tokens: 0,
      openRequests: 0,
      lastToolCallAt: null,
    });

    clock.advance(1000);
    const [, , settled] = openReservation(claimed);
    store.budgets.commit({
      reservationId: settled as string,
      usage: { inputTokens: 120, outputTokens: 30 },
      upperBound: 4000,
      modelRequested: "m",
      modelServed: "m",
    });
    openReservation(claimed);
    store.events.append({
      aggregateType: "run",
      aggregateId: claimed.runId,
      type: "tool.read",
      actorKind: "system",
      actorId: "runtime",
      payload: { outcome: "ok" },
      runId: claimed.runId,
    });

    expect(store.runs.activity(claimed.runId, since)).toEqual({
      tokens: 150,
      openRequests: 1,
      lastToolCallAt: clock.now(),
    });
    expect(store.runs.activity(claimed.runId, clock.now()).tokens).toBe(0);
  });
});
