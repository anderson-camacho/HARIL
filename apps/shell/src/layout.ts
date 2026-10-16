import { visibleWidth } from "@earendil-works/pi-tui";

// Layout helpers of the shell (TUI-D7). Pure: they take widths and offsets, never the terminal.

const TAB_GAP = 2;

export interface TabCell {
  // Position of the panel in the panel list (0-based).
  readonly index: number;
  readonly text: string;
}

// Packs the tab labels into lines no wider than `width`, so every panel stays reachable on a narrow terminal.
// A label that is wider than the terminal on its own is kept whole; the renderer truncates it.
export function packTabs(labels: readonly string[], width: number): TabCell[][] {
  const lines: TabCell[][] = [];
  let line: TabCell[] = [];
  let used = 0;
  labels.forEach((label, index) => {
    const text = `${index + 1} ${label}`;
    const cost = (line.length === 0 ? 0 : TAB_GAP) + visibleWidth(text);
    if (line.length > 0 && used + cost > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length === 0 ? 0 : TAB_GAP) + visibleWidth(text);
    line.push({ index, text });
  });
  if (line.length > 0) lines.push(line);
  return lines;
}

// The scroll offset that keeps `cursor` inside a window of `height` lines out of `total`.
export function followCursor(
  offset: number,
  cursor: number,
  height: number,
  total: number,
): number {
  let next = offset;
  if (cursor < next) next = cursor;
  else if (cursor >= next + height) next = cursor - height + 1;
  return clampOffset(next, height, total);
}

// Keeps a scroll offset inside the lines that exist.
export function clampOffset(offset: number, height: number, total: number): number {
  return Math.min(Math.max(0, offset), Math.max(0, total - height));
}
