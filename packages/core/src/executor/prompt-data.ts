// The data sections of a prompt (MC-T1, MC-T2): text another agent wrote, which a prompt carries as data, not as
// instructions (ARCH 9.10). Every text is shown as the terminal would draw it, so an escape sequence, a bidirectional
// override or a tag character cannot carry hidden words to the next agent; every line an agent wrote starts with "| ",
// and no line a section writes itself does, so agent text cannot forge the end of a section, a header, a note or an
// instruction after it. The sections share one budget in the bytes the Broker counts. Pure.
import { visibleText } from "../domain/visible-text.js";
import type { JsonObject } from "../ports/index.js";

// The budget without a token ceiling, in the bytes the Broker counts.
export const PROMPT_DATA_MAX_BYTES = 24000;

// The Broker estimates ceil(bytes / 3) tokens for the whole serialized request on every call and charges them to the
// task's tokens (gateway broker/estimate.ts), and Pi sends the prompt again on every turn. The data sections together
// may cost an eighth of the task's tokens per call, so a read-then-answer run of two or three calls spends at most about
// three eighths of its tokens on them. The docs set the ContextPack budget in tokens without a value (AGENTS.md 6.2).
const BROKER_BYTES_PER_TOKEN = 3;
const TOKEN_SHARE_PER_CALL = 8;

export const LINE_PREFIX = "| ";
// Agent text keeps its line breaks, the Unicode line and paragraph separators among them (visibleText shows the rest).
const LINE_BREAK = /\r?\n|\u{2028}|\u{2029}/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// The budget of the data sections, in the bytes the Broker counts: an eighth of the task's tokens at 3 bytes a token,
// at most PROMPT_DATA_MAX_BYTES, which is also the budget of a task without a token ceiling.
export function promptDataBudget(maxTokens: number | undefined): number {
  if (maxTokens === undefined || maxTokens <= 0) return PROMPT_DATA_MAX_BYTES;
  return Math.min(
    PROMPT_DATA_MAX_BYTES,
    BROKER_BYTES_PER_TOKEN * Math.floor(maxTokens / TOKEN_SHARE_PER_CALL),
  );
}

// The text an attempt answered with, as completionFor stores it: a real agent's text or a summary; undefined for a
// simulated run, which stores no text.
export function storedText(stored: JsonObject): string | undefined {
  if (typeof stored.text === "string") return stored.text;
  if (typeof stored.summary === "string") return stored.summary;
  if (stored.simulated === true) return undefined;
  return JSON.stringify(stored);
}

// Agent text as the lines of a data section: every line shown as the terminal draws it and prefixed, within `maxChars`
// characters (code points, a line break counting as one) and `room` bytes. A text that does not fit whole is cut between
// graphemes and followed by `cutNote(shown, total)`, inside the room. Undefined when not even a cut text fits.
export function prefixedText(
  text: string,
  maxChars: number,
  room: number,
  cutNote: (shown: number, total: number) => string,
): string[] | undefined {
  const lines = text.split(LINE_BREAK).map(visibleText);
  const total = lines.reduce((sum, line) => sum + codePoints(line), lines.length - 1);
  const whole = take(lines, maxChars, room);
  if (whole.chars === total) return prefixed(whole.lines);
  const cut = take(lines, maxChars, room - linesCost([cutNote(total, total)]));
  if (cut.chars === 0) return undefined;
  return [...prefixed(cut.lines), cutNote(cut.chars, total)];
}

// One line of text a section writes itself (a goal, an expected text): shown as the terminal draws it, so its line
// breaks show as "?", and cut between graphemes at `maxChars` code points.
export function visibleLine(
  text: string,
  maxChars: number,
): { readonly text: string; readonly cut: boolean } {
  const visible = visibleText(text);
  const shown = take([visible], maxChars, Number.POSITIVE_INFINITY);
  return { text: shown.lines[0] ?? "", cut: shown.chars < codePoints(visible) };
}

// What the Broker counts for some lines of the prompt: their bytes as JSON string content and the escaped line feed
// after each.
export function linesCost(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + lineCost(line), 0);
}

function prefixed(lines: readonly string[]): string[] {
  return lines.map((line) => `${LINE_PREFIX}${line}`);
}

// The longest start of `lines` within `maxChars` characters (a line break counts as one) and, once prefixed, within
// `maxBytes` of request bytes. It stops between graphemes, so an emoji sequence or a letter with its marks is never
// split.
function take(
  lines: readonly string[],
  maxChars: number,
  maxBytes: number,
): { readonly lines: string[]; readonly chars: number } {
  const out: string[] = [];
  let chars = 0;
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    const breakChars = index === 0 ? 0 : 1;
    const lineBytes = lineCost(LINE_PREFIX);
    if (chars + breakChars > maxChars || bytes + lineBytes > maxBytes) break;
    chars += breakChars;
    bytes += lineBytes;
    let shown = "";
    let complete = true;
    for (const { segment } of graphemes.segment(line)) {
      const segmentChars = codePoints(segment);
      const segmentBytes = jsonBytes(segment);
      if (chars + segmentChars > maxChars || bytes + segmentBytes > maxBytes) {
        complete = false;
        break;
      }
      chars += segmentChars;
      bytes += segmentBytes;
      shown += segment;
    }
    out.push(shown);
    if (!complete) break;
  }
  return { lines: out, chars };
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function lineCost(line: string): number {
  return jsonBytes(line) + 2;
}

// The UTF-8 bytes of a text as JSON string content. The text has been through visibleText, so the only characters
// JSON escapes in it are the quotation mark and the backslash.
function jsonBytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === "\\") bytes += 2;
    else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
