// EngramMemoryProvider (memory.md 9.4; MEMORY.md 4; ADR-0008 D4, D6): the MemoryProvider port over the HTTP API of a
// `engram serve` HARIL started, on 127.0.0.1 only. Every scoped request names its project and session explicitly
// (never all_projects, never the cwd); every write sends capture_prompt false and its operationId; an answer maps to
// a typed failure (memory.md 4.4; MEMORY.md 4.2 [S]); each call has its own deadline. Before it is used, a serve must
// prove it is the instance of HARIL's data dir and the pinned version (GET /health), and it proves it again after any
// failure. Time, ids and hashes come from the injected dependencies; the network deadline is real time.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
  MemoryQuery,
  MemoryRecord,
  MemoryRef,
  MemorySession,
  MemoryWrite,
  RecallBundle,
  RecallItem,
  RecallRequest,
  ScopeRef,
  SummarizeWrite,
  Visibility,
  WriteReceipt,
} from "@haril/contracts";
import type {
  HarilError,
  MemoryCallOptions,
  MemoryGetOptions,
  MemoryProvider,
  MemoryProviderDeps,
  Result,
} from "@haril/core/ports";
import {
  cancelled,
  failureOf,
  isAmbiguous,
  isSuccess,
  lostFailure,
  readFailure,
} from "./answers.js";
import {
  type CallBudget,
  type EngramEndpoint,
  type EngramRequest,
  type Exchange,
  exchange,
  type FetchFn,
} from "./http.js";
import { endpointProblem } from "./loopback.js";
import {
  engramProject,
  engramTypeOf,
  kindOfType,
  ownerOf,
  PROJECT_SEPARATOR,
  typesOf,
  visibilityOf,
} from "./mapping.js";
import {
  checked,
  contractInvalid,
  memoryFailure,
  type Outcome,
  ok,
  queryTerms,
  truncateUtf8,
  unavailable,
  unknownResult,
  utf8Length,
} from "./support.js";
import {
  errorCodeOf,
  isEngramId,
  readContext,
  readExport,
  readHealth,
  readImport,
  readObservation,
  readSaveResult,
  readSearch,
  readSession,
  type WireObservation,
  type WireSaveResult,
} from "./wire.js";

// The serve to talk to: the supervisor's connect(), which launches it on first use, or a fixed one in a test.
export type EngramConnect = () => Promise<Result<EngramEndpoint, HarilError>>;

export interface EngramMemoryProviderOptions {
  readonly connect: EngramConnect;
  // The pinned Engram version (ADR-0008 D8): capabilities come from it, and a serve reporting another is refused.
  readonly engramVersion: string;
  // HARIL's data dir (<root>\data, the one holding haril.db): exports are written under it and imports read only
  // from it (memory.md 4.2).
  readonly harilDataDir: string;
  // personal and global need an opt-in (ADR-0008 D6.7); project is always supported.
  readonly visibilities?: readonly Visibility[];
  // [S] bounds, no measured value in the sources (MEMORY.md 13.1): the whole call, and each request inside it.
  readonly callDeadlineMs?: number;
  readonly requestTimeoutMs?: number;
  // Absent: the global fetch. A test passes a spy.
  readonly fetch?: FetchFn;
}

const PROVIDER = "engram";
// [S]: under the 5 s an outbox drain allows (MC-T4), with room for the lookup that resolves an ambiguous write.
export const ENGRAM_CALL_DEADLINE_MS = 4_000;
export const ENGRAM_REQUEST_TIMEOUT_MS = 1_500;
// Engram 3.4.0 limits, 06 sec3.6 [V]: 50 000 bytes of content, 20 search results, a /context of 64 KiB at most, a
// 15-minute dedupe without topic_key, a topic_key of 120 bytes; export format 0.2.0, and 0.1.0 still imports (sec3.11).
const MAX_CONTENT_BYTES = 50_000;
const MAX_SEARCH_RESULTS = 20;
const MAX_RECALL_BYTES = 65_536;
const DEDUPE_WINDOW_MS = 900_000;
const TOPIC_KEY_MAX_BYTES = 120;
const EXPORT_VERSION = "0.2.0";
const IMPORT_VERSIONS = ["0.2.0", "0.1.0"];
// The versions whose behaviour the capabilities below describe; any other one declares nothing optional (MP-01).
const KNOWN_VERSIONS = new Set(["3.4.0"]);
const SNIPPET_CHARS = 160;
// Engram's redaction, (?is)<private>.*?</private> (06 sec3.6), applied before sending so the receipt can say it.
const PRIVATE_TAG = /<private>[\s\S]*?<\/private>/gi;
const REDACTED = "[REDACTED]";
// The project the real read of health() searches: no workspace can produce it (a StoreId has no underscore prefix).
const HEALTH_PROJECT = `_haril${PROJECT_SEPARATOR}health`;
// Summaries and forgets carry no operation_id in Engram, so the adapter keeps their first answer [S]: bounded, and
// lost on restart, where the server-side comparison of 4.2 still answers.
const LEDGER_LIMIT = 10_000;
const EXPORT_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

interface LedgerEntry {
  readonly operation: "summarize" | "forget";
  readonly fingerprint: string;
  readonly receipt: WriteReceipt | ForgetReceipt;
}

