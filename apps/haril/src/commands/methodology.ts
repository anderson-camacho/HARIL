import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BlockRegistry, loadBlockRegistry } from "@haril/os";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";

// `haril methodology list [--json]` (M3-T1). Methodologies are native blocks; the registry is loaded fail closed.

export const METHODOLOGY_PREFIX = "haril.methodology.";

// The bundle copies blocks/ next to dist/haril.mjs (apps/haril/tsdown.config.ts). From source, the blocks
// live at the repository root: the nearest ancestor holding a blocks/methodologies directory wins.
function defaultBlocksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, "blocks");
    if (existsSync(join(candidate, "methodologies"))) return candidate;
    if (dirname(dir) === dir) return join(here, "blocks");
  }
}

// Loads the native registry or reports every rejection with its reasons and returns undefined.
export function loadNativeRegistry(host: HostInfo, io: CliIo): BlockRegistry | undefined {
  const loaded = loadBlockRegistry(host.blocksDir ?? defaultBlocksDir());
  if (loaded.ok) return loaded.registry;
  io.err("haril: the native blocks are invalid and were not loaded:");
  for (const rejection of loaded.rejected) {
    io.err(`  ${rejection.path}`);
    for (const reason of rejection.reasons) io.err(`    - ${reason}`);
  }
  return undefined;
}

// Short names accepted by --methodology (the part after "haril.methodology."), sorted.
export function methodologyNames(registry: BlockRegistry): string[] {
  return registry
    .list()
    .filter((entry) => entry.id.startsWith(METHODOLOGY_PREFIX))
    .map((entry) => entry.id.slice(METHODOLOGY_PREFIX.length))
    .sort();
}

export function methodology(args: readonly string[], io: CliIo, host: HostInfo): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return methodologyList(rest, io, host);
  if (subcommand === undefined) io.err("haril: methodology needs a subcommand");
  else io.err(`haril: unknown methodology subcommand "${subcommand}"`);
  io.err("usage: haril methodology list [--json]");
  return EXIT_USAGE;
}

function methodologyList(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err("usage: haril methodology list [--json]");
    return EXIT_USAGE;
  }
  const registry = loadNativeRegistry(host, io);
  if (registry === undefined) return EXIT_USAGE;

  const items = registry
    .list()
    .filter((entry) => entry.category === "methodology")
    .map((entry) => ({
      id: entry.id,
      version: entry.version,
      sha256: entry.sha256,
      summary: entry.summary,
    }));
  if (parsed.flags.has("--json")) {
    io.out(JSON.stringify({ methodologies: items }));
    return EXIT_OK;
  }
  io.out("methodology                    version  sha256        summary");
  for (const item of items) {
    io.out(
      `${item.id.padEnd(29)}  ${item.version.padEnd(7)}  ${item.sha256.slice(0, 12)}  ${item.summary}`,
    );
  }
  return EXIT_OK;
}
