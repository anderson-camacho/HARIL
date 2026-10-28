import {
  type AssignInput,
  type Assignment,
  type DelegateInput,
  type Delegation,
  DIFFICULTIES,
  type ReportInput,
  type Stop,
} from "@haril/contracts";
import {
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_QUOTA_POLICY,
  type DelegationLimits,
  type ModelSelectionContext,
  type ReworkState,
  type ReworkTurn,
  replayRework,
} from "@haril/core";
import type {
  AuditRecord,
  DelegationAuditRequest,
  DelegationChildOutcome,
  DelegationRecord,
  DelegationVerdictView,
  JsonObject,
  Store,
  WorkflowRecord,
  WorkflowTaskRecord,
} from "@haril/core/ports";

// One workflow as the runtime reads it from the store (docs/modos-y-delegacion.md 3.3 to 3.8): its turns grouped in
// threads, its audits and its applied proposals, with the derivations the runtime needs: a thread's assignment and memo,
// an executor's rework state (replayed, never kept only in memory, 3.8), what each child ended with, and the limits and
// models the workflow runs with. Read-only: every decision is recorded elsewhere, in one transaction.

export type Task = WorkflowTaskRecord;

// The models a child may run on (3.11): the catalog, the difficulty table, the quota and the cooldowns.
export type DelegationModels = Omit<ModelSelectionContext, "now" | "largeTaskTokens">;

export interface DelegationOptions {
  // The limits of a workflow that started without a full snapshot (P11); default DEFAULT_DELEGATION_LIMITS.
  readonly limits?: DelegationLimits;
  // The catalog, table and quota of the children's models, fixed or read at each decision (phase F6: the live catalog,
  // the quota samples and the cooldowns change while a workflow runs); default: the orchestrator's model only.
  readonly models?:
    | DelegationModels
    | ((now: number, workflow: WorkflowRecord) => DelegationModels);
  // The reasoning level a model runs at when nothing asks for one (the gateway's default level), when known.
  readonly levelOf?: (ref: string) => string | null;
}

export interface WorkflowSettings {
  readonly limits: DelegationLimits;
  readonly models: (now: number) => ModelSelectionContext;
}

const TERMINAL_TASK = new Set(["completed", "failed", "cancelled"]);

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// The workflow's limits: its snapshot (P11) over the runtime's, key by key; a missing or malformed value keeps the
// runtime's, so a partial snapshot never weakens a limit to nothing.
function limitsOf(snapshot: JsonObject, base: DelegationLimits): DelegationLimits {
  const record = snapshot as Record<string, unknown>;
  const nested = <T extends Record<string, number>>(key: string, fallback: T): T => {
    const value = record[key];
    if (typeof value !== "object" || value === null) return fallback;
    const out: Record<string, number> = {};
    for (const [name, number] of Object.entries(fallback)) {
      out[name] = positive((value as Record<string, unknown>)[name], number);
    }
    return out as T;
  };
  return {
    maxActiveChildren: nested("maxActiveChildren", { ...base.maxActiveChildren }),
    maxQueuedTasksPerThread: positive(record.maxQueuedTasksPerThread, base.maxQueuedTasksPerThread),
    maxProposalsPerThread: positive(record.maxProposalsPerThread, base.maxProposalsPerThread),
    maxConcurrent: nested("maxConcurrent", { ...base.maxConcurrent }),
    maxAgentsPerWorkflow: positive(record.maxAgentsPerWorkflow, base.maxAgentsPerWorkflow),
    maxDepth: positive(record.maxDepth, base.maxDepth),
    maxAuditRetries: positive(record.maxAuditRetries, base.maxAuditRetries),
    maxEscalationsPerTask: positive(record.maxEscalationsPerTask, base.maxEscalationsPerTask),
    maxWorkflowTokens: positive(record.maxWorkflowTokens, base.maxWorkflowTokens),
    maxWorkflowWallMs: positive(record.maxWorkflowWallMs, base.maxWorkflowWallMs),
    largeTaskTokens: positive(record.largeTaskTokens, base.largeTaskTokens),
    attemptTimeoutMs: positive(record.attemptTimeoutMs, base.attemptTimeoutMs),
    minAuditorTokens: positive(record.minAuditorTokens, base.minAuditorTokens),
  };
}

