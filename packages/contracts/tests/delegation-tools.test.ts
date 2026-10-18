import { describe, expect, it } from "vitest";
import {
  DELEGATION_TOOL_NAMES,
  DIFFICULTIES,
  isDelegationToolName,
  isStop,
  MEMO_MAX_LENGTH,
  validateDelegationToolInput,
} from "../src/index.js";

// Tool contracts of the delegation (docs/modos-y-delegacion.md 3.5). Each test builds a valid input and varies only
// the field it exercises.

const delegation = {
  localId: "buttons",
  goal: "Restyle the primary button",
  description: "Color and states of the primary button",
  difficulty: "medium",
  difficultyReason: "Two files and their tests",
  dependsOn: [],
  priority: 5,
  acceptanceCriteria: ["The button uses the new color"],
  model: null,
  budget: { maxTokens: 40000 },
};

const delegateInput = {
  schemaVersion: 1,
  memo: "Split by surface: styles first, tests second.",
  delegations: [delegation],
};

const assignment = {
  localId: "theme",
  goal: "Add tintColor() to theme.ts",
  instructions: "Create the function next to the palette and export it",
  files: { write: ["src/theme.ts"], read: ["src/palette.ts"] },
  tests: "Add a unit test for tintColor in tests/theme.test.ts",
  acceptanceCriteria: ["tintColor returns the tinted color"],
  difficulty: "easy",
  difficultyReason: "One function",
  dependsOn: [],
  model: "Gemini1/gemini-3-flash",
  budget: { maxTokens: 20000 },
};

const assignInput = { schemaVersion: 1, memo: "", assignments: [assignment] };

function errorsOf(result: { ok: boolean; errors?: string[] }): string[] {
  return result.ok ? [] : (result.errors ?? []);
}

describe("delegation tool names", () => {
  it("lists the eight tools of the spec in a fixed order", () => {
    expect(DELEGATION_TOOL_NAMES).toEqual([
      "haril_delegate",
      "haril_assign",
      "haril_report",
      "haril_verdict",
      "haril_request_audit",
      "haril_abort",
      "haril_run",
      "haril_merge",
    ]);
  });

  it("recognizes only those names", () => {
    expect(isDelegationToolName("haril_assign")).toBe(true);
    expect(isDelegationToolName("haril_propose_plan")).toBe(false);
    expect(isDelegationToolName("")).toBe(false);
  });

  it("orders the five difficulty classes from easiest to hardest", () => {
    expect(DIFFICULTIES).toEqual(["trivial", "easy", "medium", "hard", "expert"]);
  });
});

describe("validateDelegationToolInput: haril_delegate", () => {
  it("returns the typed input when it is valid", () => {
    expect(validateDelegationToolInput("haril_delegate", delegateInput)).toEqual({
      ok: true,
      tool: "haril_delegate",
      input: delegateInput,
    });
  });

  it("accepts an omitted model and checkpoints that add or ask to remove stops", () => {
    const { model: _model, ...withoutModel } = delegation;
    const input = {
      ...delegateInput,
      delegations: [withoutModel],
      checkpoints: ["after_plan", "after_node:buttons", "on_budget_pct:75", { remove: "at_end" }],
    };
    expect(validateDelegationToolInput("haril_delegate", input).ok).toBe(true);
  });

  it("rejects a memo longer than the limit", () => {
    const input = { ...delegateInput, memo: "x".repeat(MEMO_MAX_LENGTH + 1) };
    const errors = errorsOf(validateDelegationToolInput("haril_delegate", input));
    expect(errors.some((error) => error.startsWith("/memo: "))).toBe(true);
  });

  it("accepts a memo exactly at the limit", () => {
    const input = { ...delegateInput, memo: "x".repeat(MEMO_MAX_LENGTH) };
    expect(validateDelegationToolInput("haril_delegate", input).ok).toBe(true);
  });

  it("rejects an empty delegation list", () => {
    expect(
      validateDelegationToolInput("haril_delegate", { ...delegateInput, delegations: [] }).ok,
    ).toBe(false);
  });

  it("rejects an unknown difficulty, a priority outside 0..9 and a zero budget", () => {
    const cases = [
      { difficulty: "impossible" },
      { priority: 10 },
      { priority: -1 },
      { budget: { maxTokens: 0 } },
    ];
    for (const change of cases) {
      const input = { ...delegateInput, delegations: [{ ...delegation, ...change }] };
      expect(validateDelegationToolInput("haril_delegate", input).ok).toBe(false);
    }
  });

  it("rejects a delegation without acceptance criteria", () => {
    const input = { ...delegateInput, delegations: [{ ...delegation, acceptanceCriteria: [] }] };
    const errors = errorsOf(validateDelegationToolInput("haril_delegate", input));
    expect(errors.some((error) => error.startsWith("/delegations/0/acceptanceCriteria"))).toBe(
      true,
    );
  });

  it("rejects a local id with characters outside the plan pattern", () => {
    const input = { ...delegateInput, delegations: [{ ...delegation, localId: "a b" }] };
    expect(validateDelegationToolInput("haril_delegate", input).ok).toBe(false);
  });

  it("rejects an unknown key and a checkpoint outside the closed vocabulary", () => {
    expect(validateDelegationToolInput("haril_delegate", { ...delegateInput, extra: 1 }).ok).toBe(
      false,
    );
    for (const checkpoint of [
      "after_lunch",
      "on_budget_pct:0",
      "on_budget_pct:101",
      "after_node:",
    ]) {
      const input = { ...delegateInput, checkpoints: [checkpoint] };
      expect(validateDelegationToolInput("haril_delegate", input).ok).toBe(false);
    }
  });

  it("rejects a schema version other than 1", () => {
    expect(
      validateDelegationToolInput("haril_delegate", { ...delegateInput, schemaVersion: 2 }).ok,
    ).toBe(false);
  });
});

