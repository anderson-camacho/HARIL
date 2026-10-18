import { plainText, truncate } from "./text.js";

// The CONSULT trace (docs/modos-y-delegacion.md 7.3 point 7, R-U7): what the model did in one run and how, in short
// form. The tool_call guard notes every call (and every blocked one), tool_result its outcome, message_end the tokens;
// after agent_end the console draws it in the chat as a session entry the model never sees. It keeps what a call acted
// on (a path, a pattern, a title) and a short result (a line count, the first line of an error), never what a call
// read or wrote.

const TARGET_MAX = 72;
const ERROR_MAX = 80;

type CallStatus = "running" | "ok" | "error" | "blocked";

interface TraceCall {
  readonly id: string;
  readonly tool: string;
  readonly target: string;
  readonly status: CallStatus;
  readonly result: string;
}

export interface Trace {
  readonly startedAt: number;
  readonly calls: readonly TraceCall[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  // Replies that did not report their tokens (counted apart, never as 0).
  readonly unreported: number;
  readonly replies: number;
  readonly research: readonly string[];
}

export function createTrace(now: number): Trace {
  return {
    startedAt: now,
    calls: [],
    tokensIn: 0,
    tokensOut: 0,
    unreported: 0,
    replies: 0,
    research: [],
  };
}

function field(input: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function short(text: string, max: number): string {
  return truncate(plainText(text).replace(/\s+/g, " ").trim(), max);
}

// What a call acted on, by tool: the path read, the pattern searched and where, the research title.
function targetOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const path = field(input, "path");
  switch (tool) {
    case "read":
      return short(path ?? "?", TARGET_MAX);
    case "grep":
    case "find": {
      const pattern = field(input, "pattern");
      const where = path ?? field(input, "glob");
      return short(
        `${pattern === undefined ? "?" : `"${pattern}"`}${where === undefined ? "" : ` in ${where}`}`,
        TARGET_MAX,
      );
    }
    case "ls":
      return short(path ?? ".", TARGET_MAX);
    case "haril_save_research": {
      const title = field(input, "title");
      return short(title === undefined ? "?" : `"${title}"`, TARGET_MAX);
    }
    default:
      return short(path ?? field(input, "command") ?? Object.keys(input).join(", "), TARGET_MAX);
  }
}

function textOf(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

function lineCount(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? 0 : trimmed.split(/\r?\n/).length;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// The short result of a call that ran: what it returned, counted the way its tool's output is shaped.
function resultOf(tool: string, isError: boolean, text: string): string {
  if (isError) return short(text.split(/\r?\n/)[0] ?? "", ERROR_MAX) || "failed";
  const lines = lineCount(text);
  switch (tool) {
    case "read":
      return plural(lines, "line", "lines");
    case "grep":
      return plural(lines, "match", "matches");
    case "find":
      return plural(lines, "path", "paths");
    case "ls":
      return plural(lines, "entry", "entries");
    case "haril_save_research":
      return short(text, ERROR_MAX);
    default:
      return plural(lines, "line", "lines");
  }
}

export function traceToolCall(
  trace: Trace,
  call: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input: Readonly<Record<string, unknown>>;
  },
  blockedReason?: string,
): Trace {
  const entry: TraceCall = {
    id: call.toolCallId,
    tool: plainText(call.toolName),
    target: targetOf(call.toolName, call.input),
    status: blockedReason === undefined ? "running" : "blocked",
    result: blockedReason === undefined ? "" : short(blockedReason, ERROR_MAX),
  };
  return { ...trace, calls: [...trace.calls, entry] };
}

export function traceToolResult(
  trace: Trace,
  result: {
    readonly toolCallId: string;
    readonly isError: boolean;
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  },
): Trace {
  return {
    ...trace,
    calls: trace.calls.map((call) =>
      call.id === result.toolCallId && call.status === "running"
        ? {
            ...call,
            status: result.isError ? "error" : "ok",
            result: resultOf(call.tool, result.isError, textOf(result.content)),
          }
        : call,
    ),
  };
}

export function traceUsage(
  trace: Trace,
  usage: { readonly tokensIn: number | null; readonly tokensOut: number | null },
): Trace {
  const reported = usage.tokensIn !== null || usage.tokensOut !== null;
  return {
    ...trace,
    replies: trace.replies + 1,
    tokensIn: trace.tokensIn + (usage.tokensIn ?? 0),
    tokensOut: trace.tokensOut + (usage.tokensOut ?? 0),
    unreported: trace.unreported + (reported ? 0 : 1),
  };
}

export function traceResearch(trace: Trace, path: string): Trace {
  return { ...trace, research: [...trace.research, plainText(path)] };
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function tokensLine(trace: Trace): string {
  if (trace.replies === 0 || trace.unreported === trace.replies) return "Tokens: not reported";
  const missing =
    trace.unreported === 0
      ? ""
      : ` (${plural(trace.unreported, "reply did not report it", "replies did not report it")})`;
  return `Tokens: ${trace.tokensIn} in · ${trace.tokensOut} out${missing}`;
}

// The trace as plain lines: a header, one line per call, then the totals. `now` closes the run's time.
export function renderTrace(trace: Trace, now: number): string[] {
  const blocked = trace.calls.filter((call) => call.status === "blocked").length;
  const head = [
    "◆ CONSULT trace",
    trace.calls.length === 0
      ? "no tool calls"
      : plural(trace.calls.length, "tool call", "tool calls"),
    ...(blocked > 0 ? [`${blocked} blocked`] : []),
    seconds(now - trace.startedAt),
  ].join(" · ");
  const width = Math.max(4, ...trace.calls.map((call) => call.tool.length));
  const rows = trace.calls.map((call) => {
    const status =
      call.status === "running"
        ? "no result"
        : `${call.status}${call.result === "" ? "" : ` · ${call.result}`}`;
    return `  ${call.tool.padEnd(width)}  ${call.target}  →  ${status}`;
  });
  const counts = new Map<string, number>();
  for (const call of trace.calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  const files = [
    ...new Set(trace.calls.filter((call) => call.tool === "read").map((call) => call.target)),
  ];
  const searches = trace.calls
    .filter((call) => call.tool === "grep" || call.tool === "find")
    .map((call) => `${call.tool} ${call.target}`);
  const totals = [
    ...(counts.size === 0
      ? []
      : [`Tools: ${[...counts].map(([tool, count]) => `${tool} ×${count}`).join(", ")}`]),
    ...(files.length === 0 ? [] : [`Files read: ${files.join(", ")}`]),
    ...(searches.length === 0 ? [] : [`Searches: ${searches.join("; ")}`]),
    tokensLine(trace),
    ...(trace.research.length === 0 ? [] : [`Research saved: ${trace.research.join(", ")}`]),
  ];
  return [head, ...rows, ...totals];
}
