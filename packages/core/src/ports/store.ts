// Store port for M1 (M1-D3): schema info, projects, the command queue, tasks, the runtime lease,
// the run lifecycle and the event log. Operations are synchronous because node:sqlite is
// synchronous. Errors carry a `store.*` code, except lease refusals, which are typed results.
import type { Acceptance, BlockReason, Plan, RetryReason, TaskState } from "@haril/contracts";
import type { HarilError, Result } from "./result.js";

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
}

export type AcceptanceRuleResult =
  | { readonly ok: true; readonly acceptance: Acceptance }
  | { readonly ok: false; readonly reason: string };

export type PlanCheck =
  | { readonly ok: true; readonly plan: Plan; readonly order: readonly string[] }
  | { readonly ok: false; readonly reason: string };

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
  // The error of the newest failed attempt of the task, if any (M2-T6, haril task show). A verification_failed
  // attempt keeps its host evidence in `verification` (M3-D7).
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly verification?: JsonObject;
  } | null;
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
}

export interface PromotedTask {
  readonly taskId: string;
  readonly goal: string;
}

export interface PromoteResult {
  readonly ready: readonly PromotedTask[];
  readonly blocked: readonly PromotedTask[];
}

// A task handed to the runtime by claimNext. `attempt` is the attempt number of this run.
export interface ClaimedTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly goal: string;
  readonly description: string;
  readonly agentRef: string;
  // Real agents (M2-T6): the requested model (null when none) and the task token ceiling (0 when none).
  readonly model: string | null;
  readonly maxTokens: number;
  // Host acceptance checks of the task (M3-D7), evaluated after the agent settles.
  readonly acceptance: Acceptance;
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
      // Host evidence of a verification_failed attempt (M3-D7); stored with the run error.
      readonly verification?: JsonObject;
    };

export interface CompletedRun {
  readonly taskId: string;
  readonly goal: string;
  readonly attempt: number;
  readonly taskState: "completed" | "ready" | "failed";
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly retryReason: RetryReason | null;
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

export interface Store {
  info(): StoreInfo;
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
    claimNext(
      epoch: number,
      excludeAgentRefs?: readonly string[],
      excludeTaskIds?: readonly string[],
    ): ClaimedTask | undefined;
  };
  readonly runtime: {
    leaseSummary(): RuntimeLeaseSummary;
    acquire(input: AcquireLeaseInput): Result<LeaseGrant, RuntimeBusyError>;
    heartbeat(epoch: number, ttlMs: number): void;
    release(epoch: number, cleanExit: boolean): void;
    // Orphans every running task claimed by another epoch: back to ready (retry_reason orphaned, no attempt
    // charged, infra_restarts + 1) or failed when infra_restarts would exceed maxInfraRestarts. The orphaned run's
    // virtual keys are revoked and its open budget reservations settled (ARCH 13.2 CP1, CP4). One transaction.
    reconcile(epoch: number, maxInfraRestarts: number): readonly RecoveredTask[];
  };
  readonly runs: {
    // Closes the run and its task in one transaction. Success persists the result before `completed`.
    complete(completion: RunCompletion): CompletedRun;
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
  close(): void;
}