describe("validateDelegationToolInput: haril_assign", () => {
  it("returns the typed input when it is valid", () => {
    expect(validateDelegationToolInput("haril_assign", assignInput)).toEqual({
      ok: true,
      tool: "haril_assign",
      input: assignInput,
    });
  });

  it("requires the write and read surfaces, the tests and the instructions", () => {
    const { files: _files, ...withoutFiles } = assignment;
    const { tests: _tests, ...withoutTests } = assignment;
    for (const broken of [
      withoutFiles,
      withoutTests,
      { ...assignment, instructions: "" },
      { ...assignment, files: { write: [""], read: [] } },
    ]) {
      const input = { ...assignInput, assignments: [broken] };
      expect(validateDelegationToolInput("haril_assign", input).ok).toBe(false);
    }
  });

  it("accepts an empty write surface for a read-only executor", () => {
    const input = {
      ...assignInput,
      assignments: [{ ...assignment, files: { write: [], read: ["src/**"] } }],
    };
    expect(validateDelegationToolInput("haril_assign", input).ok).toBe(true);
  });
});

describe("validateDelegationToolInput: the other tools", () => {
  it("accepts a report with each status and rejects another status", () => {
    for (const status of ["done", "partial", "failed"]) {
      const input = { status, summary: "Integrated three executors", issues: [] };
      expect(validateDelegationToolInput("haril_report", input).ok).toBe(true);
    }
    const bad = { status: "maybe", summary: "x", issues: [] };
    expect(validateDelegationToolInput("haril_report", bad).ok).toBe(false);
  });

  it("accepts a verdict with reasons that cite their criterion", () => {
    const input = {
      approved: false,
      reasons: [{ criterion: "The button uses the new color", ok: false, evidence: "Still blue" }],
    };
    expect(validateDelegationToolInput("haril_verdict", input).ok).toBe(true);
  });

  it("rejects a verdict reason without its criterion", () => {
    const input = { approved: false, reasons: [{ ok: false, evidence: "Still blue" }] };
    expect(validateDelegationToolInput("haril_verdict", input).ok).toBe(false);
  });

  it("accepts a final audit request and an abort with a reason", () => {
    expect(
      validateDelegationToolInput("haril_request_audit", { summary: "All done", outstanding: [] })
        .ok,
    ).toBe(true);
    expect(
      validateDelegationToolInput("haril_abort", { reason: "The goal is impossible" }).ok,
    ).toBe(true);
    expect(validateDelegationToolInput("haril_abort", { reason: "" }).ok).toBe(false);
  });

  it("accepts a run with a command and optional arguments", () => {
    expect(validateDelegationToolInput("haril_run", { command: "pnpm" }).ok).toBe(true);
    expect(validateDelegationToolInput("haril_run", { command: "pnpm", args: ["test"] }).ok).toBe(
      true,
    );
    expect(validateDelegationToolInput("haril_run", { command: "" }).ok).toBe(false);
  });

  it("accepts a merge of one task id and rejects a short id", () => {
    expect(
      validateDelegationToolInput("haril_merge", { taskId: "01JABCDEFGHJKMNPQRSTVWXYZ0" }).ok,
    ).toBe(true);
    expect(validateDelegationToolInput("haril_merge", { taskId: "t1" }).ok).toBe(false);
  });

  it("refuses an unknown tool name at run time instead of throwing", () => {
    const result = validateDelegationToolInput("haril_teleport" as "haril_abort", { reason: "x" });
    expect(result.ok).toBe(false);
    expect(errorsOf(result)[0]).toContain("unknown tool");
  });

  it("reports a value that is not an object", () => {
    expect(validateDelegationToolInput("haril_abort", null).ok).toBe(false);
  });
});

describe("isStop", () => {
  it("accepts the closed stop vocabulary", () => {
    for (const stop of [
      "after_plan",
      "after_node:d1",
      "before_merge",
      "on_audit_failure",
      "on_budget_pct:1",
      "on_budget_pct:100",
      "at_end",
    ]) {
      expect(isStop(stop)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const stop of ["", "after_node:", "on_budget_pct:0", "on_budget_pct:07", "AT_END", 3]) {
      expect(isStop(stop)).toBe(false);
    }
  });
});
