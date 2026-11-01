import { ROLE_NAMES, ROLE_PROFILES } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import {
  chooseModel,
  DEFAULT_QUOTA_POLICY,
  evaluateQuota,
  expandRoleList,
  type ModelSelectionContext,
  matchesRolePattern,
  meetsFloor,
  modelTier,
  roleVendorWarnings,
} from "../../src/delegation/index.js";

// Role profiles (feature haril-factory, F6): the role's order comes right after a pin, a role never goes below its floor,
// and none of this runs for a task that names no role.

const NOW = 1_000_000;
const HOUR = 3_600_000;
const OPUS = "cliproxy/Anti1/claude-opus-4-6-thinking";
const SONNET = "cliproxy/Anti1/claude-sonnet-4-6";
const FLASH = "cliproxy/Anti1/gemini-3.8-flash";
const FLASH_HIGH = "cliproxy/Anti2/gemini-3.8-flash-high";
const SOL = "cliproxy/Cx/gpt-6.1-sol";
const CATALOG = [OPUS, SONNET, FLASH, FLASH_HIGH, SOL];

function context(change: Partial<ModelSelectionContext> = {}): ModelSelectionContext {
  return {
    now: NOW,
    catalog: CATALOG.map((ref) => ({
      ref,
      quotaKey: ref.split("/").slice(0, 2).join("/"),
      hasKey: true,
      coolingUntil: null,
    })),
    allow: {},
    pinned: {},
    quota: {},
    table: {
      classes: {
        trivial: { minSuccessRate: 0, order: [FLASH] },
        easy: { minSuccessRate: 0, order: [FLASH] },
        medium: { minSuccessRate: 0, order: [FLASH] },
        hard: { minSuccessRate: 0, order: [FLASH] },
        expert: { minSuccessRate: 0, order: [FLASH] },
      },
      models: {},
    },
    stats: {},
    policy: DEFAULT_QUOTA_POLICY,
    largeTaskTokens: 50_000,
    roles: {
      backend: { archetype: "executor", floor: "mid", order: [SOL, SONNET, FLASH_HIGH] },
      arquitecto: { archetype: "orchestrator", floor: "high", order: [SONNET, FLASH, OPUS] },
      auditor: { archetype: "auditor", floor: "high", order: [SONNET, FLASH] },
    },
    ...change,
  };
}

const EXECUTOR = {
  archetype: "executor" as const,
  difficulty: "medium" as const,
  budgetTokens: 1_000,
  phase: "launch" as const,
};

describe("the seventeen role profiles", () => {
  it("are all there, on existing archetypes", () => {
    expect(ROLE_NAMES).toHaveLength(17);
    for (const name of ROLE_NAMES) {
      expect(["orchestrator", "delegator", "executor", "auditor"]).toContain(
        ROLE_PROFILES[name].archetype,
      );
    }
  });

  it("name no Fable, image or open-weight model", () => {
    const entries = ROLE_NAMES.flatMap((name) => ROLE_PROFILES[name].models).join(" ");
    expect(entries).not.toMatch(/fable|image|gpt-oss/i);
  });

  it("match the real ids of today's catalog, with their suffixes", () => {
    expect(expandRoleList(ROLE_PROFILES.arquitecto.models, CATALOG)).toContain(OPUS);
    expect(expandRoleList(ROLE_PROFILES.backend.models, CATALOG)).toEqual([SOL, SONNET, OPUS]);
    expect(expandRoleList(ROLE_PROFILES.investigador.models, CATALOG)).toEqual([FLASH, FLASH_HIGH]);
  });
});

describe("patterns", () => {
  it("match across account prefixes, and a dot and a hyphen are one", () => {
    expect(matchesRolePattern("claude-opus-5-5*", "cliproxy/Any/claude-opus-5-5-thinking")).toBe(
      true,
    );
    expect(matchesRolePattern("claude-sonnet-5-5*", "x/y/claude-sonnet-5.5")).toBe(true);
    expect(matchesRolePattern("gpt-6-astra*", "x/y/gpt-6.1-sol")).toBe(false);
  });

  it("leave image and open-weight models out unless the list asks for them", () => {
    const catalog = ["p/gemini-3.8-flash", "p/gemini-3.8-flash-image", "p/gpt-oss-120b"];
    expect(expandRoleList(["*gemini-3.8-flash*", "*gpt*"], catalog)).toEqual([
      "p/gemini-3.8-flash",
    ]);
    expect(expandRoleList(["*flash-image"], catalog)).toEqual(["p/gemini-3.8-flash-image"]);
  });
});

