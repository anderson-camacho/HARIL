import { homedir } from "node:os";
import { sep } from "node:path";
import type { GitSummary } from "./git-summary.js";
import type { ConsoleTheme, ThemeColor } from "./pi-types.js";
import { powerlineHead } from "./powerline.js";
import { plainText, stripAnsi, textWidth, truncate, wrap } from "./text.js";

// What the console draws: the HARIL bar (Pi's footer), the startup header and the output of a HARIL command (a widget
// above the editor). Everything is yellow, the theme's warning token, with the separators dimmed. Each line is fitted
// to the width Pi renders it at.

export type RuntimeState = "running" | "starting" | "idle" | "unknown";

export interface BarFacts {
  // The bound project's slug, else the folder's name.
  readonly place: string;
  readonly model: string | undefined;
  // What follows the model: its reasoning level, or "no reasoning" (model-levels.ts levelLabel).
  readonly level: string | undefined;
  // undefined without a model; null while Pi does not know the tokens (right after a compaction).
  readonly contextPercent: number | null | undefined;
  readonly cost: number;
  readonly pending: number | undefined;
  readonly runtime: RuntimeState;
  readonly cwd: string;
  readonly branch: string | null;
  readonly statuses: readonly string[];
  // The console mode as the bar names it (ACTION, CONSULT, PLAN, DELEGATION).
  readonly mode: string;
  // Rows of the console's chat log (orders and usage) that could not be recorded; 0 or absent shows nothing.
  readonly logFailures?: number;
  // How many warnings the right sidebar would list under AVISOS (provider warnings, data errors, a failing log);
  // 0 or absent shows nothing. Only the full bar counts them.
  readonly warnings?: number;
  // The status of the console is in the right sidebar (it is open on MAIN): the bar is one line, with the session
  // and the model, and leaves out what the sidebar already says (the folder, the branch, the statuses, the warnings).
  // Absent or false is the full bar: two lines, with the folder line and the warnings count.
  readonly compact?: boolean;
  // The folder line is drawn as powerline segments (powerline.ts) with these git counts, undefined while unknown.
  // Absent is the plain dim line, which is also what HARIL_POWERLINE=off asks for.
  readonly powerline?: { readonly git: GitSummary | undefined } | undefined;
}

// The parts of the bar a click acts on: the model opens the model selector, the level the level selector, the mode the
// mode selector, and the STOP ALL button the emergency stop.
type BarTarget = "model" | "level" | "mode" | "stop";

export interface BarLayout {
  readonly lines: string[];
  readonly hits: readonly {
    readonly row: number;
    readonly start: number;
    readonly end: number;
    readonly target: BarTarget;
  }[];
}

interface Part {
  readonly text: string;
  readonly tone: ThemeColor;
  readonly bold?: boolean;
  readonly target?: BarTarget;
}

const MAIN: ThemeColor = "warning";
const SEPARATOR: Part = { text: " ◇ ", tone: "dim" };
const GAUGE_CELLS = 8;
// The emergency button (3.14.6, P20): pinned at the right end of the bar in every mode, never dropped for room.
const STOP_PART: Part = { text: "■ STOP ALL", tone: "error", bold: true, target: "stop" };
// The right side gives way from its least needed part: the log note first, the context gauge last.
const DROP_ORDER = ["log", "cost", "runtime", "warnings", "pending", "context"] as const;
const OUTPUT_MAX_LINES = 30;

type RightPart = (typeof DROP_ORDER)[number];

function widthOf(parts: readonly Part[]): number {
  return parts.reduce((sum, part) => sum + textWidth(part.text), 0);
}

function paint(parts: readonly Part[], theme: ConsoleTheme): string {
  return parts
    .map((part) => {
      const colored = theme.fg(part.tone, part.text);
      return part.bold === true ? theme.bold(colored) : colored;
    })
    .join("");
}

// The parts cut to `width` columns: the part that does not fit is shortened and the rest dropped.
function fit(parts: readonly Part[], width: number): Part[] {
  const out: Part[] = [];
  let left = width;
  for (const part of parts) {
    const size = textWidth(part.text);
    if (size <= left) {
      out.push(part);
      left -= size;
      continue;
    }
    if (left > 0) out.push({ ...part, text: truncate(part.text, left) });
    break;
  }
  return out;
}

