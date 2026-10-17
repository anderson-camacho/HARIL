// InMemoryMemoryProvider (memory.md 2.3, 9.2): a complete provider that lives in the Runtime's process and does not
// persist (U-15; capabilities().persistent is false and `haril memory status` must say so). Records are kept per
// project; every write is idempotent by its operationId; sessions end with their summary; search is a case-insensitive
// substring match; recall fills a token budget with whole items. Time, ids and hashes come from the injected
// dependencies (R7). Pure.
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
  MemoryHit,
  MemoryHitPage,
  MemoryKind,
  MemoryQuery,
  MemoryRecord,
  MemoryRef,
  MemorySession,
  MemoryWrite,
  MemoryWriteScope,
  RecallBundle,
  RecallItem,
  RecallRequest,
  ScopeRef,
  SummarizeWrite,
  WriteReceipt,
} from "@haril/contracts";
import type {
  EpochMs,
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
  queryTerms,
  refusal,
  searchBounds,
  truncateUtf8,
  unsupportedConsolidation,
  unsupportedExport,
  unsupportedImport,
  utf8Length,
} from "./support.js";

export interface InMemoryMemoryProviderOptions {
  // Two writes of the same title, content and kind, without topicKey, within this window collapse into one record with
  // a deduped receipt. memory.md 9.2 proposes 0, no dedupe [S]; a test sets a window to exercise the receipt. A
  // non-negative integer of milliseconds.
  readonly dedupeWindowMs?: number;
}

const PROVIDER = "in-memory";
// [S] parity with Engram (memory.md 9.2). There is no proposed cap on the number of records.
const MAX_CONTENT_BYTES = 50_000;
// Parity with the 20 results of Engram's /search.
const MAX_SEARCH_RESULTS = 20;
const SNIPPET_CHARS = 160;
const TOPIC_KEY_MAX_BYTES = 120;

interface StoredRecord {
  readonly providerRef: string;
  readonly scope: MemoryWriteScope;
  title: string;
  content: string;
  readonly topicKey: string | undefined;
  revisionCount: number;
  duplicateCount: number;
  readonly createdAt: EpochMs;
  updatedAt: EpochMs;
  deleted: boolean;
  // The order of the last change: the recency tiebreak when the clock did not move.
  seq: number;
}

interface ProjectKey {
  readonly workspaceId: string;
  readonly projectKey: string;
}

interface SessionEntry extends ProjectKey {
  // Set by summarize: the hash of the summary that ended the session and the record that keeps it.
  readonly ended?: { readonly textSha256: string; readonly providerRef: string };
}

interface WriteEntry {
  readonly operation: "store" | "summarize";
  readonly sha256: string;
  readonly receipt: WriteReceipt;
}

interface ForgetEntry {
  readonly fingerprint: string;
  readonly receipt: ForgetReceipt;
}

interface Ranked {
  readonly record: StoredRecord;
  readonly score: number;
}

function sameProject(a: ProjectKey, b: ProjectKey): boolean {
  return a.workspaceId === b.workspaceId && a.projectKey === b.projectKey;
}

function projectOf(scope: ProjectKey): string {
  return `${scope.workspaceId}\n${scope.projectKey}`;
}

function refOf(record: StoredRecord): MemoryRef {
  return { provider: PROVIDER, providerRef: record.providerRef };
}

// How many terms appear in the title or the content.
function matchCount(record: StoredRecord, terms: readonly string[]): number {
  const text = `${record.title}\n${record.content}`.toLowerCase();
  return terms.filter((term) => text.includes(term)).length;
}

// Relevance, then recency (memory.md 6.1; nothing is pinned here).
function byRelevance(a: Ranked, b: Ranked): number {
  return (
    b.score - a.score || b.record.updatedAt - a.record.updatedAt || b.record.seq - a.record.seq
  );
}

function snippetOf(content: string): string {
  return Array.from(content).slice(0, SNIPPET_CHARS).join("");
}

function writeReceipt(
  operationId: string,
  providerRef: string,
  outcome: WriteReceipt["outcome"],
): WriteReceipt {
  return {
    schemaVersion: 1,
    operationId,
    provider: PROVIDER,
    providerRef,
    outcome,
    truncated: false,
    redacted: false,
  };
}

