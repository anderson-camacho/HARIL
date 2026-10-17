import type {
  ConsolidationOutcome,
  ConsolidationRequest,
  ExportArtifact,
  ExportFormat,
  ForgetReceipt,
  ForgetRequest,
  ImportReport,
  MemoryCapabilities,
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
import { InMemoryMemoryProvider, type InMemoryMemoryProviderOptions } from "../src/memory/index.js";
import type {
  MemoryCallOptions,
  MemoryFailure,
  MemoryGetOptions,
  MemoryOperation,
  MemoryProvider,
  MemoryProviderDeps,
  MemoryResult,
  MemoryWriteOperation,
  Result,
} from "../src/ports/index.js";
import type { MemoryFaultControls } from "./memory-provider.suite.js";

// FakeMemoryProvider (memory.md 9.3; TEST_STRATEGY 4.3): InMemory that becomes unreachable at will, for ESC-09, AR-G14
// and the outbox cases. Every injected fault is a typed result, never a throw.

export interface MemoryCall {
  readonly operation: MemoryOperation;
  readonly scope?: ScopeRef;
  readonly operationId?: string;
}

const READS: readonly MemoryOperation[] = ["search", "get", "recall"];

function unavailable(message: string, details?: Readonly<Record<string, unknown>>): MemoryFailure {
  const failure: MemoryFailure = {
    code: "Unavailable",
    category: "memory",
    retryable: true,
    message,
  };
  return details === undefined ? failure : { ...failure, details };
}

function failed(error: MemoryFailure): Result<never, MemoryFailure> {
  return { ok: false, error };
}

export class FakeMemoryProvider implements MemoryProvider, MemoryFaultControls {
  readonly inner: InMemoryMemoryProvider;
  private readonly deps: MemoryProviderDeps;
  // "all" makes every operation unavailable; otherwise the listed ones.
  private unavailableOps: "all" | Set<MemoryOperation> = new Set();
  private readonly nextFailures = new Map<MemoryOperation, MemoryFailure[]>();
  private readonly ambiguous = new Set<MemoryWriteOperation>();
  private readonly endedSessions = new Set<string>();
  private readonly log: MemoryCall[] = [];

  constructor(deps: MemoryProviderDeps, options?: InMemoryMemoryProviderOptions) {
    this.deps = deps;
    this.inner = new InMemoryMemoryProvider(deps, options);
  }

  // ---- Test controls ----

  makeUnavailable(operation?: MemoryOperation): void {
    if (operation === undefined) {
      this.unavailableOps = "all";
      return;
    }
    if (this.unavailableOps !== "all") this.unavailableOps.add(operation);
  }

  restore(): void {
    this.unavailableOps = new Set();
  }

  // The next call of `operation` answers `failure` instead of reaching InMemory.
  failNext(operation: MemoryOperation, failure: MemoryFailure): void {
    const queue = this.nextFailures.get(operation) ?? [];
    queue.push(failure);
    this.nextFailures.set(operation, queue);
  }

  ambiguousNext(operation: MemoryWriteOperation): void {
    this.ambiguous.add(operation);
  }

  // Ends a session from outside: later writes to it, and opening it, answer SessionEnded.
  endSession(sessionId: string): void {
    this.endedSessions.add(sessionId);
  }

  // Every call in order, with its scope and operationId (MEM-03, MEM-13).
  calls(): readonly MemoryCall[] {
    return this.log.map((call) => ({ ...call }));
  }

  // ---- MemoryProvider ----

  capabilities(): MemoryCapabilities {
    return this.inner.capabilities();
  }

  async health(): Promise<MemoryHealth> {
    const health = await this.inner.health();
    // The ping always answers; the real read fails while a read operation is unavailable (MEM-09).
    if (!READS.some((read) => this.isUnavailable(read))) return health;
    return {
      ...health,
      state: "degraded",
      realReadOk: false,
      lastError: { code: "Unavailable", at: this.deps.clock.now() },
    };
  }

  open(scope: ScopeRef, options?: MemoryCallOptions): MemoryResult<MemorySession> {
    return this.call("open", scope, undefined, () =>
      this.ended(scope) ? this.sessionEnded() : this.inner.open(scope, options),
    );
  }

  store(write: MemoryWrite, options?: MemoryCallOptions): MemoryResult<WriteReceipt> {
    return this.write("store", write?.scope, write?.operationId, () =>
      this.ended(write?.scope) ? this.sessionEnded() : this.inner.store(write, options),
    );
  }

  search(query: MemoryQuery, options?: MemoryCallOptions): MemoryResult<MemoryHitPage> {
    return this.call("search", query?.scope, undefined, () => this.inner.search(query, options));
  }

  get(ref: MemoryRef, scope: ScopeRef, options?: MemoryGetOptions): MemoryResult<MemoryRecord> {
    return this.call("get", scope, undefined, () => this.inner.get(ref, scope, options));
  }

  recall(request: RecallRequest, options?: MemoryCallOptions): MemoryResult<RecallBundle> {
    return this.call("recall", request?.scope, undefined, () =>
      this.inner.recall(request, options),
    );
  }

  summarize(write: SummarizeWrite, options?: MemoryCallOptions): MemoryResult<WriteReceipt> {
    return this.write("summarize", write?.scope, write?.operationId, () =>
      this.ended(write?.scope) ? this.sessionEnded() : this.inner.summarize(write, options),
    );
  }

  consolidate(
    request: ConsolidationRequest,
    options?: MemoryCallOptions,
  ): MemoryResult<ConsolidationOutcome> {
    return this.write("consolidate", request?.scope, request?.operationId, () =>
      this.inner.consolidate(request, options),
    );
  }

  forget(request: ForgetRequest, options?: MemoryCallOptions): MemoryResult<ForgetReceipt> {
    return this.write("forget", request?.expectedScope, request?.operationId, () =>
      this.inner.forget(request, options),
    );
  }

  export(
    scope: ScopeRef | "all",
    format: ExportFormat,
    options?: MemoryCallOptions,
  ): MemoryResult<ExportArtifact> {
    const logged = scope === "all" ? undefined : scope;
    return this.call("export", logged, undefined, () => this.inner.export(scope, format, options));
  }

  import(artifact: ExportArtifact): MemoryResult<ImportReport> {
    const scope = artifact?.scope === "all" ? undefined : artifact?.scope;
    return this.call("import", scope, undefined, () => this.inner.import(artifact));
  }

  // ---- Internals ----

  private isUnavailable(operation: MemoryOperation): boolean {
    return this.unavailableOps === "all" || this.unavailableOps.has(operation);
  }

  private ended(scope: ScopeRef | undefined): boolean {
    return scope?.sessionId !== undefined && this.endedSessions.has(scope.sessionId);
  }

  private async sessionEnded(): Promise<Result<never, MemoryFailure>> {
    return failed({
      code: "SessionEnded",
      category: "memory",
      retryable: false,
      message: "the session was ended from outside (fake)",
    });
  }

  private async call<T>(
    operation: MemoryOperation,
    scope: ScopeRef | undefined,
    operationId: string | undefined,
    run: () => MemoryResult<T>,
  ): Promise<Result<T, MemoryFailure>> {
    this.log.push({
      operation,
      ...(scope === undefined ? {} : { scope }),
      ...(operationId === undefined ? {} : { operationId }),
    });
    const injected = this.nextFailures.get(operation)?.shift();
    if (injected !== undefined) return failed(injected);
    if (this.isUnavailable(operation)) {
      return failed(unavailable(`memory provider unavailable for ${operation} (fake)`));
    }
    return run();
  }

  // A write may lose its answer after it took effect (memory.md 9.3, MEM-T1).
  private async write<T>(
    operation: MemoryWriteOperation,
    scope: ScopeRef | undefined,
    operationId: string | undefined,
    run: () => MemoryResult<T>,
  ): Promise<Result<T, MemoryFailure>> {
    const result = await this.call(operation, scope, operationId, run);
    // Only a write that took effect can lose its answer; a refused one keeps its failure.
    if (!result.ok || !this.ambiguous.delete(operation)) return result;
    return failed(unavailable(`the answer to ${operation} was lost (fake)`, { ambiguous: true }));
  }
}