// Without a catalog (simulated agents, or a gateway that has not answered yet), every child runs on the orchestrator's
// model (the one the user chose), and a model a parent proposes must be that one.
export function defaultModels(orchestratorModel: string): DelegationModels {
  const classes = Object.fromEntries(
    DIFFICULTIES.map((difficulty) => [difficulty, { minSuccessRate: 0, order: [] }]),
  ) as unknown as ModelSelectionContext["table"]["classes"];
  return {
    catalog: [
      {
        ref: orchestratorModel,
        quotaKey: orchestratorModel.split("/")[0] ?? orchestratorModel,
        hasKey: true,
        coolingUntil: null,
      },
    ],
    allow: {},
    pinned: {},
    quota: {},
    table: { classes, models: {} },
    stats: {},
    policy: DEFAULT_QUOTA_POLICY,
  };
}

export function workflowSettings(
  workflow: WorkflowRecord,
  options: DelegationOptions | undefined,
): WorkflowSettings {
  const limits = limitsOf(workflow.limits, options?.limits ?? DEFAULT_DELEGATION_LIMITS);
  const source = options?.models;
  return {
    limits,
    models: (now) => ({
      ...(source === undefined
        ? defaultModels(workflow.orchestratorModel)
        : typeof source === "function"
          ? source(now, workflow)
          : source),
      now,
      largeTaskTokens: limits.largeTaskTokens,
    }),
  };
}

// The text a turn answered with: a real agent's text or a fake's summary.
export function resultText(result: JsonObject | null): string | null {
  if (result === null) return null;
  if (typeof result.text === "string") return result.text;
  if (typeof result.summary === "string") return result.summary;
  return null;
}

function isAuditRequest(value: unknown): value is DelegationAuditRequest {
  const record = value as Record<string, unknown> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.summary === "string" &&
    Array.isArray(record.outstanding) &&
    record.outstanding.every((item) => typeof item === "string")
  );
}

function isReport(value: unknown): value is ReportInput {
  const record = value as Record<string, unknown> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    (record.status === "done" || record.status === "partial" || record.status === "failed") &&
    typeof record.summary === "string" &&
    Array.isArray(record.issues)
  );
}

export class WorkflowView {
  readonly workflow: WorkflowRecord;
  readonly tasks: readonly Task[];
  readonly audits: readonly AuditRecord[];
  readonly delegations: readonly DelegationRecord[];
  private readonly store: Pick<Store, "tasks">;
  private readonly byId: ReadonlyMap<string, Task>;
  private readonly byThread: ReadonlyMap<string, readonly Task[]>;
  private readonly delegationById: ReadonlyMap<string, DelegationRecord>;

  private constructor(store: Pick<Store, "workflows" | "tasks">, workflow: WorkflowRecord) {
    this.store = store;
    this.workflow = workflow;
    this.tasks = store.workflows.tasks(workflow.workflowId);
    this.audits = store.workflows.audits(workflow.workflowId);
    this.delegations = store.workflows.delegations(workflow.workflowId);
    this.byId = new Map(this.tasks.map((task) => [task.taskId, task]));
    const threads = new Map<string, Task[]>();
    for (const task of this.tasks) {
      const list = threads.get(task.threadId) ?? [];
      list.push(task);
      threads.set(task.threadId, list);
    }
    this.byThread = threads;
    this.delegationById = new Map(this.delegations.map((row) => [row.delegationId, row]));
  }

  static load(
    store: Pick<Store, "workflows" | "tasks">,
    workflowId: string,
  ): WorkflowView | undefined {
    const workflow = store.workflows.get(workflowId);
    return workflow === undefined ? undefined : new WorkflowView(store, workflow);
  }

  task(taskId: string | null): Task | undefined {
    return taskId === null ? undefined : this.byId.get(taskId);
  }

  // The turns of a thread in creation order.
  turns(threadId: string): readonly Task[] {
    return this.byThread.get(threadId) ?? [];
  }

  latest(threadId: string): Task | undefined {
    const turns = this.turns(threadId);
    return turns[turns.length - 1];
  }

  rootThreadId(): string | null {
    return this.task(this.workflow.rootTaskId)?.threadId ?? null;
  }

  parentThreadId(threadId: string): string | null {
    return this.task(this.turns(threadId)[0]?.parentTaskId ?? null)?.threadId ?? null;
  }

