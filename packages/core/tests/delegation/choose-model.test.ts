import { describe, expect, it } from "vitest";
import {
  type CatalogModel,
  chooseModel,
  DEFAULT_QUOTA_POLICY,
  type DifficultyTable,
  evaluateQuota,
  type ModelRequest,
  type ModelSelectionContext,
  type QuotaSample,
  worstQuota,
} from "../../src/delegation/index.js";

// chooseModel (docs/modos-y-delegacion.md 3.11): precedence user-specified > parent > difficulty table, plus the
// quota rules 80/80/20 and "sin dato". The clock is a plain number.

const NOW = 1_000_000;
const HOUR = 3_600_000;

function model(ref: string, change: Partial<CatalogModel> = {}): CatalogModel {
  return { ref, quotaKey: ref.split("/")[0] ?? ref, hasKey: true, coolingUntil: null, ...change };
}

function used(
  window5hUsedPct: number | null,
  weeklyUsedPct: number | null = 10,
): Extract<QuotaSample, { available: true }> {
  return {
    available: true,
    window5hUsedPct,
    window5hResetsAt: NOW + HOUR,
    weeklyUsedPct,
    weeklyResetsAt: NOW + 72 * HOUR,
  };
}

const TABLE: DifficultyTable = {
  classes: {
    trivial: { minSuccessRate: 0.7, order: ["cheap/a", "cheap/b"] },
    easy: { minSuccessRate: 0.7, order: ["cheap/a", "mid/m"] },
    medium: { minSuccessRate: 0.8, order: ["mid/m", "cheap/a", "high/h"] },
    hard: { minSuccessRate: 0.8, order: ["high/h", "mid/m"] },
    expert: { minSuccessRate: 0.9, order: [] },
  },
  models: {
    "cheap/a": { costTier: 1 },
    "cheap/b": { costTier: 1 },
    "mid/m": { costTier: 2 },
    "high/h": { costTier: 3 },
  },
};

function context(change: Partial<ModelSelectionContext> = {}): ModelSelectionContext {
  return {
    now: NOW,
    catalog: [model("cheap/a"), model("cheap/b"), model("mid/m"), model("high/h")],
    allow: {},
    pinned: {},
    quota: {},
    table: TABLE,
    stats: {},
    policy: DEFAULT_QUOTA_POLICY,
    largeTaskTokens: 50_000,
    ...change,
  };
}

function request(change: Partial<ModelRequest> = {}): ModelRequest {
  return {
    archetype: "executor",
    difficulty: "medium",
    budgetTokens: 10_000,
    phase: "launch",
    ...change,
  };
}

