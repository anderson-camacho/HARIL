import { type BodyLine, roleLabel } from "./factory-board.js";
import { type FactoryGlyphs, type FactoryToken, factoryCell } from "./factory-kit.js";
import { agentRows, selectedRowId } from "./factory-rows.js";
import type { FactoryState } from "./factory-state.js";
import type { FactoryAgent, FactoryModel } from "./factory-types.js";
import { textWidth } from "./text.js";

// The Agentes tab: a process list as in htop (cpu-cores), with two meters on top and a tree toggle. Tokens are exact: a
// rounded number here would hide what a run costs.

const STATUS_TOKEN: Readonly<Record<string, FactoryToken>> = {
  running: "green",
  waiting: "yellow",
  queued: "muted",
  done: "dim",
  failed: "red",
  cancelled: "dim",
  awaiting_human: "yellow",
  closed: "red",
};

export function elapsedText(ms: number | null): string {
  if (ms === null) return "n/d";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export function contextText(
  context: { readonly used: number; readonly threshold: number } | null,
): string {
  if (context === null || context.threshold <= 0) return "n/d";
  return `${Math.round((context.used / context.threshold) * 100)}%`;
}

interface Columns {
  readonly tokens: number;
  readonly context: number;
  readonly time: number;
  readonly role: number;
}

function columnsOf(width: number): Columns {
  return width >= 76
    ? { tokens: 9, context: 6, time: 7, role: 12 }
    : width >= 50
      ? { tokens: 9, context: 5, time: 0, role: 0 }
      : { tokens: 8, context: 0, time: 0, role: 0 };
}

const CODE_WIDTH = 9;

// A sibling list by parent: the branch glyph of a row in the tree view.
function treePrefix(agent: FactoryAgent, rows: readonly FactoryAgent[], g: FactoryGlyphs): string {
  if (agent.parent === null) return "";
  const siblings = rows.filter(
    (row) => row.workflowId === agent.workflowId && row.parent === agent.parent,
  );
  const last = siblings[siblings.length - 1] === agent;
  return `${" ".repeat(Math.max(0, agent.depth - 1))}${last ? g.lastBranch : g.branch}`;
}

function agentLine(
  agent: FactoryAgent,
  rows: readonly FactoryAgent[],
  state: FactoryState,
  selected: boolean,
  width: number,
  g: FactoryGlyphs,
): BodyLine {
  const columns = columnsOf(width);
  const code = state.agentsTree ? `${treePrefix(agent, rows, g)}${agent.code}` : agent.code;
  const fixed = 2 + CODE_WIDTH + columns.role + columns.tokens + columns.context + columns.time;
  const task = `${agent.model ?? "sin modelo"} ${agent.task}`;
  const token: FactoryToken = selected ? "blue" : (STATUS_TOKEN[agent.status] ?? "text");
  return [
    { text: selected ? `${g.pointer} ` : "  ", token: "blue" },
    factoryCell(code, CODE_WIDTH, token),
    ...(columns.role > 0 ? [factoryCell<never>(roleLabel(agent.role), columns.role, "muted")] : []),
    factoryCell(String(agent.tokens), columns.tokens - 1, "text", true),
    { text: " ", token: "dim" },
    ...(columns.context > 0
      ? [factoryCell<never>(contextText(agent.context), columns.context, "muted")]
      : []),
    ...(columns.time > 0
      ? [factoryCell<never>(elapsedText(agent.elapsedMs), columns.time, "muted")]
      : []),
    factoryCell(task, Math.max(0, width - fixed), selected ? "blue" : "muted"),
  ];
}

function headerLine(width: number): BodyLine {
  const columns = columnsOf(width);
  const fixed = 2 + CODE_WIDTH + columns.role + columns.tokens + columns.context + columns.time;
  return [
    factoryCell("  AGENTE", 2 + CODE_WIDTH, "green"),
    ...(columns.role > 0 ? [factoryCell<never>("ROL", columns.role, "green")] : []),
    factoryCell("TOKENS", columns.tokens - 1, "green", true),
    { text: " ", token: "dim" },
    ...(columns.context > 0 ? [factoryCell<never>("CTX", columns.context, "green")] : []),
    ...(columns.time > 0 ? [factoryCell<never>("TIEMPO", columns.time, "green")] : []),
    factoryCell("MODELO Y TAREA", Math.max(0, width - fixed), "green"),
  ];
}

// `Agentes[|||||      5/20]`, as cpu-cores draws its meters. Without a limit it only says the count.
function meter(label: string, value: number, max: number | null, width: number): BodyLine {
  const room = Math.max(0, width - textWidth(label) - 2);
  const tail = max === null ? String(value) : `${value}/${max}`;
  const ratio = max === null || max <= 0 ? 0 : Math.min(1, value / max);
  const bars = Math.max(0, Math.min(room - textWidth(tail), Math.round(ratio * room)));
  const gap = Math.max(0, room - bars - textWidth(tail));
  return [
    { text: label, token: "cyan" },
    { text: "[", token: "text" },
    { text: "|".repeat(bars), token: ratio > 0.8 ? "red" : "green" },
    { text: " ".repeat(gap), token: "dim" },
    factoryCell(tail, Math.max(0, room - bars - gap), "muted"),
    { text: "]", token: "text" },
  ];
}

function meters(model: FactoryModel, width: number): BodyLine[] {
  const live = model.workflows.filter((row) => row.state === "running");
  const shown = live.length > 0 ? live : model.workflows;
  const agents = shown.reduce((sum, row) => sum + row.agentsCreated, 0);
  const cap = shown.reduce((sum, row) => sum + row.agentsCap, 0);
  const tokens = shown.reduce((sum, row) => sum + row.tokensUsed, 0);
  const budgets = shown.map((row) => row.tokensBudget);
  const budget = budgets.includes(null)
    ? null
    : budgets.reduce<number>((sum, row) => sum + (row ?? 0), 0);
  return [
    meter("Agentes", agents, cap > 0 ? cap : null, width),
    meter("Tokens ", tokens, budget, width),
  ];
}

export function agentsBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const rows = agentRows(state);
  if (model.agents.length === 0) {
    return [[factoryCell("  Sin agentes todavía.", width, "muted")]];
  }
  const top = height >= 8 ? meters(model, width) : [];
  const head = [...top, headerLine(width)];
  const room = Math.max(1, height - head.length);
  const selected = state.selection.agentes;
  const start = Math.max(0, Math.min(selected - room + 1, rows.length - room));
  const selectedId = selectedRowId(state, "agentes").id;
  const lines = rows
    .slice(start, start + room)
    .map((agent) =>
      agentLine(agent, rows, state, `${agent.workflowId}/${agent.code}` === selectedId, width, g),
    );
  return [...head, ...lines];
}
