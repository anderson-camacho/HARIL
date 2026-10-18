import { type ControlServer, createControlServer } from "@haril/control";
import { type RunEvent, runExitCode, visibleText } from "@haril/core";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_ERROR, EXIT_USAGE, type HostInfo } from "../context.js";
import { agentRuntimeFor, clockFor } from "../host.js";
import { createDelegationTools } from "../runtime/delegation-tools.js";
import { createLiveModels } from "../runtime/live-models.js";
import { memoryLeftLine } from "../runtime/memory.js";
import { withStoreState } from "../runtime/model-context.js";
import { createPlanProposals } from "../runtime/plan-proposals.js";
import { createRealAgents } from "../runtime/real-agent.js";
import { runUntilIdle } from "../runtime/run-loop.js";
import { attachStopSignals, createKillSwitch, createShutdown } from "../runtime/shutdown.js";
import { workflowExitCode, workflowSummaryText } from "../runtime/workflow-summary.js";
import { dataDirFor, failureReasonText, openExisting } from "./common.js";

// `haril start` (M1-T5, LD-T1): the foreground runtime. It applies the queue, runs the ready tasks and stays up for new
// work until --idle-exit-sec of nothing to do (ARCH 4.2). `haril run` is start until idle: it exits as soon as the
// queue is empty. A runtime.stop, a first Ctrl+C or SIGTERM stops it in order; a second signal kills the agents in
// flight and exits (3.14); haril stop --now kills them, cancels their tasks and leaves the runtime halted.
// `--started-by shell` (LD-T6, ADR-0022) is how haril shell starts it: the same runtime, which also records
// runtime.started_by_shell once it holds the lease, because the shell never writes the store.
const IDLE_EXIT_SEC = 120;
// How long the start waits for the first catalog reading (phase F6).
const CATALOG_HEAD_START_MS = 3_000;
const STARTED_BY_SHELL = "shell";
const START_USAGE =
  "usage: haril start [--project <slug>] [--json] [--data-dir <path>] [--idle-exit-sec <n>] [--started-by shell]";
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
        ? ["--project", "--data-dir", "--idle-exit-sec", "--started-by"]
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
  const startedBy = lastValue(parsed, "--started-by");
  if (startedBy !== undefined && startedBy !== STARTED_BY_SHELL) {
    io.err(`haril: --started-by only takes ${STARTED_BY_SHELL}`);
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
  // The models of real workflows (phase F6): the live catalog, the difficulty table, the quota and the cooldowns. The
  // delegation tools check a proposal against the same models the run loop decides with.
  const liveModels = createLiveModels({ host, store, clock: clockFor(host) });
  const delegation = liveModels.options;
  // The host handler of the delegation tools (phase F2): the workflow turns of every lane call it.
  const delegationTools = createDelegationTools({
    store,
    clock: clockFor(host),
    options: withStoreState(store, delegation),
  });
  // The real lane (M2-T6): the analyst, the planner and the workflow archetypes in Pi through one Broker, closed when
  // the run ends. A real workflow turn's tool calls reach the same delegation tools as a fake one's (phase F2b).
  const realAgents = createRealAgents({
    host,
    store,
    clock: clockFor(host),
    dataDir,
    proposePlan: planProposals.propose,
    delegationTools: delegationTools.call,
  });
  // The control channel (LD-T2): the runtime opens it after taking the lease, so subscribed shells and nudging CLIs
  // reach this runtime only while it holds the lease.
  const control = createControlServer({ dataDir });
  // Ctrl+C and SIGTERM ask for the ordered stop; a second signal kills the agents in flight and exits (ARCH 4.2, 3.14).
  const shutdown = createShutdown();
  const killSwitch = createKillSwitch();
  const detach = attachStopSignals(
    host.signals ?? process,
    shutdown,
    host.forceExit ?? ((code) => process.exit(code)),
    killSwitch,
  );
  try {
    // M1-D6: the lease is per data root, so one runtime serves every project. --project only names one that exists.
    const slug = lastValue(parsed, "--project");
    if (slug !== undefined && store.projects.getBySlug(slug) === undefined) {
      io.err(`haril: no project with slug "${slug}"`);
      return EXIT_USAGE;
    }
    // LD-T6: runtimes started by shells share the log of the day, so the lines of start that open and close a run name
    // its pid. "runtime up" is said only once the lease is held: the run loop opens the control channel right after it
    // takes the lease (ARCH 4.3), and a start that loses the lease never says it.
    const pid = process.pid;
    const announce = mode === "start" && !json;
    const channel = announce
      ? announcingStart(control, () =>
          io.out(
            `runtime up (pid ${pid}): waiting for work, exits after ${idleExitSec} s idle (haril stop ends it)`,
          ),
        )
      : control;

    // The first turns see the catalog when the gateway answers within a few seconds; otherwise they start with the
    // orchestrator's model and the catalog arrives in the background.
    await liveModels.ready(CATALOG_HEAD_START_MS);
    const result = await runUntilIdle({
      store,
      agentRuntime: agentRuntimeFor(host, planProposals.propose, delegationTools.call),
      clock: clockFor(host),
      pid,
      nodeVersion: host.nodeVersion,
      realAgents,
      planProposals,
      delegationTools,
      delegation,
      control: channel,
      idleExitMs: idleExitSec * 1000,
      startedByShell: startedBy === STARTED_BY_SHELL,
      shutdown,
      killSwitch,
      ...(host.processControl === undefined ? {} : { processControl: host.processControl }),
      // LD-T7c: the goals of a plan's tasks are agent-written, so each line is shown as the terminal draws it.
      onEvent: (event) => {
        if (!json) io.out(visibleText(formatEvent(event)));
      },
    });
    if (result.kind === "busy") {
      const who = mode === "start" ? `haril (pid ${pid})` : "haril";
      io.err(`${who}: another runtime is active (pid ${result.pid})`);
      return EXIT_ERROR;
    }

    // A workflow that failed fails the run, as a failed task does (phase F2b).
    const exitCode = Math.max(runExitCode(result.summary), workflowExitCode(result.workflows)) as
      | 0
      | 1;
    if (json) {
      io.out(
        JSON.stringify({
          ...result.summary,
          workflows: result.workflows,
          memory: result.memory,
          exitCode,
        }),
      );
    } else {
      // MC-T4 fix: the tasks that wait for memory and the queued writes outlive this runtime; the next one resumes them.
      const memoryLeft = memoryLeftLine(result.memory);
      if (memoryLeft !== undefined) io.out(memoryLeft);
      const skipped =
        result.summary.skipped.length === 0 ? "" : `, ${result.summary.skipped.length} skipped`;
      const cancelled =
        result.summary.cancelled.length === 0
          ? ""
          : `, ${result.summary.cancelled.length} cancelled`;
      const whose = mode === "start" ? ` (pid ${pid})` : "";
      io.out(
        `done: ${result.summary.completed.length} completed, ${result.summary.failed.length} failed, ${result.summary.blocked.length} blocked${skipped}${cancelled}${workflowSummaryText(result.workflows)}${whose}`,
      );
    }
    return exitCode;
  } finally {
    detach();
    await realAgents.close();
    await liveModels.close();
    store.close();
  }
}