describe("chooseModel: a model the user specified", () => {
  it("uses the model named for the task over the parent's and the table's", () => {
    const choice = chooseModel(request({ explicit: "high/h", proposed: "cheap/a" }), context());
    expect(choice).toEqual({
      kind: "use",
      model: "high/h",
      source: "pinned",
      reason: "explicit",
      quota: "no_data",
      substitutedFrom: null,
      sameAsAvoided: false,
    });
  });

  it("treats an empty or blank model named for the task as absent, never as a pinned model", () => {
    for (const blank of ["", "   "]) {
      expect(chooseModel(request({ explicit: blank }), context())).toMatchObject({
        kind: "use",
        model: "mid/m",
        source: "table",
      });
      expect(
        chooseModel(request({ explicit: blank }), context({ pinned: { executor: "high/h" } })),
      ).toMatchObject({ model: "high/h", source: "pinned", reason: "layer_pin" });
    }
  });

  it("treats a null, empty or blank layer pin as unpinned", () => {
    for (const pin of [null, "", " "]) {
      expect(
        chooseModel(request({ proposed: "cheap/a" }), context({ pinned: { executor: pin } })),
      ).toMatchObject({ model: "cheap/a", source: "parent" });
    }
  });

  it("uses the layer's pinned model when the task names none, and the task's model over it", () => {
    const pinned = context({ pinned: { executor: "mid/m" } });
    expect(chooseModel(request({ proposed: "cheap/a" }), pinned)).toMatchObject({
      kind: "use",
      model: "mid/m",
      reason: "layer_pin",
    });
    expect(chooseModel(request({ explicit: "high/h" }), pinned)).toMatchObject({
      model: "high/h",
      reason: "explicit",
    });
  });

  it("uses it even outside the allow list and the catalog", () => {
    const choice = chooseModel(
      request({ explicit: "elsewhere/x" }),
      context({ allow: { executor: ["cheap/a"] } }),
    );
    expect(choice).toMatchObject({ kind: "use", model: "elsewhere/x", source: "pinned" });
  });

  it("waits for the 5-hour reset instead of switching when its quota is over the threshold", () => {
    const choice = chooseModel(
      request({ explicit: "mid/m" }),
      context({ quota: { mid: used(85) } }),
    );
    expect(choice).toEqual({ kind: "wait", model: "mid/m", until: NOW + HOUR, cause: "window_5h" });
  });

  it("waits for the end of a cooldown", () => {
    const catalog = [model("mid/m", { coolingUntil: NOW + 60_000 })];
    expect(chooseModel(request({ explicit: "mid/m" }), context({ catalog }))).toEqual({
      kind: "wait",
      model: "mid/m",
      until: NOW + 60_000,
      cause: "cooldown",
    });
  });

  it("stops with a clear reason when its weekly reset is beyond the longest wait", () => {
    const choice = chooseModel(
      request({ explicit: "mid/m" }),
      context({ quota: { mid: used(10, 90) } }),
    );
    expect(choice).toEqual({ kind: "unavailable", model: "mid/m", cause: "weekly" });
  });

  it("is used with quota 'no_data' when the provider reports none", () => {
    const unavailable: QuotaSample = { available: false, reason: "management API unreachable" };
    const choice = chooseModel(
      request({ explicit: "mid/m" }),
      context({ quota: { mid: unavailable } }),
    );
    expect(choice).toMatchObject({ kind: "use", model: "mid/m", quota: "no_data" });
  });

  it("is used for an auditor even when it equals the executor's model, and says so", () => {
    const choice = chooseModel(
      request({ archetype: "auditor", explicit: "mid/m", avoid: "mid/m" }),
      context(),
    );
    expect(choice).toMatchObject({ kind: "use", model: "mid/m", sameAsAvoided: true });
  });
});

describe("chooseModel: the parent's choice", () => {
  it("is used when it is allowed, listed, keyed and within quota", () => {
    const choice = chooseModel(request({ proposed: "high/h", phase: "propose" }), context());
    expect(choice).toMatchObject({
      kind: "use",
      model: "high/h",
      source: "parent",
      reason: "parent",
    });
  });

  it("is rejected at proposal time with model_not_allowed outside the layer's allow list", () => {
    const choice = chooseModel(
      request({ proposed: "high/h", phase: "propose" }),
      context({ allow: { executor: ["cheap/a", "mid/m"] } }),
    );
    expect(choice).toEqual({
      kind: "reject",
      code: "model_not_allowed",
      model: "high/h",
      cause: "not_allowed",
    });
  });

  it("is rejected with model_unavailable when it is not in the catalog or has no key", () => {
    expect(
      chooseModel(request({ proposed: "ghost/g", phase: "propose" }), context()),
    ).toMatchObject({
      kind: "reject",
      code: "model_unavailable",
      cause: "not_in_catalog",
    });
    const catalog = [model("mid/m", { hasKey: false })];
    expect(
      chooseModel(request({ proposed: "mid/m", phase: "propose" }), context({ catalog })),
    ).toMatchObject({ kind: "reject", code: "model_unavailable", cause: "no_key" });
  });

  it("is rejected with quota_blocked over a quota threshold or in cooldown", () => {
    expect(
      chooseModel(
        request({ proposed: "mid/m", phase: "propose" }),
        context({ quota: { mid: used(81) } }),
      ),
    ).toMatchObject({ kind: "reject", code: "quota_blocked", cause: "window_5h" });
    const catalog = [model("mid/m", { coolingUntil: NOW + 1 })];
    expect(
      chooseModel(request({ proposed: "mid/m", phase: "propose" }), context({ catalog })),
    ).toMatchObject({ kind: "reject", code: "quota_blocked", cause: "cooldown" });
  });

  it("is replaced by the next eligible model at launch time, and the substitution is reported", () => {
    const choice = chooseModel(
      request({ proposed: "mid/m", phase: "launch" }),
      context({ quota: { mid: used(85) } }),
    );
    expect(choice).toMatchObject({
      kind: "use",
      model: "cheap/a",
      source: "table",
      reason: "substituted",
      substitutedFrom: "mid/m",
    });
  });
});

