import {
  DEFAULT_WATCHDOG_POLICY,
  evaluateLiveness,
  type LivenessDecision,
  type LivenessEvidence,
  type RunEvent,
  type WatchdogPolicy,
} from "@haril/core";
import type { CancelledTask, Clock, Store, WorkflowRecord } from "@haril/core/ports";
import { type ThreadView, threadsOf } from "../commands/workflow-snapshot.js";

// The residual-task watchdog in the runtime (docs/modos-y-delegacion.md 3.16, reading L2): code asks "are you still
// working?" on behalf of the parent, with objective facts, and costs no tokens. Every intervalMs (15 minutes by default,
// P16) each live node of a running workflow is judged by Core's evaluateLiveness:
//   - a node of layer 3 (an executor or an auditor) is asked by its delegator, a delegator by the orchestrator, and the
//     orchestrator by the workflow itself;
//   - a node whose current turn runs is judged by its own attempt: tokens its model calls settled in the window, a model
//     call still open, its newest tool call (the Broker's ledger and the run's tool.* events);
//   - a node whose current turn waits (pending on its children, or ready and held back by a limit) has live work, so it
//     continues: a turn waiting for capacity is never closed;
//   - active: it continues and is checked again intervalMs later (next_check_at, kept across a restart);
//   - idle: its attempt is closed now, its process killed; it counts as a failed attempt, so the rework rules decide
//     what follows (3.8) and no loop opens;
//   - residual: nothing will consume its result (its workflow ended, or the thread that waits for it has no live turn
//     left): it is cancelled now, without retry.
// The workflow's own check is settleWorkflows, every turn of the loop: a running workflow with nothing pending, ready or
// running fails as stalled. The backstop for a capacity that never frees is the workflow's wall time
// (limits.maxWorkflowWallMs, 2 hours by default): past it the workflow fails (wall_time) and every turn it left is
// residual, cancelled at once by cancelStrandedTurns. A workflow waiting for a person is under no such cap: it waits for
// as long as the person takes, and that time is not charged to it when it goes on. Each verdict is a watchdog.checked or watchdog.closed event whose
// text starts with the node's id, which the console's detail line reads.

const LIVE = new Set(["pending", "ready", "running"]);

export interface WatchdogSettings {
  // The cadence of the checks; default 15 minutes.
  readonly intervalMs?: number;
  // Checks in a row without progress before an idle attempt is closed; default 1.
  readonly idleStrikesToClose?: number;
}

export function watchdogPolicy(settings: WatchdogSettings | undefined): WatchdogPolicy {
  return {
    intervalMs: settings?.intervalMs ?? DEFAULT_WATCHDOG_POLICY.intervalMs,
    idleStrikesToClose: settings?.idleStrikesToClose ?? DEFAULT_WATCHDOG_POLICY.idleStrikesToClose,
  };
}

// An attempt in flight of this runtime, as the loop knows it.
interface WatchedAttempt {
  readonly runId: string;
  readonly startedAt: number;
}

export interface WatchdogDeps {
  readonly store: Store;
  readonly epoch: number;
  readonly clock: Clock;
  readonly policy: WatchdogPolicy;
  readonly emit: (event: RunEvent) => void;
  // The live attempt of a running turn, by task id; undefined when this runtime does not run it.
  readonly attemptOf: (taskId: string) => WatchedAttempt | undefined;
  // Checks in a row without progress, by task id (kept in memory: with the default policy every count is 0).
  readonly strikes: Map<string, number>;
}

export interface WatchdogPass {
  // Turns cancelled as residual (a running one had its run closed: its attempt must be killed).
  readonly cancelled: readonly CancelledTask[];
  // Running turns judged idle: their attempts must be closed now.
  readonly idle: readonly string[];
}

const NO_ACTION: WatchdogPass = { cancelled: [], idle: [] };

// Every turn of the loop: the turns a workflow left when it ended are residual and cancelled at once. Cheap: one query
// that is empty unless a workflow just ended.
export function cancelStrandedTurns(deps: WatchdogDeps): WatchdogPass {
  const stranded = deps.store.workflows.strandedTurns();
  if (stranded.length === 0) return NO_ACTION;
  const cancelled: CancelledTask[] = [];
  const byWorkflow = new Map<string, string[]>();
  for (const turn of stranded) {
    byWorkflow.set(turn.workflowId, [...(byWorkflow.get(turn.workflowId) ?? []), turn.taskId]);
  }
  for (const [workflowId, taskIds] of byWorkflow) {
    const workflow = deps.store.workflows.get(workflowId);
    if (workflow === undefined) continue;
    const threads = threadsOf(deps.store.workflows.tasks(workflowId));
    for (const taskId of taskIds) {
      const thread = threads.find((item) => item.turns.some((turn) => turn.taskId === taskId));
      const done = cancelResidual(
        deps,
        workflow,
        thread,
        threads,
        taskId,
        `its workflow ${workflow.state}`,
      );
      if (done !== undefined) cancelled.push(done);
    }
  }
  return { cancelled, idle: [] };
}

