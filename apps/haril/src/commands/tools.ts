import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { resolveDataDir } from "../data-dir.js";
import { defaultEngramBinary, ENGRAM_VERSION, loadMemorySettings } from "../memory-config.js";
import { harilConfigPath } from "../providers.js";
import { runtimeRootFor } from "../runtime.js";
import { extractBinary } from "../tools/archive.js";
import {
  type EngramEnsureResult,
  type EnsureDeps,
  type EnsureServices,
  ensureEngram,
} from "../tools/ensure.js";
import { nodeEnsureFs } from "../tools/fs.js";
import { engramSmoke } from "../tools/smoke.js";
import { readToolsState, type ToolsState, writeToolsState } from "../tools/state.js";
import {
  collectToolsReport,
  type RefreshMode,
  type ToolsDeps,
  type ToolsInput,
} from "../tools/status.js";
import { runCapped, SYSTEM_DETECT_DEPS } from "../tools/system.js";
import type { Install, ToolState, ToolStatus } from "../tools/types.js";
import { VERSION } from "../version.js";

// `haril tools status [--json] [--refresh]`: where engram and gentle-ai are installed, their real versions, and the
// latest published ones. By default it only inspects this machine (it runs each binary's version command, which is
// read-only) and reads the cached latest versions; --refresh asks GitHub now and saves the answer.
//
// `haril tools ensure [engram|gentle-ai] [--json] [--force]`: refreshes the latest versions when they are due and, for
// Engram, installs or repairs HARIL's own copy after verifying it (src/tools/ensure.ts). For gentle-ai it only detects.

const STATUS_USAGE = "usage: haril tools status [--json] [--refresh]";
const ENSURE_USAGE = "usage: haril tools ensure [engram|gentle-ai] [--json] [--force]";
const ENSURE_SCHEMA = "haril.tools.ensure/1";
const EXIT_FAILED = 1;

export interface ToolsServices extends Partial<ToolsDeps> {
  readonly ensure?: Partial<EnsureServices>;
}

export function tools(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: ToolsServices = {},
): Promise<number> | number {
  const [subcommand, ...rest] = args;
  if (subcommand === "status") return toolsStatus(rest, io, host, services);
  if (subcommand === "ensure") return toolsEnsure(rest, io, host, services);
  if (subcommand === undefined) io.err("haril: tools needs a subcommand");
  else io.err(`haril: unknown tools subcommand "${subcommand}"`);
  io.err(STATUS_USAGE);
  io.err(ENSURE_USAGE);
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

function toolsDepsFor(host: HostInfo, services: ToolsServices): ToolsDeps {
  const statePath = statePathFor(host);
  return {
    detect: services.detect ?? SYSTEM_DETECT_DEPS,
    fetch: services.fetch ?? ((url, init) => fetch(url, init)),
    now: services.now ?? Date.now,
    readState: services.readState ?? (() => readToolsState(statePath)),
    writeState: services.writeState ?? ((state: ToolsState) => writeToolsState(statePath, state)),
  };
}

function toolsInputFor(host: HostInfo): ToolsInput {
  const { runtimeBinary, notes } = engramPaths(host);
  return {
    platform: host.platform,
    env: host.env ?? {},
    homeDir: host.homeDir ?? "",
    harilCopy: defaultEngramBinary(host),
    runtimeBinary,
    pin: ENGRAM_VERSION,
    notes,
  };
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
    io.err(STATUS_USAGE);
    return EXIT_USAGE;
  }

  const mode: RefreshMode = parsed.flags.has("--refresh") ? "always" : "never";
  const report = await collectToolsReport(toolsInputFor(host), toolsDepsFor(host, services), mode);

  if (parsed.flags.has("--json")) io.out(JSON.stringify(report));
  else printText(io, report.tools, "tools status");
  return EXIT_OK;
}

function ensureDepsFor(host: HostInfo, services: ToolsServices): EnsureDeps {
  const own = services.ensure ?? {};
  const fs = own.fs ?? nodeEnsureFs;
  const exec = own.exec ?? runCapped;
  return {
    ...toolsDepsFor(host, services),
    download: own.download ?? ((url, init) => fetch(url, init)),
    exec,
    extract: own.extract ?? ((input) => extractBinary(input, exec, fs)),
    smoke: own.smoke ?? engramSmoke,
    fs,
    pid: own.pid ?? process.pid,
    makeId: own.makeId ?? (() => randomBytes(4).toString("hex")),
  };
}

async function toolsEnsure(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: ToolsServices,
): Promise<number> {
  const parsed = parseArgs(args, { values: [], flags: ["--json", "--force"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [target, ...extra] = parsed.positionals;
  if (extra.length > 0 || (target !== undefined && target !== "engram" && target !== "gentle-ai")) {
    io.err(ENSURE_USAGE);
    return EXIT_USAGE;
  }
  const json = parsed.flags.has("--json");

  if (target === "gentle-ai") {
    // Installing or updating gentle-ai builds it from source with Go: an explicit action of its own, not an ensure.
    const report = await collectToolsReport(
      toolsInputFor(host),
      toolsDepsFor(host, services),
      "if-due",
    );
    const gentleAi = {
      action: "none",
      message:
        "gentle-ai was detected and its latest version refreshed; ensure does not install it",
    };
    if (json) {
      io.out(JSON.stringify({ schema: ENSURE_SCHEMA, gentleAi, status: report }));
    } else {
      io.out(`haril ${VERSION} tools ensure`);
      io.out(`gentle-ai: ${gentleAi.message}`);
      printText(io, report.tools);
    }
    return EXIT_OK;
  }

  const platform = host.platform;
  const homeDir = host.homeDir ?? "";
  const env = host.env ?? {};
  const outcome = await ensureEngram(
    {
      platform,
      arch: host.arch,
      env,
      homeDir,
      runtimeRoot: runtimeRootFor(host),
      configPath: harilConfigPath(host).path,
      dataDir: resolveDataDir({ env, platform, homeDir }).dataDir,
      pin: ENGRAM_VERSION,
      force: parsed.flags.has("--force"),
    },
    ensureDepsFor(host, services),
  );

  if (json) {
    const document = { schema: ENSURE_SCHEMA, engram: outcome.engram, status: outcome.report };
    io.out(JSON.stringify(document));
  } else {
    io.out(`haril ${VERSION} tools ensure`);
    printEnsure(io, outcome.engram);
    printText(io, outcome.report.tools);
  }
  return outcome.engram.action === "failed" ? EXIT_FAILED : EXIT_OK;
}

function printEnsure(io: CliIo, result: EngramEnsureResult): void {
  const lines: Record<EngramEnsureResult["action"], string> = {
    none: `engram: up to date (${ENGRAM_VERSION})`,
    installed: `engram: installed ${result.to ?? ENGRAM_VERSION}`,
    updated: `engram: updated ${result.from ?? "unknown"} -> ${result.to ?? ENGRAM_VERSION}`,
    skipped: "engram: skipped",
    busy: "engram: busy",
    failed: "engram: failed",
  };
  io.out(lines[result.action]);
  if (result.path !== undefined) io.out(`  path        ${result.path}`);
  if (result.message !== undefined) io.out(`  message     ${result.message}`);
  for (const note of result.notes ?? []) io.out(`  note        ${note}`);
}

const STATE_WORDS: Record<ToolState, string> = {
  ok: "ok",
  outdated: "outdated",
  missing: "missing",
  unknown: "unknown",
};

function printText(io: CliIo, statuses: readonly ToolStatus[], title?: string): void {
  if (title !== undefined) io.out(`haril ${VERSION} ${title}`);
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
