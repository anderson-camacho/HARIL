import type { WorkflowState } from "@haril/contracts";
import { type ClaimCandidate, type HeldSurface, type LiveTask, selectClaims } from "@haril/core";
import type { ClaimedTask, Clock, Store, WorkflowRecord } from "@haril/core/ports";
import { checkLaunch } from "./model-launch.js";
import { reachStop } from "./workflow-commit.js";
import {
  type DelegationOptions,
  type Task,
  WorkflowView,
  workflowSettings,
} from "./workflow-view.js";

// The workflow side of the concurrent loop (docs/modos-y-delegacion.md 3.9, 3.15): which ready turns of each running
// workflow start now, and what to do with a running workflow that can no longer move. The queue is the tasks table;
// selectClaims decides with the workflow's limits (simultaneous per role, live children per thread, the workflow's
// agent cap, the writer limit and the surface locks), and each chosen turn is claimed on its own, atomically, with the
// lease's epoch. A full limit never starts an extra process: the turn waits ready for the next free slot.
//
// Phase F8, a workflow that writes in git worktrees: its delegator turns and its final auditor hold the workflow's
// integration lock (one of them at a time uses the integration worktree), and its writers also wait for the write
// surfaces that writers of other writing workflows of the same project hold, so two tasks that may write the same file
// never run at once, in one workflow or across workflows.

export interface WorkflowClaim {
  readonly claimed: ClaimedTask;
  readonly workflowId: string;
}

function writes(workflow: WorkflowRecord): boolean {
  return workflow.baseBranch !== null && workflow.baseSha !== null;
}

// The exclusive locks a turn holds while it runs: in a workflow that writes, a delegator turn and the final auditor work
// in the integration worktree, one at a time.
function locksOf(task: Task, view: WorkflowView): string[] {
  if (!writes(view.workflow)) return [];
  const integrates =
    task.role === "delegator" ||
    (task.role === "auditor" && view.task(task.parentTaskId)?.role !== "executor");
  return integrates ? [`integration:${view.workflow.workflowId}`] : [];
}

function candidateOf(task: Task, view: WorkflowView): ClaimCandidate {
  const parent = view.task(task.parentTaskId);
  return {
    taskId: task.taskId,
    threadId: task.threadId,
    parentThreadId: parent?.threadId ?? null,
    parentArchetype: parent?.role ?? null,
    archetype: task.role,
    priority: task.priority,
    createdSeq: task.createdSeq,
    writeSurface: task.surfaceWrite,
    started: task.attempt > 0,
    locks: locksOf(task, view),
  };
}

function liveOf(task: Task, view: WorkflowView): LiveTask {
  return {
    taskId: task.taskId,
    threadId: task.threadId,
    parentThreadId: view.task(task.parentTaskId)?.threadId ?? null,
    archetype: task.role,
    writeSurface: task.surfaceWrite,
    locks: locksOf(task, view),
  };
}

interface ProjectWriter extends HeldSurface {
  readonly workflowId: string;
}

// The running writers of every writing workflow, by project.
function runningWriters(
  store: Store,
  workflows: readonly WorkflowRecord[],
): Map<string, ProjectWriter[]> {
  const byProject = new Map<string, ProjectWriter[]>();
  for (const workflow of workflows) {
    if (!writes(workflow)) continue;
    for (const task of store.workflows.tasks(workflow.workflowId)) {
      if (task.state !== "running" || task.surfaceWrite.length === 0) continue;
      const list = byProject.get(workflow.projectId) ?? [];
      list.push({ workflowId: workflow.workflowId, writeSurface: task.surfaceWrite });
      byProject.set(workflow.projectId, list);
    }
  }
  return byProject;
}

