import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { dataDirFor } from "./common.js";
import { defaultPidAlive } from "../host.js";
import { runtimeRootFor } from "../runtime.js";

// Local-source updater. No unverified GitHub archive, branch or arbitrary remote script is
// executed: the caller explicitly selects a checked-out HARIL source repository. The
// existing installer performs dependency resolution, build, versioned installation and doctor.
// Remote updates can be enabled later when signed/pinned release artifacts are published.
const USAGE = "usage: haril update [--check] [--from <repository>] [--yes]";

export interface UpdateServices {
  readonly readText: (path: string) => string;
  readonly exists: (path: string) => boolean;
  readonly activeRuntime: (dataDir: string) => { state: "none" | "active" | "unknown"; detail?: string };
  readonly install: (script: string, root: string, source: string) => Promise<number>;
  readonly confirm: () => Promise<boolean>;
}

function versionParts(input: unknown): number[] | null {
  if (typeof input !== "string" || !/^\d+\.\d+\.\d+$/.test(input)) return null;
  return input.split(".").map(Number);
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (left === null || right === null) throw new Error("invalid version");
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readVersion(path: string, services: UpdateServices): string {
  const value: unknown = JSON.parse(services.readText(path));
  const version =
    typeof value === "object" && value !== null && "version" in value ? value.version : null;
  if (versionParts(version) === null) throw new Error(`${path}: invalid semantic version`);
  return version as string;
}

function installedVersion(root: string, services: UpdateServices): string {
  const path = join(root, "app", "current.json");
  if (!services.exists(path)) {
    throw new Error(`${path} is missing; install HARIL before updating`);
  }
  return readVersion(path, services);
}

// Fail closed if an existing SQLite database cannot be inspected. A stale or dead
// lease is not active; a live, unexpired lease is an unconditional update refusal.
function runtimeState(dataDir: string): { state: "none" | "active" | "unknown"; detail?: string } {
  const file = join(dataDir, "haril.db");
  if (!existsSync(file)) return { state: "none" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const leases = db
      .prepare("SELECT pid FROM runtime_leases WHERE status = 'active' AND expires_at > ?")
      .all(Date.now()) as { pid: number }[];
    const active = leases.find((lease) => defaultPidAlive(lease.pid));
    return active === undefined
      ? { state: "none" }
      : { state: "active", detail: `pid ${active.pid}` };
  } catch (error) {
    if (error instanceof Error && /no such table: runtime_leases/.test(error.message)) {
      return { state: "none" };
    }
    return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function installFrom(script: string, root: string, source: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, "--root", root], {
      cwd: source,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => done(1));
    child.once("close", (code) => done(code ?? 1));
  });
}

async function askConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Update HARIL from this local checkout? [y/N] ");
    return /^(y|yes|s|si|sí)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const DEFAULT_SERVICES: UpdateServices = {
  readText: (path) => readFileSync(path, "utf8"),
  exists: existsSync,
  activeRuntime: runtimeState,
  install: installFrom,
  confirm: askConfirm,
};

export async function update(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: UpdateServices = DEFAULT_SERVICES,
): Promise<number> {
  let sourceArg: string | undefined;
  let check = false;
  let yes = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--check") check = true;
    else if (token === "--yes") yes = true;
    else if (token === "--from") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || value === "") {
        io.err(USAGE);
        return EXIT_USAGE;
      }
      sourceArg = value;
      index++;
    } else {
      io.err(USAGE);
      return EXIT_USAGE;
    }
  }

  const source = resolve(host.cwd ?? process.cwd(), sourceArg ?? host.env?.HARIL_SOURCE_DIR ?? ".");
  const script = join(source, "scripts", "install.mjs");
  const manifest = join(source, "apps", "haril", "package.json");
  const root = runtimeRootFor(host);
  let current: string;
  let available: string;
  try {
    current = installedVersion(root, services);
    if (!services.exists(script) || !services.exists(manifest)) {
      io.err(
        `haril: no local HARIL checkout at ${source}; use --from <repository>. No official release auto-updater is configured.`,
      );
      return EXIT_USAGE;
    }
    available = readVersion(manifest, services);
  } catch (error) {
    io.err(`haril: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_USAGE;
  }

  io.out(`HARIL installed: ${current}; local source: ${available} (${source})`);
  const comparison = compareVersions(available, current);
  if (comparison < 0) {
    io.err("haril: the selected source is older; downgrades are not automatic");
    return EXIT_USAGE;
  }
  if (comparison === 0) {
    io.out("HARIL is already at the selected source version.");
    return EXIT_OK;
  }
  if (check) {
    io.out("An update is available from this local checkout; no files were changed.");
    return EXIT_OK;
  }

  const runtime = services.activeRuntime(dataDirFor(host, undefined));
  if (runtime.state !== "none") {
    io.err(
      runtime.state === "active"
        ? `haril: a runtime is active (${runtime.detail ?? "unknown PID"}); stop it before updating`
        : `haril: runtime state could not be checked (${runtime.detail ?? "unknown"}); update refused`,
    );
    return EXIT_USAGE;
  }
  if (!yes) {
    if (host.interactive !== true) {
      io.err("haril: confirmation required; inspect with --check, then use --yes");
      return EXIT_USAGE;
    }
    if (!(await services.confirm())) {
      io.out("Update cancelled; no files were changed.");
      return EXIT_OK;
    }
  }

  io.out(`Updating HARIL to ${available} through the repository installer...`);
  const result = await services.install(script, root, source);
  if (result !== 0) {
    io.err(`haril: installer failed (exit ${result}); inspect its output. Do not assume the update succeeded.`);
    return 1;
  }
  io.out(`HARIL update to ${available} completed; open a new terminal before continuing.`);
  return EXIT_OK;
}
