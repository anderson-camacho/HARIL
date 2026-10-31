import { type DashboardTone, lineTone, visualText } from "./dashboard-theme.js";
import type { OrchestrationTarget } from "./orchestration-state.js";
import type { WorkflowNode, WorkflowState } from "./orchestration-types.js";
import { plainText, textWidth, truncate } from "./text.js";

// The drawing primitives of the ORCHESTRATION view (orchestration-view.ts draws the screens with them): the glyph
// sets, line composition with hit-boxes, values as text and the glyph-plus-text status of a node or a workflow.
// Every composed line is cut to its width and padded; colors come from the dashboard theme.

export interface OrchestrationGlyphs {
  readonly running: string;
  readonly idle: string;
  readonly done: string;
  readonly failed: string;
  readonly stop: string;
  readonly paused: string;
  readonly arrow: string;
  readonly pointer: string;
  readonly upDown: string;
  readonly barOn: string;
  readonly barOff: string;
  readonly mark: string;
  readonly frame: {
    readonly h: string;
    readonly v: string;
    readonly topLeft: string;
    readonly topRight: string;
    readonly bottomLeft: string;
    readonly bottomRight: string;
    readonly teeLeft: string;
    readonly teeRight: string;
    readonly teeTop: string;
    readonly teeBottom: string;
  };
}

export const UNICODE_GLYPHS: OrchestrationGlyphs = {
  running: "●",
  idle: "○",
  done: "✓",
  failed: "✗",
  stop: "■",
  paused: "‖",
  arrow: "→",
  pointer: "▸",
  upDown: "↑↓",
  barOn: "▰",
  barOff: "▱",
  mark: "│",
  frame: {
    h: "─",
    v: "│",
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    teeLeft: "├",
    teeRight: "┤",
    teeTop: "┬",
    teeBottom: "┴",
  },
};

// For a terminal font without the state glyphs: every glyph above in plain ASCII. The separators (·) and the
// ellipsis of a cut text (…) stay, as in the rest of the console.
export const ASCII_GLYPHS: OrchestrationGlyphs = {
  running: "*",
  idle: "o",
  done: "v",
  failed: "x",
  stop: "#",
  paused: "||",
  arrow: "->",
  pointer: ">",
  upDown: "Up/Down",
  barOn: "=",
  barOff: "-",
  mark: "|",
  frame: {
    h: "-",
    v: "|",
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    teeLeft: "+",
    teeRight: "+",
    teeTop: "+",
    teeBottom: "+",
  },
};

// HARIL_CONSOLE_ASCII=1 (or true/yes) selects the ASCII glyphs; anything else, or unset, the Unicode ones.
const ASCII_ENV = "HARIL_CONSOLE_ASCII";

