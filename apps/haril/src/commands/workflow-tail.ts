import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { visibleText } from "@haril/core";
import type { Store, WorkflowRecord } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { dataDirFor, openExisting } from "./common.js";
import { EXIT_ON_STDIN_END, onStdinEnd } from "./stdin-end.js";
import { type ThreadView, threadsOf } from "./workflow-snapshot.js";

// `haril workflow tail <workflowId> <node>` (docs/modos-y-delegacion.md 7.9, spike S7; phase F5b): what a node's agent
// writes and calls, for the console's live view. Each attempt of a real agent runs Pi with --session-dir
// runs/<runId>/pi, where Pi appends one whole JSON line per message (session, model_change, thinking_level_change and
// message entries with the roles system, user, assistant and toolResult). This reads the session of the node's current
// or latest run and prints each entry in short form: prompts, the assistant's text, its tool calls, the results and the
// tokens of each reply. --follow keeps reading while the file grows (a half-written last line waits for its end), moves
// to the next run when the node starts another turn (the previous run read to its end first), and ends once the
// workflow ended, or on Ctrl+C, or with --exit-on-stdin-end when its stdin ends (the console that runs it went away).
// --json prints one
// object per line ({at, kind, text, tokensIn?, tokensOut?}); `at` is null for a line about the run itself. What an agent
// wrote is data: whitespace is folded and every control character shown as "?", so nothing reaches the terminal as a
// command. The text stays on this machine: it is never written to the usage log.

const USAGE =
  "usage: haril workflow tail <workflowId> <node> [--follow] [--json] [--interval-ms <n>] [--exit-on-stdin-end] [--data-dir <path>]";
const DEFAULT_INTERVAL_MS = 250;
const MAX_TEXT = 300;
const RUNS_DIR = "runs";
const SESSION_DIR = "pi";
const ENDED = new Set<WorkflowRecord["state"]>(["completed", "failed", "stopped"]);
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";
const NEWLINE = 0x0a;

type TailKind =
  | "run"
  | "note"
  | "session"
  | "model"
  | "thinking"
  | "system"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "result"
  | "tokens"
  | "error"
  | "entry";

export interface TailLine {
  readonly at: number | null;
  readonly kind: TailKind;
  readonly text: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

function fail(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Folds whitespace, shows every control character as "?" and cuts the text to `max` characters.
function short(text: string, max = MAX_TEXT): string {
  const shown = visibleText(text.replace(/\s+/g, " ").trim());
  const chars = Array.from(shown);
  return chars.length <= max ? shown : `${chars.slice(0, max - 1).join("")}…`;
}

function timeOf(entry: Record<string, unknown>): number | null {
  const value = entry.timestamp;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter((text) => text !== "")
    .join(" ");
}

function argumentsOf(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assistantLines(message: Record<string, unknown>, at: number | null): TailLine[] {
  const lines: TailLine[] = [];
  const content = Array.isArray(message.content) ? message.content : [message.content];
  for (const part of content) {
    if (typeof part === "string") {
      if (part.trim() !== "") lines.push({ at, kind: "assistant", text: short(part) });
      continue;
    }
    const item = record(part);
    if (item === undefined) continue;
    if (item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") {
      lines.push({ at, kind: "assistant", text: short(item.text) });
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      lines.push({ at, kind: "reasoning", text: short(item.thinking) });
    } else if (item.type === "toolCall") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const args = argumentsOf(item.arguments);
      lines.push({ at, kind: "tool", text: short(args === "" ? name : `${name} ${args}`) });
    }
  }
  const usage = record(message.usage);
  const tokensIn = count(usage?.input);
  const tokensOut = count(usage?.output);
  if (tokensIn !== undefined || tokensOut !== undefined) {
    lines.push({
      at,
      kind: "tokens",
      text: `in ${tokensIn ?? "n/a"} · out ${tokensOut ?? "n/a"}`,
      ...(tokensIn === undefined ? {} : { tokensIn }),
      ...(tokensOut === undefined ? {} : { tokensOut }),
    });
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const why =
      typeof message.errorMessage === "string" ? message.errorMessage : message.stopReason;
    lines.push({ at, kind: "error", text: short(String(why)) });
  }
  return lines;
}

// The short lines of one entry of a Pi session file (S7). An entry it does not know is named by its type.
export function sessionLines(entry: unknown): TailLine[] {
  const item = record(entry);
  if (item === undefined) return [];
  const at = timeOf(item);
  switch (item.type) {
    case "session":
      return [{ at, kind: "session", text: "session started" }];
    case "model_change":
      return [
        {
          at,
          kind: "model",
          text: short(`${String(item.provider ?? "?")}/${String(item.modelId ?? "?")}`),
        },
      ];
    case "thinking_level_change":
      return [{ at, kind: "thinking", text: short(`level ${String(item.thinkingLevel ?? "?")}`) }];
    case "message":
      break;
    default:
      return [{ at, kind: "entry", text: short(String(item.type ?? "unknown entry")) }];
  }
  const message = record(item.message);
  if (message === undefined) return [];
  const atMessage = at ?? timeOf(message);
  switch (message.role) {
    case "system": {
      // Pi keeps the prompt in content, or in named sections with an empty content.
      const sections = Object.values(record(message.sections) ?? {}).filter(
        (value): value is string => typeof value === "string",
      );
      const length =
        Array.from(textOf(message.content)).length ||
        sections.reduce((sum, value) => sum + Array.from(value).length, 0);
      return [{ at: atMessage, kind: "system", text: `system prompt, ${length} characters` }];
    }
    case "user":
      return [{ at: atMessage, kind: "user", text: short(textOf(message.content)) }];
    case "assistant":
      return assistantLines(message, atMessage);
    case "toolResult": {
      const name = typeof message.toolName === "string" ? message.toolName : "tool";
      const outcome = message.isError === true ? "error" : "ok";
      const text = textOf(message.content);
      return [
        {
          at: atMessage,
          kind: "result",
          text: short(text === "" ? `${name} ${outcome}` : `${name} ${outcome} · ${text}`),
        },
      ];
    }
    default:
      return [{ at: atMessage, kind: "entry", text: short(`message ${String(message.role)}`) }];
  }
}

// Reads a session file from where the last read stopped. Only whole lines are parsed: the bytes after the last newline
// wait for the rest of their line, so a line Pi is still writing is never cut, and a character split across two reads
// is decoded whole.
class SessionReader {
  private readonly file: string;
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);

  constructor(file: string) {
    this.file = file;
  }

  read(final: boolean): TailLine[] {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // The file was replaced: read it again from its start.
      this.offset = 0;
      this.pending = Buffer.alloc(0);
    }
    if (size > this.offset) {
      const chunk = Buffer.alloc(size - this.offset);
      const fd = openSync(this.file, "r");
      try {
        const read = readSync(fd, chunk, 0, chunk.length, this.offset);
        this.offset += read;
        this.pending = Buffer.concat([this.pending, chunk.subarray(0, read)]);
      } finally {
        closeSync(fd);
      }
    }
    const lines: TailLine[] = [];
    const end = this.pending.lastIndexOf(NEWLINE);
    if (end >= 0) {
      const complete = this.pending.subarray(0, end).toString("utf8");
      this.pending = this.pending.subarray(end + 1);
      for (const line of complete.split("\n")) lines.push(...parseLine(line));
    }
    if (final && this.pending.length > 0) {
      // The end of a session that will not grow: a last line without its newline is read if it is whole.
      const rest = this.pending.toString("utf8");
      const parsed = parseLine(rest);
      lines.push(
        ...(parsed.length > 0 && parsed[0]?.kind !== "note"
          ? parsed
          : [{ at: null, kind: "note" as const, text: "the last message is still being written" }]),
      );
    }
    return lines;
  }
}

