import { installRuntime } from "./install.js";
import { pathOps } from "./platform.js";
import type { ExecPort, FetchPort, FsPort } from "./ports.js";
import { resolveRuntimeRoot } from "./root.js";

// Command line of haril-bootstrap: `install-runtime [--root <dir>] [--json]`, plus --help.
// Exit 0 when no step failed, 1 otherwise (usage errors included).

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
  "       haril-bootstrap --help",
  "root: --root, else HARIL_RUNTIME_DIR, else %LOCALAPPDATA%\\HARIL on win32, else XDG_DATA_HOME/haril",
];

export async function runCli(argv: readonly string[], io: CliIo, host: CliHost): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    for (const line of USAGE) io.out(line);
    return 0;
  }
  if (command !== "install-runtime") {
    for (const line of USAGE) io.err(line);
    return 1;
  }

  const options = parseOptions(rest);
  if (typeof options === "string") {
    io.err(options);
    return 1;
  }

  const ops = pathOps(host.platform);
  const flag = options.root === undefined ? undefined : ops.resolve(host.cwd, options.root);
  const resolution = resolveRuntimeRoot({
    flag,
    env: host.env,
    platform: host.platform,
    homeDir: host.homeDir,
  });

  const result = await installRuntime({
    root: resolution.root,
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

interface InstallOptions {
  readonly root?: string;
  readonly json: boolean;
}

function parseOptions(args: readonly string[]): InstallOptions | string {
  let root: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--root") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return "--root needs a directory";
      root = value;
      index++;
    } else {
      return `unknown argument: ${arg ?? ""}`;
    }
  }
  return root === undefined ? { json } : { root, json };
}
