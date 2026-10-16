import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { AcceptanceCheckSchema, AcceptanceSchema, validateAcceptance } from "../src/index.js";

// Acceptance checks (criterion 8, M3-D7): the host evaluates them after the agent settles.
describe("AcceptanceCheckSchema", () => {
  it.each([
    { kind: "file_exists", path: "docs/notes.md" },
    { kind: "file_contains", path: "src/index.ts", text: "export" },
    { kind: "output_contains", text: "done" },
  ])("accepts the check %j", (check) => {
    expect(Value.Check(AcceptanceCheckSchema, check)).toBe(true);
  });

  it.each([
    { kind: "command", command: "npm test" },
    { kind: "file_exists" },
    { kind: "file_exists", path: "" },
    { kind: "file_contains", path: "a.md" },
    { kind: "file_contains", path: "a.md", text: "" },
    { kind: "output_contains", text: "" },
    { kind: "output_contains", text: "x", extra: true },
  ])("rejects the check %j", (check) => {
    expect(Value.Check(AcceptanceCheckSchema, check)).toBe(false);
  });

  it("keeps accepting the M1 verifier reference shape so stored plans stay valid", () => {
    expect(Value.Check(AcceptanceSchema, [{ blockId: "markdown", checkId: "lint" }])).toBe(true);
  });
});

describe("validateAcceptance", () => {
  it("returns the list when every entry is valid", () => {
    const result = validateAcceptance([{ kind: "output_contains", text: "ok" }]);
    expect(result.ok).toBe(true);
  });

  it("reports the entries that are invalid", () => {
    const result = validateAcceptance([{ kind: "output_contains", text: "" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
});
