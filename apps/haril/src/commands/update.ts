import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { defaultPidAlive } from "../host.js";
import { runtimeRootFor } from "../runtime.js";
import { dataDirFor } from "./common.js";

// Without --from, HARIL fetches its own main branch into an isolated temporary directory.
// This is a development channel, NOT a signed release; confirmation is still required.
const MAIN_REPOSITORY = "https://github.com/anderson-camacho/HARIL.git";
const USAGE = "usage: haril update [--check] [--from <repository> | --main] [--yes]";

interface MainCheckout {
  readonly source: string;
  readonly revision: string;
  cleanup(): void;
}

export interface UpdateServices {
  readonly readText: (path: string) => string;
  readonly exists: (path: string) => boolean;
  readonly activeRuntime: (dataDir: string) => {
    state: "none" | "active" | "unknown";
    detail?: string;
  };
  readonly install: (script: string, root: string, source: string) => Promise<number>;
  readonly confirm: () => Promise<boolean>;
  readonly checkoutMain: () => Promise<MainCheckout>;
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

function git(args: readonly string[], cwd?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90_000);
    child.stdout.on("data", (bytes: Buffer) => {
      stdout = (stdout + bytes.toString("utf8")).slice(-4096);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = (stderr + bytes.toString("utf8")).slice(-4096);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(stdout);
      else
        reject(
          new Error(
            timedOut
              ? "git timed out after 90s; check GitHub connection, VPN, proxy or firewall"
              : `git failed (exit ${String(code)}): ${stderr.trim() || "connection closed or process interrupted"}`,
          ),
        );
    });
  });
}

// Prefer a ZIP archive over Git so updates work even when Git is not installed.
// This is an unsigned development snapshot: the printed 'archive:main' is not a commit SHA.
async function checkoutArchive(temp: string): Promise<MainCheckout> {
  const archive = join(temp, "main.zip");
  const extracted = join(temp, "unpacked");
  const response = await fetch("https://codeload.github.com/anderson-camacho/HARIL/zip/refs/heads/main", {
    signal: AbortSignal.timeout(60_000),
    headers: { "User-Agent": "HARIL-updater" },
  });
  if (!response.ok || response.body === null) {
    throw new Error(`GitHub archive HTTP ${response.status}`);
  }
  const limit = 32 * 1024 * 1024;
  let size = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("GitHub archive exceeds 32 MiB");
    chunks.push(chunk);
  }
  writeFileSync(archive, Buffer.concat(chunks));
  mkdirSync(extracted);
  if (process.platform === "win32") {
    const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
    await systemCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${quoted(archive)} -DestinationPath ${quoted(extracted)} -Force`,
    ]);
  } else {
    await systemCommand("unzip", ["-q", archive, "-d", extracted]);
  }
  const source = join(extracted, "HARIL-main");
  if (!existsSync(join(source, "scripts", "install.mjs"))) {
    throw new Error("GitHub archive lacks HARIL installer");
  }
  return { source, revision: "archive:main (no verified commit SHA)", cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

function systemCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let detail = "";
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stderr.on("data", (bytes: Buffer) => {
      detail = (detail + bytes.toString("utf8")).slice(-1000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error(`${command} failed (exit ${code ?? "interrupted"}): ${detail}`));
    });
  });
}

// Clone main into an isolated temporary directory: never switch or pull the user's worktree.
async function checkoutMain(): Promise<MainCheckout> {
  const temp = mkdtempSync(join(tmpdir(), "haril-main-"));
  const source = join(temp, "checkout");
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  let archiveFailure: unknown;
  try {
    return await checkoutArchive(temp);
  } catch (error) {
    archiveFailure = error;
  }
  try {
    await git(["init", "--quiet", source]);
    await git(["-C", source, "remote", "add", "origin", MAIN_REPOSITORY]);
    // A fetch is more resilient than 'clone' on intermittent Windows HTTPS connections.
    // HTTP/1.1 avoids the TLS resets seen by some Git for Windows installations.
    let lastError: unknown;
    let fetched = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await git([
          "-c",
          "http.version=HTTP/1.1",
          "-C",
          source,
          "fetch",
          "--quiet",
          "--depth",
          "1",
          "--no-tags",
          "origin",
          "main",
        ]);
        fetched = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
      }
    }
    if (!fetched) throw lastError ?? new Error("GitHub main is unreachable");
    await git(["-C", source, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const revision = (await git(["-C", source, "rev-parse", "--verify", "HEAD"])).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Git returned an invalid commit SHA");
    return { source, revision, cleanup };
  } catch (error) {
    cleanup();
    const archive = archiveFailure instanceof Error ? archiveFailure.message : String(archiveFailure);
    const gitError = error instanceof Error ? error.message : String(error);
    throw new Error(`archive failed (${archive}); Git fallback failed (${gitError})`);
  }
}

async function askConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Update HARIL from the selected source? [y/N] ");
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
  checkoutMain,
};

export async function update(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: UpdateServices = DEFAULT_SERVICES,
): Promise<number> {
  let sourceArg: string | undefined;
  let main = false;
  let check = false;
  let yes = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--check") check = true;
    else if (token === "--yes") yes = true;
    else if (token === "--main") main = true;
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

  if (main && sourceArg !== undefined) {
    io.err("haril: choose either --main or --from");
    return EXIT_USAGE;
  }
  // Explicit --from (or the advanced HARIL_SOURCE_DIR override) retains local updates.
  // Otherwise 'haril update', '--check' and '--yes' all use the main channel.
  const useMain = main || (sourceArg === undefined && !host.env?.HARIL_SOURCE_DIR);
  let checkout: MainCheckout | undefined;
  if (useMain) {
    try {
      io.out("Checking GitHub main (development channel; not a signed release)...");
      checkout = await services.checkoutMain();
    } catch (error) {
      io.err(`haril: cannot fetch main: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  try {
    const source =
      checkout?.source ??
      resolve(host.cwd ?? process.cwd(), sourceArg ?? host.env?.HARIL_SOURCE_DIR ?? ".");
    const script = join(source, "scripts", "install.mjs");
    const manifest = join(source, "apps", "haril", "package.json");
    const root = runtimeRootFor(host);
    let current: string;
    let available: string;
    try {
      current = installedVersion(root, services);
      if (!services.exists(script) || !services.exists(manifest)) {
        io.err(
          `haril: no usable HARIL source at ${source}; use --from <local-repository> or retry the GitHub connection.`,
        );
        return EXIT_USAGE;
      }
      available = readVersion(manifest, services);
    } catch (error) {
      io.err(`haril: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_USAGE;
    }

    io.out(
      `HARIL installed: ${current}; ${useMain ? "GitHub main" : "local source"}: ${available} (${checkout?.revision ?? source})`,
    );
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
      io.out("An update is available; the installed files were not changed.");
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

    io.out(
      `Updating HARIL to ${available} from ${useMain ? "GitHub main" : "local source"} through the installer...`,
    );
    const result = await services.install(script, root, source);
    if (result !== 0) {
      io.err(
        `haril: installer failed (exit ${result}); inspect its output. Do not assume the update succeeded.`,
      );
      return 1;
    }
    io.out(`HARIL update to ${available} completed; open a new terminal before continuing.`);
    return EXIT_OK;
  } finally {
    checkout?.cleanup();
  }
}