describe("chooseModel: the difficulty table", () => {
  it("takes the class order when there is no history", () => {
    expect(chooseModel(request({ difficulty: "medium" }), context())).toMatchObject({
      kind: "use",
      model: "mid/m",
      source: "table",
      reason: "table_order",
    });
  });

  it("takes the cheapest model whose success rate meets the class minimum", () => {
    const stats = {
      "mid/m": { medium: { successRate: 0.95, samples: 20 } },
      "cheap/a": { medium: { successRate: 0.85, samples: 12 } },
      "high/h": { medium: { successRate: 0.99, samples: 30 } },
    };
    expect(chooseModel(request({ difficulty: "medium" }), context({ stats }))).toMatchObject({
      model: "cheap/a",
      reason: "success_rate",
    });
  });

  it("breaks a cost tie by the most remaining quota, and an unknown quota ranks last", () => {
    const stats = {
      "cheap/a": { trivial: { successRate: 0.9, samples: 5 } },
      "cheap/b": { trivial: { successRate: 0.9, samples: 5 } },
    };
    const busierA = context({ stats, quota: { cheap: used(10) } });
    const separate = context({
      stats,
      catalog: [model("cheap/a", { quotaKey: "acct1" }), model("cheap/b", { quotaKey: "acct2" })],
      quota: { acct1: used(60), acct2: used(20) },
    });
    expect(chooseModel(request({ difficulty: "trivial" }), separate)).toMatchObject({
      model: "cheap/b",
    });
    const unknownB = context({
      stats,
      catalog: [model("cheap/a", { quotaKey: "acct1" }), model("cheap/b", { quotaKey: "acct2" })],
      quota: { acct1: used(60) },
    });
    expect(chooseModel(request({ difficulty: "trivial" }), unknownB)).toMatchObject({
      model: "cheap/a",
    });
    expect(chooseModel(request({ difficulty: "trivial" }), busierA)).toMatchObject({
      model: "cheap/a",
    });
  });

  it("falls back to the class order when no model meets the minimum", () => {
    const stats = { "cheap/a": { medium: { successRate: 0.5, samples: 40 } } };
    expect(chooseModel(request({ difficulty: "medium" }), context({ stats }))).toMatchObject({
      model: "mid/m",
      reason: "table_order",
    });
  });

  // The user's wording ("más del 80 %"): exactly 80% used still runs; only more than 80% switches.
  it("switches away from a model over 80% of its 5-hour window, and keeps it at exactly 80%", () => {
    expect(
      chooseModel(request({ difficulty: "medium" }), context({ quota: { mid: used(80) } })),
    ).toMatchObject({ model: "mid/m", quota: "ok" });
    expect(
      chooseModel(request({ difficulty: "medium" }), context({ quota: { mid: used(80.1) } })),
    ).toMatchObject({ model: "cheap/a" });
  });

  it("stops using a model over 80% of its weekly limit, and keeps it at exactly 80%", () => {
    expect(
      chooseModel(request({ difficulty: "medium" }), context({ quota: { mid: used(5, 81) } })),
    ).toMatchObject({ model: "cheap/a" });
    expect(
      chooseModel(request({ difficulty: "medium" }), context({ quota: { mid: used(5, 80) } })),
    ).toMatchObject({ model: "mid/m", quota: "ok" });
  });

  it('sends a large task to a model with exactly 20% of its 5-hour window left ("menos del 20 %")', () => {
    const policy = { ...DEFAULT_QUOTA_POLICY, switchAtPercent5h: 90 };
    expect(
      chooseModel(request({ difficulty: "hard" }), context({ policy, quota: { high: used(80) } })),
    ).toMatchObject({ model: "high/h", quota: "ok" });
    expect(
      chooseModel(
        request({ difficulty: "hard" }),
        context({ policy, quota: { high: used(80.5) } }),
      ),
    ).toMatchObject({ model: "mid/m" });
  });

  it("treats a NaN, negative or above-100 percentage as no data for that window only; a valid window still applies", () => {
    for (const bad of [Number.NaN, -1, 100.5, Number.POSITIVE_INFINITY]) {
      expect(
        chooseModel(request({ difficulty: "medium" }), context({ quota: { mid: used(bad) } })),
      ).toMatchObject({ model: "mid/m", quota: "ok" });
      expect(
        chooseModel(request({ difficulty: "medium" }), context({ quota: { mid: used(5, bad) } })),
      ).toMatchObject({ model: "mid/m", quota: "ok" });
      expect(evaluateQuota(used(bad, 95), false, DEFAULT_QUOTA_POLICY)).toEqual({
        ok: false,
        cause: "weekly",
        until: NOW + 72 * HOUR,
      });
      expect(evaluateQuota(used(95, bad), false, DEFAULT_QUOTA_POLICY)).toMatchObject({
        ok: false,
        cause: "window_5h",
      });
      expect(evaluateQuota(used(bad, bad), false, DEFAULT_QUOTA_POLICY)).toEqual({
        ok: true,
        data: "no_data",
      });
    }
  });

  it("sends no large task to a model with 20% or less of its 5-hour window left", () => {
    const policy = { ...DEFAULT_QUOTA_POLICY, switchAtPercent5h: 90 };
    const quota = { high: used(85) };
    expect(chooseModel(request({ difficulty: "hard" }), context({ policy, quota }))).toMatchObject({
      model: "mid/m",
    });
    expect(
      chooseModel(
        request({ difficulty: "medium", budgetTokens: 50_000, explicit: null }),
        context({ policy, quota: { mid: used(85) } }),
      ),
    ).toMatchObject({ model: "cheap/a" });
    expect(
      chooseModel(request({ difficulty: "medium" }), context({ policy, quota: { mid: used(85) } })),
    ).toMatchObject({ model: "mid/m" });
  });

  it("skips the quota rule for a provider without data and says 'no_data'", () => {
    const choice = chooseModel(
      request({ difficulty: "medium" }),
      context({ quota: { mid: { available: false, reason: "not exposed" } } }),
    );
    expect(choice).toMatchObject({ model: "mid/m", quota: "no_data" });
  });

  it("skips a model in cooldown, outside the allow list or without a key", () => {
    const catalog = [
      model("mid/m", { coolingUntil: NOW + 5 }),
      model("cheap/a", { hasKey: false }),
      model("high/h"),
    ];
    expect(chooseModel(request({ difficulty: "medium" }), context({ catalog }))).toMatchObject({
      model: "high/h",
    });
    expect(
      chooseModel(request({ difficulty: "medium" }), context({ allow: { executor: ["high/h"] } })),
    ).toMatchObject({ model: "high/h" });
  });

  it("ranks every eligible catalog model by cost when the class lists none", () => {
    expect(chooseModel(request({ difficulty: "expert" }), context())).toMatchObject({
      model: "cheap/a",
      reason: "table_order",
    });
  });

  it("gives an auditor a model other than its executor's when one is eligible", () => {
    expect(
      chooseModel(
        request({ archetype: "auditor", difficulty: "medium", avoid: "mid/m" }),
        context(),
      ),
    ).toMatchObject({ model: "cheap/a", sameAsAvoided: false });
    const onlyOne = context({ catalog: [model("mid/m")] });
    expect(
      chooseModel(request({ archetype: "auditor", difficulty: "medium", avoid: "mid/m" }), onlyOne),
    ).toMatchObject({ model: "mid/m", sameAsAvoided: true });
  });

  it("waits for the earliest reset when only the 5-hour window excludes every model", () => {
    const quota = {
      mid: { ...used(90), window5hResetsAt: NOW + 2 * HOUR } as QuotaSample,
      cheap: used(95),
      high: { ...used(99), window5hResetsAt: NOW + 3 * HOUR } as QuotaSample,
    };
    expect(chooseModel(request({ difficulty: "medium" }), context({ quota }))).toEqual({
      kind: "wait",
      model: null,
      until: NOW + HOUR,
      cause: "window_5h",
    });
  });

  it("ends with no capacity when every model is out beyond the longest wait", () => {
    const quota = { mid: used(5, 90), cheap: used(5, 95), high: used(5, 99) };
    expect(chooseModel(request({ difficulty: "medium" }), context({ quota }))).toEqual({
      kind: "unavailable",
      model: null,
      cause: "weekly",
    });
    expect(chooseModel(request({ difficulty: "medium" }), context({ catalog: [] }))).toEqual({
      kind: "unavailable",
      model: null,
      cause: "not_in_catalog",
    });
  });
});

