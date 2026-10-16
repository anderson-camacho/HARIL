// Host verification of acceptance checks (criterion 8, M3-D7). Pure: the file reader is injected by the host,
// which routes every read through the PathGuard. Evidence never carries file content or the expected text.
import { type Acceptance, type AcceptanceCheck, validateAcceptance } from "@haril/contracts";
import type { AcceptanceRuleResult } from "../ports/index.js";

export type AcceptanceEntry = Acceptance[number];

// The store's rule for task.create (M3-D7): the schema decides, and the first problem becomes the reason.
export function checkAcceptance(value: unknown): AcceptanceRuleResult {
  const result = validateAcceptance(value);
  if (result.ok) return { ok: true, acceptance: result.acceptance };
  return { ok: false, reason: `acceptance is invalid: ${result.errors[0] ?? "unknown entry"}` };
}

// A read either yields the content or a short reason: "missing", or a PathGuard denial such as "outside_root".
export type FileRead =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: string };

export type FileReader = (relativePath: string) => FileRead;

export interface VerificationInput {
  readonly readFile: FileReader;
  // The final text of the agent: the summary of its settled outcome.
  readonly outputText: string;
}

export interface CheckOutcome {
  readonly kind: AcceptanceCheck["kind"];
  readonly ok: boolean;
  readonly detail: string;
}

// `verified` is true only when at least one check ran and every check passed. A task without checks is
// completed but unverified (M3-D7).
export type Verification = {
  readonly verified: boolean;
  readonly checks: readonly CheckOutcome[];
};

export function evaluateAcceptance(
  acceptance: readonly AcceptanceEntry[],
  input: VerificationInput,
): Verification {
  const checks: CheckOutcome[] = [];
  for (const entry of acceptance) {
    // M1 verifier references are not evaluated in M3 and do not count as checks.
    if (isCheck(entry)) checks.push(evaluateCheck(entry, input));
  }
  return { verified: checks.length > 0 && checks.every((check) => check.ok), checks };
}

// The message of a failed attempt names the failing checks and their reasons, never their content.
export function verificationFailureMessage(verification: Verification): string {
  const failing = verification.checks.filter((check) => !check.ok);
  const names = failing.map((check) => `${check.kind} (${check.detail})`);
  return `verification failed: ${names.join(", ")}`;
}

export function hasFailedCheck(verification: Verification): boolean {
  return verification.checks.some((check) => !check.ok);
}

function isCheck(entry: AcceptanceEntry): entry is AcceptanceCheck {
  return "kind" in entry;
}

function evaluateCheck(check: AcceptanceCheck, input: VerificationInput): CheckOutcome {
  switch (check.kind) {
    case "file_exists": {
      const read = input.readFile(check.path);
      return read.ok
        ? { kind: check.kind, ok: true, detail: "file exists" }
        : { kind: check.kind, ok: false, detail: read.reason };
    }
    case "file_contains": {
      const read = input.readFile(check.path);
      if (!read.ok) return { kind: check.kind, ok: false, detail: read.reason };
      const found = read.content.includes(check.text);
      return {
        kind: check.kind,
        ok: found,
        detail: found ? "text found" : "text not found",
      };
    }
    case "output_contains": {
      const found = input.outputText.includes(check.text);
      return {
        kind: check.kind,
        ok: found,
        detail: found ? "output contains text" : "output does not contain text",
      };
    }
  }
}
