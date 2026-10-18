// Store port for M1 (M1-D3): schema info, projects, the command queue, tasks, the runtime lease,
// the run lifecycle and the event log. Operations are synchronous because node:sqlite is
// synchronous. Errors carry a `store.*` code, except lease refusals, which are typed results.
import type {
  Acceptance,
  AcceptanceCheck,
  BlockReason,
  MemoryOrigin,
  MemoryProviderState,
  Plan,
  RetryReason,
  TaskKind,
  TaskState,
} from "@haril/contracts";
import type { WorkflowsPort } from "./delegation.js";
import type { HarilError, Result } from "./result.js";
import type { UsageLogPort } from "./usage-log.js";

export type GateStatus = "ok" | "warn" | "error";

export interface StoreGate {
  readonly name: string;
  readonly status: GateStatus;
  readonly detail: string;
}

export interface StorePragmas {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  // Pages between automatic WAL checkpoints (INV-14).
  readonly walAutocheckpoint: number;
}

export interface StoreInfo {
  readonly storeId: string;
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  readonly pragmas: StorePragmas;
  readonly gates: readonly StoreGate[];
}

export type JsonObject = Readonly<Record<string, unknown>>;

// The Core rules the composition root injects into the adapter. The adapter never imports Core
// values (integrations type-import @haril/core only), so the transition table and the plan checks
// arrive through this object.
export interface StoreRules {
  canTransition(from: TaskState, to: TaskState): boolean;
  checkPlan(value: unknown): PlanCheck;
  // Acceptance checks of a task.create command (M3-D7); a reason names what is wrong.
  checkAcceptance(value: unknown): AcceptanceRuleResult;
  // The kind of a task.create command against its agent (LD-T4): absent means work, a plan task needs a planner agent
  // and a planner agent runs only plan tasks. A reason names what is wrong.
  checkTaskKind(kind: unknown, agentRef: string): TaskKindRuleResult;
  // The canonical JSON of a value (sorted keys at every depth). Approvals hash the canonical text of their subject, and
  // the idempotency keys of plan.submit are computed from it, so the adapter and the CLI agree on one text.
  canonicalJson(value: unknown): string;
}

export type AcceptanceRuleResult =
  | { readonly ok: true; readonly acceptance: Acceptance }
  | { readonly ok: false; readonly reason: string };

// The kinds a task.create may ask for (LD-T4). verify and summarize come only from a plan.
export type CreatableTaskKind = Extract<TaskKind, "work" | "plan">;

export type TaskKindRuleResult =
  | { readonly ok: true; readonly kind: CreatableTaskKind }
  | { readonly ok: false; readonly reason: string };

export type PlanCheck =
  | { readonly ok: true; readonly plan: Plan; readonly order: readonly string[] }
  | { readonly ok: false; readonly reason: string };

// Approvals (LD-T3, ARCH 4.3, 9.5, schemas 16). A decision is an admin write (approvals.decide), never a command. Only
// `plan` exists as a kind; the runtime applies a granted plan as the same plan.submit that `haril plan import` queues.
export type ApprovalKind = "plan";
export type ApprovalStatus = "requested" | "granted" | "denied";
export type ApprovalOutcome = "granted" | "denied";

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly projectId: string;
  readonly kind: ApprovalKind;
  // The proposed subject: the schema-checked plan for kind plan.
  readonly subject: JsonObject;
  // SHA-256 of the canonical JSON of the subject.
  readonly subjectSha256: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: number;
  // "cli" for a human at the terminal, otherwise the id of the proposing run or task.
  readonly requestedBy: string;
  // The model of the task that proposed the plan (LD-T7a); null when it named none, and for a plan from the terminal.
  // A granted plan gives it to every task it creates: a plan never names a model itself (ADR-0016 D10).
  readonly model: string | null;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
  readonly reason: string | null;
  // Null until the runtime has applied the decision (ARCH 4.2: an unapplied decision keeps the runtime up).
  readonly appliedAt: number | null;
}

export interface ApprovalFilter {
  readonly projectId?: string;
  readonly status?: ApprovalStatus;
  // Only the approvals a run of this task proposed (requestedBy is one of its run ids, LD-T4). An approval the task's
  // proposal only deduplicated against was requested by another run and is left out.
  readonly requestedByTask?: string;
}

