import {
  type ConsoleMode,
  checkToolCall,
  initialModeState,
  isReadOnly,
  type ModeState,
  modeDescription,
  modeInstruction,
  modeLabel,
  nextMode,
  PLAN_TOOL,
  RESEARCH_TOOL,
  switchMode,
} from "./modes.js";
import type { AgentMessage, ConsoleContext, ConsolePi, SessionEntry } from "./pi-types.js";
import { listPlans, savePlan } from "./plans.js";
import { type SavedResearch, saveResearch } from "./research.js";
import {
  createTrace,
  renderTrace,
  type Trace,
  traceResearch,
  traceToolCall,
  traceToolResult,
  traceUsage,
} from "./trace.js";

// Wires the console modes (modes.ts) into Pi, defense in depth for the read-only modes (7.3):
// 1. setActiveTools narrows the tools to the mode's list (bash, powershell, edit and write are gone);
// 2. a tool_call guard blocks every tool off that list, deny by default, whoever registered it and even if it was
//    turned back on; Pi blocks the call if the guard itself fails;
// 3. before_agent_start tells the model the mode, as a prompt section that extension providers such as claude-bridge
//    also forward;
// 4. a `!` shell command the user types is refused too;
// 5. haril_save_research, the one write, refuses outside CONSULT and PLAN.
// The mode is kept in the session (appendEntry "haril-mode") and comes back on resume or reload. In CONSULT each run
// leaves its trace in the chat (appendEntry "haril-trace", drawn by an entry renderer, never sent to the model); in
// PLAN the plan the model wrote is kept as a session entry ("haril-plan") for /goal. A plan saved to docs/planes
// (haril_save_plan, /save-plan) becomes that plan too, so DELEGATION's "current plan" is the one just saved.

const MODE_ENTRY = "haril-mode";
const TRACE_ENTRY = "haril-trace";
const PLAN_ENTRY = "haril-plan";
const MODE_SECTION = "haril-mode";
// How many saved plan titles DELEGATION names on entry.
const SHOWN_PLANS = 3;

export interface ModeHost {
  // The folder research files go under: the bound project's root, else the folder Pi opened in.
  researchRoot(): string;
  // haril.json's research folder inside that root (delegation.research.folder, P18), when it names one.
  researchFolder?(): Promise<string | undefined>;
  now(): number;
  redraw(): void;
}

export interface ModeController {
  mode(): ConsoleMode;
  // Switches and says so; returns the mode now in force.
  switchTo(next: ConsoleMode, ctx: ConsoleContext | undefined): ConsoleMode;
  cycle(ctx: ConsoleContext | undefined): ConsoleMode;
  // Puts back the mode kept in the session's branch (session_start).
  restore(ctx: ConsoleContext): void;
  // The last plan PLAN mode produced in this session, for /goal.
  lastPlan(): string | undefined;
  // Saves `content` as a plan in docs/planes and keeps it as the session's plan; throws an Error that says why it
  // refused.
  savePlan(title: unknown, content: unknown): SavedResearch;
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function assistantText(message: AgentMessage | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function storedMode(entries: readonly SessionEntry[]): ModeState | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
    const data = entry.data as { mode?: unknown; toolsBefore?: unknown } | undefined;
    const mode = data?.mode;
    if (mode !== "action" && mode !== "consult" && mode !== "plan" && mode !== "delegation")
      return undefined;
    const toolsBefore = Array.isArray(data?.toolsBefore)
      ? data.toolsBefore.filter((name): name is string => typeof name === "string")
      : undefined;
    return { mode, toolsBefore: mode === "action" ? undefined : toolsBefore };
  }
  return undefined;
}

// What DELEGATION says on entry: the saved plans it will offer, newest first, or how to save one.
function savedPlansNote(root: string): string {
  const plans = listPlans(root);
  if (plans.length === 0) {
    return "No saved plan yet: ask the model to save the plan, or /save-plan (--chat keeps the whole conversation)";
  }
  const shown = plans.slice(0, SHOWN_PLANS).map((plan) => plan.title);
  const more = plans.length > SHOWN_PLANS ? ` and ${plans.length - SHOWN_PLANS} more` : "";
  return `${plans.length} saved ${plans.length === 1 ? "plan" : "plans"} (${shown.join(" · ")}${more}): type the goal and pick one to start`;
}

function storedPlan(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== PLAN_ENTRY) continue;
    const text = (entry.data as { text?: unknown } | undefined)?.text;
    return typeof text === "string" && text.trim() !== "" ? text : undefined;
  }
  return undefined;
}

