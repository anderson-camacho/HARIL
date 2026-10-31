// EngramMemoryProvider (memory.md 9.4; MEMORY.md 4; ADR-0008 D4, D6): the MemoryProvider port over the HTTP API of a
// `engram serve` HARIL started, on 127.0.0.1 only. Every scoped request names its project and session explicitly
// (never all_projects, never the cwd); every write sends capture_prompt false and its operationId; an answer maps to
// a typed failure (answers.ts); an ambiguous write is settled before it returns (settle.ts); each call has its own
// deadline. Before it is used, a serve must prove it is the instance of HARIL's data dir and the pinned version (GET
// /health), and it proves it again after any failure. Time, ids and hashes come from the injected dependencies; the
// network deadline is real time.
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
  MemoryKind,
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
import { cancelled, failureOfExchange, isSuccess, lostFailure } from "./answers.js";
import { exportFileOf, readArtifact, writeExport } from "./archive.js";
import {
  capabilitiesOf,
  copyCapabilities,
  MAX_CONTENT_BYTES,
  MAX_RECALL_BYTES,
  MAX_SEARCH_RESULTS,
  PROVIDER,
  TOPIC_KEY_MAX_BYTES,
} from "./capabilities.js";
import {
  type CallBudget,
  type EngramEndpoint,
  type EngramRequest,
  type Exchange,
  exchange,
  type FetchFn,
} from "./http.js";
import { OperationLedger } from "./ledger.js";
import { endpointProblem } from "./loopback.js";
import {
  engramProject,
  engramTypeOf,
  kindOfType,
  kindsOf,
  PROJECT_SEPARATOR,
  typesOf,
} from "./mapping.js";
import { belongsTo, byRelevance, hitOf, recordOf, refOf } from "./records.js";
import {
  type Channel,
  compareSummary,
  endSession,
  eraseObservation,
  prepare,
  settleStore,
} from "./settle.js";
import {
  checked,
  contractInvalid,
  memoryFailure,
  type Outcome,
  ok,
  queryTerms,
  unavailable,
  unknownResult,
  utf8Length,
} from "./support.js";
import {
  isEngramId,
  readContext,
  readExport,
  readHealth,
  readImport,
  readObservation,
  readSearch,
  type WireObservation,
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

// [S]: under the 5 s an outbox drain allows (MC-T4), with room for the lookup that resolves an ambiguous write.
export const ENGRAM_CALL_DEADLINE_MS = 4_000;
export const ENGRAM_REQUEST_TIMEOUT_MS = 1_500;
// HARIL's own Engram projects start with this workspace prefix, which a StoreId (a ULID) never has; a scope that
// would produce one is refused, so no caller can reach them.
const RESERVED_WORKSPACE = "_haril";
// The project the real read of health() searches.
const HEALTH_PROJECT = `${RESERVED_WORKSPACE}${PROJECT_SEPARATOR}health`;

function sameEndpoint(a: EngramEndpoint, b: EngramEndpoint): boolean {
  return a.baseUrl === b.baseUrl && a.instanceId === b.instanceId && a.token === b.token;
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
  private readonly ledger = new OperationLedger();
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
        query:
          this.options.engramVersion === "3.6.0"
            ? { q: "haril health", all_projects: "true", scope: "project", limit: "1" }
            : { q: "haril health", project: HEALTH_PROJECT, scope: "project", limit: "1" },
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
    return this.catchingDefects(async () => {
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
      const channel = this.channel(connected.value, budget);
      const opened = await channel.openSession(accepted.scope);
      if (!opened.ok) return opened;
      const prepared = prepare(accepted);
      const sent = await channel.send({
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
      return settleStore(channel, accepted, prepared, sent);
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
    return this.catchingDefects(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const found = await this.searchKinds(connected.value, budget, accepted.scope, {
        text: accepted.text,
        matchMode: accepted.matchMode,
        limit: accepted.limit,
        kinds: kindsOf(accepted.scope.kind, accepted.kinds),
      });
      if (!found.ok) return found;
      const items = [...found.value].sort(byRelevance).slice(0, accepted.limit).map(hitOf);
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
    return this.catchingDefects(async () => {
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
      return ok(recordOf(found.value, scopeInput.value));
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
    return this.catchingDefects(async () => {
      const budget = this.budget(options);
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const endpoint = connected.value;
      const kinds = kindsOf(accepted.scope.kind, accepted.kinds);
      const project = engramProject(accepted.scope);
      const wanted = (observation: WireObservation): boolean =>
        belongsTo(observation, project, accepted.scope, kinds) &&
        (accepted.includePinned || !observation.pinned);
      const merged = new Map<string, WireObservation>();
      let universe = 0;
      let filtersHeld = true;
      for (const type of typesOf(kinds) ?? [undefined]) {
        const answer = await this.send(endpoint, budget, {
          method: "GET",
          path: this.options.engramVersion === "3.6.0" ? "/observations/recent" : "/context",
          query: {
            limit: "50",
            project,
            scope: accepted.scope.visibility,
            max_bytes: String(MAX_RECALL_BYTES),
            pinned: String(accepted.includePinned),
            type,
          },
        });
        const recent =
          answer.kind === "answer" &&
          answer.status === 200 &&
          this.options.engramVersion === "3.6.0"
            ? readSearch(answer.body)
            : undefined;
        const context =
          recent === undefined
            ? answer.kind === "answer" && answer.status === 200
              ? readContext(answer.body)
              : undefined
            : { observations: recent, total: recent.length };
        if (context === undefined) return failureOfExchange(answer);
        universe += context.total;
        for (const observation of context.observations) {
          if (!wanted(observation)) filtersHeld = false;
          merged.set(observation.id, observation);
        }
      }
      if (accepted.query !== undefined && queryTerms(accepted.query).length > 0) {
        const hits = await this.searchKinds(endpoint, budget, accepted.scope, {
          text: accepted.query,
          matchMode: "any",
          limit: MAX_SEARCH_RESULTS,
          kinds,
        });
        if (!hits.ok) return hits;
        for (const hit of hits.value) merged.set(hit.id, hit);
      }
      const candidates = [...merged.values()].filter(wanted).sort(byRelevance);
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
      // A /context that ignored scope, type or pinned counts in its total rows the adapter drops, so then only what
      // was seen is counted [S].
      const seen = filtersHeld ? Math.max(universe, candidates.length) : candidates.length;
      return ok({
        schemaVersion: 1,
        scope: { ...accepted.scope },
        budgetTokens: accepted.budgetTokens,
        usedTokens,
        items,
        omittedCount: seen - items.length,
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
    const replay = this.ledger.replay<WriteReceipt>(
      accepted.operationId,
      "summarize",
      accepted.textSha256,
    );
    if (replay !== undefined) return replay;
    const budget = this.budget(options);
    return this.serialized(async () => {
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      const channel = this.channel(connected.value, budget);
      const sessionPath = `/sessions/${encodeURIComponent(accepted.scope.sessionId)}`;
      const ended = await endSession(channel, accepted, sessionPath);
      channel.dropSession(accepted.scope.sessionId);
      const result =
        ended === "compare" ? await compareSummary(channel, accepted, sessionPath) : ended;
      if (result.ok) {
        this.ledger.remember(accepted.operationId, "summarize", accepted.textSha256, result.value);
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
    return this.catchingDefects(async () => {
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
  // record is read first, so another project's record is refused before any DELETE and a forgotten one is told; a
  // hard forget this adapter sent whose answer was lost finds the record gone on its retry, and that is its success.
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
    const replay = this.ledger.replay<ForgetReceipt>(accepted.operationId, "forget", fingerprint);
    if (replay !== undefined) return replay;
    const budget = this.budget(options);
    return this.serialized(async () => {
      const connected = await this.connection(budget);
      if (!connected.ok) return connected;
      if (accepted.mode === "hard" && !this.caps.hardDelete) {
        return memoryFailure("Unsupported", "a hard forget needs hardDelete");
      }
      const channel = this.channel(connected.value, budget);
      const receipt = (outcome: ForgetReceipt["outcome"]): ForgetReceipt => ({
        schemaVersion: 1,
        operationId: accepted.operationId,
        ref: { ...accepted.ref },
        mode: accepted.mode,
        outcome,
        erasure: accepted.mode === "hard" ? "deleted_with_residue" : "hidden",
      });
      const found = await channel.observation(accepted.ref.providerRef);
      let result: Outcome<ForgetReceipt>;
      if (!found.ok) {
        const sentBefore =
          found.error.code === "NotFound" &&
          accepted.mode === "hard" &&
          this.ledger.sentHardForget(accepted.operationId);
        if (!sentBefore) return found;
        result = ok(receipt("forgotten"));
      } else if (found.value.project !== engramProject(accepted.expectedScope)) {
        return memoryFailure("ScopeMismatch", "the record belongs to another project");
      } else if (found.value.deleted && accepted.mode === "soft") {
        result = ok(receipt("already_forgotten"));
      } else {
        if (accepted.mode === "hard") this.ledger.sendingHardForget(accepted.operationId);
        result = await eraseObservation(
          channel,
          accepted,
          engramProject(accepted.expectedScope),
          receipt("forgotten"),
        );
      }
      if (result.ok)
        this.ledger.remember(accepted.operationId, "forget", fingerprint, result.value);
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
    return this.catchingDefects(async () => {
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
      const file = exportFileOf(this.options.harilDataDir, owner?.projectKey, this.deps.ids.next());
      if (!file.ok) return file;
      const answer = await this.send(connected.value, budget, {
        method: "GET",
        path: "/export",
        query: { project: owner === undefined ? undefined : engramProject(owner) },
      });
      if (answer.kind === "lost" || answer.status !== 200) return failureOfExchange(answer);
      const exported = readExport(answer.body);
      if (exported === undefined || exported.version !== formatInput.value.version) {
        return unavailable("GET /export answered something that is not a version 0.2.0 export");
      }
      await writeExport(file.value, answer.text);
      return ok({
        schemaVersion: 1,
        format: { ...formatInput.value },
        provider: PROVIDER,
        scope: owner === undefined ? "all" : { ...owner },
        path: file.value.path,
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
      const text = await readArtifact(this.options.harilDataDir, accepted, this.deps.hasher);
      if (!text.ok) return text;
      const answer = await this.send(connected.value, budget, {
        method: "POST",
        path: "/import",
        body: text.value,
      });
      if (answer.kind === "lost" || answer.status !== 200) return failureOfExchange(answer);
      const report = readImport(answer.body);
      if (report === undefined) {
        return unknownResult("POST /import answered something the adapter cannot read");
      }
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
  // workspaceId that would blur the Engram project or reach one of HARIL's own.
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
    if (scope.workspaceId.startsWith(RESERVED_WORKSPACE)) {
      return contractInvalid(`a workspaceId cannot start with "${RESERVED_WORKSPACE}"`);
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
    const answer = await this.send(endpoint, budget, {
      method: "GET",
      path: "/health",
      anonymous: true,
    });
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

  // The requests of one call to a verified serve, as settle.ts needs them.
  private channel(endpoint: EngramEndpoint, budget: CallBudget): Channel {
    return {
      send: (request) => this.send(endpoint, budget, request),
      openSession: (scope) => this.openSession(endpoint, budget, scope),
      dropSession: (sessionId) => {
        this.openSessions.delete(sessionId);
      },
      observation: (providerRef) => this.observation(endpoint, budget, providerRef),
      hasher: this.deps.hasher,
    };
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
    return failureOfExchange(answer);
  }

  private async observation(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    providerRef: string,
  ): Promise<Outcome<WireObservation>> {
    if (!isEngramId(providerRef)) {
      return memoryFailure("NotFound", "the ref is not an Engram observation id");
    }
    const answer = await this.send(endpoint, budget, {
      method: "GET",
      path: `/observations/${encodeURIComponent(providerRef)}`,
    });
    const observation =
      answer.kind === "answer" && answer.status === 200 ? readObservation(answer.body) : undefined;
    return observation === undefined ? failureOfExchange(answer) : ok(observation);
  }

  // GET /search once per Engram type (one request when no kind narrows); only the rows that belong to the scope, by
  // project, visibility and kind, are kept, whatever the serve did with its scope and type parameters.
  private async searchKinds(
    endpoint: EngramEndpoint,
    budget: CallBudget,
    scope: ScopeRef,
    query: {
      readonly text: string;
      readonly matchMode: MemoryQuery["matchMode"];
      readonly limit: number;
      readonly kinds: readonly MemoryKind[] | undefined;
    },
  ): Promise<Outcome<WireObservation[]>> {
    const project = engramProject(scope);
    const found = new Map<string, WireObservation>();
    for (const type of typesOf(query.kinds) ?? [undefined]) {
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
      if (results === undefined) return failureOfExchange(answer);
      for (const observation of results) {
        if (belongsTo(observation, project, scope, query.kinds)) {
          found.set(observation.id, observation);
        }
      }
    }
    return ok([...found.values()]);
  }

  // Writes towards serve run one at a time, in call order.
  private serialized<T>(run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    const next = this.writes.then(
      () => this.catchingDefects(run),
      () => this.catchingDefects(run),
    );
    this.writes = next;
    return next;
  }

  // An expected failure is a typed result; an unexpected exception (a defect, a file system error) becomes an
  // unknown result rather than a throw, because a write may have gone through.
  private async catchingDefects<T>(run: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    try {
      return await run();
    } catch (error) {
      return unknownResult("the Engram adapter failed unexpectedly", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