export interface ProposePlanInput {
  readonly projectId: string;
  // Untrusted until it passes the Core rules of plan.submit.
  readonly plan: unknown;
  readonly requestedBy: string;
  // The model of the proposing task (LD-T7a). Absent or null means none; a blank one is a model.invalid error.
  readonly model?: string | null;
}

export interface ProposePlanResult {
  readonly approval: ApprovalRecord;
  // False when the same plan already has a requested approval in this project: that one is returned, with its model.
  readonly created: boolean;
}

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly outcome: ApprovalOutcome;
  // A declared name (the OS user name in the CLI), not an authenticated identity (ARCH 9.12).
  readonly decidedBy: string;
  readonly reason?: string;
}

export interface ApprovalsPort {
  // Validates the plan with the plan.submit rules; an invalid plan is a plan.invalid error that carries the same reason.
  // A blank model is a model.invalid error. Neither stores anything.
  proposePlan(input: ProposePlanInput): Result<ProposePlanResult, HarilError>;
  // An admin write, only on a requested approval: a second decision is store.conflict, an unknown id store.not_found.
  decide(input: DecideApprovalInput): ApprovalRecord;
  list(filter?: ApprovalFilter): readonly ApprovalRecord[];
  get(approvalId: string): ApprovalRecord | undefined;
  // Decided approvals the runtime has not applied yet, oldest decision first.
  listUnapplied(): readonly ApprovalRecord[];
  // Marks a decision applied, fenced by the runtime epoch. False when it was already applied (no second event).
  markApplied(approvalId: string, epoch: number): boolean;
}

export interface ProjectRecord {
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  // Hash and text of the manifest that was registered (null when registered without one).
  readonly manifestSha256: string | null;
  readonly createdAt: number;
}

export interface RegisterProjectInput {
  // Optional: the store generates one when absent. The CLI passes the id it previewed.
  readonly projectId?: string;
  readonly slug: string;
  readonly name: string;
  readonly rootPath: string;
  readonly manifestSha256?: string;
  readonly manifestJson?: string;
}

export interface TaskRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly state: TaskState;
  readonly agentRef: string;
  readonly createdAt: number;
}

export interface TaskDetail extends TaskRecord {
  readonly description: string;
  readonly model: string | null;
  readonly maxTokens: number;
  // The error of the newest failed attempt of the task, if any (M2-T6, haril task show), with the attempt number of its
  // run. A verification_failed attempt keeps its host evidence in `verification` (M3-D7) and the output its checks
  // rejected in `output` (MC-T2). A completed task may have one too: an attempt before the one that completed it.
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly attempt?: number;
    readonly verification?: JsonObject;
    readonly output?: JsonObject;
  } | null;
  // Why a failed task failed for good when an attempt's own error does not say it (MC-T2 fix; executor.md DR-05): the
  // reason of its newest task.failed event, null otherwise.
  readonly failureReason: FailureReason | null;
  // The verification retries the task was granted (ORCHESTRATION 7.3: at most 2, inside maxAttempts).
  readonly verifyRetries: number;
  readonly attempt: number;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly claimEpoch: number;
  readonly infraRestarts: number;
  readonly retryReason: RetryReason | null;
  readonly blockReason: BlockReason | null;
  readonly result: JsonObject | null;
  // The ids of the tasks this task depends on, in the order they were declared (TUI-D4). Empty when it has none.
  readonly dependsOn: readonly string[];
}

export interface TaskFilter {
  readonly projectId?: string;
}

// The newest runtime lease: `none` when no runtime has ever started (M1-D6).
export type RuntimeLeaseSummary =
  | { readonly status: "none" }
  | {
      readonly status: "active" | "released" | "lost";
      readonly instanceId: string;
      readonly pid: number;
      readonly startedAt: number;
      readonly heartbeatAt: number;
      readonly expiresAt: number;
      readonly nodeVersion: string;
      readonly sqliteVersion: string;
    };

export interface AcquireLeaseInput {
  readonly pid: number;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly ttlMs: number;
}

// The epoch is the fencing token of this runtime: every later write must name it (M1-D6).
export interface LeaseGrant {
  readonly epoch: number;
  readonly instanceId: string;
}

