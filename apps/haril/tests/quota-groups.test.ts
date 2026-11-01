import { chooseModel, DEFAULT_QUOTA_POLICY, type ModelSelectionContext } from "@haril/core";
import type { QuotaSampleRecord } from "@haril/core/ports";
import { describe, expect, it } from "vitest";
import {
  accountViews,
  groupIndex,
  quotaByKey,
  quotaGroupOf,
  quotaKeyFor,
  quotaKeyOf,
} from "../src/quota-view.js";

// Quota by group (feature haril-factory, F5): an account's models spend different pools, so a spent pool holds back only
// its own models. A model with no known group keeps the worst-window rule: nothing gets looser without data.

const NOW = 1_800_000_000_000;
const CLAUDE = "cliproxy/Anti1/claude-opus-4-6-thinking";
const GPT = "cliproxy/Anti1/gpt-6.1-sol";
const GEMINI = "cliproxy/Anti1/gemini-3.8-flash";
const UNKNOWN = "cliproxy/Anti1/mystery-model";

function row(overrides: Partial<QuotaSampleRecord>): QuotaSampleRecord {
  return {
    provider: "cliproxy",
    batchId: "b1",
    credentialRef: "acct-1",
    kind: "antigravity",
    prefix: "Anti1",
    window: "5h",
    usedPct: 90,
    resetsAt: NOW + 3_600_000,
    sampledAt: NOW,
    source: "cliproxyapi-management/v8",
    note: null,
    ...overrides,
  };
}

// The user's panel: 90% on Gemini, 5% on Claude and GPT. The account's worst window is therefore 90%.
const RECORDS: readonly QuotaSampleRecord[] = [
  row({ window: "5h", usedPct: 90 }),
  row({ window: "7d", usedPct: 40 }),
  row({ window: "5h", usedPct: 90, group: "Gemini" }),
  row({ window: "7d", usedPct: 40, group: "Gemini" }),
  row({ window: "5h", usedPct: 5, group: "Claude and GPT" }),
  row({ window: "7d", usedPct: 3, group: "Claude and GPT" }),
];

function contextFor(ref: string): ModelSelectionContext {
  const groups = groupIndex(RECORDS);
  return {
    now: NOW,
    catalog: [{ ref, quotaKey: quotaKeyFor(ref, groups), hasKey: true, coolingUntil: null }],
    allow: {},
    pinned: {},
    quota: quotaByKey(RECORDS, DEFAULT_QUOTA_POLICY),
    table: {
      classes: {
        trivial: { minSuccessRate: 0, order: [ref] },
        easy: { minSuccessRate: 0, order: [ref] },
        medium: { minSuccessRate: 0, order: [ref] },
        hard: { minSuccessRate: 0, order: [ref] },
        expert: { minSuccessRate: 0, order: [ref] },
      },
      models: {},
    },
    stats: {},
    policy: { ...DEFAULT_QUOTA_POLICY, maxWaitMs: 0 },
    largeTaskTokens: 50_000,
  };
}

function choiceFor(ref: string) {
  return chooseModel(
    { archetype: "executor", difficulty: "medium", budgetTokens: 1_000, phase: "launch" },
    contextFor(ref),
  );
}

describe("quota by group", () => {
  it("keeps an account at 90% on Gemini and 5% on Claude and GPT eligible for Claude and GPT", () => {
    expect(choiceFor(CLAUDE)).toMatchObject({ kind: "use", model: CLAUDE });
    expect(choiceFor(GPT)).toMatchObject({ kind: "use", model: GPT });
  });

  it("holds back the group that is spent", () => {
    expect(choiceFor(GEMINI).kind).not.toBe("use");
  });

  it("applies the worst window to a model with no known group", () => {
    expect(quotaKeyFor(UNKNOWN, groupIndex(RECORDS))).toBe("cliproxy/Anti1");
    expect(choiceFor(UNKNOWN).kind).not.toBe("use");
  });

  it("names the key provider/prefix#group, and falls back to the account's key", () => {
    const groups = groupIndex(RECORDS);
    expect(quotaKeyFor(CLAUDE, groups)).toBe("cliproxy/Anti1#Claude and GPT");
    expect(quotaKeyFor(GEMINI, groups)).toBe("cliproxy/Anti1#Gemini");
    expect(quotaKeyFor("cliproxy/Other/claude-opus-4-6", groups)).toBe("cliproxy/Other");
    expect(quotaKeyFor("cliproxy/plain-model", groups)).toBe(quotaKeyOf("cliproxy/plain-model"));
  });

  it("prefers the bucket's model list over the family rule", () => {
    const groups = [
      { name: "Fast pool", models: ["claude-haiku-5-5"] },
      { name: "Claude", models: [] },
    ];
    expect(quotaGroupOf("claude-haiku-5-5", groups)).toBe("Fast pool");
    expect(quotaGroupOf("claude-opus-5-5", groups)).toBe("Claude");
  });

  it("leaves a family that two groups could own without a group", () => {
    const groups = [
      { name: "Gemini Flash", models: [] },
      { name: "Gemini Pro", models: [] },
    ];
    expect(quotaGroupOf("gemini-3-flash", groups)).toBeNull();
  });

  it("reads rows stored before groups existed, and providers without groups, as before", () => {
    const old = [row({ window: "5h", usedPct: 12 }), row({ window: "7d", usedPct: 30 })];
    expect(groupIndex(old).size).toBe(0);
    const [account] = accountViews(old, DEFAULT_QUOTA_POLICY);
    expect(account?.groups).toEqual([]);
    expect(account?.window5h.usedPct).toBe(12);
    expect(quotaByKey(old, DEFAULT_QUOTA_POLICY)["cliproxy/Anti1"]).toMatchObject({
      window5hUsedPct: 12,
      weeklyUsedPct: 30,
    });
  });

  it("does not let a group's window overwrite the account's worst one", () => {
    const [account] = accountViews(RECORDS, DEFAULT_QUOTA_POLICY);
    expect(account?.window5h.usedPct).toBe(90);
    expect(account?.groups.map((group) => [group.name, group.window5h.usedPct])).toEqual([
      ["Gemini", 90],
      ["Claude and GPT", 5],
    ]);
  });
});
