import type { AcceptanceCheck } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import { completionFor, evaluateAcceptance, type FileReader } from "../src/index.js";

// Host verification (criterion 8, M3-D7). The Core evaluates checks through an injected reader and never
// touches the file system itself.

const FILES: Readonly<Record<string, string>> = {
  "docs/notes.md": "SECRET-BODY the reader must not leak\nexport const ok = true;",
};

const reader: FileReader = (path) => {
  if (path === "outside.txt") return { ok: false, reason: "outside_root" };
  const content = FILES[path];
  return content === undefined ? { ok: false, reason: "missing" } : { ok: true, content };
};

function evaluate(checks: readonly AcceptanceCheck[], outputText = "all done") {
  return evaluateAcceptance(checks, { readFile: reader, outputText });
}

describe("evaluateAcceptance", () => {
  it("reports unverified with no checks", () => {
    expect(evaluate([])).toEqual({ verified: false, checks: [] });
  });

  it("reports verified when every check passes", () => {
    const result = evaluate([
      { kind: "file_exists", path: "docs/notes.md" },
      { kind: "file_contains", path: "docs/notes.md", text: "export const ok" },
      { kind: "output_contains", text: "done" },
    ]);
    expect(result.verified).toBe(true);
    expect(result.checks.map((check) => check.ok)).toEqual([true, true, true]);
    expect(result.checks.map((check) => check.kind)).toEqual([
      "file_exists",
      "file_contains",
      "output_contains",
    ]);
  });

  it("fails a file_exists check on a missing file and keeps the reason", () => {
    const result = evaluate([{ kind: "file_exists", path: "absent.md" }]);
    expect(result.verified).toBe(false);
    expect(result.checks[0]).toEqual({ kind: "file_exists", ok: false, detail: "missing" });
  });

  it("fails a check the reader denied, with the denial reason", () => {
    const result = evaluate([{ kind: "file_exists", path: "outside.txt" }]);
    expect(result.checks[0]).toEqual({ kind: "file_exists", ok: false, detail: "outside_root" });
  });

  it("fails file_contains when the text is absent", () => {
    const result = evaluate([{ kind: "file_contains", path: "docs/notes.md", text: "nope" }]);
    expect(result.verified).toBe(false);
    expect(result.checks[0]?.ok).toBe(false);
  });

  it("fails output_contains when the output lacks the text", () => {
    const result = evaluate([{ kind: "output_contains", text: "never said" }], "hello");
    expect(result.verified).toBe(false);
    expect(result.checks[0]).toEqual({
      kind: "output_contains",
      ok: false,
      detail: "output does not contain text",
    });
  });

  it("never copies file content into the evidence", () => {
    const result = evaluate([{ kind: "file_contains", path: "docs/notes.md", text: "missing" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET-BODY");
  });

  it("does not count M1 verifier references as evaluated checks", () => {
    const result = evaluate([
      { blockId: "markdown", checkId: "lint" } as unknown as AcceptanceCheck,
    ]);
    expect(result).toEqual({ verified: false, checks: [] });
  });
});

describe("completionFor with a verification", () => {
  const succeeded = { status: "succeeded" as const, summary: "all done" };

  it("keeps the result unchanged when no verification is given (M1 callers)", () => {
    expect(completionFor("run-1", succeeded)).toEqual({
      runId: "run-1",
      outcome: "succeeded",
      result: { summary: "all done" },
    });
  });

  it("stores the verification in the result of a passing run", () => {
    const verification = evaluate([{ kind: "output_contains", text: "done" }]);
    const completion = completionFor("run-1", succeeded, verification);
    expect(completion.outcome).toBe("succeeded");
    if (completion.outcome === "succeeded") {
      expect(completion.result.verification).toEqual(verification);
      expect(completion.result.summary).toBe("all done");
    }
  });

  it("turns a failed check into a verification_failed attempt that keeps the evidence", () => {
    const verification = evaluate([{ kind: "output_contains", text: "never said" }]);
    const completion = completionFor("run-1", succeeded, verification);
    expect(completion.outcome).toBe("failed");
    if (completion.outcome === "failed") {
      expect(completion.error.code).toBe("verification_failed");
      expect(completion.endCause).toBe("exit");
      expect(completion.verification).toEqual(verification);
    }
  });

  it("records an unverified success as verified false", () => {
    const completion = completionFor("run-1", succeeded, evaluate([]));
    expect(completion.outcome).toBe("succeeded");
    if (completion.outcome === "succeeded") {
      expect(completion.result.verification).toEqual({ verified: false, checks: [] });
    }
  });
});