  // The threads a thread created (delegators of the orchestrator, executors of a delegator), auditors left out, in
  // creation order.
  childThreads(threadId: string): string[] {
    const own = new Set(this.turns(threadId).map((turn) => turn.taskId));
    const out: string[] = [];
    for (const [child, turns] of this.byThread) {
      const first = turns[0];
      if (first === undefined || first.role === "auditor" || child === threadId) continue;
      if (first.parentTaskId !== null && own.has(first.parentTaskId)) out.push(child);
    }
    return out;
  }

  // The auditor turn created with an executor turn.
  auditorOf(executorTurnId: string): Task | undefined {
    return this.tasks.find(
      (task) => task.role === "auditor" && task.auditedTaskId === executorTurnId,
    );
  }

  auditOfAuditor(auditorTurnId: string): AuditRecord | undefined {
    return this.audits.find((audit) => audit.auditorTaskId === auditorTurnId);
  }

  // The proposal behind a thread's latest turn that a proposal created (its first turn, or a reformulation).
  proposalOf(threadId: string): DelegationRecord | undefined {
    const turns = [...this.turns(threadId)].reverse();
    const made = turns.find((turn) => turn.delegationId !== null);
    return made === undefined ? undefined : this.delegationById.get(made.delegationId as string);
  }

  assignmentOf(executorThreadId: string): Assignment | undefined {
    const localId = this.turns(executorThreadId)[0]?.localId;
    const payload = this.proposalOf(executorThreadId)?.payload as AssignInput | null | undefined;
    return payload?.assignments?.find((item) => item.localId === localId);
  }

  delegationOf(delegatorThreadId: string): Delegation | undefined {
    const localId = this.turns(delegatorThreadId)[0]?.localId;
    const payload = this.proposalOf(delegatorThreadId)?.payload as DelegateInput | null | undefined;
    return payload?.delegations?.find((item) => item.localId === localId);
  }

  // The orchestrator's haril_request_audit behind a final auditor turn (3.8): its summary and outstanding list, as the
  // proposal that created the turn stored them; null for any other turn.
  auditRequestOf(auditorTurn: Task): DelegationAuditRequest | null {
    const row =
      auditorTurn.delegationId === null
        ? undefined
        : this.delegationById.get(auditorTurn.delegationId);
    if (row?.tool !== "haril_request_audit" || !isAuditRequest(row.payload)) return null;
    return { summary: row.payload.summary, outstanding: [...row.payload.outstanding] };
  }

  // The memo of the last proposal this thread applied (3.7).
  memoOf(threadId: string): string | null {
    const own = this.delegations.filter((row) => row.threadId === threadId);
    return own[own.length - 1]?.memo ?? null;
  }

  // Applied haril_delegate and haril_assign proposals of a thread (checkDelegation's maxProposalsPerThread).
  proposalCount(threadId: string): number {
    return this.delegations.filter(
      (row) => row.threadId === threadId && row.tool !== "haril_request_audit",
    ).length;
  }

  tokensCommitted(): number {
    return this.tasks.reduce((sum, task) => sum + task.budgetTokens, 0);
  }

  // How an executor turn's attempt ended, for the rework replay: its auditor's verdict, "failed" for a failed attempt
  // or an auditor that ended without a verdict (provisional, 3.8: it counts like a failed attempt), null while running.
  turnOutcome(executorTurn: Task): ReworkTurn["outcome"] {
    if (executorTurn.state === "failed") return "failed";
    if (executorTurn.state !== "completed") return null;
    const auditor = this.auditorOf(executorTurn.taskId);
    if (auditor === undefined) return null;
    const audit = this.auditOfAuditor(auditor.taskId);
    if (audit !== undefined) return audit.verdict;
    return auditor.state === "failed" || auditor.state === "cancelled" ? "failed" : null;
  }

  reworkTurns(executorThreadId: string): ReworkTurn[] {
    return this.turns(executorThreadId).map((turn) => ({
      byProposal: turn.delegationId !== null,
      outcome: this.turnOutcome(turn),
    }));
  }

  rework(executorThreadId: string, limits: DelegationLimits): ReworkState {
    return replayRework(this.reworkTurns(executorThreadId), limits);
  }

  // A later turn of the thread came from a proposal: it was reformulated or reassigned once.
  reassigned(threadId: string): boolean {
    return this.turns(threadId).some((turn, index) => index > 0 && turn.delegationId !== null);
  }