function joined(groups: readonly (readonly Part[])[]): Part[] {
  return groups.flatMap((group, index) => (index === 0 ? [...group] : [SEPARATOR, ...group]));
}

function gauge(percent: number | null): Part[] {
  const known = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const filled = Math.round((known / 100) * GAUGE_CELLS);
  const tone: ThemeColor = known >= 90 ? "error" : MAIN;
  return [
    { text: "ctx ", tone: MAIN },
    { text: "▰".repeat(filled), tone },
    { text: "▱".repeat(GAUGE_CELLS - filled), tone: "dim" },
    { text: percent === null ? " ?%" : ` ${Math.round(known)}%`, tone },
  ];
}

function rightParts(facts: BarFacts): Map<RightPart, Part[]> {
  const parts = new Map<RightPart, Part[]>();
  if (facts.contextPercent !== undefined) parts.set("context", gauge(facts.contextPercent));
  parts.set("cost", [{ text: `$${facts.cost.toFixed(3)}`, tone: MAIN }]);
  if (facts.pending === undefined) parts.set("pending", [{ text: "approvals ?", tone: "warning" }]);
  else if (facts.pending > 0)
    parts.set("pending", [{ text: `${facts.pending} pending`, tone: MAIN }]);
  parts.set("runtime", [
    { text: "runtime ", tone: MAIN },
    { text: facts.runtime, tone: facts.runtime === "running" ? "success" : MAIN },
  ]);
  if (facts.compact === true) {
    // The sidebar lists the warnings and the failing log; the bar keeps only what it does not show. A count of
    // approvals that wait stays, since a human has to act on it, but "approvals ?" (not known yet) is the sidebar's.
    if (facts.pending === undefined) parts.delete("pending");
    return parts;
  }
  const warnings = facts.warnings ?? 0;
  if (warnings > 0) {
    parts.set("warnings", [
      { text: `${warnings} ${warnings === 1 ? "warning" : "warnings"}`, tone: "warning" },
    ]);
  }
  if ((facts.logFailures ?? 0) > 0) {
    parts.set("log", [{ text: `log ✗ ${facts.logFailures}`, tone: "warning" }]);
  }
  return parts;
}

const RIGHT_ORDER: readonly RightPart[] = [
  "context",
  "cost",
  "pending",
  "warnings",
  "runtime",
  "log",
];

// The columns of the parts a click acts on, in the parts as drawn from column `from`.
function hitsOf(parts: readonly Part[], from = 0): BarLayout["hits"][number][] {
  const hits: BarLayout["hits"][number][] = [];
  let column = from;
  for (const part of parts) {
    const size = textWidth(part.text);
    if (part.target !== undefined && size > 0)
      hits.push({ row: 0, start: column, end: column + size, target: part.target });
    column += size;
  }
  return hits;
}

function modelParts(facts: BarFacts): Part[] {
  if (facts.model === undefined) return [{ text: "no model", tone: MAIN, target: "model" }];
  const model: Part = { text: plainText(facts.model), tone: MAIN, target: "model" };
  if (facts.level === undefined) return [model];
  return [
    model,
    { text: " · ", tone: MAIN },
    { text: plainText(facts.level), tone: MAIN, target: "level" },
  ];
}

function barLine(
  facts: BarFacts,
  width: number,
  theme: ConsoleTheme,
): { line: string; hits: BarLayout["hits"][number][] } {
  const stopWidth = textWidth(STOP_PART.text);
  if (width <= stopWidth + 1) {
    const fitted = fit([STOP_PART], width);
    return { line: paint(fitted, theme), hits: hitsOf(fitted) };
  }
  // The button keeps its place at the right end, after one space; the rest of the bar fits in what is left.
  const room = width - stopWidth - 1;
  const stop = { line: ` ${paint([STOP_PART], theme)}`, hits: hitsOf([STOP_PART], room + 1) };
  const left = joined([
    [{ text: "◆ HARIL", tone: MAIN, bold: true }],
    [{ text: `MODE: ${plainText(facts.mode)}`, tone: MAIN, bold: true, target: "mode" }],
    ...(facts.compact === true ? [] : [[{ text: plainText(facts.place), tone: MAIN }]]),
    modelParts(facts),
  ]);
  const right = rightParts(facts);
  const shown = (): Part[] =>
    joined(
      RIGHT_ORDER.flatMap((name) => {
        const group = right.get(name);
        return group === undefined ? [] : [group];
      }),
    );
  const leftWidth = widthOf(left);
  for (const name of DROP_ORDER) {
    if (leftWidth + 2 + widthOf(shown()) <= room) break;
    right.delete(name);
  }
  const shownRight = shown();
  const rightWidth = widthOf(shownRight);
  if (rightWidth === 0 || leftWidth + 2 + rightWidth > room) {
    const fitted = fit(left, room);
    return {
      line: paint(fitted, theme) + " ".repeat(room - widthOf(fitted)) + stop.line,
      hits: [...hitsOf(fitted), ...stop.hits],
    };
  }
  return {
    line:
      paint(left, theme) +
      " ".repeat(room - leftWidth - rightWidth) +
      paint(shownRight, theme) +
      stop.line,
    hits: [...hitsOf(left), ...stop.hits],
  };
}