// An attempt whose runtime epoch ended without a clean exit (M1 fix d). `ready` goes back to the queue;
// `failed` means infra_restarts would exceed its ceiling.
export interface RecoveredTask {
  readonly taskId: string;
  readonly goal: string;
  readonly runId: string | null;
  readonly outcome: "ready" | "failed";
  readonly infraRestarts: number;
  readonly maxInfraRestarts: number;
}

export interface AgentMetrics {
  readonly agentRef: string;
  readonly runs: number;
  readonly completed: number;
  readonly failed: number;
  readonly orphaned: number;
  readonly totalMs: number;
}

// Raw counts behind `haril metrics` (M1-T6). Every number is derivable from runs, tasks and events.
export interface MetricsSnapshot {
  readonly tasksByState: Readonly<Record<TaskState, number>>;
  readonly runsByStatus: Readonly<Record<string, number>>;
  readonly retries: number;
  readonly orphanedRecoveries: number;
  readonly closedRuns: number;
  readonly durationTotalMs: number;
  readonly perAgent: readonly AgentMetrics[];
  // Completed tasks whose host checks all passed, and completed tasks without a passing verification (M3-D7).
  readonly verifiedCompletions: number;
  readonly unverifiedCompletions: number;
}

export interface RuntimeBusyError extends HarilError {
  readonly code: "runtime.busy";
  readonly pid: number;
  readonly instanceId: string;
  readonly expiresAt: number;
}

export interface EnqueueCommandInput {
  readonly type: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly projectId?: string;
}

export interface EnqueueResult {
  readonly commandId: string;
  // True when the idempotency key was already queued with the same request hash.
  readonly duplicate: boolean;
}

export interface CommandRecord {
  readonly commandId: string;
  readonly projectId: string | null;
  readonly type: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly enqueuedAt: number;
}

// Outcome of applying one queued command. A rejection is a normal result, not an error.
export interface AppliedCommand {
  readonly commandId: string;
  readonly type: string;
  readonly outcome: "applied" | "rejected";
  readonly reason?: string;
  readonly taskIds: readonly string[];
  readonly planId?: string;
  // The workflow a workflow.start created.
  readonly workflowId?: string;
}

export interface PromotedTask {
  readonly taskId: string;
  readonly goal: string;
}

export interface PromoteResult {
  readonly ready: readonly PromotedTask[];
  readonly blocked: readonly PromotedTask[];
}

// The stored result of a task that a claimed task depends on (AGENTS.md 6.1, source 4; MC-T1). Another agent wrote it,
// so the prompt that carries it labels it as data. `result` is the task's result as completed. A dependency of kind
// settled (3.7) is met by a task that will never complete too: then `result` is null and `failure` says how it ended
// (failed with its newest error, cancelled, or blocked by an earlier failure), so a continuation knows which child
// failed and why.
export interface DependencyResult {
  readonly taskId: string;
  readonly goal: string;
  readonly result: JsonObject | null;
  readonly failure?: {
    readonly state: "failed" | "cancelled" | "blocked";
    readonly code: string;
    readonly message: string;
  };
}

// One acceptance check of a rejected attempt (MC-T2): the check as the task states it (kind, path, expected text), and
// the host's evidence of it, whether it passed and why.
export type RejectedCheck = AcceptanceCheck & {
  readonly ok: boolean;
  readonly detail: string;
};

// The newest attempt of a task that its acceptance checks rejected (ORCHESTRATION 7.3, ARCH 7.6; MC-T2), even when a
// failure for another reason came after it: its run's attempt number, every check of it in the task's order, and the
// output the checks rejected, the result it would have had (null when the run kept none). An agent wrote the output, so
// the prompt that carries it labels it as data.
export interface RejectedAttempt {
  readonly attempt: number;
  readonly checks: readonly RejectedCheck[];
  readonly output: JsonObject | null;
}

