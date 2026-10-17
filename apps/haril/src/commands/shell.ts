import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_USAGE, type HostInfo } from "../context.js";
import { runtimeRootFor } from "../runtime.js";
import { dataDirFor } from "./common.js";

// `haril shell` (TUI-T2): opens the interactive terminal UI. This process only resolves the paths, checks the terminal
// and runs the shell bundle (apps/shell) with them. It never opens the store, and apps never import each other, so the
// bundle is a separate Node process. The bundle starts `haril start` when work waits and no runtime runs (LD-T6,
// ADR-0022); --no-runtime tells it never to.

const USAGE = "usage: haril shell [--data-dir <path>] [--no-runtime]";
const NO_RUNTIME = "--no-runtime";
const NOT_A_TERMINAL =
  "the shell needs an interactive terminal (stdin and stdout must be a TTY); run haril shell in a terminal window";
const NOT_BUILT = "the shell is not built; run npm run build";
const EXIT_NOT_BUILT = 1;
const SHELL_FILE = "shell.mjs";

export interface ShellPorts {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  // Directory of the running haril bundle: apps/haril/dist in the repository, app/<version> when installed.
  readonly bundleDir: string;
  // The running haril bundle itself (haril.mjs). The shell runs its actions through it (TUI-D13).
  readonly harilEntry: string;
}

function defaultShellPorts(): ShellPorts {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    bundleDir: dirname(fileURLToPath(import.meta.url)),
    harilEntry: fileURLToPath(import.meta.url),
  };
}

export async function shell(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  ports: ShellPorts = defaultShellPorts(),
): Promise<number> {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: [NO_RUNTIME] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  if (!ports.stdinIsTTY || !ports.stdoutIsTTY) {
    io.err(`haril: ${NOT_A_TERMINAL}`);
    return EXIT_USAGE;
  }

  const entry = locateShellBundle(host, ports.bundleDir);
  if (entry === undefined) {
    io.err(`haril: ${NOT_BUILT}`);
    return EXIT_NOT_BUILT;
  }

  const ops = host.platform === "win32" ? win32 : posix;
  const runtimeRoot = runtimeRootFor(host);
  const config = nonEmpty(host.env?.HARIL_CONFIG) ?? ops.join(runtimeRoot, "config", "haril.json");
  const dataDir = dataDirFor(host, lastValue(parsed, "--data-dir"));
  return runChild(
    entry,
    [
      "--data-dir",
      dataDir,
      "--runtime-root",
      runtimeRoot,
      "--config",
      config,
      "--haril",
      ports.harilEntry,
      ...(parsed.flags.has(NO_RUNTIME) ? [NO_RUNTIME] : []),
    ],
    io,
  );
}

// HARIL_SHELL_ENTRY names the bundle outright (tests). Otherwise the bundle is beside haril.mjs when installed, or
// at apps/shell/dist when running from the repository (apps/haril/dist -> apps/shell/dist).
function locateShellBundle(host: HostInfo, bundleDir: string): string | undefined {
  const override = nonEmpty(host.env?.HARIL_SHELL_ENTRY);
  if (override !== undefined) return existsSync(override) ? override : undefined;
  const candidates = [
    join(bundleDir, SHELL_FILE),
    join(bundleDir, "..", "..", "shell", "dist", SHELL_FILE),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

// The shell inherits the terminal; its exit code is this command's exit code.
function runChild(entry: string, args: readonly string[], io: CliIo): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      io.err(`haril: could not start the shell: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
