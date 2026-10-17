import {
  type ConsolidationRequest,
  type ExportArtifact,
  type ExportFormat,
  type ForgetRequest,
  type MemoryCapabilities,
  type MemoryHealth,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRef,
  type MemorySchemaName,
  type MemorySchemaValue,
  type MemoryWrite,
  type MemoryWriteScope,
  type RecallBundle,
  type RecallRequest,
  type ScopeRef,
  type SummarizeWrite,
  validateMemoryValue,
  type WriteReceipt,
} from "@haril/contracts";
import { canonicalJson } from "../src/domain/index.js";
import type {
  MemoryFailure,
  MemoryOperation,
  MemoryProvider,
  MemoryProviderDeps,
  MemoryResult,
  MemoryWriteOperation,
  Result,
} from "../src/ports/index.js";
import { cancelSignal } from "./fake-memory-deps.js";

// Contract suite of the MemoryProvider port (docs/contracts/memory.md 8.1; ADR-0008 T1; BL-047). It is written once and
// run against every implementation: Null, InMemory and the fault fake in packages/core/tests, the Engram adapter in M4.
// A case reads capabilities() and, when a capability is false, asserts the typed Unsupported instead of skipping
// (MEM-15). The suite imports no test framework (the Core depends on no external package): the caller passes its
// describe and it, and a failed check throws a ContractViolation.

// The part of a test framework the suite needs (vitest's describe and it fit).
export interface ContractTestApi {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
}

// Fault injection the subject may offer (memory.md 9.3). Null and InMemory never fail by themselves, so the cases that
// need a failing provider (MP-17, MP-18) run only when a subject brings these controls.
export interface MemoryFaultControls {
  // Every operation, or one, answers Unavailable until restore().
  makeUnavailable(operation?: MemoryOperation): void;
  restore(): void;
  // The next call of this write takes effect but its answer is lost: it answers Unavailable.
  ambiguousNext(operation: MemoryWriteOperation): void;
}

export interface MemoryContractSubject {
  readonly provider: MemoryProvider;
  // The dependencies the provider was given; the suite hashes and estimates with the same ones.
  readonly deps: MemoryProviderDeps;
  readonly faults?: MemoryFaultControls;
  teardown?(): Promise<void>;
}

// A fresh, empty provider for each case.
export type MemoryProviderFactory = () => MemoryContractSubject | Promise<MemoryContractSubject>;

export interface MemoryProviderContractOptions {
  // False for a provider that discards every write (Null, memory.md 9.2): the cases then assert discarded receipts and
  // empty reads instead of reading back what was stored. A provider that retains writes never answers discarded.
  readonly retainsWrites: boolean;
}

export class ContractViolation extends Error {}

interface ContractCase {
  readonly id: string;
  readonly title: string;
  run(ctx: CaseContext): Promise<void>;
}

const WORKSPACE = "fake-workspace";
const OTHER_WORKSPACE = "fake-workspace-other";
const PROJECT_A = "fake-project-a";
const PROJECT_B = "fake-project-b";

function sessionId(n: number): string {
  return `01HMEMSESSION${String(n).padStart(13, "0")}`;
}

const SCOPE_A: ScopeRef = {
  workspaceId: WORKSPACE,
  projectKey: PROJECT_A,
  visibility: "project",
  sessionId: sessionId(1),
};
const SCOPE_B: ScopeRef = {
  workspaceId: WORKSPACE,
  projectKey: PROJECT_B,
  visibility: "project",
  sessionId: sessionId(2),
};
// The closest collision with A: the same projectKey in another workspace (another user's haril.db).
const SCOPE_A_ELSEWHERE: ScopeRef = {
  workspaceId: OTHER_WORKSPACE,
  projectKey: PROJECT_A,
  visibility: "project",
  sessionId: sessionId(4),
};

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ContractViolation(message);
}

