import type { WorkflowState } from "@haril/contracts";
import { type DelegationArchetype, evaluateQuota } from "@haril/core";
import type {
  AgentOutcome,
  ClaimedTask,
  Clock,
  DelegationCapacity,
  DelegationSibling,
  DelegationTurnInput,
  DelegationTurnKind,
  Store,
} from "@haril/core/ports";
import type { TurnWindowReport } from "./delegation-tools.js";
import { commitPlanOf, reachStop, type TurnContext } from "./workflow-commit.js";
import {
  type DelegationOptions,
  resultText,
  type Task,
  type WorkflowSettings,
  WorkflowView,
  workflowSettings,
} from "./workflow-view.js";

// A workflow turn from claim to close (docs/modos-y-delegacion.md 3.3 to 3.8, 3.11, 3.13; ADR-0021). Before the attempt,
// the runtime builds the turn's input from the store: what it must do, its memo, its children's outcomes and verdicts,
// the subject of an audit, its siblings and the capacity. When the attempt ends, it closes the turn in one transaction:
// the call the turn decided (applied now: the children and the continuation, a relaunch, a verdict...), the run's
// completion and its usage row, then the stops it reaches and the workflow's state. Nothing is half written, and the
// rework state is read back from the store every time, so a restart continues with the same counts.

const MAX_SIBLINGS = 20;

const SIBLING_STATE: Readonly<Record<string, DelegationSibling["state"]>> = {
  running: "running",
  pending: "queued",
  ready: "queued",
  completed: "done",
};

function turnKindOf(task: Task, index: number): DelegationTurnKind {
  if (index === 0) return "first";
  if (task.role === "orchestrator" || task.role === "delegator") return "continuation";
  if (task.role === "executor" && task.delegationId !== null) return "reformulation";
  return "relaunch";
}

function capacityOf(
  view: WorkflowView,
  task: Task,
  settings: WorkflowSettings,
  now: number,
): DelegationCapacity {
  const { limits } = settings;
  const live = (role: Task["role"]) =>
    view.tasks.filter((other) => other.role === role && other.state === "running").length;
  const childRole: DelegationArchetype | null =
    task.role === "orchestrator" ? "delegator" : task.role === "delegator" ? "executor" : null;
  const context = settings.models(now);
  const allow = childRole === null ? [] : (context.allow[childRole] ?? []);
  const models =
    childRole === null
      ? []
      : context.catalog
          .filter((entry) => allow.length === 0 || allow.includes(entry.ref))
          .map((entry) => {
            const quota = evaluateQuota(context.quota[entry.quotaKey], false, context.policy);
            return {
              ref: entry.ref,
              costTier: context.table.models[entry.ref]?.costTier ?? null,
              quota: quota.ok ? quota.data : ("blocked" as const),
            };
          });
  return {
    activeChildrenMax:
      task.role === "orchestrator" || task.role === "delegator"
        ? limits.maxActiveChildren[task.role]
        : null,
    queuedChildrenMax: limits.maxQueuedTasksPerThread,
    proposalsLeft: Math.max(0, limits.maxProposalsPerThread - view.proposalCount(task.threadId)),
    agentsLeft: Math.max(0, limits.maxAgentsPerWorkflow - view.workflow.agentsCreated),
    tokensLeft: Math.max(0, limits.maxWorkflowTokens - view.tokensCommitted()),
    live: {
      executors: { live: live("executor"), max: limits.maxConcurrent.executors },
      auditors: { live: live("auditor"), max: limits.maxConcurrent.auditors },
      delegators: { live: live("delegator"), max: limits.maxConcurrent.delegators },
    },
    models,
  };
}

function siblingsOf(view: WorkflowView, task: Task): DelegationSibling[] {
  if (task.role !== "executor" && task.role !== "delegator") return [];
  const parent = view.parentThreadId(task.threadId);
  if (parent === null) return [];
  return view
    .childThreads(parent)
    .filter((thread) => thread !== task.threadId)
    .slice(0, MAX_SIBLINGS)
    .map((thread) => {
      const first = view.turns(thread)[0] as Task;
      const latest = view.latest(thread) as Task;
      return {
        localId: first.localId ?? thread,
        goal: first.goal,
        writeSurface: latest.surfaceWrite,
        state: SIBLING_STATE[latest.state] ?? "failed",
      };
    });
}