// A task handed to the runtime by claimNext. `attempt` is the attempt number of this run.
export interface ClaimedTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly goal: string;
  readonly description: string;
  // work, or plan for a task that asks its planner agent for a plan (LD-T4); a plan's tasks keep their own kind.
  readonly kind: TaskKind;
  readonly agentRef: string;
  // Real agents (M2-T6): the requested model (null when none) and the task token ceiling (0 when none).
  readonly model: string | null;
  readonly maxTokens: number;
  // Host acceptance checks of the task (M3-D7), evaluated after the agent settles.
  readonly acceptance: Acceptance;
  // The files the task is told to read: a plan task's surface.read, empty for a task.create (LD-T7c). Its prompt names
  // them; they are not an access limit.
  readonly surfaceRead: readonly string[];
  // The results of the task's direct dependencies, the oldest dependency first; empty without dependencies (MC-T1).
  readonly dependencyResults: readonly DependencyResult[];
  // The newest attempt its acceptance checks rejected, null when none did (MC-T2).
  readonly rejectedAttempt: RejectedAttempt | null;
  readonly attempt: number;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly claimEpoch: number;
  readonly runtimeEpoch: number;
}

export type RunCompletion =
  | { readonly runId: string; readonly outcome: "succeeded"; readonly result: JsonObject }
  | {
      readonly runId: string;
      readonly outcome: "failed";
      readonly error: { readonly code: string; readonly message: string };
      readonly endCause: "exit" | "timeout";
      // Host evidence of a verification_failed attempt (M3-D7); stored with the run error. Its presence makes the failure
      // a verification failure: the task returns to ready as verify_failed (MC-T2).
      readonly verification?: JsonObject;
      // The output of that attempt, the result it would have had (MC-T2); stored with the run error.
      readonly output?: JsonObject;
    };

// Why a task failed for good beyond its last attempt's error (MC-T2 fix): its verification retries ran out
// (executor.md DR-05), or its infra restarts did (M1-T7).
export type FailureReason = "verification_exhausted" | "infra_restarts_exhausted";

export interface CompletedRun {
  readonly taskId: string;
  readonly goal: string;
  readonly attempt: number;
  readonly taskState: "completed" | "ready" | "failed";
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly retryReason: RetryReason | null;
  // A failed task whose verification retries ran out says so (MC-T2 fix); null otherwise.
  readonly failureReason: FailureReason | null;
  // The verification retries granted to the task so far.
  readonly verifyRetries: number;
}

export interface AppendEventInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly actorKind: "user" | "agent" | "system";
  readonly actorId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  // Defaults to the clock. A run event shares the timestamp of the run row it describes (M1-T6).
  readonly ts?: number;
  readonly schemaVersion?: number;
  readonly audit?: boolean;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface EventRecord extends AppendEventInput {
  readonly seq: number;
  readonly eventId: string;
  readonly ts: number;
}

export interface EventFilter {
  readonly aggregateId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  // The newest `limit` events, returned oldest first.
  readonly limit?: number;
}

// Token budgets (M2-T2, ADR-0005 BR-5, BR-8, BR-12). M2 budgets count tokens only; money is not stored.
export type BudgetScopeType = "project" | "task";

export interface EnsureBudgetInput {
  readonly scopeType: BudgetScopeType;
  readonly scopeId: string;
  readonly projectId: string;
  readonly hardLimit: number;
}

export interface BudgetRecord {
  readonly budgetId: string;
  readonly scopeType: BudgetScopeType;
  readonly scopeId: string;
  readonly projectId: string;
  readonly hardLimit: number;
  readonly spent: number;
  readonly reserved: number;
  // Spend above hard_limit that a settlement could not fit in `spent` (kept apart so the CHECK holds).
  readonly overrun: number;
}

export interface ReserveInput {
  readonly budgetIds: readonly string[];
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly taskId: string;
  readonly routeId: string;
}

// All-or-nothing: either every named budget holds the amount, or none changes.
export type ReserveResult =
  | { readonly ok: true; readonly reservationId: string }
  | {
      readonly ok: false;
      readonly reason: "insufficient" | "unknown_budget";
      readonly budgetId: string;
    };

// Token counts of an upstream reply; a null count is one the provider did not report.
export interface SettleUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface CommitInput {
  readonly reservationId: string;
  readonly usage: SettleUsage | null;
  // Worst case known when the reply carries no usage (the estimate of the input plus the output so far).
  readonly upperBound: number;
  // Null only when the reservation is settled by the reconciler, which has no request to name (ARCH 13.2 CP4).
  readonly modelRequested: string | null;
  readonly modelServed: string | null;
}