function parseLine(line: string): TailLine[] {
  const text = line.trim();
  if (text === "") return [];
  try {
    return sessionLines(JSON.parse(text) as unknown);
  } catch {
    return [{ at: null, kind: "note", text: "a line of the session could not be read" }];
  }
}

interface NodeRun {
  readonly thread: ThreadView;
  // The newest run of the node's turns, with its turn number; undefined before the node ran.
  readonly runId: string | undefined;
  readonly turn: number;
  readonly agentRef: string | undefined;
}

// The node by its code (o1, d2, e3, a3, fa) or its thread id, and its newest run (the newest task.claimed event of its
// turns).
function nodeRun(store: Store, workflowId: string, node: string): NodeRun | undefined {
  const threads = threadsOf(store.workflows.tasks(workflowId));
  const thread = threads.find((item) => item.code === node || item.threadId === node);
  if (thread === undefined) return undefined;
  let newest: { runId: string; seq: number; turn: number } | undefined;
  thread.turns.forEach((turn, index) => {
    for (const event of store.events.list({ taskId: turn.taskId })) {
      if (event.type !== "task.claimed" || event.runId === null || event.runId === undefined)
        continue;
      if (newest === undefined || event.seq > newest.seq)
        newest = { runId: event.runId, seq: event.seq, turn: index + 1 };
    }
  });
  const latestTurn = thread.turns[(newest?.turn ?? thread.turns.length) - 1];
  return {
    thread,
    runId: newest?.runId,
    turn: newest?.turn ?? thread.turns.length,
    agentRef: latestTurn?.agentRef,
  };
}

// The session file of a run: the newest .jsonl in runs/<runId>/pi, by name (Pi names them by their start time).
function sessionFileOf(dataDir: string, runId: string): string | undefined {
  const dir = join(dataDir, RUNS_DIR, runId, SESSION_DIR);
  if (!existsSync(dir)) return undefined;
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    const last = files[files.length - 1];
    return last === undefined ? undefined : join(dir, last);
  } catch {
    return undefined;
  }
}

