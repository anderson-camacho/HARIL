import { visibleWidth } from "@earendil-works/pi-tui";
import { compactCount, fit } from "./format.js";
import {
  box,
  fitsBar,
  type Line,
  lineWidth,
  type Segment,
  segment,
  type Tone,
} from "./frame-layout.js";

// The parts of the console frame (LD-T6b-1) that are not a panel: the top bar, the status line, the right column of
// boxes and the home view with the HARIL banner. The app gathers the facts; these functions only lay them out. The
// look follows the user's references (a top bar, a status rail, a block-letter title and a key/value grid); the
// banner and the mascot are HARIL's own.

// The right column: its width and the terminal width from which it shows.
export const RIGHT_COLUMN_WIDTH = 30;
export const RIGHT_COLUMN_FROM = 100;
const TAGLINE = "Many minds. One flow.";
const SEPARATOR = segment(" ◇ ", "border");
const DOT = segment(" · ", "muted");
const CONTEXT_CELLS = 8;
const LABEL_WIDTH = 8;
const GRID_LABEL_WIDTH = 11;
// The grid is a little wider than the banner, two cells per line.
const GRID_EXTRA_WIDTH = 16;
const BOX_INNER_WIDTH = RIGHT_COLUMN_WIDTH - 4;
const NOT_CONNECTED = "not connected (M4)";

