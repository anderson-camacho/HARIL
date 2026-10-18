import { canonicalJson } from "@haril/core";
import type { Store } from "@haril/core/ports";
import { createProcessControl } from "@haril/os";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, EXIT_WARN, type HostInfo } from "../context.js";
import { clockFor, defaultPidAlive, storeAccess } from "../host.js";
import { killRecordedProcesses, stillRunning } from "../runtime/processes.js";
import { RUNTIME_STOP } from "../runtime/shutdown.js";
import { dataDirFor, nudgeQueued, openExisting, sha256 } from "./common.js";

// `haril stop` (LD-T1, ARCH 4.2): enqueues runtime.stop for the runtime that holds the lease. That runtime stops
// claiming, cancels its in-flight run without charging an attempt, releases its lease and exits 0. Nothing is queued
// when no runtime is active.
// `haril stop --now` (docs/modos-y-delegacion.md 3.14): the emergency stop of every agent in every mode. The runtime
// applies runtime.stop {mode: "now"}: it halts, stops every workflow, cancels their turns and the running standalone
// tasks (their reservations settled), kills every agent's process tree without the grace period and exits. This command
// waits for that, then makes sure itself that no agent process a run recorded is still running as the recorded process
// (pid and start time), and kills the ones that are: a runtime that does not answer, or one that died and left them.
// With no runtime active the stop stays queued, so the next runtime applies it before it claims anything. Repeating
// it is harmless; haril resume lifts the halt.
const USAGE = "usage: haril stop [--now] [--json] [--data-dir <path>]";
const STOP_WAIT_MS = 5_000;
const POLL_MS = 50;

export function stop(args: readonly string[], io: CliIo, host: HostInfo): number | Promise<number> {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--now", "--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const json = parsed.flags.has("--json");
  return parsed.flags.has("--now")
    ? emergencyStop(dataDir, json, io, host)
    : orderedStop(dataDir, json, io, host);
}

