import { describe, expect, it } from "vitest";
import {
  compactAtFor,
  DELEGATION_FIELDS,
  DELEGATION_LAYERS,
  delegationSectionErrors,
  delegationValueProblem,
  resolveDelegationSettings,
} from "../src/delegation-config.js";

// The field table of haril.json's delegation section (phase F7): every default fits its own field, the defaults form a
// valid section, and a layer's compaction threshold falls back to the general one.

describe("the delegation field table", () => {
  it("has one entry per path, and every default fits its own field", () => {
    const paths = DELEGATION_FIELDS.map((field) => field.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const field of DELEGATION_FIELDS) {
      expect([field.path, delegationValueProblem(field, field.default)]).toEqual([
        field.path,
        null,
      ]);
    }
  });

  it("resolves to settings that are themselves a valid section", () => {
    const settings = resolveDelegationSettings(undefined);
    expect(delegationSectionErrors(settings)).toEqual([]);
  });

  it("gives each layer its own compaction threshold, else the general one", () => {
    const settings = resolveDelegationSettings({
      context: { compactAtTokens: 200_000, perLayer: { orchestrator: 400_000, executor: null } },
    });
    expect(DELEGATION_LAYERS.map((layer) => compactAtFor(settings, layer))).toEqual([
      400_000, 200_000, 200_000, 200_000,
    ]);
  });
});
