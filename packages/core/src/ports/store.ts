// Store port for M1 (M1-D3): schema info, projects, the command queue, tasks, the runtime lease,
// the run lifecycle and the event log. Operations are synchronous because node:sqlite is
// synchronous. Errors carry a `store.*` code, except lease refusals, which are typed results.
import type { BlockReason, Plan, RetryReason, TaskState } from "@haril/contracts";
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
}

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
  readonly attempt: number;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly claimEpoch: number;
  readonly infraRestarts: number;
  readonly retryReason: RetryReason | null;
  readonly blockReason: BlockReason | null;
  readonly result: JsonObject | null;
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
    // Highest priority, then oldest ready task: ready -> running, one run row, one claim epoch.
    claimNext(epoch: number): ClaimedTask | undefined;
  };
  readonly runtime: {
    leaseSummary(): RuntimeLeaseSummary;
    acquire(input: AcquireLeaseInput): Result<LeaseGrant, RuntimeBusyError>;
    heartbeat(epoch: number, ttlMs: number): void;
    release(epoch: number, cleanExit: boolean): void;
    // Orphans every running task claimed by another epoch: back to ready (retry_reason orphaned, no attempt
    // charged, infra_restarts + 1) or failed when infra_restarts would exceed maxInfraRestarts. One transaction.
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
  close(): void;
}