export type CommitStatus = "committed" | "already_settled" | "unknown_reservation";
export type ReleaseStatus = "released" | "already_settled" | "unknown_reservation";

export interface UsageSummaryFilter {
  readonly projectId?: string;
  readonly taskId?: string;
}

// Settled token totals from the ledger; `unreconciled` counts commits that charged an upper bound.
export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly settled: number;
  readonly unreconciled: number;
}

// Settled tokens per agent and model, from the project budgets (M2-T6, haril metrics).
export interface UsageBreakdownRow {
  readonly agentRef: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly unreconciled: number;
}

export interface BudgetsPort {
  ensure(input: EnsureBudgetInput): BudgetRecord;
  usageBreakdown(projectId?: string): readonly UsageBreakdownRow[];
  get(budgetId: string): BudgetRecord | undefined;
  reserve(input: ReserveInput): ReserveResult;
  commit(input: CommitInput): CommitStatus;
  release(reservationId: string): ReleaseStatus;
  // Settles every open reservation of a run whose runtime is gone, at its upper bound and unreconciled (ARCH
  // 13.2 CP4). Returns how many were settled; a settled reservation is skipped, so a second call returns 0.
  settleOpenForRun(runId: string): number;
  // Null when the ledger holds no settled entry for the filter.
  usageSummary(filter?: UsageSummaryFilter): UsageSummary | null;
}

// Virtual keys (ADR-0005 BR-3). Only the SHA-256 hash of a key is ever given to the store.
export interface IssueKeyInput {
  readonly runId: string;
  readonly keyHash: string;
  readonly routeGrant: JsonObject;
  readonly budgetIds: readonly string[];
  readonly expiresAt: number;
}

export interface ActiveVirtualKey {
  readonly keyId: string;
  readonly runId: string;
  readonly routeGrant: JsonObject;
  readonly budgetIds: readonly string[];
  readonly expiresAt: number;
}

export interface VirtualKeysPort {
  // Returns the key id. A second active key for the same run is a store.conflict.
  issue(input: IssueKeyInput): string;
  findActiveByHash(keyHash: string): ActiveVirtualKey | undefined;
  // Revokes every active key of the run; returns how many were revoked.
  revoke(runId: string, reason: string): number;
}

// Maintenance of the database file, outside any transaction (ST-30, INV-11, INV-14).
export interface BackupReport {
  readonly path: string;
  readonly size: number;
  // The copy passed integrity_check before it was renamed to its destination.
  readonly quickCheckOk: boolean;
}

export interface StoreMaintenance {
  // VACUUM INTO a temporary file next to destPath, verify it, then rename it. Refuses an existing destination.
  backup(destPath: string): BackupReport;
  // wal_checkpoint(TRUNCATE): the WAL size in bytes afterwards; null for a store without a file.
  checkpoint(): { readonly walBytes: number | null };
}

// The memory module of the Store (MC-T4; task-store.md 4.10, DATA_MODEL 5.7, memory.md 4.4): the outbox, the only way
// a write reaches a memory provider, its pointers, and the provider state the CLI reads without a runtime. The outbox
// is transactional state, never a consumer of events. Every write is fenced by the runtime epoch.
export type OutboxOp = "store" | "summarize" | "forget" | "consolidate";
export type OutboxStatus = "pending" | "sending" | "delivered" | "needs_review" | "dead";

export interface OutboxEnqueue {
  // Ids.next() at enqueue time, reused on every retry (ADR-0008 D4); the provider deduplicates by it.
  readonly operationId: string;
  readonly projectId: string;
  readonly op: OutboxOp;
  // The MemoryWrite, SummarizeWrite, ForgetRequest or ConsolidationRequest, already redacted (RF-226).
  readonly payload: JsonObject;
  readonly schemaVersion: number;
  // The HARIL session of the row: a summarize waits for the other rows of its session (CM-09).
  readonly sessionId: string | null;
  // The domain row it mirrors (decisions): one outbox row per source row.
  readonly source?: { readonly table: string; readonly id: string };
}

export interface OutboxRow {
  readonly outboxSeq: number;
  readonly operationId: string;
  readonly projectId: string;
  readonly op: OutboxOp;
  readonly payload: JsonObject;
  readonly schemaVersion: number;
  readonly sessionId: string | null;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  // A redacted code, never a message.
  readonly lastError: string | null;
  readonly receipt: JsonObject | null;
  readonly deliveredProvider: string | null;
  readonly enqueuedAt: number;
  readonly deliveredAt: number | null;
}

