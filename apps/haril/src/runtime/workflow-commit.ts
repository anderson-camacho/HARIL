import { createHash } from "node:crypto";
import type { AssignInput, DelegateInput, RequestAuditInput, VerdictInput } from "@haril/contracts";
import {
  type AutonomySettings,
  auditorBudgetTokens,
  canonicalJson,
  checkDelegation,
  chooseModel,
  completionFor,
  type DelegationCheck,
  decideRework,
  type ModelRequest,
  proposalFromAssign,
  proposalFromDelegate,
  type ReworkEvent,
  type StopEvent,
  stopFor,
} from "@haril/core";
import type {
  AgentOutcome,
  Clock,
  JsonObject,
  NewTurn,
  RunCompletion,
  Store,
} from "@haril/core/ports";
import { delegationState, reassignmentProblem, type TurnAction } from "./delegation-tools.js";
import { evidenceStatus, executorEvidence, workflowEvidence } from "./workflow-evidence.js";
import {
  firedStops,
  type Task,
  type WorkflowSettings,
  type WorkflowView,
} from "./workflow-view.js";

// What closing a workflow turn writes (docs/modos-y-delegacion.md 3.5, 3.7, 3.8, 3.13), as a plan the caller runs in
// one transaction: `before` (the decided call applied: children and continuation, a final auditor, a verdict and the
// relaunch it decides), the run's completion, then `after` (the stops reached and the workflow's state). The run's
// task state is the gate its dependents read: an auditor turn completes only when it approves, so a step that depends
// on another waits for its approval, and a node whose audit finally fails blocks its dependents; a delegator turn
// completes only when it reports done. The verdict or report itself is kept with the run either way.

export interface TurnContext {
  readonly store: Store;
  readonly epoch: number;
  readonly clock: Clock;
  readonly view: WorkflowView;
  readonly task: Task;
  readonly settings: WorkflowSettings;
  readonly runId: string;
}

export interface CommitPlan {
  readonly before: readonly (() => void)[];
  readonly completion: RunCompletion;
  // What the turn did, for its usage row.
  readonly outcome: string;
  readonly verdict: "approved" | "rejected" | null;
  readonly after: readonly (() => void)[];
}

const ENDED = new Set(["completed", "failed", "stopped"]);
const REASON_MAX = 500;
// Provisional (P2): the final auditor's token budget.
const FINAL_AUDIT_TOKENS = 30_000;

// The stop rule (3.13): the first listed stop an event reaches pauses a running workflow for the human; a stop already
// reached (and continued from) never fires again.
export function reachStop(
  store: Store,
  epoch: number,
  workflowId: string,
  event: StopEvent,
): boolean {
  const workflow = store.workflows.get(workflowId);
  if (workflow === undefined || workflow.state !== "running") return false;
  const settings: AutonomySettings = {
    mode: workflow.autonomy.mode,
    stops: workflow.autonomy.stops,
  };
  const stop = stopFor(settings, event, firedStops(store, workflow));
  if (stop === null) return false;
  store.workflows.setState(epoch, { workflowId, state: "awaiting_human", reason: stop });
  return true;
}

