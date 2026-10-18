import type { NewTurn, Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import { type ManualClock, manualClock, sequentialIds, testRules } from "./support.js";

// The delegation module of the Store (docs/modos-y-delegacion.md 4.2, 4.3, 4.4): workflow.start and workflow.continue,
// delegation.apply as applyTurns, the auditor verdicts, the workflow states and the settled continuations.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const LIMITS = { maxAgentsPerWorkflow: 100, maxDepth: 3 };

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
    rootPath: "D:/demo",
  }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: "v24.21.0",
    sqliteVersion: "3.53.3",
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  epoch = grant.value.epoch;
});

afterEach(() => {
  store.close();
});

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

function enqueue(type: string, args: Record<string, unknown>) {
  store.commands.enqueue({
    type,
    projectId,
    args,
    idempotencyKey: `k-${++keySeq}`,
    requestHash: `h-${keySeq}`,
  });
  const applied = store.commands.applyNext(epoch);
  if (applied === undefined) throw new Error("nothing applied");
  return applied;
}

function start(change: Record<string, unknown> = {}) {
  const applied = enqueue("workflow.start", {
    goal: "Change the primary button color and test it",
    model: "fake/high-model",
    agent: "fake:orchestrate",
    autonomy: { mode: "autonomous", stops: [] },
    limits: LIMITS,
    budgetTokens: 50_000,
    timeoutMs: 600_000,
    simulated: true,
    ...change,
  });
  if (applied.outcome !== "applied" || applied.workflowId === undefined) {
    throw new Error(`workflow.start rejected: ${applied.reason}`);
  }
  return { workflowId: applied.workflowId, rootTaskId: applied.taskIds[0] as string };
}

function turn(change: Partial<NewTurn> & Pick<NewTurn, "key">): NewTurn {
  return {
    threadId: null,
    role: "delegator",
    layer: 2,
    kind: "plan",
    parentTaskId: null,
    localId: change.key,
    goal: `goal ${change.key}`,
    description: "",
    agentRef: "fake:delegate",
    model: "fake/mid-model",
    modelPinned: false,
    difficulty: "medium",
    difficultyReason: "a few files",
    priority: 5,
    budgetTokens: 20_000,
    timeoutMs: 600_000,
    surfaceWrite: [],
    surfaceRead: [],
    dependsOn: [],
    ...change,
  };
}

function claim(taskId: string): string {
  const others = store.tasks
    .list()
    .filter((task) => task.state === "ready" && task.taskId !== taskId)
    .map((task) => task.taskId);
  const claimed = store.tasks.claimNext(epoch, [], others);
  if (claimed?.taskId !== taskId) throw new Error(`could not claim ${taskId}`);
  return claimed.runId;
}

function eventTypes(): string[] {
  return store.events.list().map((event) => event.type);
}

// The orchestrator's first turn delegates to two delegators and leaves its continuation behind them.
function delegateTwo(workflowId: string, rootTaskId: string, payloadHash = HASH_A) {
  const orchestrator = store.workflows.tasks(workflowId)[0];
  if (orchestrator === undefined) throw new Error("no orchestrator turn");
  return store.workflows.applyTurns(epoch, {
    workflowId,
    turns: [
      turn({ key: "d1", parentTaskId: rootTaskId }),
      turn({ key: "d2", parentTaskId: rootTaskId, dependsOn: [{ on: "d1", kind: "completed" }] }),
      turn({
        key: "continuation",
        threadId: orchestrator.threadId,
        role: "orchestrator",
        layer: 1,
        kind: "plan",
        localId: null,
        agentRef: "fake:orchestrate",
        model: "fake/high-model",
        modelPinned: true,
        dependsOn: [
          { on: "d1", kind: "settled" },
          { on: "d2", kind: "settled" },
        ],
      }),
    ],
    delegation: {
      threadId: orchestrator.threadId,
      parentTaskId: rootTaskId,
      proposedByRunId: null,
      tool: "haril_delegate",
      payloadHash,
      memo: "styles first, tests second",
    },
  });
}

