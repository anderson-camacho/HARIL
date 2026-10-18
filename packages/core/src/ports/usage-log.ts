// The orders and usage logs (docs/modos-y-delegacion.md 4.5, R-L1): every order that passes through the shell and
// every model use, with its model, difficulty, duration and times. Both tables are append-only and hash-chained: each
// row stores the hash of the previous row of its table and its own hash, sha256(prevHash + canonical JSON of the row
// without its hash), written inside one transaction so the chain has a total order. verify() walks both chains and
// names the first row that was changed or deleted by hand. P14: appending needs no runtime lease (the console may log
// with no runtime alive), so it is the one write outside the runtime; the tables depend on no task state.

export type OrderMode = "accion" | "consulta" | "plan" | "delegacion" | "cli";
export type OrderSource = "chat" | "cli" | "workflow";
export type UsageKind = "chat" | "agent_run";
export type UsageRole = "orchestrator" | "delegator" | "executor" | "auditor";
export type UsageDifficulty = "trivial" | "easy" | "medium" | "hard" | "expert";

export interface AppendOrderInput {
  readonly mode: OrderMode;
  readonly source: OrderSource;
  // The order as typed. Only its SHA-256 and its length are stored, never the text itself (P15).
  readonly text: string;
  // At most 200 characters, already redacted with orderPreview (core); null stores no preview.
  readonly preview: string | null;
  readonly sessionId?: string | null;
  readonly workflowId?: string | null;
  readonly projectId?: string | null;
  // A second append with the same key returns the first row (a replay after a restart, or the console's
  // session id + message id).
  readonly idempotencyKey?: string | null;
}

export interface OrderRecord {
  readonly seq: number;
  readonly orderId: string;
  readonly ts: number;
  readonly sessionId: string | null;
  readonly mode: OrderMode;
  readonly source: OrderSource;
  readonly workflowId: string | null;
  readonly projectId: string | null;
  readonly textSha256: string;
  readonly textChars: number;
  readonly preview: string | null;
  readonly idempotencyKey: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

// One attempt of an agent, or one assistant message of the chat. A token count that was not reported is null, never 0.
export interface AppendUsageInput {
  readonly kind: UsageKind;
  readonly orderId?: string | null;
  readonly sessionId?: string | null;
  readonly projectId?: string | null;
  readonly workflowId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly threadId?: string | null;
  readonly layer?: 1 | 2 | 3 | null;
  readonly role?: UsageRole | null;
  readonly mode?: OrderMode | null;
  readonly provider?: string | null;
  readonly modelRequested?: string | null;
  readonly modelServed?: string | null;
  readonly modelPinned?: boolean;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly tokensCached?: number | null;
  readonly tokensReasoning?: number | null;
  readonly costMicros?: number | null;
  readonly unreconciled?: boolean;
  readonly startedAt?: number | null;
  readonly endedAt?: number | null;
  readonly durationMs?: number | null;
  readonly difficultyEst?: UsageDifficulty | null;
  readonly difficultyReason?: string | null;
  readonly outcome?: string | null;
  readonly auditVerdict?: "approved" | "rejected" | null;
  readonly retries?: number | null;
  // A row written by a simulation (haril workflow demo); model_stats leaves it out.
  readonly simulated?: boolean;
  readonly idempotencyKey?: string | null;
}

export interface UsageRecord {
  readonly seq: number;
  readonly usageId: string;
  readonly ts: number;
  readonly orderId: string | null;
  readonly kind: UsageKind;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly workflowId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly threadId: string | null;
  readonly layer: number | null;
  readonly role: UsageRole | null;
  readonly mode: OrderMode | null;
  readonly provider: string | null;
  readonly modelRequested: string | null;
  readonly modelServed: string | null;
  readonly modelPinned: boolean;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly tokensCached: number | null;
  readonly tokensReasoning: number | null;
  readonly costMicros: number | null;
  readonly unreconciled: boolean;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly difficultyEst: UsageDifficulty | null;
  readonly difficultyReason: string | null;
  readonly outcome: string | null;
  readonly auditVerdict: "approved" | "rejected" | null;
  readonly retries: number | null;
  readonly simulated: boolean;
  readonly idempotencyKey: string | null;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AppendResult<T> {
  readonly record: T;
  // False when the idempotency key was already used: the first row is returned and nothing is appended.
  readonly created: boolean;
}

// Time bounds are on ts (the time the row was appended): from inclusive, to exclusive. limit keeps the newest rows,
// returned oldest first, as `haril events` does.
export interface OrderFilter {
  readonly from?: number;
  readonly to?: number;
  readonly mode?: OrderMode;
  readonly workflowId?: string;
  readonly limit?: number;
}

export interface UsageFilter {
  readonly from?: number;
  readonly to?: number;
  readonly kind?: UsageKind;
  // Matches the model served, or the model requested when none was served.
  readonly model?: string;
  readonly workflowId?: string;
  readonly layer?: number;
  readonly mode?: OrderMode;
  readonly difficulty?: UsageDifficulty;
  readonly limit?: number;
}

export type UsageGroupBy = "day" | "model" | "layer" | "difficulty" | "workflow" | "mode" | "role";

// One group of usage rows. Token sums count only the reported values; the *Unreported counts say how many rows had
// none, so a total is never mistaken for complete. day is the UTC date (YYYY-MM-DD).
export interface UsageSummaryRow {
  readonly key: string | null;
  readonly rows: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensInUnreported: number;
  readonly tokensOutUnreported: number;
  readonly durationMs: number;
  readonly retries: number;
  readonly approved: number;
  readonly rejected: number;
}

export type ChainBreak =
  // The row's content no longer gives its stored hash: it was changed.
  | "hash_mismatch"
  // The row's prev_hash is not the hash of the row before it: a row was deleted or inserted before it.
  | "prev_hash_mismatch"
  // seq jumps: a row was deleted.
  | "sequence_gap"
  // The newest row is not the head the last append recorded: the newest rows were deleted.
  | "head_mismatch";

export interface ChainReport {
  readonly table: "orders" | "usage_log";
  readonly rows: number;
  readonly ok: boolean;
  // The first broken position, by seq (the head mismatch names the seq the head expected).
  readonly firstBroken: {
    readonly seq: number;
    readonly id: string | null;
    readonly reason: ChainBreak;
  } | null;
}

export interface UsageVerification {
  readonly ok: boolean;
  readonly orders: ChainReport;
  readonly usage: ChainReport;
}

export interface UsageLogPort {
  appendOrder(input: AppendOrderInput): AppendResult<OrderRecord>;
  appendUsage(input: AppendUsageInput): AppendResult<UsageRecord>;
  orders(filter?: OrderFilter): readonly OrderRecord[];
  usage(filter?: UsageFilter): readonly UsageRecord[];
  // Groups in key order (null last).
  summary(groupBy: UsageGroupBy, filter?: UsageFilter): readonly UsageSummaryRow[];
  verify(): UsageVerification;
}