function orderedStop(dataDir: string, json: boolean, io: CliIo, host: HostInfo): number {
  const store = openExisting(host, dataDir);
  if (store === undefined || !runtimeIsActive(store, host)) {
    store?.close();
    if (json) io.out(JSON.stringify({ commandId: null, mode: "graceful", queued: false }));
    else io.out("no runtime is active: nothing to stop, nothing queued");
    return EXIT_OK;
  }
  try {
    const commandId = enqueueStop(store, host, {});
    nudgeQueued(dataDir);
    if (json) io.out(JSON.stringify({ commandId, mode: "graceful", queued: true }));
    else io.out(`command ${commandId}: queued (the runtime stops when it applies it)`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

type RuntimeOutcome = "stopped" | "unresponsive" | "none";

async function emergencyStop(
  dataDir: string,
  json: boolean,
  io: CliIo,
  host: HostInfo,
): Promise<number> {
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    if (json) io.out(JSON.stringify(noStoreReport()));
    else io.out("no store here: no runtime and no agent to stop");
    return EXIT_OK;
  }
  try {
    const since = clockFor(host).now();
    const lease = store.runtime.leaseSummary();
    const active = runtimeIsActive(store, host);
    const holder = active && lease.status === "active" ? lease.pid : null;
    const alreadyQueued = store.commands
      .listQueued()
      .some((command) => command.type === RUNTIME_STOP && command.args.mode === "now");
    const enqueue = active || (!store.runtime.haltState().halted && !alreadyQueued);
    const commandId = enqueue ? enqueueStop(store, host, { mode: "now" }) : null;
    if (commandId !== null) nudgeQueued(dataDir);

    let runtime: RuntimeOutcome = "none";
    if (commandId !== null && holder !== null) {
      const exited = await waitFor(
        () => store.commands.get(commandId)?.status !== "queued" && holderGone(store, holder, host),
        host.stopWaitMs ?? STOP_WAIT_MS,
      );
      runtime = exited ? "stopped" : "unresponsive";
    }
    const status = commandId === null ? undefined : store.commands.get(commandId);

    // Whatever the runtime did, no recorded agent process outlives the stop.
    const control = host.processControl ?? createProcessControl();
    const swept = await killRecordedProcesses(store, control, { endedSince: since });
    const left = await stillRunning(control, swept.killed);
    const report = {
      commandId,
      runtime,
      queued: status?.status === "queued" || (commandId === null && alreadyQueued),
      halted: store.runtime.haltState().halted,
      cancelledTasks: status?.taskIds.length ?? 0,
      stoppedWorkflows: status?.workflowIds.length ?? 0,
      processes: {
        recorded: swept.checked,
        killed: swept.killed.length,
        kept: swept.kept.length,
        alive: left.length,
      },
    };
    if (json) io.out(JSON.stringify(report));
    else printReport(io, report, holder, left);
    return left.length === 0 ? EXIT_OK : EXIT_WARN;
  } finally {
    store.close();
  }
}

interface StopReport {
  readonly commandId: string | null;
  readonly runtime: RuntimeOutcome;
  readonly queued: boolean;
  readonly halted: boolean;
  readonly cancelledTasks: number;
  readonly stoppedWorkflows: number;
  readonly processes: {
    readonly recorded: number;
    readonly killed: number;
    readonly kept: number;
    readonly alive: number;
  };
}

function noStoreReport(): StopReport {
  return {
    commandId: null,
    runtime: "none",
    queued: false,
    halted: false,
    cancelledTasks: 0,
    stoppedWorkflows: 0,
    processes: { recorded: 0, killed: 0, kept: 0, alive: 0 },
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function printReport(
  io: CliIo,
  report: StopReport,
  holder: number | null,
  left: readonly { pid: number }[],
): void {
  if (report.runtime === "stopped") {
    io.out(
      `emergency stop: the runtime (pid ${holder}) cancelled ${plural(report.cancelledTasks, "task", "tasks")}, stopped ${plural(report.stoppedWorkflows, "workflow", "workflows")}, killed its agents and exited`,
    );
  } else if (report.runtime === "unresponsive") {
    io.out(
      `emergency stop: the runtime (pid ${holder}) did not apply it in time; it stays queued for it, and the agent processes were checked here`,
    );
  } else if (report.commandId !== null || report.queued) {
    io.out(
      "no runtime is active: the stop is queued, and the next runtime applies it before it claims anything",
    );
  } else {
    io.out("already halted and no runtime is active: nothing to stop");
  }
  if (report.halted || report.queued) {
    io.out("the runtime stays halted: nothing is claimed until haril resume");
  }
  const { recorded, killed, kept } = report.processes;
  const extra = [
    ...(killed > 0 ? [`${killed} killed here`] : []),
    ...(kept > 0 ? [`${kept} kept: the pid now names another process`] : []),
  ];
  if (left.length === 0) {
    io.out(
      `no agent process left alive (${plural(recorded, "recorded process", "recorded processes")} checked${extra.length === 0 ? "" : `; ${extra.join("; ")}`})`,
    );
  } else {
    io.out(
      `${plural(left.length, "agent process is", "agent processes are")} still alive after the kill: pid ${left.map((item) => item.pid).join(", ")}`,
    );
  }
}

function enqueueStop(store: Store, host: HostInfo, commandArgs: Record<string, unknown>): string {
  const result = store.commands.enqueue({
    type: RUNTIME_STOP,
    args: commandArgs,
    idempotencyKey: `runtime-stop-${storeAccess(host).ids.next()}`,
    requestHash: sha256(canonicalJson({ type: RUNTIME_STOP, args: commandArgs })),
  });
  return result.commandId;
}

// The runtime that held the lease is gone: its lease is no longer active, or another took it, or its process ended.
function holderGone(store: Store, pid: number, host: HostInfo): boolean {
  const lease = store.runtime.leaseSummary();
  if (lease.status !== "active" || lease.pid !== pid) return true;
  return !(host.isPidAlive ?? defaultPidAlive)(pid);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// The newest lease is active and its holder is alive. An expired lease of a live holder still counts: the holder can
// apply the command once it is responsive again.
function runtimeIsActive(store: Store, host: HostInfo): boolean {
  const lease = store.runtime.leaseSummary();
  if (lease.status !== "active") return false;
  return (host.isPidAlive ?? defaultPidAlive)(lease.pid);
}
