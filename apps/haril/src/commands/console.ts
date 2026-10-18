import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { argsProblem, lastValue, parseArgs } from "../args.js";
import { type CliIo, EXIT_USAGE, type HostInfo } from "../context.js";
import { findPayloadFile, readRuntime, runtimeRootFor } from "../runtime.js";
import { VERSION } from "../version.js";
import { dataDirFor } from "./common.js";

// `haril console` (PS-T3), and a bare `haril` in a terminal: opens Pi, the Node and the Pi that HARIL installed
// (runtime/manifest.json), in the current folder with the HARIL extension (integrations/pi-console), the way Gentle
// Shell is Pi with its own extension. Pi keeps all of its commands, logins and settings; its agent directory is
// HARIL's own (<runtime root>/agent), never ~/.pi. This process only resolves the paths and waits: the extension
// reaches HARIL through this same CLI (HARIL_NODE and HARIL_CLI), and Pi owns the terminal until it exits.

const USAGE = "usage: haril console [--data-dir <path>]";
const NOT_A_TERMINAL =
  "the console needs an interactive terminal (stdin and stdout must be a TTY); run haril console in a terminal window";
const NOT_BUILT = "the console extension is not built; run npm run build";
const EXIT_NOT_BUILT = 1;
const EXTENSION_FILE = join("integrations", "pi-console", "dist", "console.mjs");
const AGENT_DIR = "agent";

export interface ConsolePorts {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  // Directory of the running haril bundle: apps/haril/dist in the repository, app/<version> when installed.
  readonly bundleDir: string;
  // The running haril bundle itself (haril.mjs), which the extension runs for every HARIL command.
  readonly harilEntry: string;
  // The Node running this CLI; the extension runs the CLI on it.
  readonly nodePath: string;
}

function defaultConsolePorts(): ConsolePorts {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    bundleDir: dirname(fileURLToPath(import.meta.url)),
    harilEntry: fileURLToPath(import.meta.url),
    nodePath: process.execPath,
  };
}

export async function consoleCommand(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  ports: ConsolePorts = defaultConsolePorts(),
): Promise<number> {
  const parsed = parseArgs(args, { values: ["--data-dir"], flags: [] });
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

  // Every path handed to Pi is absolute: the extension starts the runtime from the runtime root, not from this folder.
  const cwd = host.cwd ?? process.cwd();
  const root = resolve(cwd, runtimeRootFor(host));
  const runtime = readRuntime(root, host.platform);
  if (runtime.status !== "ok" || runtime.node === undefined || runtime.pi === undefined) {
    io.err(
      `haril: the console needs HARIL's Pi runtime: ${runtime.detail} (or run the HARIL installer)`,
    );
    return EXIT_USAGE;
  }
  const extension = findPayloadFile(EXTENSION_FILE, ports.bundleDir);
  if (extension === undefined) {
    io.err(`haril: ${NOT_BUILT}`);
    return EXIT_NOT_BUILT;
  }

  const ops = host.platform === "win32" ? win32 : posix;
  const agentDir = ops.join(root, AGENT_DIR);
  try {
    mkdirSync(agentDir, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.err(`haril: could not create Pi's agent directory ${agentDir}: ${reason}`);
    return EXIT_USAGE;
  }
  const dataDir = lastValue(parsed, "--data-dir");
  const harilHome = nonEmpty(host.env?.HARIL_HOME);
  const config = nonEmpty(host.env?.HARIL_CONFIG);
  const env: NodeJS.ProcessEnv = {
    ...(host.env ?? process.env),
    // HARIL's own Pi configuration: its logins, settings and sessions live under the runtime root.
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: nonEmpty(host.env?.PI_SKIP_VERSION_CHECK) ?? "1",
    PI_TELEMETRY: nonEmpty(host.env?.PI_TELEMETRY) ?? "0",
    HARIL_NODE: ports.nodePath,
    HARIL_CLI: ports.harilEntry,
    HARIL_RUNTIME_DIR: root,
    HARIL_VERSION: VERSION,
    // --data-dir reaches every command the extension runs the way HARIL_HOME does.
    ...(dataDir === undefined && harilHome === undefined
      ? {}
      : { HARIL_HOME: resolve(cwd, dataDirFor(host, dataDir)) }),
    ...(config === undefined ? {} : { HARIL_CONFIG: resolve(cwd, config) }),
  };
  // Pi 1.2.0 captures normalized mouse input in fullscreen mode; passing the mode explicitly overrides a saved
  // per-user setting for this HARIL process only and does not edit that setting.
  return runPi(
    runtime.node.path,
    [runtime.pi.cliPath, "--tui-mode", "fullscreen", "-e", extension],
    {
      cwd,
      env,
      io,
    },
  );
}

// Pi inherits the terminal; its exit code is this command's. Ctrl+C belongs to Pi while it runs, so this process
// ignores SIGINT until Pi exits instead of dying under it.
function runPi(
  node: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly io: CliIo },
): Promise<number> {
  const ignore = (): void => undefined;
  process.on("SIGINT", ignore);
  return new Promise<number>((resolve) => {
    const child = spawn(node, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    child.once("error", (error) => {
      options.io.err(`haril: could not start Pi: ${error.message}`);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
  }).finally(() => {
    process.off("SIGINT", ignore);
  });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