describe("workflow.start", () => {
  it("creates a running workflow and the orchestrator's first turn, ready", () => {
    const { workflowId, rootTaskId } = start();
    expect(store.workflows.get(workflowId)).toEqual({
      workflowId,
      projectId,
      rootTaskId,
      goal: "Change the primary button color and test it",
      state: "running",
      autonomy: { mode: "autonomous", stops: [] },
      limits: LIMITS,
      orchestratorModel: "fake/high-model",
      agentsCreated: 1,
      stopReason: null,
      baseBranch: null,
      baseSha: null,
      simulated: true,
      createdAt: clock.now(),
      endedAt: null,
    });
    const [orchestrator] = store.workflows.tasks(workflowId);
    expect(orchestrator).toMatchObject({
      taskId: rootTaskId,
      role: "orchestrator",
      layer: 1,
      kind: "plan",
      state: "ready",
      agentRef: "fake:orchestrate",
      model: "fake/high-model",
      modelPinned: true,
      parentTaskId: null,
      budgetTokens: 50_000,
      timeoutMs: 600_000,
      dependsOn: [],
    });
    expect(orchestrator?.threadId).toEqual(expect.any(String));
    expect(eventTypes()).toEqual(
      expect.arrayContaining(["workflow.created", "task.created", "command.applied"]),
    );
  });

  it("starts with the after_plan stop when no autonomy is given (P1)", () => {
    const { workflowId } = start({ autonomy: undefined });
    expect(store.workflows.get(workflowId)?.autonomy).toEqual({
      mode: "stops",
      stops: ["after_plan"],
    });
  });

  it("rejects a blank goal or model, an unknown stop, a bad mode and limits that are not an object", () => {
    for (const [change, reason] of [
      [{ goal: " " }, /goal/],
      [{ model: "" }, /model/],
      [{ autonomy: { mode: "stops", stops: ["after_lunch"] } }, /stop/],
      [{ autonomy: { mode: "sometimes", stops: [] } }, /autonomy/],
      [{ limits: [1, 2] }, /limits/],
    ] as const) {
      const applied = enqueue("workflow.start", {
        goal: "g",
        model: "m",
        limits: LIMITS,
        ...change,
      });
      expect(applied.outcome).toBe("rejected");
      expect(applied.reason).toMatch(reason);
    }
    expect(store.workflows.list()).toEqual([]);
  });
});