function clockText(at: number | null): string {
  if (at === null) return "--:--:--";
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function workflowTail(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): number | Promise<number> {
  const parsed = parseArgs(args, {
    values: ["--interval-ms", "--data-dir"],
    flags: ["--follow", "-f", "--json", EXIT_ON_STDIN_END],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [workflowId, node, ...extra] = parsed.positionals;
  if (workflowId === undefined || node === undefined || extra.length > 0) return fail(io, USAGE);
  const intervalText = lastValue(parsed, "--interval-ms");
  const intervalMs = intervalText === undefined ? DEFAULT_INTERVAL_MS : Number(intervalText);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    return fail(io, "--interval-ms takes a whole number of milliseconds from 10 to 60000");
  }
  const json = parsed.flags.has("--json");
  const followMode = parsed.flags.has("--follow") || parsed.flags.has("-f");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  const workflow = store.workflows.get(workflowId);
  if (workflow === undefined) {
    store.close();
    return fail(io, `no workflow with id "${workflowId}"`);
  }
  const first = nodeRun(store, workflowId, node);
  if (first === undefined) {
    store.close();
    return fail(
      io,
      `no node "${short(node, 40)}" in workflow ${workflowId} (haril workflow show lists them)`,
    );
  }
  const print = (line: TailLine): void => {
    if (json) io.out(JSON.stringify(line));
    else if (line.kind === "run") io.out(line.text);
    else io.out(`${clockText(line.at)}  ${line.kind.padEnd(9)} ${line.text}`);
  };
  const tail = new NodeTail(store, workflowId, node, dataDir, print);
  tail.start(first);
  if (!followMode) {
    tail.step(true);
    store.close();
    return EXIT_OK;
  }
  return new Promise((resolve) => {
    const signals = host.signals ?? process;
    let ended = false;
    let stopStdin: (() => void) | undefined;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      stopStdin?.();
      clearInterval(timer);
      signals.off("SIGINT", finish);
      signals.off("SIGTERM", finish);
      store.close();
      resolve(EXIT_OK);
    };
    const timer = setInterval(() => {
      try {
        const state = store.workflows.get(workflowId)?.state;
        const over = state === undefined || ENDED.has(state);
        tail.step(over);
        if (over) finish();
      } catch (error) {
        io.err(`haril: ${error instanceof Error ? error.message : String(error)}`);
        finish();
      }
    }, intervalMs);
    signals.on("SIGINT", finish);
    signals.on("SIGTERM", finish);
    // The console runs it as a child with a stdin pipe: when the console goes away, the tail ends too.
    if (parsed.flags.has(EXIT_ON_STDIN_END)) stopStdin = onStdinEnd(host, finish);
  });
}

// The reading of one node: the run it follows, its session reader, and the notes already said.
class NodeTail {
  private readonly store: Store;
  private readonly workflowId: string;
  private readonly node: string;
  private readonly dataDir: string;
  private readonly print: (line: TailLine) => void;
  private runId: string | undefined;
  private reader: SessionReader | undefined;
  private readonly told = new Set<string>();

  constructor(
    store: Store,
    workflowId: string,
    node: string,
    dataDir: string,
    print: (line: TailLine) => void,
  ) {
    this.store = store;
    this.workflowId = workflowId;
    this.node = node;
    this.dataDir = dataDir;
    this.print = print;
  }

  start(found: NodeRun): void {
    this.switchTo(found);
  }

  // Reads what was added; `final` reads a last line that has no newline yet.
  step(final: boolean): void {
    const found = nodeRun(this.store, this.workflowId, this.node);
    if (found !== undefined && found.runId !== this.runId) {
      // The run it read may have written its last lines since the previous step (a failed attempt's final reply):
      // they are read to the end before the next run's.
      this.drain();
      this.switchTo(found);
    }
    if (this.runId === undefined) return;
    if (this.reader === undefined) {
      const file = sessionFileOf(this.dataDir, this.runId);
      if (file === undefined) {
        if (final) this.note(`no Pi session in run ${this.runId}`);
        return;
      }
      this.reader = new SessionReader(file);
    }
    for (const line of this.reader.read(final)) this.print(line);
  }

  // Everything left in the current run's session, its unfinished last line included.
  private drain(): void {
    if (this.runId === undefined) return;
    if (this.reader === undefined) {
      const file = sessionFileOf(this.dataDir, this.runId);
      if (file === undefined) return;
      this.reader = new SessionReader(file);
    }
    for (const line of this.reader.read(true)) this.print(line);
  }

  private switchTo(found: NodeRun): void {
    this.runId = found.runId;
    this.reader = undefined;
    const { thread } = found;
    const head = `${thread.code} · ${thread.label} · turn ${found.turn} of ${thread.turns.length}`;
    if (found.runId === undefined) {
      this.note(`${head} · has not run yet`);
      return;
    }
    this.print({ at: null, kind: "run", text: `${head} · run ${found.runId}` });
    if (found.agentRef?.startsWith("fake:") === true) {
      this.note(
        `${thread.code} runs a simulated agent (${found.agentRef}): it keeps no Pi session`,
      );
    }
  }

  private note(text: string): void {
    if (this.told.has(text)) return;
    this.told.add(text);
    this.print({ at: null, kind: "note", text });
  }
}
