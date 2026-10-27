import { keyOf } from "./orchestration-state.js";
import type { ConsoleTheme, ThemeColor } from "./pi-types.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

// The /delegate card (docs/modos-y-delegacion.md 3.13 and 7.5): the one human confirmation before a three-layer
// workflow starts. It shows the goal, the orchestrator's model (pinned; the user picks a high model) and the autonomy
// decided for this run. The autonomy is read from the user's own words with a closed vocabulary, never by a model:
// the stop names themselves (after_plan, at_end, on_audit_failure, on_budget_pct:<n>, after_node:<id>, before_merge)
// and a few plain phrases in English and Spanish ("don't stop", "stop at the end", "si falla una auditoría"…). A message
// that says nothing runs without stops: the card itself is the human's confirmation, so the workflow starts working at
// once instead of waiting after its first plan; the usual stops stay listed, unchecked, for the human to turn on. The
// human toggles the stops and confirms; nothing starts without that. The card builds the exact `haril workflow start` arguments, always with real agents (--agent orchestrator).
// Agents may add stops later; only the human removes them (/continue, haril workflow continue --remove-stop).

const GOAL_LINES = 3;
const LABEL_WIDTH = 10;
// Blank columns left and right of the card, so it never touches the terminal edge or the panels behind it.
const MARGIN = 3;
// The stops every card lists; a stop the message names joins them.
const USUAL_STOPS = ["after_plan", "at_end", "on_audit_failure"] as const;

interface CardStop {
  readonly stop: string;
  readonly on: boolean;
}

export interface DelegateCard {
  readonly goal: string;
  readonly model: string | undefined;
  readonly preflight?: { readonly baseBranch: string; readonly testCommand: string };
  readonly stops: readonly CardStop[];
  // The stop row the keyboard is on.
  readonly cursor: number;
}

export type CardEffect = "start" | "cancel" | "choose-model";

export type CardTarget =
  | { readonly kind: "stop"; readonly index: number }
  | { readonly kind: "start" }
  | { readonly kind: "cancel" }
  | { readonly kind: "model" }
  | { readonly kind: "autonomy" };

export interface CardStep {
  readonly card: DelegateCard;
  readonly effect?: CardEffect;
  readonly handled: boolean;
}

interface CardHit {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly target: CardTarget;
}

const STOP_TOKEN =
  /\b(after_plan|before_merge|on_audit_failure|at_end|after_node:[A-Za-z0-9_-]{1,64}|on_budget_pct:(?:100|[1-9][0-9]?))(?![A-Za-z0-9_:-])/gi;

