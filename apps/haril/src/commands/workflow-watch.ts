import type { WorkflowSnapshot } from "@haril/contracts";
import { type ControlClient, connect } from "@haril/control";
import type { Store } from "@haril/core/ports";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { clockFor } from "../host.js";
import { dataDirFor, openExisting } from "./common.js";
import { storeQuota } from "./snapshot-quota.js";
import { EXIT_ON_STDIN_END, onStdinEnd } from "./stdin-end.js";
import { buildWorkflowSnapshot } from "./workflow-snapshot.js";

// `haril workflow watch <workflowId>` (docs/modos-y-delegacion.md 6, 7.6; phase F5b): a stream of JSON lines, each one
// WorkflowSnapshot v1 (ADR-0021), for the console's ORCHESTRATION view. One snapshot at once; then one on each wake of
// the runtime's control channel (a subscription, as haril shell holds one: every runtime event is followed by a wake),
// at most one per WAKE_INTERVAL_MS for a burst. Without a runtime, or between wakes, the store is read every
// --interval-ms and a snapshot printed only when it changed (the elapsed time aside), and a subscription is tried again,
// so a runtime that starts later is followed too. It ends after the snapshot that shows the workflow ended (completed,
// failed or stopped), or on Ctrl+C, or with --exit-on-stdin-end when its stdin ends (the console that runs it as a child
// went away). It reads the store only: it writes nothing and queues nothing.

const USAGE =
  "usage: haril workflow watch <workflowId> [--json] [--interval-ms <n>] [--exit-on-stdin-end] [--data-dir <path>]";
const DEFAULT_INTERVAL_MS = 1_000;
const WAKE_INTERVAL_MS = 250;
const ENDED = new Set<WorkflowSnapshot["workflow"]["state"]>(["completed", "failed", "stopped"]);
const NOT_INITIALIZED =
  "store not initialized (run haril project init <path> --name <name> --yes first)";

function fail(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

// What makes two snapshots different: everything but the clock that runs while nothing happens.
function fingerprint(snapshot: WorkflowSnapshot): string {
  return JSON.stringify({ ...snapshot, workflow: { ...snapshot.workflow, elapsedMs: 0 } });
}

export function workflowWatch(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
): number | Promise<number> {
  // --json is accepted as spec 6 writes it: every line is JSON already.
  const parsed = parseArgs(args, {
    values: ["--interval-ms", "--data-dir"],
    flags: ["--json", EXIT_ON_STDIN_END],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [workflowId, ...extra] = parsed.positionals;
  if (workflowId === undefined || extra.length > 0) return fail(io, USAGE);
  const intervalText = lastValue(parsed, "--interval-ms");
  const intervalMs = intervalText === undefined ? DEFAULT_INTERVAL_MS : Number(intervalText);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000) {
    return fail(io, "--interval-ms takes a whole number of milliseconds from 10 to 60000");
  }
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  const store = openExisting(host, dataDir);
  if (store === undefined) return fail(io, NOT_INITIALIZED);
  if (store.workflows.get(workflowId) === undefined) {
    store.close();
    return fail(io, `no workflow with id "${workflowId}"`);
  }
  return follow(
    store,
    workflowId,
    dataDir,
    intervalMs,
    io,
    host,
    parsed.flags.has(EXIT_ON_STDIN_END),
  );
}

function follow(
  store: Store,
  workflowId: string,
  dataDir: string,
  intervalMs: number,
  io: CliIo,
  host: HostInfo,
  exitOnStdinEnd: boolean,
): Promise<number> {
  const clock = clockFor(host);
  const connectControl = host.connectControl ?? connect;
  const signals = host.signals ?? process;
  let last = "";
  // Prints the snapshot when forced (a wake) or when it changed; true once the workflow ended.
  const print = (force: boolean): boolean => {
    const now = clock.now();
    const snapshot = buildWorkflowSnapshot(store, workflowId, {
      now,
      ...storeQuota(store, host, now),
    });
    const current = fingerprint(snapshot);
    if (force || current !== last) io.out(JSON.stringify(snapshot));
    last = current;
    return ENDED.has(snapshot.workflow.state);
  };
  if (print(true)) {
    store.close();
    return Promise.resolve(EXIT_OK);
  }
  return new Promise((resolve) => {
    let client: ControlClient | undefined;
    let connecting = false;
    let ended = false;
    let pendingWake: ReturnType<typeof setTimeout> | undefined;
    let lastWake = Number.NEGATIVE_INFINITY;
    let stopStdin: (() => void) | undefined;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      stopStdin?.();
      clearInterval(poll);
      if (pendingWake !== undefined) clearTimeout(pendingWake);
      signals.off("SIGINT", finish);
      signals.off("SIGTERM", finish);
      const open = client;
      client = undefined;
      open?.close();
      store.close();
      resolve(EXIT_OK);
    };
    const step = (force: boolean): void => {
      if (ended) return;
      try {
        if (print(force)) finish();
      } catch (error) {
        io.err(`haril: ${error instanceof Error ? error.message : String(error)}`);
        finish();
      }
    };
    // A wake prints at once, or once the interval since the last wake passed: a burst prints the newest rows once more.
    const onWake = (): void => {
      if (ended || pendingWake !== undefined) return;
      const wait = lastWake + WAKE_INTERVAL_MS - Date.now();
      const now = (): void => {
        pendingWake = undefined;
        lastWake = Date.now();
        step(true);
      };
      if (wait <= 0) now();
      else pendingWake = setTimeout(now, wait);
    };
    const subscribe = async (): Promise<void> => {
      if (client !== undefined || connecting || ended) return;
      connecting = true;
      const next = await connectControl(dataDir, { subscribe: true }).catch(() => undefined);
      connecting = false;
      if (next === undefined) return;
      if (ended) {
        next.close();
        return;
      }
      client = next;
      next.onWake(onWake);
      next.onClose(() => {
        if (client === next) client = undefined;
      });
    };
    const poll = setInterval(() => {
      step(false);
      if (!ended && client === undefined) void subscribe();
    }, intervalMs);
    signals.on("SIGINT", finish);
    signals.on("SIGTERM", finish);
    if (exitOnStdinEnd) stopStdin = onStdinEnd(host, finish);
    void subscribe();
  });
}