// Every turn of the loop: the live nodes of running workflows whose check came. A node seen for the first time is
// scheduled, not judged: its first window starts now (a running turn's, when its attempt started).
export function checkLiveNodes(deps: WatchdogDeps): WatchdogPass {
  const { store, clock, policy } = deps;
  const cancelled: CancelledTask[] = [];
  const idle: string[] = [];
  const now = clock.now();
  for (const workflow of store.workflows.list()) {
    if (workflow.state !== "running" && workflow.state !== "awaiting_human") continue;
    const tasks = store.workflows.tasks(workflow.workflowId);
    const threads = threadsOf(tasks);
    const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
    for (const thread of threads) {
      const latest = thread.turns[thread.turns.length - 1];
      if (latest === undefined || !LIVE.has(latest.state)) continue;
      const attempt = latest.state === "running" ? deps.attemptOf(latest.taskId) : undefined;
      if (latest.state === "running" && attempt === undefined) continue;
      if (latest.nextCheckAt === null) {
        store.workflows.scheduleCheck(
          deps.epoch,
          latest.taskId,
          (attempt?.startedAt ?? now) + policy.intervalMs,
        );
        continue;
      }
      if (now < latest.nextCheckAt) continue;
      const windowStart = Math.max(attempt?.startedAt ?? 0, latest.nextCheckAt - policy.intervalMs);
      if (consumerGone(thread, byId)) {
        const done = cancelResidual(
          deps,
          workflow,
          thread,
          threads,
          latest.taskId,
          "nobody waits for its result",
        );
        if (done !== undefined) cancelled.push(done);
        continue;
      }
      const evidence = evidenceOf(
        deps,
        workflow,
        thread,
        threads,
        latest.state,
        attempt,
        windowStart,
      );
      const decision = evaluateLiveness(evidence, now, policy);
      deps.strikes.set(latest.taskId, decision.idleStrikes);
      if (decision.action === "close") {
        store.workflows.scheduleCheck(deps.epoch, latest.taskId, null);
        verdict(
          deps,
          workflow,
          thread,
          threads,
          latest.taskId,
          decision,
          `${thread.code} closed: no progress in ${minutes(policy.intervalMs)}`,
          now,
        );
        idle.push(latest.taskId);
        continue;
      }
      if (decision.action === "cancel") {
        const done = cancelResidual(
          deps,
          workflow,
          thread,
          threads,
          latest.taskId,
          "its workflow ended",
        );
        if (done !== undefined) cancelled.push(done);
        continue;
      }
      store.workflows.scheduleCheck(deps.epoch, latest.taskId, decision.nextCheckAt);
      verdict(
        deps,
        workflow,
        thread,
        threads,
        latest.taskId,
        decision,
        continueText(thread, latest.state, decision),
        now,
      );
    }
  }
  return { cancelled, idle };
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return value >= 1 ? `${value} min` : `${Math.round(ms / 1000)} s`;
}

function continueText(thread: ThreadView, state: string, decision: LivenessDecision): string {
  if (decision.verdict === "waiting_human")
    return `${thread.code} waiting for the human, continues`;
  if (decision.verdict === "cooling_down") return `${thread.code} cooling down, continues`;
  if (decision.verdict === "idle") {
    return `${thread.code} idle (${decision.idleStrikes} check without progress), continues`;
  }
  if (state === "ready") return `${thread.code} active, continues: ready, waiting for capacity`;
  if (state === "pending") return `${thread.code} active, continues: waiting for its children`;
  return `${thread.code} active, continues: ${decision.signals.join(", ")}`;
}

// The thread that consumes this thread's result has no live turn left (3.16 residual): the parent thread for an executor
// or delegator. A task auditor shares its executor's structural delegator parent; the orchestrator and final auditor
// answer to the workflow itself, which cancelStrandedTurns covers.
function consumerGone(thread: ThreadView, byId: ReadonlyMap<string, ThreadView>): boolean {
  if (thread.role === "orchestrator") return false;
  const consumer = thread.parentThreadId === null ? undefined : byId.get(thread.parentThreadId);
  if (thread.role === "auditor") {
    if (consumer?.role !== "delegator") return false;
  }
  if (consumer === undefined) return false;
  return !consumer.turns.some((turn) => LIVE.has(turn.state) || turn.state === "blocked");
}

