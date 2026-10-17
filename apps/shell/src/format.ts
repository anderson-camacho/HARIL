import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RuntimeLeaseSummary } from "@haril/core/ports";

// Text helpers shared by the panels. They build plain strings; the app applies colors and width.

const SUMMARY_LIMIT = 160;

// Cuts plain text to `columns` cells, marking the cut with an ellipsis.
export function fit(text: string, columns: number): string {
  if (visibleWidth(text) <= columns) return text;
  return `${sliceByColumn(text, 0, Math.max(0, columns - 1))}…`;
}

// Word-wraps plain text to `columns` cells; an empty text is one empty line.
export function wrap(text: string, columns: number): string[] {
  return text === "" ? [""] : wrapTextWithAnsi(text, Math.max(1, columns));
}

export function pad(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width);
}

export function time(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

// running: a lease that is active and not yet expired at `now`; idle otherwise.
export function runtimeState(lease: RuntimeLeaseSummary, now: number): "running" | "idle" {
  return lease.status === "active" && lease.expiresAt > now ? "running" : "idle";
}

// The reply of a real run, or the summary of a simulated one; "none" when the task has no result yet.
export function resultText(result: Readonly<Record<string, unknown>> | null): string {
  if (result === null) return "none";
  if (typeof result.text === "string") return result.text;
  if (typeof result.summary === "string") return result.summary;
  if (result.simulated === true) return "simulated (no real agent)";
  return JSON.stringify(result);
}

interface VerificationCheck {
  readonly kind: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Verification {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
}

// The host verification of the settled attempt: the result of a completed task, the evidence of a failed one.
export function verificationLines(
  result: Readonly<Record<string, unknown>> | null,
  error: { readonly verification?: unknown } | null,
): string[] {
  const candidate = result?.verification ?? error?.verification;
  if (candidate === undefined || candidate === null) return [];
  const verification = candidate as Verification;
  const state = verification.verified
    ? "verified"
    : verification.checks.length === 0
      ? "unverified (no acceptance checks)"
      : "not verified";
  return [
    `verification: ${state}`,
    ...verification.checks.map(
      (check) => `  ${check.ok ? "ok" : "failed"} ${check.kind}: ${check.detail}`,
    ),
  ];
}

// The payload of an event as key=value pairs, cut to one short line.
export function payloadSummary(payload: Readonly<Record<string, unknown>>): string {
  const pairs = Object.entries(payload).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
  const text = pairs.length === 0 ? "-" : pairs.join(" ");
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 3)}...` : text;
}
