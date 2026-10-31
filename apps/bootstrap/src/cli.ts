import type { PlatformPath } from "node:path";
import { type AppInstallResult, installApp, uninstallApp } from "./app-install.js";
import { installRuntime } from "./install.js";
import { pathOps } from "./platform.js";
import type { ExecPort, FetchPort, FsPort } from "./ports.js";
import { resolveRuntimeRoot } from "./root.js";
import { checkActiveRuntime, pidIsAlive } from "./runtime-lease.js";
import {
  BACKGROUND_STRETCH_MODES,
  backgroundProblem,
  DEFAULT_BACKGROUND,
  installTerminalProfile,
  removeTerminalProfile,
  TERMINAL_PROFILE_GUID,
} from "./terminal-profile.js";
import {
  isTerminalShaderName,
  TERMINAL_SHADER_NAMES,
  type TerminalShaderName,
} from "./terminal-shader.js";

// Command line of haril-bootstrap:
//   install-runtime [--root <dir>] [--json]              Node and Pi (M2-T3)
//   install [--root <dir>] [--from <repo dir>] [--json]  HARIL itself into <root>/app and <root>/bin (M3-T3)
//   uninstall [--root <dir>] [--json]                    removes only what install recorded (M3-T3)
//   terminal-profile [--root <dir>] [--shader crt|none] [--background-image <path>|none [--background-opacity <0-1>] [--background-stretch none|fill|uniform|uniformToFill]] [--remove] [--json]
//                                                        optional Windows Terminal profile running HARIL
// Exit 0 when no step failed, 2 when uninstall refuses because a runtime is active (M3-T6b), 1 otherwise
// (usage errors included).

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliHost {
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string;
  readonly fs: FsPort;
  readonly exec: ExecPort;
  readonly fetch: FetchPort;
  readonly now: () => string;
}

const USAGE = [
  "usage: haril-bootstrap install-runtime [--root <dir>] [--json]",
  "       haril-bootstrap install [--root <dir>] [--from <repo dir>] [--json]",
  "       haril-bootstrap uninstall [--root <dir>] [--json]",
  "       haril-bootstrap terminal-profile [--root <dir>] [--shader crt|none] [--background-image <path>|none [--background-opacity <0-1>] [--background-stretch none|fill|uniform|uniformToFill]] [--remove] [--json]",
  "       haril-bootstrap --help",
  "root: --root, else HARIL_RUNTIME_DIR, else %LOCALAPPDATA%\\HARIL on win32, else XDG_DATA_HOME/haril",
];

export async function runCli(argv: readonly string[], io: CliIo, host: CliHost): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    for (const line of USAGE) io.out(line);
    return 0;
  }
  if (command === "install-runtime") return installRuntimeCommand(rest, io, host);
  if (command === "install") return installCommand(rest, io, host);
  if (command === "uninstall") return uninstallCommand(rest, io, host);
  if (command === "terminal-profile") return terminalProfileCommand(rest, io, host);
  for (const line of USAGE) io.err(line);
  return 1;
}

interface Options {
  readonly root?: string;
  readonly from?: string;
  readonly json: boolean;
}

// Only the flags listed in `valued` take a value; anything else is a usage error.
function parseOptions(args: readonly string[], valued: readonly string[]): Options | string {
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg !== undefined && valued.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return `${arg} needs a directory`;
      values[arg] = value;
      index++;
    } else {
      return `unknown argument: ${arg ?? ""}`;
    }
  }
  return {
    ...(values["--root"] === undefined ? {} : { root: values["--root"] }),
    ...(values["--from"] === undefined ? {} : { from: values["--from"] }),
    json,
  };
}

function rootFrom(options: Options, host: CliHost): string {
  const ops = pathOps(host.platform);
  const flag = options.root === undefined ? undefined : ops.resolve(host.cwd, options.root);
  return resolveRuntimeRoot({
    flag,
    env: host.env,
    platform: host.platform,
    homeDir: host.homeDir,
  }).root;
}

