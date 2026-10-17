import type {
  MemoryQuery,
  MemoryWrite,
  RecallRequest,
  ScopeRef,
  SummarizeWrite,
} from "@haril/contracts";
import { describe, expect, it } from "vitest";
import { estimateTokens, InMemoryMemoryProvider, NullMemoryProvider } from "../src/memory/index.js";
import type { MemoryCallOptions, MemoryProviderDeps } from "../src/ports/index.js";
import {
  ContractViolation,
  cancelSignal,
  FakeMemoryProvider,
  fakeMemoryDeps,
  type MemoryProviderFactory,
  runMemoryProviderContractCase,
  Sha256Hasher,
} from "../testing/index.js";

// The semantics of the Core's own memory providers beyond the shared suite (memory.md 9.2, 9.3), the fault fake's
// controls, and the seeded deviations that prove the suite can fail (memory.md 8.3, V18-5).

const SCOPE_A: ScopeRef = {
  workspaceId: "fake-workspace",
  projectKey: "fake-project-a",
  visibility: "project",
  sessionId: "01HMEMSESSION0000000000001",
};
const SCOPE_B: ScopeRef = {
  ...SCOPE_A,
  projectKey: "fake-project-b",
  sessionId: "01HMEMSESSION0000000000002",
};

let operations = 0;
function operationId(): string {
  operations += 1;
  return `fake-test-op-${operations}`;
}

function write(
  deps: MemoryProviderDeps,
  fields: Partial<Pick<MemoryWrite, "title" | "content" | "topicKey">> & {
    readonly scope?: ScopeRef;
  } = {},
): MemoryWrite {
  const content = fields.content ?? "fake content";
  const base: MemoryWrite = {
    schemaVersion: 1,
    operationId: operationId(),
    scope: { ...(fields.scope ?? SCOPE_A), kind: "discovery" },
    title: fields.title ?? "fake title",
    content,
    contentSha256: deps.hasher.sha256(content),
    origin: "haril",
  };
  return fields.topicKey === undefined ? base : { ...base, topicKey: fields.topicKey };
}

function summary(deps: MemoryProviderDeps, provider: string, text: string): SummarizeWrite {
  return {
    schemaVersion: 1,
    operationId: operationId(),
    scope: SCOPE_A,
    session: { provider, sessionId: SCOPE_A.sessionId },
    text,
    textSha256: deps.hasher.sha256(text),
  };
}

function query(text: string, extra: Partial<MemoryQuery> = {}): MemoryQuery {
  return { schemaVersion: 1, scope: SCOPE_A, text, matchMode: "all", limit: 20, ...extra };
}

function recall(budgetTokens: number, extra: Partial<RecallRequest> = {}): RecallRequest {
  return {
    schemaVersion: 1,
    scope: SCOPE_A,
    budgetTokens,
    includePinned: true,
    maxItems: 10,
    ...extra,
  };
}

async function value<T>(
  promise: Promise<{ ok: true; value: T } | { ok: false; error: { code: string } }>,
): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

async function code(promise: Promise<{ ok: boolean; error?: { code: string } }>): Promise<string> {
  const result = await promise;
  return result.ok ? "ok" : (result.error?.code ?? "none");
}

describe("Sha256Hasher (pure SHA-256 for tests)", () => {
  const hasher = new Sha256Hasher();

  it("matches node:crypto on the empty text, ASCII and multibyte UTF-8", () => {
    expect(hasher.sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hasher.sha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hasher.sha256("Many minds. One flow. € é 😀")).toBe(
      "fc08f987118f647b78e84d9195d44787c9616ee3a9ce34611241613afbf944ba",
    );
  });

  it("encodes a lone surrogate as U+FFFD, as TextEncoder does", () => {
    expect(hasher.sha256("\uD800")).toBe(hasher.sha256("�"));
  });
});

describe("estimateTokens (CM-03 fallback)", () => {
  it("counts UTF-8 bytes, an upper bound of the tokens", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(3);
    expect(estimateTokens("é€😀")).toBe(9);
  });
});