// The folder with the home directory shown as ~, only when the folder is the home directory or inside it. Windows
// paths compare without case, as its file system does.
function homeRelative(path: string): string {
  const home = homedir().replace(/[\\/]+$/, "");
  if (home === "") return path;
  const fold = (text: string): string => (process.platform === "win32" ? text.toLowerCase() : text);
  const inside = fold(path) === fold(home) || fold(path).startsWith(fold(`${home}${sep}`));
  return inside ? `~${path.slice(home.length)}` : path;
}

// The statuses other extensions set, as dim text after two spaces; one that is empty once cleaned is left out.
function statusParts(statuses: readonly string[]): Part[] {
  const parts: Part[] = [];
  for (const status of statuses) {
    const text = plainText(stripAnsi(status)).trim();
    if (text !== "") parts.push({ text: `  ${text}`, tone: "dim" });
  }
  return parts;
}

function placeLine(facts: BarFacts, width: number, theme: ConsoleTheme): string {
  const statuses = statusParts(facts.statuses);
  if (facts.powerline !== undefined) {
    const head = powerlineHead(
      { folder: homeRelative(facts.cwd), branch: facts.branch, git: facts.powerline.git },
      width,
      theme,
    );
    // The statuses take what the segments leave. A width that holds no segment draws the plain line below.
    if (head !== undefined) return head.line + paint(fit(statuses, width - head.width), theme);
  }
  const parts: Part[] = [{ text: plainText(homeRelative(facts.cwd)), tone: "dim" }];
  if (facts.branch !== null) parts.push({ text: ` (${plainText(facts.branch)})`, tone: "dim" });
  return paint(fit([...parts, ...statuses], width), theme);
}

// The full bar is two lines: HARIL, the mode, the place and `model · level` on the left, the session, the runtime and the
// warnings count on the right, and the STOP ALL button at the right end; below, the folder, its git branch and the
// statuses other extensions set (the folder and the branch are powerline segments with the git counts when the bar
// asks for them, `powerline` in BarFacts). The compact bar (the status is in the sidebar) is the first line without
// the place, the warnings and the folder line. The hit-boxes are the mode, the model, the level and the button on the
// first line.
export function renderBarLayout(facts: BarFacts, width: number, theme: ConsoleTheme): BarLayout {
  if (width <= 0) return { lines: [], hits: [] };
  const first = barLine(facts, width, theme);
  if (facts.compact === true) return { lines: [first.line], hits: first.hits };
  return { lines: [first.line, placeLine(facts, width, theme)], hits: first.hits };
}

// A command's output: its title, then its lines wrapped to the width, at most OUTPUT_MAX_LINES of them.
export function renderOutput(
  title: string,
  lines: readonly string[],
  width: number,
  theme: ConsoleTheme,
): string[] {
  if (width <= 0) return [];
  const body = lines.flatMap((line) => {
    const clean = plainText(line).trimEnd();
    return clean === "" ? [""] : wrap(clean, width);
  });
  const shown = body.slice(0, OUTPUT_MAX_LINES);
  const out = [paint(fit([{ text: `◆ ${title}`, tone: MAIN, bold: true }], width), theme)];
  for (const line of shown) out.push(theme.fg("text", line));
  if (body.length > shown.length) {
    const more = `… ${body.length - shown.length} more lines: run haril ${title} in a terminal`;
    out.push(theme.fg("dim", truncate(more, width)));
  }
  return out;
}
