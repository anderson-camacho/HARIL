import { canonicalJson } from "@haril/core";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { storeAccess } from "../host.js";
import { RUNTIME_STOP } from "../runtime/shutdown.js";
import { dataDirFor, leaseHolderAlive, nudgeQueued, openExisting, sha256 } from "./common.js";

// `haril resume` (docs/modos-y-delegacion.md 3.14): lifts the halt an emergency stop left. It enqueues runtime.resume,
// which the runtime applies in order, so a stop queued before it is applied first. Cancelled work stays cancelled and a
// stopped workflow stays stopped (3.14: the stop ends them); the standalone tasks that kept waiting run again. With no
// halt and no queued emergency stop there is nothing to lift and nothing is queued.
const USAGE = "usage: haril resume [--json] [--data-dir <path>]";
const RUNTIME_RESUME = "runtime.resume";

export function resume(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  const say = (commandId: string | null, text: string): number => {
    if (json) io.out(JSON.stringify({ commandId, queued: commandId !== null }));
    else io.out(text);
    return EXIT_OK;
  };
  if (store === undefined) return say(null, "the runtime is not halted: nothing to resume");
  try {
    const stopQueued = store.commands
      .listQueued()
      .some((command) => command.type === RUNTIME_STOP && command.args.mode === "now");
    if (!store.runtime.haltState().halted && !stopQueued) {
      return say(null, "the runtime is not halted: nothing to resume");
    }
    const commandArgs = {};
    const result = store.commands.enqueue({
      type: RUNTIME_RESUME,
      args: commandArgs,
      idempotencyKey: `runtime-resume-${storeAccess(host).ids.next()}`,
      requestHash: sha256(canonicalJson({ type: RUNTIME_RESUME, args: commandArgs })),
    });
    nudgeQueued(dataDir);
    const applier = leaseHolderAlive(store.runtime.leaseSummary(), host)
      ? "the runtime applies it now"
      : "the next haril start or haril run applies it";
    return say(
      result.commandId,
      `command ${result.commandId}: resume queued (${applier}); cancelled work stays cancelled`,
    );
  } finally {
    store.close();
  }
}