function shown(value: unknown): string {
  const text = canonicalJson(value) ?? String(value);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function same(actual: unknown, expected: unknown, what: string): void {
  check(
    canonicalJson(actual) === canonicalJson(expected),
    `${what}: expected ${shown(expected)}, got ${shown(actual)}`,
  );
}

function validated<N extends MemorySchemaName>(
  what: string,
  schema: N,
  value: unknown,
): MemorySchemaValue<N> {
  const validation = validateMemoryValue(schema, value);
  if (!validation.ok) {
    throw new ContractViolation(
      `${what}: the result does not validate as memory.${schema}: ${validation.errors.join("; ")}`,
    );
  }
  return validation.value;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// A typed failure has the category and retryability of its code (memory.md 3.3).
function checkFailureShape(what: string, error: MemoryFailure): void {
  const contract = error.code === "contract.invalid";
  check(
    error.category === (contract ? "contract" : "memory"),
    `${what}: ${error.code} must have category ${contract ? "contract" : "memory"}, got ${error.category}`,
  );
  check(
    error.retryable === (error.code === "Unavailable"),
    `${what}: only Unavailable is retryable, got ${error.code} with retryable ${error.retryable}`,
  );
  check(error.message.length > 0, `${what}: a failure needs a message`);
}

// Runs one call and insists on a typed result: an operation never throws for an expected failure.
async function settle<T>(
  what: string,
  call: () => MemoryResult<T>,
): Promise<Result<T, MemoryFailure>> {
  let result: Result<T, MemoryFailure>;
  try {
    result = await call();
  } catch (error) {
    throw new ContractViolation(
      `${what} threw instead of returning a typed result: ${String(error)}`,
    );
  }
  check(
    typeof result === "object" && result !== null && typeof result.ok === "boolean",
    `${what} did not return a Result`,
  );
  return result;
}

async function expectOk<N extends MemorySchemaName>(
  what: string,
  schema: N,
  call: () => MemoryResult<unknown>,
): Promise<MemorySchemaValue<N>> {
  const result = await settle(what, call);
  if (!result.ok) {
    throw new ContractViolation(
      `${what}: expected ok, got ${result.error.code} (${result.error.message})`,
    );
  }
  return validated(what, schema, result.value);
}

async function expectFailure(
  what: string,
  code: MemoryFailure["code"],
  call: () => MemoryResult<unknown>,
): Promise<MemoryFailure> {
  const result = await settle(what, call);
  if (result.ok) throw new ContractViolation(`${what}: expected ${code}, got ok`);
  check(
    result.error.code === code,
    `${what}: expected ${code}, got ${result.error.code} (${result.error.message})`,
  );
  checkFailureShape(what, result.error);
  return result.error;
}

interface WriteFields {
  readonly scope?: ScopeRef;
  readonly kind?: MemoryKind;
  readonly title?: string;
  readonly content?: string;
  readonly topicKey?: string;
  readonly origin?: MemoryWrite["origin"];
}

// Fixtures and checked calls for one case, bound to one fresh subject.
class CaseContext {
  readonly subject: MemoryContractSubject;
  readonly options: MemoryProviderContractOptions;
  readonly make: MemoryProviderFactory;
  readonly caps: MemoryCapabilities;
  private operations = 0;

  constructor(
    subject: MemoryContractSubject,
    options: MemoryProviderContractOptions,
    make: MemoryProviderFactory,
  ) {
    this.subject = subject;
    this.options = options;
    this.make = make;
    this.caps = subject.provider.capabilities();
  }

  get provider(): MemoryProvider {
    return this.subject.provider;
  }

  get deps(): MemoryProviderDeps {
    return this.subject.deps;
  }

  get retains(): boolean {
    return this.options.retainsWrites;
  }

  operationId(): string {
    this.operations += 1;
    return `fake-op-${this.operations}`;
  }

  sha(text: string): string {
    return this.deps.hasher.sha256(text);
  }

  ref(providerRef: string): MemoryRef {
    return { provider: this.caps.provider, providerRef };
  }

  refOf(receipt: WriteReceipt): MemoryRef {
    check(receipt.providerRef !== undefined, "a retained write must name its providerRef");
    const ref: MemoryRef = { provider: receipt.provider, providerRef: receipt.providerRef };
    return receipt.syncId === undefined ? ref : { ...ref, syncId: receipt.syncId };
  }

  write(fields: WriteFields = {}): MemoryWrite {
    const content = fields.content ?? "fake memory content";
    const scope: MemoryWriteScope = {
      ...(fields.scope ?? SCOPE_A),
      kind: fields.kind ?? "discovery",
    };
    const write: MemoryWrite = {
      schemaVersion: 1,
      operationId: this.operationId(),
      scope,
      title: fields.title ?? "fake memory",
      content,
      contentSha256: this.sha(content),
      origin: fields.origin ?? "haril",
    };
    return fields.topicKey === undefined ? write : { ...write, topicKey: fields.topicKey };
  }

  summary(scope: ScopeRef, text: string): SummarizeWrite {
    return {
      schemaVersion: 1,
      operationId: this.operationId(),
      scope,
      session: { provider: this.caps.provider, sessionId: scope.sessionId },
      text,
      textSha256: this.sha(text),
    };
  }

  query(scope: ScopeRef, text: string): MemoryQuery {
    return { schemaVersion: 1, scope, text, matchMode: "all", limit: this.caps.maxSearchResults };
  }

  recall(scope: ScopeRef, budgetTokens: number, maxItems = 50): RecallRequest {
    return { schemaVersion: 1, scope, budgetTokens, includePinned: true, maxItems };
  }

  forget(ref: MemoryRef, mode: ForgetRequest["mode"]): ForgetRequest {
    const request: ForgetRequest = {
      schemaVersion: 1,
      operationId: this.operationId(),
      ref,
      mode,
      expectedScope: SCOPE_A,
    };
    return mode === "hard" ? { ...request, authorizedBy: "fake-approval-1" } : request;
  }

  consolidation(scope: ScopeRef, sources: MemoryRef[], apply = false): ConsolidationRequest {
    return { schemaVersion: 1, operationId: this.operationId(), scope, sources, apply };
  }

  exportFormat(): ExportFormat {
    return { id: "engram-export", version: this.caps.exportVersion ?? "0.2.0" };
  }

  artifact(): ExportArtifact {
    return {
      schemaVersion: 1,
      format: this.exportFormat(),
      provider: this.caps.provider,
      scope: SCOPE_A,
      path: "D:/fake-data/exports/fake-export.json",
      sha256: this.sha(""),
      size: 0,
      recordCount: 0,
      createdAt: 0,
    };
  }

  storeOk(write: MemoryWrite, what = "store"): Promise<WriteReceipt> {
    return expectOk(what, "write-receipt", () => this.provider.store(write));
  }

  summarizeOk(write: SummarizeWrite, what = "summarize"): Promise<WriteReceipt> {
    return expectOk(what, "write-receipt", () => this.provider.summarize(write));
  }

  recallOk(request: RecallRequest, what = "recall"): Promise<RecallBundle> {
    return expectOk(what, "recall-bundle", () => this.provider.recall(request));
  }

  async healthOk(what: string): Promise<MemoryHealth> {
    let health: MemoryHealth;
    try {
      health = await this.provider.health();
    } catch (error) {
      throw new ContractViolation(`${what} threw: health() never fails (${String(error)})`);
    }
    return validated(what, "health", health);
  }

  async searchRefs(
    scope: ScopeRef,
    text: string,
    narrowed: Partial<Pick<MemoryQuery, "kinds" | "matchMode" | "limit">> = {},
  ): Promise<string[]> {
    const page = await expectOk(`search "${text}"`, "hit-page", () =>
      this.provider.search({ ...this.query(scope, text), ...narrowed }),
    );
    check(
      page.next === undefined || this.caps.pagination,
      "search returned a cursor without pagination",
    );
    return page.items.map((hit) => hit.ref.providerRef);
  }

  // The providerRefs of retained writes, sorted; none for a discarding provider.
  refsOf(receipts: readonly WriteReceipt[]): string[] {
    return this.retains ? receipts.map((receipt) => this.refOf(receipt).providerRef).sort() : [];
  }

  async storedContent(receipt: WriteReceipt, scope: ScopeRef = SCOPE_A): Promise<string> {
    const record = await expectOk("get", "record", () =>
      this.provider.get(this.refOf(receipt), scope),
    );
    return record.content;
  }

  // A retaining provider answers the given outcome; a discarding one answers discarded, and only it does.
  expectOutcome(receipt: WriteReceipt, outcome: WriteReceipt["outcome"], what: string): void {
    const expected = this.retains ? outcome : "discarded";
    check(
      receipt.outcome === expected,
      `${what}: expected outcome ${expected}, got ${receipt.outcome}`,
    );
  }
}

type Probe = readonly [MemoryOperation, MemorySchemaName, () => MemoryResult<unknown>];

// One valid call of every operation that can fail.
function probes(ctx: CaseContext): readonly Probe[] {
  const ref = ctx.ref("fake-ref-1");
  const probeScope = { ...SCOPE_A, sessionId: sessionId(9) };
  return [
    ["open", "session", () => ctx.provider.open(SCOPE_A)],
    ["store", "write-receipt", () => ctx.provider.store(ctx.write({ content: "zqxprobe one" }))],
    ["search", "hit-page", () => ctx.provider.search(ctx.query(SCOPE_A, "zqxprobe"))],
    ["get", "record", () => ctx.provider.get(ref, SCOPE_A)],
    ["recall", "recall-bundle", () => ctx.provider.recall(ctx.recall(SCOPE_A, 1000))],
    [
      "summarize",
      "write-receipt",
      () => ctx.provider.summarize(ctx.summary(probeScope, "zqxprobe summary")),
    ],
    [
      "consolidate",
      "consolidation-outcome",
      () => ctx.provider.consolidate(ctx.consolidation(SCOPE_A, [ref, ctx.ref("fake-ref-2")])),
    ],
    ["forget", "forget-receipt", () => ctx.provider.forget(ctx.forget(ref, "soft"))],
    ["export", "export-artifact", () => ctx.provider.export(SCOPE_A, ctx.exportFormat())],
    ["import", "import-report", () => ctx.provider.import(ctx.artifact())],
  ];
}

const PIECES = ["a", "é", "€", "😀"];

// Deterministic content of exactly `bytes` UTF-8 bytes: one long line of one- to four-byte characters.
function sizedContent(bytes: number, seed: number): string {
  let out = "";
  let used = 0;
  for (let i = seed; used < bytes; i++) {
    let piece = PIECES[i % PIECES.length] ?? "a";
    if (used + utf8Length(piece) > bytes) piece = "a";
    out += piece;
    used += utf8Length(piece);
  }
  return out;
}

const CASES: readonly ContractCase[] = [
  {
    id: "MP-01",
    title: "capabilities validate, stay stable and are all false without a provider version",
    async run(ctx) {
      const caps = validated("capabilities()", "capabilities", ctx.provider.capabilities());
      same(ctx.provider.capabilities(), caps, "a second capabilities()");
      check(caps.visibilities.includes("project"), "every provider supports project visibility");
      if (caps.providerVersion === null) {
        const optional = [
          caps.supportsOperationId,
          caps.topicKeyUpsert,
          caps.versionHistory,
          caps.planConfirmConsolidation,
          caps.conflictJudgment,
          caps.hardDelete,
          caps.ttl,
          caps.semanticSearch,
          caps.pagination,
        ];
        check(
          optional.every((value) => !value),
          "with providerVersion null every optional capability must be false",
        );
      }
    },
  },
  {
    id: "MP-02",
    title: "an operation without a valid ScopeRef is contract.invalid and derives nothing",
    async run(ctx) {
      const { sessionId: _sessionId, ...withoutSession } = SCOPE_A;
      const invalidScopes: readonly (readonly [string, unknown])[] = [
        ["no scope", undefined],
        ["no sessionId", withoutSession],
        ["an empty projectKey", { ...SCOPE_A, projectKey: "" }],
        ["a foreign visibility", { ...SCOPE_A, visibility: "team" }],
      ];
      const ref = ctx.ref("fake-ref-1");
      for (const [label, invalid] of invalidScopes) {
        const scope = invalid as ScopeRef;
        const writeScope = (
          invalid === undefined ? undefined : { ...(invalid as object), kind: "discovery" }
        ) as MemoryWriteScope;
        const calls: readonly (readonly [string, () => MemoryResult<unknown>])[] = [
          ["open", () => ctx.provider.open(scope)],
          ["store", () => ctx.provider.store({ ...ctx.write(), scope: writeScope })],
          ["search", () => ctx.provider.search({ ...ctx.query(SCOPE_A, "zqxscope"), scope })],
          ["get", () => ctx.provider.get(ref, scope)],
          ["recall", () => ctx.provider.recall({ ...ctx.recall(SCOPE_A, 100), scope })],
          [
            "summarize",
            () => ctx.provider.summarize({ ...ctx.summary(SCOPE_A, "zqxscope summary"), scope }),
          ],
          [
            "forget",
            () => ctx.provider.forget({ ...ctx.forget(ref, "soft"), expectedScope: scope }),
          ],
          [
            "consolidate",
            () =>
              ctx.provider.consolidate({
                ...ctx.consolidation(SCOPE_A, [ref, ctx.ref("fake-ref-2")]),
                scope,
              }),
          ],
          ["export", () => ctx.provider.export(scope, ctx.exportFormat())],
        ];
        for (const [operation, call] of calls) {
          await expectFailure(`${operation} with ${label}`, "contract.invalid", call);
        }
      }
      await expectFailure("store without a kind in its scope", "contract.invalid", () =>
        ctx.provider.store({ ...ctx.write(), scope: SCOPE_A as MemoryWriteScope }),
      );
    },
  },
  {
    id: "MP-03",
    title: "the same operationId and content returns the first receipt and writes nothing more",
    async run(ctx) {
      // MEM-04 rests on the capability; a provider without it has nothing to assert here.
      if (!ctx.caps.supportsOperationId) return;
      const write = ctx.write({ title: "idempotent write", content: "zqxidem first content" });
      const first = await ctx.storeOk(write, "the first store");
      ctx.expectOutcome(first, "created", "the first store");
      const before = await ctx.searchRefs(SCOPE_A, "zqxidem");
      check(before.length === (ctx.retains ? 1 : 0), `expected one record, found ${before.length}`);
      same(await ctx.storeOk(write, "the repeated store"), first, "the repeated receipt");
      same(await ctx.searchRefs(SCOPE_A, "zqxidem"), before, "the search after the repeat");
    },
  },
  {
    id: "MP-04",
    title:
      "a reused operationId with other content, or a hash of other content, is contract.invalid",
    async run(ctx) {
      if (!ctx.caps.supportsOperationId) return;
      const write = ctx.write({ content: "zqxconflict original" });
      const first = await ctx.storeOk(write);
      const other = "zqxrewrite other content";
      await expectFailure("the same operationId with other content", "contract.invalid", () =>
        ctx.provider.store({ ...write, content: other, contentSha256: ctx.sha(other) }),
      );
      same(await ctx.searchRefs(SCOPE_A, "zqxrewrite"), [], "the search for the refused content");
      if (ctx.retains) {
        same(await ctx.storedContent(first), "zqxconflict original", "the first content");
      }
      const lying = ctx.write({ content: "zqxlying content" });
      await expectFailure("a contentSha256 that is not the content's", "contract.invalid", () =>
        ctx.provider.store({ ...lying, contentSha256: ctx.sha("other text") }),
      );
      same(await ctx.searchRefs(SCOPE_A, "zqxlying"), [], "the search for the refused write");
    },
  },
  {
    id: "MP-05",
    title:
      "a duplicate within dedupeWindowMs is declared deduped; without a window it is a new record",
    async run(ctx) {
      const fields = {
        title: "zqxdup title",
        content: "zqxdup same content",
        kind: "pattern",
      } as const;
      const first = await ctx.storeOk(ctx.write(fields), "the first store");
      const second = await ctx.storeOk(ctx.write(fields), "the duplicate store");
      const refs = await ctx.searchRefs(SCOPE_A, "zqxdup");
      ctx.expectOutcome(first, "created", "the first store");
      if (!ctx.retains) {
        ctx.expectOutcome(second, "created", "the duplicate store");
        return;
      }
      if ((ctx.caps.dedupeWindowMs ?? 0) > 0) {
        ctx.expectOutcome(second, "deduped", "a duplicate within the dedupe window");
        check(refs.length === 1, `a deduped write must leave one record, found ${refs.length}`);
      } else {
        ctx.expectOutcome(second, "created", "a duplicate without a dedupe window");
        check(refs.length === 2, `two writes without dedupe are two records, found ${refs.length}`);
      }
    },
  },
  {
    id: "MP-06",
    title:
      "the same project, kind and topicKey updates the record; without topicKeyUpsert it is Unsupported",
    async run(ctx) {
      const topicKey = "convention/zqxnaming";
      const fields = { kind: "convention", title: "naming", topicKey } as const;
      const v1 = ctx.write({ ...fields, content: "zqxtopicone names" });
      if (!ctx.caps.topicKeyUpsert) {
        await expectFailure("a topicKey without topicKeyUpsert", "Unsupported", () =>
          ctx.provider.store(v1),
        );
        same(await ctx.searchRefs(SCOPE_A, "zqxtopicone"), [], "the search after the refusal");
        return;
      }
      const first = await ctx.storeOk(v1, "the first topic write");
      const second = await ctx.storeOk(
        ctx.write({ ...fields, content: "zqxtopictwo names" }),
        "the second topic write",
      );
      ctx.expectOutcome(first, "created", "the first topic write");
      ctx.expectOutcome(second, "updated", "the second topic write");
      if (!ctx.retains) return;
      check(second.providerRef === first.providerRef, "an update names the record it replaced");
      same(await ctx.storedContent(second), "zqxtopictwo names", "the updated content");
      same(await ctx.searchRefs(SCOPE_A, "zqxtopicone"), [], "the search for the old content");
      same(await ctx.searchRefs(SCOPE_A, "zqxtopictwo"), [second.providerRef], "the new content");
      const other = await ctx.storeOk(
        ctx.write({ ...fields, scope: SCOPE_B, content: "zqxtopicthree names" }),
      );
      ctx.expectOutcome(other, "created", "the same topicKey in another project");
      if (ctx.caps.versionHistory) {
        const record = await expectOk("get with history", "record", () =>
          ctx.provider.get(ctx.refOf(second), SCOPE_A, { history: true }),
        );
        check(
          record.history?.some((revision) => revision.content === "zqxtopicone names") === true,
          "the history must keep the replaced content",
        );
      } else {
        await expectFailure("get with history without versionHistory", "Unsupported", () =>
          ctx.provider.get(ctx.refOf(second), SCOPE_A, { history: true }),
        );
      }
    },
  },
  {
    id: "MP-07",
    title: "content over maxContentBytes is truncated to valid UTF-8 and the receipt declares it",
    async run(ctx) {
      const limit = ctx.caps.maxContentBytes;
      if (limit === null) {
        const content = `zqxbig ${"€".repeat(20000)}`;
        const receipt = await ctx.storeOk(ctx.write({ content }));
        check(!receipt.truncated, "a provider without maxContentBytes must not truncate");
        if (ctx.retains) same(await ctx.storedContent(receipt), content, "the stored content");
        return;
      }
      const emojis = Math.floor(limit / 4);
      const content = "a".repeat(limit + 1 - emojis * 4) + "😀".repeat(emojis);
      check(utf8Length(content) === limit + 1, "the fixture must be one byte over the limit");
      const receipt = await ctx.storeOk(ctx.write({ content }));
      check(receipt.truncated, "content over maxContentBytes must be declared truncated");
      check(
        receipt.originalBytes === limit + 1 && receipt.limitBytes === limit,
        `expected originalBytes ${limit + 1} and limitBytes ${limit}, got ${receipt.originalBytes} and ${receipt.limitBytes}`,
      );
      if (!ctx.retains) return;
      const stored = await ctx.storedContent(receipt);
      check(stored.length > 0 && content.startsWith(stored), "the stored text is a prefix");
      check(utf8Length(stored) <= limit, `the stored text has ${utf8Length(stored)} bytes`);
      check(!LONE_SURROGATE.test(stored), "the stored text must be valid UTF-8");
    },
  },
  {
    id: "MP-08",
    title: "a provider that redacts declares it; one that does not keeps the text whole",
    async run(ctx) {
      const content = "zqxkeep <private>fake-hidden-value</private> tail";
      const receipt = await ctx.storeOk(ctx.write({ content }));
      if (!ctx.retains) return;
      const stored = await ctx.storedContent(receipt);
      if (receipt.redacted) {
        check(!stored.includes("fake-hidden-value"), "a redacted write must not keep the secret");
      } else {
        same(stored, content, "a write the provider did not redact");
      }
    },
  },
  {
    id: "MP-09",
    title:
      "nothing written under project A is visible under B, or under A of another workspace, through search, recall or get",
    async run(ctx) {
      const title = "zqxshared title";
      const a = await ctx.storeOk(ctx.write({ scope: SCOPE_A, title, content: "zqxshared alpha" }));
      const b = await ctx.storeOk(ctx.write({ scope: SCOPE_B, title, content: "zqxshared beta" }));
      const elsewhere = await ctx.storeOk(
        ctx.write({ scope: SCOPE_A_ELSEWHERE, title, content: "zqxshared gamma" }),
      );
      const hits = await ctx.searchRefs(SCOPE_A, "zqxshared");
      const bundle = await ctx.recallOk(ctx.recall(SCOPE_A, 100000));
      if (!ctx.retains) {
        check(hits.length === 0 && bundle.items.length === 0, "a discarding provider reads empty");
        await expectFailure("get of a discarded write", "NotFound", () =>
          ctx.provider.get(ctx.ref("fake-ref-1"), SCOPE_A),
        );
        return;
      }
      same(hits, [a.providerRef], "the search under A");
      same(
        bundle.items.map((item) => item.ref.providerRef),
        [a.providerRef],
        "the recall under A",
      );
      same(await ctx.storedContent(a, SCOPE_A), "zqxshared alpha", "A's record under A");
      await expectFailure("get of B's record under A", "ScopeMismatch", () =>
        ctx.provider.get(ctx.refOf(b), SCOPE_A),
      );
      await expectFailure("get of another workspace's record under A", "ScopeMismatch", () =>
        ctx.provider.get(ctx.refOf(elsewhere), SCOPE_A),
      );
      same(await ctx.searchRefs(SCOPE_B, "zqxshared"), [b.providerRef], "the search under B");
      same(
        await ctx.searchRefs(SCOPE_A_ELSEWHERE, "zqxshared"),
        [elsewhere.providerRef],
        "the search under A of another workspace",
      );
    },
  },
  {
    id: "MP-10",
    title: "open is idempotent and summarize ends the session; a session belongs to one project",
    async run(ctx) {
      const first = await expectOk("open", "session", () => ctx.provider.open(SCOPE_A));
      check(first.ref.sessionId === SCOPE_A.sessionId, "the session is HARIL's session");
      same(
        await expectOk("open again", "session", () => ctx.provider.open(SCOPE_A)),
        first,
        "a second open of an open session",
      );
      await ctx.storeOk(ctx.write({ content: "zqxbefore end" }));
      await ctx.summarizeOk(ctx.summary(SCOPE_A, "fake run summary"));
      if (!ctx.caps.sessionTracking) {
        await ctx.storeOk(ctx.write({ content: "zqxafter end" }), "a store after summarize");
        await expectOk("open after summarize", "session", () => ctx.provider.open(SCOPE_A));
        return;
      }
      await expectFailure("store in an ended session", "SessionEnded", () =>
        ctx.provider.store(ctx.write({ content: "zqxafter end" })),
      );
      await expectFailure("open of an ended session", "SessionEnded", () =>
        ctx.provider.open(SCOPE_A),
      );
      same(await ctx.searchRefs(SCOPE_A, "zqxafter"), [], "the search for the refused write");
      const sessionC = { ...SCOPE_A, sessionId: sessionId(3) };
      await expectOk("open of a new session in A", "session", () => ctx.provider.open(sessionC));
      const crossed = { ...SCOPE_B, sessionId: sessionC.sessionId };
      await expectFailure("open of A's session under B", "ScopeMismatch", () =>
        ctx.provider.open(crossed),
      );
      await expectFailure("store in A's session under B", "ScopeMismatch", () =>
        ctx.provider.store(ctx.write({ scope: crossed })),
      );
    },
  },
  {
    id: "MP-11",
    title:
      "summarize is idempotent by operationId; another summary of an ended session is SessionEnded",
    async run(ctx) {
      const summary = ctx.summary(SCOPE_A, "fake summary one");
      const first = await ctx.summarizeOk(summary, "the first summarize");
      ctx.expectOutcome(first, "created", "the first summarize");
      same(await ctx.summarizeOk(summary, "the repeated summarize"), first, "the repeated receipt");
      const two = "fake summary two";
      await expectFailure("the same operationId with another text", "contract.invalid", () =>
        ctx.provider.summarize({ ...summary, text: two, textSha256: ctx.sha(two) }),
      );
      await expectFailure("a textSha256 that is not the text's", "contract.invalid", () =>
        ctx.provider.summarize({ ...ctx.summary(SCOPE_A, two), textSha256: ctx.sha("other") }),
      );
      if (!ctx.caps.sessionTracking) {
        await ctx.summarizeOk(ctx.summary(SCOPE_A, two), "another summary");
        return;
      }
      await expectFailure("another summary of an ended session", "SessionEnded", () =>
        ctx.provider.summarize(ctx.summary(SCOPE_A, two)),
      );
      const again = await ctx.summarizeOk(
        ctx.summary(SCOPE_A, "fake summary one"),
        "the same text",
      );
      ctx.expectOutcome(again, "deduped", "the stored summary sent again under a new operationId");
    },
  },
  {
    id: "MP-12",
    title:
      "recall stays within its budget with whole items, counts what it omits and is deterministic",
    async run(ctx) {
      const contents = new Map<string, string>();
      const total = 50;
      for (let i = 0; i < total; i++) {
        const content = sizedContent(1 + Math.floor((i * 4999) / (total - 1)), i);
        const receipt = await ctx.storeOk(ctx.write({ title: `zqxrecall ${i}`, content }));
        if (ctx.retains) contents.set(ctx.refOf(receipt).providerRef, content);
      }
      const budgets = [0, 1, 7, 64, 333, 1000, 5000, 12345, 40000, 200000];
      for (const budget of budgets) {
        const request = ctx.recall(SCOPE_A, budget, total);
        const bundle = await ctx.recallOk(request, `recall within ${budget}`);
        const what = `recall within ${budget}`;
        check(bundle.budgetTokens === budget, `${what}: the bundle names another budget`);
        check(bundle.usedTokens <= budget, `${what}: used ${bundle.usedTokens} tokens`);
        const sum = bundle.items.reduce((tokens, item) => tokens + item.tokens, 0);
        check(
          sum <= bundle.usedTokens,
          `${what}: the items cost ${sum} > used ${bundle.usedTokens}`,
        );
        for (const item of bundle.items) {
          check(item.trust === "untrusted", `${what}: a recalled item must be untrusted`);
          check(
            item.tokens >= ctx.deps.estimateTokens(item.content),
            `${what}: an item's tokens must bound its content`,
          );
          if (ctx.retains) {
            same(item.content, contents.get(item.ref.providerRef), `${what}: a recalled item`);
          }
        }
        const candidates = ctx.retains ? total : 0;
        check(
          bundle.omittedCount === candidates - bundle.items.length,
          `${what}: omittedCount ${bundle.omittedCount} for ${bundle.items.length} of ${candidates}`,
        );
        same(await ctx.recallOk(request), bundle, `${what}: a second recall`);
        if (ctx.retains && budget === budgets[budgets.length - 1]) {
          check(bundle.items.length > 0, `${what}: a large budget recalls something`);
        }
      }
      const maxItems = 5;
      const limited = await ctx.recallOk(ctx.recall(SCOPE_A, 200000, maxItems), "a short recall");
      check(
        limited.items.length <= maxItems,
        `recall returned ${limited.items.length} items for maxItems ${maxItems}`,
      );
      check(
        limited.omittedCount === (ctx.retains ? total : 0) - limited.items.length,
        `a short recall: omittedCount ${limited.omittedCount} for ${limited.items.length} items`,
      );
      if (ctx.retains) check(limited.items.length > 0, "a short recall recalls something");
    },
  },
  {
    id: "MP-13",
    title: "every recalled item is untrusted, whatever its origin",
    async run(ctx) {
      for (const origin of ["haril", "agent", "import"] as const) {
        await ctx.storeOk(ctx.write({ title: `zqxorigin ${origin}`, content: origin, origin }));
      }
      const bundle = await ctx.recallOk(ctx.recall(SCOPE_A, 100000));
      check(bundle.items.length === (ctx.retains ? 3 : 0), "the recall returns every memory");
      check(
        bundle.items.every((item) => item.trust === "untrusted"),
        "a recalled item is untrusted",
      );
    },
  },
  {
    id: "MP-14",
    title: "soft forget hides a record, checks its project and repeats as already_forgotten",
    async run(ctx) {
      const missing = ctx.ref("fake-missing-ref");
      if (!ctx.retains) {
        await expectFailure("forget of a record that does not exist", "NotFound", () =>
          ctx.provider.forget(ctx.forget(missing, "soft")),
        );
        if (!ctx.caps.hardDelete) {
          await expectFailure("hard forget without hardDelete", "Unsupported", () =>
            ctx.provider.forget(ctx.forget(missing, "hard")),
          );
        }
        return;
      }
      const kept = await ctx.storeOk(ctx.write({ title: "zqxforget", content: "zqxforget it" }));
      const ref = ctx.refOf(kept);
      await expectFailure("forget with another project's expectedScope", "ScopeMismatch", () =>
        ctx.provider.forget({ ...ctx.forget(ref, "soft"), expectedScope: SCOPE_B }),
      );
      same(await ctx.searchRefs(SCOPE_A, "zqxforget"), [ref.providerRef], "the record lives on");
      if (ctx.caps.hardDelete) {
        await expectFailure(
          "hard forget with another project's expectedScope",
          "ScopeMismatch",
          () => ctx.provider.forget({ ...ctx.forget(ref, "hard"), expectedScope: SCOPE_B }),
        );
        same(
          await ctx.searchRefs(SCOPE_A, "zqxforget"),
          [ref.providerRef],
          "the record after a refused hard forget",
        );
        same(
          await ctx.storedContent(kept),
          "zqxforget it",
          "the record after a refused hard forget",
        );
      }
      const request = ctx.forget(ref, "soft");
      const receipt = await expectOk("soft forget", "forget-receipt", () =>
        ctx.provider.forget(request),
      );
      check(
        receipt.outcome === "forgotten" && receipt.erasure === "hidden",
        `a soft forget hides, got ${receipt.outcome}/${receipt.erasure}`,
      );
      same(await ctx.searchRefs(SCOPE_A, "zqxforget"), [], "the search after a soft forget");
      const bundle = await ctx.recallOk(ctx.recall(SCOPE_A, 100000));
      check(
        bundle.items.every((item) => item.ref.providerRef !== ref.providerRef),
        "recall must not return a forgotten record",
      );
      same(
        await expectOk("the same forget again", "forget-receipt", () =>
          ctx.provider.forget(request),
        ),
        receipt,
        "the repeated forget receipt",
      );
      await expectFailure(
        "the same forget operationId with another expectedScope",
        "contract.invalid",
        () => ctx.provider.forget({ ...request, expectedScope: SCOPE_B }),
      );
      const repeat = await expectOk("a new forget of the same record", "forget-receipt", () =>
        ctx.provider.forget(ctx.forget(ref, "soft")),
      );
      check(
        repeat.outcome === "already_forgotten",
        `expected already_forgotten, got ${repeat.outcome}`,
      );
      await expectFailure("forget of a record that does not exist", "NotFound", () =>
        ctx.provider.forget(ctx.forget(missing, "soft")),
      );
      const doomed = await ctx.storeOk(ctx.write({ title: "zqxdoomed", content: "zqxdoomed it" }));
      const hard = ctx.forget(ctx.refOf(doomed), "hard");
      if (!ctx.caps.hardDelete) {
        await expectFailure("hard forget without hardDelete", "Unsupported", () =>
          ctx.provider.forget(hard),
        );
        same(await ctx.searchRefs(SCOPE_A, "zqxdoomed"), [doomed.providerRef], "the record lives");
        return;
      }
      const erased = await expectOk("hard forget", "forget-receipt", () =>
        ctx.provider.forget(hard),
      );
      check(
        erased.outcome === "forgotten" && erased.erasure !== "hidden",
        `a hard forget deletes, got ${erased.outcome}/${erased.erasure}`,
      );
      await expectFailure("get after a hard forget", "NotFound", () =>
        ctx.provider.get(ctx.refOf(doomed), SCOPE_A),
      );
      same(await ctx.searchRefs(SCOPE_A, "zqxdoomed"), [], "the search after a hard forget");
    },
  },
  {
    id: "MP-15",
    title:
      "export and import keep the counts; an unsupported version is Unsupported before any change",
    async run(ctx) {
      const format = ctx.exportFormat();
      const written = 3;
      for (let i = 0; i < written; i++) {
        await ctx.storeOk(
          ctx.write({ title: `zqxexport ${i}`, content: `zqxexport content ${i}` }),
        );
      }
      // What a reader can observe of the provider: its search and its recall.
      const observed = async () => ({
        hits: (await ctx.searchRefs(SCOPE_A, "zqxexport")).sort(),
        recall: await ctx.recallOk(ctx.recall(SCOPE_A, 1_000_000)),
      });
      const before = await observed();
      if (ctx.caps.exportVersion === null) {
        await expectFailure("export without exportVersion", "Unsupported", () =>
          ctx.provider.export(SCOPE_A, format),
        );
      }
      if (!ctx.caps.importVersions.includes(format.version)) {
        await expectFailure("import of a version the provider does not read", "Unsupported", () =>
          ctx.provider.import(ctx.artifact()),
        );
        same(await observed(), before, "the provider after a refused import");
      }
      if (ctx.caps.exportVersion === null || !ctx.retains) return;
      const artifact = await expectOk("export", "export-artifact", () =>
        ctx.provider.export(SCOPE_A, format),
      );
      check(artifact.recordCount === null || artifact.recordCount === written, "the export count");
      const target = await ctx.make();
      try {
        const unsupported = { ...artifact, format: { ...artifact.format, version: "0.0.0-fake" } };
        await expectFailure("import of an unsupported version", "Unsupported", () =>
          target.provider.import(unsupported),
        );
        const report = await expectOk("import", "import-report", () =>
          target.provider.import(artifact),
        );
        check(
          report.imported + report.updated + report.unchanged === written && report.rejected === 0,
          `the import must account for ${written} records`,
        );
      } finally {
        await target.teardown?.();
      }
    },
  },
  {
    id: "MP-16",
    title: "consolidate without planConfirmConsolidation is Unsupported and changes nothing",
    async run(ctx) {
      const one = await ctx.storeOk(ctx.write({ title: "zqxmerge one", content: "zqxmerge 1" }));
      const two = await ctx.storeOk(ctx.write({ title: "zqxmerge two", content: "zqxmerge 2" }));
      const sources = ctx.retains
        ? [ctx.refOf(one), ctx.refOf(two)]
        : [ctx.ref("fake-ref-1"), ctx.ref("fake-ref-2")];
      const before = await ctx.searchRefs(SCOPE_A, "zqxmerge");
      if (!ctx.caps.planConfirmConsolidation) {
        for (const apply of [false, true]) {
          await expectFailure(`consolidate (apply ${apply})`, "Unsupported", () =>
            ctx.provider.consolidate(ctx.consolidation(SCOPE_A, sources, apply)),
          );
        }
      } else {
        const outcome = await expectOk("a consolidation plan", "consolidation-outcome", () =>
          ctx.provider.consolidate(ctx.consolidation(SCOPE_A, sources, false)),
        );
        check(outcome.mode === "plan", "a plan request answers a plan");
      }
      same(await ctx.searchRefs(SCOPE_A, "zqxmerge"), before, "the search after consolidate");
    },
  },
  {
    id: "MP-17",
    title: "health validates and never throws; a failing read with a working ping is degraded",
    async run(ctx) {
      const health = await ctx.healthOk("health");
      check(health.provider === ctx.caps.provider, "health names its provider");
      check(health.state === "active", `a working provider is active, got ${health.state}`);
      const faults = ctx.subject.faults;
      if (faults === undefined) return;
      faults.makeUnavailable("search");
      const degraded = await ctx.healthOk("health while reads fail");
      check(
        degraded.state === "degraded" && degraded.realReadOk === false,
        `failing reads are degraded with realReadOk false, got ${degraded.state}/${degraded.realReadOk}`,
      );
      faults.restore();
      const back = await ctx.healthOk("health after restore");
      check(back.state === "active", `a restored provider is active, got ${back.state}`);
    },
  },
  {
    id: "MP-18",
    title:
      "an unreachable provider answers Unavailable everywhere; a retry with the operationId writes once",
    async run(ctx) {
      const faults = ctx.subject.faults;
      // Null and InMemory cannot fail by themselves (memory.md 9.3).
      if (faults === undefined) return;
      faults.makeUnavailable();
      for (const [operation, , call] of probes(ctx)) {
        await expectFailure(`${operation} while unavailable`, "Unavailable", call);
      }
      check((await ctx.healthOk("health while unavailable")).state !== "active", "not active");
      faults.restore();
      const refused = ctx.write({ content: "zqxrefused content" });
      faults.makeUnavailable("store");
      await expectFailure("store while store is unavailable", "Unavailable", () =>
        ctx.provider.store(refused),
      );
      faults.restore();
      ctx.expectOutcome(await ctx.storeOk(refused, "the retried store"), "created", "the retry");
      const lost = ctx.write({ content: "zqxlost content" });
      faults.ambiguousNext("store");
      await expectFailure("a store whose answer is lost", "Unavailable", () =>
        ctx.provider.store(lost),
      );
      ctx.expectOutcome(await ctx.storeOk(lost, "the retried lost store"), "created", "the retry");
      const expected = ctx.retains ? 1 : 0;
      for (const word of ["zqxrefused", "zqxlost"]) {
        const found = (await ctx.searchRefs(SCOPE_A, word)).length;
        check(found === expected, `"${word}" must be written once, found ${found}`);
      }
    },
  },
  {
    id: "MP-19",
    title: "a cancelled write answers Unavailable with details.cancelled and its retry writes once",
    async run(ctx) {
      const write = ctx.write({ content: "zqxcancel content" });
      const failure = await expectFailure("a cancelled store", "Unavailable", () =>
        ctx.provider.store(write, { signal: cancelSignal(true) }),
      );
      check(failure.details?.cancelled === true, "a cancelled write says details.cancelled");
      const receipt = await ctx.storeOk(write, "the store retried without a signal");
      ctx.expectOutcome(receipt, "created", "the retried store");
      const found = (await ctx.searchRefs(SCOPE_A, "zqxcancel")).length;
      check(found === (ctx.retains ? 1 : 0), `the write must exist once, found ${found}`);
    },
  },
  {
    id: "MP-21",
    title: "every result validates against its schema and every failure is typed",
    async run(ctx) {
      validated("capabilities()", "capabilities", ctx.provider.capabilities());
      await ctx.healthOk("health");
      for (const [operation, schema, call] of probes(ctx)) {
        const result = await settle(operation, call);
        if (result.ok) validated(operation, schema, result.value);
        else checkFailureShape(operation, result.error);
      }
    },
  },
  {
    id: "MP-22",
    title: "a visibility the provider does not support is Unsupported; project needs no opt-in",
    async run(ctx) {
      const kept = ctx.retains
        ? ctx.refOf(await ctx.storeOk(ctx.write({ content: "zqxvisible kept" })))
        : ctx.ref("fake-ref-1");
      for (const visibility of ["personal", "global"] as const) {
        const scope = { ...SCOPE_A, visibility };
        if (ctx.caps.visibilities.includes(visibility)) {
          await expectOk(`search with ${visibility}`, "hit-page", () =>
            ctx.provider.search(ctx.query(scope, "zqxvisible")),
          );
          continue;
        }
        const calls: readonly (readonly [string, () => MemoryResult<unknown>])[] = [
          ["open", () => ctx.provider.open(scope)],
          ["store", () => ctx.provider.store(ctx.write({ scope }))],
          ["search", () => ctx.provider.search(ctx.query(scope, "zqxvisible"))],
          ["get", () => ctx.provider.get(kept, scope)],
          ["recall", () => ctx.provider.recall(ctx.recall(scope, 100))],
        ];
        for (const [operation, call] of calls) {
          await expectFailure(`${operation} with ${visibility}`, "Unsupported", call);
        }
      }
      await expectOk("open with project visibility", "session", () => ctx.provider.open(SCOPE_A));
    },
  },
  {
    // Not a row of memory.md 8.1: the preconditions of search and recall in 4.2, and what limit, kinds and matchMode do.
    id: "MP-X1",
    title:
      "a search or recall outside its bounds is contract.invalid; limit, kinds and matchMode narrow a search",
    async run(ctx) {
      const query = ctx.query(SCOPE_A, "zqxbounds");
      const recall = ctx.recall(SCOPE_A, 100);
      const calls: readonly (readonly [string, () => MemoryResult<unknown>])[] = [
        [
          "a limit over maxSearchResults",
          () => ctx.provider.search({ ...query, limit: ctx.caps.maxSearchResults + 1 }),
        ],
        ["a limit of 0", () => ctx.provider.search({ ...query, limit: 0 })],
        ["an empty text", () => ctx.provider.search({ ...query, text: "" })],
        ["maxItems 0", () => ctx.provider.recall({ ...recall, maxItems: 0 })],
        ["a negative budget", () => ctx.provider.recall({ ...recall, budgetTokens: -1 })],
      ];
      for (const [label, call] of calls) {
        await expectFailure(`a call with ${label}`, "contract.invalid", call);
      }
      const first = await ctx.storeOk(
        ctx.write({ kind: "decision", title: "zqxfilter one", content: "zqxfilt zqxfirst" }),
      );
      const second = await ctx.storeOk(
        ctx.write({ kind: "pattern", title: "zqxfilter two", content: "zqxfilt zqxsecond" }),
      );
      const third = await ctx.storeOk(
        ctx.write({ kind: "pattern", title: "zqxfilter three", content: "zqxfilt zqxthird" }),
      );
      const limit = Math.min(2, ctx.caps.maxSearchResults);
      const limited = await ctx.searchRefs(SCOPE_A, "zqxfilt", { limit });
      check(
        limited.length === (ctx.retains ? limit : 0),
        `a search with limit ${limit} returned ${limited.length} of ${ctx.retains ? 3 : 0} matches`,
      );
      same(
        (await ctx.searchRefs(SCOPE_A, "zqxfilt", { kinds: ["decision"] })).sort(),
        ctx.refsOf([first]),
        "a search narrowed to decisions",
      );
      same(
        (await ctx.searchRefs(SCOPE_A, "zqxfilt", { kinds: ["pattern"] })).sort(),
        ctx.refsOf([second, third]),
        "a search narrowed to patterns",
      );
      same(
        await ctx.searchRefs(SCOPE_A, "zqxfirst zqxsecond"),
        [],
        "a search for every term of two records",
      );
      same(
        (await ctx.searchRefs(SCOPE_A, "zqxfirst zqxsecond", { matchMode: "any" })).sort(),
        ctx.refsOf([first, second]),
        "a search for any term",
      );
    },
  },
];

async function runCase(
  contractCase: ContractCase,
  make: MemoryProviderFactory,
  options: MemoryProviderContractOptions,
): Promise<void> {
  const subject = await make();
  try {
    await contractCase.run(new CaseContext(subject, options, make));
  } finally {
    await subject.teardown?.();
  }
}

// Registers one test per case, each on a fresh subject from `make`.
export function describeMemoryProviderContract(
  test: ContractTestApi,
  name: string,
  make: MemoryProviderFactory,
  options: MemoryProviderContractOptions,
): void {
  test.describe(`MemoryProvider contract: ${name}`, () => {
    for (const contractCase of CASES) {
      test.it(`${contractCase.id}: ${contractCase.title}`, () =>
        runCase(contractCase, make, options),
      );
    }
  });
}

// Runs one case by id; it rejects with a ContractViolation when the subject breaks the contract. A seeded deviation
// proves a case can fail (V18-5).
export async function runMemoryProviderContractCase(
  id: string,
  make: MemoryProviderFactory,
  options: MemoryProviderContractOptions,
): Promise<void> {
  const contractCase = CASES.find((candidate) => candidate.id === id);
  if (contractCase === undefined) throw new Error(`unknown memory contract case ${id}`);
  await runCase(contractCase, make, options);
}