// The verdict an orchestrator turn answers: the final audit that rejected the workflow, when no proposal of the
// orchestrator came after it (after corrections, the next turn reads its delegators' reports instead).
function finalAuditFor(view: WorkflowView, task: Task): DelegationTurnInput["finalAudit"] {
  const audit = view.finalAudit();
  if (audit === undefined || audit.verdict !== "rejected") return null;
  const auditor = view.task(audit.auditorTaskId);
  if (auditor === undefined || task.createdSeq < auditor.createdSeq) return null;
  const later = view.delegations.some(
    (row) => row.threadId === task.threadId && row.createdAt > audit.createdAt,
  );
  return later ? null : { verdict: audit.verdict, reasons: audit.reasons };
}

export function buildTurnInput(
  view: WorkflowView,
  task: Task,
  settings: WorkflowSettings,
  now: number,
): DelegationTurnInput {
  const turns = view.turns(task.threadId);
  const index = Math.max(
    0,
    turns.findIndex((turn) => turn.taskId === task.taskId),
  );
  const first = turns[0] ?? task;
  const base = {
    workflowId: view.workflow.workflowId,
    workflowGoal: view.workflow.goal,
    role: task.role,
    layer: task.layer,
    threadId: task.threadId,
    label: view.label(task.threadId),
    localId: first.localId,
    turn: index + 1,
    turnKind: turnKindOf(task, index),
    goal: task.goal,
    instructions: task.description,
    difficulty: task.difficulty,
    memo: null,
    acceptanceCriteria: [] as readonly string[],
    tests: null,
    files: { write: task.surfaceWrite, read: task.surfaceRead },
    children: [],
    previousVerdicts: [],
    subject: null,
    finalAudit: null,
    siblings: siblingsOf(view, task),
    capacity: capacityOf(view, task, settings, now),
  } satisfies DelegationTurnInput;
  switch (task.role) {
    case "orchestrator":
      return {
        ...base,
        memo: view.memoOf(task.threadId),
        children: view.childThreads(task.threadId).map((child) => view.delegatorOutcome(child)),
        finalAudit: finalAuditFor(view, task),
      };
    case "delegator":
      return {
        ...base,
        memo: view.memoOf(task.threadId),
        acceptanceCriteria: view.delegationOf(task.threadId)?.acceptanceCriteria ?? [],
        children: view
          .childThreads(task.threadId)
          .map((child) => view.executorOutcome(child, settings.limits)),
      };
    case "executor": {
      const assignment = view.assignmentOf(task.threadId);
      const earlier = new Set(turns.slice(0, index).map((turn) => turn.taskId));
      return {
        ...base,
        acceptanceCriteria: assignment?.acceptanceCriteria ?? [],
        tests: assignment?.tests ?? null,
        files: assignment?.files ?? base.files,
        previousVerdicts: view.audits
          .filter(
            (audit) =>
              audit.subjectTaskId !== null &&
              earlier.has(audit.subjectTaskId) &&
              audit.verdict === "rejected",
          )
          .map((audit) => ({ verdict: audit.verdict, reasons: audit.reasons })),
      };
    }
    case "auditor": {
      const subject = view.task(task.parentTaskId);
      if (subject?.role === "executor") {
        const assignment = view.assignmentOf(subject.threadId);
        return {
          ...base,
          acceptanceCriteria: assignment?.acceptanceCriteria ?? [],
          tests: assignment?.tests ?? null,
          files: { write: [], read: assignment?.files.read ?? [] },
          subject: {
            scope: "task",
            label: view.label(subject.threadId),
            goal: subject.goal,
            result: resultText(subject.result),
            reports: [],
          },
        };
      }
      const root = view.rootThreadId();
      return {
        ...base,
        subject: {
          scope: "workflow",
          label: "workflow",
          goal: view.workflow.goal,
          result: null,
          reports:
            root === null
              ? []
              : view.childThreads(root).map((child) => view.delegatorOutcome(child)),
        },
      };
    }
  }
}

export interface WorkflowAttempt {
  readonly claimed: ClaimedTask;
  readonly workflowId: string;
  readonly startedAt: number;
}

export interface CommitDeps {
  readonly store: Store;
  readonly epoch: number;
  readonly clock: Clock;
  readonly options?: DelegationOptions;
}