function evidenceOf(
  deps: WatchdogDeps,
  workflow: WorkflowRecord,
  thread: ThreadView,
  threads: readonly ThreadView[],
  state: string,
  attempt: WatchedAttempt | undefined,
  windowStart: number,
): LivenessEvidence {
  const base = {
    workflowState: workflow.state,
    parentTerminal: false,
    coolingUntil: null,
    windowStart,
    lastChildChangeAt: null,
    lastFileChangeAt: null,
    idleStrikes: deps.strikes.get(thread.turns[thread.turns.length - 1]?.taskId ?? "") ?? 0,
  };
  if (state === "running" && attempt !== undefined) {
    const activity = deps.store.runs.activity(attempt.runId, windowStart);
    return {
      ...base,
      kind: "attempt",
      // An attempt is judged by its own progress, whatever the workflow waits for.
      awaitingHuman: false,
      tokensInWindow: activity.tokens,
      lastToolCallAt: activity.lastToolCallAt,
      modelRequestOpen: activity.openRequests > 0,
      liveWork: 0,
    };
  }
  return {
    ...base,
    kind: thread.role === "orchestrator" ? "workflow" : "thread",
    awaitingHuman: workflow.state === "awaiting_human",
    tokensInWindow: 0,
    lastToolCallAt: null,
    modelRequestOpen: false,
    liveWork: liveWorkOf(thread, threads),
  };
}

// The live turns of a thread and of every thread under it: a waiting node waits for these.
function liveWorkOf(thread: ThreadView, threads: readonly ThreadView[]): number {
  const subtree = new Set([thread.threadId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const other of threads) {
      if (
        other.parentThreadId !== null &&
        subtree.has(other.parentThreadId) &&
        !subtree.has(other.threadId)
      ) {
        subtree.add(other.threadId);
        grew = true;
      }
    }
  }
  return threads
    .filter((other) => subtree.has(other.threadId))
    .reduce((sum, other) => sum + other.turns.filter((turn) => LIVE.has(turn.state)).length, 0);
}

function askerOf(thread: ThreadView, threads: readonly ThreadView[]): string {
  if (thread.layer === 1) return "workflow";
  const byId = new Map(threads.map((item) => [item.threadId, item]));
  let parent = thread.parentThreadId === null ? undefined : byId.get(thread.parentThreadId);
  const wanted = thread.layer === 3 ? "delegator" : "orchestrator";
  while (parent !== undefined && parent.role !== wanted) {
    parent = parent.parentThreadId === null ? undefined : byId.get(parent.parentThreadId);
  }
  return parent?.code ?? "workflow";
}

function cancelResidual(
  deps: WatchdogDeps,
  workflow: WorkflowRecord,
  thread: ThreadView | undefined,
  threads: readonly ThreadView[],
  taskId: string,
  why: string,
): CancelledTask | undefined {
  const cancelled = deps.store.tasks.cancel(deps.epoch, taskId, "residual");
  if (cancelled === undefined) return undefined;
  const node = thread?.code ?? taskId;
  verdict(
    deps,
    workflow,
    thread,
    threads,
    taskId,
    { verdict: "residual", action: "cancel", nextCheckAt: null, idleStrikes: 0, signals: [] },
    `${node} cancelled: residual (${why})`,
  );
  deps.emit({ type: "task.cancelled", taskId, goal: cancelled.goal, reason: "residual" });
  return cancelled;
}

function verdict(
  deps: WatchdogDeps,
  workflow: WorkflowRecord,
  thread: ThreadView | undefined,
  threads: readonly ThreadView[],
  taskId: string,
  decision: LivenessDecision,
  text: string,
  checkedAt: number = deps.clock.now(),
): void {
  const node = thread?.code ?? taskId;
  const by = thread === undefined ? "workflow" : askerOf(thread, threads);
  const closing = decision.action !== "continue";
  deps.store.events.append({
    aggregateType: "task",
    aggregateId: taskId,
    type: closing ? "watchdog.closed" : "watchdog.checked",
    actorKind: "system",
    actorId: "watchdog",
    payload: {
      workflowId: workflow.workflowId,
      node,
      by,
      verdict: decision.verdict,
      action: decision.action,
      signals: decision.signals.join(","),
      checkedAt,
      nextCheckAt: decision.nextCheckAt,
      text,
    },
    projectId: workflow.projectId,
    taskId,
  });
  deps.emit({
    type: "watchdog.checked",
    workflowId: workflow.workflowId,
    taskId,
    node,
    verdict: decision.verdict,
    action: decision.action,
    text,
  });
}
