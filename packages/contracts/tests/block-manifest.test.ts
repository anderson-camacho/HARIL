import { describe, expect, it } from "vitest";
import { validateBlockManifest, validateMethodologyPayload } from "../src/index.js";

// BlockManifest v1 (ADR-0014 D1): the 12 PROMPT sec4 fields plus provides and replaces.
const tddManifest = {
  id: "haril.methodology.tdd",
  version: "0.1.0",
  category: "methodology",
  capabilities: [],
  dependencies: [{ kind: "block", id: "haril.agent.developer", range: "^0.1.0" }],
  permissions: [],
  config: {
    schema: { type: "object", additionalProperties: false, properties: {} },
    defaults: {},
    payload: {
      roles: [{ id: "implementer", agent: "haril.agent.developer" }],
      gates: [{ id: "authorize-writes", kind: "approval_before", action: "write" }],
      sections: [
        { id: "red-green-refactor", roles: ["implementer"], kinds: ["work"], mandatory: true },
      ],
    },
  },
  inputs: [],
  outputs: [],
  events: [],
  errorPolicy: { failClosed: true },
  compatibility: { contracts: "^0.1.0", core: "^0.1.0" },
  provides: ["methodology"],
  replaces: [],
};

const TWELVE_REQUIRED = [
  "id",
  "version",
  "category",
  "capabilities",
  "dependencies",
  "permissions",
  "config",
  "inputs",
  "outputs",
  "events",
  "errorPolicy",
  "compatibility",
] as const;

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}

describe("validateBlockManifest", () => {
  it("accepts a complete methodology manifest", () => {
    const result = validateBlockManifest(tddManifest);
    expect(result.ok).toBe(true);
  });

  it("accepts a manifest without the optional provides and replaces", () => {
    const { provides: _provides, replaces: _replaces, ...bare } = tddManifest;
    expect(validateBlockManifest(bare).ok).toBe(true);
  });

  it.each(TWELVE_REQUIRED)("rejects a manifest without the required field %s", (field) => {
    const result = validateBlockManifest(without(tddManifest, field));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown top-level key (no fifteenth field)", () => {
    const result = validateBlockManifest({ ...tddManifest, schemaVersion: 1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a numeric version, which would read 1.10 as 1.1", () => {
    const result = validateBlockManifest({ ...tddManifest, version: 1.1 });
    expect(result.ok).toBe(false);
  });

  it("rejects a category outside the ten closed values", () => {
    const result = validateBlockManifest({ ...tddManifest, category: "scrum" });
    expect(result.ok).toBe(false);
  });

  it("rejects an errorPolicy without failClosed", () => {
    const result = validateBlockManifest({ ...tddManifest, errorPolicy: { retries: 1 } });
    expect(result.ok).toBe(false);
  });

  it("returns readable error paths when rejecting", () => {
    const result = validateBlockManifest({ ...tddManifest, version: 1.1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("/version");
  });
});

describe("validateMethodologyPayload", () => {
  const payload = tddManifest.config.payload;

  it("accepts the roles, gates and sections of a methodology", () => {
    expect(validateMethodologyPayload(payload).ok).toBe(true);
  });

  it("rejects a gate kind outside the closed vocabulary", () => {
    const bad = { ...payload, gates: [{ id: "g", kind: "always_allow" }] };
    expect(validateMethodologyPayload(bad).ok).toBe(false);
  });

  it("rejects a gate with an unknown extra key", () => {
    const bad = {
      ...payload,
      gates: [{ id: "g", kind: "approval_before", action: "write", grant: true }],
    };
    expect(validateMethodologyPayload(bad).ok).toBe(false);
  });

  it("rejects a task kind outside work, plan, verify and summarize", () => {
    const bad = {
      ...payload,
      sections: [{ id: "s", roles: [], kinds: ["executing"], mandatory: false }],
    };
    expect(validateMethodologyPayload(bad).ok).toBe(false);
  });
});
