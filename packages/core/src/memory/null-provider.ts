// NullMemoryProvider (memory.md 2.3, 9.2): the default when no memory is configured, so the Core never branches on
// "is there memory". It keeps nothing: writes are accepted and discarded with a discarded receipt, reads come back empty,
// a record is never found, and what it cannot do is Unsupported. It is always active: an empty read is its honest
// answer, not a degradation (a degraded bundle is what core/memory builds for an Unavailable provider). Pure.
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
import type {
  MemoryCallOptions,
  MemoryGetOptions,
  MemoryProvider,
  MemoryProviderDeps,
} from "../ports/index.js";
import {
  CORE_PROVIDER_VERSION,
  checked,
  contractInvalid,
  copyCapabilities,
  foreignRef,
  foreignSession,
  inProcessHealth,
  type MemoryOutcome,
  memoryFailure,
  mismatchedHash,
  ok,
  refusal,
  searchBounds,
  unsupportedConsolidation,
  unsupportedExport,
  unsupportedImport,
} from "./support.js";

const PROVIDER = "null";

const NULL_CAPABILITIES: MemoryCapabilities = {
  schemaVersion: 1,
  provider: PROVIDER,
  providerVersion: CORE_PROVIDER_VERSION,
  persistent: false,
  sessionTracking: false,
  // It accepts an operationId and discards the write: a retry answers the same receipt.
  supportsOperationId: true,
  topicKeyUpsert: false,
  versionHistory: false,
  planConfirmConsolidation: false,
  conflictJudgment: false,
  hardDelete: false,
  ttl: false,
  semanticSearch: false,
  searchSyntax: "none",
  maxContentBytes: null,
  maxSearchResults: 20,
  maxRecallBytes: null,
  dedupeWindowMs: null,
  exportVersion: null,
  importVersions: [],
  pagination: false,
  visibilities: ["project"],
};

export class NullMemoryProvider implements MemoryProvider {
  private readonly deps: MemoryProviderDeps;
  // operationId -> the operation and hash it was first used with. Null keeps no memory, only what lets a reuse of an
  // operationId with other content answer contract.invalid (supportsOperationId; CM-12). The outbox never queues for a
  // provider that does not persist (CM-04), so this stays small.
  private readonly ledger = new Map<string, string>();

  constructor(deps: MemoryProviderDeps) {
    this.deps = deps;
  }

  capabilities(): MemoryCapabilities {
    return copyCapabilities(NULL_CAPABILITIES);
  }

  async health(): Promise<MemoryHealth> {
    return inProcessHealth(PROVIDER, this.deps.clock.now());
  }

  async open(scope: ScopeRef, options?: MemoryCallOptions): Promise<MemoryOutcome<MemorySession>> {
    const input = checked("scope-ref", scope);
    if (!input.ok) return input;
    const refused = this.refuse(input.value, options);
    if (refused !== undefined) return refused;
    return ok({
      ref: { provider: PROVIDER, sessionId: input.value.sessionId },
      scope: { ...input.value },
      state: "open",
    });
  }

  async store(
    write: MemoryWrite,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<WriteReceipt>> {
    const input = checked("write", write);
    if (!input.ok) return input;
    const { scope, content, contentSha256, topicKey, operationId } = input.value;
    const refused =
      this.refuse(scope, options) ?? mismatchedHash(this.deps.hasher, content, contentSha256);
    if (refused !== undefined) return refused;
    if (topicKey !== undefined) {
      return memoryFailure("Unsupported", "the null provider has no topicKey upsert");
    }
    return this.discard("store", operationId, contentSha256);
  }

  async search(
    query: MemoryQuery,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<MemoryHitPage>> {
    const input = checked("query", query);
    if (!input.ok) return input;
    const refused =
      this.refuse(input.value.scope, options) ?? searchBounds(NULL_CAPABILITIES, input.value);
    if (refused !== undefined) return refused;
    return ok({ items: [] });
  }

  async get(
    ref: MemoryRef,
    scope: ScopeRef,
    options?: MemoryGetOptions,
  ): Promise<MemoryOutcome<MemoryRecord>> {
    const refInput = checked("ref", ref);
    if (!refInput.ok) return refInput;
    const scopeInput = checked("scope-ref", scope);
    if (!scopeInput.ok) return scopeInput;
    const refused = foreignRef(refInput.value, PROVIDER) ?? this.refuse(scopeInput.value, options);
    if (refused !== undefined) return refused;
    if (options?.history === true) {
      return memoryFailure("Unsupported", "the null provider keeps no version history");
    }
    return memoryFailure("NotFound", "the null provider keeps no records");
  }

  async recall(
    request: RecallRequest,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<RecallBundle>> {
    const input = checked("recall-request", request);
    if (!input.ok) return input;
    const refused = this.refuse(input.value.scope, options);
    if (refused !== undefined) return refused;
    return ok({
      schemaVersion: 1,
      scope: { ...input.value.scope },
      budgetTokens: input.value.budgetTokens,
      usedTokens: 0,
      items: [],
      omittedCount: 0,
      degraded: false,
    });
  }

  async summarize(
    write: SummarizeWrite,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<WriteReceipt>> {
    const input = checked("summarize-write", write);
    if (!input.ok) return input;
    const { scope, text, textSha256, operationId } = input.value;
    const refused =
      foreignSession(input.value, PROVIDER) ??
      this.refuse(scope, options) ??
      mismatchedHash(this.deps.hasher, text, textSha256);
    if (refused !== undefined) return refused;
    return this.discard("summarize", operationId, textSha256);
  }

  async consolidate(
    request: ConsolidationRequest,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<ConsolidationOutcome>> {
    return unsupportedConsolidation(
      NULL_CAPABILITIES,
      request,
      options,
      "the null provider does not consolidate",
    );
  }

  async forget(
    request: ForgetRequest,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<ForgetReceipt>> {
    const input = checked("forget-request", request);
    if (!input.ok) return input;
    const refused =
      foreignRef(input.value.ref, PROVIDER) ?? this.refuse(input.value.expectedScope, options);
    if (refused !== undefined) return refused;
    // The capability is checked before the lookup, as in every provider of the Core.
    if (input.value.mode === "hard") {
      return memoryFailure("Unsupported", "the null provider has no hard delete");
    }
    return memoryFailure("NotFound", "the null provider keeps no records");
  }

  async export(
    scope: ScopeRef | "all",
    format: ExportFormat,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<ExportArtifact>> {
    return unsupportedExport(
      NULL_CAPABILITIES,
      scope,
      format,
      options,
      "the null provider has nothing to export",
    );
  }

  // A function property (see MemoryProvider.import).
  readonly import = async (artifact: ExportArtifact): Promise<MemoryOutcome<ImportReport>> =>
    unsupportedImport(artifact, "the null provider does not import");

  private refuse(
    scope: ScopeRef,
    options: MemoryCallOptions | undefined,
  ): MemoryOutcome<never> | undefined {
    return refusal(NULL_CAPABILITIES, scope, options);
  }

  // The same receipt for every call with this operationId and hash; another hash is contract.invalid.
  private discard(
    operation: "store" | "summarize",
    operationId: string,
    sha256: string,
  ): MemoryOutcome<WriteReceipt> {
    const fingerprint = `${operation}:${sha256}`;
    const first = this.ledger.get(operationId);
    if (first !== undefined && first !== fingerprint) {
      return contractInvalid("the operationId was already used with other content");
    }
    this.ledger.set(operationId, fingerprint);
    return ok({
      schemaVersion: 1,
      operationId,
      provider: PROVIDER,
      outcome: "discarded",
      truncated: false,
      redacted: false,
    });
  }
}