// A pointer to a record of a provider, without its content (13 sec4.9 rule 4).
export interface MemoryRefInsert {
  readonly projectId: string;
  // Kept only when the task exists.
  readonly taskId?: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly syncId?: string;
  readonly topicKey?: string;
  readonly direction: "out" | "in";
  readonly kind: string;
  readonly origin: MemoryOrigin;
  readonly contentSha256?: string;
}

export interface MemoryRefRecord extends MemoryRefInsert {
  readonly refId: string;
  readonly operationId: string | null;
  readonly createdAt: number;
}

export interface MarkDeliveredInput {
  readonly operationId: string;
  readonly receipt: JsonObject;
  readonly provider: string;
  readonly refs: readonly MemoryRefInsert[];
  // memory.stored, memory.forgotten or memory.consolidated with its payload (memory.md 6), written with the row.
  readonly event: { readonly type: string; readonly payload: JsonObject };
}

export interface MarkFailedInput {
  readonly operationId: string;
  // A MemoryErrorCode or contract.invalid.
  readonly code: string;
  readonly to: "pending" | "needs_review" | "dead";
  // The backoff of a row back to pending.
  readonly nextAttemptAt?: number;
}

export interface SetMemoryStateInput {
  readonly provider: string;
  readonly state: MemoryProviderState;
  readonly persistent: boolean;
  // Why it is not active (a MemoryErrorCode); kept as the last error after a recovery.
  readonly code?: string;
}

export interface MemoryOutboxCounts {
  readonly pending: number;
  readonly sending: number;
  readonly needsReview: number;
  readonly dead: number;
  readonly delivered: number;
  // The enqueue time of the oldest pending row.
  readonly oldestPendingAt: number | null;
}

// What `haril memory status` and the shell read (RF-132): the meta keys memory.* the last runtime wrote, null before
// any did, and the outbox counts.
export interface MemoryStatus {
  readonly provider: string | null;
  readonly persistent: boolean | null;
  readonly lastState: MemoryProviderState | null;
  readonly lastStateAt: number | null;
  readonly lastError: { readonly code: string; readonly at: number } | null;
  readonly outbox: MemoryOutboxCounts;
}

export interface MemoryStorePort {
  // Inserts pending rows due now, each with a memory.outbox.enqueued event. The same operationId (or source row) is
  // deduplicated; the same operationId with another payload is store.conflict.
  enqueue(epoch: number, rows: readonly OutboxEnqueue[]): { enqueued: number; deduped: number };
  // Claims due pending rows in outbox order: sending, attempts + 1, claimed by this epoch. A row not due is skipped
  // without blocking the next ones; a summarize waits while another row of its session is not terminal (MEM-11).
  claimDue(epoch: number, limit: number): readonly OutboxRow[];
  // The row, its pointers (one per provider and providerRef) and its event, in one transaction (MEM-04). A row this
  // epoch did not claim is store.stale.
  markDelivered(epoch: number, input: MarkDeliveredInput): void;
  markFailed(epoch: number, input: MarkFailedInput): void;
  // The rows earlier epochs left sending go back to pending with the same operationId (MEM-16). Returns how many.
  requeueStale(epoch: number): number;
  // Writes the meta keys memory.*; memory.degraded or memory.recovered once per transition. True when it changed.
  setState(epoch: number, input: SetMemoryStateInput): boolean;
  // The ready tasks whose requires[] has memory go to blocked(memory_unavailable), and back (MEM-08).
  blockTasks(epoch: number): readonly PromotedTask[];
  releaseTasks(epoch: number): readonly PromotedTask[];
  // The earliest next attempt of a pending row; null when none is pending.
  nextDueAt(): number | null;
  status(): MemoryStatus;
  get(operationId: string): OutboxRow | undefined;
  refs(projectId?: string): readonly MemoryRefRecord[];
}

