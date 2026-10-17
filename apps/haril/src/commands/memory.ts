import {
  describeMemory,
  type MemoryStatusView,
  UNRECORDED_MEMORY_STATUS,
  visibleText,
} from "@haril/core";
import { readMemoryStatus, StoreError } from "@haril/state-sqlite";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_ERROR, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { VERSION } from "../version.js";
import { dataDirFor, leaseHolderAlive } from "./common.js";

// `haril memory status [--json]` (MC-T4; BL-082, RF-132; MEMORY.md 12.3): read-only. It reads the meta keys memory.*
// the runtime recorded and the outbox counts without writing or migrating haril.db, leaves the data dir as it found it,
// works with no runtime running and never starts a provider. Without a live runtime the recorded health is "not
// checked". A haril.db without the HARIL schema reads as not initialized, and one of another application is refused
// with the gate's message, as haril status does. haril status and the shell's Connect box read the same status and
// describe it with the same Core rule.

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
    // The gate's refusal reaches the CLI's error report, the same exit and text as haril status (MC-T4 fix).
    if (error instanceof StoreError) throw error;
    io.err(
      `haril: the store could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_ERROR;
  }
  const alive = reading !== undefined && leaseHolderAlive(reading.lease, host);
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

// One line for haril status (MEMORY.md 12.3): "null · not checked (last recorded active) · degraded no · outbox 0 to
// deliver". The provider name comes from the store, so the caller shows it as the terminal draws it.
export function memoryLine(view: MemoryStatusView): string {
  const health =
    view.health !== "not_checked"
      ? view.health
      : view.lastState === null
        ? "not checked"
        : `not checked (last recorded ${view.lastState})`;
  return `${view.provider} · ${health} · degraded ${view.degraded ? "yes" : "no"} · outbox ${view.outbox.depth} to deliver`;
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
