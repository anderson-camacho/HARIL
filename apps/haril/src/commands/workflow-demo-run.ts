import { createHash } from "node:crypto";
import {
  type AssignInput,
  type Assignment,
  type DelegateInput,
  type ReportInput,
  type Stop,
  type VerdictInput,
  validateDelegationToolInput,
} from "@haril/contracts";
import {
  type AutonomySettings,
  auditorBudgetTokens,
  type ClaimCandidate,
  canonicalJson,
  checkDelegation,
  checkVerdict,
  chooseModel,
  type DelegationArchetype,
  type DelegationCaller,
  type DelegationCheck,
  type DelegationLimits,
  type DelegationProposal,
  evaluateLiveness,
  INITIAL_REWORK,
  type LiveTask,
  type ModelRequest,
  type ModelSelectionContext,
  proposalFromAssign,
  proposalFromDelegate,
  type ReworkAction,
  type ReworkEvent,
  type ReworkState,
  type StopEvent,
  selectClaims,
  stepRework,
  stopFor,
  type WatchdogPolicy,
} from "@haril/core";
import type { NewTurn, Store, WorkflowAutonomy, WorkflowTaskRecord } from "@haril/core/ports";
import {
  type DelegatorReport,
  type ExecuteOutcome,
  type ExecutorOutcome,
  type FakeTurnCost,
  fakeAudit,
  fakeDelegate,
  fakeExecute,
  fakeOrchestrate,
} from "@haril/core/testing";
import { type ThreadView, threadsOf } from "./workflow-snapshot.js";

// The simulated three-layer workflow behind `haril workflow demo` (docs/modos-y-delegacion.md 9, the F1 stop). The
// fake agents propose; the Core rules of phase F1 decide (checkDelegation, chooseModel, selectClaims, the rework
// machine, evaluateLiveness, the stop rule); the store records every decision through its real SQLite path (the
// workflow.start command, applyTurns, claimNext, runs.complete, recordAudit, the usage log). Time is virtual: the loop
// jumps from one event (an attempt ending, a watchdog check) to the next, so a run of an hour takes milliseconds and
// the same seed always gives the same result. Several attempts are in flight at once, as phase F2's concurrent loop
// will run them, and every launch goes through selectClaims, so the limits hold by construction; the run records the
// peaks it saw so a test can check them. Nothing here calls a model.

export interface DemoClock {
  now(): number;
  set(ms: number): void;
}

export interface DemoSettings {
  readonly goal: string;
  readonly seed: number;
  readonly delegators: number;
  readonly executorsPerDelegator: number;
  readonly autonomy: WorkflowAutonomy;
  readonly limits: DelegationLimits;
  readonly policy: WatchdogPolicy;
  readonly orchestratorModel: string;
  readonly models: Omit<ModelSelectionContext, "now">;
  // Unique per run (an id), so two demos written to one database never share an idempotency key.
  readonly runKey: string;
}

interface DemoPeaks {
  readonly executors: number;
  readonly auditors: number;
  readonly delegators: number;
  readonly writers: number;
  // Live children (delegators of the orchestrator, executors of a delegator) of any one thread.
  readonly orchestratorChildren: number;
  readonly delegatorChildren: number;
  readonly live: number;
}

interface DemoCounts {
  readonly proposalsRefused: number;
  readonly retries: number;
  readonly escalations: number;
  readonly reformulations: number;
  readonly idleCloses: number;
  readonly failedNodes: number;
  readonly watchdogChecks: number;
  readonly substitutions: number;
  readonly attempts: number;
}

export interface DemoResult {
  readonly workflowId: string;
  readonly orderId: string;
  readonly peaks: DemoPeaks;
  readonly counts: DemoCounts;
  // The rework state each executor thread ended with.
  readonly rework: readonly ReworkState[];
}

interface Attempt {
  readonly task: WorkflowTaskRecord;
  readonly runId: string;
  readonly startedAt: number;
  // null: no progress until the watchdog closes it.
  readonly endsAt: number | null;
  lastCheckAt: number;
  nextCheckAt: number;
  idleStrikes: number;
  readonly prepared: Prepared;
}

type Prepared =
  | { readonly kind: "orchestrate_plan"; readonly cost: FakeTurnCost }
  | {
      readonly kind: "orchestrate_continuation";
      readonly reports: DelegatorReport[];
      readonly cost: FakeTurnCost;
    }
  | { readonly kind: "delegate_plan"; readonly input: AssignInput; readonly cost: FakeTurnCost }
  | {
      readonly kind: "delegate_continuation";
      readonly call: ReturnType<typeof fakeDelegate>["call"];
      readonly cost: FakeTurnCost;
    }
  | { readonly kind: "execute"; readonly outcome: ExecuteOutcome }
  | {
      readonly kind: "audit";
      readonly verdict: VerdictInput;
      readonly cost: FakeTurnCost;
      readonly subject: string | null;
    };

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled"]);
const MAX_STEPS = 100_000;
const DEMO_PROVIDER = "simulated";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function textHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function settled(task: WorkflowTaskRecord): boolean {
  return (
    TERMINAL_TASK.has(task.state) || (task.state === "blocked" && task.blockReason === "dep_failed")
  );
}