// A model for a new turn (3.11). A model held back, within maxWaitMs or beyond it, is still given: the turn is created
// with it, and the check at its launch makes it wait or stops it with an explanation until capacity returns
// (model-launch.ts). A substitution is recorded as model.substituted.
function pickModel(
  context: Pick<TurnContext, "store" | "clock" | "settings" | "view">,
  request: ModelRequest,
): { readonly model: string; readonly pinned: boolean } {
  const models = context.settings.models(context.clock.now());
  const choice = chooseModel(request, models);
  if (choice.kind !== "use") {
    const tried = choice.kind === "unavailable" ? choice.tried[0]?.model : undefined;
    const model =
      choice.model ??
      request.proposed ??
      tried ??
      models.table.classes[request.difficulty].order[0] ??
      context.view.workflow.orchestratorModel;
    return { model, pinned: models.pinned[request.archetype] === model };
  }
  if (choice.substitutedFrom !== null) {
    context.store.events.append({
      aggregateType: "workflow",
      aggregateId: context.view.workflow.workflowId,
      type: "model.substituted",
      actorKind: "system",
      actorId: "runtime",
      payload: { from: choice.substitutedFrom, to: choice.model, archetype: request.archetype },
      projectId: context.view.workflow.projectId,
    });
  }
  return { model: choice.model, pinned: choice.source === "pinned" };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function short(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= REASON_MAX
    ? chars.join("")
    : `${chars.slice(0, REASON_MAX - 1).join("")}…`;
}

function failure(
  context: TurnContext,
  code: string,
  message: string,
  output?: JsonObject,
): RunCompletion {
  return {
    runId: context.runId,
    outcome: "failed",
    error: { code, message },
    endCause: "exit",
    ...(output === undefined ? {} : { output }),
  };
}

// The failure of an attempt that did not succeed, as the store keeps it.
function failureOf(context: TurnContext, outcome: AgentOutcome): RunCompletion {
  return completionFor(context.runId, outcome);
}

function codeOf(completion: RunCompletion): string {
  return completion.outcome === "failed" ? completion.error.code : "";
}

// A turn that succeeded without the call its role must make.
function noAction(
  context: TurnContext,
  expected: string,
  refusals: readonly string[],
): RunCompletion {
  const last = refusals[refusals.length - 1];
  return failure(
    context,
    "delegation.no_action",
    last === undefined
      ? `the turn ended without calling ${expected}`
      : `the turn ended without an accepted call to ${expected}; the last refusal: ${last}`,
  );
}

function setWorkflowFailed(context: TurnContext, reason: string): () => void {
  return () => {
    const workflow = context.store.workflows.get(context.view.workflow.workflowId);
    if (workflow === undefined || ENDED.has(workflow.state)) return;
    context.store.workflows.setState(context.epoch, {
      workflowId: workflow.workflowId,
      state: "failed",
      reason: short(reason),
    });
  };
}

function stopAt(context: TurnContext, event: Parameters<typeof reachStop>[3]): () => void {
  return () => {
    reachStop(context.store, context.epoch, context.view.workflow.workflowId, event);
  };
}

function agentFor(view: WorkflowView, role: "delegator" | "executor" | "auditor"): string {
  const root = view.task(view.workflow.rootTaskId)?.agentRef ?? "";
  if (!root.startsWith("fake:")) return role;
  return role === "delegator"
    ? "fake:delegate"
    : role === "executor"
      ? "fake:execute"
      : "fake:audit";
}

// The next turn of the thread that delegated: same role and model, waiting for the children it just created (3.7).
function continuationOf(context: TurnContext): Omit<NewTurn, "dependsOn"> {
  const { view, task } = context;
  const first = view.turns(task.threadId)[0] ?? task;
  return {
    key: "continuation",
    threadId: task.threadId,
    role: task.role,
    layer: task.layer,
    kind: task.kind,
    parentTaskId: first.parentTaskId,
    localId: first.localId,
    goal: first.goal,
    description: first.description,
    agentRef: task.agentRef,
    model: task.model,
    modelPinned: task.modelPinned,
    difficulty: task.difficulty,
    difficultyReason: task.difficultyReason,
    priority: task.priority,
    budgetTokens: task.budgetTokens,
    timeoutMs: task.timeoutMs,
    surfaceWrite: [],
    surfaceRead: first.surfaceRead,
  };
}

function turnLike(task: Task): Omit<NewTurn, "key" | "dependsOn"> {
  return {
    threadId: task.threadId,
    role: task.role,
    layer: task.layer,
    kind: task.kind,
    parentTaskId: task.parentTaskId,
    auditedTaskId: task.auditedTaskId,
    localId: task.localId,
    goal: task.goal,
    description: task.description,
    agentRef: task.agentRef,
    model: task.model,
    modelPinned: task.modelPinned,
    difficulty: task.difficulty,
    difficultyReason: task.difficultyReason,
    priority: task.priority,
    budgetTokens: task.budgetTokens,
    timeoutMs: task.timeoutMs,
    surfaceWrite: task.surfaceWrite,
    surfaceRead: task.surfaceRead,
  };
}

function recheck(
  context: TurnContext,
  action: Extract<TurnAction, { tool: "haril_delegate" | "haril_assign" }>,
): Extract<DelegationCheck, { ok: true }> | string {
  const { view, task, settings } = context;
  const caller = { threadId: task.threadId, archetype: task.role, depth: task.layer };
  const proposal =
    action.tool === "haril_delegate"
      ? proposalFromDelegate(caller, action.input)
      : proposalFromAssign(caller, action.input);
  const state = delegationState(view, task.threadId, settings, context.clock.now());
  // A proposal accepted while the workflow ran is still applied when it paused meanwhile: its turns wait in the queue.
  const result = checkDelegation(
    proposal,
    { ...state, workflow: { ...state.workflow, state: "running" } },
    settings.limits,
  );
  if (!result.ok) return result.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
  if (action.tool === "haril_assign") {
    const problem = reassignmentProblem(view, task.threadId, action.input, settings);
    if (problem !== null) return problem;
  }
  return result;
}

function proposalRecord(
  context: TurnContext,
  tool: "haril_delegate" | "haril_assign" | "haril_request_audit",
  input: DelegateInput | AssignInput | RequestAuditInput,
  memo: string | null,
): NonNullable<Parameters<Store["workflows"]["applyTurns"]>[1]["delegation"]> {
  return {
    threadId: context.task.threadId,
    parentTaskId: context.task.taskId,
    proposedByRunId: context.runId,
    tool,
    payloadHash: sha256(input),
    memo,
    payload: input as unknown as JsonObject,
  };
}

function addedStops(context: TurnContext, check: Extract<DelegationCheck, { ok: true }>) {
  const before = context.view.workflow.autonomy.stops;
  return check.autonomy.stops.filter((stop) => !before.includes(stop));
}

function serializedAfter(check: Extract<DelegationCheck, { ok: true }>, localId: string): string[] {
  return check.serialize.filter((edge) => edge.localId === localId).map((edge) => edge.after);
}

// The delegators of an orchestrator's haril_delegate and its continuation.
function delegateTurns(
  context: TurnContext,
  input: DelegateInput,
  check: Extract<DelegationCheck, { ok: true }>,
): NewTurn[] {
  const { view, task, settings } = context;
  const turns: NewTurn[] = [];
  for (const delegation of input.delegations) {
    const model = pickModel(context, {
      archetype: "delegator",
      difficulty: delegation.difficulty,
      budgetTokens: delegation.budget.maxTokens,
      phase: "launch",
      proposed: delegation.model ?? null,
      role: delegation.role ?? null,
    });
    turns.push({
      key: delegation.localId,
      threadId: null,
      role: "delegator",
      layer: 2,
      kind: "plan",
      parentTaskId: task.taskId,
      localId: delegation.localId,
      goal: delegation.goal,
      description: delegation.description,
      agentRef: agentFor(view, "delegator"),
      model: model.model,
      modelPinned: model.pinned,
      difficulty: delegation.difficulty,
      difficultyReason: delegation.difficultyReason,
      priority: delegation.priority,
      budgetTokens: delegation.budget.maxTokens,
      timeoutMs: settings.limits.attemptTimeoutMs,
      surfaceWrite: [],
      surfaceRead: [],
      // A part that depends on another starts once the other reported done.
      dependsOn: [...delegation.dependsOn, ...serializedAfter(check, delegation.localId)].map(
        (on) => ({ on, kind: "completed" as const }),
      ),
    });
  }
  turns.push({
    ...continuationOf(context),
    dependsOn: input.delegations.map((item) => ({ on: item.localId, kind: "settled" as const })),
  });
  return turns;
}

// The executors and auditors of a delegator's haril_assign and its continuation. An
// assignment that names an escalated or blocked step continues that step's threads (the reformulation of 3.8).
function assignTurns(
  context: TurnContext,
  input: AssignInput,
  check: Extract<DelegationCheck, { ok: true }>,
): NewTurn[] {
  const { view, task, settings } = context;
  const steps = new Map(
    view
      .childThreads(task.threadId)
      .map((thread) => [view.turns(thread)[0]?.localId ?? "", thread]),
  );
  const turns: NewTurn[] = [];
  for (const assignment of input.assignments) {
    const existing = steps.get(assignment.localId);
    const firstTurn = existing === undefined ? undefined : view.turns(existing)[0];
    const latest = existing === undefined ? undefined : view.latest(existing);
    const auditorThread =
      latest === undefined ? undefined : view.auditorOf(latest.taskId)?.threadId;
    const executorModel = pickModel(context, {
      archetype: "executor",
      difficulty: assignment.difficulty,
      budgetTokens: assignment.budget.maxTokens,
      phase: "launch",
      proposed: assignment.model ?? null,
      role: assignment.role ?? null,
      sticky: latest?.model ?? null,
    });
    const auditorModel = pickModel(context, {
      archetype: "auditor",
      difficulty: assignment.difficulty,
      budgetTokens: assignment.budget.maxTokens,
      phase: "launch",
      avoid: executorModel.model,
      role: assignment.auditorRole ?? null,
    });
    const auditKey = `audit:${assignment.localId}`;
    turns.push({
      key: assignment.localId,
      threadId: existing ?? null,
      role: "executor",
      layer: 3,
      kind: "work",
      parentTaskId: firstTurn?.parentTaskId ?? task.taskId,
      localId: assignment.localId,
      goal: assignment.goal,
      description: assignment.instructions,
      agentRef: agentFor(view, "executor"),
      model: executorModel.model,
      modelPinned: executorModel.pinned,
      difficulty: assignment.difficulty,
      difficultyReason: assignment.difficultyReason,
      priority: 5,
      budgetTokens: assignment.budget.maxTokens,
      timeoutMs: settings.limits.attemptTimeoutMs,
      surfaceWrite: assignment.files.write,
      surfaceRead: assignment.files.read,
      // A step that depends on another (or that the Core serialized after it, 3.10) waits for its approval: it waits on
      // the other's auditor turn, which completes only when it approves.
      dependsOn: [...assignment.dependsOn, ...serializedAfter(check, assignment.localId)].map(
        (on) => ({ on: `audit:${on}`, kind: "completed" as const }),
      ),
    });
    turns.push({
      key: auditKey,
      threadId: auditorThread ?? null,
      role: "auditor",
      layer: 3,
      kind: "verify",
      parentTaskId: firstTurn?.parentTaskId ?? task.taskId,
      auditedTaskId: assignment.localId,
      localId: null,
      goal: `Audit ${assignment.localId} against its acceptance criteria`,
      description: "Judge the step's result against each of its acceptance criteria.",
      agentRef: agentFor(view, "auditor"),
      model: auditorModel.model,
      modelPinned: auditorModel.pinned,
      difficulty: assignment.difficulty,
      difficultyReason: assignment.difficultyReason,
      priority: 5,
      budgetTokens: auditorBudgetTokens(assignment.budget.maxTokens, settings.limits),
      timeoutMs: settings.limits.attemptTimeoutMs,
      surfaceWrite: [],
      surfaceRead: assignment.files.read,
      dependsOn: [{ on: assignment.localId, kind: "completed" }],
    });
  }
  turns.push({
    ...continuationOf(context),
    dependsOn: input.assignments.map((item) => ({
      on: `audit:${item.localId}`,
      kind: "settled" as const,
    })),
  });
  return turns;
}

// The executor's next turn and its auditor's (3.8: the relaunch). The dependents of the earlier auditor turn (the
// steps that wait for its approval, the delegator's continuation) move to the new auditor turn before the earlier one
// closes, so none of them runs on a rejected or failed attempt.
function relaunch(context: TurnContext, executor: Task, auditor: Task): () => void {
  return () => {
    context.store.workflows.applyTurns(context.epoch, {
      workflowId: context.view.workflow.workflowId,
      turns: [
        { ...turnLike(executor), key: "relaunch", dependsOn: [] },
        {
          ...turnLike(auditor),
          key: "relaunch:audit",
          parentTaskId: executor.parentTaskId,
          auditedTaskId: "relaunch",
          dependsOn: [{ on: "relaunch", kind: "completed" }],
        },
      ],
      inherit: [
        { from: executor.taskId, to: "relaunch", except: [auditor.taskId] },
        { from: auditor.taskId, to: "relaunch:audit" },
      ],
    });
  };
}

// `relaunchable` false settles the event without a relaunch, as the agent cap does; the replay reads a failure that no
// relaunch followed the same way.
function reworkEvent(
  context: TurnContext,
  executor: Task,
  event: ReworkEvent,
  relaunchable = true,
) {
  const { view, settings } = context;
  const state = view.rework(executor.threadId, settings.limits);
  const canRelaunch =
    relaunchable && view.workflow.agentsCreated + 2 <= settings.limits.maxAgentsPerWorkflow;
  return decideRework(state, event, settings.limits, canRelaunch);
}

function retryEvent(context: TurnContext, executor: Task, cause: string): () => void {
  return () => {
    context.store.events.append({
      aggregateType: "task",
      aggregateId: executor.taskId,
      type: "audit.retry",
      actorKind: "system",
      actorId: `runtime:${context.epoch}`,
      payload: {
        workflowId: context.view.workflow.workflowId,
        threadId: executor.threadId,
        cause,
      },
      projectId: context.view.workflow.projectId,
      taskId: executor.taskId,
    });
  };
}

function verdictOutput(verdict: VerdictInput): JsonObject {
  return { tool: "haril_verdict", verdict: verdict as unknown as JsonObject };
}

function unmetText(verdict: VerdictInput): string {
  const unmet = verdict.reasons.filter((reason) => !reason.ok).map((reason) => reason.criterion);
  return short(`rejected: ${unmet.join("; ") || "no criterion named"}`);
}

function orchestratorPlan(
  context: TurnContext,
  outcome: AgentOutcome,
  action: TurnAction | null,
  refusals: readonly string[],
): CommitPlan {
  const { store, epoch, view, task } = context;
  if (outcome.status !== "succeeded") {
    const completion = failureOf(context, outcome);
    return {
      before: [],
      completion,
      outcome: "failed",
      verdict: null,
      after: [setWorkflowFailed(context, `orchestrator_failed: ${codeOf(completion)}`)],
    };
  }
  if (action?.tool === "haril_delegate") {
    const check = recheck(context, action);
    if (typeof check === "string") {
      return {
        before: [],
        completion: failure(context, "delegation.refused_at_commit", check),
        outcome: "refused_at_commit",
        verdict: null,
        after: [setWorkflowFailed(context, "refused_at_commit")],
      };
    }
    const turns = delegateTurns(context, action.input, check);
    const firstPlan = !view.delegations.some((row) => row.tool === "haril_delegate");
    return {
      before: [
        () => {
          store.workflows.applyTurns(epoch, {
            workflowId: view.workflow.workflowId,
            turns,
            inherit: [{ from: task.taskId, to: "continuation" }],
            delegation: proposalRecord(context, "haril_delegate", action.input, action.input.memo),
            addStops: addedStops(context, check),
          });
        },
      ],
      completion: {
        runId: context.runId,
        outcome: "succeeded",
        result: { tool: "haril_delegate", delegations: action.input.delegations.length },
      },
      outcome: "delegated",
      verdict: null,
      after: firstPlan ? [stopAt(context, { type: "first_plan_applied" })] : [],
    };
  }
  if (action?.tool === "haril_request_audit") {
    const model = pickModel(context, {
      archetype: "auditor",
      difficulty: "medium",
      budgetTokens: FINAL_AUDIT_TOKENS,
      phase: "launch",
      avoid: task.model,
    });
    const finalAuditor: NewTurn = {
      key: "final-audit",
      threadId: null,
      role: "auditor",
      layer: 3,
      kind: "verify",
      parentTaskId: task.taskId,
      localId: null,
      goal: `Final audit: ${view.workflow.goal}`,
      description: "Judge whether the workflow's goal is met, from the delegators' reports.",
      agentRef: agentFor(view, "auditor"),
      model: model.model,
      modelPinned: model.pinned,
      difficulty: "medium",
      difficultyReason: "the whole workflow",
      priority: 5,
      budgetTokens: FINAL_AUDIT_TOKENS,
      timeoutMs: context.settings.limits.attemptTimeoutMs,
      surfaceWrite: [],
      surfaceRead: [],
      dependsOn: [],
    };
    return {
      before: [
        () => {
          store.workflows.applyTurns(epoch, {
            workflowId: view.workflow.workflowId,
            turns: [finalAuditor],
            delegation: proposalRecord(
              context,
              "haril_request_audit",
              action.input,
              short(action.input.summary),
            ),
          });
        },
      ],
      completion: {
        runId: context.runId,
        outcome: "succeeded",
        result: { tool: "haril_request_audit", outstanding: action.input.outstanding.length },
      },
      outcome: "requested_audit",
      verdict: null,
      after: [],
    };
  }
  if (action?.tool === "haril_abort") {
    return {
      before: [],
      completion: {
        runId: context.runId,
        outcome: "succeeded",
        result: { tool: "haril_abort", reason: action.input.reason },
      },
      outcome: "aborted",
      verdict: null,
      after: [setWorkflowFailed(context, `aborted: ${action.input.reason}`)],
    };
  }
  return {
    before: [],
    completion: noAction(context, "haril_delegate, haril_request_audit or haril_abort", refusals),
    outcome: "no_action",
    verdict: null,
    after: [setWorkflowFailed(context, "orchestrator_failed: delegation.no_action")],
  };
}

function delegatorPlan(
  context: TurnContext,
  outcome: AgentOutcome,
  action: TurnAction | null,
  refusals: readonly string[],
): CommitPlan {
  const { store, epoch, view, task } = context;
  if (outcome.status !== "succeeded") {
    return {
      before: [],
      completion: failureOf(context, outcome),
      outcome: "failed",
      verdict: null,
      after: [],
    };
  }
  if (action?.tool === "haril_assign") {
    const check = recheck(context, action);
    if (typeof check === "string") {
      // A refused proposal is the delegator's to answer.
      return {
        before: [],
        completion: failure(context, "delegation.refused_at_commit", check),
        outcome: "refused_at_commit",
        verdict: null,
        after: [],
      };
    }
    const turns = assignTurns(context, action.input, check);
    const continuation = view.turns(task.threadId)[0]?.taskId !== task.taskId;
    return {
      before: [
        () => {
          store.workflows.applyTurns(epoch, {
            workflowId: view.workflow.workflowId,
            turns,
            inherit: [{ from: task.taskId, to: "continuation" }],
            delegation: proposalRecord(context, "haril_assign", action.input, action.input.memo),
          });
        },
      ],
      completion: {
        runId: context.runId,
        outcome: "succeeded",
        result: { tool: "haril_assign", assignments: action.input.assignments.length },
      },
      outcome: continuation ? "reassigned" : "assigned",
      verdict: null,
      after: [],
    };
  }
  if (action?.tool === "haril_report") {
    const report = action.input;
    const localId = view.turns(task.threadId)[0]?.localId ?? task.threadId;
    const output: JsonObject = { tool: "haril_report", report: report as unknown as JsonObject };
    return {
      before: [],
      completion:
        report.status === "done"
          ? { runId: context.runId, outcome: "succeeded", result: output }
          : failure(context, `delegation.report_${report.status}`, short(report.summary), output),
      outcome: `reported_${report.status}`,
      verdict: null,
      after: [stopAt(context, { type: "node_closed", localId })],
    };
  }
  return {
    before: [],
    completion: noAction(context, "haril_assign or haril_report", refusals),
    outcome: "no_action",
    verdict: null,
    after: [],
  };
}

function executorPlan(context: TurnContext, outcome: AgentOutcome): CommitPlan {
  const { view, task } = context;
  if (outcome.status === "succeeded") {
    return {
      before: [],
      completion: completionFor(context.runId, outcome),
      outcome: "completed",
      verdict: null,
      after: [],
    };
  }
  const completion = failureOf(context, outcome);
  const step = reworkEvent(context, task, { type: "attempt_failed" });
  const auditor = view.auditorOf(task.taskId);
  const before =
    step.action === "retry" && auditor !== undefined
      ? [relaunch(context, task, auditor), retryEvent(context, task, "attempt_failed")]
      : [];
  return {
    before,
    completion,
    outcome: step.action === "retry" ? "failed_retry" : "failed",
    verdict: null,
    after: step.action === "fail" ? [stopAt(context, { type: "audit_exhausted" })] : [],
  };
}

function taskAuditPlan(
  context: TurnContext,
  outcome: AgentOutcome,
  action: TurnAction | null,
  refusals: readonly string[],
  executor: Task,
): CommitPlan {
  const { store, epoch, view, task } = context;
  const verdict =
    outcome.status === "succeeded" && action?.tool === "haril_verdict" ? action.input : null;
  const observed =
    verdict?.approved && view.workflow.baseBranch !== null
      ? executorEvidence(store, executor, task)
      : null;
  const accepted: VerdictInput | null =
    verdict === null
      ? null
      : observed?.ok === false
        ? {
            approved: false,
            reasons: [
              ...verdict.reasons,
              { criterion: "host implementation evidence", ok: false, evidence: observed.reason },
            ],
          }
        : verdict;
  const event: ReworkEvent =
    accepted === null
      ? { type: "attempt_failed" }
      : { type: "verdict", approved: accepted.approved };
  // An auditor that spent its token budget before its verdict judged nothing: relaunching the executor would redo work
  // no one found wanting and meet the same budget again, so the step settles without a relaunch.
  const budgetSpent =
    accepted === null && outcome.status === "failed" && outcome.code === "insufficient_quota";
  const step = reworkEvent(context, executor, event, !budgetSpent);
  const before: (() => void)[] = [];
  if (accepted !== null) {
    before.push(() => {
      store.workflows.recordAudit(epoch, {
        workflowId: view.workflow.workflowId,
        subjectTaskId: executor.taskId,
        auditorTaskId: task.taskId,
        scope: "task",
        verdict: accepted.approved ? "approved" : "rejected",
        reasons: accepted.reasons,
        reworkAction: step.action === "rerun" ? "ignore" : step.action,
      });
    });
  }
  if (step.action === "retry") {
    before.push(relaunch(context, executor, task));
    if (verdict === null) before.push(retryEvent(context, executor, "auditor_failed"));
  }
  const after = step.action === "fail" ? [stopAt(context, { type: "audit_exhausted" })] : [];
  if (accepted === null) {
    const completion =
      outcome.status === "succeeded"
        ? noAction(context, "haril_verdict", refusals)
        : failureOf(context, outcome);
    return { before, completion, outcome: "failed", verdict: null, after };
  }
  return {
    before,
    completion: accepted.approved
      ? {
          runId: context.runId,
          outcome: "succeeded",
          result: {
            ...verdictOutput(accepted),
            ...(observed?.ok ? { evidence: observed as unknown as JsonObject } : {}),
          },
        }
      : failure(
          context,
          observed?.ok === false ? "audit.evidence_missing" : "audit.rejected",
          observed?.ok === false ? observed.reason : unmetText(accepted),
          verdictOutput(accepted),
        ),
    outcome: accepted.approved ? "approved" : "rejected",
    verdict: accepted.approved ? "approved" : "rejected",
    after:
      step.action === "fail" && observed?.ok === false
        ? [setWorkflowFailed(context, `host_evidence_missing: ${observed.reason}`)]
        : after,
  };
}

function finalAuditPlan(
  context: TurnContext,
  outcome: AgentOutcome,
  action: TurnAction | null,
  refusals: readonly string[],
): CommitPlan {
  const { store, epoch, view, task, settings } = context;
  const verdict =
    outcome.status === "succeeded" && action?.tool === "haril_verdict" ? action.input : null;
  if (verdict === null) {
    const completion =
      outcome.status === "succeeded"
        ? noAction(context, "haril_verdict", refusals)
        : failureOf(context, outcome);
    return {
      before: [],
      completion,
      outcome: "failed",
      verdict: null,
      after: [setWorkflowFailed(context, `final_audit_failed: ${codeOf(completion)}`)],
    };
  }
  const workflowId = view.workflow.workflowId;
  if (verdict.approved) {
    const evidence = workflowEvidence(store, view.workflow, view.tasks, view.audits);
    if (!evidence.ok) {
      return {
        before: [],
        completion: failure(
          context,
          "audit.evidence_missing",
          evidence.reason,
          verdictOutput(verdict),
        ),
        outcome: "evidence_missing",
        verdict: "rejected",
        after: [setWorkflowFailed(context, `host_evidence_missing: ${evidence.reason}`)],
      };
    }
    return {
      before: [
        () => {
          store.workflows.recordAudit(epoch, {
            workflowId,
            subjectTaskId: null,
            auditorTaskId: task.taskId,
            scope: "workflow",
            verdict: "approved",
            reasons: verdict.reasons,
            reworkAction: "accept",
          });
        },
      ],
      completion: {
        runId: context.runId,
        outcome: "succeeded",
        result: { ...verdictOutput(verdict), evidence: evidence as unknown as JsonObject },
      },
      outcome: "approved",
      verdict: "approved",
      after: [
        () => {
          if (reachStop(store, epoch, workflowId, { type: "workflow_completing" })) return;
          if (store.workflows.get(workflowId)?.state === "running") {
            store.workflows.setState(epoch, {
              workflowId,
              state: "completed",
              reason: short(evidenceStatus(evidence)),
            });
          }
        },
      ],
    };
  }
  // 3.8: the orchestrator hears the findings in a continuation and may delegate corrections, within
  // maxEscalationsPerTask final rejections; past them the workflow fails.
  const rejectedBefore = view.audits.filter(
    (audit) => audit.scope === "workflow" && audit.verdict === "rejected",
  ).length;
  const escalate = rejectedBefore < settings.limits.maxEscalationsPerTask;
  const orchestrator = view.task(task.parentTaskId);
  const before: (() => void)[] = [
    () => {
      store.workflows.recordAudit(epoch, {
        workflowId,
        subjectTaskId: null,
        auditorTaskId: task.taskId,
        scope: "workflow",
        verdict: "rejected",
        reasons: verdict.reasons,
        reworkAction: escalate ? "escalate" : "fail",
      });
    },
  ];
  if (escalate && orchestrator !== undefined) {
    const latest = view.latest(orchestrator.threadId) ?? orchestrator;
    before.push(() => {
      store.workflows.applyTurns(epoch, {
        workflowId,
        turns: [
          {
            ...continuationOf({ ...context, task: latest }),
            dependsOn: [],
          },
        ],
      });
    });
  }
  return {
    before,
    completion: failure(context, "audit.rejected", unmetText(verdict), verdictOutput(verdict)),
    outcome: "rejected",
    verdict: "rejected",
    after:
      escalate && orchestrator !== undefined
        ? []
        : [setWorkflowFailed(context, "final_audit_rejected")],
  };
}

export function commitPlanOf(
  context: TurnContext,
  outcome: AgentOutcome,
  action: TurnAction | null,
  refusals: readonly string[] = [],
): CommitPlan {
  const { view, task } = context;
  // An ended workflow takes nothing more: the run closes with its own outcome and nothing follows it.
  if (ENDED.has(view.workflow.state)) {
    const completion =
      outcome.status === "succeeded"
        ? ({
            runId: context.runId,
            outcome: "succeeded",
            result: {
              ended: view.workflow.state,
              ...(action === null ? {} : { dropped: action.tool }),
            },
          } as RunCompletion)
        : failureOf(context, outcome);
    return { before: [], completion, outcome: "workflow_ended", verdict: null, after: [] };
  }
  switch (task.role) {
    case "orchestrator":
      return orchestratorPlan(context, outcome, action, refusals);
    case "delegator":
      return delegatorPlan(context, outcome, action, refusals);
    case "executor":
      return executorPlan(context, outcome);
    case "auditor": {
      const subject = view.task(task.auditedTaskId);
      return subject?.role === "executor"
        ? taskAuditPlan(context, outcome, action, refusals, subject)
        : finalAuditPlan(context, outcome, action, refusals);
    }
  }
}