interface Prepared {
  readonly title: string;
  readonly content: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

function capabilitiesOf(version: string, visibilities: readonly Visibility[]): MemoryCapabilities {
  const known = KNOWN_VERSIONS.has(version);
  return {
    schemaVersion: 1,
    provider: PROVIDER,
    providerVersion: known ? version : null,
    persistent: true,
    sessionTracking: true,
    supportsOperationId: known,
    topicKeyUpsert: known,
    // That the history exists over HTTP is NOT VERIFIED (memory.md 4.2), so it is not declared.
    versionHistory: false,
    // mem_consolidate exists only on main, not in 3.4.0 (memory.md 4.2).
    planConfirmConsolidation: false,
    conflictJudgment: false,
    hardDelete: known,
    ttl: false,
    semanticSearch: false,
    searchSyntax: "fts5-trigram",
    maxContentBytes: MAX_CONTENT_BYTES,
    maxSearchResults: MAX_SEARCH_RESULTS,
    maxRecallBytes: MAX_RECALL_BYTES,
    dedupeWindowMs: DEDUPE_WINDOW_MS,
    exportVersion: known ? EXPORT_VERSION : null,
    importVersions: known ? [...IMPORT_VERSIONS] : [],
    pagination: false,
    visibilities: ["project", ...visibilities.filter((visibility) => visibility !== "project")],
  };
}

function copyCapabilities(capabilities: MemoryCapabilities): MemoryCapabilities {
  return {
    ...capabilities,
    importVersions: [...capabilities.importVersions],
    visibilities: [...capabilities.visibilities],
  };
}

function sameEndpoint(a: EngramEndpoint, b: EngramEndpoint): boolean {
  return a.baseUrl === b.baseUrl && a.instanceId === b.instanceId && a.token === b.token;
}

// Redaction first, then truncation measured after it, as Engram does (06 sec3.6), cut between code points.
function prepare(write: MemoryWrite): Prepared {
  const title = write.title.replace(PRIVATE_TAG, REDACTED);
  const full = write.content.replace(PRIVATE_TAG, REDACTED);
  const originalBytes = utf8Length(full);
  const truncated = originalBytes > MAX_CONTENT_BYTES;
  return {
    title,
    content: truncated ? truncateUtf8(full, MAX_CONTENT_BYTES) : full,
    redacted: title !== write.title || full !== write.content,
    truncated,
    originalBytes,
  };
}

function refOf(observation: WireObservation): MemoryRef {
  const ref: MemoryRef = { provider: PROVIDER, providerRef: observation.id };
  return observation.syncId === undefined ? ref : { ...ref, syncId: observation.syncId };
}

function scopeOf(observation: WireObservation, asked: ScopeRef): ScopeRef {
  const owner = ownerOf(observation.project) ?? asked;
  return {
    workspaceId: owner.workspaceId,
    projectKey: owner.projectKey,
    visibility: visibilityOf(observation.scope),
    // A session id from elsewhere (an import) may not be one of HARIL's: the asking scope's stands in.
    sessionId: observation.sessionId.length === 26 ? observation.sessionId : asked.sessionId,
    kind: kindOfType(observation.type),
  };
}

function byRelevance(a: WireObservation, b: WireObservation): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (b.score ?? 0) - (a.score ?? 0) ||
    b.updatedAt - a.updatedAt ||
    Number(b.id) - Number(a.id)
  );
}

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

// A file name segment for an export directory: the projectKey as it is (a ULID, or _knowledge), never a path.
function exportSegment(projectKey: string): string | undefined {
  return EXPORT_SEGMENT.test(projectKey) && !DEVICE_NAMES.test(projectKey) ? projectKey : undefined;
}

function isInside(root: string, path: string): boolean {
  const between = relative(resolve(root), resolve(path));
  return between !== "" && !between.startsWith("..") && !isAbsolute(between);
}

export class EngramMemoryProvider implements MemoryProvider {
  private readonly deps: MemoryProviderDeps;
  private readonly options: EngramMemoryProviderOptions;
  private readonly caps: MemoryCapabilities;
  private readonly fetchFn: FetchFn;
  private readonly callDeadlineMs: number;
  private readonly requestTimeoutMs: number;
  // The endpoint whose identity GET /health last proved; cleared by any failure.
  private verified: EngramEndpoint | undefined;
  // Sessions this adapter opened (session id -> Engram project); summarize removes its own.
  private readonly openSessions = new Map<string, string>();
  private readonly ledger = new Map<string, LedgerEntry>();
  // The adapter's own single-consumer queue of writes towards serve (memory.md 9.4 point 7).
  private writes: Promise<unknown> = Promise.resolve();

  constructor(deps: MemoryProviderDeps, options: EngramMemoryProviderOptions) {
    this.deps = deps;
    this.options = options;
    this.caps = capabilitiesOf(options.engramVersion, options.visibilities ?? []);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.callDeadlineMs = options.callDeadlineMs ?? ENGRAM_CALL_DEADLINE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? ENGRAM_REQUEST_TIMEOUT_MS;
  }

  capabilities(): MemoryCapabilities {
    return copyCapabilities(this.caps);
  }

