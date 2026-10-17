import {
  describeMemory,
  type MemoryStatusView,
  UNRECORDED_MEMORY_STATUS,
  visibleText,
} from "@haril/core";
import type { RuntimeLeaseSummary } from "@haril/core/ports";
import { readMemoryStatus } from "@haril/state-sqlite";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_ERROR, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { clockFor, defaultPidAlive } from "../host.js";
import { VERSION } from "../version.js";
import { dataDirFor } from "./common.js";

// `haril memory status [--json]` (MC-T4; BL-082, RF-132; MEMORY.md 12.3): read-only. It reads the meta keys memory.*
// the runtime recorded and the outbox counts through a read-only connection, so it works with no runtime running, never
// writes or migrates haril.db and never starts a provider. Without a live runtime the recorded health is "not checked".
// The shell's Connect box reads the same status and describes it with the same Core rule.

const USAGE = "usage: haril memory status [--json] [--data-dir <path>]";

interface MemoryReport extends MemoryStatusView {
  readonly initialized: boolean;
  readonly dataDir: string;
  readonly runtime: "running" | "not_running";
}

export function memory(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "status") return memoryStatus(rest, io, host);
  if (subcommand === undefined) io.err("haril: memory needs a subcommand");
  else io.err(`haril: unknown memory subcommand "${subcommand}"`);
  io.err(USAGE);
  return EXIT_USAGE;
}

function memoryStatus(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  let reading: ReturnType<typeof readMemoryStatus>;
  try {
    reading = readMemoryStatus(dataDir);
  } catch (error) {
    io.err(
      `haril: the store could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_ERROR;
  }
  const alive =
    reading !== undefined &&
    leaseAlive(reading.lease, clockFor(host).now(), host.isPidAlive ?? defaultPidAlive);
  const report: MemoryReport = {
    initialized: reading !== undefined,
    dataDir,
    runtime: alive ? "running" : "not_running",
    ...describeMemory(reading?.status ?? UNRECORDED_MEMORY_STATUS, alive),
  };
  if (parsed.flags.has("--json")) io.out(JSON.stringify(report));
  else printText(io, report);
  return EXIT_OK;
}

// A runtime holds the lease: active, unexpired and its process alive (as the shell tells it, LD-T6).
function leaseAlive(
  lease: RuntimeLeaseSummary,
  now: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  return lease.status === "active" && lease.expiresAt > now && isPidAlive(lease.pid);
}

function printText(io: CliIo, report: MemoryReport): void {
  io.out(`haril ${VERSION} memory status`);
  io.out(`  data        ${report.dataDir}`);
  if (!report.initialized) {
    io.out("  store       not initialized (run haril project init <path> --name <name> --yes)");
  }
  // The provider name comes from the store, so it is shown as the terminal draws it (LD-T7c).
  const source =
    report.providerSource === "default"
      ? "the default: no runtime has recorded one yet"
      : "recorded by the runtime";
  io.out(visibleText(`  provider    ${report.provider} (${source})`));
  io.out(`  persistent  ${persistenceText(report.persistent)}`);
  io.out(`  runtime     ${report.runtime === "running" ? "running" : "not running"}`);
  io.out(`  health      ${healthText(report)}`);
  io.out(`  degraded    ${degradedText(report)}`);
  const { outbox } = report;
  io.out(
    `  outbox      ${outbox.depth} to deliver (pending ${outbox.pending}, sending ${outbox.sending}, needs review ${outbox.needsReview}, dead ${outbox.dead}, delivered ${outbox.delivered})`,
  );
  if (outbox.oldestPendingAt !== null) {
    io.out(`              oldest pending since ${isoTime(outbox.oldestPendingAt)}`);
  }
}

function persistenceText(persistent: boolean | null): string {
  if (persistent === null) return "unknown";
  return persistent
    ? "yes"
    : "no (not persistent: the knowledge and project memories are not kept, U-15)";
}

function healthText(report: MemoryReport): string {
  const since = report.lastStateAt === null ? "" : ` since ${isoTime(report.lastStateAt)}`;
  if (report.health !== "not_checked") return `${report.health}${since}`;
  if (report.lastState === null) return "not checked (no runtime has recorded it yet)";
  const why =
    report.runtime === "running" ? "the runtime has not recorded it" : "no runtime running";
  return `not checked (${why}; last recorded ${report.lastState}${since})`;
}

function degradedText(report: MemoryReport): string {
  const error = report.lastError;
  const last =
    error === null ? "" : `; last error ${visibleText(error.code)} at ${isoTime(error.at)}`;
  return `${report.degraded ? "yes" : "no"}${last}`;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