describe("tiers", () => {
  it("read a model's strength from its id", () => {
    expect(modelTier(OPUS)).toBe("high");
    expect(modelTier("x/gpt-6-astra")).toBe("high");
    expect(modelTier("x/gemini-4-argon")).toBe("high");
    expect(modelTier(SONNET)).toBe("mid");
    expect(modelTier("x/gpt-6.1-terra")).toBe("mid");
    expect(modelTier(FLASH_HIGH)).toBe("mid");
    expect(modelTier("x/deepseek-v4-pro")).toBe("mid");
    expect(modelTier("x/claude-haiku-5-5")).toBe("low");
    expect(modelTier(FLASH)).toBe("low");
    expect(modelTier("x/gemini-3.5-flash-lite")).toBe("low");
    expect(modelTier("x/deepseek-flash")).toBe("low");
    expect(modelTier("x/unknown")).toBeNull();
  });

  it("count sol as high only at its maximum level", () => {
    expect(modelTier(SOL)).toBe("mid");
    expect(modelTier(SOL, true)).toBe("high");
    expect(meetsFloor(SOL, "high")).toBe(false);
    expect(meetsFloor(SOL, "high", true)).toBe(true);
  });

  it("let an unknown model pass only the lowest floor", () => {
    expect(meetsFloor("x/unknown", "low")).toBe(true);
    expect(meetsFloor("x/unknown", "mid")).toBe(false);
  });
});

describe("chooseModel with a role", () => {
  it("takes the first eligible model of the list, and says why", () => {
    expect(chooseModel({ ...EXECUTOR, role: "backend" }, context())).toMatchObject({
      kind: "use",
      model: SOL,
      source: "role",
      reason: "role_order",
    });
  });

  it("leaves a task with no role, or an unknown one, to the table as before", () => {
    expect(chooseModel(EXECUTOR, context())).toMatchObject({ model: FLASH, source: "table" });
    expect(chooseModel({ ...EXECUTOR, role: "nobody" }, context())).toMatchObject({
      model: FLASH,
      source: "table",
    });
  });

  it("ignores a role of another archetype", () => {
    expect(
      chooseModel({ ...EXECUTOR, archetype: "auditor", role: "backend" }, context()),
    ).toMatchObject({ source: "table" });
  });

  it("gives a pin precedence over the role", () => {
    expect(chooseModel({ ...EXECUTOR, role: "backend", explicit: FLASH }, context())).toMatchObject(
      {
        model: FLASH,
        source: "pinned",
      },
    );
  });

  it("skips what its cooldown or quota holds back, with the same rules", () => {
    const cooling = context();
    const catalog = cooling.catalog.map((entry) =>
      entry.ref === SOL ? { ...entry, coolingUntil: NOW + HOUR } : entry,
    );
    expect(chooseModel({ ...EXECUTOR, role: "backend" }, { ...cooling, catalog })).toMatchObject({
      model: SONNET,
    });
    const spent = context({
      quota: {
        "cliproxy/Cx": {
          available: true,
          window5hUsedPct: 95,
          window5hResetsAt: NOW + HOUR,
          weeklyUsedPct: 10,
          weeklyResetsAt: null,
        },
      },
    });
    expect(chooseModel({ ...EXECUTOR, role: "backend" }, spent)).toMatchObject({ model: SONNET });
  });

  it("rejects Sonnet 4.6 and Flash for a role with a high floor, even when its list names them", () => {
    for (const role of ["arquitecto", "auditor"] as const) {
      const archetype = role === "auditor" ? ("auditor" as const) : ("delegator" as const);
      const choice = chooseModel(
        { ...EXECUTOR, archetype, role },
        context({
          roles: {
            [role]: {
              archetype: role === "auditor" ? "auditor" : "orchestrator",
              floor: "high",
              order: [SONNET, FLASH],
            },
          },
        }),
      );
      expect(choice.kind).toBe("unavailable");
    }
  });

  it("does not fall back to the table below the floor", () => {
    const choice = chooseModel(
      { ...EXECUTOR, role: "backend" },
      context({ roles: { backend: { archetype: "executor", floor: "mid", order: [FLASH] } } }),
    );
    expect(choice).toMatchObject({ kind: "unavailable", cause: "below_floor" });
  });

  it("runs sol on a high-floor role only when its layer asks for the maximum level", () => {
    const roles = (maxLevel: boolean): ModelSelectionContext["roles"] => ({
      seguridad: { archetype: "auditor", floor: "high", order: [SOL, OPUS], maxLevel },
    });
    const request = { ...EXECUTOR, archetype: "auditor" as const, role: "seguridad" };
    expect(chooseModel(request, context({ roles: roles(false) }))).toMatchObject({ model: OPUS });
    expect(chooseModel(request, context({ roles: roles(true) }))).toMatchObject({ model: SOL });
  });

  it("moves to the least used model of the same tier when usage is known", () => {
    expect(
      chooseModel(
        { ...EXECUTOR, role: "backend" },
        context({ usage: { [SOL]: 900, [SONNET]: 100, [FLASH_HIGH]: 500 } }),
      ),
    ).toMatchObject({ model: SONNET });
    // Without usage for the first, the list's order stands.
    expect(
      chooseModel({ ...EXECUTOR, role: "backend" }, context({ usage: { [SONNET]: 100 } })),
    ).toMatchObject({ model: SOL });
    // A cheap model of a lower tier never overtakes a stronger one.
    expect(
      chooseModel(
        { ...EXECUTOR, role: "frontend" },
        context({
          roles: { frontend: { archetype: "executor", floor: "low", order: [OPUS, FLASH] } },
          usage: { [OPUS]: 900, [FLASH]: 1 },
        }),
      ),
    ).toMatchObject({ model: OPUS });
  });

  it("keeps an agent thread on its model while it stays eligible", () => {
    const usage = { [SOL]: 1, [SONNET]: 900 };
    expect(
      chooseModel({ ...EXECUTOR, role: "backend", sticky: SONNET }, context({ usage })),
    ).toMatchObject({ model: SONNET });
    const cooling = context();
    const catalog = cooling.catalog.map((entry) =>
      entry.ref === SONNET ? { ...entry, coolingUntil: NOW + HOUR } : entry,
    );
    expect(
      chooseModel({ ...EXECUTOR, role: "backend", sticky: SONNET }, { ...cooling, catalog }),
    ).toMatchObject({ model: SOL });
  });

  it("keeps an auditor off its executor's model when another is eligible", () => {
    const roles: ModelSelectionContext["roles"] = {
      auditor: { archetype: "auditor", floor: "mid", order: [SOL, SONNET] },
    };
    expect(
      chooseModel(
        { ...EXECUTOR, archetype: "auditor", role: "auditor", avoid: SOL },
        context({ roles }),
      ),
    ).toMatchObject({ model: SONNET, sameAsAvoided: false });
  });

  it("names a parent's replaced model", () => {
    expect(chooseModel({ ...EXECUTOR, role: "backend", proposed: FLASH }, context())).toMatchObject(
      {
        model: SOL,
        substitutedFrom: FLASH,
      },
    );
  });

  it("rejects a parent's proposal below the floor at proposal time", () => {
    expect(
      chooseModel({ ...EXECUTOR, phase: "propose", role: "backend", proposed: FLASH }, context()),
    ).toMatchObject({ kind: "reject", code: "model_not_allowed", cause: "below_floor" });
  });

  it("lists what it tried when nothing can run", () => {
    const choice = chooseModel(
      { ...EXECUTOR, role: "backend" },
      context({
        catalog: context().catalog.map((entry) => ({ ...entry, coolingUntil: NOW + 99 * HOUR })),
      }),
    );
    expect(choice).toMatchObject({ kind: "unavailable", cause: "cooldown" });
    expect(choice.kind === "unavailable" ? choice.tried.map((row) => row.model) : []).toEqual([
      SOL,
      SONNET,
      FLASH_HIGH,
    ]);
  });
});

