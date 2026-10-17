import { visibleWidth } from "@earendil-works/pi-tui";
import { fit } from "./format.js";
import type { ThemeToken } from "./theme.js";

// Layout helpers of the console frame (LD-T6b-1). pi-tui's main screen takes one component that renders whole lines,
// so boxes and columns are drawn here, by hand, as lines of segments: a text and the theme token it is painted with.
// Pure: they take widths, never the terminal. Every text goes through fit, the render boundary of format.ts, so a
// line built here is never wider than asked and keeps no control character; the app colors it afterwards.

export type Tone = ThemeToken;

export interface Segment {
  readonly text: string;
  readonly tone: Tone;
  readonly bold?: boolean;
  // Drawn in reverse video: the cursor of the input box (LD-T6b-2).
  readonly inverse?: boolean;
}

export type Line = readonly Segment[];

const GAP = 1;

export function segment(text: string, tone: Tone, bold = false): Segment {
  return bold ? { text, tone, bold } : { text, tone };
}

export function lineText(line: Line): string {
  return line.map((part) => part.text).join("");
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
}

// Cuts a line to `width` cells: each segment passes through fit, and the one that crosses the edge ends with "…".
export function fitLine(line: Line, width: number): Segment[] {
  const out: Segment[] = [];
  let used = 0;
  for (const part of line) {
    const room = width - used;
    if (room <= 0) break;
    const text = fit(part.text, room);
    out.push({ ...part, text });
    used += visibleWidth(text);
  }
  return out;
}

// Exactly `width` cells: the line cut as fitLine does, then padded with spaces.
export function padLine(line: Line, width: number): Segment[] {
  const fitted = fitLine(line, width);
  const rest = width - lineWidth(fitted);
  return rest > 0 ? [...fitted, segment(" ".repeat(rest), "text")] : fitted;
}

// A box `width` cells wide with a border on every side, its title in the top one ("┌─ Status ──┐") and a footer, such
// as the keys of the input box (LD-T6b-2), in the bottom one. Each body line is cut to the inside. The border takes the
// border token, the title the accent and the footer the muted one; the body keeps its own tones.
export function box(
  title: string | undefined,
  body: readonly Line[],
  width: number,
  footer?: string,
): Segment[][] {
  if (width < 4) return [];
  const inner = width - 4;
  return [
    title === undefined || width < 7
      ? [segment(`┌${"─".repeat(width - 2)}┐`, "border")]
      : labelledBorder("┌", "┐", segment(title, "accent", true), width),
    ...body.map((line) => [
      segment("│ ", "border"),
      ...padLine(line, inner),
      segment(" │", "border"),
    ]),
    footer === undefined || footer === "" || width < 7
      ? [segment(`└${"─".repeat(width - 2)}┘`, "border")]
      : labelledBorder("└", "┘", segment(footer, "muted"), width),
  ];
}

function labelledBorder(left: string, right: string, label: Segment, width: number): Segment[] {
  // "┌─ " and " " around the label, at least one "─" and the corner: six cells besides the label.
  const shown = fit(label.text, width - 6);
  const rest = width - 5 - visibleWidth(shown);
  return [
    segment(`${left}─ `, "border"),
    { ...label, text: shown },
    segment(` ${"─".repeat(rest)}${right}`, "border"),
  ];
}

// Two columns side by side, one space apart, as `height` lines of exactly leftWidth + 1 + rightWidth cells. A column
// with fewer lines is padded with blank ones; lines past the height are dropped.
export function joinColumns(
  left: readonly Line[],
  leftWidth: number,
  right: readonly Line[],
  rightWidth: number,
  height: number,
): Segment[][] {
  const lines: Segment[][] = [];
  for (let index = 0; index < height; index++) {
    lines.push([
      ...padLine(left[index] ?? [], leftWidth),
      segment(" ".repeat(GAP), "text"),
      ...padLine(right[index] ?? [], rightWidth),
    ]);
  }
  return lines;
}

// One line of `width` cells with `left` at the start and `right` at the end. When both do not fit, the left part is
// cut so the right part stays whole.
export function bar(left: Line, right: Line, width: number): Segment[] {
  const shownRight = fitLine(right, width);
  const rightWidth = lineWidth(shownRight);
  if (rightWidth === 0) return padLine(left, width);
  const shownLeft = fitLine(left, Math.max(0, width - rightWidth - GAP));
  const spaces = width - lineWidth(shownLeft) - rightWidth;
  return [...shownLeft, segment(" ".repeat(Math.max(0, spaces)), "text"), ...shownRight];
}

// Whether `left` and `right` fit on one line of `width` cells with at least one space between them.
export function fitsBar(left: Line, right: Line, width: number): boolean {
  return lineWidth(left) + GAP + lineWidth(right) <= width;
}
