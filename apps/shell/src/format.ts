import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RuntimeLeaseSummary } from "@haril/core/ports";

// Text helpers shared by the panels. They build plain strings; the app applies colors and width.

const SUMMARY_LIMIT = 160;

// fit and wrap are the render boundary (LD-T5): every line of the frame passes through one of them, and only then
// does the theme color it. Text from the store, an agent or the CLI may hold escape sequences that would clear the
// screen, move the cursor, set the title or the clipboard, or hide text, so both make it plain first.

// Each control character (C0 with ESC and CR, DEL, C1) becomes "?", and a tab a space. One for one, so the lengths
// the panels padded with stay the same.
function plain(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "\t") out += " ";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += "?";
    else out += char;
  }
  return out;
}

// Cuts text to `columns` cells, marking the cut with an ellipsis. A line break is a control character here.
export function fit(text: string, columns: number): string {
  const clean = plain(text);
  if (visibleWidth(clean) <= columns) return clean;
  return `${sliceByColumn(clean, 0, Math.max(0, columns - 1))}…`;
}

// Word-wraps text to `columns` cells; a line break (LF or CRLF) starts a new line and an empty text is one empty
// line.
export function wrap(text: string, columns: number): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(plain(line), Math.max(1, columns))));
}

// A token count in at most five characters: 999, 18.3k, 120k, 2.5M.
export function compactCount(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] = count < 999_950 ? [count / 1000, "k"] : [count / 1_000_000, "M"];
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text}${unit}`;
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
