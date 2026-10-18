// The four console modes (F4, docs/modos-y-delegacion.md 7.1-7.5), as pure rules the console applies:
// - ACTION: Pi as it is, every tool the user has; the model is chosen with /model.
// - CONSULT: read-only. Only read, grep, find, ls and haril_save_research (the one write: a Markdown research file in
//   the project's research folder). Every other tool is blocked, deny by default, whoever registered it (Pi, another
//   extension, an MCP server), even if something turns it back on; the HARIL commands and console actions that change
//   state are refused. bash and powershell are out entirely: a read-only shell cannot be guaranteed.
// - PLAN: the same read-only tools, and the model builds a plan from the conversation; /goal hands it to the planner.
// - DELEGATION: what the user types opens the /delegate card for a three-layer workflow; the chat is read-only and has
//   no research tool.
// The console keeps the tools that were active before a read-only mode and gives them back when it leaves.

export type ConsoleMode = "action" | "consult" | "plan" | "delegation";

// The orders log vocabulary (packages/core ports/usage-log.ts OrderMode), which the console writes through the CLI.
type OrderMode = "accion" | "consulta" | "plan" | "delegacion";

export const CONSOLE_MODES: readonly ConsoleMode[] = ["action", "consult", "plan", "delegation"];
export const RESEARCH_TOOL = "haril_save_research";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
// Pi 1.2.0's default active tools (docs/cli.md), used when a read-only mode is left with nothing saved to restore.
const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const;

const LABELS: Readonly<Record<ConsoleMode, string>> = {
  action: "ACTION",
  consult: "CONSULT",
  plan: "PLAN",
  delegation: "DELEGATION",
};

const ORDER_MODES: Readonly<Record<ConsoleMode, OrderMode>> = {
  action: "accion",
  consult: "consulta",
  plan: "plan",
  delegation: "delegacion",
};

const DESCRIPTIONS: Readonly<Record<ConsoleMode, string>> = {
  action: "work as usual with every tool; pick the model with /model",
  consult: "read-only: nothing changes; it shows a trace and can save a Markdown research file",
  plan: "read-only: build a plan from the conversation; /goal hands it to the planner",
  delegation: "what you type opens the /delegate card for a three-layer workflow",
};

// The names /mode accepts: the English and Spanish names, without accents, and a one-letter alias.
const ALIASES: Readonly<Record<string, ConsoleMode>> = {
  action: "action",
  accion: "action",
  a: "action",
  consult: "consult",
  consulta: "consult",
  ask: "consult",
  c: "consult",
  plan: "plan",
  p: "plan",
  delegation: "delegation",
  delegacion: "delegation",
  delegate: "delegation",
  d: "delegation",
};

// The tools each read-only mode allows; ACTION has no list (no restriction).
const PERMITTED: Readonly<Record<ConsoleMode, readonly string[] | undefined>> = {
  action: undefined,
  consult: [...READ_ONLY_TOOLS, RESEARCH_TOOL],
  plan: [...READ_ONLY_TOOLS, RESEARCH_TOOL],
  delegation: [...READ_ONLY_TOOLS],
};

// The HARIL commands that change state, refused in CONSULT; /tasks, /task, /events, /plans and /plan stay.
const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "goal",
  "approve",
  "deny",
  "delegate",
  "continue",
]);

// The console actions (the /haril menu and the panel controls) that change state, refused in CONSULT. Reviewing
// approvals leads to approving or denying, and toggling tools could turn a write tool back on. The stops stay: they
// are the human's safety, not a change the model makes.
const MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  "register-project",
  "approvals",
  "goal",
  "run-queue",
  "start-runtime",
  "toggle-tools",
]);

export function modeLabel(mode: ConsoleMode): string {
  return LABELS[mode];
}

export function modeDescription(mode: ConsoleMode): string {
  return DESCRIPTIONS[mode];
}

export function orderModeOf(mode: ConsoleMode): OrderMode {
  return ORDER_MODES[mode];
}

export function parseMode(text: string): ConsoleMode | undefined {
  const key = text.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : undefined;
}

export function nextMode(mode: ConsoleMode): ConsoleMode {
  const index = CONSOLE_MODES.indexOf(mode);
  return CONSOLE_MODES[(index + 1) % CONSOLE_MODES.length] ?? "action";
}

