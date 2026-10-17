import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  MemoryCapabilitiesSchema,
  MemoryHealthSchema,
  MemoryWriteSchema,
  RecallBundleSchema,
  ScopeRefSchema,
  validateMemoryValue,
  WriteReceiptSchema,
} from "../src/index.js";

// Memory contract v1 draft (docs/contracts/memory.md 3; schemas.md 13 for ScopeRef).

const SESSION = "01HMEMSESSION0000000000001";
const SHA = "a".repeat(64);

const scope = {
  workspaceId: "fake-workspace",
  projectKey: "fake-project-a",
  visibility: "project",
  sessionId: SESSION,
};

const write = {
  schemaVersion: 1,
  operationId: "op-1",
  scope: { ...scope, kind: "decision" },
  title: "Use the outbox",
  content: "Every write goes through memory_outbox.",
  contentSha256: SHA,
  origin: "haril",
};

const receipt = {
  schemaVersion: 1,
  operationId: "op-1",
  provider: "in-memory",
  providerRef: "mem-1",
  outcome: "created",
  truncated: false,
  redacted: false,
};

describe("ScopeRef v1 (schemas.md 13)", () => {
  it("accepts the four required fields and the optional agent, task and kind", () => {
    expect(Value.Check(ScopeRefSchema, scope)).toBe(true);
    const full = {
      ...scope,
      agentId: "agent-1",
      taskId: "01HMEMTASK0000000000000001",
      kind: "any",
    };
    expect(Value.Check(ScopeRefSchema, full)).toBe(true);
  });

  it("rejects a scope without sessionId, with an empty projectKey or with an unknown visibility", () => {
    const { sessionId: _sessionId, ...withoutSession } = scope;
    expect(Value.Check(ScopeRefSchema, withoutSession)).toBe(false);
    expect(Value.Check(ScopeRefSchema, { ...scope, projectKey: "" })).toBe(false);
    expect(Value.Check(ScopeRefSchema, { ...scope, visibility: "team" })).toBe(false);
    expect(Value.Check(ScopeRefSchema, { ...scope, cwd: "D:/repo" })).toBe(false);
  });
});

describe("MemoryWrite v1 (memory.md 3.4)", () => {
  it("accepts a write with a kind in its scope", () => {
    expect(Value.Check(MemoryWriteSchema, write)).toBe(true);
    const evolving = {
      ...write,
      topicKey: "convention/naming",
      sourceRef: { table: "decisions", id: "d-1" },
    };
    expect(Value.Check(MemoryWriteSchema, evolving)).toBe(true);
  });

  it("requires the kind when writing and keeps the kind vocabulary closed", () => {
    expect(Value.Check(MemoryWriteSchema, { ...write, scope })).toBe(false);
    expect(Value.Check(MemoryWriteSchema, { ...write, scope: { ...scope, kind: "gossip" } })).toBe(
      false,
    );
  });

  it("rejects a hash that is not 64 lowercase hex characters and an unknown origin", () => {
    expect(Value.Check(MemoryWriteSchema, { ...write, contentSha256: "A".repeat(64) })).toBe(false);
    expect(Value.Check(MemoryWriteSchema, { ...write, contentSha256: "abc" })).toBe(false);
    expect(Value.Check(MemoryWriteSchema, { ...write, origin: "user" })).toBe(false);
  });

  it("rejects a topicKey longer than 120 characters", () => {
    expect(Value.Check(MemoryWriteSchema, { ...write, topicKey: "k".repeat(121) })).toBe(false);
  });
});

describe("WriteReceipt v1 (memory.md 3.4, CM-01)", () => {
  it("accepts the four outcomes with independent truncated and redacted flags", () => {
    for (const outcome of ["created", "updated", "deduped", "discarded"]) {
      expect(Value.Check(WriteReceiptSchema, { ...receipt, outcome })).toBe(true);
    }
    const lossy = {
      ...receipt,
      truncated: true,
      redacted: true,
      originalBytes: 60,
      limitBytes: 50,
    };
    expect(Value.Check(WriteReceiptSchema, lossy)).toBe(true);
  });

  it("rejects truncated or redacted as outcomes", () => {
    expect(Value.Check(WriteReceiptSchema, { ...receipt, outcome: "truncated" })).toBe(false);
    expect(Value.Check(WriteReceiptSchema, { ...receipt, outcome: "redacted" })).toBe(false);
  });
});

describe("RecallBundle v1 (memory.md 3.4, CM-10)", () => {
  const item = {
    ref: { provider: "in-memory", providerRef: "mem-1" },
    kind: "decision",
    title: "Use the outbox",
    content: "Every write goes through memory_outbox.",
    tokens: 52,
    trust: "untrusted",
    pinned: false,
    updatedAt: 0,
  };
  const bundle = {
    schemaVersion: 1,
    scope,
    budgetTokens: 100,
    usedTokens: 52,
    items: [item],
    omittedCount: 0,
    degraded: false,
  };

  it("accepts a bundle whose items are untrusted", () => {
    expect(Value.Check(RecallBundleSchema, bundle)).toBe(true);
    expect(
      Value.Check(RecallBundleSchema, { ...bundle, items: [{ ...item, kind: "unknown" }] }),
    ).toBe(true);
  });

  it("rejects a trusted item", () => {
    expect(
      Value.Check(RecallBundleSchema, { ...bundle, items: [{ ...item, trust: "trusted" }] }),
    ).toBe(false);
  });
});

describe("MemoryCapabilities and MemoryHealth v1 (memory.md 3.4)", () => {
  const capabilities = {
    schemaVersion: 1,
    provider: "null",
    providerVersion: null,
    persistent: false,
    sessionTracking: false,
    supportsOperationId: false,
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

  it("accepts honest capabilities and rejects an unknown search syntax", () => {
    expect(Value.Check(MemoryCapabilitiesSchema, capabilities)).toBe(true);
    expect(Value.Check(MemoryCapabilitiesSchema, { ...capabilities, searchSyntax: "regex" })).toBe(
      false,
    );
  });

  it("accepts a degraded health with its last error", () => {
    const health = {
      schemaVersion: 1,
      provider: "engram",
      state: "degraded",
      checkedAt: 10,
      realReadOk: false,
      version: null,
      instanceId: null,
      dataDir: null,
      lastError: { code: "Unavailable", at: 9 },
    };
    expect(Value.Check(MemoryHealthSchema, health)).toBe(true);
    expect(Value.Check(MemoryHealthSchema, { ...health, lastError: { code: "Boom", at: 9 } })).toBe(
      false,
    );
  });
});

describe("validateMemoryValue", () => {
  it("returns the value when it validates and readable paths when it does not", () => {
    expect(validateMemoryValue("scope-ref", scope)).toEqual({ ok: true, value: scope });
    const invalid = validateMemoryValue("write", { ...write, title: "" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.some((error) => error.startsWith("/title"))).toBe(true);
  });

  it("never throws on a value that is not an object", () => {
    expect(validateMemoryValue("write-receipt", undefined).ok).toBe(false);
    expect(validateMemoryValue("recall-request", 42).ok).toBe(false);
  });

  it("knows memory.hit (memory.md 3.2) on its own, not only inside a page", () => {
    const hit = {
      ref: { provider: "in-memory", providerRef: "mem-1" },
      kind: "unknown",
      title: "Use the outbox",
      snippet: "Every write goes",
      score: null,
      pinned: false,
      updatedAt: 0,
    };
    expect(validateMemoryValue("hit", hit)).toEqual({ ok: true, value: hit });
    expect(validateMemoryValue("hit", { ...hit, score: "high" }).ok).toBe(false);
  });
});