async function installRuntimeCommand(
  args: readonly string[],
  io: CliIo,
  host: CliHost,
): Promise<number> {
  const options = parseOptions(args, ["--root"]);
  if (typeof options === "string") {
    io.err(options);
    return 1;
  }

  const result = await installRuntime({
    root: rootFrom(options, host),
    platform: host.platform,
    arch: host.arch,
    env: host.env,
    fs: host.fs,
    exec: host.exec,
    fetch: host.fetch,
    now: host.now,
  });

  if (options.json) {
    io.out(JSON.stringify({ ok: result.ok, root: result.root, steps: result.steps }));
  } else {
    for (const step of result.steps) {
      io.out(`${step.name.padEnd(10)}${step.status.padEnd(9)}${step.detail}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function installCommand(args: readonly string[], io: CliIo, host: CliHost): Promise<number> {
  const options = parseOptions(args, ["--root", "--from"]);
  if (typeof options === "string") {
    io.err(options);
    return 1;
  }

  const ops = pathOps(host.platform);
  const sourceRoot = options.from === undefined ? host.cwd : ops.resolve(host.cwd, options.from);
  const result = await installApp({
    root: rootFrom(options, host),
    sourceRoot,
    platform: host.platform,
    fs: host.fs,
    now: host.now,
  });

  if (options.json) {
    io.out(JSON.stringify(result));
  } else {
    printInstall(result, io, ops);
  }
  return result.ok ? 0 : 1;
}

function printInstall(result: AppInstallResult, io: CliIo, ops: PlatformPath): void {
  for (const step of result.steps) {
    const line = `${step.name.padEnd(10)}${step.status.padEnd(9)}${step.detail}`;
    if (step.status === "failed") io.err(line);
    else io.out(line);
  }
  if (!result.ok) return;
  if (result.nodeSource === "path") {
    io.out(
      "note: no runtime/manifest.json, so the shims run node from PATH (run install-runtime to pin Node)",
    );
  }
  io.out(`bin       ${result.binDir} (PATH is not edited; call the launcher by its full path)`);
  io.out(`call      & '${ops.join(result.binDir, "haril.ps1")}' --version`);
}

async function uninstallCommand(
  args: readonly string[],
  io: CliIo,
  host: CliHost,
): Promise<number> {
  const options = parseOptions(args, ["--root"]);
  if (typeof options === "string") {
    io.err(options);
    return 1;
  }

  const root = rootFrom(options, host);
  // The data directory is HARIL_HOME when set (haril's own rule), else the data/ directory under the root.
  const ops = pathOps(host.platform);
  const home = host.env.HARIL_HOME;
  const dataDir = home === undefined || home === "" ? ops.join(root, "data") : home;
  const result = await uninstallApp({
    root,
    platform: host.platform,
    fs: host.fs,
    activeRuntime: () =>
      checkActiveRuntime({
        dbPath: ops.join(dataDir, "haril.db"),
        fs: host.fs,
        now: Date.now(),
        isAlive: pidIsAlive,
      }),
  });

  if (options.json) {
    io.out(JSON.stringify(result));
  } else {
    if (result.ok) {
      io.out(result.detail);
      if (result.kept.length > 0) io.out(`kept      ${result.kept.join(", ")} (not touched)`);
    } else {
      io.err(result.detail);
    }
  }
  if (result.refusal !== undefined) return 2;
  return result.ok ? 0 : 1;
}

// --shader and --remove are taken out first; --root and --json go through the shared parser.
async function terminalProfileCommand(
  args: readonly string[],
  io: CliIo,
  host: CliHost,
): Promise<number> {
  let shader: TerminalShaderName | null = "crt";
  let backgroundImage: string | undefined;
  let backgroundOpacity = DEFAULT_BACKGROUND.opacity;
  let backgroundStretch = DEFAULT_BACKGROUND.stretch;
  let remove = false;
  const shared: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--remove") {
      remove = true;
    } else if (arg === "--background-image") {
      const value = args[++index];
      if (value === undefined) {
        io.err("--background-image needs the path of a local image, or none");
        return 2;
      }
      backgroundImage = value;
    } else if (arg === "--background-opacity") {
      const value = Number(args[++index]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        io.err("--background-opacity needs a number from 0 to 1");
        return 2;
      }
      backgroundOpacity = value;
    } else if (arg === "--background-stretch") {
      const value = BACKGROUND_STRETCH_MODES.find((mode) => mode === args[index + 1]);
      index++;
      if (value === undefined) {
        io.err(`--background-stretch needs one of ${BACKGROUND_STRETCH_MODES.join(", ")}`);
        return 2;
      }
      backgroundStretch = value;
    } else if (arg === "--shader") {
      const value = args[index + 1];
      if (value === "none") shader = null;
      else if (isTerminalShaderName(value)) shader = value;
      else {
        io.err(`--shader needs one of ${[...TERMINAL_SHADER_NAMES, "none"].join(", ")}`);
        return 1;
      }
      index++;
    } else if (arg !== undefined) {
      shared.push(arg);
    }
  }
  const options = parseOptions(shared, ["--root"]);
  if (typeof options === "string") {
    io.err(options);
    return 1;
  }

  const deps = {
    root: rootFrom(options, host),
    platform: host.platform,
    env: host.env,
    homeDir: host.homeDir,
    fs: host.fs,
  };

  if (remove) {
    const removal = await removeTerminalProfile(deps);
    if (options.json) {
      io.out(JSON.stringify(removal));
    } else if (removal.ok) {
      io.out(removal.detail);
      for (const path of removal.manual) {
        io.out(`manual    remove the profile ${TERMINAL_PROFILE_GUID} from ${path} by hand`);
      }
    } else {
      io.err(removal.detail);
    }
    return removal.ok ? 0 : 1;
  }

  // A picture that cannot be used keeps the default one: the profile still installs, and the warning says why.
  if (backgroundImage !== undefined && backgroundImage !== "none") {
    const problem = await backgroundProblem(deps.fs, backgroundImage);
    if (problem !== undefined) {
      io.err(`warning: --background-image: ${problem}; keeping the default image`);
      backgroundImage = undefined;
    }
  }
  const result = await installTerminalProfile(deps, shader, {
    image: backgroundImage ?? DEFAULT_BACKGROUND.image,
    opacity: backgroundOpacity,
    stretch: backgroundStretch,
  });
  if (options.json) {
    io.out(JSON.stringify(result));
  } else {
    for (const step of result.steps) {
      const line = `${step.name.padEnd(10)}${step.status.padEnd(9)}${step.detail}`;
      if (step.status === "failed") io.err(line);
      else io.out(line);
    }
    if (result.ok) {
      io.out("next      open Windows Terminal and pick the HARIL profile from the new-tab menu");
      if (result.shaderPath !== null) {
        io.out(
          "toggle    bind the toggleShaderEffects action in Windows Terminal to switch the effect",
        );
      }
    }
  }
  return result.ok ? 0 : 1;
}