describe("store.workflows.applyTurns (delegation.apply)", () => {
  it("creates the children and the caller's continuation in one transaction, and records the proposal", () => {
    const { workflowId, rootTaskId } = start();
    claim(rootTaskId);
    const result = delegateTwo(workflowId, rootTaskId);
    expect(result.created).toBe(true);
    expect(Object.keys(result.taskIds).sort()).toEqual(["continuation", "d1", "d2"]);

    const tasks = store.workflows.tasks(workflowId);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const d1 = byId.get(result.taskIds.d1 as string);
    const d2 = byId.get(result.taskIds.d2 as string);
    const continuation = byId.get(result.taskIds.continuation as string);
    expect(d1).toMatchObject({
      role: "delegator",
      layer: 2,
      state: "ready",
      localId: "d1",
      parentTaskId: rootTaskId,
    });
    expect(d2).toMatchObject({
      state: "pending",
      dependsOn: [{ taskId: d1?.taskId, kind: "completed" }],
    });
    expect(continuation).toMatchObject({
      role: "orchestrator",
      threadId: tasks[0]?.threadId,
      state: "pending",
      dependsOn: [
        { taskId: d1?.taskId, kind: "settled" },
        { taskId: d2?.taskId, kind: "settled" },
      ],
    });
    expect(d1?.delegationId).toBe(result.delegationId);
    expect(d1?.threadId).not.toBe(d2?.threadId);
    expect(store.workflows.get(workflowId)?.agentsCreated).toBe(4);
    expect(store.workflows.delegations(workflowId)).toEqual([
      {
        delegationId: result.delegationId,
        workflowId,
        threadId: tasks[0]?.threadId,
        parentTaskId: rootTaskId,
        proposedByRunId: null,
        tool: "haril_delegate",
        payloadHash: HASH_A,
        memo: "styles first, tests second",
        createdAt: clock.now(),
      },
    ]);
    expect(eventTypes()).toContain("delegation.applied");
  });

  it("creates nothing for a replayed proposal (same thread and payload hash)", () => {
    const { workflowId, rootTaskId } = start();
    const first = delegateTwo(workflowId, rootTaskId);
    const replay = delegateTwo(workflowId, rootTaskId);
    expect(replay).toEqual({
      created: false,
      delegationId: first.delegationId,
      taskIds: {},
      threadIds: {},
    });
    expect(store.workflows.tasks(workflowId)).toHaveLength(4);
    expect(store.workflows.get(workflowId)?.agentsCreated).toBe(4);
  });

  it("lets a thread's dependents wait for its latest turn (inherit)", () => {
    const { workflowId, rootTaskId } = start();
    const top = delegateTwo(workflowId, rootTaskId);
    const d1 = top.taskIds.d1 as string;
    const d1Thread = top.threadIds.d1 as string;
    const result = store.workflows.applyTurns(epoch, {
      workflowId,
      turns: [
        turn({
          key: "e1",
          role: "executor",
          layer: 3,
          kind: "work",
          parentTaskId: d1,
          agentRef: "fake:execute",
          surfaceWrite: ["src/a.ts"],
        }),
        turn({
          key: "a1",
          role: "auditor",
          layer: 3,
          kind: "verify",
          parentTaskId: "e1",
          localId: null,
          agentRef: "fake:audit",
          dependsOn: [{ on: "e1", kind: "completed" }],
        }),
        turn({
          key: "c1",
          threadId: d1Thread,
          localId: null,
          parentTaskId: rootTaskId,
          dependsOn: [{ on: "a1", kind: "settled" }],
        }),
      ],
      inherit: [{ from: d1, to: "c1" }],
      delegation: {
        threadId: d1Thread,
        parentTaskId: d1,
        proposedByRunId: null,
        tool: "haril_assign",
        payloadHash: HASH_B,
        memo: null,
      },
    });
    const continuation = store.workflows
      .tasks(workflowId)
      .find((task) => task.taskId === top.taskIds.continuation);
    expect(continuation?.dependsOn).toEqual([
      { taskId: d1, kind: "settled" },
      { taskId: top.taskIds.d2, kind: "settled" },
      { taskId: result.taskIds.c1, kind: "settled" },
    ]);
    const d2 = store.workflows.tasks(workflowId).find((task) => task.taskId === top.taskIds.d2);
    expect(d2?.dependsOn).toEqual([
      { taskId: d1, kind: "completed" },
      { taskId: result.taskIds.c1, kind: "completed" },
    ]);
    expect(store.workflows.get(workflowId)?.agentsCreated).toBe(7);
  });

  it("merges the stops a proposal adds into the workflow's autonomy", () => {
    const { workflowId, rootTaskId } = start();
    store.workflows.applyTurns(epoch, {
      workflowId,
      turns: [turn({ key: "d1", parentTaskId: rootTaskId })],
      addStops: ["after_node:d1", "at_end"],
    });
    expect(store.workflows.get(workflowId)?.autonomy).toEqual({
      mode: "stops",
      stops: ["after_node:d1", "at_end"],
    });
  });

  it("refuses turns whose role, layer and kind disagree, or that name what the workflow does not hold", () => {
    const { workflowId, rootTaskId } = start();
    const attempts: [Partial<NewTurn>, RegExp][] = [
      [{ layer: 3 }, /layer/],
      [{ kind: "work" }, /kind/],
      [{ parentTaskId: "no-such-task" }, /unknown/],
      [{ dependsOn: [{ on: "nowhere", kind: "completed" }] }, /unknown/],
      [{ threadId: "no-such-thread" }, /thread/],
      [{ parentTaskId: null }, /parent/],
    ];
    for (const [change, message] of attempts) {
      const error = caught(() =>
        store.workflows.applyTurns(epoch, {
          workflowId,
          turns: [turn({ key: "d1", parentTaskId: rootTaskId, ...change })],
        }),
      );
      expect(error.code).toBe("store.conflict");
      expect(error.message).toMatch(message);
    }
    expect(store.workflows.tasks(workflowId)).toHaveLength(1);
  });

  it("refuses a workflow that is not running, and a fenced epoch", () => {
    const { workflowId, rootTaskId } = start();
    expect(
      caught(() =>
        store.workflows.applyTurns(epoch + 1, {
          workflowId,
          turns: [turn({ key: "d1", parentTaskId: rootTaskId })],
        }),
      ).code,
    ).toBe("store.fenced");
    store.workflows.setState(epoch, { workflowId, state: "awaiting_human", reason: "after_plan" });
    const error = caught(() =>
      store.workflows.applyTurns(epoch, {
        workflowId,
        turns: [turn({ key: "d1", parentTaskId: rootTaskId })],
      }),
    );
    expect(error.code).toBe("store.conflict");
    expect(error.message).toMatch(/awaiting_human/);
  });
});