describe("NullMemoryProvider (memory.md 9.2)", () => {
  function setup() {
    const deps = fakeMemoryDeps();
    return { deps, provider: new NullMemoryProvider(deps) };
  }

  it("declares that it keeps nothing", () => {
    const caps = setup().provider.capabilities();
    expect(caps).toMatchObject({
      provider: "null",
      persistent: false,
      sessionTracking: false,
      supportsOperationId: true,
      topicKeyUpsert: false,
      searchSyntax: "none",
      maxContentBytes: null,
      exportVersion: null,
      visibilities: ["project"],
    });
  });

  it("is always active, at the injected clock's time", async () => {
    const { deps, provider } = setup();
    deps.clock.advance(1234);
    expect(await provider.health()).toMatchObject({
      provider: "null",
      state: "active",
      checkedAt: 1234,
      lastError: null,
    });
  });

  it("accepts and discards writes, and reads come back empty and not degraded", async () => {
    const { deps, provider } = setup();
    const receipt = await value(provider.store(write(deps, { content: "zqxnull kept?" })));
    expect(receipt).toEqual({
      schemaVersion: 1,
      operationId: receipt.operationId,
      provider: "null",
      outcome: "discarded",
      truncated: false,
      redacted: false,
    });
    expect((await value(provider.summarize(summary(deps, "null", "fake summary")))).outcome).toBe(
      "discarded",
    );
    expect(await value(provider.search(query("zqxnull")))).toEqual({ items: [] });
    expect(await value(provider.recall(recall(1000)))).toEqual({
      schemaVersion: 1,
      scope: SCOPE_A,
      budgetTokens: 1000,
      usedTokens: 0,
      items: [],
      omittedCount: 0,
      degraded: false,
    });
  });

  it("answers NotFound for a record and Unsupported for what it cannot do", async () => {
    const { deps, provider } = setup();
    const ref = { provider: "null", providerRef: "fake-ref" };
    expect(await code(provider.get(ref, SCOPE_A))).toBe("NotFound");
    const forget = {
      schemaVersion: 1,
      operationId: operationId(),
      ref,
      expectedScope: SCOPE_A,
    } as const;
    expect(await code(provider.forget({ ...forget, mode: "soft" }))).toBe("NotFound");
    expect(await code(provider.forget({ ...forget, mode: "hard" }))).toBe("Unsupported");
    expect(await code(provider.store(write(deps, { topicKey: "convention/x" })))).toBe(
      "Unsupported",
    );
    const sources = [ref, { ...ref, providerRef: "fake-ref-2" }];
    const consolidation = {
      schemaVersion: 1,
      operationId: operationId(),
      scope: SCOPE_A,
      sources,
      apply: false,
    } as const;
    expect(await code(provider.consolidate(consolidation))).toBe("Unsupported");
    expect(await code(provider.export("all", { id: "engram-export", version: "0.2.0" }))).toBe(
      "Unsupported",
    );
  });
});

