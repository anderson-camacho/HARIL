import { homedir } from "node:os";
import { StoreError } from "@haril/state-sqlite";
import { doctor } from "./commands/doctor.js";
import { plan } from "./commands/plan.js";
import { project } from "./commands/project.js";
import { states } from "./commands/states.js";
import { status } from "./commands/status.js";
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
  };
}

const HELP_LINES = [
  "haril - HARIL command line",
  "",
  "usage:",
  "  haril --version | version        print the CLI version",
  "  haril doctor [--json] [--data-dir <path>]   check the runtime and the store",
  "  haril states                     print the task states and legal transitions",
  "  haril plan validate <file> [--json]   validate a plan file",
  "  haril plan import <file> [--project <slug>] [--json]   queue a plan (applied by start)",
  "  haril project init [path] --name <name> [--slug <slug>] [--methodology odd|tdd|custom] [--yes] [--json]",
  "  haril project list [--json]      list the registered projects",
  '  haril task add "<title>" [--project <slug>] [--depends-on <taskId>]... [--agent <ref>] [--json]',
  "  haril status [--project <slug>] [--json]   projects, tasks, queued commands and runtime",
  "  haril help                       print this help",
];

export function run(argv: readonly string[], io: CliIo, host: HostInfo = currentHost()): number {
  try {
    return dispatch(argv, io, host);
  } catch (error) {
    // Store refusals (gates, conflicts, stale state) are reported as usage errors with their remedy.
    if (error instanceof StoreError) {
      io.err(`haril: ${error.message}`);
      return EXIT_USAGE;
    }
    throw error;
  }
}

function dispatch(argv: readonly string[], io: CliIo, host: HostInfo): number {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
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
    case "states":
      return states(rest, io);
    case "plan":
      return plan(rest, io, host);
    case "project":
      return project(rest, io, host);
    case "task":
      return task(rest, io, host);
    case "status":
      return status(rest, io, host);
    default:
      io.err(`haril: unknown command "${command}"`);
      printHelp(io.err);
      return EXIT_USAGE;
  }
}

function printHelp(write: (line: string) => void): void {
  for (const line of HELP_LINES) write(line);
}