export function isReadOnly(mode: ConsoleMode): boolean {
  return PERMITTED[mode] !== undefined;
}

// The tool_call guard: in a read-only mode every tool that is not on its list is blocked, exact names only.
export function checkToolCall(
  mode: ConsoleMode,
  toolName: string,
): { readonly block: true; readonly reason: string } | undefined {
  const permitted = PERMITTED[mode];
  if (permitted === undefined || permitted.includes(toolName)) return undefined;
  return {
    block: true,
    reason: `${LABELS[mode]} mode is read-only: the tool "${toolName}" is not allowed (allowed: ${permitted.join(", ")}). Switch with /mode action to change files.`,
  };
}

export function commandRefusal(mode: ConsoleMode, name: string): string | undefined {
  if (mode !== "consult" || !MUTATING_COMMANDS.has(name)) return undefined;
  return `CONSULT mode is read-only: /${name} changes HARIL state. Switch with /mode action (or Alt+M) first.`;
}

export function actionRefusal(mode: ConsoleMode, action: string): string | undefined {
  if (mode !== "consult" || !MUTATING_ACTIONS.has(action)) return undefined;
  return "CONSULT mode is read-only: this action changes state. Switch with /mode action (or Alt+M) first.";
}

export interface ModeState {
  readonly mode: ConsoleMode;
  // The tools active before the console entered a read-only mode, given back when it leaves; undefined in ACTION.
  readonly toolsBefore: readonly string[] | undefined;
}

export function initialModeState(): ModeState {
  return { mode: "action", toolsBefore: undefined };
}

// A switch: the new state and the tools to activate, or undefined to leave the active tools as they are. `active` is
// what Pi has active now, `registered` every tool Pi knows (setActiveTools ignores unknown names; this keeps the list
// honest). The research tool never passes to ACTION.
export function switchMode(
  state: ModeState,
  next: ConsoleMode,
  active: readonly string[],
  registered: readonly string[],
): { readonly state: ModeState; readonly tools: string[] | undefined } {
  if (next === state.mode) return { state, tools: undefined };
  const known = new Set(registered);
  const permitted = PERMITTED[next];
  if (permitted !== undefined) {
    const toolsBefore = state.toolsBefore ?? active.filter((name) => name !== RESEARCH_TOOL);
    return {
      state: { mode: next, toolsBefore },
      tools: permitted.filter((name) => known.has(name)),
    };
  }
  if (state.toolsBefore === undefined)
    return { state: { mode: next, toolsBefore: undefined }, tools: undefined };
  const restore = state.toolsBefore.filter((name) => name !== RESEARCH_TOOL);
  return {
    state: { mode: next, toolsBefore: undefined },
    tools: restore.length > 0 ? restore : PI_DEFAULT_TOOLS.filter((name) => known.has(name)),
  };
}

// What the model is told about the mode, added to the system prompt of each run (before_agent_start).
export function modeInstruction(mode: ConsoleMode): string | undefined {
  switch (mode) {
    case "action":
      return undefined;
    case "consult":
      return [
        "[HARIL CONSULT mode] This session is read-only. You may read and search the project with read, grep, find and ls; any other tool is blocked.",
        "Do not try to change files, run commands or start work. Answer from what you read, and say which files you read.",
        `Only when the user asks for a research document, save it with ${RESEARCH_TOOL} (a title and Markdown content): it is the only write allowed and it never overwrites a file.`,
      ].join("\n");
    case "plan":
      return [
        "[HARIL PLAN mode] This session is read-only: read, grep, find and ls only.",
        "Build a plan from the conversation: the goal, numbered steps, the files involved, the tests, the risks and the open questions. Do not change anything.",
        `To carry it out, the user switches with /mode action and asks for it, or sends it to the HARIL planner with /goal. ${RESEARCH_TOOL} saves the plan as a Markdown file when the user asks.`,
      ].join("\n");
    case "delegation":
      return [
        "[HARIL DELEGATION mode] What the user types opens the /delegate card that starts a three-layer workflow; this chat is read-only (read, grep, find, ls).",
        "Help shape the goal and the stops; do not change anything yourself.",
      ].join("\n");
  }
}