// Phrases that name a stop, on the text lower-cased and without accents. The stop phrases do not cross a sentence.
const STOP_PHRASES: readonly [string, RegExp][] = [
  ["after_plan", /\b(?:stop|pause|wait)\b[^.;\n]*?\bafter (?:the )?(?:first )?plan\b/g],
  [
    "after_plan",
    /\b(?:para|parar|detente|pausa|espera)\b[^.;\n]*?\b(?:despues|luego|tras) (?:del?|el) (?:primer )?plan\b/g,
  ],
  [
    "at_end",
    /\b(?:stop|pause|wait)\b[^.;,\n]*?\b(?:at the end|before (?:you )?(?:finish|finishing|close|closing))\b/g,
  ],
  ["at_end", /\b(?:except|but|only) at the end\b/g],
  ["at_end", /\b(?:para|parar|detente|pausa|espera)\b[^.;\n]*?\bal final\b/g],
  ["at_end", /\bantes de (?:terminar|cerrar|acabar)\b/g],
  ["on_audit_failure", /\b(?:if|when|on) (?:an |the |any )?audits? fails?\b/g],
  ["on_audit_failure", /\baudit failures?\b/g],
  ["on_audit_failure", /\b(?:si|cuando) falla (?:una |la |alguna )?auditoria\b/g],
];
const BUDGET_PHRASES: readonly RegExp[] = [
  /\b(\d{1,3}) ?% of (?:the )?(?:token )?budget\b/g,
  /\b(\d{1,3}) ?% del presupuesto\b/g,
];
const NO_STOP_PHRASES: readonly RegExp[] = [
  /\b(?:don'?t|do not|never) stop\b/,
  /\bautonomous(?:ly)?\b/,
  /\bwithout (?:any )?stops?\b/,
  /\bno stops\b/,
  /\bnon-?stop\b/,
  /\bno (?:pares|te detengas|parar|te pares)\b/,
  /\bsin (?:paradas|parar|detenerte|pausas)\b/,
  /\bautonom[oa]\b/,
];

const STOP_TEXT: Readonly<Record<string, string>> = {
  after_plan: "after the orchestrator's first plan",
  at_end: "before the workflow is declared complete",
  on_audit_failure: "when an auditor runs out of retries",
  before_merge: "before branches are merged",
};

function stopText(stop: string): string {
  const known = STOP_TEXT[stop];
  if (known !== undefined) return known;
  if (stop.startsWith("on_budget_pct:"))
    return `at ${stop.slice("on_budget_pct:".length)}% of the token budget`;
  if (stop.startsWith("after_node:"))
    return `when the delegator ${stop.slice("after_node:".length)} closes`;
  return stop;
}

function folded(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").normalize("NFD").replace(/\p{M}/gu, "");
}

// What the message says about stops: `said` is false when it says nothing, and then there is no stop (the workflow runs
// at once). A named stop wins over a no-stop phrase ("don't stop, except at the end" stops at the end). Stops come in
// the order the message names them.
export function readAutonomy(text: string): { readonly said: boolean; readonly stops: string[] } {
  const found: { stop: string; at: number }[] = [];
  for (const match of text.matchAll(STOP_TOKEN)) {
    const token = match[1] ?? "";
    const stop = token.toLowerCase().startsWith("after_node:")
      ? `after_node:${token.slice("after_node:".length)}`
      : token.toLowerCase();
    found.push({ stop, at: match.index ?? 0 });
  }
  const plain = folded(text);
  for (const [stop, pattern] of STOP_PHRASES) {
    for (const match of plain.matchAll(pattern)) found.push({ stop, at: match.index ?? 0 });
  }
  for (const pattern of BUDGET_PHRASES) {
    for (const match of plain.matchAll(pattern)) {
      const percent = Number(match[1]);
      if (Number.isInteger(percent) && percent >= 1 && percent <= 100) {
        found.push({ stop: `on_budget_pct:${percent}`, at: match.index ?? 0 });
      }
    }
  }
  const stops = [...new Set(found.sort((a, b) => a.at - b.at).map((item) => item.stop))];
  if (stops.length > 0) return { said: true, stops };
  if (NO_STOP_PHRASES.some((pattern) => pattern.test(plain))) return { said: true, stops: [] };
  return { said: false, stops: [] };
}

export function createCard(
  goal: string,
  model: string | undefined,
  preflight?: DelegateCard["preflight"],
): DelegateCard {
  const read = readAutonomy(goal);
  const rows = [
    ...USUAL_STOPS,
    ...read.stops.filter((stop) => !(USUAL_STOPS as readonly string[]).includes(stop)),
  ];
  return {
    goal: goal.trim(),
    model: model === undefined || model.trim() === "" ? undefined : model.trim(),
    preflight,
    stops: rows.map((stop) => ({ stop, on: read.stops.includes(stop) })),
    cursor: 0,
  };
}

export function selectedStops(card: DelegateCard): string[] {
  return card.stops.filter((row) => row.on).map((row) => row.stop);
}

// Why the card cannot start yet, or undefined when it can.
export function cardProblem(card: DelegateCard): string | undefined {
  if (card.goal === "") return "the workflow needs a goal";
  if (card.model === undefined) return "choose the orchestrator's model first (M): a high model";
  return undefined;
}

// `haril workflow start` for the card: real agents, the pinned model, the stops (none: --autonomous).
export function workflowStartArgs(card: DelegateCard, projectSlug: string): string[] {
  const stops = selectedStops(card);
  return [
    "workflow",
    "start",
    "--goal",
    card.goal,
    "--model",
    card.model ?? "",
    "--agent",
    "orchestrator",
    ...(stops.length === 0 ? ["--autonomous"] : ["--stop-at", stops.join(",")]),
    "--project",
    projectSlug,
    "--intake-stdin",
    "--json",
  ];
}

function toggle(card: DelegateCard, index: number): DelegateCard {
  return {
    ...card,
    cursor: index,
    stops: card.stops.map((row, at) => (at === index ? { ...row, on: !row.on } : row)),
  };
}

// Autonomous when a stop is checked, else back to the default stop after the first plan.
function toggleAutonomy(card: DelegateCard): DelegateCard {
  const any = card.stops.some((row) => row.on);
  return {
    ...card,
    stops: card.stops.map((row) => ({ ...row, on: !any && row.stop === "after_plan" })),
  };
}

export function cardClick(card: DelegateCard, target: CardTarget): CardStep {
  switch (target.kind) {
    case "stop":
      return { card: toggle(card, target.index), handled: true };
    case "autonomy":
      return { card: toggleAutonomy(card), handled: true };
    case "model":
      return { card, effect: "choose-model", handled: true };
    case "cancel":
      return { card, effect: "cancel", handled: true };
    case "start":
      return cardProblem(card) === undefined
        ? { card, effect: "start", handled: true }
        : { card, handled: true };
  }
}

export function cardKey(card: DelegateCard, data: string): CardStep {
  const key = keyOf(data);
  const last = Math.max(0, card.stops.length - 1);
  switch (key) {
    case "up":
    case "k":
      return { card: { ...card, cursor: Math.max(0, card.cursor - 1) }, handled: true };
    case "down":
    case "j":
      return { card: { ...card, cursor: Math.min(last, card.cursor + 1) }, handled: true };
    case " ":
      return { card: toggle(card, card.cursor), handled: true };
    case "a":
      return cardClick(card, { kind: "autonomy" });
    case "m":
      return cardClick(card, { kind: "model" });
    case "enter":
      return cardClick(card, { kind: "start" });
    case "escape":
      return cardClick(card, { kind: "cancel" });
    default:
      return { card, handled: false };
  }
}

interface Segment {
  readonly text: string;
  readonly tone: ThemeColor;
  readonly bold?: boolean;
  readonly target?: CardTarget;
}

// The card as lines fitted to `width`, with the hit-boxes of its stops and buttons.
export function renderCard(
  card: DelegateCard,
  width: number,
  theme: ConsoleTheme,
): { readonly lines: string[]; readonly hits: CardHit[] } {
  const lines: string[] = [];
  const hits: CardHit[] = [];
  const room = Math.max(1, width - 2 * MARGIN);
  const push = (segments: readonly Segment[]): void => {
    let column = 0;
    let line = " ".repeat(MARGIN);
    for (const segment of segments) {
      const left = room - column;
      if (left <= 0) break;
      const text = truncate(segment.text, left);
      const size = textWidth(text);
      if (segment.target !== undefined && size > 0) {
        hits.push({
          row: lines.length,
          start: MARGIN + column,
          end: MARGIN + column + size,
          target: segment.target,
        });
      }
      line += theme.fg(segment.tone, segment.bold === true ? theme.bold(text) : text);
      column += size;
    }
    lines.push(line);
  };
  // Labels are bold accent, values plain text: the two read apart at a glance.
  const label = (text: string): Segment => ({
    text: text.padEnd(LABEL_WIDTH),
    tone: "accent",
    bold: true,
  });
  const blank = (): void => push([{ text: "", tone: "dim" }]);
  const rule = (): void => push([{ text: "─".repeat(room), tone: "dim" }]);
  const valueWidth = Math.max(1, room - LABEL_WIDTH);

  blank();
  push([
    {
      text: "◆ DELEGATE · start a three-layer workflow with real agents",
      tone: "warning",
      bold: true,
    },
  ]);
  rule();
  blank();
  const goal = wrap(plainText(card.goal).replace(/\s+/g, " "), valueWidth);
  const shownGoal = goal.slice(0, GOAL_LINES);
  if (goal.length > GOAL_LINES && shownGoal.length > 0) {
    shownGoal[GOAL_LINES - 1] = truncate(`${shownGoal[GOAL_LINES - 1] ?? ""}…`, valueWidth);
  }
  shownGoal.forEach((line, index) => {
    push([index === 0 ? label("Goal") : label(""), { text: line, tone: "text" }]);
  });
  push([
    label("Model"),
    card.model === undefined
      ? { text: "none: choose one, a high model ", tone: "error" }
      : { text: `${plainText(card.model)} `, tone: "text" },
    { text: "[M Model]", tone: "accent", target: { kind: "model" } },
  ]);
  const stops = selectedStops(card);
  push([
    label("Autonomy"),
    {
      text: stops.length === 0 ? "autonomous: no stops " : `with stops: ${stops.join(", ")} `,
      tone: "text",
      target: { kind: "autonomy" },
    },
  ]);
  card.stops.forEach((row, index) => {
    const pointer = index === card.cursor ? "▸ " : "  ";
    push([
      index === 0 ? label("Stops") : label(""),
      {
        text: `${pointer}[${row.on ? "x" : " "}] ${row.stop.padEnd(18)} ${stopText(row.stop)}`,
        tone: row.on ? "text" : "muted",
        target: { kind: "stop", index },
      },
    ]);
  });
  blank();
  push([label("Agents"), { text: "real agents (--agent orchestrator)", tone: "text" }]);
  if (card.preflight !== undefined) {
    push([label("Mode"), { text: "Implementation · Git worktree listing checked", tone: "text" }]);
    push([label("Base"), { text: plainText(card.preflight.baseBranch), tone: "text" }]);
    push([
      label("Test"),
      { text: `${plainText(card.preflight.testCommand)} allowed · not run`, tone: "text" },
    ]);
    push([label("Write"), { text: "worktree creation pending runtime", tone: "muted" }]);
  }
  push([
    label("Limits"),
    { text: "HARIL's defaults, frozen at start (haril workflow show)", tone: "text" },
  ]);
  push([label("Quota"), { text: "not available yet", tone: "muted" }]);
  blank();
  push([
    { text: "Agents may add stops; only you remove them. /continue lifts a stop.", tone: "muted" },
  ]);
  const problem = cardProblem(card);
  if (problem !== undefined) push([{ text: `! ${problem}`, tone: "error" }]);
  rule();
  push([
    {
      text: "[Enter Start]",
      tone: problem === undefined ? "success" : "dim",
      target: { kind: "start" },
    },
    { text: "  ", tone: "dim" },
    { text: "[M Model]", tone: "accent", target: { kind: "model" } },
    { text: "  ", tone: "dim" },
    { text: "[Space Toggle]", tone: "accent", target: { kind: "stop", index: card.cursor } },
    { text: "  ", tone: "dim" },
    { text: "[A Autonomous]", tone: "accent", target: { kind: "autonomy" } },
    { text: "  ", tone: "dim" },
    { text: "[Esc Cancel]", tone: "error", target: { kind: "cancel" } },
  ]);
  blank();
  return { lines, hits };
}
