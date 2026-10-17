import { homedir, userInfo } from "node:os";
import { StoreError } from "@haril/state-sqlite";
import { approvals, approve, deny } from "./commands/approvals.js";
import { doctor } from "./commands/doctor.js";
import { events } from "./commands/events.js";
import { methodology } from "./commands/methodology.js";
import { metrics } from "./commands/metrics.js";
import { models } from "./commands/models.js";
import { plan } from "./commands/plan.js";
import { project } from "./commands/project.js";
import { shell } from "./commands/shell.js";
import { runQueue, start } from "./commands/start.js";
import { states } from "./commands/states.js";
import { status } from "./commands/status.js";
import { stop } from "./commands/stop.js";
import { task } from "./commands/task.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "./context.js";
import { VERSION } from "./version.js";

// Composition root of the CLI: dispatches the command line. Each command lives in ./commands.
export type { CliIo, HostInfo } from "./context.js";

function currentHost(): HostInfo {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDir: homedir(),
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    user: operatorName(),
  };
}

// The OS user name the decisions of approve and deny are recorded under (LD-T3). Undefined when the OS has none.
function operatorName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

const HELP_LINES = [
  "haril - HARIL command line",
  "",
  "usage:",
  "  haril                            in a terminal, open the interactive terminal UI (haril shell); otherwise print this help",
  "  haril --version | version        print the CLI version",
  "  haril doctor [--json] [--data-dir <path>]   check the runtime and the store",
  "  haril models [--json] [--provider <id>]   list the models of every provider as <provider>/<model> (haril.json)",
  "  haril states                     print the task states and legal transitions",
  "  haril plan validate <file> [--json]   validate a plan file",
  "  haril plan import <file> [--project <slug>] [--json]   queue a plan (applied by start)",
  "  haril plan propose <file> [--project <slug>] [--json]   propose a plan: a requested approval, nothing queued",
  "  haril approvals [--project <slug>] [--all] [--json]   the pending approvals (--all: every status)",
  "  haril approvals show <approvalId> [--json]   one approval with every task of its plan; read it before approve",
  "  haril approve <approvalId> [--reason <text>]   grant a proposed plan; the runtime queues it on its next turn",
  "  haril deny <approvalId> [--reason <text>]   deny a proposed plan; nothing is queued",
  "  haril project init [path] --name <name> [--slug <slug>] [--methodology <name>] [--yes] [--json]",
  "  haril project list [--json]      list the registered projects",
  "  haril methodology list [--json]  list the native methodology blocks (id, version, sha256, summary)",
  '  haril task add "<title>" [--project <slug>] [--depends-on <taskId>]... [--kind work|plan] [--agent <ref>] [--model <id>] [--max-tokens <n>]',
  "    [--max-attempts <n>] [--timeout-ms <n>] [--accept-file <path>]... [--accept-contains <path>=<text>]... [--accept-output <text>]... [--json]",
  "    --kind plan asks a planner agent (planner, or fake:plan offline) for a plan; it waits for haril approve",
  "    the --accept-* checks run after the agent; haril task add --help describes every flag",
  "  haril task show <taskId> [--json]   one task with its result, error and settled tokens",
  "  haril start [--project <slug>] [--json] [--idle-exit-sec <n>]   stay up for new work: apply the queue, run the ready tasks, exit after n idle seconds (default 120)",
  "  haril run [--project <slug>] [--json]   apply the queue, run the ready tasks and exit as soon as nothing is claimable",
  "  haril stop                       ask the running runtime to stop: its in-flight run returns to ready, uncharged",
  "  start and run exit 0 when idle or stopped with nothing failed, 1 when a task failed, was blocked or was skipped,",
  "  2 when another runtime holds the lease; Ctrl+C or SIGTERM stops gracefully, and a second signal exits 130 at once",
  "  haril status [--project <slug>] [--json]   projects, tasks, queued commands and runtime",
  "  haril metrics [--project <slug>] [--json]   runs, retries and success rate from the event log",
  "  haril events [--project <slug>] [--task <id>] [--limit <n>] [--json]   the newest events, oldest first",
  "  haril shell [--data-dir <path>] [--no-runtime]   open the interactive terminal UI; it starts haril start",
  "    in the background when work waits and no runtime runs (output in logs/), never with --no-runtime",
  "  haril help                       print this help",
];

// `start` is the only asynchronous command, so the result is a promise only for it.
export function run(
  argv: readonly string[],
  io: CliIo,
  host: HostInfo = currentHost(),
): number | Promise<number> {
  try {
    const result = dispatch(argv, io, host);
    return typeof result === "number"
      ? result
      : result.catch((error: unknown) => reportError(error, io));
  } catch (error) {
    return reportError(error, io);
  }
}

// Store refusals (gates, conflicts, stale state, fenced epochs) are reported as usage errors with their remedy.
function reportError(error: unknown, io: CliIo): number {
  if (error instanceof StoreError) {
    io.err(`haril: ${error.message}`);
    return EXIT_USAGE;
  }
  throw error;
}

function dispatch(argv: readonly string[], io: CliIo, host: HostInfo): number | Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      // A bare `haril` in a terminal is the shell, the way people open it; scripts and pipes still get the help.
      if (host.interactive === true) return shell([], io, host);
      printHelp(io.err);
      return EXIT_USAGE;
    case "--version":
    case "version":
      io.out(`haril ${VERSION}`);
      return EXIT_OK;
    case "--help":
    case "-h":
    case "help":
      printHelp(io.out);
      return EXIT_OK;
    case "doctor":
      return doctor(rest, io, host);
    case "models":
      return models(rest, io, host);
    case "states":
      return states(rest, io);
    case "plan":
      return plan(rest, io, host);
    case "approvals":
      return approvals(rest, io, host);
    case "approve":
      return approve(rest, io, host);
    case "deny":
      return deny(rest, io, host);
    case "project":
      return project(rest, io, host);
    case "methodology":
      return methodology(rest, io, host);
    case "task":
      return task(rest, io, host);
    case "status":
      return status(rest, io, host);
    case "metrics":
      return metrics(rest, io, host);
    case "events":
      return events(rest, io, host);
    case "start":
      return start(rest, io, host);
    case "run":
      return runQueue(rest, io, host);
    case "stop":
      return stop(rest, io, host);
    case "shell":
      return shell(rest, io, host);
    default:
      io.err(`haril: unknown command "${command}"`);
      printHelp(io.err);
      return EXIT_USAGE;
  }
}

function printHelp(write: (line: string) => void): void {
  for (const line of HELP_LINES) write(line);
}
