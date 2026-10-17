import { createControlServer } from "@haril/control";
import { type RunEvent, runExitCode } from "@haril/core";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_ERROR, EXIT_USAGE, type HostInfo } from "../context.js";
import { agentRuntimeFor, clockFor } from "../host.js";
import { createPlanProposals } from "../runtime/plan-proposals.js";
import { createRealAgents } from "../runtime/real-agent.js";
import { runUntilIdle } from "../runtime/run-loop.js";
import { attachStopSignals, createShutdown } from "../runtime/shutdown.js";
import { dataDirFor, openExisting } from "./common.js";

// `haril start` (M1-T5, LD-T1): the foreground runtime. It applies the queue, runs the ready tasks and stays up for new
// work until --idle-exit-sec of nothing to do (ARCH 4.2). `haril run` is start until idle: it exits as soon as the
// queue is empty. A runtime.stop, a first Ctrl+C or SIGTERM stops it in order; a second signal exits at once.
const IDLE_EXIT_SEC = 120;
const START_USAGE =
  "usage: haril start [--project <slug>] [--json] [--data-dir <path>] [--idle-exit-sec <n>]";
const RUN_USAGE = "usage: haril run [--project <slug>] [--json] [--data-dir <path>]";
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";

export function start(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  return serve(args, io, host, "start");
}

export function runQueue(args: readonly string[], io: CliIo, host: HostInfo): Promise<number> {
  return serve(args, io, host, "run");
}

async function serve(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  mode: "start" | "run",
): Promise<number> {
  const parsed = parseArgs(args, {
    values:
      mode === "start"
        ? ["--project", "--data-dir", "--idle-exit-sec"]
        : ["--project", "--data-dir"],
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(mode === "start" ? START_USAGE : RUN_USAGE);
    return EXIT_USAGE;
  }

  const idleExitSec = idleExitSecOf(parsed.values, mode);
  if (idleExitSec === undefined) {
    io.err("haril: --idle-exit-sec takes a whole number of seconds, 0 or more");
    return EXIT_USAGE;
  }

  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    io.err(`haril: ${NOT_INITIALIZED}`);
    return EXIT_USAGE;
  }
  // The host handler of haril_propose_plan (LD-T4): a plan task's proposal becomes a requested approval. Both lanes get
  // the same handler, so the run loop opens one attempt window whichever runtime serves the plan task.
  const planProposals = createPlanProposals(store);
  // The real lane (M2-T6): the analyst and planner agents in Pi through one Broker, closed when the run ends.
  const realAgents = createRealAgents({
    host,
    store,
    clock: clockFor(host),
    dataDir,
    proposePlan: planProposals.propose,
  });
  // The control channel (LD-T2): the runtime opens it after taking the lease, so subscribed shells and nudging CLIs
  // reach this runtime only while it holds the lease.
  const control = createControlServer({ dataDir });
  // Ctrl+C and SIGTERM ask for the ordered stop; a second signal exits at once (ARCH 4.2).
  const shutdown = createShutdown();
  const detach = attachStopSignals(
    host.signals ?? process,
    shutdown,
    host.forceExit ?? ((code) => process.exit(code)),
  );
  try {
    // M1-D6: the lease is per data root, so one runtime serves every project. --project only names one that exists.
    const slug = lastValue(parsed, "--project");
    if (slug !== undefined && store.projects.getBySlug(slug) === undefined) {
      io.err(`haril: no project with slug "${slug}"`);
      return EXIT_USAGE;
    }
    if (mode === "start" && !json) {
      io.out(
        `runtime up: waiting for work, exits after ${idleExitSec} s idle (haril stop ends it)`,
      );
    }

    const result = await runUntilIdle({
      store,
      agentRuntime: agentRuntimeFor(host, planProposals.propose),
      clock: clockFor(host),
      pid: process.pid,
      nodeVersion: host.nodeVersion,
      realAgents,
      planProposals,
      control,
      idleExitMs: idleExitSec * 1000,
      shutdown,
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
      const skipped =
        result.summary.skipped.length === 0 ? "" : `, ${result.summary.skipped.length} skipped`;
      io.out(
        `done: ${result.summary.completed.length} completed, ${result.summary.failed.length} failed, ${result.summary.blocked.length} blocked${skipped}`,
      );
    }
    return exitCode;
  } finally {
    detach();
    await realAgents.close();
    store.close();
  }
}

// Whole seconds from --idle-exit-sec (start only; run always exits as soon as it is idle). Undefined when malformed.
function idleExitSecOf(
  values: ReadonlyMap<string, readonly string[]>,
  mode: "start" | "run",
): number | undefined {
  if (mode === "run") return 0;
  const list = values.get("--idle-exit-sec");
  const raw = list?.[list.length - 1];
  if (raw === undefined) return IDLE_EXIT_SEC;
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
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
    case "task.skipped":
      return `skipped ${event.taskId} ${event.goal}: needs setup (${event.what}: ${event.fix})`;
    case "runtime.stopping":
      return `stopping (${event.reason}): the in-flight run returns to ready`;
    case "task.returned":
      return `returned ${event.taskId} ${event.goal} to ready (stopped, no attempt charged)`;
    case "approval.applied":
      return event.alreadySubmitted
        ? `approval ${event.approvalId} ${event.outcome}: applied (plan already submitted, nothing new queued)`
        : `approval ${event.approvalId} ${event.outcome}: applied`;
    case "approval.requested":
      return event.created
        ? `approval ${event.approvalId} requested by ${event.taskId}: haril approve ${event.approvalId} runs its plan`
        : `approval ${event.approvalId} requested by ${event.taskId}: the same plan already waits (haril approve ${event.approvalId})`;
  }
}