export function orchestrationGlyphs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OrchestrationGlyphs {
  const value = env[ASCII_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

interface OrchestrationHit {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly target: OrchestrationTarget;
}

export interface RenderedBlock {
  readonly lines: string[];
  readonly hits: OrchestrationHit[];
}

const STALE_MS = 5 * 60_000;
const BAR_CELLS = 10;
// The quota rules avoid an account above 80% of its 5h or weekly window (spec 3.11): the bars mark that point.
const QUOTA_MARK_CELLS = 8;

export type Background = "base" | "panel" | "selected";

export interface Seg {
  readonly text: string;
  readonly tone?: DashboardTone;
  readonly bg?: Background;
  readonly target?: OrchestrationTarget;
}

export interface Row {
  readonly text: string;
  readonly hits: {
    readonly start: number;
    readonly end: number;
    readonly target: OrchestrationTarget;
  }[];
}

export interface Status {
  readonly glyph: string;
  readonly text: string;
  readonly tone: DashboardTone;
}

// ---------------------------------------------------------------------------------------------------------------
// Line composition: segments cut to a width, hit columns recorded, the rest padded.

export function widthOf(segs: readonly Seg[]): number {
  return segs.reduce((sum, seg) => sum + textWidth(plainText(seg.text)), 0);
}

export function clip(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = [];
  let left = width;
  for (const seg of segs) {
    if (left <= 0) break;
    const text = plainText(seg.text);
    const size = textWidth(text);
    if (size <= left) {
      out.push(seg);
      left -= size;
    } else {
      out.push({ ...seg, text: truncate(text, left) });
      left = 0;
    }
  }
  return out;
}

export function compose(segs: readonly Seg[], width: number, fill: Background = "base"): Row {
  if (width <= 0) return { text: "", hits: [] };
  let text = "";
  let used = 0;
  const hits: { start: number; end: number; target: OrchestrationTarget }[] = [];
  for (const seg of clip(segs, width)) {
    const shown = plainText(seg.text);
    const size = textWidth(shown);
    if (size === 0) continue;
    text += visualText(shown, seg.tone ?? "text", seg.bg ?? fill);
    if (seg.target !== undefined) {
      const last = hits[hits.length - 1];
      if (last !== undefined && last.target === seg.target && last.end === used) last.end += size;
      else hits.push({ start: used, end: used + size, target: seg.target });
    }
    used += size;
  }
  if (used < width) text += visualText(" ".repeat(width - used), "text", fill);
  return { text, hits };
}

// Left and right parts on one line, the right one flush right; when both do not fit, the left one gives way.
export function spread(left: readonly Seg[], right: readonly Seg[], width: number): Seg[] {
  const rightWidth = widthOf(right);
  const leftWidth = widthOf(left);
  if (rightWidth >= width) return clip(right, width);
  if (leftWidth + 1 + rightWidth <= width)
    return [...left, { text: " ".repeat(width - leftWidth - rightWidth) }, ...right];
  return [...clip(left, width - rightWidth - 1), { text: " " }, ...right];
}

export function firstThatFits(
  candidates: readonly (readonly Seg[])[],
  width: number,
): readonly Seg[] {
  return (
    candidates.find((segs) => widthOf(segs) <= width) ?? candidates[candidates.length - 1] ?? []
  );
}

export class Canvas {
  readonly lines: string[] = [];
  readonly hits: OrchestrationHit[] = [];

  push(row: Row): void {
    const index = this.lines.length;
    this.lines.push(row.text);
    for (const hit of row.hits)
      this.hits.push({ row: index, start: hit.start, end: hit.end, target: hit.target });
  }

  raw(text: string, hits: readonly Row["hits"][number][] = []): void {
    this.push({ text, hits: [...hits] });
  }

  block(): RenderedBlock {
    return { lines: this.lines, hits: this.hits };
  }
}

export function frameText(text: string): string {
  return visualText(text, lineTone("cyan"), "base");
}

export function framed(
  canvas: Canvas,
  inner: readonly Seg[],
  width: number,
  g: OrchestrationGlyphs,
): void {
  const row = compose(inner, width - 2);
  canvas.raw(
    `${frameText(g.frame.v)}${row.text}${frameText(g.frame.v)}`,
    row.hits.map((hit) => ({ ...hit, start: hit.start + 1, end: hit.end + 1 })),
  );
}

export function rule(
  width: number,
  left: string,
  right: string,
  g: OrchestrationGlyphs,
  middle?: { readonly at: number; readonly glyph: string },
): string {
  const inside = Math.max(0, width - 2);
  let line = g.frame.h.repeat(inside);
  if (middle !== undefined && middle.at > 0 && middle.at < inside)
    line = `${line.slice(0, middle.at)}${middle.glyph}${line.slice(middle.at + 1)}`;
  return frameText(`${left}${line}${right}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Values as text. A null is not available and says so.

function trimNumber(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

export function tokens(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${trimNumber(value / 1_000)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${trimNumber(value / 1_000_000)}M`;
}

export function optionalTokens(value: number | null): string {
  return value === null ? "n/a" : tokens(value);
}

function two(value: number): string {
  return String(Math.floor(value)).padStart(2, "0");
}

export function clockTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${two(seconds / 3_600)}:${two((seconds % 3_600) / 60)}:${two(seconds % 60)}`;
}

export function shortTime(ms: number | null): string {
  if (ms === null) return "n/a";
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return seconds >= 3_600 ? clockTime(ms) : `${two(seconds / 60)}:${two(seconds % 60)}`;
}

export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

export function inTime(at: number, now: number): string {
  const seconds = Math.round((at - now) / 1_000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `in ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} h ${minutes % 60} min`;
  return `in ${Math.floor(hours / 24)} d`;
}

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

export function contextBar(used: number, threshold: number, g: OrchestrationGlyphs): string {
  const ratio = threshold > 0 ? used / threshold : 0;
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(ratio * BAR_CELLS)));
  return `${g.barOn.repeat(filled)}${g.barOff.repeat(BAR_CELLS - filled)}`;
}

// A quota bar with the 80% mark: a value above the mark always shows a cell past it, one at or below never does.
function quotaBar(value: number, g: OrchestrationGlyphs): string {
  const markPercent = QUOTA_MARK_CELLS * (100 / BAR_CELLS);
  let filled = Math.max(0, Math.min(BAR_CELLS, Math.round(value / (100 / BAR_CELLS))));
  if (value > markPercent && filled <= QUOTA_MARK_CELLS) filled = QUOTA_MARK_CELLS + 1;
  if (value <= markPercent && filled > QUOTA_MARK_CELLS) filled = QUOTA_MARK_CELLS;
  const cells = Array.from({ length: BAR_CELLS }, (_, index) =>
    index < filled ? g.barOn : g.barOff,
  );
  return `${cells.slice(0, QUOTA_MARK_CELLS).join("")}${g.mark}${cells.slice(QUOTA_MARK_CELLS).join("")}`;
}

export function quotaValue(value: number | null, g: OrchestrationGlyphs): Seg[] {
  if (value === null) return [{ text: "n/a", tone: "muted" }];
  return [
    { text: `${percent(value).padEnd(5)}`, tone: value > 80 ? "yellow" : "text" },
    { text: quotaBar(value, g), tone: value > 80 ? "yellow" : "teal" },
  ];
}

export function nodeStatus(node: WorkflowNode, now: number, g: OrchestrationGlyphs): Status {
  switch (node.state) {
    case "running": {
      const idle = node.lastProgress === null ? 0 : now - node.lastProgress.at;
      return idle >= STALE_MS
        ? {
            glyph: g.running,
            text: `${Math.floor(idle / 60_000)} min without activity`,
            tone: "yellow",
          }
        : { glyph: g.running, text: "working", tone: "teal" };
    }
    case "waiting":
      return { glyph: g.idle, text: node.waitingReason ?? "waiting", tone: "muted" };
    case "queued":
      return { glyph: g.idle, text: "queued", tone: "muted" };
    case "done":
      return { glyph: g.done, text: "done", tone: "cyan" };
    case "failed":
      return { glyph: g.failed, text: "failed", tone: "error" };
    case "cancelled":
      return { glyph: g.stop, text: "cancelled", tone: "muted" };
    case "awaiting_human":
      return { glyph: g.paused, text: "awaiting you", tone: "yellow" };
    case "closed":
      return {
        glyph: g.failed,
        text: node.waitingReason === null ? "closed" : `closed: ${node.waitingReason}`,
        tone: "error",
      };
  }
}

export function workflowStatus(state: WorkflowState, g: OrchestrationGlyphs): Status {
  switch (state) {
    case "running":
      return { glyph: g.running, text: "running", tone: "teal" };
    case "awaiting_human":
      return { glyph: g.paused, text: "awaiting you", tone: "yellow" };
    case "completed":
      return { glyph: g.done, text: "completed", tone: "cyan" };
    case "failed":
      return { glyph: g.failed, text: "failed", tone: "error" };
    case "stopped":
      return { glyph: g.stop, text: "stopped", tone: "error" };
  }
}
