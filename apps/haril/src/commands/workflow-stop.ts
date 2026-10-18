import { canonicalJson } from "@haril/core";
import { createProcessControl } from "@haril/os";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, EXIT_WARN, type HostInfo } from "../context.js";
import { clockFor, storeAccess } from "../host.js";
import { killRecordedProcesses } from "../runtime/processes.js";
import { dataDirFor, leaseHolderAlive, nudgeQueued, openExisting, sha256 } from "./common.js";
import { unverifiedLine } from "./stop.js";

// `haril workflow stop <workflowId>` (docs/modos-y-delegacion.md 3.14, 6): stops one workflow and its agents now. The
// runtime applies workflow.stop: the workflow ends stopped (reason user_stop), its turns are cancelled with their
// reservations settled, and only its agents' processes are killed; the runtime and every other workflow go on. The
// command waits for that, then kills any agent of this workflow still running as the process its run recorded (a
// runtime that does not answer, or one that died). With no runtime active the stop stays queued for the next one.
const USAGE = "usage: haril workflow stop <workflowId> [--json] [--data-dir <path>]";
const WORKFLOW_STOP = "workflow.stop";
const WAIT_MS = 5_000;
const POLL_MS = 50;

export async function workflowStop(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): Promise<number> {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [workflowId, ...extra] = parsed.positionals;
  if (workflowId === undefined || extra.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    io.err(`haril: no workflow "${workflowId}" (the store is not initialized)`);
    return EXIT_USAGE;
  }
  try {
    const workflow = store.workflows.get(workflowId);
    if (workflow === undefined) {
      io.err(`haril: no workflow "${workflowId}"`);
      return EXIT_USAGE;
    }
    if (workflow.state !== "running" && workflow.state !== "awaiting_human") {
      if (json) io.out(JSON.stringify({ workflowId, commandId: null, state: workflow.state }));
      else io.out(`workflow ${workflowId} is already ${workflow.state}: nothing to stop`);
      return EXIT_OK;
    }
    const commandArgs = { workflowId };
    const queued = store.commands.enqueue({
      type: WORKFLOW_STOP,
      projectId: workflow.projectId,
      args: commandArgs,
      idempotencyKey: `workflow-stop-${storeAccess(host).ids.next()}`,
      requestHash: sha256(
        canonicalJson({ type: WORKFLOW_STOP, projectId: workflow.projectId, args: commandArgs }),
      ),
    });
    nudgeQueued(dataDir);
    const active = leaseHolderAlive(store.runtime.leaseSummary(), host);
    if (active) {
      const deadline = Date.now() + WAIT_MS;
      while (store.commands.get(queued.commandId)?.status === "queued" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
    const status = store.commands.get(queued.commandId);

    // Only this workflow's agents: the processes its turns' runs recorded.
    const turns = new Set(store.workflows.tasks(workflowId).map((task) => task.taskId));
    const control = host.processControl ?? createProcessControl();
    const swept = await killRecordedProcesses(
      store,
      control,
      { unverified: true },
      { select: (record) => turns.has(record.taskId), now: () => clockFor(host).now() },
    );
    const left = swept.alive;
    const report = {
      workflowId,
      commandId: queued.commandId,
      state: status?.status ?? "queued",
      cancelledTasks: status?.taskIds.length ?? 0,
      processes: {
        recorded: swept.checked,
        killed: swept.killed.length,
        alive: left.length,
        unverified: swept.unverified.length,
      },
    };
    if (json) {
      io.out(JSON.stringify(report));
    } else if (status?.status === "applied") {
      io.out(
        `workflow ${workflowId} stopped: ${report.cancelledTasks} ${report.cancelledTasks === 1 ? "turn" : "turns"} cancelled, their agents killed`,
      );
    } else if (status?.status === "rejected") {
      io.out(`workflow ${workflowId}: the stop was rejected: ${status.reason ?? ""}`);
    } else {
      io.out(
        `workflow ${workflowId}: the stop is queued (${active ? "the runtime has not applied it yet" : "the next haril start or haril run applies it"})`,
      );
    }
    if (left.length > 0 && !json) {
      io.out(
        `${left.length} agent processes are still alive: pid ${left.map((item) => item.pid).join(", ")}`,
      );
    }
    if (swept.unverified.length > 0 && !json) io.out(unverifiedLine(swept.unverified.length));
    return left.length > 0 || swept.unverified.length > 0 ? EXIT_WARN : EXIT_OK;
  } finally {
    store.close();
  }
}
