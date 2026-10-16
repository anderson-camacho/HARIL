import { type RunEvent, runExitCode } from "@haril/core";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_ERROR, EXIT_USAGE, type HostInfo } from "../context.js";
import { agentRuntimeFor, clockFor } from "../host.js";
import { runUntilIdle } from "../runtime/run-loop.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril start` (M1-T5): the foreground runtime. It applies the queue, runs the ready tasks and exits when idle.
const USAGE = "usage: haril start [--project <slug>] [--json] [--data-dir <path>]";
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";

export async function start(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  const parsed = parseArgs(args, { values: ["--project", "--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    io.err(`haril: ${NOT_INITIALIZED}`);
    return EXIT_USAGE;
  }
  try {
    // M1-D6: the lease is per data root, so one runtime serves every project. --project only names one that exists.
    const slug = lastValue(parsed, "--project");
    if (slug !== undefined && store.projects.getBySlug(slug) === undefined) {
      io.err(`haril: no project with slug "${slug}"`);
      return EXIT_USAGE;
    }

    const result = await runUntilIdle({
      store,
      agentRuntime: agentRuntimeFor(host),
      clock: clockFor(host),
      pid: process.pid,
      nodeVersion: host.nodeVersion,
      onEvent: (event) => {
        if (!json) io.out(formatEvent(event));
      },
    });
    if (result.kind === "busy") {
      io.err(`haril: another runtime is active (pid ${result.pid})`);
      return EXIT_ERROR;
    }

    const exitCode = runExitCode(result.summary);
    if (json) {
      io.out(JSON.stringify({ ...result.summary, exitCode }));
    } else {
      io.out(
        `done: ${result.summary.completed.length} completed, ${result.summary.failed.length} failed, ${result.summary.blocked.length} blocked`,
      );
    }
    return exitCode;
  } finally {
    store.close();
  }
}

function formatEvent(event: RunEvent): string {
  switch (event.type) {
    case "command.applied":
      return `command ${event.commandId} ${event.commandType} applied`;
    case "command.rejected":
      return `command ${event.commandId} ${event.commandType} rejected: ${event.reason}`;
    case "task.claimed":
      return `claimed ${event.taskId} ${event.goal} (attempt ${event.attempt}/${event.maxAttempts})`;
    case "task.recovered":
      return `recovered ${event.taskId} ${event.goal} (orphaned, restart ${event.infraRestarts}/${event.maxInfraRestarts})`;
    case "task.completed":
      return event.simulated
        ? `completed ${event.taskId} ${event.goal} (simulated: no real agent until M2)`
        : `completed ${event.taskId} ${event.goal}`;
    case "task.retrying":
      return `failed (retrying ${event.nextAttempt}/${event.maxAttempts}) ${event.taskId} ${event.goal}: ${event.code}`;
    case "task.failed":
      return `failed ${event.taskId} ${event.goal}: ${event.code}`;
    case "task.blocked":
      return `blocked: ${event.reason} ${event.taskId} ${event.goal}`;
  }
}
