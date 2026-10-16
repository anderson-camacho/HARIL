import { allValues, argsProblem, lastValue, type ParsedArgs, parseArgs } from "../args.js";
import { type CliIo, EXIT_USAGE, type HostInfo } from "../context.js";
import { storeAccess } from "../host.js";
import { dataDirFor, queueCommand, withProject } from "./common.js";

// `haril task add` (M1-T4): validates the input and queues task.create. `haril start` applies the queue.

const DEFAULT_AGENT = "fake:succeed";
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_TIMEOUT_MS = 120000;
const TASK_ADD_USAGE =
  'usage: haril task add "<title>" [--project <slug>] [--depends-on <taskId>]... [--agent <agentRef>] [--max-attempts <n>] [--timeout-ms <n>] [--idempotency-key <key>] [--json] [--data-dir <path>]';

export function task(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "add") return taskAdd(rest, io, host);
  if (subcommand === undefined) io.err("haril: task needs a subcommand");
  else io.err(`haril: unknown task subcommand "${subcommand}"`);
  io.err("usage: haril task add ...");
  return EXIT_USAGE;
}

function taskAdd(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, {
    values: [
      "--project",
      "--depends-on",
      "--agent",
      "--max-attempts",
      "--timeout-ms",
      "--idempotency-key",
      "--data-dir",
    ],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [titleArg, ...extra] = parsed.positionals;
  if (titleArg === undefined || extra.length > 0) {
    io.err(TASK_ADD_USAGE);
    return EXIT_USAGE;
  }

  const title = titleArg.trim();
  if (title === "") {
    io.err("haril: task title must not be empty");
    return EXIT_USAGE;
  }
  const dependsOn = allValues(parsed, "--depends-on").map((id) => id.trim());
  if (dependsOn.some((id) => id === "")) {
    io.err("haril: --depends-on needs a task id");
    return EXIT_USAGE;
  }
  const agent = (lastValue(parsed, "--agent") ?? DEFAULT_AGENT).trim();
  if (agent === "") {
    io.err("haril: --agent needs an agent reference");
    return EXIT_USAGE;
  }
  const maxAttempts = intOption(io, parsed, "--max-attempts", DEFAULT_MAX_ATTEMPTS);
  const timeoutMs = intOption(io, parsed, "--timeout-ms", DEFAULT_TIMEOUT_MS);
  if (maxAttempts === null || timeoutMs === null) return EXIT_USAGE;
  const explicitKey = lastValue(parsed, "--idempotency-key");
  if (explicitKey !== undefined && explicitKey.trim() === "") {
    io.err("haril: --idempotency-key needs a value");
    return EXIT_USAGE;
  }

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const idempotencyKey = explicitKey ?? `task-add-${storeAccess(host).ids.next()}`;
  return withProject(io, host, dataDir, lastValue(parsed, "--project"), (store, project) =>
    queueCommand(io, parsed.flags.has("--json"), store, {
      type: "task.create",
      projectId: project.projectId,
      args: { goal: title, dependsOn, agent, maxAttempts, timeoutMs },
      idempotencyKey,
    }),
  );
}

// An integer option of at least 1; prints the problem and returns null when it is not one.
function intOption(io: CliIo, parsed: ParsedArgs, flag: string, fallback: number): number | null {
  const raw = lastValue(parsed, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    io.err(`haril: ${flag} must be a whole number of at least 1`);
    return null;
  }
  return value;
}