export interface Store {
  info(): StoreInfo;
  readonly maintenance: StoreMaintenance;
  readonly projects: {
    register(input: RegisterProjectInput): ProjectRecord;
    list(): readonly ProjectRecord[];
    getBySlug(slug: string): ProjectRecord | undefined;
    getByRootPath(rootPath: string): ProjectRecord | undefined;
  };
  readonly commands: {
    enqueue(input: EnqueueCommandInput): EnqueueResult;
    listQueued(): readonly CommandRecord[];
    // Applies the oldest queued command in one transaction; undefined when the queue is empty.
    applyNext(epoch: number): AppliedCommand | undefined;
  };
  readonly tasks: {
    list(filter?: TaskFilter): readonly TaskRecord[];
    get(taskId: string): TaskDetail | undefined;
    // pending -> ready when every dependency completed; pending -> blocked(dep_failed) when one dependency
    // failed, was cancelled or is blocked(dep_failed). Propagates transitively within the call.
    promote(): PromoteResult;
    // Highest priority, then oldest ready task: ready -> running, one run row, one claim epoch. Tasks whose
    // agentRef is in excludeAgentRefs are not claimed (M2-T6: a real agent without its prerequisites). Tasks whose
    // id is in excludeTaskIds stay ready and are not claimed (M3-T7: a task whose model cannot run yet).
    // A turn of a workflow that is not running is never claimed (3.14); standaloneOnly leaves every workflow turn to
    // the workflow scheduler, which claims them one by one with claimTask under its limits (3.9).
    claimNext(
      epoch: number,
      excludeAgentRefs?: readonly string[],
      excludeTaskIds?: readonly string[],
      options?: { readonly standaloneOnly?: boolean },
    ): ClaimedTask | undefined;
    // Claims one named task the same way: ready -> running, one run row, one claim epoch, in one transaction.
    // Undefined when the task is not ready or belongs to a workflow that is not running.
    claimTask(epoch: number, taskId: string): ClaimedTask | undefined;
  };
  readonly runtime: {
    leaseSummary(): RuntimeLeaseSummary;
    acquire(input: AcquireLeaseInput): Result<LeaseGrant, RuntimeBusyError>;
    heartbeat(epoch: number, ttlMs: number): void;
    release(epoch: number, cleanExit: boolean): void;
    // Releases the lease with a clean exit only when no command is queued and no decided approval is unapplied, in the same
    // transaction (ARCH 4.2).
    // False leaves the lease held: the caller drains the queue and decides again.
    releaseIfIdle(epoch: number): boolean;
    // Orphans every running task claimed by another epoch: back to ready (retry_reason orphaned, no attempt
    // charged, infra_restarts + 1) or failed when infra_restarts would exceed maxInfraRestarts. The orphaned run's
    // virtual keys are revoked and its open budget reservations settled (ARCH 13.2 CP1, CP4). One transaction.
    reconcile(epoch: number, maxInfraRestarts: number): readonly RecoveredTask[];
  };
  readonly runs: {
    // Closes the run and its task in one transaction. Success persists the result before `completed`.
    complete(completion: RunCompletion): CompletedRun;
    // Ends the run of a stopping runtime (ARCH 4.2, step 3): the run closes as cancelled, the task returns to ready
    // with retryReason orphaned, no attempt and no infra restart is charged, and the run's keys and open reservations
    // end. One transaction.
    cancel(runId: string, reason: "shutdown"): CompletedRun;
  };
  readonly events: {
    append(input: AppendEventInput): EventRecord;
    list(filter?: EventFilter): readonly EventRecord[];
  };
  readonly metrics: {
    snapshot(projectId?: string): MetricsSnapshot;
  };
  readonly budgets: BudgetsPort;
  readonly virtualKeys: VirtualKeysPort;
  readonly approvals: ApprovalsPort;
  readonly memory: MemoryStorePort;
  // Workflows of the Delegation mode, their turns, proposals and verdicts (4.2, 4.3).
  readonly workflows: WorkflowsPort;
  // The orders and usage logs (4.5): append-only, hash-chained, written without a lease (P14).
  readonly usageLog: UsageLogPort;
  // Runs `work` in one transaction: the store's own writes inside it join it, so they commit together or, when `work`
  // throws, none of them does. The runtime closes an attempt this way: its run, its verdict, the turns that follow it
  // and its usage row (3.8 rule 6: a restart never finds half of it).
  transaction<T>(work: () => T): T;
  close(): void;
}
