import { posix, win32 } from "node:path";
import { argsProblem, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { runtimeRootFor } from "../runtime.js";
import { readConfigDocument, serializeConfig, writeConfigAtomically } from "./config-file.js";

// Pi is launched with PI_CODING_AGENT_DIR=<HARIL runtime>/agent. Manage ONLY that private
// user-level settings file, never the user's ~/.pi, Gentle Shell or a project's trusted .pi.
// A configured package is not proof that Pi installed or loaded its extension this session.
const USAGE = [
  "usage: haril extensions list [--json]",
  "       haril extensions enable|disable <exact-package-source> --yes [--json]",
  "Only HARIL's private Pi package declarations are changed; restart haril to reload.",
  "For installing or reviewing packages and local project overrides, use Pi's official package tools.",
].join("\n");

type PackageExtensionState = "enabled" | "disabled" | "filtered";

interface ConfiguredPiPackage {
  readonly source: string;
  readonly extensions: PackageExtensionState;
}

interface ParsedPackage extends ConfiguredPiPackage {
  readonly value: string | Record<string, unknown>;
}

function packageOf(value: unknown): ParsedPackage | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return { source: value, extensions: "enabled", value };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.source !== "string" || record.source.trim() === "") return undefined;
  const filter = record.extensions;
  if (
    filter !== undefined &&
    (!Array.isArray(filter) || !filter.every((x) => typeof x === "string"))
  ) {
    return undefined;
  }
  return {
    source: record.source,
    extensions:
      filter === undefined
        ? "enabled"
        : (filter as string[]).length === 0
          ? "disabled"
          : "filtered",
    value: record,
  };
}

function failure(io: CliIo, message: string): number {
  io.err(`haril: ${message}`);
  return EXIT_USAGE;
}

function output(
  io: CliIo,
  settingsPath: string,
  packages: readonly ParsedPackage[],
  json: boolean,
): void {
  if (json) {
    io.out(
      JSON.stringify({
        scope: "haril-private-pi-agent",
        settingsPath,
        reloadRequired: true,
        installedOrLoaded: "unknown",
        packages: packages.map(({ source, extensions }) => ({ source, extensions })),
      }),
    );
    return;
  }
  io.out("HARIL · declaraciones de paquetes Pi (sin verificar instalación ni carga)");
  if (!packages.length) io.out("  No hay paquetes Pi declarados en HARIL.");
  for (const item of packages) io.out(`  ${item.extensions.padEnd(8)}  ${item.source}`);
  io.out("enable/disable requiere --yes y reiniciar HARIL. Para instalar usa Pi (pi install).");
}

export function extensions(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--yes", "--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [verb = "list", source, ...extra] = parsed.positionals;
  const json = parsed.flags.has("--json");
  if (
    extra.length > 0 ||
    (verb === "list"
      ? source !== undefined
      : !["enable", "disable"].includes(verb) || source === undefined)
  ) {
    return failure(io, USAGE);
  }

  const ops = host.platform === "win32" ? win32 : posix;
  const root = ops.resolve(host.cwd ?? process.cwd(), runtimeRootFor(host));
  const settingsPath = ops.join(root, "agent", "settings.json");
  const read = readConfigDocument(settingsPath);
  if (!read.ok) return failure(io, `${settingsPath}: ${read.error}`);
  const raw = read.document.packages ?? [];
  if (!Array.isArray(raw)) return failure(io, `${settingsPath}: packages must be an array`);
  const packages = raw.map(packageOf);
  if (packages.some((item) => item === undefined)) {
    return failure(io, `${settingsPath}: invalid package entry; no changes made`);
  }
  const declarations = packages as ParsedPackage[];
  if (verb === "list") {
    output(io, settingsPath, declarations, json);
    return EXIT_OK;
  }
  const matching = declarations
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.source === source);
  if (matching.length !== 1) {
    return failure(
      io,
      `${source}: package not declared exactly once in HARIL's private Pi settings`,
    );
  }
  const entry = matching[0];
  if (entry === undefined) return failure(io, "package not found");
  if (entry.item.extensions === "filtered") {
    return failure(
      io,
      `${source}: custom extension filters; use Pi's official pi config to preserve them`,
    );
  }
  if (!parsed.flags.has("--yes")) {
    return failure(
      io,
      "pass --yes after reviewing the package; changing load state requires restarting HARIL",
    );
  }

  const shouldEnable = verb === "enable";
  if ((entry.item.extensions === "enabled") !== shouldEnable) {
    if (!shouldEnable) {
      raw[entry.index] =
        typeof entry.item.value === "string"
          ? { source: entry.item.value, extensions: [] }
          : { ...entry.item.value, extensions: [] };
    } else {
      const next = { ...(entry.item.value as Record<string, unknown>) };
      delete next.extensions;
      raw[entry.index] = Object.keys(next).length === 1 ? next.source : next;
    }
    const nextDocument = { ...read.document, packages: raw };
    try {
      writeConfigAtomically(
        settingsPath,
        serializeConfig(nextDocument, read.exists ? read.text : undefined),
      );
    } catch (error) {
      return failure(
        io,
        `could not update Pi settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const updated = raw.map(packageOf) as ParsedPackage[];
  output(io, settingsPath, updated, json);
  return EXIT_OK;
}
