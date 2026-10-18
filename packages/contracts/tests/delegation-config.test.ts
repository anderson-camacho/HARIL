import { describe, expect, it } from "vitest";
import {
  compactAtFor,
  DEFAULT_COMMAND_ALLOW,
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

  it("gives haril_run a default allow list, time limit and output cap, and checks each one", () => {
    const settings = resolveDelegationSettings(undefined);
    expect(settings.commands).toEqual({
      allow: DEFAULT_COMMAND_ALLOW,
      timeoutMs: 300_000,
      outputMaxBytes: 16_384,
    });
    expect(DEFAULT_COMMAND_ALLOW).toEqual(
      expect.arrayContaining(["npm test", "pnpm test", "npm run build", "node --test"]),
    );
    expect(delegationSectionErrors({ commands: { timeoutMs: 10, outputMaxBytes: 10 } })).toEqual([
      "/delegation/commands/timeoutMs: must be a whole number from 1000 to 86400000",
      "/delegation/commands/outputMaxBytes: must be a whole number from 1024 to 1048576",
    ]);
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