// Claims the turns selectClaims starts now in every running workflow, oldest workflow first. `exclude` names ready
// turns that must wait (a real agent whose setup is missing, for instance). Each turn's model is checked right before
// its claim (3.11, model-launch.ts): it may be replaced, the turn may wait for a cooldown, or the workflow may fail with
// no_capacity, which `onEnded` hears.
export function claimWorkflowTurns(
  store: Store,
  epoch: number,
  options: DelegationOptions | undefined,
  exclude: ReadonlySet<string> = new Set(),
  onEnded: (ended: WorkflowEnded) => void = () => undefined,
  now: number = Date.now(),
): WorkflowClaim[] {
  const claims: WorkflowClaim[] = [];
  const running = [...store.workflows.list({ state: "running" })].reverse();
  const writers = runningWriters(store, running);
  for (const workflow of running) {
    const view = WorkflowView.load(store, workflow.workflowId);
    if (view === undefined) continue;
    const ready = view.tasks.filter((task) => task.state === "ready" && !exclude.has(task.taskId));
    if (ready.length === 0) continue;
    const settings = workflowSettings(view.workflow, options);
    const { limits } = settings;
    const selection = selectClaims(
      {
        workflowState: view.workflow.state,
        ready: ready.map((task) => candidateOf(task, view)),
        running: view.tasks
          .filter((task) => task.state === "running")
          .map((task) => liveOf(task, view)),
        tasksStarted: view.tasks.filter((task) => task.attempt > 0).length,
        held: writes(workflow)
          ? (writers.get(workflow.projectId) ?? []).filter(
              (writer) => writer.workflowId !== workflow.workflowId,
            )
          : [],
      },
      limits,
    );
    for (const plan of selection.claims) {
      const task = view.task(plan.taskId);
      if (task === undefined) continue;
      const launch = checkLaunch(store, epoch, view, task, settings, now);
      if (launch.kind === "deferred") continue;
      if (launch.kind === "no_capacity") {
        onEnded({ workflowId: workflow.workflowId, state: "failed", reason: launch.reason });
        break;
      }
      const claimed = store.tasks.claimTask(epoch, plan.taskId);
      if (claimed === undefined) continue;
      claims.push({ claimed, workflowId: workflow.workflowId });
      // A writer started now holds its surface for the workflows scheduled after this one in the same pass.
      if (writes(workflow) && task.surfaceWrite.length > 0) {
        const list = writers.get(workflow.projectId) ?? [];
        list.push({ workflowId: workflow.workflowId, writeSurface: task.surfaceWrite });
        writers.set(workflow.projectId, list);
      }
    }
  }
  return claims;
}

export interface WorkflowEnded {
  readonly workflowId: string;
  readonly state: Exclude<WorkflowState, "running">;
  readonly reason: string | null;
}

// A running workflow that can no longer move: nothing pending, ready or running. With an approved final audit it is
// complete (after its at_end stop, which the human may have continued from); otherwise it stalled and fails. A workflow
// past its wall time fails too (its attempts in flight close normally and nothing follows them). The watchdog of 3.16
// (phase F3) adds the finer checks.
export function settleWorkflows(
  store: Store,
  epoch: number,
  clock: Clock,
  options: DelegationOptions | undefined,
): WorkflowEnded[] {
  const changed: WorkflowEnded[] = [];
  for (const workflow of store.workflows.list({ state: "running" })) {
    const view = WorkflowView.load(store, workflow.workflowId);
    if (view === undefined) continue;
    const { limits } = workflowSettings(workflow, options);
    let reason: string | null = null;
    let state: Exclude<WorkflowState, "running"> | null = null;
    if (
      limits.maxWorkflowWallMs > 0 &&
      clock.now() - workflow.createdAt > limits.maxWorkflowWallMs
    ) {
      state = "failed";
      reason = "wall_time";
    } else if (!view.liveWork()) {
      if (view.finalAudit()?.verdict === "approved") {
        if (reachStop(store, epoch, workflow.workflowId, { type: "workflow_completing" })) {
          changed.push({
            workflowId: workflow.workflowId,
            state: "awaiting_human",
            reason: "at_end",
          });
          continue;
        }
        state = "completed";
      } else {
        state = "failed";
        reason = "stalled";
      }
    }
    if (state === null) continue;
    store.workflows.setState(epoch, {
      workflowId: workflow.workflowId,
      state,
      ...(reason === null ? {} : { reason }),
    });
    changed.push({ workflowId: workflow.workflowId, state, reason });
  }
  return changed;
}
