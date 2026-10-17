import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RuntimeLeaseSummary } from "@haril/core/ports";

// Text helpers shared by the panels. They build plain strings; the app applies colors and width.

const SUMMARY_LIMIT = 160;

// fit and wrap are the render boundary (LD-T5): every line of the frame passes through one of them, and only then
// does the theme color it. Text from the store, an agent or the CLI may hold escape sequences that would clear the
// screen, move the cursor, set the title or the clipboard, or hide text, and invisible code points that draw nothing
// or reorder the text around them (LD-T6c), so both show it as visibleText first.

// An emoji presentation selector (U+FE0E, U+FE0F) that follows no emoji. After one, as in a red heart or a keycap, it
// is part of what is drawn.
const LOOSE_SELECTOR = /(?<!\p{Emoji})[\u{FE0E}\u{FE0F}]/gu;
// Every other invisible code point: a format character (zero-width spaces, bidirectional overrides, tag characters...)
// or another default-ignorable one (the other variation selectors, the Hangul fillers, unassigned specials...), and a
// lone surrogate. The joiner is left to LOOSE_JOINER.
const INVISIBLE =
  /(?![\u{200D}\u{FE0E}\u{FE0F}])[\p{Cf}\p{Default_Ignorable_Code_Point}]|[\u{D800}-\u{DFFF}]/gu;
// A zero-width joiner that joins nothing: one not right after a pictograph, U+FE0F, a skin tone or a combining mark
// (the virama of an Indic half-form). A joiner after a joiner is one of them, so a run keeps at most its first.
const LOOSE_JOINER =
  /(?<!\p{Extended_Pictographic}|\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]|\p{Mn})\u{200D}/gu;

// Text as the screen shows it: each control character (C0 with ESC and CR, DEL, C1) and each invisible code point
// above becomes "?", and a tab a space. Such a code point draws nothing or reorders the text around it, so without this
// a plan could carry words its approver never sees (LD-T6c). It keeps what emoji sequences and scripts need: the
// presentation selector right after an emoji, the joiner where it joins, and the combining marks (accents, nikud,
// viramas), which draw. One "?" per code point: a tag character is two UTF-16 units and no cell, its "?" one unit and
// one cell, so text is measured or padded only once it is shown this way (pad does it itself). Exported for the text
// laid out before it is cut (the frame's facts, LD-T6b-1) and for what the user sends (LD-T6b-2).
export function visibleText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === "\t") out += " ";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += "?";
    else out += char;
  }
  // The joiners are judged last, on the text with every other invisible code point already shown as "?".
  return out.replace(LOOSE_SELECTOR, "?").replace(INVISIBLE, "?").replace(LOOSE_JOINER, "?");
}

// Cuts text to `columns` cells, marking the cut with an ellipsis. A line break is a control character here. The cut
// is strict: a wide character that would straddle it is left out and a space takes its cell, so the result is never
// wider than `columns` (pi-tui fails on a line wider than the terminal).
export function fit(text: string, columns: number): string {
  if (columns <= 0) return "";
  const clean = visibleText(text);
  if (visibleWidth(clean) <= columns) return clean;
  const kept = sliceByColumn(clean, 0, columns - 1, true);
  return `${kept}…${" ".repeat(Math.max(0, columns - 1 - visibleWidth(kept)))}`;
}

// Word-wraps text to `columns` cells; a line break (LF or CRLF) starts a new line and an empty text is one empty
// line.
export function wrap(text: string, columns: number): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(visibleText(line), Math.max(1, columns)),
    );
}

// A token count in at most five characters: 999, 18.3k, 120k, 2.5M.
export function compactCount(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] = count < 999_950 ? [count / 1000, "k"] : [count / 1_000_000, "M"];
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text}${unit}`;
}

// A table column of exactly `width` cells: the text as the screen shows it, padded with spaces, or cut so one space
// still ends the column. It counts cells, not UTF-16 units, so a format character, a wide character or an emoji
// sequence in a row from the store never moves the columns after it (LD-T6c).
export function pad(text: string, width: number): string {
  const shown = visibleText(text);
  const kept = visibleWidth(shown) < width ? shown : sliceByColumn(shown, 0, width - 1, true);
  return `${kept}${" ".repeat(Math.max(0, width - visibleWidth(kept)))}`;
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