describe("evaluateQuota", () => {
  it("skips the rule without data", () => {
    expect(evaluateQuota(undefined, false, DEFAULT_QUOTA_POLICY)).toEqual({
      ok: true,
      data: "no_data",
    });
    expect(evaluateQuota(used(null, null), true, DEFAULT_QUOTA_POLICY)).toEqual({
      ok: true,
      data: "no_data",
    });
  });

  it("applies only the windows it knows", () => {
    expect(evaluateQuota(used(null, 50), true, DEFAULT_QUOTA_POLICY)).toEqual({
      ok: true,
      data: "ok",
    });
    expect(evaluateQuota(used(null, 85), false, DEFAULT_QUOTA_POLICY)).toEqual({
      ok: false,
      cause: "weekly",
      until: NOW + 72 * HOUR,
    });
  });
});

describe("worstQuota (P4: the worst account of the provider)", () => {
  it("takes the highest use of each window across the accounts that report", () => {
    const merged = worstQuota([
      used(38, 52),
      { available: false, reason: "not exposed" },
      { ...used(83, 41), window5hResetsAt: NOW + 2 * HOUR } as QuotaSample,
    ]);
    expect(merged).toEqual({
      available: true,
      window5hUsedPct: 83,
      window5hResetsAt: NOW + 2 * HOUR,
      weeklyUsedPct: 52,
      weeklyResetsAt: NOW + 72 * HOUR,
    });
  });

  it("keeps the valid window of an account whose other window is not valid", () => {
    expect(worstQuota([used(38, 52), used(Number.NaN, 99)])).toEqual({
      available: true,
      window5hUsedPct: 38,
      window5hResetsAt: NOW + HOUR,
      weeklyUsedPct: 99,
      weeklyResetsAt: NOW + 72 * HOUR,
    });
    expect(worstQuota([used(-5, 10)])).toMatchObject({ window5hUsedPct: null, weeklyUsedPct: 10 });
    expect(worstQuota([used(-5, Number.NaN)]).available).toBe(false);
  });

  it("is unavailable when no account reports", () => {
    expect(worstQuota([{ available: false, reason: "x" }])).toEqual({
      available: false,
      reason: "no account reports quota",
    });
    expect(worstQuota([]).available).toBe(false);
  });
});