// The control channel with `announce` called as it opens, which is once the lease is held.
function announcingStart(control: ControlServer, announce: () => void): ControlServer {
  return {
    start: () => {
      announce();
      return control.start();
    },
    notify: (event) => control.notify(event),
    wake: () => control.wake(),
    subscriberCount: () => control.subscriberCount(),
    onNudge: (listener) => control.onNudge(listener),
    close: () => control.close(),
  };
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
      return event.reason === undefined
        ? `failed ${event.taskId} ${event.goal}: ${event.code}`
        : `failed ${event.taskId} ${event.goal}: ${event.code}, ${failureReasonText(event.reason, event.verifyRetries ?? 0)}`;
    case "task.blocked":
      return `blocked: ${event.reason} ${event.taskId} ${event.goal}`;
    case "task.skipped":
      return `skipped ${event.taskId} ${event.goal}: needs setup (${event.what}: ${event.fix})`;
    case "runtime.stopping":
      return event.reason === "emergency"
        ? "stopping now (emergency stop): every agent process is killed; the runtime stays halted until haril resume"
        : `stopping (${event.reason}): the in-flight run returns to ready`;
    case "runtime.halted":
      return "halted by an emergency stop: nothing is claimed until haril resume";
    case "runtime.swept":
      return `startup sweep: killed ${event.killed} agent ${event.killed === 1 ? "process" : "processes"} a stopped runtime left${event.kept === 0 ? "" : `; kept ${event.kept} whose pid now names another process`}`;
    case "watchdog.checked":
      return `watchdog: ${event.text}`;
    case "task.cancelled":
      return event.reason === "user_stop"
        ? `cancelled ${event.taskId} ${event.goal} (stopped by you; not retried)`
        : `cancelled ${event.taskId} ${event.goal} (residual: nothing will use its result)`;
    case "task.returned":
      return `returned ${event.taskId} ${event.goal} to ready (stopped, no attempt charged)`;
    case "approval.applied":
      return event.alreadySubmitted
        ? `approval ${event.approvalId} ${event.outcome}: applied (plan already submitted, nothing new queued)`
        : `approval ${event.approvalId} ${event.outcome}: applied`;
    // Only what is true (LD-T4): a grant may queue nothing (the plan was already submitted), and a deduplicated proposal
    // names the approval it found, not a requester it never was.
    case "approval.requested":
      return event.created
        ? `approval ${event.approvalId} requested by task ${event.taskId}: decide with haril approve|deny ${event.approvalId}`
        : `the same plan already waits as approval ${event.approvalId}: decide with haril approve|deny ${event.approvalId}`;
    case "workflow.turn":
      return `turn ${event.taskId} ${event.role} ${event.goal}: ${event.outcome}`;
    case "workflow.state":
      return event.state === "awaiting_human"
        ? `workflow ${event.workflowId} waits for you at ${event.reason ?? "a stop"}: haril workflow continue ${event.workflowId}`
        : `workflow ${event.workflowId} ${event.state}${event.reason === null ? "" : `: ${event.reason}`}`;
  }
}