export interface CommitResult {
  readonly taskState: "completed" | "failed";
  // The run's error code, "" when it completed.
  readonly code: string;
  // What the turn did, as its usage row says it.
  readonly outcome: string;
  readonly workflowState: WorkflowState;
  readonly workflowReason: string | null;
}

// A fake agent reports its tokens; a real agent's come from the Broker's ledger, for this run only: a turn rerun after a
// recovery or a retry spent on the same task, and its earlier run already has its own row.
function tokensOf(
  store: Store,
  runId: string,
  outcome: AgentOutcome,
): { tokensIn: number | null; tokensOut: number | null } {
  if (outcome.status === "succeeded" && outcome.usage !== undefined) return outcome.usage;
  const ledger = store.budgets.usageSummary({ runId });
  return ledger === null
    ? { tokensIn: null, tokensOut: null }
    : { tokensIn: ledger.inputTokens, tokensOut: ledger.outputTokens };
}

// Closes one workflow turn: the call its window decided and its follow-ups, the run, the usage row and the stops, in
// one transaction.
export function commitWorkflowAttempt(
  deps: CommitDeps,
  attempt: WorkflowAttempt,
  outcome: AgentOutcome,
  report: TurnWindowReport,
): CommitResult {
  const { store, clock } = deps;
  const view = WorkflowView.load(store, attempt.workflowId);
  const task = view?.task(attempt.claimed.taskId);
  if (view === undefined || task === undefined) {
    throw new Error(
      `task ${attempt.claimed.taskId} is not a turn of workflow ${attempt.workflowId}`,
    );
  }
  const settings = workflowSettings(view.workflow, deps.options);
  const context: TurnContext = {
    store,
    epoch: deps.epoch,
    clock,
    view,
    task,
    settings,
    runId: attempt.claimed.runId,
  };
  const plan = commitPlanOf(context, outcome, report.action, report.refusals);
  const now = clock.now();
  store.transaction(() => {
    for (const write of plan.before) write();
    store.runs.complete(plan.completion);
    const tokens = tokensOf(store, attempt.claimed.runId, outcome);
    store.usageLog.appendUsage({
      kind: "agent_run",
      orderId: view.workflow.orderId,
      projectId: view.workflow.projectId,
      workflowId: view.workflow.workflowId,
      taskId: task.taskId,
      runId: attempt.claimed.runId,
      threadId: task.threadId,
      layer: task.layer,
      role: task.role,
      mode: "delegacion",
      provider: task.model?.split("/")[0] ?? null,
      modelRequested: task.model,
      modelServed: outcome.status === "succeeded" ? (outcome.model ?? task.model) : task.model,
      modelPinned: task.modelPinned,
      tokensIn: tokens.tokensIn,
      tokensOut: tokens.tokensOut,
      startedAt: attempt.startedAt,
      endedAt: now,
      durationMs: Math.max(0, now - attempt.startedAt),
      difficultyEst: task.difficulty,
      difficultyReason: task.difficultyReason,
      outcome: plan.outcome,
      auditVerdict: plan.verdict,
      // An executor's relaunch counts once, so a sum of the column counts relaunches.
      retries: task.role === "executor" ? (task.delegationId === null ? 1 : 0) : null,
      simulated: task.agentRef.startsWith("fake:"),
      idempotencyKey: `run:${attempt.claimed.runId}`,
    });
    for (const write of plan.after) write();
    reachBudget(context);
  });
  const workflow = store.workflows.get(attempt.workflowId);
  return {
    taskState: plan.completion.outcome === "succeeded" ? "completed" : "failed",
    code: plan.completion.outcome === "failed" ? plan.completion.error.code : "",
    outcome: plan.outcome,
    workflowState: workflow?.state ?? view.workflow.state,
    workflowReason: workflow?.stopReason ?? null,
  };
}

function reachBudget(context: TurnContext): void {
  const { store, view, settings } = context;
  const used = store.usageLog
    .usage({ workflowId: view.workflow.workflowId })
    .reduce((sum, row) => sum + (row.tokensIn ?? 0) + (row.tokensOut ?? 0), 0);
  if (settings.limits.maxWorkflowTokens <= 0) return;
  reachStop(store, context.epoch, view.workflow.workflowId, {
    type: "budget_used",
    pct: (used / settings.limits.maxWorkflowTokens) * 100,
  });
}