describe("quota.reservePercent", () => {
  it("keeps the last share of a window away, also when the thresholds would allow it", () => {
    const policy = { ...DEFAULT_QUOTA_POLICY, switchAtPercent5h: 100, reservePercent: 10 };
    const sample = (pct: number) => ({
      available: true as const,
      window5hUsedPct: pct,
      window5hResetsAt: NOW + HOUR,
      weeklyUsedPct: null,
      weeklyResetsAt: null,
    });
    expect(evaluateQuota(sample(90), false, policy).ok).toBe(true);
    expect(evaluateQuota(sample(91), false, policy)).toMatchObject({
      ok: false,
      cause: "window_5h",
    });
  });
});

describe("the vendor warning", () => {
  it("warns of a role that reaches one vendor among the connected models, whichever it is", () => {
    const roles = { a: { models: ["*sonnet*", "*opus*"], enabled: true } };
    expect(roleVendorWarnings(roles, ["x/claude-sonnet-4-6"])).toEqual([
      { role: "a", vendor: "anthropic", models: ["x/claude-sonnet-4-6"] },
    ]);
    const flash = { b: { models: ["*flash*"], enabled: true } };
    expect(roleVendorWarnings(flash, ["x/gemini-3-flash"])[0]?.vendor).toBe("google");
    const custom = { c: { models: ["*acme*"], enabled: true } };
    expect(roleVendorWarnings(custom, ["x/acme-large"])[0]?.vendor).toBe("acme");
  });

  it("stays quiet with two vendors, no connected model, or a role that is off", () => {
    const roles = { a: { models: ["*sonnet*", "*sol*"], enabled: true } };
    expect(roleVendorWarnings(roles, ["x/claude-sonnet-4-6", "y/gpt-6.1-sol"])).toEqual([]);
    expect(roleVendorWarnings(roles, [])).toEqual([]);
    expect(
      roleVendorWarnings({ a: { models: ["*sonnet*"], enabled: false } }, ["x/claude-sonnet-4-6"]),
    ).toEqual([]);
  });
});