  verdictsOn(executorThreadId: string): DelegationVerdictView[] {
    const turns = new Set(this.turns(executorThreadId).map((turn) => turn.taskId));
    return this.audits
      .filter((audit) => audit.subjectTaskId !== null && turns.has(audit.subjectTaskId))
      .map((audit) => ({ verdict: audit.verdict, reasons: audit.reasons }));
  }

  // A delegator's report: the result of a turn that reported done, or the output kept with a partial or failed one.
  reportOf(delegatorThreadId: string): ReportInput | undefined {
    for (const turn of [...this.turns(delegatorThreadId)].reverse()) {
      if (turn.state === "completed" && isReport(turn.result?.report)) return turn.result.report;
      if (turn.state === "failed") {
        const output = this.store.tasks.get(turn.taskId)?.error?.output;
        if (isReport(output?.report)) return output.report;
      }
    }
    return undefined;
  }

  label(threadId: string): string {
    const first = this.turns(threadId)[0];
    if (first === undefined) return threadId;
    if (first.role === "orchestrator") return "orchestrator";
    if (first.role === "delegator") return first.localId ?? threadId;
    if (first.role === "executor") {
      const parent = this.parentThreadId(threadId);
      const part = parent === null ? "" : `${this.label(parent)}/`;
      return `${part}${first.localId ?? threadId}`;
    }
    const subject = this.task(first.auditedTaskId);
    return subject?.role === "executor"
      ? `audit of ${this.label(subject.threadId)}`
      : "final audit";
  }

  executorOutcome(threadId: string, limits: DelegationLimits): DelegationChildOutcome {
    const turns = this.turns(threadId);
    const first = turns[0] as Task;
    const latest = turns[turns.length - 1] as Task;
    const state = this.rework(threadId, limits);
    const status: DelegationChildOutcome["status"] =
      state.phase === "approved"
        ? "approved"
        : state.phase === "awaiting_reformulation"
          ? "escalated"
          : state.phase === "working" && latest.state === "blocked"
            ? "blocked"
            : "failed";
    const done = [...turns].reverse().find((turn) => turn.state === "completed");
    return {
      localId: first.localId ?? threadId,
      role: "executor",
      goal: first.goal,
      status,
      summary: resultText(done?.result ?? null),
      issues: [],
      verdicts: this.verdictsOn(threadId),
      retries: state.retries,
      escalations: state.escalations,
      reassigned: this.reassigned(threadId),
    };
  }

  delegatorOutcome(threadId: string): DelegationChildOutcome {
    const first = this.turns(threadId)[0] as Task;
    const report = this.reportOf(threadId);
    return {
      localId: first.localId ?? threadId,
      role: "delegator",
      goal: first.goal,
      status: report?.status ?? "failed",
      summary: report?.summary ?? null,
      issues: report?.issues ?? ["the delegator ended without a report"],
      verdicts: [],
      retries: 0,
      escalations: 0,
      reassigned: false,
    };
  }

  // Threads whose latest turn has not settled: still pending, ready or running, or waiting for a cooldown to end.
  unsettled(threadId: string): boolean {
    const latest = this.latest(threadId);
    return (
      latest !== undefined &&
      !TERMINAL_TASK.has(latest.state) &&
      (latest.state !== "blocked" || latest.blockReason === "cooldown")
    );
  }

  // Turns that will still run: pending, ready, running, or blocked by a cooldown that ends (3.11).
  liveWork(): boolean {
    return this.tasks.some(
      (task) =>
        task.state === "pending" ||
        task.state === "ready" ||
        task.state === "running" ||
        (task.state === "blocked" && task.blockReason === "cooldown"),
    );
  }

  // The newest workflow-scope audit (the final auditor's verdict), if any.
  finalAudit(): AuditRecord | undefined {
    const finals = this.audits.filter((audit) => audit.scope === "workflow");
    return finals[finals.length - 1];
  }
}

// The stops already reached (3.13), from the workflow's events, so a stop the human continued from never fires twice.
export function firedStops(store: Pick<Store, "events">, workflow: WorkflowRecord): Stop[] {
  return store.events
    .list({ aggregateId: workflow.workflowId })
    .filter((event) => event.type === "workflow.awaiting_human")
    .map((event) => (event.payload as { reason?: unknown }).reason)
    .filter((reason): reason is Stop => typeof reason === "string");
}