  // GET /health proves the identity; a search of a reserved project is the real read (#571: /health alone can say ok
  // while /search fails). Without a serve the state is degraded and realReadOk null. Never throws.
  async health(options?: MemoryCallOptions): Promise<MemoryHealth> {
    const checkedAt = this.deps.clock.now();
    const report = (
      state: MemoryHealth["state"],
      realReadOk: boolean | null,
      endpoint?: EngramEndpoint,
    ): MemoryHealth => ({
      schemaVersion: 1,
      provider: PROVIDER,
      state,
      checkedAt,
      realReadOk,
      version: endpoint === undefined ? null : this.options.engramVersion,
      instanceId: endpoint?.instanceId ?? null,
      dataDir: endpoint?.dataDir ?? null,
      lastError: state === "active" ? null : { code: "Unavailable", at: checkedAt },
    });
    try {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return report("degraded", null);
      const read = await this.send(connected.value, budget, {
        method: "GET",
        path: "/search",
        query: { q: "haril health", project: HEALTH_PROJECT, scope: "project", limit: "1" },
      });
      const readOk =
        read.kind === "answer" && read.status === 200 && readSearch(read.body) !== undefined;
      return report(readOk ? "active" : "degraded", readOk, connected.value);
    } catch {
      return report("degraded", null);
    }
  }

