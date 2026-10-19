import type { EventRecord, Store, WorkflowRecord, WorkflowTaskRecord } from "@haril/core/ports";
import { describe, expect, it } from "vitest";
import { executorEvidence, workflowEvidence } from "../src/runtime/workflow-evidence.js";
import { settleWorkflows } from "../src/runtime/workflow-scheduler.js";

const workflow = {
  workflowId: "wf-1",
  baseBranch: "main",
  baseSha: "base-sha",
} as WorkflowRecord;
const executor = {
  taskId: "executor-1",
  workflowId: "wf-1",
  role: "executor",
  attempt: 1,
} as WorkflowTaskRecord;
const auditor = {
  taskId: "auditor-1",
  workflowId: "wf-1",
  role: "auditor",
  attempt: 1,
  auditedTaskId: executor.taskId,
} as WorkflowTaskRecord;

function event(
  type: string,
  taskId: string,
  runId: string,
  payload: Record<string, unknown>,
): EventRecord {
  return {
    type,
    taskId,
    runId,
    payload,
    actorKind: "system",
    actorId: "runtime:1",
    aggregateType: "task",
    aggregateId: taskId,
    seq: 1,
    eventId: `${type}-${runId}`,
    ts: 1,
  };
}

function store(events: EventRecord[]): { events: Pick<Store["events"], "list"> } {
  return { events: { list: ({ taskId } = {}) => events.filter((item) => item.taskId === taskId) } };
}

describe("host-observed workflow evidence", () => {
  it("rejects auditor prose, inherited files and unrelated successful commands", () => {
    const observed = store([
      event("task.claimed", executor.taskId, "executor-run", { attempt: 1 }),
      event("workspace.command", auditor.taskId, "audit-run", {
        command: "node",
        exitCode: 0,
        projectTest: false,
      }),
    ]);
    expect(executorEvidence(observed, executor, auditor).ok).toBe(false);
    expect(
      workflowEvidence(
        observed,
        workflow,
        [executor, auditor],
        [{ subjectTaskId: executor.taskId, auditorTaskId: auditor.taskId, verdict: "approved" }],
      ).ok,
    ).toBe(false);
  });

  it("accepts only a changed commit from the current attempt and a successful project test from its auditor", () => {
    const observed = store([
      event("task.claimed", executor.taskId, "older-run", { attempt: 0 }),
      event("worktree.committed", executor.taskId, "older-run", {
        attempt: 0,
        sha: "old",
        paths: ["old.ts"],
      }),
      event("task.claimed", executor.taskId, "executor-run", { attempt: 1 }),
      event("worktree.committed", executor.taskId, "executor-run", {
        attempt: 1,
        sha: "new",
        paths: ["new.ts"],
      }),
      event("task.claimed", auditor.taskId, "audit-run", { attempt: 1 }),
      event("workspace.command", auditor.taskId, "audit-run", {
        command: "npm",
        testCommand: "npm test",
        exitCode: 0,
        timedOut: false,
        projectTest: true,
      }),
    ]);
    expect(executorEvidence(observed, executor, auditor)).toMatchObject({
      ok: true,
      paths: ["new.ts"],
      commit: "new",
    });
  });

  it("permits an explicit read-only consultation without claiming implementation evidence", () => {
    expect(
      workflowEvidence(store([]), { ...workflow, baseBranch: null, baseSha: null }, [], []),
    ).toMatchObject({ ok: true, mode: "consultation" });
  });

  it("blocks the scheduler's settled completion despite a stored approved final audit", () => {
    const stateChanges: { state: string; reason?: string }[] = [];
    const record = {
      ...workflow,
      state: "running",
      createdAt: Date.now(),
      limits: {},
      orchestratorModel: "fake/model",
      autonomy: { mode: "autonomous", stops: [] },
    } as WorkflowRecord;
    const finished = { ...executor, state: "completed" } as WorkflowTaskRecord;
    const fake = {
      events: store([]).events,
      workflows: {
        list: () => [record],
        get: () => record,
        tasks: () => [finished],
        audits: () => [
          { scope: "workflow", subjectTaskId: null, auditorTaskId: "final", verdict: "approved" },
        ],
        delegations: () => [],
        setState: (_epoch: number, input: { state: string; reason?: string }) => {
          stateChanges.push(input);
        },
      },
    } as unknown as Store;
    expect(
      settleWorkflows(
        fake,
        1,
        { now: () => Date.now(), schedule: () => () => undefined },
        undefined,
      ),
    ).toMatchObject([{ state: "failed" }]);
    expect(stateChanges[0]?.reason).toContain("host_evidence_missing");
  });
});
