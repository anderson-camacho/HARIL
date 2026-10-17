import { canonicalJson } from "@haril/core";
import type { Store } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { defaultPidAlive, storeAccess } from "../host.js";
import { RUNTIME_STOP } from "../runtime/shutdown.js";
import { dataDirFor, openExisting, sha256 } from "./common.js";

// `haril stop` (LD-T1, ARCH 4.2): enqueues runtime.stop for the runtime that holds the lease. That runtime stops
// claiming, cancels its in-flight run without charging an attempt, releases its lease and exits 0. Nothing is queued
// when no runtime is active.
const USAGE = "usage: haril stop [--data-dir <path>]";

export function stop(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: [] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) {
    io.out("no runtime is active: nothing to stop, nothing queued");
    return EXIT_OK;
  }
  try {
    if (!runtimeIsActive(store, host)) {
      io.out("no runtime is active: nothing to stop, nothing queued");
      return EXIT_OK;
    }
    const commandArgs = {};
    const result = store.commands.enqueue({
      type: RUNTIME_STOP,
      args: commandArgs,
      idempotencyKey: `runtime-stop-${storeAccess(host).ids.next()}`,
      requestHash: sha256(canonicalJson({ type: RUNTIME_STOP, args: commandArgs })),
    });
    io.out(`command ${result.commandId}: queued (the runtime stops when it applies it)`);
    return EXIT_OK;
  } finally {
    store.close();
  }
}

// The newest lease is active and its holder is alive. An expired lease of a live holder still counts: the holder can
// apply the command once it is responsive again.
function runtimeIsActive(store: Store, host: HostInfo): boolean {
  const lease = store.runtime.leaseSummary();
  if (lease.status !== "active") return false;
  return (host.isPidAlive ?? defaultPidAlive)(lease.pid);
}
