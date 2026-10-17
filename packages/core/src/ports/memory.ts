// MemoryProvider port (memory contract v1 draft: docs/contracts/memory.md 3.4 and 4; ADR-0008 D1, D2). The Core keeps
// and recalls semantic memory through it without knowing the provider: Null and InMemory live in core/memory, Engram
// in integrations/memory-engram (M4). Every scoped operation takes an explicit ScopeRef, never derived from the cwd or
// Git; every write is idempotent by its operationId; every expected failure is a typed result, never a throw.
import type {
  ConsolidationOutcome,
  ConsolidationRequest,
  ExportArtifact,
  ExportFormat,
  ForgetReceipt,
  ForgetRequest,
  ImportReport,
  MemoryCapabilities,
  MemoryErrorCode,
  MemoryHealth,
  MemoryHitPage,
  MemoryQuery,
  MemoryRecord,
  MemoryRef,
  MemorySession,
  MemoryWrite,
  RecallBundle,
  RecallRequest,
  ScopeRef,
  SummarizeWrite,
  WriteReceipt,
} from "@haril/contracts";
import type { Clock, Ids } from "./clock.js";
import type { Result } from "./result.js";

// A failure of a memory operation: the memory category of HarilError, or contract.invalid for a value that does not
// validate (a reused operationId with other content among them, CM-12). Only Unavailable is retryable: the outbox
// tries it again with the same operationId. A cancelled write is Unavailable with details.cancelled = true, because
// whether it took effect is unknown.
export type MemoryFailure =
  | {
      readonly code: MemoryErrorCode;
      readonly category: "memory";
      readonly retryable: boolean;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly code: "contract.invalid";
      readonly category: "contract";
      readonly retryable: false;
      readonly message: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

export type MemoryResult<T> = Promise<Result<T, MemoryFailure>>;

// The operations that can fail (capabilities and health never do), and the writes among them.
export type MemoryOperation =
  | "open"
  | "store"
  | "search"
  | "get"
  | "recall"
  | "summarize"
  | "consolidate"
  | "forget"
  | "export"
  | "import";
export type MemoryWriteOperation = Extract<
  MemoryOperation,
  "store" | "summarize" | "consolidate" | "forget"
>;

// Cooperative cancellation without AbortSignal (schemas.md 4, SC-18; ARCH 6.4): an adapter fills it from an
// AbortSignal. TODO(ARCH 6.4): it belongs in core/kernel once a second port takes it.
export interface CancelSignal {
  readonly cancelled: boolean;
  // Returns the function that removes the listener.
  onCancel(listener: () => void): () => void;
}

export interface MemoryCallOptions {
  readonly signal?: CancelSignal;
}

export interface MemoryGetOptions extends MemoryCallOptions {
  // Adds the earlier revisions; Unsupported without capabilities().versionHistory.
  readonly history?: boolean;
}

export type Sha256Hex = string;

// The SHA-256 the Core cannot compute by itself (ARCH 2.2 H2, 5.1). TODO(ARCH 5.1): it joins Clock and Ids once a second
// port takes it.
export interface Hasher {
  // Lowercase hex SHA-256 of the UTF-8 bytes of `text`.
  sha256(text: string): Sha256Hex;
}

// A non-negative integer that is never less than the real tokens of `text` (CM-03).
export type TokenEstimator = (text: string) => number;

// What a provider receives: no clock, randomness or hashing of its own (R7).
export interface MemoryProviderDeps {
  readonly clock: Clock;
  readonly ids: Ids;
  readonly hasher: Hasher;
  readonly estimateTokens: TokenEstimator;
}

// Reads (capabilities, health, open, search, get, recall) go straight to the provider; writes (store, summarize,
// consolidate, forget) come only from the memory_outbox consumer; export and import are administrative (memory.md 2.2).
export interface MemoryProvider {
  // Pure and stable for the life of the provider.
  capabilities(): MemoryCapabilities;
  // Never fails: it reports, after a real read.
  health(options?: MemoryCallOptions): Promise<MemoryHealth>;
  // Idempotent per (project, sessionId) while the session is open; store opens lazily (CM-15).
  open(scope: ScopeRef, options?: MemoryCallOptions): MemoryResult<MemorySession>;
  store(write: MemoryWrite, options?: MemoryCallOptions): MemoryResult<WriteReceipt>;
  search(query: MemoryQuery, options?: MemoryCallOptions): MemoryResult<MemoryHitPage>;
  // The scope lets the provider answer ScopeMismatch for a record of another project (CM-13).
  get(ref: MemoryRef, scope: ScopeRef, options?: MemoryGetOptions): MemoryResult<MemoryRecord>;
  recall(request: RecallRequest, options?: MemoryCallOptions): MemoryResult<RecallBundle>;
  // Persists a summary HARIL generated and ends the provider session.
  summarize(write: SummarizeWrite, options?: MemoryCallOptions): MemoryResult<WriteReceipt>;
  consolidate(
    request: ConsolidationRequest,
    options?: MemoryCallOptions,
  ): MemoryResult<ConsolidationOutcome>;
  forget(request: ForgetRequest, options?: MemoryCallOptions): MemoryResult<ForgetReceipt>;
  export(
    scope: ScopeRef | "all",
    format: ExportFormat,
    options?: MemoryCallOptions,
  ): MemoryResult<ExportArtifact>;
  // A function property, not a method: scripts/check-forbidden.mjs reads a method declaration named import as a dynamic
  // import(). Implementations declare it the same way in src.
  readonly import: (
    artifact: ExportArtifact,
    options?: MemoryCallOptions,
  ) => MemoryResult<ImportReport>;
}