export function runDemoWorkflow(
  store: Store,
  epoch: number,
  clock: DemoClock,
  projectId: string,
  settings: DemoSettings,
): DemoResult {
  const { limits, policy } = settings;
  const attempts = new Map<string, Attempt>();
  const rework = new Map<string, ReworkState>();
  const assignments = new Map<string, Assignment>();
  const reformulated = new Map<string, string[]>();
  // Executor turns created by a relaunch (not by a reformulation).
  const relaunched = new Set<string>();
  const reports = new Map<string, ReportInput>();
  const fired: Stop[] = [];
  const peaks = {
    executors: 0,
    auditors: 0,
    delegators: 0,
    writers: 0,
    orchestratorChildren: 0,
    delegatorChildren: 0,
    live: 0,
  };
  const counts = {
    proposalsRefused: 0,
    retries: 0,
    escalations: 0,
    reformulations: 0,
    idleCloses: 0,
    failedNodes: 0,
    watchdogChecks: 0,
    substitutions: 0,
    attempts: 0,
  };
  let lastChangeAt = clock.now();
  let tokensSinceSweep = 0;

  // --- start: the workflow.start command, as `haril workflow start` will queue it, and the order behind it -------
  const projectRoot = store.projects
    .list()
    .find((project) => project.projectId === projectId)?.rootPath;
  if (projectRoot === undefined) throw new Error(`project ${projectId} vanished`);
  const planText = `1. Complete the demo goal: ${settings.goal}\n2. Verify the result.\n`;
  const instructions =
    "Run the simulated delegation steps and report their observed audit results.";
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      goal: settings.goal,
      model: settings.orchestratorModel,
      agent: "fake:orchestrate",
      autonomy: settings.autonomy,
      limits,
      budgetTokens: 200_000,
      timeoutMs: limits.attemptTimeoutMs,
      simulated: true,
      intake: {
        projectRoot,
        plan: {
          sourceId: "demo:scenario",
          revision: `seed:${settings.seed}`,
          text: planText,
          sha256: textHash(planText),
        },
        methodology: { id: "demo", instructions, sha256: textHash(instructions) },
      },
    },
    idempotencyKey: `workflow-demo:${settings.runKey}`,
    requestHash: sha256(settings),
  });
  const applied = store.commands.applyNext(epoch);
  if (applied?.outcome !== "applied" || applied.workflowId === undefined) {
    throw new Error(`workflow.start was rejected: ${applied?.reason ?? "nothing applied"}`);
  }
  const workflowId = applied.workflowId;
  const order = store.usageLog.appendOrder({
    mode: "delegacion",
    source: "cli",
    text: settings.goal,
    preview: null,
    workflowId,
    projectId,
  });
  const orderId = order.record.orderId;

  const workflow = () => {
    const record = store.workflows.get(workflowId);
    if (record === undefined) throw new Error(`workflow ${workflowId} vanished`);
    return record;
  };
  const tasks = () => store.workflows.tasks(workflowId);
  const threads = (): ThreadView[] => threadsOf(tasks());
  const threadOf = (taskId: string): ThreadView => {
    const found = threads().find((thread) => thread.turns.some((turn) => turn.taskId === taskId));
    if (found === undefined) throw new Error(`no thread holds ${taskId}`);
    return found;
  };
  const event = (type: string, aggregateId: string, payload: Readonly<Record<string, unknown>>) =>
    store.events.append({
      aggregateType: type.split(".")[0] ?? "workflow",
      aggregateId,
      type,
      actorKind: "system",
      actorId: `runtime:${epoch}`,
      payload: { workflowId, ...payload },
      projectId,
    });
  const modelContext = (): ModelSelectionContext => ({ ...settings.models, now: clock.now() });

  // A model for a new turn (3.11), or null when nothing can run: the workflow then fails with no_capacity.
  const pickModel = (request: ModelRequest): { model: string; pinned: boolean } | null => {
    const choice = chooseModel(request, modelContext());
    if (choice.kind !== "use") return null;
    if (choice.substitutedFrom !== null) {
      counts.substitutions += 1;
      event("model.substituted", workflowId, { from: choice.substitutedFrom, to: choice.model });
    }
    return { model: choice.model, pinned: choice.source === "pinned" };
  };

  const fail = (reason: string) => {
    if (workflow().state === "running")
      store.workflows.setState(epoch, { workflowId, state: "failed", reason });
  };

  // The stop rule (3.13): the first listed stop an event reaches pauses the workflow for the human.
  const reach = (stopEvent: StopEvent): void => {
    const current = workflow();
    if (current.state !== "running") return;
    const settingsNow: AutonomySettings = {
      mode: current.autonomy.mode,
      stops: current.autonomy.stops,
    };
    const stop = stopFor(settingsNow, stopEvent, fired);
    if (stop === null) return;
    fired.push(stop);
    store.workflows.setState(epoch, { workflowId, state: "awaiting_human", reason: stop });
  };

  const usageRow = (
    attempt: Attempt,
    cost: FakeTurnCost | null,
    outcome: string,
    verdict: "approved" | "rejected" | null = null,
  ) => {
    const { task } = attempt;
    store.usageLog.appendUsage({
      kind: "agent_run",
      orderId,
      projectId,
      workflowId,
      taskId: task.taskId,
      runId: attempt.runId,
      threadId: task.threadId,
      layer: task.layer,
      role: task.role,
      mode: "delegacion",
      provider: DEMO_PROVIDER,
      modelRequested: task.model,
      modelServed: task.model,
      modelPinned: task.modelPinned,
      tokensIn: cost?.tokensIn ?? null,
      tokensOut: cost?.tokensOut ?? null,
      startedAt: attempt.startedAt,
      endedAt: clock.now(),
      durationMs: clock.now() - attempt.startedAt,
      difficultyEst: task.difficulty,
      difficultyReason: task.difficultyReason,
      outcome,
      auditVerdict: verdict,
      // 1 for an executor attempt that is a relaunch after a rejection or an idle close, so a sum counts relaunches.
      retries: task.role === "executor" ? (relaunched.has(task.taskId) ? 1 : 0) : null,
      simulated: true,
      idempotencyKey: `workflow-demo:${attempt.runId}`,
    });
    tokensSinceSweep += (cost?.tokensIn ?? 0) + (cost?.tokensOut ?? 0);
    const used = store.usageLog
      .summary("workflow", { workflowId })
      .reduce((total, row) => total + row.tokensIn + row.tokensOut, 0);
    reach({ type: "budget_used", pct: (used / limits.maxWorkflowTokens) * 100 });
  };

  // The state checkDelegation reads for a calling thread.
  const delegationState = (caller: ThreadView) => {
    const all = tasks();
    const callerTurns = new Set(caller.turns.map((turn) => turn.taskId));
    const children = all.filter(
      (task) =>
        task.parentTaskId !== null &&
        callerTurns.has(task.parentTaskId) &&
        (task.role === "delegator" || task.role === "executor") &&
        task.threadId !== caller.threadId,
    );
    const current = workflow();
    return {
      workflow: {
        state: current.state,
        agentsCreated: current.agentsCreated,
        tokensCommitted: all.reduce((total, task) => total + task.budgetTokens, 0),
        autonomy: { mode: current.autonomy.mode, stops: current.autonomy.stops },
      },
      thread: {
        queuedChildren: children.filter((task) => !settled(task)).length,
        proposals: store.workflows
          .delegations(workflowId)
          .filter((row) => row.threadId === caller.threadId).length,
      },
      models: modelContext(),
    };
  };

  const check = (proposal: DelegationProposal, caller: ThreadView): DelegationCheck =>
    checkDelegation(proposal, delegationState(caller), limits);

  const refused = (caller: ThreadView, issues: readonly { code: string }[]) => {
    counts.proposalsRefused += 1;
    event("delegation.rejected", caller.threadId, {
      codes: issues.map((issue) => issue.code).join(","),
    });
  };

  const addedStops = (result: Extract<DelegationCheck, { ok: true }>): Stop[] => {
    const before = workflow().autonomy.stops;
    return result.autonomy.stops.filter((stop) => !before.includes(stop));
  };

  const serializedAfter = (
    result: Extract<DelegationCheck, { ok: true }>,
    localId: string,
  ): string[] =>
    result.serialize.filter((edge) => edge.localId === localId).map((edge) => edge.after);

  // --- applying the agents' calls ---------------------------------------------------------------------------------

  const applyDelegate = (
    attempt: Attempt,
    caller: ThreadView,
    input: DelegateInput,
    result: Extract<DelegationCheck, { ok: true }>,
  ) => {
    const turns: NewTurn[] = [];
    for (const delegation of input.delegations) {
      const model = pickModel({
        archetype: "delegator",
        difficulty: delegation.difficulty,
        budgetTokens: delegation.budget.maxTokens,
        phase: "launch",
        proposed: delegation.model ?? null,
      });
      if (model === null) return false;
      turns.push({
        key: delegation.localId,
        threadId: null,
        role: "delegator",
        layer: 2,
        kind: "plan",
        parentTaskId: attempt.task.taskId,
        localId: delegation.localId,
        goal: delegation.goal,
        description: delegation.description,
        agentRef: "fake:delegate",
        model: model.model,
        modelPinned: model.pinned,
        difficulty: delegation.difficulty,
        difficultyReason: delegation.difficultyReason,
        priority: delegation.priority,
        budgetTokens: delegation.budget.maxTokens,
        timeoutMs: limits.attemptTimeoutMs,
        surfaceWrite: [],
        surfaceRead: [],
        dependsOn: [...delegation.dependsOn, ...serializedAfter(result, delegation.localId)].map(
          (on) => ({
            on,
            kind: "completed" as const,
          }),
        ),
      });
    }
    turns.push({
      ...continuationOf(attempt.task, caller),
      dependsOn: input.delegations.map((delegation) => ({
        on: delegation.localId,
        kind: "settled" as const,
      })),
    });
    store.workflows.applyTurns(epoch, {
      workflowId,
      turns,
      inherit: [{ from: attempt.task.taskId, to: "continuation" }],
      delegation: {
        threadId: caller.threadId,
        parentTaskId: attempt.task.taskId,
        proposedByRunId: attempt.runId,
        tool: "haril_delegate",
        payloadHash: sha256(input),
        memo: input.memo,
      },
      addStops: addedStops(result),
    });
    return true;
  };

  // The next turn of a thread that delegated: same role and model, waiting for the children it just created.
  const continuationOf = (turn: WorkflowTaskRecord, caller: ThreadView): NewTurn => ({
    key: "continuation",
    threadId: caller.threadId,
    role: turn.role,
    layer: turn.layer,
    kind: turn.kind,
    parentTaskId: caller.turns[0]?.parentTaskId ?? null,
    localId: caller.turns[0]?.localId ?? null,
    goal: caller.turns[0]?.goal ?? turn.goal,
    description: `Continuation of ${caller.code}: read the results of your children and decide.`,
    agentRef: turn.agentRef,
    model: turn.model,
    modelPinned: turn.modelPinned,
    difficulty: turn.difficulty,
    difficultyReason: turn.difficultyReason,
    priority: turn.priority,
    budgetTokens: turn.budgetTokens,
    timeoutMs: turn.timeoutMs,
    surfaceWrite: [],
    surfaceRead: [],
    dependsOn: [],
  });

  // Executor and auditor turns for assignments; an assignment whose local id names an escalated thread of the caller
  // continues that thread (the reformulation of 3.8), every other one starts a new thread.
  const applyAssign = (
    attempt: Attempt,
    caller: ThreadView,
    input: AssignInput,
    result: Extract<DelegationCheck, { ok: true }>,
  ): boolean => {
    const all = threads();
    const callerTurns = new Set(caller.turns.map((turn) => turn.taskId));
    const executorThreads = all.filter(
      (thread) =>
        thread.role === "executor" && callerTurns.has(thread.turns[0]?.parentTaskId ?? ""),
    );
    const turns: NewTurn[] = [];
    const reuse = new Map<string, { executor: ThreadView; auditor: ThreadView | undefined }>();
    for (const assignment of input.assignments) {
      const existing = executorThreads.find(
        (thread) => thread.turns[0]?.localId === assignment.localId,
      );
      const auditorThread =
        existing === undefined
          ? undefined
          : all.find(
              (thread) =>
                thread.role === "auditor" &&
                thread.turns.some((turn) =>
                  existing.turns.some((executor) => executor.taskId === turn.auditedTaskId),
                ),
            );
      if (existing !== undefined)
        reuse.set(assignment.localId, { executor: existing, auditor: auditorThread });
      const executorModel = pickModel({
        archetype: "executor",
        difficulty: assignment.difficulty,
        budgetTokens: assignment.budget.maxTokens,
        phase: "launch",
        proposed: assignment.model ?? null,
      });
      if (executorModel === null) return false;
      const auditorModel = pickModel({
        archetype: "auditor",
        difficulty: assignment.difficulty,
        budgetTokens: assignment.budget.maxTokens,
        phase: "launch",
        avoid: executorModel.model,
      });
      if (auditorModel === null) return false;
      const executorKey = assignment.localId;
      const auditorKey = `audit:${assignment.localId}`;
      turns.push({
        key: executorKey,
        threadId: existing?.threadId ?? null,
        role: "executor",
        layer: 3,
        kind: "work",
        parentTaskId: existing?.turns[0]?.parentTaskId ?? attempt.task.taskId,
        localId: assignment.localId,
        goal: assignment.goal,
        description: assignment.instructions,
        agentRef: "fake:execute",
        model: executorModel.model,
        modelPinned: executorModel.pinned,
        difficulty: assignment.difficulty,
        difficultyReason: assignment.difficultyReason,
        priority: 5,
        budgetTokens: assignment.budget.maxTokens,
        timeoutMs: limits.attemptTimeoutMs,
        surfaceWrite: assignment.files.write,
        surfaceRead: assignment.files.read,
        dependsOn: [...assignment.dependsOn, ...serializedAfter(result, assignment.localId)].map(
          (on) => ({
            on,
            kind: "completed" as const,
          }),
        ),
      });
      turns.push({
        key: auditorKey,
        threadId: auditorThread?.threadId ?? null,
        role: "auditor",
        layer: 3,
        kind: "verify",
        parentTaskId: existing?.turns[0]?.parentTaskId ?? attempt.task.taskId,
        auditedTaskId: executorKey,
        localId: null,
        goal: `Audit ${assignment.localId} against its criteria`,
        description: `Judge the result against: ${assignment.acceptanceCriteria.join("; ")}`,
        agentRef: "fake:audit",
        model: auditorModel.model,
        modelPinned: auditorModel.pinned,
        difficulty: assignment.difficulty,
        difficultyReason: assignment.difficultyReason,
        priority: 5,
        budgetTokens: auditorBudgetTokens(assignment.budget.maxTokens, limits),
        timeoutMs: limits.attemptTimeoutMs,
        surfaceWrite: [],
        surfaceRead: assignment.files.read,
        dependsOn: [{ on: executorKey, kind: "completed" }],
      });
    }
    turns.push({
      ...continuationOf(attempt.task, caller),
      dependsOn: input.assignments.map((assignment) => ({
        on: `audit:${assignment.localId}`,
        kind: "settled" as const,
      })),
    });
    const made = store.workflows.applyTurns(epoch, {
      workflowId,
      turns,
      inherit: [{ from: attempt.task.taskId, to: "continuation" }],
      delegation: {
        threadId: caller.threadId,
        parentTaskId: attempt.task.taskId,
        proposedByRunId: attempt.runId,
        tool: "haril_assign",
        payloadHash: sha256(input),
        memo: input.memo,
      },
    });
    for (const assignment of input.assignments) {
      const threadId = made.threadIds[assignment.localId];
      if (threadId !== undefined) assignments.set(threadId, assignment);
      const reused = reuse.get(assignment.localId);
      if (reused !== undefined) {
        const step = stepRework(
          rework.get(reused.executor.threadId) ?? INITIAL_REWORK,
          { type: "reformulated" },
          limits,
        );
        rework.set(reused.executor.threadId, step.state);
        counts.reformulations += 1;
        reformulated.set(caller.threadId, [
          ...(reformulated.get(caller.threadId) ?? []),
          assignment.localId,
        ]);
      }
    }
    return true;
  };

  // The rework machine of one executor thread (3.8). A relaunch creates two agents; past the workflow cap the node fails
  // instead, so the limit holds.
  const decideRework = (
    threadId: string,
    reworkEvent: ReworkEvent,
  ): { state: ReworkState; action: ReworkAction } => {
    const step = stepRework(rework.get(threadId) ?? INITIAL_REWORK, reworkEvent, limits);
    if (step.action === "retry" && workflow().agentsCreated + 2 > limits.maxAgentsPerWorkflow) {
      return { state: { ...step.state, phase: "failed" }, action: "fail" };
    }
    return step;
  };

  // Applies a decision; a relaunch is the thread's next turn and its auditor's.
  const reworkAfter = (
    executorTurn: WorkflowTaskRecord,
    decision: { state: ReworkState; action: ReworkAction },
    auditorTurn: WorkflowTaskRecord | undefined,
  ): void => {
    const { action } = decision;
    rework.set(executorTurn.threadId, decision.state);
    if (action === "retry") {
      counts.retries += 1;
      relaunch(executorTurn, auditorTurn);
    } else if (action === "escalate") {
      counts.escalations += 1;
    } else if (action === "fail") {
      counts.failedNodes += 1;
      reach({ type: "audit_exhausted" });
    }
  };

  const relaunch = (
    executorTurn: WorkflowTaskRecord,
    auditorTurn: WorkflowTaskRecord | undefined,
  ) => {
    const all = tasks();
    const oldAuditor =
      auditorTurn ??
      all.find(
        (task) =>
          task.role === "auditor" &&
          task.dependsOn.some((dep) => dep.taskId === executorTurn.taskId),
      );
    if (oldAuditor === undefined)
      throw new Error(`executor turn ${executorTurn.taskId} has no auditor`);
    const verdictNote =
      auditorTurn === undefined
        ? "The previous attempt was closed by the watchdog: it showed no progress."
        : "The previous attempt was rejected by its auditor; its verdict is in the workflow's audits.";
    const made = store.workflows.applyTurns(epoch, {
      workflowId,
      turns: [
        {
          ...turnLike(executorTurn),
          key: "relaunch",
          description: `${executorTurn.description}\n${verdictNote}`,
          dependsOn: [],
        },
        {
          ...turnLike(oldAuditor),
          key: "relaunch:audit",
          parentTaskId: executorTurn.parentTaskId,
          auditedTaskId: "relaunch",
          dependsOn: [{ on: "relaunch", kind: "completed" }],
        },
      ],
      inherit: [
        { from: executorTurn.taskId, to: "relaunch", except: [oldAuditor.taskId] },
        { from: oldAuditor.taskId, to: "relaunch:audit" },
      ],
    });
    const relaunchId = made.taskIds.relaunch;
    if (relaunchId !== undefined) relaunched.add(relaunchId);
    event("audit.retry", executorTurn.taskId, {
      cause: auditorTurn === undefined ? "watchdog_idle" : "rejected",
      threadId: executorTurn.threadId,
    });
  };

  const turnLike = (task: WorkflowTaskRecord): Omit<NewTurn, "key" | "dependsOn"> => ({
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
  });

  // The outcomes the delegator's continuation reads: one per executor thread it created.
  const childOutcomes = (caller: ThreadView): ExecutorOutcome[] => {
    const callerTurns = new Set(caller.turns.map((turn) => turn.taskId));
    return threads()
      .filter(
        (thread) =>
          thread.role === "executor" && callerTurns.has(thread.turns[0]?.parentTaskId ?? ""),
      )
      .map((thread) => {
        const phase = rework.get(thread.threadId)?.phase;
        const status: ExecutorOutcome["status"] =
          phase === "approved"
            ? "done"
            : phase === "awaiting_reformulation"
              ? "escalated"
              : "failed";
        return { localId: thread.turns[0]?.localId ?? thread.code, status };
      });
  };

  // --- one attempt: prepared at its claim (so its duration is known), applied when it ends ---------------------------

  const prepare = (task: WorkflowTaskRecord, thread: ThreadView): Prepared => {
    const turnIndex = thread.turns.findIndex((turn) => turn.taskId === task.taskId) + 1;
    if (task.role === "orchestrator") {
      if (turnIndex === 1) {
        const plan = fakeOrchestrate({
          kind: "plan",
          goal: settings.goal,
          seed: settings.seed,
          delegators: settings.delegators,
          executorsPerDelegator: settings.executorsPerDelegator,
          previousRejection: [],
          makeMistake: true,
        });
        return { kind: "orchestrate_plan", cost: plan.cost };
      }
      const delegatorThreads = threads().filter((other) => other.role === "delegator");
      const delegatorReports: DelegatorReport[] = delegatorThreads.map((other) => {
        const report = reports.get(other.threadId);
        return {
          localId: other.turns[0]?.localId ?? other.code,
          status: report?.status ?? "failed",
          summary: report?.summary ?? "no report",
          issues: report?.issues ?? ["the delegator ended without a report"],
        };
      });
      const turn = fakeOrchestrate({
        kind: "continuation",
        goal: settings.goal,
        seed: settings.seed,
        memo: "",
        reports: delegatorReports,
      });
      return { kind: "orchestrate_continuation", reports: delegatorReports, cost: turn.cost };
    }
    if (task.role === "delegator") {
      const partId = thread.turns[0]?.localId ?? thread.code;
      if (turnIndex === 1) {
        const turn = fakeDelegate({
          kind: "plan",
          goal: task.goal,
          description: task.description,
          seed: settings.seed,
          partId,
          executors: settings.executorsPerDelegator,
        });
        if (turn.call.tool !== "haril_assign")
          throw new Error("fake:delegate planned without haril_assign");
        return { kind: "delegate_plan", input: turn.call.input, cost: turn.cost };
      }
      const turn = fakeDelegate({
        kind: "continuation",
        goal: task.goal,
        seed: settings.seed,
        partId,
        reformulated: reformulated.get(thread.threadId) ?? [],
        children: childOutcomes(thread),
      });
      return { kind: "delegate_continuation", call: turn.call, cost: turn.cost };
    }
    if (task.role === "executor") {
      return {
        kind: "execute",
        outcome: fakeExecute({
          seed: settings.seed,
          key: thread.code,
          goal: task.goal,
          instructions: task.description,
          attempt: turnIndex,
          // A thread that was escalated runs its next turns with the delegator's reformulated assignment.
          reformulated: (rework.get(thread.threadId)?.escalations ?? 0) > 0,
        }),
      };
    }
    // The audit target is independent of the auditor's structural parent and scheduling dependency.
    const subject = task.auditedTaskId;
    const subjectTask =
      subject === null ? undefined : tasks().find((other) => other.taskId === subject);
    const executorThread = subjectTask === undefined ? undefined : threadOf(subjectTask.taskId);
    const criteria =
      executorThread === undefined
        ? [`The goal is met: ${settings.goal}`]
        : (assignments.get(executorThread.threadId)?.acceptanceCriteria ?? ["The step is done"]);
    const complete =
      subjectTask === undefined
        ? [...reports.values()].every((report) => report.status === "done") && reports.size > 0
        : subjectTask.result?.complete === true;
    const audit = fakeAudit({
      seed: settings.seed,
      key: `${thread.code}:${turnIndex}`,
      scope: subjectTask === undefined ? "workflow" : "task",
      acceptanceCriteria: criteria,
      complete,
    });
    return {
      kind: "audit",
      verdict: audit.verdict,
      cost: audit.cost,
      subject: subjectTask?.taskId ?? null,
    };
  };

  const durationOf = (prepared: Prepared): number | null => {
    if (prepared.kind === "execute") {
      return prepared.outcome.outcome === "stalled" ? null : prepared.outcome.cost.durationMs;
    }
    return prepared.cost.durationMs;
  };

  const claim = (task: WorkflowTaskRecord): void => {
    const others = store.tasks
      .list()
      .filter((candidate) => candidate.state === "ready" && candidate.taskId !== task.taskId)
      .map((candidate) => candidate.taskId);
    const claimed = store.tasks.claimNext(epoch, [], others);
    if (claimed?.taskId !== task.taskId) throw new Error(`could not claim ${task.taskId}`);
    const thread = threadOf(task.taskId);
    const prepared = prepare(task, thread);
    const duration = durationOf(prepared);
    const now = clock.now();
    const nextCheckAt = now + policy.intervalMs;
    attempts.set(task.taskId, {
      task,
      runId: claimed.runId,
      startedAt: now,
      endsAt: duration === null ? null : now + duration,
      lastCheckAt: now,
      nextCheckAt,
      idleStrikes: 0,
      prepared,
    });
    store.workflows.scheduleCheck(epoch, task.taskId, nextCheckAt);
    counts.attempts += 1;
  };

  const completeRun = (attempt: Attempt, result: Readonly<Record<string, unknown>>) => {
    attempts.delete(attempt.task.taskId);
    store.runs.complete({ runId: attempt.runId, outcome: "succeeded", result });
    store.workflows.scheduleCheck(epoch, attempt.task.taskId, null);
    lastChangeAt = clock.now();
  };

  const finishOrchestratorPlan = (attempt: Attempt) => {
    const caller = threadOf(attempt.task.taskId);
    const callerInfo: DelegationCaller = {
      threadId: caller.threadId,
      archetype: "orchestrator",
      depth: 1,
    };
    let rejection: string[] = [];
    let cost = attempt.prepared.kind === "orchestrate_plan" ? attempt.prepared.cost : null;
    for (let call = 1; call <= 3; call++) {
      const turn = fakeOrchestrate({
        kind: "plan",
        goal: settings.goal,
        seed: settings.seed,
        delegators: settings.delegators,
        executorsPerDelegator: settings.executorsPerDelegator,
        previousRejection: rejection,
        makeMistake: true,
      });
      if (call > 1 && cost !== null) {
        cost = {
          ...cost,
          tokensIn: cost.tokensIn + turn.cost.tokensIn,
          tokensOut: cost.tokensOut + turn.cost.tokensOut,
        };
      }
      if (turn.call.tool !== "haril_delegate") break;
      const valid = validateDelegationToolInput("haril_delegate", turn.call.input);
      if (!valid.ok) {
        refused(caller, [{ code: "contract" }]);
        rejection = ["contract"];
        continue;
      }
      const result = check(proposalFromDelegate(callerInfo, valid.input), caller);
      if (!result.ok) {
        refused(caller, result.issues);
        rejection = result.issues.map((issue) => issue.code);
        continue;
      }
      if (!applyDelegate(attempt, caller, valid.input, result)) {
        completeRun(attempt, { tool: "haril_delegate", applied: false });
        usageRow(attempt, cost, "no_capacity");
        fail("no_capacity");
        return;
      }
      completeRun(attempt, { tool: "haril_delegate", delegations: valid.input.delegations.length });
      usageRow(attempt, cost, "delegated");
      reach({ type: "first_plan_applied" });
      return;
    }
    completeRun(attempt, { tool: "haril_delegate", applied: false });
    usageRow(attempt, cost, "proposal_refused");
    fail("plan_refused");
  };

  const finishDelegatorPlan = (
    attempt: Attempt,
    input: AssignInput,
    cost: FakeTurnCost,
    outcome = "assigned",
  ) => {
    const caller = threadOf(attempt.task.taskId);
    const callerInfo: DelegationCaller = {
      threadId: caller.threadId,
      archetype: "delegator",
      depth: 2,
    };
    const result = check(proposalFromAssign(callerInfo, input), caller);
    if (!result.ok) {
      refused(caller, result.issues);
      completeRun(attempt, { tool: "haril_assign", applied: false });
      usageRow(attempt, cost, "proposal_refused");
      return;
    }
    if (!applyAssign(attempt, caller, input, result)) {
      completeRun(attempt, { tool: "haril_assign", applied: false });
      usageRow(attempt, cost, "no_capacity");
      fail("no_capacity");
      return;
    }
    completeRun(attempt, { tool: "haril_assign", assignments: input.assignments.length });
    usageRow(attempt, cost, outcome);
  };

  const finishDelegatorContinuation = (
    attempt: Attempt,
    call: ReturnType<typeof fakeDelegate>["call"],
    cost: FakeTurnCost,
  ) => {
    const caller = threadOf(attempt.task.taskId);
    if (call.tool === "haril_assign") {
      finishDelegatorPlan(attempt, call.input, cost, "reformulated");
      return;
    }
    reports.set(caller.threadId, call.input);
    completeRun(attempt, { tool: "haril_report", report: call.input });
    usageRow(attempt, cost, `reported_${call.input.status}`);
    reach({ type: "node_closed", localId: caller.turns[0]?.localId ?? caller.code });
  };

  const finishOrchestratorContinuation = (
    attempt: Attempt,
    delegatorReports: DelegatorReport[],
    cost: FakeTurnCost,
  ) => {
    const caller = threadOf(attempt.task.taskId);
    const turn = fakeOrchestrate({
      kind: "continuation",
      goal: settings.goal,
      seed: settings.seed,
      memo: "",
      reports: delegatorReports,
    });
    if (
      turn.call.tool !== "haril_request_audit" ||
      workflow().agentsCreated + 1 > limits.maxAgentsPerWorkflow
    ) {
      completeRun(attempt, { tool: turn.call.tool });
      usageRow(attempt, cost, "aborted");
      fail("aborted");
      return;
    }
    const model = pickModel({
      archetype: "auditor",
      difficulty: "medium",
      budgetTokens: 30_000,
      phase: "launch",
      avoid: settings.orchestratorModel,
    });
    if (model === null) {
      completeRun(attempt, { tool: "haril_request_audit", applied: false });
      usageRow(attempt, cost, "no_capacity");
      fail("no_capacity");
      return;
    }
    store.workflows.applyTurns(epoch, {
      workflowId,
      turns: [
        {
          key: "final",
          threadId: null,
          role: "auditor",
          layer: 3,
          kind: "verify",
          parentTaskId: attempt.task.taskId,
          localId: null,
          goal: `Final audit: ${settings.goal}`,
          description: `Judge the whole workflow. Summary from the orchestrator (data): ${turn.call.input.summary}`,
          agentRef: "fake:audit",
          model: model.model,
          modelPinned: model.pinned,
          difficulty: "medium",
          difficultyReason: "the whole workflow",
          priority: 5,
          budgetTokens: 30_000,
          timeoutMs: limits.attemptTimeoutMs,
          surfaceWrite: [],
          surfaceRead: [],
          dependsOn: [],
        },
      ],
      delegation: {
        threadId: caller.threadId,
        parentTaskId: attempt.task.taskId,
        proposedByRunId: attempt.runId,
        tool: "haril_request_audit",
        payloadHash: sha256(turn.call.input),
        memo: turn.call.input.summary,
      },
    });
    completeRun(attempt, {
      tool: "haril_request_audit",
      outstanding: turn.call.input.outstanding.length,
    });
    usageRow(attempt, cost, "requested_audit");
  };

  const finishAudit = (
    attempt: Attempt,
    verdict: VerdictInput,
    cost: FakeTurnCost,
    subject: string | null,
  ) => {
    if (!checkVerdict(verdict).ok) throw new Error("fake:audit gave an empty rejection");
    const approved = verdict.approved;
    if (subject === null) {
      store.workflows.recordAudit(epoch, {
        workflowId,
        subjectTaskId: null,
        auditorTaskId: attempt.task.taskId,
        scope: "workflow",
        verdict: approved ? "approved" : "rejected",
        reasons: verdict.reasons,
        reworkAction: approved ? "accept" : "fail",
      });
      completeRun(attempt, { verdict: approved ? "approved" : "rejected" });
      usageRow(
        attempt,
        cost,
        approved ? "approved" : "rejected",
        approved ? "approved" : "rejected",
      );
      if (approved) {
        reach({ type: "workflow_completing" });
        if (workflow().state === "running")
          store.workflows.setState(epoch, { workflowId, state: "completed" });
      } else {
        const findings = verdict.reasons
          .filter((reason) => !reason.ok)
          .map((reason) => reason.criterion);
        const abort = fakeOrchestrate({
          kind: "final_rejected",
          goal: settings.goal,
          seed: settings.seed,
          findings,
        });
        fail(abort.call.tool === "haril_abort" ? `aborted: ${abort.call.input.reason}` : "aborted");
      }
      return;
    }
    const executorTurn = tasks().find((task) => task.taskId === subject);
    if (executorTurn === undefined) throw new Error(`no executor turn ${subject}`);
    const decision = decideRework(executorTurn.threadId, { type: "verdict", approved });
    store.workflows.recordAudit(epoch, {
      workflowId,
      subjectTaskId: subject,
      auditorTaskId: attempt.task.taskId,
      scope: "task",
      verdict: approved ? "approved" : "rejected",
      reasons: verdict.reasons,
      // A verdict never yields "rerun" (only a reformulation does).
      reworkAction: decision.action === "rerun" ? "ignore" : decision.action,
    });
    reworkAfter(executorTurn, decision, attempt.task);
    completeRun(attempt, { verdict: approved ? "approved" : "rejected" });
    usageRow(attempt, cost, approved ? "approved" : "rejected", approved ? "approved" : "rejected");
  };

  const finish = (attempt: Attempt): void => {
    const { prepared } = attempt;
    switch (prepared.kind) {
      case "orchestrate_plan":
        finishOrchestratorPlan(attempt);
        return;
      case "orchestrate_continuation":
        finishOrchestratorContinuation(attempt, prepared.reports, prepared.cost);
        return;
      case "delegate_plan":
        finishDelegatorPlan(attempt, prepared.input, prepared.cost);
        return;
      case "delegate_continuation":
        finishDelegatorContinuation(attempt, prepared.call, prepared.cost);
        return;
      case "execute": {
        if (prepared.outcome.outcome !== "succeeded") return;
        const { complete, summary, cost } = prepared.outcome;
        completeRun(attempt, { complete, summary });
        usageRow(attempt, cost, complete ? "completed" : "incomplete");
        return;
      }
      case "audit":
        finishAudit(attempt, prepared.verdict, prepared.cost, prepared.subject);
    }
  };

  // The watchdog closes an attempt that showed no progress (3.16): its process is killed, the attempt counts as failed
  // and the rework machine decides what follows, so an idle close cannot open a loop either.
  const closeIdle = (attempt: Attempt, signals: readonly string[]) => {
    attempts.delete(attempt.task.taskId);
    store.runs.complete({
      runId: attempt.runId,
      outcome: "failed",
      error: { code: "watchdog.idle", message: "no progress in the watchdog's window" },
      endCause: "timeout",
    });
    store.workflows.scheduleCheck(epoch, attempt.task.taskId, null);
    counts.idleCloses += 1;
    lastChangeAt = clock.now();
    event("watchdog.closed", attempt.task.taskId, { verdict: "idle", signals: signals.join(",") });
    usageRow(attempt, null, "closed_idle");
    if (attempt.task.role === "executor") {
      reworkAfter(
        attempt.task,
        decideRework(attempt.task.threadId, { type: "attempt_failed" }),
        undefined,
      );
    }
  };

  const checkAttempt = (attempt: Attempt) => {
    const now = clock.now();
    const stalled = attempt.endsAt === null;
    const decision = evaluateLiveness(
      {
        kind: "attempt",
        workflowState: workflow().state,
        parentTerminal: false,
        awaitingHuman: false,
        coolingUntil: null,
        windowStart: attempt.lastCheckAt,
        tokensInWindow: stalled ? 0 : 1,
        lastToolCallAt: null,
        lastChildChangeAt: null,
        lastFileChangeAt: null,
        modelRequestOpen: !stalled,
        liveWork: 0,
        idleStrikes: attempt.idleStrikes,
      },
      now,
      policy,
    );
    counts.watchdogChecks += 1;
    event("watchdog.checked", attempt.task.taskId, {
      kind: "attempt",
      verdict: decision.verdict,
      signals: decision.signals.join(","),
    });
    if (decision.action === "close") {
      closeIdle(attempt, decision.signals);
      return;
    }
    attempt.idleStrikes = decision.idleStrikes;
    attempt.lastCheckAt = now;
    attempt.nextCheckAt = decision.nextCheckAt ?? now + policy.intervalMs;
    store.workflows.scheduleCheck(epoch, attempt.task.taskId, attempt.nextCheckAt);
  };

  // Every interval, layer 1 asks each waiting delegator thread (by its subtree) and the workflow asks itself.
  let lastSweepAt = clock.now();
  let workflowStrikes = 0;
  const sweep = (): boolean => {
    const now = clock.now();
    const all = tasks();
    const live = all.filter((task) => task.state === "running" || task.state === "ready");
    for (const thread of threads().filter((other) => other.role === "delegator")) {
      const latest = thread.turns[thread.turns.length - 1];
      if (latest === undefined || latest.state !== "pending") continue;
      const subtree = descendants(thread, threads());
      const decision = evaluateLiveness(
        {
          kind: "thread",
          workflowState: workflow().state,
          parentTerminal: false,
          awaitingHuman: false,
          coolingUntil: null,
          windowStart: lastSweepAt,
          tokensInWindow: 0,
          lastToolCallAt: null,
          lastChildChangeAt: lastChangeAt,
          lastFileChangeAt: null,
          modelRequestOpen: false,
          liveWork: live.filter((task) => subtree.has(task.threadId)).length,
          idleStrikes: 0,
        },
        now,
        policy,
      );
      counts.watchdogChecks += 1;
      event("watchdog.checked", thread.threadId, {
        kind: "thread",
        verdict: decision.verdict,
        signals: decision.signals.join(","),
      });
    }
    const decision = evaluateLiveness(
      {
        kind: "workflow",
        workflowState: workflow().state,
        parentTerminal: false,
        awaitingHuman: false,
        coolingUntil: null,
        windowStart: lastSweepAt,
        tokensInWindow: tokensSinceSweep,
        lastToolCallAt: null,
        lastChildChangeAt: lastChangeAt,
        lastFileChangeAt: null,
        modelRequestOpen: [...attempts.values()].some((attempt) => attempt.endsAt !== null),
        liveWork: live.length,
        idleStrikes: workflowStrikes,
      },
      now,
      policy,
    );
    counts.watchdogChecks += 1;
    event("watchdog.checked", workflowId, {
      kind: "workflow",
      verdict: decision.verdict,
      signals: decision.signals.join(","),
    });
    workflowStrikes = decision.idleStrikes;
    lastSweepAt = now;
    tokensSinceSweep = 0;
    if (decision.action === "close") {
      fail("stalled");
      return false;
    }
    return true;
  };

  // --- the loop -----------------------------------------------------------------------------------------------------

  // The live attempts by role, writers and live children per parent thread, as selectClaims counts them (reading L1:
  // an auditor is not a live child).
  const recordPeaks = (byId: ReadonlyMap<string, WorkflowTaskRecord>): void => {
    const live = [...attempts.values()].map((attempt) => attempt.task);
    const byRole = (role: DelegationArchetype) => live.filter((task) => task.role === role).length;
    peaks.executors = Math.max(peaks.executors, byRole("executor"));
    peaks.auditors = Math.max(peaks.auditors, byRole("auditor"));
    peaks.delegators = Math.max(peaks.delegators, byRole("delegator"));
    peaks.writers = Math.max(
      peaks.writers,
      live.filter((task) => task.surfaceWrite.length > 0).length,
    );
    peaks.live = Math.max(peaks.live, live.length);
    const perParent = new Map<string, { role: DelegationArchetype; count: number }>();
    for (const task of live) {
      if (task.role === "auditor" || task.parentTaskId === null) continue;
      const parent = byId.get(task.parentTaskId);
      if (parent === undefined) continue;
      const entry = perParent.get(parent.threadId) ?? { role: parent.role, count: 0 };
      perParent.set(parent.threadId, { role: entry.role, count: entry.count + 1 });
    }
    for (const { role, count } of perParent.values()) {
      if (role === "orchestrator")
        peaks.orchestratorChildren = Math.max(peaks.orchestratorChildren, count);
      if (role === "delegator") peaks.delegatorChildren = Math.max(peaks.delegatorChildren, count);
    }
  };

  const launch = (): void => {
    store.tasks.promote();
    const all = tasks();
    const byId = new Map(all.map((task) => [task.taskId, task]));
    const parentOf = (task: WorkflowTaskRecord) =>
      task.parentTaskId === null ? undefined : byId.get(task.parentTaskId);
    const ready: ClaimCandidate[] = all
      .filter((task) => task.state === "ready")
      .map((task) => ({
        taskId: task.taskId,
        threadId: task.threadId,
        parentThreadId: parentOf(task)?.threadId ?? null,
        parentArchetype: parentOf(task)?.role ?? null,
        archetype: task.role,
        priority: task.priority,
        createdSeq: task.createdSeq,
        writeSurface: task.surfaceWrite,
        started: task.attempt > 0,
      }));
    const running: LiveTask[] = [...attempts.values()].map(({ task }) => ({
      taskId: task.taskId,
      threadId: task.threadId,
      parentThreadId: parentOf(task)?.threadId ?? null,
      archetype: task.role,
      writeSurface: task.surfaceWrite,
    }));
    const selection = selectClaims(
      {
        workflowState: workflow().state,
        ready,
        running,
        tasksStarted: all.filter((task) => task.attempt > 0).length,
      },
      limits,
    );
    for (const plan of selection.claims) {
      const task = byId.get(plan.taskId);
      if (task !== undefined) claim(task);
    }
    recordPeaks(byId);
  };

  const start = clock.now();
  let nextSweepAt = start + policy.intervalMs;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (workflow().state !== "running") break;
    launch();
    if (attempts.size === 0) {
      // Nothing runs and nothing could start: the workflow can no longer move.
      fail("stalled");
      break;
    }
    let next = nextSweepAt;
    for (const attempt of attempts.values()) {
      if (attempt.endsAt !== null) next = Math.min(next, attempt.endsAt);
      next = Math.min(next, attempt.nextCheckAt);
    }
    clock.set(next);
    store.runtime.heartbeat(epoch, 600_000);
    if (next - start > limits.maxWorkflowWallMs) {
      fail("wall_time");
      break;
    }
    const ending = [...attempts.values()]
      .filter((attempt) => attempt.endsAt === next)
      .sort((a, b) => a.task.createdSeq - b.task.createdSeq);
    for (const attempt of ending) {
      if (workflow().state !== "running") break;
      finish(attempt);
    }
    if (workflow().state !== "running") break;
    for (const attempt of [...attempts.values()].sort(
      (a, b) => a.task.createdSeq - b.task.createdSeq,
    )) {
      if (attempt.nextCheckAt <= clock.now() && attempts.has(attempt.task.taskId))
        checkAttempt(attempt);
    }
    if (clock.now() >= nextSweepAt) {
      if (!sweep()) break;
      nextSweepAt += policy.intervalMs;
    }
  }
  if (workflow().state === "running") fail("step_limit");

  // A stop, a failure or the end leaves attempts in flight: they return to the queue, uncharged, as a stopping runtime
  // leaves them (ARCH 4.2); the workflow's state keeps them from running until a human continues it (phase F2).
  for (const attempt of attempts.values()) store.runs.cancel(attempt.runId, "shutdown");
  attempts.clear();

  return {
    workflowId,
    orderId,
    peaks: { ...peaks },
    counts: { ...counts },
    rework: [...rework.values()],
  };
}

function descendants(root: ThreadView, all: readonly ThreadView[]): Set<string> {
  const found = new Set<string>();
  const queue = [root.threadId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const thread of all) {
      if (thread.parentThreadId === current && !found.has(thread.threadId)) {
        found.add(thread.threadId);
        queue.push(thread.threadId);
      }
    }
  }
  return found;
}