describe("settled continuations through the store (3.7)", () => {
  it("readies the orchestrator's continuation after one delegator failed", () => {
    const { workflowId, rootTaskId } = start();
    const runId = claim(rootTaskId);
    const top = delegateTwo(workflowId, rootTaskId);
    store.runs.complete({ runId, outcome: "succeeded", result: { delegated: 2 } });
    const d1Run = claim(top.taskIds.d1 as string);
    store.runs.complete({
      runId: d1Run,
      outcome: "failed",
      error: { code: "fake.failed", message: "boom" },
      endCause: "exit",
    });

    const promoted = store.tasks.promote();

    expect(promoted.blocked.map((task) => task.taskId)).toEqual([top.taskIds.d2]);
    expect(promoted.ready.map((task) => task.taskId)).toEqual([top.taskIds.continuation]);
  });
});

describe("store.workflows.recordAudit", () => {
  // A delegator with one executor and its auditor, and a final auditor of the workflow.
  function audited() {
    const { workflowId, rootTaskId } = start();
    const top = delegateTwo(workflowId, rootTaskId);
    const d1 = top.taskIds.d1 as string;
    const made = store.workflows.applyTurns(epoch, {
      workflowId,
      turns: [
        turn({ key: "e1", role: "executor", layer: 3, kind: "work", parentTaskId: d1 }),
        turn({
          key: "a1",
          role: "auditor",
          layer: 3,
          kind: "verify",
          parentTaskId: "e1",
          localId: null,
        }),
        turn({
          key: "final",
          role: "auditor",
          layer: 3,
          kind: "verify",
          parentTaskId: rootTaskId,
          localId: null,
        }),
      ],
    });
    return {
      workflowId,
      d1,
      executor: made.taskIds.e1 as string,
      auditor: made.taskIds.a1 as string,
      finalAuditor: made.taskIds.final as string,
    };
  }

  it("records a verdict with its reasons and the rework action, with its events", () => {
    const { workflowId, executor, auditor } = audited();
    const audit = store.workflows.recordAudit(epoch, {
      workflowId,
      subjectTaskId: executor,
      auditorTaskId: auditor,
      scope: "task",
      verdict: "rejected",
      reasons: [{ criterion: "The button uses the new color", ok: false, evidence: "still blue" }],
      reworkAction: "retry",
    });
    expect(store.workflows.audits(workflowId)).toEqual([audit]);
    expect(audit).toMatchObject({ verdict: "rejected", reworkAction: "retry", scope: "task" });
    expect(eventTypes()).toEqual(expect.arrayContaining(["audit.verdict", "audit.retry"]));
    expect(
      caught(() => store.workflows.recordAudit(epoch, { ...audit, reworkAction: "fail" })).code,
    ).toBe("store.conflict");
  });

  it("records the final audit with no subject, and an escalation event", () => {
    const { workflowId, executor, auditor, finalAuditor } = audited();
    store.workflows.recordAudit(epoch, {
      workflowId,
      subjectTaskId: executor,
      auditorTaskId: auditor,
      scope: "task",
      verdict: "rejected",
      reasons: [{ criterion: "c", ok: false, evidence: "e" }],
      reworkAction: "escalate",
    });
    const final = store.workflows.recordAudit(epoch, {
      workflowId,
      subjectTaskId: null,
      auditorTaskId: finalAuditor,
      scope: "workflow",
      verdict: "approved",
      reasons: [],
      reworkAction: "accept",
    });
    expect(final.subjectTaskId).toBeNull();
    expect(eventTypes()).toContain("audit.escalated");
  });

  it("refuses an auditor turn that is not an auditor, or a subject that is not an executor", () => {
    const { workflowId, d1, executor, auditor } = audited();
    for (const [subjectTaskId, auditorTaskId] of [
      [executor, d1],
      [d1, auditor],
    ]) {
      const error = caught(() =>
        store.workflows.recordAudit(epoch, {
          workflowId,
          subjectTaskId: subjectTaskId as string,
          auditorTaskId: auditorTaskId as string,
          scope: "task",
          verdict: "approved",
          reasons: [],
          reworkAction: "accept",
        }),
      );
      expect(error.code).toBe("store.conflict");
    }
  });
});

