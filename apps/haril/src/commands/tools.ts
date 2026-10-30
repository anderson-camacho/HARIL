import { posix, win32 } from "node:path";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { defaultEngramBinary, ENGRAM_VERSION, loadMemorySettings } from "../memory-config.js";
import { runtimeRootFor } from "../runtime.js";
import { readToolsState, type ToolsState, writeToolsState } from "../tools/state.js";
import {
  collectToolsReport,
  type RefreshMode,
  type ToolsDeps,
  type ToolsInput,
} from "../tools/status.js";
import { SYSTEM_DETECT_DEPS } from "../tools/system.js";
import type { Install, ToolState, ToolStatus } from "../tools/types.js";
import { VERSION } from "../version.js";

// `haril tools status [--json] [--refresh]`: where engram and gentle-ai are installed, their real versions, and the
// latest published ones. By default it only inspects this machine (it runs each binary's version command, which is
// read-only) and reads the cached latest versions; --refresh asks GitHub now and saves the answer.

const USAGE = "usage: haril tools status [--json] [--refresh]";

export type ToolsServices = Partial<ToolsDeps>;

export function tools(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: ToolsServices = {},
): Promise<number> | number {
  const [subcommand, ...rest] = args;
  if (subcommand === "status") return toolsStatus(rest, io, host, services);
  if (subcommand === undefined) io.err("haril: tools needs a subcommand");
  else io.err(`haril: unknown tools subcommand "${subcommand}"`);
  io.err(USAGE);
  return EXIT_USAGE;
}

function statePathFor(host: HostInfo): string {
  const ops = host.platform === "win32" ? win32 : posix;
  return ops.join(runtimeRootFor(host), "state", "tools.json");
}

// The settings decide which Engram the runtime executes; an unreadable haril.json must not hide the rest of the report.
function engramPaths(host: HostInfo): { runtimeBinary: string; notes: string[] } {
  try {
    return { runtimeBinary: loadMemorySettings(host).binary, notes: [] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      runtimeBinary: defaultEngramBinary(host),
      notes: [`haril.json could not be read (${reason}); showing the default Engram location`],
    };
  }
}

async function toolsStatus(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: ToolsServices,
): Promise<number> {
  const parsed = parseArgs(args, { values: [], flags: ["--json", "--refresh"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  const statePath = statePathFor(host);
  const deps: ToolsDeps = {
    detect: services.detect ?? SYSTEM_DETECT_DEPS,
    fetch: services.fetch ?? ((url, init) => fetch(url, init)),
    now: services.now ?? Date.now,
    readState: services.readState ?? (() => readToolsState(statePath)),
    writeState: services.writeState ?? ((state: ToolsState) => writeToolsState(statePath, state)),
  };
  const { runtimeBinary, notes } = engramPaths(host);
  const input: ToolsInput = {
    platform: host.platform,
    env: host.env ?? {},
    homeDir: host.homeDir ?? "",
    harilCopy: defaultEngramBinary(host),
    runtimeBinary,
    pin: ENGRAM_VERSION,
    notes,
  };
  const mode: RefreshMode = parsed.flags.has("--refresh") ? "always" : "never";
  const report = await collectToolsReport(input, deps, mode);

  if (parsed.flags.has("--json")) io.out(JSON.stringify(report));
  else printText(io, report.tools);
  return EXIT_OK;
}

const STATE_WORDS: Record<ToolState, string> = {
  ok: "ok",
  outdated: "outdated",
  missing: "missing",
  unknown: "unknown",
};

function printText(io: CliIo, statuses: readonly ToolStatus[]): void {
  io.out(`haril ${VERSION} tools status`);
  for (const status of statuses) {
    io.out(`${status.id}: ${STATE_WORDS[status.state]}`);
    io.out(`  active      ${status.active === null ? "none" : installText(status.active)}`);
    io.out(`  latest      ${latestText(status)}`);
    if (status.qualified !== null) io.out(`  qualified   ${status.qualified}`);
    for (const install of status.installs.filter((candidate) => !candidate.active)) {
      const why = status.id === "engram" ? "not used by HARIL" : "not the one that runs";
      io.out(`  other       ${installText(install, why)}`);
    }
    for (const note of status.notes) io.out(`  note        ${note}`);
  }
}

// "<path>  <version>  (<origins>[; why])": the version is "unknown" when it could not be read.
function installText(install: Install, why?: string): string {
  const origins = install.origins.join(" + ");
  return `${install.path}  ${install.version ?? "unknown"}  (${origins}${why === undefined ? "" : `; ${why}`})`;
}

function latestText(status: ToolStatus): string {
  if (status.latest === null) return "not available";
  return status.latestCheckedAt === null
    ? status.latest
    : `${status.latest}  (checked ${status.latestCheckedAt})`;
}
