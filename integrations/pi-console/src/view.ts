import { homedir } from "node:os";
import { sep } from "node:path";
import type { ConsoleTheme, ThemeColor, ThinkingLevel } from "./pi-types.js";
import { plainText, stripAnsi, textWidth, truncate, wrap } from "./text.js";

// What the console draws: the HARIL bar (Pi's footer), the startup header and the output of a HARIL command (a widget
// above the editor). Everything is yellow, the theme's warning token, with the separators dimmed. Each line is fitted
// to the width Pi renders it at.

export type RuntimeState = "running" | "starting" | "idle" | "unknown";

export interface BarFacts {
  // The bound project's slug, else the folder's name.
  readonly place: string;
  readonly model: string | undefined;
  // Only for a model that reasons.
  readonly level: ThinkingLevel | undefined;
  // undefined without a model; null while Pi does not know the tokens (right after a compaction).
  readonly contextPercent: number | null | undefined;
  readonly cost: number;
  readonly pending: number;
  readonly runtime: RuntimeState;
  readonly cwd: string;
  readonly branch: string | null;
  readonly statuses: readonly string[];
}

interface Part {
  readonly text: string;
  readonly tone: ThemeColor;
  readonly bold?: boolean;
}

const MAIN: ThemeColor = "warning";
const SEPARATOR: Part = { text: " ◇ ", tone: "dim" };
const GAUGE_CELLS = 8;
// The right side gives way from its least needed part: the cost first, the context gauge last.
const DROP_ORDER = ["cost", "runtime", "pending", "context"] as const;
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
  if (facts.pending > 0) parts.set("pending", [{ text: `${facts.pending} pending`, tone: MAIN }]);
  parts.set("runtime", [
    { text: "runtime ", tone: MAIN },
    { text: facts.runtime, tone: facts.runtime === "running" ? "success" : MAIN },
  ]);
  return parts;
}

const RIGHT_ORDER: readonly RightPart[] = ["context", "cost", "pending", "runtime"];

function barLine(facts: BarFacts, width: number, theme: ConsoleTheme): string {
  const modelText =
    facts.model === undefined
      ? "no model"
      : facts.level === undefined
        ? facts.model
        : `${facts.model} · ${facts.level}`;
  const left = joined([
    [{ text: "◆ HARIL", tone: MAIN, bold: true }],
    [{ text: plainText(facts.place), tone: MAIN }],
    [{ text: plainText(modelText), tone: MAIN }],
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
    if (leftWidth + 2 + widthOf(shown()) <= width) break;
    right.delete(name);
  }
  const shownRight = shown();
  const rightWidth = widthOf(shownRight);
  if (rightWidth === 0 || leftWidth + 2 + rightWidth > width) return paint(fit(left, width), theme);
  return paint(left, theme) + " ".repeat(width - leftWidth - rightWidth) + paint(shownRight, theme);
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

function placeLine(facts: BarFacts, width: number, theme: ConsoleTheme): string {
  const parts: Part[] = [{ text: plainText(homeRelative(facts.cwd)), tone: "dim" }];
  if (facts.branch !== null) parts.push({ text: ` (${plainText(facts.branch)})`, tone: "dim" });
  for (const status of facts.statuses) {
    const text = plainText(stripAnsi(status)).trim();
    if (text !== "") parts.push({ text: `  ${text}`, tone: "dim" });
  }
  return paint(fit(parts, width), theme);
}

// The two lines of the bar: HARIL, the place and the model on the left, the session and the runtime on the right;
// below, the folder, its git branch and the statuses other extensions set.
export function renderBar(facts: BarFacts, width: number, theme: ConsoleTheme): string[] {
  if (width <= 0) return [];
  return [barLine(facts, width, theme), placeLine(facts, width, theme)];
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