describe("InMemoryMemoryProvider (memory.md 9.2)", () => {
  function setup(options?: { dedupeWindowMs?: number }) {
    const deps = fakeMemoryDeps();
    return { deps, provider: new InMemoryMemoryProvider(deps, options) };
  }

  it("declares honest capabilities", () => {
    expect(setup().provider.capabilities()).toMatchObject({
      provider: "in-memory",
      persistent: false,
      sessionTracking: true,
      supportsOperationId: true,
      topicKeyUpsert: true,
      versionHistory: false,
      planConfirmConsolidation: false,
      hardDelete: true,
      ttl: false,
      semanticSearch: false,
      searchSyntax: "substring",
      maxContentBytes: 50000,
      dedupeWindowMs: 0,
      exportVersion: null,
      pagination: false,
    });
    expect(setup({ dedupeWindowMs: 60_000 }).provider.capabilities().dedupeWindowMs).toBe(60_000);
  });

  it("takes time from the injected clock and refs from the injected ids (MP-20)", async () => {
    const { deps, provider } = setup();
    deps.clock.advance(1000);
    const created = await value(provider.store(write(deps, { topicKey: "convention/clock" })));
    expect(created.providerRef).toBe("mem-1");
    deps.clock.advance(500);
    await value(provider.store(write(deps, { topicKey: "convention/clock", content: "v2" })));
    const ref = { provider: "in-memory", providerRef: "mem-1" };
    const record = await value(provider.get(ref, SCOPE_A));
    expect(record).toMatchObject({
      createdAt: 1000,
      updatedAt: 1500,
      revisionCount: 2,
      content: "v2",
    });
    expect((await provider.health()).checkedAt).toBe(1500);
  });

  it("recalls the most recent first and fills the budget with whole items", async () => {
    const { deps, provider } = setup();
    await value(provider.store(write(deps, { title: "old", content: "a".repeat(40) })));
    deps.clock.advance(10);
    await value(provider.store(write(deps, { title: "big", content: "b".repeat(200) })));
    deps.clock.advance(10);
    await value(provider.store(write(deps, { title: "new", content: "c".repeat(20) })));
    const bundle = await value(provider.recall(recall(100)));
    // "new" fits, "big" does not, "old" still fits after it.
    expect(bundle.items.map((item) => item.title)).toEqual(["new", "old"]);
    expect(bundle.usedTokens).toBe(
      estimateTokens(`new\n${"c".repeat(20)}`) + estimateTokens(`old\n${"a".repeat(40)}`),
    );
    expect(bundle.omittedCount).toBe(1);
  });

  it("searches case-insensitive substrings by all or any term, kind and limit", async () => {
    const { deps, provider } = setup();
    await value(provider.store(write(deps, { title: "Alpha Notes", content: "the zqxone fact" })));
    await value(provider.store(write(deps, { title: "beta", content: "the zqxtwo fact" })));
    expect((await value(provider.search(query("ALPHA zqxone")))).items).toHaveLength(1);
    expect((await value(provider.search(query("zqxone zqxtwo")))).items).toHaveLength(0);
    const any = await value(provider.search(query("zqxone zqxtwo alpha", { matchMode: "any" })));
    // The record that matches two terms comes first.
    expect(any.items.map((hit) => hit.title)).toEqual(["Alpha Notes", "beta"]);
    expect(any.items[0]?.score).toBe(2);
    expect((await value(provider.search(query("fact", { limit: 1 })))).items).toHaveLength(1);
    expect((await value(provider.search(query("fact", { kinds: ["decision"] })))).items).toEqual(
      [],
    );
    expect(await code(provider.search(query("   ")))).toBe("contract.invalid");
  });

  it("rejects a topicKey over 120 bytes and a ref of another provider", async () => {
    const { deps, provider } = setup();
    // 41 characters, 123 bytes.
    expect(await code(provider.store(write(deps, { topicKey: "€".repeat(41) })))).toBe(
      "contract.invalid",
    );
    const foreign = { provider: "engram", providerRef: "mem-1" };
    expect(await code(provider.get(foreign, SCOPE_A))).toBe("contract.invalid");
  });

  it("refuses a summary over maxContentBytes and keeps a summary as a run_summary record", async () => {
    const { deps, provider } = setup();
    expect(await code(provider.summarize(summary(deps, "in-memory", "x".repeat(50001))))).toBe(
      "contract.invalid",
    );
    const receipt = await value(
      provider.summarize(summary(deps, "in-memory", "zqxsummary of the run")),
    );
    const ref = { provider: "in-memory", providerRef: receipt.providerRef ?? "" };
    expect((await value(provider.get(ref, SCOPE_A))).kind).toBe("run_summary");
    expect((await value(provider.search(query("zqxsummary")))).items).toHaveLength(1);
  });

  it("refuses a summary for a session of another provider", async () => {
    const { deps, provider } = setup();
    expect(await code(provider.summarize(summary(deps, "engram", "fake summary")))).toBe(
      "contract.invalid",
    );
  });

  it("returns copies, so a caller cannot change what is stored", async () => {
    const { deps, provider } = setup();
    const receipt = await value(provider.store(write(deps, { content: "zqxcopy original" })));
    const ref = { provider: "in-memory", providerRef: receipt.providerRef ?? "" };
    const record = await value(provider.get(ref, SCOPE_A));
    (record as { content: string }).content = "changed";
    (record.scope as { projectKey: string }).projectKey = "fake-project-b";
    expect(await value(provider.get(ref, SCOPE_A))).toMatchObject({ content: "zqxcopy original" });
  });

  it("answers already_forgotten after a hard forget and a cancelled read as Unavailable", async () => {
    const { deps, provider } = setup();
    const receipt = await value(provider.store(write(deps)));
    const ref = { provider: "in-memory", providerRef: receipt.providerRef ?? "" };
    const forget = { schemaVersion: 1, ref, mode: "hard", expectedScope: SCOPE_A } as const;
    expect((await value(provider.forget({ ...forget, operationId: operationId() }))).erasure).toBe(
      "deleted",
    );
    const again = await value(provider.forget({ ...forget, operationId: operationId() }));
    expect(again).toMatchObject({ outcome: "already_forgotten", erasure: "deleted" });
    const options: MemoryCallOptions = { signal: cancelSignal(true) };
    const cancelled = await provider.search(query("fake"), options);
    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: "Unavailable", details: { cancelled: true } },
    });
  });
});

