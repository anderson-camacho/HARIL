import type { WorkflowState } from "@haril/contracts";
import type { DelegationArchetype } from "./archetypes.js";
import { surfacesMayOverlap } from "./globs.js";
import type { DelegationLimits } from "./limits.js";

// The scheduler's decision (docs/modos-y-delegacion.md 3.9): which ready tasks of one workflow start now. Pure, so
// the concurrent loop of F2 asks it on every turn and the tests drive it with generated snapshots. It honours three
// levels of limits at once (simultaneous per role, live children per thread, workflow total), the writer limit and
// the surface locks of 3.10: two tasks whose write surfaces may overlap never run together; the second waits and so
// runs after the first (it is not an error). A full limit never spawns an extra process: the task stays ready.

export interface ClaimCandidate {
  readonly taskId: string;
  // The thread this turn belongs to (an agent across its turns).
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly parentArchetype: DelegationArchetype | null;
  readonly archetype: DelegationArchetype;
  readonly priority: number;
  // Creation order in the store (created_seq); the store claims by priority DESC, created_seq ASC.
  readonly createdSeq: number;
  readonly writeSurface: readonly string[];
  // True when the task already ran an attempt (a retry or a recovery): starting it again creates no new agent.
  readonly started: boolean;
}

export interface LiveTask {
  readonly taskId: string;
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly archetype: DelegationArchetype;
  readonly writeSurface: readonly string[];
}

export interface ClaimSnapshot {
  readonly workflowState: WorkflowState;
  readonly ready: readonly ClaimCandidate[];
  readonly running: readonly LiveTask[];
  // Distinct tasks of the workflow that ever started an attempt.
  readonly tasksStarted: number;
}

// Why a ready task waits, checked in this order; the first that holds is reported.
export type ClaimDeferral =
  | "workflow_not_running"
  | "thread_busy"
  | "workflow_agent_cap"
  | "role_limit"
  | "thread_limit"
  | "writer_limit"
  | "surface_conflict";

export interface ClaimPlan {
  readonly taskId: string;
  readonly archetype: DelegationArchetype;
}

export interface ClaimSelection {
  // In start order.
  readonly claims: readonly ClaimPlan[];
  // Every other ready task, in the same order, with the reason it waits.
  readonly deferred: readonly { readonly taskId: string; readonly reason: ClaimDeferral }[];
}

type RoleLimit = keyof DelegationLimits["maxConcurrent"];

const ROLE_LIMIT: Record<DelegationArchetype, RoleLimit | null> = {
  // One orchestrator thread per workflow, and a thread never runs two turns at once.
  orchestrator: null,
  delegator: "delegators",
  executor: "executors",
  auditor: "auditors",
};

// Reading L1: maxActiveChildren counts the delegators of the orchestrator and the executors of a delegator. Auditors
// are bounded by their own simultaneous limit only, independent of the executors they review.
function countsAsChild(archetype: DelegationArchetype): boolean {
  return archetype !== "auditor";
}

function childLimit(parent: DelegationArchetype | null, limits: DelegationLimits): number {
  if (parent === "orchestrator" || parent === "delegator") return limits.maxActiveChildren[parent];
  // An executor or auditor has no children; a task that claims one as its parent never starts.
  return 0;
}

function byStartOrder(a: ClaimCandidate, b: ClaimCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdSeq !== b.createdSeq) return a.createdSeq - b.createdSeq;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

export function selectClaims(snapshot: ClaimSnapshot, limits: DelegationLimits): ClaimSelection {
  const ordered = [...snapshot.ready].sort(byStartOrder);
  if (snapshot.workflowState !== "running") {
    return {
      claims: [],
      deferred: ordered.map((candidate) => ({
        taskId: candidate.taskId,
        reason: "workflow_not_running",
      })),
    };
  }

  const live: LiveTask[] = [...snapshot.running];
  const busyThreads = new Set(live.map((task) => task.threadId));
  const perRole = new Map<DelegationArchetype, number>();
  const perParent = new Map<string, number>();
  let writers = 0;
  let started = snapshot.tasksStarted;
  const count = (task: LiveTask): void => {
    perRole.set(task.archetype, (perRole.get(task.archetype) ?? 0) + 1);
    if (task.parentThreadId !== null && countsAsChild(task.archetype)) {
      perParent.set(task.parentThreadId, (perParent.get(task.parentThreadId) ?? 0) + 1);
    }
    if (task.writeSurface.length > 0) writers += 1;
  };
  for (const task of live) count(task);

  const reasonFor = (candidate: ClaimCandidate): ClaimDeferral | null => {
    if (busyThreads.has(candidate.threadId)) return "thread_busy";
    if (!candidate.started && started >= limits.maxAgentsPerWorkflow) return "workflow_agent_cap";
    const role = ROLE_LIMIT[candidate.archetype];
    if (role !== null && (perRole.get(candidate.archetype) ?? 0) >= limits.maxConcurrent[role]) {
      return "role_limit";
    }
    if (candidate.parentThreadId !== null && countsAsChild(candidate.archetype)) {
      const siblings = perParent.get(candidate.parentThreadId) ?? 0;
      if (siblings >= childLimit(candidate.parentArchetype, limits)) return "thread_limit";
    }
    if (candidate.writeSurface.length > 0) {
      if (writers >= limits.maxConcurrent.writers) return "writer_limit";
      if (live.some((task) => surfacesMayOverlap(task.writeSurface, candidate.writeSurface))) {
        return "surface_conflict";
      }
    }
    return null;
  };

  const claims: ClaimPlan[] = [];
  const deferred: { taskId: string; reason: ClaimDeferral }[] = [];
  for (const candidate of ordered) {
    const reason = reasonFor(candidate);
    if (reason !== null) {
      deferred.push({ taskId: candidate.taskId, reason });
      continue;
    }
    claims.push({ taskId: candidate.taskId, archetype: candidate.archetype });
    live.push(candidate);
    busyThreads.add(candidate.threadId);
    count(candidate);
    if (!candidate.started) started += 1;
  }
  return { claims, deferred };
}