// A copy, so a caller cannot change the receipt a replay answers.
function copyForgetReceipt(receipt: ForgetReceipt): ForgetReceipt {
  return { ...receipt, ref: { ...receipt.ref } };
}

// What makes two forgets with one operationId the same forget: the ref, the mode and the expectedScope (authorizedBy is
// informative). Another one is a reused operationId.
function forgetFingerprint(request: ForgetRequest): string {
  const { ref, mode, expectedScope: scope } = request;
  return JSON.stringify([
    ref.providerRef,
    ref.syncId ?? null,
    mode,
    scope.workspaceId,
    scope.projectKey,
    scope.visibility,
    scope.sessionId,
    scope.agentId ?? null,
    scope.taskId ?? null,
    scope.kind ?? null,
  ]);
}

function forgetReceipt(
  request: ForgetRequest,
  outcome: ForgetReceipt["outcome"],
  erasure: ForgetReceipt["erasure"],
): ForgetReceipt {
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    ref: { ...request.ref },
    mode: request.mode,
    outcome,
    erasure,
  };
}

export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly deps: MemoryProviderDeps;
  private readonly caps: MemoryCapabilities;
  private readonly dedupeWindowMs: number;
  private readonly records = new Map<string, StoredRecord>();
  // providerRef -> project of a hard-forgotten record, so forgetting it again answers already_forgotten.
  private readonly erased = new Map<string, string>();
  private readonly sessions = new Map<string, SessionEntry>();
  // The operationId ledger (MEM-04): the first receipt of each write and forget.
  private readonly writes = new Map<string, WriteEntry>();
  private readonly forgets = new Map<string, ForgetEntry>();
  private seq = 0;

  constructor(deps: MemoryProviderDeps, options: InMemoryMemoryProviderOptions = {}) {
    this.deps = deps;
    const dedupeWindowMs = options.dedupeWindowMs ?? 0;
    // A programming error of the composition root, not a result of a call.
    if (!Number.isSafeInteger(dedupeWindowMs) || dedupeWindowMs < 0) {
      throw new RangeError(`dedupeWindowMs must be a non-negative integer, got ${dedupeWindowMs}`);
    }
    this.dedupeWindowMs = dedupeWindowMs;
    this.caps = {
      schemaVersion: 1,
      provider: PROVIDER,
      providerVersion: CORE_PROVIDER_VERSION,
      persistent: false,
      sessionTracking: true,
      supportsOperationId: true,
      topicKeyUpsert: true,
      versionHistory: false,
      planConfirmConsolidation: false,
      conflictJudgment: false,
      hardDelete: true,
      ttl: false,
      semanticSearch: false,
      searchSyntax: "substring",
      maxContentBytes: MAX_CONTENT_BYTES,
      maxSearchResults: MAX_SEARCH_RESULTS,
      maxRecallBytes: null,
      dedupeWindowMs: this.dedupeWindowMs,
      exportVersion: null,
      importVersions: [],
      pagination: false,
      visibilities: ["project"],
    };
  }

  capabilities(): MemoryCapabilities {
    return copyCapabilities(this.caps);
  }

  async health(): Promise<MemoryHealth> {
    return inProcessHealth(PROVIDER, this.deps.clock.now());
  }

  async open(scope: ScopeRef, options?: MemoryCallOptions): Promise<MemoryOutcome<MemorySession>> {
    const input = checked("scope-ref", scope);
    if (!input.ok) return input;
    const refused = this.refuse(input.value, options);
    if (refused !== undefined) return refused;
    const session = this.openSession(input.value);
    if (!session.ok) return session;
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
    const accepted = input.value;
    const refused =
      this.refuse(accepted.scope, options) ??
      mismatchedHash(this.deps.hasher, accepted.content, accepted.contentSha256) ??
      (accepted.topicKey !== undefined && utf8Length(accepted.topicKey) > TOPIC_KEY_MAX_BYTES
        ? contractInvalid(`the topicKey is over ${TOPIC_KEY_MAX_BYTES} bytes`)
        : undefined);
    if (refused !== undefined) return refused;
    const replay = this.replayWrite(accepted.operationId, "store", accepted.contentSha256);
    if (replay !== undefined) return replay;
    const session = this.openSession(accepted.scope);
    if (!session.ok) return session;
    const originalBytes = utf8Length(accepted.content);
    const truncated = originalBytes > MAX_CONTENT_BYTES;
    const content = truncated
      ? truncateUtf8(accepted.content, MAX_CONTENT_BYTES)
      : accepted.content;
    const kept = this.keep(accepted, content);
    const receipt: WriteReceipt = {
      ...writeReceipt(accepted.operationId, kept.providerRef, kept.outcome),
      truncated,
      ...(truncated ? { originalBytes, limitBytes: MAX_CONTENT_BYTES } : {}),
    };
    this.writes.set(accepted.operationId, {
      operation: "store",
      sha256: accepted.contentSha256,
      receipt,
    });
    return ok({ ...receipt });
  }

  async search(
    query: MemoryQuery,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<MemoryHitPage>> {
    const input = checked("query", query);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused = this.refuse(accepted.scope, options) ?? searchBounds(this.caps, accepted);
    if (refused !== undefined) return refused;
    const terms = queryTerms(accepted.text);
    const items = this.ranked(accepted.scope, accepted.kinds, terms)
      .filter(({ score }) => (accepted.matchMode === "all" ? score === terms.length : score > 0))
      .slice(0, accepted.limit)
      .map(({ record, score }) => this.hitOf(record, score));
    return ok({ items });
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
      return memoryFailure("Unsupported", "the in-memory provider keeps no version history");
    }
    const record = this.records.get(refInput.value.providerRef);
    if (record === undefined) return memoryFailure("NotFound", "no record has this ref");
    if (!sameProject(record.scope, scopeInput.value)) {
      return memoryFailure("ScopeMismatch", "the record belongs to another project");
    }
    return ok(this.recordOf(record));
  }

  async recall(
    request: RecallRequest,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<RecallBundle>> {
    const input = checked("recall-request", request);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused = this.refuse(accepted.scope, options);
    if (refused !== undefined) return refused;
    const terms = queryTerms(accepted.query ?? "");
    const candidates = this.ranked(accepted.scope, accepted.kinds, terms).filter(
      ({ score }) => terms.length === 0 || score > 0,
    );
    const items: RecallItem[] = [];
    let usedTokens = 0;
    // Whole items in order; one that does not fit is left out and a later, smaller one may still fit.
    for (const { record } of candidates) {
      if (items.length >= accepted.maxItems) break;
      const tokens = Math.max(
        0,
        Math.ceil(this.deps.estimateTokens(`${record.title}\n${record.content}`)),
      );
      const fits = usedTokens + tokens <= accepted.budgetTokens;
      if (!fits) continue;
      usedTokens += tokens;
      items.push({
        ref: refOf(record),
        kind: record.scope.kind,
        title: record.title,
        content: record.content,
        tokens,
        trust: "untrusted",
        pinned: false,
        updatedAt: record.updatedAt,
      });
    }
    return ok({
      schemaVersion: 1,
      scope: { ...accepted.scope },
      budgetTokens: accepted.budgetTokens,
      usedTokens,
      items,
      omittedCount: candidates.length - items.length,
      degraded: false,
    });
  }

  async summarize(
    write: SummarizeWrite,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<WriteReceipt>> {
    const input = checked("summarize-write", write);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused =
      foreignSession(accepted, PROVIDER) ??
      this.refuse(accepted.scope, options) ??
      mismatchedHash(this.deps.hasher, accepted.text, accepted.textSha256) ??
      (utf8Length(accepted.text) > MAX_CONTENT_BYTES
        ? contractInvalid(`the summary is over ${MAX_CONTENT_BYTES} bytes`)
        : undefined);
    if (refused !== undefined) return refused;
    const replay = this.replayWrite(accepted.operationId, "summarize", accepted.textSha256);
    if (replay !== undefined) return replay;
    const ended = this.endSession(accepted);
    if (!ended.ok) return ended;
    this.writes.set(accepted.operationId, {
      operation: "summarize",
      sha256: accepted.textSha256,
      receipt: ended.value,
    });
    return ok({ ...ended.value });
  }

  async consolidate(
    request: ConsolidationRequest,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<ConsolidationOutcome>> {
    // core/memory consolidates with search, store and forget for every provider (CM-05).
    return unsupportedConsolidation(
      this.caps,
      request,
      options,
      "the in-memory provider has no plan-and-confirm consolidation",
    );
  }

  async forget(
    request: ForgetRequest,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<ForgetReceipt>> {
    const input = checked("forget-request", request);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused =
      foreignRef(accepted.ref, PROVIDER) ?? this.refuse(accepted.expectedScope, options);
    if (refused !== undefined) return refused;
    const fingerprint = forgetFingerprint(accepted);
    if (this.writes.has(accepted.operationId)) return this.reusedOperationId();
    const first = this.forgets.get(accepted.operationId);
    if (first !== undefined) {
      return first.fingerprint === fingerprint
        ? ok(copyForgetReceipt(first.receipt))
        : this.reusedOperationId();
    }
    const erased = this.erase(accepted);
    if (!erased.ok) return erased;
    this.forgets.set(accepted.operationId, { fingerprint, receipt: erased.value });
    return ok(copyForgetReceipt(erased.value));
  }

  async export(
    scope: ScopeRef | "all",
    format: ExportFormat,
    options?: MemoryCallOptions,
  ): Promise<MemoryOutcome<ExportArtifact>> {
    return unsupportedExport(
      this.caps,
      scope,
      format,
      options,
      "the in-memory provider does not export",
    );
  }

  // A function property (see MemoryProvider.import).
  readonly import = async (artifact: ExportArtifact): Promise<MemoryOutcome<ImportReport>> =>
    unsupportedImport(artifact, "the in-memory provider does not import");

  // ---- Internals ----

  private refuse(
    scope: ScopeRef,
    options: MemoryCallOptions | undefined,
  ): MemoryOutcome<never> | undefined {
    return refusal(this.caps, scope, options);
  }

  private reusedOperationId(): MemoryOutcome<never> {
    return contractInvalid("the operationId was already used with another request");
  }

  // The first receipt of an operationId used with the same hash; contract.invalid for other content (CM-12).
  private replayWrite(
    operationId: string,
    operation: WriteEntry["operation"],
    sha256: string,
  ): MemoryOutcome<WriteReceipt> | undefined {
    if (this.forgets.has(operationId)) return this.reusedOperationId();
    const first = this.writes.get(operationId);
    if (first === undefined) return undefined;
    if (first.operation !== operation || first.sha256 !== sha256) return this.reusedOperationId();
    return ok({ ...first.receipt });
  }

  // The open session of `scope`, opened on its first use (CM-15). A session belongs to one project.
  private openSession(scope: ScopeRef): MemoryOutcome<SessionEntry> {
    const existing = this.sessions.get(scope.sessionId);
    if (existing === undefined) {
      const entry: SessionEntry = { workspaceId: scope.workspaceId, projectKey: scope.projectKey };
      this.sessions.set(scope.sessionId, entry);
      return ok(entry);
    }
    if (!sameProject(existing, scope)) {
      return memoryFailure("ScopeMismatch", "the session belongs to another project");
    }
    if (existing.ended !== undefined) return memoryFailure("SessionEnded", "the session has ended");
    return ok(existing);
  }

  // Keeps the summary as a run_summary record and ends the session. The same summary of an ended session is deduped;
  // another one is SessionEnded (CM-06).
  private endSession(write: SummarizeWrite): MemoryOutcome<WriteReceipt> {
    const { scope } = write;
    const existing = this.sessions.get(scope.sessionId);
    if (existing !== undefined && !sameProject(existing, scope)) {
      return memoryFailure("ScopeMismatch", "the session belongs to another project");
    }
    if (existing?.ended !== undefined) {
      if (existing.ended.textSha256 !== write.textSha256) {
        return memoryFailure("SessionEnded", "the session already ended with another summary");
      }
      return ok(writeReceipt(write.operationId, existing.ended.providerRef, "deduped"));
    }
    const record = this.create(
      { ...scope, kind: "run_summary" },
      `Session ${scope.sessionId}`,
      write.text,
    );
    this.sessions.set(scope.sessionId, {
      workspaceId: scope.workspaceId,
      projectKey: scope.projectKey,
      ended: { textSha256: write.textSha256, providerRef: record.providerRef },
    });
    return ok(writeReceipt(write.operationId, record.providerRef, "created"));
  }

  // A topicKey updates the live record of the same project, kind and key; a twin within the dedupe window is deduped;
  // anything else is a new record.
  private keep(
    write: MemoryWrite,
    content: string,
  ): { readonly providerRef: string; readonly outcome: "created" | "updated" | "deduped" } {
    const now = this.deps.clock.now();
    const live = this.live(write.scope).filter((record) => record.scope.kind === write.scope.kind);
    if (write.topicKey !== undefined) {
      const topic = live.find((record) => record.topicKey === write.topicKey);
      if (topic !== undefined) {
        topic.title = write.title;
        topic.content = content;
        topic.updatedAt = now;
        topic.revisionCount += 1;
        topic.seq = this.nextSeq();
        return { providerRef: topic.providerRef, outcome: "updated" };
      }
    } else if (this.dedupeWindowMs > 0) {
      const twin = live.find(
        (record) =>
          record.topicKey === undefined &&
          record.title === write.title &&
          record.content === content &&
          now - record.createdAt <= this.dedupeWindowMs,
      );
      if (twin !== undefined) {
        twin.duplicateCount += 1;
        return { providerRef: twin.providerRef, outcome: "deduped" };
      }
    }
    const record = this.create(write.scope, write.title, content, write.topicKey);
    return { providerRef: record.providerRef, outcome: "created" };
  }

  private create(
    scope: MemoryWriteScope,
    title: string,
    content: string,
    topicKey?: string,
  ): StoredRecord {
    const now = this.deps.clock.now();
    const record: StoredRecord = {
      providerRef: this.deps.ids.next(),
      scope: { ...scope },
      title,
      content,
      topicKey,
      revisionCount: 1,
      duplicateCount: 0,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      seq: this.nextSeq(),
    };
    this.records.set(record.providerRef, record);
    return record;
  }

  private erase(request: ForgetRequest): MemoryOutcome<ForgetReceipt> {
    const { ref, expectedScope } = request;
    const erasedProject = this.erased.get(ref.providerRef);
    if (erasedProject !== undefined) {
      if (erasedProject !== projectOf(expectedScope)) {
        return memoryFailure("ScopeMismatch", "the record belonged to another project");
      }
      return ok(forgetReceipt(request, "already_forgotten", "deleted"));
    }
    const record = this.records.get(ref.providerRef);
    if (record === undefined) return memoryFailure("NotFound", "no record has this ref");
    if (!sameProject(record.scope, expectedScope)) {
      return memoryFailure("ScopeMismatch", "the record belongs to another project");
    }
    if (request.mode === "hard") {
      this.records.delete(ref.providerRef);
      this.erased.set(ref.providerRef, projectOf(record.scope));
      return ok(forgetReceipt(request, "forgotten", "deleted"));
    }
    if (record.deleted) return ok(forgetReceipt(request, "already_forgotten", "hidden"));
    record.deleted = true;
    return ok(forgetReceipt(request, "forgotten", "hidden"));
  }

  // Records of the scope's project that are not forgotten.
  private live(scope: ProjectKey): StoredRecord[] {
    return [...this.records.values()].filter(
      (record) => !record.deleted && sameProject(record.scope, scope),
    );
  }

  // The live records a read may return, ranked: a kind in the scope or in `kinds` narrows them (a read crosses kinds
  // when neither is given).
  private ranked(
    scope: ScopeRef,
    kinds: readonly MemoryKind[] | undefined,
    terms: readonly string[],
  ): Ranked[] {
    return this.live(scope)
      .filter((record) => scope.kind === undefined || record.scope.kind === scope.kind)
      .filter((record) => kinds === undefined || kinds.includes(record.scope.kind))
      .map((record) => ({ record, score: matchCount(record, terms) }))
      .sort(byRelevance);
  }

  private hitOf(record: StoredRecord, score: number): MemoryHit {
    const hit: MemoryHit = {
      ref: refOf(record),
      kind: record.scope.kind,
      title: record.title,
      snippet: snippetOf(record.content),
      score,
      pinned: false,
      updatedAt: record.updatedAt,
    };
    return record.topicKey === undefined ? hit : { ...hit, topicKey: record.topicKey };
  }

  private recordOf(record: StoredRecord): MemoryRecord {
    const copy: MemoryRecord = {
      ref: refOf(record),
      scope: { ...record.scope },
      kind: record.scope.kind,
      title: record.title,
      content: record.content,
      pinned: false,
      revisionCount: record.revisionCount,
      duplicateCount: record.duplicateCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deleted: record.deleted,
    };
    return record.topicKey === undefined ? copy : { ...copy, topicKey: record.topicKey };
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
}
