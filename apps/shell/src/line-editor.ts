import { decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { visibleText } from "./format.js";

// The line editor of the input box (LD-T6b-2): one line of text and a cursor. pi-tui's Input draws its own line with
// escape sequences (a reverse-video cursor and the hardware cursor marker) and keeps pasted control characters in its
// value, so it cannot go through fit like every other text of the frame; this editor keeps only visible text instead.
// Each control character, invisible code point or lone surrogate becomes "?" (format.ts visibleText) and a paste's
// line breaks become spaces, so the box shows exactly what Enter sends. The app colors the view and draws the cursor.

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LONE_SURROGATE = /[\u{D800}-\u{DFFF}]/gu;
// The Private Use Area, where the Kitty protocol puts the keys that are not text (F13, Menu, the media keys).
const PRIVATE_USE = /^[\u{E000}-\u{F8FF}]$/u;

// What the box shows of the text: the graphemes before the cursor, the one under it (a space at the end) and the ones
// after it that still fit.
export interface EditorView {
  readonly before: string;
  readonly at: string;
  readonly after: string;
}

export class LineEditor {
  // The longest text the editor keeps, in UTF-16 units: a goal is one argument of a haril child process, and a
  // Windows command line holds about 32 000.
  static readonly MAX = 4000;
  private text = "";
  // A UTF-16 index at a grapheme boundary.
  private cursor = 0;
  // The start of a bracketed paste that has not ended yet.
  private paste: string | undefined;
  // pi-tui's input buffer hands a character beyond the BMP (an emoji) over as its two UTF-16 halves, one key each:
  // the high half waits here for the low one. Any other key drops it, so half a character never reaches the text.
  private high: string | undefined;

  get value(): string {
    return this.text;
  }

  clear(): void {
    this.text = "";
    this.cursor = 0;
  }

  // Replaces the text with `text`, made plain, and puts the cursor at its end.
  setValue(text: string): void {
    this.clear();
    this.insert(text);
  }

  // One key or one paste. Keys that are not the editor's (Enter, Tab, the arrows up and down, escape sequences) change
  // nothing.
  handleInput(input: string): void {
    const high = this.high;
    this.high = undefined;
    const data =
      high !== undefined && isLowSurrogate(input.charCodeAt(0)) ? `${high}${input}` : input;
    if (this.paste !== undefined || data.includes(PASTE_START)) {
      this.takePaste(data);
      return;
    }
    if (matchesKey(data, "backspace")) this.deleteBefore();
    else if (matchesKey(data, "delete")) this.deleteAfter();
    else if (matchesKey(data, "left")) this.cursor = this.previousBoundary(this.cursor);
    else if (matchesKey(data, "right")) this.cursor = this.nextBoundary(this.cursor);
    else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) this.cursor = 0;
    else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) this.cursor = this.text.length;
    else if (matchesKey(data, "ctrl+u")) this.cut(0, this.cursor);
    else if (matchesKey(data, "ctrl+k")) this.cut(this.cursor, this.text.length);
    else if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) this.deleteWord();
    else {
      const decoded = decodeKittyPrintable(data);
      if (decoded !== undefined) {
        if (!PRIVATE_USE.test(decoded)) this.insert(decoded);
      } else if (!hasControl(data)) {
        this.type(data);
      }
    }
  }

  // Typed text: a high surrogate at its end waits for its low half, and a lone half is dropped.
  private type(data: string): void {
    const last = data.charCodeAt(data.length - 1);
    const waits = last >= 0xd800 && last <= 0xdbff;
    if (waits) this.high = data.slice(-1);
    this.insert((waits ? data.slice(0, -1) : data).replace(LONE_SURROGATE, ""));
  }

  // The text around the cursor in at most `width` cells. While the text fits it shows from its start; once it does
  // not, the cursor stays at the right edge.
  view(width: number): EditorView {
    const graphemes = [...segmenter.segment(this.text)].map((part) => part.segment);
    let at = 0;
    for (let offset = 0; at < graphemes.length && offset < this.cursor; at++) {
      offset += graphemes[at]?.length ?? 0;
    }
    const cells = (grapheme: string | undefined): number =>
      grapheme === undefined ? 1 : visibleWidth(grapheme);
    let start = 0;
    let used = Math.max(1, cells(graphemes[at]));
    for (let index = 0; index < at; index++) used += cells(graphemes[index]);
    while (used > width && start < at) {
      used -= cells(graphemes[start]);
      start++;
    }
    let after = "";
    for (let index = at + 1; index < graphemes.length; index++) {
      const next = cells(graphemes[index]);
      if (used + next > width) break;
      after += graphemes[index];
      used += next;
    }
    return { before: graphemes.slice(start, at).join(""), at: graphemes[at] ?? " ", after };
  }

  private takePaste(data: string): void {
    const buffered = `${this.paste ?? ""}${data}`;
    const begin = buffered.indexOf(PASTE_START);
    const content = begin === -1 ? buffered : buffered.slice(begin + PASTE_START.length);
    const end = content.indexOf(PASTE_END);
    if (end === -1) {
      this.paste = `${PASTE_START}${content}`;
      return;
    }
    this.paste = undefined;
    this.insert(content.slice(0, end).replace(/\r\n|\r|\n/g, " "));
    const rest = content.slice(end + PASTE_END.length);
    if (rest !== "") this.handleInput(rest);
  }

  private insert(text: string): void {
    const room = LineEditor.MAX - this.text.length;
    if (room <= 0) return;
    const clean = cutAtBoundary(visibleText(text), room);
    this.text = `${this.text.slice(0, this.cursor)}${clean}${this.text.slice(this.cursor)}`;
    this.cursor += clean.length;
  }

  private deleteBefore(): void {
    this.cut(this.previousBoundary(this.cursor), this.cursor);
  }

  private deleteAfter(): void {
    this.cut(this.cursor, this.nextBoundary(this.cursor));
  }

  // The spaces before the cursor and the word before them.
  private deleteWord(): void {
    const before = this.text.slice(0, this.cursor);
    const kept = before.replace(/\S*\s*$/u, "");
    this.cut(kept.length, this.cursor);
  }

  private cut(from: number, to: number): void {
    if (to <= from) return;
    this.text = `${this.text.slice(0, from)}${this.text.slice(to)}`;
    this.cursor = from;
  }

  private previousBoundary(index: number): number {
    let last = 0;
    for (const part of segmenter.segment(this.text)) {
      if (part.index >= index) break;
      last = part.index;
    }
    return last;
  }

  private nextBoundary(index: number): number {
    for (const part of segmenter.segment(this.text)) {
      if (part.index > index) return part.index;
    }
    return this.text.length;
  }
}

// C0 (with ESC), DEL and C1: the key is a control key or an escape sequence, not text.
function hasControl(data: string): boolean {
  for (const char of data) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

// At most `units` UTF-16 units of `text`, never splitting a grapheme.
function cutAtBoundary(text: string, units: number): string {
  if (text.length <= units) return text;
  let end = 0;
  for (const part of segmenter.segment(text)) {
    if (part.index + part.segment.length > units) break;
    end = part.index + part.segment.length;
  }
  return text.slice(0, end);
}