describe("workflow states", () => {
  it("pauses at a stop and resumes only through the human's workflow.continue, which may remove stops", () => {
    const { workflowId } = start({ autonomy: { mode: "stops", stops: ["after_plan", "at_end"] } });
    store.workflows.setState(epoch, { workflowId, state: "awaiting_human", reason: "after_plan" });
    expect(store.workflows.get(workflowId)).toMatchObject({
      state: "awaiting_human",
      stopReason: "after_plan",
      endedAt: null,
    });
    const applied = enqueue("workflow.continue", { workflowId, removeStops: ["after_plan"] });
    expect(applied.outcome).toBe("applied");
    expect(store.workflows.get(workflowId)).toMatchObject({
      state: "running",
      stopReason: null,
      autonomy: { mode: "stops", stops: ["at_end"] },
    });
    expect(eventTypes()).toEqual(
      expect.arrayContaining(["workflow.awaiting_human", "workflow.continued"]),
    );
    expect(enqueue("workflow.continue", { workflowId }).outcome).toBe("rejected");
  });

  it("ends a workflow once: completed, failed or stopped set ended_at and allow no other state", () => {
    const { workflowId } = start();
    clock.advance(5_000);
    store.workflows.setState(epoch, { workflowId, state: "completed" });
    expect(store.workflows.get(workflowId)).toMatchObject({
      state: "completed",
      endedAt: clock.now(),
    });
    expect(
      caught(() => store.workflows.setState(epoch, { workflowId, state: "failed" })).code,
    ).toBe("store.conflict");
    expect(eventTypes()).toContain("workflow.completed");
    const other = start();
    store.workflows.setState(epoch, {
      workflowId: other.workflowId,
      state: "failed",
      reason: "no_capacity",
    });
    expect(store.workflows.get(other.workflowId)).toMatchObject({
      state: "failed",
      stopReason: "no_capacity",
    });
    expect(store.workflows.list().map((workflow) => workflow.workflowId)).toEqual([
      other.workflowId,
      workflowId,
    ]);
  });

  it("keeps the watchdog's next check on the turn", () => {
    const { workflowId, rootTaskId } = start();
    store.workflows.scheduleCheck(epoch, rootTaskId, clock.now() + 900_000);
    expect(store.workflows.tasks(workflowId)[0]?.nextCheckAt).toBe(clock.now() + 900_000);
    store.workflows.scheduleCheck(epoch, rootTaskId, null);
    expect(store.workflows.tasks(workflowId)[0]?.nextCheckAt).toBeNull();
  });
});