export function installModes(pi: ConsolePi, host: ModeHost): ModeController {
  let state: ModeState = initialModeState();
  let trace: Trace | undefined;
  let plan: string | undefined;

  const registered = (): string[] => safely(() => pi.getAllTools().map((tool) => tool.name), []);

  function keepPlan(text: string): void {
    plan = text;
    safely(() => pi.appendEntry(PLAN_ENTRY, { text, at: host.now() }), undefined);
  }

  function apply(next: ModeState, tools: string[] | undefined): void {
    state = next;
    if (tools !== undefined) safely(() => pi.setActiveTools(tools), undefined);
  }

  const controller: ModeController = {
    mode: () => state.mode,
    switchTo(next, ctx) {
      const step = switchMode(
        state,
        next,
        safely(() => pi.getActiveTools(), []),
        registered(),
      );
      if (step.state === state) return state.mode;
      apply(step.state, step.tools);
      safely(
        () => pi.appendEntry(MODE_ENTRY, { mode: state.mode, toolsBefore: state.toolsBefore }),
        undefined,
      );
      if (ctx?.hasUI === true) {
        ctx.ui.notify(`MODE: ${modeLabel(state.mode)} · ${modeDescription(state.mode)}`, "info");
        if (state.mode === "delegation") ctx.ui.notify(savedPlansNote(host.researchRoot()), "info");
      }
      host.redraw();
      return state.mode;
    },
    cycle(ctx) {
      return controller.switchTo(nextMode(state.mode), ctx);
    },
    restore(ctx) {
      const branch = safely(() => ctx.sessionManager.getBranch(), []);
      plan = storedPlan(branch);
      const kept = storedMode(branch);
      if (kept !== undefined && isReadOnly(kept.mode)) {
        // The saved tools come back on the way out; the read-only set is applied again now.
        const fresh = switchMode(initialModeState(), kept.mode, [], registered());
        apply({ mode: kept.mode, toolsBefore: kept.toolsBefore ?? [] }, fresh.tools);
      } else if (isReadOnly(state.mode)) {
        // A new session without a saved mode starts in ACTION with the tools from before the read-only mode.
        const back = switchMode(state, "action", [], registered());
        apply(back.state, back.tools);
      } else {
        state = initialModeState();
      }
      trace = undefined;
      host.redraw();
    },
    lastPlan: () => plan,
    savePlan(title, content) {
      const saved = savePlan(host.researchRoot(), { title, content }, new Date(host.now()));
      // savePlan refused anything but non-empty text.
      keepPlan(String(content));
      return saved;
    },
  };

  // 2. Deny by default: the verdict comes first, the trace after it, so a trace failure can never unblock a call.
  pi.on("tool_call", (event) => {
    const verdict = checkToolCall(state.mode, event.toolName);
    if (trace !== undefined) {
      const current = trace;
      trace = safely(() => traceToolCall(current, event, verdict?.reason), current);
    }
    return verdict;
  });

  // 3. The mode reaches the model with each run, for that run only, as the prompt section "haril-mode": every provider
  // gets it, and claude-bridge, which drops a replaced system prompt, forwards it. A Pi without sections gets the
  // instruction appended to the system prompt instead.
  pi.on("before_agent_start", (event) => {
    if (state.mode === "consult") trace = createTrace(host.now());
    const instruction = modeInstruction(state.mode);
    const sections = event.systemPromptOptions?.sections;
    if (sections !== undefined) {
      if (instruction === undefined) delete sections[MODE_SECTION];
      else sections[MODE_SECTION] = instruction;
      return undefined;
    }
    if (instruction === undefined) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${instruction}` };
  });

  // The trace follows the messages: a reply's tool calls and tokens, then each tool result.
  pi.on("message_end", (event) => {
    if (trace === undefined) return;
    const current = trace;
    trace = safely(() => traceMessage(current, event.message), current);
  });

  function traceMessage(current: Trace, message: AgentMessage): Trace {
    let next = current;
    if (message.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (
          part.type !== "toolCall" ||
          typeof part.id !== "string" ||
          typeof part.name !== "string"
        )
          continue;
        next = traceToolCall(next, {
          toolCallId: part.id,
          toolName: part.name,
          input: part.arguments ?? {},
        });
      }
      const usage = message.usage;
      const reported = usage !== undefined && ((usage.input ?? 0) > 0 || (usage.output ?? 0) > 0);
      return traceUsage(next, {
        tokensIn: reported ? (usage?.input ?? null) : null,
        tokensOut: reported ? (usage?.output ?? null) : null,
      });
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return next;
    const toolName = message.toolName ?? "";
    // Pi refuses a call to a tool that is not active before any guard runs (the first wall): in a read-only mode such a
    // refusal is a block, and the trace says so.
    const refused = message.isError === true ? checkToolCall(state.mode, toolName) : undefined;
    if (refused !== undefined) {
      return traceToolCall(
        next,
        { toolCallId: message.toolCallId, toolName, input: {} },
        refused.reason,
      );
    }
    return traceToolResult(next, {
      toolCallId: message.toolCallId,
      isError: message.isError === true,
      content: Array.isArray(message.content) ? message.content : [],
    });
  }

  pi.on("agent_end", (event, ctx) => {
    if (trace !== undefined) {
      const lines = renderTrace(trace, host.now());
      trace = undefined;
      safely(() => pi.appendEntry(TRACE_ENTRY, { lines }), undefined);
    }
    if (state.mode !== "plan") return;
    const last = [...(event.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    const text = assistantText(last).trim();
    if (text === "") return;
    keepPlan(text);
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Plan kept in this session: /save-plan saves it for DELEGATION; /goal sends it to the HARIL planner for approval.",
        "info",
      );
    }
  });

  // 4. In a read-only mode the user's own `!` commands do not run either.
  pi.on("user_bash", () => {
    if (!isReadOnly(state.mode)) return undefined;
    return {
      result: {
        output: `${modeLabel(state.mode)} mode is read-only: shell commands do not run. Switch with /mode action (or Alt+M) first.`,
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.registerEntryRenderer(TRACE_ENTRY, (entry, _options, theme) => {
    const lines = (entry.data as { lines?: unknown } | undefined)?.lines;
    if (!Array.isArray(lines)) return undefined;
    const text = lines.filter((line): line is string => typeof line === "string");
    return {
      render: (width: number) =>
        text.map((line, index) =>
          theme.fg(
            index === 0 ? "warning" : "muted",
            line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line,
          ),
        ),
      invalidate() {},
    };
  });

  // 5. The one write of the read-only modes. Inactive until CONSULT or PLAN turns it on, and refused anywhere else.
  pi.registerTool({
    name: RESEARCH_TOOL,
    label: "Save research",
    description:
      "Save a Markdown research document in the project's research folder (docs/investigacion unless haril.json names another). Use it only when the user asks for a research document. Give a short title and the Markdown content; the file name is chosen for you and an existing file is never overwritten.",
    promptSnippet: `${RESEARCH_TOOL}: save a Markdown research document the user asked for`,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short title, not a path" },
        content: { type: "string", description: "The research document in Markdown" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    defaultActive: false,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (state.mode !== "consult" && state.mode !== "plan") {
        throw new Error(`refused: ${RESEARCH_TOOL} works only in CONSULT and PLAN mode`);
      }
      const folder = await host.researchFolder?.();
      const saved = saveResearch(
        host.researchRoot(),
        { title: params.title, content: params.content },
        new Date(host.now()),
        folder,
      );
      if (trace !== undefined) trace = traceResearch(trace, saved.relative);
      return {
        content: [{ type: "text", text: `saved ${saved.relative} (${saved.bytes} bytes)` }],
        details: { path: saved.relative, bytes: saved.bytes },
      };
    },
  });

  // The plan write: active in ACTION, allowed in PLAN and DELEGATION, refused in CONSULT (which only saves research).
  pi.registerTool({
    name: PLAN_TOOL,
    label: "Save plan",
    description:
      "Save a plan as a Markdown file in the project's docs/planes folder, where DELEGATION offers it to start a workflow. Use it when the user asks to save the plan or to take the current conversation as the plan. Give a short title and the full plan in Markdown (goal, numbered steps, files, tests, risks); the file name is chosen for you and an existing file is never overwritten.",
    promptSnippet: `${PLAN_TOOL}: save the plan the user asked to keep, for DELEGATION`,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short title, not a path" },
        content: { type: "string", description: "The full plan in Markdown" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    defaultActive: true,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (state.mode === "consult") {
        throw new Error(`refused: ${PLAN_TOOL} does not work in CONSULT mode`);
      }
      const saved = controller.savePlan(params.title, params.content);
      return {
        content: [
          {
            type: "text",
            text: `saved ${saved.relative} (${saved.bytes} bytes); DELEGATION offers it as a saved plan`,
          },
        ],
        details: { path: saved.relative, bytes: saved.bytes },
      };
    },
  });

  return controller;
}