// Block letters, one string per pixel row: "#" is a lit pixel, drawn two cells wide so the letters look square.
const LETTERS: Readonly<Record<string, readonly string[]>> = {
  H: ["#...#", "#...#", "#####", "#...#", "#...#"],
  A: [".###.", "#...#", "#####", "#...#", "#...#"],
  R: ["####.", "#...#", "####.", "#..#.", "#...#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  L: ["#...", "#...", "#...", "#...", "####"],
};
const PIXEL_ROWS = 5;

const BANNER: readonly string[] = Array.from({ length: PIXEL_ROWS }, (_, row) =>
  [..."HARIL"]
    .map((letter) => (LETTERS[letter]?.[row] ?? "").replace(/#/g, "██").replace(/\./g, "  "))
    .join("  "),
);
const BANNER_WIDTH = Math.max(...BANNER.map((line) => visibleWidth(line)));
// The banner, a blank line, the tagline, a blank line and four lines of grid.
const HOME_ROWS = BANNER.length + 7;

// Three small minds feeding one flow: the tagline as a picture.
const MASCOT: readonly string[] = [
  "(o o) (o o) (o o)",
  "   \\    |    /",
  "    `---+---'",
  "        v",
];

export type RuntimeState = "running" | "starting" | "idle";

export interface FrameFacts {
  // The filter's slug, or "all".
  readonly project: string;
  readonly projectCount: number;
  // The root of the filtered project, or of the only one; undefined with several and no filter.
  readonly rootPath: string | undefined;
  // reading: a read of rootPath is in flight; unknown: git could not tell (not a repository, no git, a time-out).
  readonly git: { readonly branch: string; readonly changes: number } | "reading" | "unknown";
  readonly model: string | undefined;
  // Settled tokens of the running task against its maxTokens; undefined when nothing runs.
  readonly context: { readonly used: number; readonly max: number } | undefined;
  // Settled tokens of the scope.
  readonly tokens: { readonly input: number; readonly output: number };
  readonly runtime: {
    readonly state: RuntimeState;
    readonly pid: number | undefined;
    readonly byShell: boolean;
    readonly live: boolean;
  };
  // The runtime as the status line says it: "running (started by shell, pid N) · live" and its kin.
  readonly runtimeText: string;
  readonly isolation: string;
  readonly approvals: number;
  readonly taxis: { readonly busy: number; readonly slots: number };
  // For the home grid: the project slugs, a summary of the tasks, the agents in use and the settings.
  readonly projects: readonly string[];
  readonly tasks: string;
  readonly agents: readonly string[];
  readonly version: string;
  readonly dataDir: string | undefined;
  readonly theme: string;
}

// The top bar: brand, project and model on the left; context, tokens and runtime on the right. Without the right
// column (`folded`) it also carries the pending approvals. When it is too wide it drops the context cells, then the
// tokens, then the context.
export function topBar(facts: FrameFacts, width: number, folded: boolean): Line {
  const left = [
    segment("◆ HARIL", "accent", true),
    SEPARATOR,
    segment(facts.project, "text"),
    SEPARATOR,
    segment(facts.model ?? "no model", "muted"),
  ];
  const tokens = [segment("tok ", "muted"), segment(tokenPair(facts), "text")];
  const runtime = [segment("runtime ", "muted"), segment(facts.runtime.state, stateTone(facts))];
  const count = facts.approvals;
  const approvals =
    folded && count > 0
      ? [[segment(`${count} ${count === 1 ? "approval" : "approvals"} (p)`, "warning")]]
      : [];
  const variants = [
    [contextPart(facts, true), tokens, runtime, ...approvals],
    [contextPart(facts, false), tokens, runtime, ...approvals],
    [contextPart(facts, false), runtime, ...approvals],
    [runtime, ...approvals],
  ].map((parts) => joined(parts, SEPARATOR));
  return spread(
    left,
    firstFitting(variants, (right) => fitsBar(left, right, width)),
    width,
  );
}

// The status line: model, runtime and tokens on the left, help and quit on the right. Without the right column
// (`folded`) it also names the branch and its changes. The branch gives way first, then the model, then the tokens.
export function statusLine(facts: FrameFacts, width: number, folded: boolean): Line {
  const model = [segment(facts.model ?? "no model", "muted")];
  const runtime = [segment(`runtime ${facts.runtimeText}`, "text")];
  const tokens = [segment(`tok ${tokenPair(facts)}`, "muted")];
  const right = [segment("? help · q quit", "muted")];
  const git = folded ? gitPart(facts) : undefined;
  const variants = [
    ...(git === undefined ? [] : [[model, runtime, tokens, git]]),
    [model, runtime, tokens],
    [runtime, tokens],
    [runtime],
  ].map((parts) => joined(parts, DOT));
  return spread(
    firstFitting(variants, (left) => fitsBar(left, right, width)),
    right,
    width,
  );
}

// The boxes of the right column, in this order, each one only when it still fits in `height` lines.
export function rightColumn(facts: FrameFacts, height: number): Line[] {
  const width = RIGHT_COLUMN_WIDTH;
  const tokens = `in ${compactCount(facts.tokens.input)} · out ${compactCount(facts.tokens.output)}`;
  const mascotIndent = " ".repeat(
    Math.floor((BOX_INNER_WIDTH - Math.max(...MASCOT.map((line) => line.length))) / 2),
  );
  const boxes = [
    box("Status", statusRows(facts), width),
    box("Runtime", runtimeRows(facts), width),
    box("Approvals", approvalRows(facts), width),
    box("Taxis", [taxiRow(facts)], width),
    box("Tokens", [[segment(tokens, "text")], [segment("cost n/a (not tracked)", "muted")]], width),
    box(
      "Connect",
      ["memory", "mcp", "profile"].map((name) => row(name, NOT_CONNECTED, "muted")),
      width,
    ),
    box(
      undefined,
      MASCOT.map((line) => [segment(`${mascotIndent}${line}`, "accent")]),
      width,
    ),
  ];
  const lines: Line[] = [];
  for (const drawn of boxes) {
    if (lines.length + drawn.length <= height) lines.push(...drawn);
  }
  return lines;
}

// The home view: the banner, the tagline and the facts grid, centered in `width` x `height`. Undefined when it does
// not fit; the app then shows the active panel.
export function homeLines(facts: FrameFacts, width: number, height: number): Line[] | undefined {
  if (height < HOME_ROWS || width < BANNER_WIDTH) return undefined;
  const cell = Math.floor(Math.min(width, BANNER_WIDTH + GRID_EXTRA_WIDTH) / 2);
  const valueWidth = cell - GRID_LABEL_WIDTH - 1;
  const pairs: readonly (readonly [string, string])[] = [
    ["PROJECTS", listed(facts.projects, true)],
    ["TASKS", facts.tasks],
    ["AGENTS", listed(facts.agents, false)],
    ["RUNTIME", `${facts.runtime.state} · isolation ${facts.isolation}`],
    ["VERSION", facts.version],
    ["DATA", facts.dataDir === undefined ? "not set" : shortPath(facts.dataDir, valueWidth)],
    ["APPROVALS", facts.approvals === 0 ? "none pending" : `${facts.approvals} pending · p`],
    ["THEME", facts.theme],
  ];
  const grid: Line[] = [];
  for (let index = 0; index < pairs.length; index += 2) {
    grid.push(
      pairs
        .slice(index, index + 2)
        .flatMap(([label, value]) => [
          segment(label.padEnd(GRID_LABEL_WIDTH), "accent"),
          segment(cells(fit(value, valueWidth), valueWidth + 1), "text"),
        ]),
    );
  }
  const content: Line[] = [
    ...BANNER.map((line) => centered([segment(line, "accent", true)], width)),
    [],
    centered([segment(TAGLINE, "muted")], width),
    [],
    ...grid.map((line) => centered(line, width)),
  ];
  return [
    ...Array.from({ length: Math.floor((height - content.length) / 2) }, () => []),
    ...content,
  ];
}

// A path cut from the left to `width` cells, at a separator when one is near: "…\runtime\data". It counts cells, not
// characters, so a wide character in the path keeps it within the width.
function shortPath(path: string, width: number): string {
  if (visibleWidth(path) <= width) return path;
  const chars = [...path];
  let tail = "";
  for (let index = chars.length - 1; index >= 0; index--) {
    const longer = `${chars[index]}${tail}`;
    if (visibleWidth(longer) > width - 1) break;
    tail = longer;
  }
  const separator = tail.search(/[\\/]/);
  return `…${separator > 0 ? tail.slice(separator) : tail}`;
}

function statusRows(facts: FrameFacts): Line[] {
  const { git, rootPath } = facts;
  const project = facts.project === "all" ? `all (${facts.projectCount})` : facts.project;
  const known = rootPath !== undefined && typeof git !== "string" ? git : undefined;
  const branch =
    known !== undefined
      ? row("branch", known.branch, "text")
      : row(
          "branch",
          rootPath === undefined ? "-" : git === "reading" ? "reading…" : "n/a",
          "muted",
        );
  const changes =
    known === undefined
      ? row("changes", "-", "muted")
      : known.changes === 0
        ? row("changes", "clean", "ok")
        : row("changes", `${known.changes} changed`, "warning");
  return [
    row("project", project, "text"),
    row(
      "root",
      rootPath === undefined ? "-" : shortPath(rootPath, BOX_INNER_WIDTH - LABEL_WIDTH),
      "text",
    ),
    branch,
    changes,
  ];
}

function runtimeRows(facts: FrameFacts): Line[] {
  const { runtime } = facts;
  const started = runtime.pid === undefined ? "-" : runtime.byShell ? "by shell" : "elsewhere";
  return [
    row("state", runtime.state, stateTone(facts)),
    row("pid", runtime.pid === undefined ? "-" : String(runtime.pid), "text"),
    row("started", started, "text"),
    row("live", runtime.live ? "subscribed" : "no", runtime.live ? "ok" : "muted"),
    row("isolation", facts.isolation, "text"),
  ];
}

function approvalRows(facts: FrameFacts): Line[] {
  return facts.approvals === 0
    ? [[segment("none pending", "ok")], [segment("p opens Plans", "muted")]]
    : [[segment(`${facts.approvals} pending`, "warning")], [segment("p to review", "muted")]];
}

// "git main · 3 changed" for the status line; undefined while git has not answered for the root.
function gitPart(facts: FrameFacts): Segment[] | undefined {
  const { git } = facts;
  if (facts.rootPath === undefined || typeof git === "string") return undefined;
  return [
    segment(`git ${git.branch}`, "text"),
    DOT,
    git.changes === 0 ? segment("clean", "ok") : segment(`${git.changes} changed`, "warning"),
  ];
}

function taxiRow(facts: FrameFacts): Line {
  const { busy, slots } = facts.taxis;
  return [
    segment(`${busy} busy`, busy > 0 ? "ok" : "muted"),
    segment(` · ${Math.max(0, slots - busy)} free (of ${slots})`, "text"),
  ];
}

// The context of the running task: "ctx ▰▰▱▱▱▱▱▱ 25%" (or without the cells), "ctx n/a" when nothing runs.
function contextPart(facts: FrameFacts, cells: boolean): Segment[] {
  const { context } = facts;
  if (context === undefined || context.max <= 0) return [segment("ctx n/a", "muted")];
  const percent = Math.round((context.used / context.max) * 100);
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * CONTEXT_CELLS);
  const tone: Tone = percent >= 90 ? "danger" : percent >= 70 ? "warning" : "accent";
  const bar = `${"▰".repeat(filled)}${"▱".repeat(CONTEXT_CELLS - filled)} `;
  return [
    segment("ctx ", "muted"),
    ...(cells ? [segment(bar, tone)] : []),
    segment(`${percent}%`, "text"),
  ];
}

function stateTone(facts: FrameFacts): Tone {
  const { state } = facts.runtime;
  return state === "running" ? "ok" : state === "starting" ? "warning" : "muted";
}

function tokenPair(facts: FrameFacts): string {
  return `${compactCount(facts.tokens.input)}/${compactCount(facts.tokens.output)}`;
}

// A label and its value; a label longer than the column keeps one space after it.
function row(label: string, value: string, tone: Tone): Line {
  return [
    segment(label.padEnd(Math.max(LABEL_WIDTH, label.length + 1)), "muted"),
    segment(value, tone),
  ];
}

function listed(names: readonly string[], counted: boolean): string {
  if (names.length === 0) return "none yet";
  return counted ? `${names.length} · ${names.join(", ")}` : names.join(", ");
}

function joined(parts: readonly (readonly Segment[])[], separator: Segment): Segment[] {
  return parts.flatMap((part, index) => (index === 0 ? [...part] : [separator, ...part]));
}

function firstFitting(variants: readonly Segment[][], fits: (line: Line) => boolean): Segment[] {
  return variants.find(fits) ?? variants.at(-1) ?? [];
}

// The left part, at least one space, and the right part ending at `width`. The app cuts what is still too wide.
function spread(left: Line, right: Line, width: number): Line {
  const gap = Math.max(1, width - lineWidth(left) - lineWidth(right));
  return [...left, segment(" ".repeat(gap), "text"), ...right];
}

function centered(line: Line, width: number): Line {
  const indent = Math.max(0, Math.floor((width - lineWidth(line)) / 2));
  return [segment(" ".repeat(indent), "text"), ...line];
}

// Exactly `width` cells: the text cut by fit, then padded with spaces, so the grid's columns stay even with wide
// characters too.
function cells(text: string, width: number): string {
  const shown = fit(text, width);
  return `${shown}${" ".repeat(Math.max(0, width - visibleWidth(shown)))}`;
}
