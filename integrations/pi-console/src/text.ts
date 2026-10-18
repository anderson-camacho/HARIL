// Terminal-width helpers for the console's own lines. Pi's TUI does not shorten a line that is wider than the
// terminal, so every line the console renders is measured and cut here first. The measure is per code point: marks
// and joiners take no cell, pictographs and East Asian wide characters take two, everything else one.

const ESC = 0x1b;
const BEL = 0x07;
const MARK = /^\p{M}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const ELLIPSIS = "…";

// Escape sequences (CSI, OSC and the two-character ones) removed, so text another extension styled can be measured and
// shown in the console's own colors.
export function stripAnsi(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== ESC) {
      out += text[index];
      index++;
      continue;
    }
    const kind = text[index + 1];
    index += 2;
    if (kind === "[") {
      while (index < text.length && !isFinalByte(text.charCodeAt(index))) index++;
      index++;
    } else if (kind === "]") {
      while (
        index < text.length &&
        text.charCodeAt(index) !== BEL &&
        text.charCodeAt(index) !== ESC
      ) {
        index++;
      }
      index += text.charCodeAt(index) === ESC ? 2 : 1;
    }
  }
  return out;
}

function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

// A command's output or a typed argument as the terminal may show it: escape sequences removed, tabs as two spaces
// and any other control character as "?".
export function plainText(text: string): string {
  let out = "";
  for (const char of stripAnsi(text)) {
    const code = char.charCodeAt(0);
    if (char === "\t") out += "  ";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += "?";
    else out += char;
  }
  return out;
}

// Marks, zero-width spaces and joiners, the word joiner and the variation selectors take no cell.
function isZeroWidth(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    MARK.test(char) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2060 ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}

function charWidth(char: string): number {
  if (isZeroWidth(char)) return 0;
  if (PICTOGRAPH.test(char) && (char.codePointAt(0) ?? 0) > 0x2fff) return 2;
  return isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

// Columns a plain (unstyled) text takes.
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char);
  return width;
}

// The text cut to at most `width` columns; a cut text ends with an ellipsis.
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (textWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const next = charWidth(char);
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return `${out}${ELLIPSIS}`;
}

// The text broken into lines of at most `width` columns, at spaces when a word fits, else anywhere.
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  if (textWidth(text) <= width) return [text];
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const word of text.split(/(?<= )/)) {
    const size = textWidth(word);
    if (used + size <= width) {
      line += word;
      used += size;
      continue;
    }
    if (line.trim() !== "") lines.push(line.trimEnd());
    line = "";
    used = 0;
    for (const char of word) {
      const next = charWidth(char);
      if (used + next > width) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += char;
      used += next;
    }
  }
  if (line.trim() !== "") lines.push(line.trimEnd());
  return lines;
}