  async open(scope: ScopeRef, options?: MemoryCallOptions): Promise<Outcome<MemorySession>> {
    const input = checked("scope-ref", scope);
    if (!input.ok) return input;
    const refused = this.refusal(input.value, options);
    if (refused !== undefined) return refused;
    return this.guard(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const opened = await this.openSession(connected.value, budget, input.value);
      if (!opened.ok) return opened;
      return ok({
        ref: { provider: PROVIDER, sessionId: input.value.sessionId },
        scope: { ...input.value },
        state: "open",
      });
    });
  }

  async store(write: MemoryWrite, options?: MemoryCallOptions): Promise<Outcome<WriteReceipt>> {
    const input = checked("write", write);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused =
      this.refusal(accepted.scope, options) ??
      (this.deps.hasher.sha256(accepted.content) === accepted.contentSha256
        ? undefined
        : contractInvalid("the contentSha256 is not the SHA-256 of the content")) ??
      (accepted.topicKey !== undefined && utf8Length(accepted.topicKey) > TOPIC_KEY_MAX_BYTES
        ? contractInvalid(`the topicKey is over ${TOPIC_KEY_MAX_BYTES} bytes`)
        : undefined) ??
      (this.ledger.has(accepted.operationId)
        ? contractInvalid("the operationId was already used with another request")
        : undefined);
    if (refused !== undefined) return refused;
    const budget = this.budget(options);
    return this.serialized(async () => {
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      if (accepted.topicKey !== undefined && !this.caps.topicKeyUpsert) {
        return memoryFailure(
          "Unsupported",
          `Engram ${this.options.engramVersion} has no topic_key upsert`,
        );
      }
      const endpoint = connected.value;
      const opened = await this.openSession(endpoint, budget, accepted.scope);
      if (!opened.ok) return opened;
      const prepared = prepare(accepted);
      const sent = await this.send(endpoint, budget, {
        method: "POST",
        path: "/observations",
        body: {
          session_id: accepted.scope.sessionId,
          project: engramProject(accepted.scope),
          scope: accepted.scope.visibility,
          type: engramTypeOf(accepted.scope.kind),
          title: prepared.title,
          content: prepared.content,
          ...(accepted.topicKey === undefined ? {} : { topic_key: accepted.topicKey }),
          operation_id: accepted.operationId,
          capture_prompt: false,
        },
      });
      return this.stored(endpoint, budget, accepted, prepared, sent);
    });
  }

  async search(query: MemoryQuery, options?: MemoryCallOptions): Promise<Outcome<MemoryHitPage>> {
    const input = checked("query", query);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused =
      this.refusal(accepted.scope, options) ??
      (queryTerms(accepted.text).length === 0
        ? contractInvalid("the search text has no terms")
        : undefined) ??
      (accepted.limit > this.caps.maxSearchResults
        ? contractInvalid(`the search limit is over ${this.caps.maxSearchResults}`)
        : undefined);
    if (refused !== undefined) return refused;
    return this.guard(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const found = await this.searchTypes(connected.value, budget, accepted.scope, {
        text: accepted.text,
        matchMode: accepted.matchMode,
        limit: accepted.limit,
        types: typesOf(accepted.scope.kind, accepted.kinds),
      });
      if (!found.ok) return found;
      const items = [...found.value]
        .sort(byRelevance)
        .slice(0, accepted.limit)
        .map((observation) => this.hitOf(observation));
      return ok({ items });
    });
  }

  async get(
    ref: MemoryRef,
    scope: ScopeRef,
    options?: MemoryGetOptions,
  ): Promise<Outcome<MemoryRecord>> {
    const refInput = checked("ref", ref);
    if (!refInput.ok) return refInput;
    const scopeInput = checked("scope-ref", scope);
    if (!scopeInput.ok) return scopeInput;
    const refused = this.foreignRef(refInput.value) ?? this.refusal(scopeInput.value, options);
    if (refused !== undefined) return refused;
    return this.guard(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      if (options?.history === true && !this.caps.versionHistory) {
        return memoryFailure("Unsupported", "the history of an observation is not read over HTTP");
      }
      const found = await this.observation(connected.value, budget, refInput.value.providerRef);
      if (!found.ok) return found;
      if (found.value.project !== engramProject(scopeInput.value)) {
        return memoryFailure("ScopeMismatch", "the record belongs to another project");
      }
      return ok(this.recordOf(found.value, scopeInput.value));
    });
  }

  // MEMORY.md 6.1: /context (64 KiB at most) and, with a query, /search, merged by id; pinned first, then relevance,
  // then recency; whole items within the token budget; what does not fit is counted as omitted.
  async recall(
    request: RecallRequest,
    options?: MemoryCallOptions,
  ): Promise<Outcome<RecallBundle>> {
    const input = checked("recall-request", request);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused = this.refusal(accepted.scope, options);
    if (refused !== undefined) return refused;
    return this.guard(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const endpoint = connected.value;
      const types = typesOf(accepted.scope.kind, accepted.kinds);
      const project = engramProject(accepted.scope);
      const merged = new Map<string, WireObservation>();
      let universe = 0;
      for (const type of types ?? [undefined]) {
        const answer = await this.send(endpoint, budget, {
          method: "GET",
          path: "/context",
          query: {
            project,
            scope: accepted.scope.visibility,
            max_bytes: String(MAX_RECALL_BYTES),
            pinned: String(accepted.includePinned),
            type,
          },
        });
        const context =
          answer.kind === "answer" && answer.status === 200 ? readContext(answer.body) : undefined;
        if (context === undefined) return readFailure(answer);
        universe += context.total;
        for (const observation of context.observations) merged.set(observation.id, observation);
      }
      if (accepted.query !== undefined && queryTerms(accepted.query).length > 0) {
        const hits = await this.searchTypes(endpoint, budget, accepted.scope, {
          text: accepted.query,
          matchMode: "any",
          limit: MAX_SEARCH_RESULTS,
          types,
        });
        if (!hits.ok) return hits;
        for (const hit of hits.value) merged.set(hit.id, hit);
      }
      const candidates = [...merged.values()]
        .filter((observation) => observation.project === project && !observation.deleted)
        .filter((observation) => accepted.includePinned || !observation.pinned)
        .sort(byRelevance);
      const items: RecallItem[] = [];
      let usedTokens = 0;
      for (const observation of candidates) {
        if (items.length >= accepted.maxItems) break;
        const tokens = Math.max(
          0,
          Math.ceil(this.deps.estimateTokens(`${observation.title}\n${observation.content}`)),
        );
        if (usedTokens + tokens > accepted.budgetTokens) continue;
        usedTokens += tokens;
        items.push({
          ref: refOf(observation),
          kind: kindOfType(observation.type),
          title: observation.title,
          content: observation.content,
          tokens,
          trust: "untrusted",
          pinned: observation.pinned,
          updatedAt: observation.updatedAt,
        });
      }
      return ok({
        schemaVersion: 1,
        scope: { ...accepted.scope },
        budgetTokens: accepted.budgetTokens,
        usedTokens,
        items,
        omittedCount: Math.max(universe, candidates.length) - items.length,
        degraded: false,
      });
    });
  }

  // POST /sessions/{id}/end takes no operation_id: a replay is answered from the adapter's ledger, and after an
  // ambiguous failure or on an ended session the stored summary is compared with textSha256 (memory.md 4.2).
  async summarize(
    write: SummarizeWrite,
    options?: MemoryCallOptions,
  ): Promise<Outcome<WriteReceipt>> {
    const input = checked("summarize-write", write);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused =
      (accepted.session.provider === PROVIDER &&
      accepted.session.sessionId === accepted.scope.sessionId
        ? undefined
        : contractInvalid(
            "the summary's session is not the session of its scope in this provider",
          )) ??
      this.refusal(accepted.scope, options) ??
      (this.deps.hasher.sha256(accepted.text) === accepted.textSha256
        ? undefined
        : contractInvalid("the textSha256 is not the SHA-256 of the text")) ??
      (utf8Length(accepted.text) > MAX_CONTENT_BYTES
        ? contractInvalid(`the summary is over ${MAX_CONTENT_BYTES} bytes`)
        : undefined);
    if (refused !== undefined) return refused;
    const replay = this.replay(accepted.operationId, "summarize", accepted.textSha256);
    if (replay !== undefined) return replay as Outcome<WriteReceipt>;
    const budget = this.budget(options);
    return this.serialized(async () => {
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const endpoint = connected.value;
      const sessionPath = `/sessions/${encodeURIComponent(accepted.scope.sessionId)}`;
      const ended = await this.endSession(endpoint, budget, accepted, sessionPath);
      this.openSessions.delete(accepted.scope.sessionId);
      const result =
        ended === "compare"
          ? await this.compareSummary(endpoint, budget, accepted, sessionPath)
          : ended;
      if (result.ok) {
        this.remember(accepted.operationId, "summarize", accepted.textSha256, result.value);
      }
      return result;
    });
  }

  async consolidate(
    request: ConsolidationRequest,
    options?: MemoryCallOptions,
  ): Promise<Outcome<ConsolidationOutcome>> {
    const input = checked("consolidation-request", request);
    if (!input.ok) return input;
    const refused = this.refusal(input.value.scope, options);
    if (refused !== undefined) return refused;
    return this.guard(async () => {
      const connected = await this.connection(this.budget(options));
      if (!connected.ok) return connected;
      // core/memory consolidates with search, store and forget (CM-05).
      return memoryFailure(
        "Unsupported",
        `Engram ${this.options.engramVersion} has no plan-and-confirm consolidation`,
      );
    });
  }

  // A soft forget hides (DELETE keeps the row); a hard one deletes and leaves Engram's relations behind (#1780). The
  // record is read first, so another project's record is refused before any DELETE and a forgotten one is told.
  async forget(
    request: ForgetRequest,
    options?: MemoryCallOptions,
  ): Promise<Outcome<ForgetReceipt>> {
    const input = checked("forget-request", request);
    if (!input.ok) return input;
    const accepted = input.value;
    const refused = this.foreignRef(accepted.ref) ?? this.refusal(accepted.expectedScope, options);
    if (refused !== undefined) return refused;
    const fingerprint = forgetFingerprint(accepted);
    const replay = this.replay(accepted.operationId, "forget", fingerprint);
    if (replay !== undefined) return replay as Outcome<ForgetReceipt>;
    const budget = this.budget(options);
    return this.serialized(async () => {
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      if (accepted.mode === "hard" && !this.caps.hardDelete) {
        return memoryFailure("Unsupported", "a hard forget needs hardDelete");
      }
      const endpoint = connected.value;
      const project = engramProject(accepted.expectedScope);
      const found = await this.observation(endpoint, budget, accepted.ref.providerRef);
      if (!found.ok) return found;
      if (found.value.project !== project) {
        return memoryFailure("ScopeMismatch", "the record belongs to another project");
      }
      const receipt = (outcome: ForgetReceipt["outcome"]): ForgetReceipt => ({
        schemaVersion: 1,
        operationId: accepted.operationId,
        ref: { ...accepted.ref },
        mode: accepted.mode,
        outcome,
        erasure: accepted.mode === "hard" ? "deleted_with_residue" : "hidden",
      });
      const result =
        found.value.deleted && accepted.mode === "soft"
          ? ok(receipt("already_forgotten"))
          : await this.erase(endpoint, budget, accepted, project, receipt("forgotten"));
      if (result.ok) this.remember(accepted.operationId, "forget", fingerprint, result.value);
      return result;
    });
  }

  // GET /export (it needs the token) to a new file under the data dir; the content never travels in the result.
  async export(
    scope: ScopeRef | "all",
    format: ExportFormat,
    options?: MemoryCallOptions,
  ): Promise<Outcome<ExportArtifact>> {
    let owner: ScopeRef | undefined;
    if (scope !== "all") {
      const input = checked("scope-ref", scope);
      if (!input.ok) return input;
      const refused = this.refusal(input.value, options);
      if (refused !== undefined) return refused;
      owner = input.value;
    }
    const formatInput = checked("export-format", format);
    if (!formatInput.ok) return formatInput;
    return this.guard(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      if (
        this.caps.exportVersion === null ||
        formatInput.value.version !== this.caps.exportVersion
      ) {
        return memoryFailure(
          "Unsupported",
          `Engram exports version ${this.caps.exportVersion ?? "none"}`,
        );
      }
      const segment = owner === undefined ? "all" : exportSegment(owner.projectKey);
      if (segment === undefined)
        return contractInvalid("the projectKey cannot name an export directory");
      const answer = await this.send(connected.value, budget, {
        method: "GET",
        path: "/export",
        query: { project: owner === undefined ? undefined : engramProject(owner) },
      });
      if (answer.kind === "lost" || answer.status !== 200) return readFailure(answer);
      const exported = readExport(answer.body);
      if (exported === undefined || exported.version !== formatInput.value.version) {
        return unavailable("GET /export answered something that is not a version 0.2.0 export");
      }
      const directory =
        owner === undefined
          ? join(this.options.harilDataDir, "memory", "exports")
          : join(this.options.harilDataDir, "projects", segment, "exports");
      const path = join(directory, `engram-${segment}-${this.deps.ids.next()}.json`);
      await mkdir(directory, { recursive: true });
      await writeFile(`${path}.tmp`, answer.text, { encoding: "utf8", flag: "wx" });
      await rename(`${path}.tmp`, path);
      return ok({
        schemaVersion: 1,
        format: { ...formatInput.value },
        provider: PROVIDER,
        scope: owner === undefined ? "all" : { ...owner },
        path,
        sha256: this.deps.hasher.sha256(answer.text),
        size: Buffer.byteLength(answer.text, "utf8"),
        recordCount: exported.records,
        createdAt: this.deps.clock.now(),
      });
    });
  }

  // POST /import of a file under the data dir whose hash and version are checked before anything changes. Engram's
  // import is atomic and by sync_id (06 sec3.11), so a retry after a lost answer is safe. The project names are not
  // rewritten (MEM-T6 is NOT VERIFIED). A function property (see MemoryProvider.import).
  readonly import = async (
    artifact: ExportArtifact,
    options?: MemoryCallOptions,
  ): Promise<Outcome<ImportReport>> => {
    const input = checked("export-artifact", artifact);
    if (!input.ok) return input;
    const accepted = input.value;
    if (options?.signal?.cancelled === true) return cancelled();
    const budget = this.budget(options);
    return this.serialized(async () => {
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      if (!this.caps.importVersions.includes(accepted.format.version)) {
        return memoryFailure(
          "Unsupported",
          `Engram does not import version ${accepted.format.version}`,
        );
      }
      if (!isAbsolute(accepted.path) || !isInside(this.options.harilDataDir, accepted.path)) {
        return contractInvalid("the artifact is not a file under HARIL's data dir");
      }
      let text: string;
      try {
        text = await readFile(accepted.path, "utf8");
      } catch {
        return contractInvalid("the artifact's file cannot be read");
      }
      if (this.deps.hasher.sha256(text) !== accepted.sha256) {
        return contractInvalid("the artifact's file does not match its sha256");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return contractInvalid("the artifact's file is not JSON");
      }
      const exported = readExport(parsed);
      if (exported === undefined || exported.version !== accepted.format.version) {
        return memoryFailure("Unsupported", "the artifact's file is not the version it declares");
      }
      const answer = await this.send(connected.value, budget, {
        method: "POST",
        path: "/import",
        body: text,
      });
      if (answer.kind === "lost" || answer.status !== 200) return readFailure(answer);
      const report = readImport(answer.body);
      if (report === undefined)
        return unknownResult("POST /import answered something the adapter cannot read");
      return ok({
        schemaVersion: 1,
        format: { ...accepted.format },
        ...report,
        records: [],
        recordsTruncated: report.imported + report.updated > 0,
      });
    });
  };

  // ---- Internals ----

  private budget(options: MemoryCallOptions | undefined): CallBudget {
    return { deadlineAt: Date.now() + this.callDeadlineMs, signal: options?.signal };
  }

  // What every scoped call refuses before it is sent: a visibility without opt-in (MP-22), a cancelled signal, and a
  // workspaceId that would blur the Engram project.
  private refusal(
    scope: ScopeRef,
    options: MemoryCallOptions | undefined,
  ): Outcome<never> | undefined {
    if (!this.caps.visibilities.includes(scope.visibility)) {
      return memoryFailure("Unsupported", `the visibility ${scope.visibility} is not supported`);
    }
    if (options?.signal?.cancelled === true) return cancelled();
    if (scope.workspaceId.includes(PROJECT_SEPARATOR)) {
      return contractInvalid(`a workspaceId cannot contain "${PROJECT_SEPARATOR}"`);
    }
    return undefined;
  }

  private foreignRef(ref: MemoryRef): Outcome<never> | undefined {
    if (ref.provider === PROVIDER) return undefined;
    return contractInvalid(`the ref belongs to the provider ${ref.provider}, not ${PROVIDER}`);
  }

  // A verified serve, or Unavailable. The endpoint is refused before any request when it is not plain HTTP to
  // 127.0.0.1 on an allowed port; then GET /health must name the instance of HARIL's data dir and the pinned version.
  private async connection(budget: CallBudget): Promise<Outcome<EngramEndpoint>> {
    let connected: Result<EngramEndpoint, HarilError>;
    try {
      connected = await this.options.connect();
    } catch (error) {
      return unavailable("engram serve could not be started", { reason: String(error) });
    }
    if (!connected.ok) {
      return unavailable(connected.error.message, { serve: connected.error.code });
    }
    const endpoint = connected.value;
    const problem = endpointProblem(endpoint.baseUrl);
    if (problem !== undefined) return unavailable(problem, { refused: true });
    if (this.verified !== undefined && sameEndpoint(this.verified, endpoint)) return ok(endpoint);
    const answer = await this.send(endpoint, budget, { method: "GET", path: "/health" });
    if (answer.kind === "lost") return lostFailure(answer);
    const health = answer.status === 200 ? readHealth(answer.body) : undefined;
    if (health === undefined) return unavailable(`GET /health answered ${answer.status}`);
    if (health.instanceId !== endpoint.instanceId) {
      return unavailable("the serve on this port is not the instance of HARIL's data dir", {
        identity: true,
      });
    }
    if (health.version !== this.options.engramVersion) {
      return unavailable(
        `the serve is Engram ${health.version ?? "unknown"}, not the pinned ${this.options.engramVersion}`,
        { identity: true },
      );
    }
    this.verified = endpoint;
    return ok(endpoint);
  }

  // One request; a lost answer, a 5xx or a refused token makes the serve prove its identity again.
  private async send(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    request: EngramRequest,
  ): Promise<Exchange> {
    const answer = await exchange(this.fetchFn, endpoint, budget, this.requestTimeoutMs, request);
    if (
      answer.kind === "lost" ||
      answer.status >= 500 ||
      answer.status === 401 ||
      answer.status === 403
    ) {
      this.verified = undefined;
    }
    return answer;
  }

  // POST /sessions, idempotent while the session is open; a session this adapter opened is not asked again.
  private async openSession(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    scope: ScopeRef,
  ): Promise<Outcome<void>> {
    const project = engramProject(scope);
    if (this.openSessions.get(scope.sessionId) === project) return ok(undefined);
    const answer = await this.send(endpoint, budget, {
      method: "POST",
      path: "/sessions",
      body: { id: scope.sessionId, project },
    });
    if (isSuccess(answer)) {
      this.openSessions.set(scope.sessionId, project);
      return ok(undefined);
    }
    return readFailure(answer);
  }

  private async observation(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    providerRef: string,
  ): Promise<Outcome<WireObservation>> {
    if (!isEngramId(providerRef))
      return memoryFailure("NotFound", "the ref is not an Engram observation id");
    const answer = await this.send(endpoint, budget, {
      method: "GET",
      path: `/observations/${encodeURIComponent(providerRef)}`,
    });
    const observation =
      answer.kind === "answer" && answer.status === 200 ? readObservation(answer.body) : undefined;
    return observation === undefined ? readFailure(answer) : ok(observation);
  }

  // GET /search once per Engram type (one request when no type narrows), only rows of the scope's project kept.
  private async searchTypes(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    scope: ScopeRef,
    query: {
      readonly text: string;
      readonly matchMode: MemoryQuery["matchMode"];
      readonly limit: number;
      readonly types: readonly string[] | undefined;
    },
  ): Promise<Outcome<WireObservation[]>> {
    const project = engramProject(scope);
    const found = new Map<string, WireObservation>();
    for (const type of query.types ?? [undefined]) {
      const answer = await this.send(endpoint, budget, {
        method: "GET",
        path: "/search",
        query: {
          q: query.text,
          project,
          scope: scope.visibility,
          type,
          limit: String(query.limit),
          match_mode: query.matchMode,
        },
      });
      const results =
        answer.kind === "answer" && answer.status === 200 ? readSearch(answer.body) : undefined;
      if (results === undefined) return readFailure(answer);
      for (const observation of results) {
        if (observation.project === project && !observation.deleted)
          found.set(observation.id, observation);
      }
    }
    return ok([...found.values()]);
  }

  // The answer of POST /observations; an ambiguous one is resolved through save-result before it is returned (R-O6).
  private async stored(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    write: MemoryWrite,
    prepared: Prepared,
    sent: Exchange,
  ): Promise<Outcome<WriteReceipt>> {
    if (sent.kind === "lost" && sent.cause === "cancelled") return cancelled();
    if (sent.kind === "answer") {
      const saved = isSuccess(sent) ? readSaveResult(sent.body) : undefined;
      if (saved !== undefined) return ok(this.storeReceipt(write, prepared, saved));
      if (sent.status === 409 && errorCodeOf(sent.body, sent.text) === "session_already_ended") {
        this.openSessions.delete(write.scope.sessionId);
      }
      if (sent.status === 404) {
        // The session this adapter opened is unknown to the serve (its data dir changed): open it on the retry.
        this.openSessions.delete(write.scope.sessionId);
        return unavailable("engram serve does not know the session", { status: 404 });
      }
      // A 409 that names no session or scope code is a reused operationId with other content (CM-12).
      if (sent.status >= 400 && !isAmbiguous(sent)) return failureOf(sent);
    }
    const lookup = await this.send(endpoint, budget, {
      method: "GET",
      path: "/observations/save-result",
      query: { operation_id: write.operationId },
    });
    if (lookup.kind === "answer") {
      if (lookup.status === 200) {
        const saved = readSaveResult(lookup.body);
        if (saved !== undefined) return ok(this.storeReceipt(write, prepared, saved));
        return unknownResult("save-result answered something the adapter cannot read");
      }
      if (lookup.status === 404) {
        return unavailable("the write was not applied; its retry is safe", { notApplied: true });
      }
      if (lookup.status === 410)
        return unknownResult("save-result no longer knows the operation (410)");
    } else if (lookup.cause === "cancelled") {
      return cancelled();
    }
    // Not known yet: a retry with the same operationId goes through Engram's ledger and cannot write twice.
    const why = sent.kind === "lost" ? sent : lookup.kind === "lost" ? lookup : undefined;
    return unavailable("the result of the write is not known yet", {
      ...(why === undefined ? {} : why.cause === "timeout" ? { timeout: true } : { network: true }),
    });
  }

  private storeReceipt(
    write: MemoryWrite,
    prepared: Prepared,
    saved: WireSaveResult,
  ): WriteReceipt {
    return {
      schemaVersion: 1,
      operationId: write.operationId,
      provider: PROVIDER,
      providerRef: saved.id,
      ...(saved.syncId === undefined ? {} : { syncId: saved.syncId }),
      outcome: saved.outcome,
      truncated: prepared.truncated,
      redacted: prepared.redacted,
      ...(prepared.truncated
        ? { originalBytes: prepared.originalBytes, limitBytes: MAX_CONTENT_BYTES }
        : {}),
    };
  }

  private summaryReceipt(write: SummarizeWrite, outcome: WriteReceipt["outcome"]): WriteReceipt {
    return {
      schemaVersion: 1,
      operationId: write.operationId,
      provider: PROVIDER,
      outcome,
      truncated: false,
      redacted: false,
    };
  }

  // The ended session's summary decides: the same text is deduped, another one SessionEnded; a session still open
  // means the end was not applied.
  private async compareSummary(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    write: SummarizeWrite,
    sessionPath: string,
  ): Promise<Outcome<WriteReceipt>> {
    const answer = await this.send(endpoint, budget, { method: "GET", path: sessionPath });
    const session =
      answer.kind === "answer" && answer.status === 200 ? readSession(answer.body) : undefined;
    if (session === undefined) {
      if (answer.kind === "lost") return lostFailure(answer);
      return answer.status === 200
        ? unknownResult("GET /sessions answered something unreadable")
        : failureOf(answer);
    }
    if (session.project !== engramProject(write.scope)) {
      return memoryFailure("ScopeMismatch", "the session belongs to another project");
    }
    if (!session.ended)
      return unavailable("the session did not end; its retry is safe", { notApplied: true });
    if (session.summary !== null && this.deps.hasher.sha256(session.summary) === write.textSha256) {
      return ok(this.summaryReceipt(write, "deduped"));
    }
    return memoryFailure("SessionEnded", "the session already ended with another summary");
  }

  // What POST /sessions/{id}/end settled: a receipt, a failure, or "compare" when only the stored summary can tell
  // (the session had already ended, or the answer was lost or ambiguous).
  private async endSession(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    write: SummarizeWrite,
    sessionPath: string,
  ): Promise<Outcome<WriteReceipt> | "compare"> {
    const opened = await this.openSession(endpoint, budget, write.scope);
    if (!opened.ok) return opened.error.code === "SessionEnded" ? "compare" : opened;
    const sent = await this.send(endpoint, budget, {
      method: "POST",
      path: `${sessionPath}/end`,
      body: { summary: write.text },
    });
    if (sent.kind === "lost") return sent.cause === "cancelled" ? cancelled() : "compare";
    if (isSuccess(sent)) return ok(this.summaryReceipt(write, "created"));
    if (isAmbiguous(sent)) return "compare";
    const failure = failureOf(sent);
    return !failure.ok && failure.error.code === "SessionEnded" ? "compare" : failure;
  }

  // DELETE /observations/{id}?expected_project=X[&hard=true]. After an ambiguous answer the record says whether it
  // went: hidden or gone is forgotten, still live means the forget was not applied.
  private async erase(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    request: ForgetRequest,
    project: string,
    forgotten: ForgetReceipt,
  ): Promise<Outcome<ForgetReceipt>> {
    const sent = await this.send(endpoint, budget, {
      method: "DELETE",
      path: `/observations/${encodeURIComponent(request.ref.providerRef)}`,
      query: { expected_project: project, hard: request.mode === "hard" ? "true" : undefined },
    });
    if (isSuccess(sent)) return ok(forgotten);
    if (sent.kind === "lost" && sent.cause === "cancelled") return cancelled();
    if (sent.kind === "answer" && !isAmbiguous(sent)) return failureOf(sent);
    const after = await this.observation(endpoint, budget, request.ref.providerRef);
    if (!after.ok) {
      return after.error.code === "NotFound" && request.mode === "hard" ? ok(forgotten) : after;
    }
    if (request.mode === "soft" && after.value.deleted) return ok(forgotten);
    return unavailable("the forget was not applied; its retry is safe", { notApplied: true });
  }

  private replay(operationId: string, operation: LedgerEntry["operation"], fingerprint: string) {
    const first = this.ledger.get(operationId);
    if (first === undefined) return undefined;
    if (first.operation !== operation || first.fingerprint !== fingerprint) {
      return contractInvalid("the operationId was already used with another request");
    }
    return ok(structuredClone(first.receipt));
  }

  private remember(
    operationId: string,
    operation: LedgerEntry["operation"],
    fingerprint: string,
    receipt: WriteReceipt | ForgetReceipt,
  ): void {
    if (this.ledger.size >= LEDGER_LIMIT) {
      const oldest = this.ledger.keys().next().value;
      if (oldest !== undefined) this.ledger.delete(oldest);
    }
    this.ledger.set(operationId, { operation, fingerprint, receipt: structuredClone(receipt) });
  }

  private hitOf(observation: WireObservation): MemoryHit {
    const hit: MemoryHit = {
      ref: refOf(observation),
      kind: kindOfType(observation.type),
      title: observation.title,
      snippet: Array.from(observation.content).slice(0, SNIPPET_CHARS).join(""),
      score: observation.score ?? null,
      pinned: observation.pinned,
      updatedAt: observation.updatedAt,
    };
    return observation.topicKey === undefined ? hit : { ...hit, topicKey: observation.topicKey };
  }

  private recordOf(observation: WireObservation, asked: ScopeRef): MemoryRecord {
    const record: MemoryRecord = {
      ref: refOf(observation),
      scope: scopeOf(observation, asked),
      kind: kindOfType(observation.type),
      title: observation.title,
      content: observation.content,
      pinned: observation.pinned,
      ...(observation.revisionCount !== undefined && observation.revisionCount >= 1
        ? { revisionCount: observation.revisionCount }
        : {}),
      ...(observation.duplicateCount === undefined
        ? {}
        : { duplicateCount: observation.duplicateCount }),
      createdAt: observation.createdAt,
      updatedAt: observation.updatedAt,
      deleted: observation.deleted,
    };
    return observation.topicKey === undefined
      ? record
      : { ...record, topicKey: observation.topicKey };
  }

  // Writes towards serve run one at a time, in call order.
  private serialized<T>(run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const next = this.writes.then(
      () => this.guard(run),
      () => this.guard(run),
    );
    this.writes = next;
    return next;
  }

  // An expected failure is a typed result; an unexpected one (a defect, a file system error) becomes an unknown
  // result rather than a throw, because a write may have gone through.
  private async guard<T>(run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    try {
      return await run();
    } catch (error) {
      return unknownResult("the Engram adapter failed unexpectedly", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