describe("FakeMemoryProvider (memory.md 9.3)", () => {
  function setup() {
    const deps = fakeMemoryDeps();
    return { deps, provider: new FakeMemoryProvider(deps) };
  }

  it("answers the injected failure once, then reaches InMemory again", async () => {
    const { deps, provider } = setup();
    provider.failNext("store", {
      code: "ScopeMismatch",
      category: "memory",
      retryable: false,
      message: "fake mismatch",
    });
    expect(await code(provider.store(write(deps)))).toBe("ScopeMismatch");
    expect(await code(provider.store(write(deps)))).toBe("ok");
  });

  it("makes one operation unavailable without touching the others", async () => {
    const { deps, provider } = setup();
    provider.makeUnavailable("recall");
    expect(await code(provider.store(write(deps)))).toBe("ok");
    const failed = await provider.recall(recall(100));
    expect(failed).toMatchObject({ ok: false, error: { code: "Unavailable", retryable: true } });
    expect((await provider.health()).state).toBe("degraded");
    provider.restore();
    expect(await code(provider.recall(recall(100)))).toBe("ok");
  });

  it("applies an ambiguous write and loses only its answer", async () => {
    const { deps, provider } = setup();
    provider.ambiguousNext("store");
    const lost = await provider.store(write(deps, { content: "zqxambiguous" }));
    expect(lost).toMatchObject({
      ok: false,
      error: { code: "Unavailable", details: { ambiguous: true } },
    });
    expect((await value(provider.search(query("zqxambiguous")))).items).toHaveLength(1);
  });

  it("ends a session from outside", async () => {
    const { deps, provider } = setup();
    provider.endSession(SCOPE_A.sessionId);
    expect(await code(provider.store(write(deps)))).toBe("SessionEnded");
    expect(await code(provider.open(SCOPE_A))).toBe("SessionEnded");
    expect(await code(provider.open(SCOPE_B))).toBe("ok");
  });

  it("records every call with its scope and operationId", async () => {
    const { deps, provider } = setup();
    const stored = write(deps);
    await provider.store(stored);
    await provider.search(query("fake"));
    await provider.export("all", { id: "engram-export", version: "0.2.0" });
    expect(provider.calls()).toEqual([
      { operation: "store", scope: stored.scope, operationId: stored.operationId },
      { operation: "search", scope: SCOPE_A },
      { operation: "export" },
    ]);
  });

  it("never throws, even for a call without arguments", async () => {
    const { provider } = setup();
    const store = provider.store as (value: unknown) => Promise<{ ok: boolean }>;
    await expect(store.call(provider, undefined)).resolves.toMatchObject({ ok: false });
  });
});

// Seeded deviations (memory.md 8.3, V18-5): each deviant breaks one rule and the matching case must fail on it, while
// the honest provider passes the same case.
class AcceptsMissingScope extends InMemoryMemoryProvider {
  override async search(request: MemoryQuery, options?: MemoryCallOptions) {
    if (request.scope === undefined) return { ok: true as const, value: { items: [] } };
    return super.search(request, options);
  }
}

class HidesDedupe extends InMemoryMemoryProvider {
  override async store(request: MemoryWrite, options?: MemoryCallOptions) {
    const result = await super.store(request, options);
    if (!result.ok || result.value.outcome !== "deduped") return result;
    return { ok: true as const, value: { ...result.value, outcome: "created" as const } };
  }
}

class IgnoresBudget extends InMemoryMemoryProvider {
  override async recall(request: RecallRequest, options?: MemoryCallOptions) {
    const result = await super.recall({ ...request, budgetTokens: 10_000_000 }, options);
    if (!result.ok) return result;
    return { ok: true as const, value: { ...result.value, budgetTokens: request.budgetTokens } };
  }
}

class LeaksOtherProjects extends InMemoryMemoryProvider {
  override async recall(request: RecallRequest, options?: MemoryCallOptions) {
    const own = await super.recall(request, options);
    const other = await super.recall({ ...request, scope: SCOPE_B }, options);
    if (!own.ok || !other.ok) return own;
    return {
      ok: true as const,
      value: { ...own.value, items: [...own.value.items, ...other.value.items] },
    };
  }
}

function subject(
  Provider: typeof InMemoryMemoryProvider,
  options?: { dedupeWindowMs?: number },
): MemoryProviderFactory {
  return () => {
    const deps = fakeMemoryDeps();
    return { provider: new Provider(deps, options), deps };
  };
}

describe("MemoryProvider contract suite: seeded deviations fail", () => {
  const retains = { retainsWrites: true };
  const window = { dedupeWindowMs: 900_000 };

  it.each([
    ["MP-02", "accepts a search without ScopeRef", subject(AcceptsMissingScope)],
    ["MP-05", "answers created for a dedupe", subject(HidesDedupe, window)],
    ["MP-12", "recalls past the budget", subject(IgnoresBudget)],
    ["MP-09", "recalls another project's memory", subject(LeaksOtherProjects)],
  ] as const)("%s fails for a provider that %s", async (id, _what, make) => {
    await expect(runMemoryProviderContractCase(id, make, retains)).rejects.toBeInstanceOf(
      ContractViolation,
    );
  });

  it.each(["MP-02", "MP-05", "MP-09", "MP-12"])("%s passes for the honest provider", async (id) => {
    await expect(
      runMemoryProviderContractCase(id, subject(InMemoryMemoryProvider, window), retains),
    ).resolves.toBeUndefined();
  });

  it("refuses an unknown case id", async () => {
    await expect(
      runMemoryProviderContractCase("MP-99", subject(InMemoryMemoryProvider), retains),
    ).rejects.toThrow("unknown memory contract case MP-99");
  });
});
