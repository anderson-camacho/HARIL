import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

// haril_run (docs/modos-y-delegacion.md 3.10.5 and section 8; phase F8): the host runs one command of the allow list in
// the agent's worktree, never Pi. The rules:
//   - argv only: `command` is a program name found on PATH (never a path) and `args` its arguments, each passed as it
//     is; no shell ever reads them. On Windows a .cmd or .bat needs cmd.exe, so the package managers' shims (npm, npx,
//     pnpm, yarn, corepack) and a node package's command shim run as `node <its script>` instead, and any other batch
//     file is refused;
//   - the allow list decides: an entry ("npm test") allows exactly that argv, and an entry ending in " *" ("npm test *")
//     allows further positional arguments after it: never one that starts with "-" (a flag, a bare "--"), holds an
//     absolute path anywhere or a ".." segment (refusedExtra). The default list has exact entries only;
//   - a clean environment: only the variables a program needs to start (PATH, the system and profile folders, the
//     temporary folders, the locale), plus CI=true and the switches that keep tools quiet. No key, token or other
//     variable of the runtime reaches the command;
//   - a time limit (the command's tree is killed when it passes) and an output limit (the end of each stream is kept);
//   - the command's process is reported when it starts and when it ends (onSpawn, onExit), so the runtime records it like
//     an agent's and a stop or a sweep can kill its verified tree; an aborted turn (signal) kills it at once;
//   - the answer never waits on a process the command left behind: once the command exits (or is killed), its output
//     streams get a short drain and are then closed, whatever still holds them;
//   - the result comes back as data: the exit code, whether it timed out, the duration and the end of its output.
// N0 (3.10.6): there is no sandbox. An allowed command such as `npm test` runs the project's own code with the user's
// rights, and that code is what the agents wrote: a test script can do anything the user can. The allow list is the
// boundary, and the user owns it; the refused arguments only keep a "*" entry from passing flags or naming another
// folder. A "*" entry still hands its positional arguments to the program: "node *" runs any script of the worktree
// (which the agents wrote), and a test runner may read a positional argument as a file or a filter. Allow a "*" entry
// only for a program whose positional arguments you accept from an agent.

export interface HostCommandSettings {
  // The allow list, as its entries are spelled ("npm test", "pnpm run build", "npm test *").
  readonly allow: readonly string[];
  readonly timeoutMs: number;
  // The most bytes of each stream (stdout, stderr) that come back; the end is kept.
  readonly outputMaxBytes: number;
}

// The settings come from haril.json's delegation.commands (allow, timeoutMs, outputMaxBytes), read when the runtime
// starts; without them the defaults of @haril/contracts apply (DEFAULT_COMMAND_ALLOW, 5 minutes, 16 KiB).

const WILDCARD = "*";

// Whether an argument after a "*" entry's fixed part is refused (0.20.1). The extra arguments are positional only:
//   - no flag at all, whatever its spelling: anything that starts with "-", a bare "--" included. A list of refused flags
//     loses to the tools' own parsing (npm takes the abbreviation "--prefi=../b" for --prefix, node takes "-p", "--print"
//     and "-r./x"), so no flag is let through;
//   - no absolute path anywhere in it: a leading "/" or "\" (POSIX root, a drive's root), one right after "=", a drive
//     letter with its colon and a separator anywhere ("--root=C:/other", "x=D:\other"), a drive-relative "C:" at the
//     start, or a share's "\\" anywhere;
//   - no ".." path segment anywhere (between separators, "=", ":", ";" or ",", or the whole argument).
// What stays possible (N0): a positional argument still reaches the program, which reads it as it wants, inside the
// worktree; an allowed command runs the project's code with the user's rights. The allow list is the boundary.
function refusedExtra(argument: string): boolean {
  if (argument.startsWith("-")) return true;
  if (/^[\\/]/.test(argument) || /=[\\/]/.test(argument) || argument.includes("\\\\")) return true;
  if (/[A-Za-z]:[\\/]/.test(argument) || /^[A-Za-z]:/.test(argument) || isAbsolute(argument)) {
    return true;
  }
  return /(^|[\\/=:;,])\.\.($|[\\/=:;,])/.test(argument);
}

function isProgramName(command: string): boolean {
  return (
    command !== "" &&
    !command.includes("/") &&
    !command.includes("\\") &&
    !command.includes(":") &&
    !isAbsolute(command) &&
    !command.startsWith("-")
  );
}

function programKey(command: string, platform: string = process.platform): string {
  return platform === "win32" ? command.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "") : command;
}

// Whether the allow list admits `command args`.
export function allowedCommand(
  allow: readonly string[],
  command: string,
  args: readonly string[],
  platform: string = process.platform,
): boolean {
  if (!isProgramName(command)) return false;
  return allow.some((entry) => {
    const tokens = entry
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "");
    const prefix = tokens[tokens.length - 1] === WILDCARD;
    const fixed = prefix ? tokens.slice(0, -1) : tokens;
    const [program, ...rest] = fixed;
    if (program === undefined || programKey(program, platform) !== programKey(command, platform)) {
      return false;
    }
    if (prefix ? args.length < rest.length : args.length !== rest.length) return false;
    if (!rest.every((token, index) => args[index] === token)) return false;
    return args.slice(rest.length).every((argument) => !refusedExtra(argument));
  });
}

// The variables a command may see, compared without case on Windows. Nothing that names a key, a token or a secret.
const KEPT = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TERM",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

const ADDED: Readonly<Record<string, string>> = {
  CI: "true",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  GIT_TERMINAL_PROMPT: "0",
};

export function cleanEnvironment(
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = platform === "win32" ? name.toUpperCase() : name;
    if (KEPT.has(key)) out[name] = value;
  }
  return { ...out, ...ADDED };
}

export interface ProgramFs {
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string | undefined;
}

const nodeFs: ProgramFs = {
  exists: (path) => existsSync(path),
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

export type ResolvedProgram =
  | { readonly ok: true; readonly file: string; readonly prefix: readonly string[] }
  | { readonly ok: false; readonly reason: string };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const found = Object.keys(env).find((key) => key.toUpperCase() === name);
  return found === undefined ? undefined : env[found];
}

// The scripts of the shims Node installs next to node.exe, relative to its folder.
const NODE_SHIMS: Readonly<Record<string, readonly string[]>> = {
  npm: ["node_modules", "npm", "bin", "npm-cli.js"],
  npx: ["node_modules", "npm", "bin", "npx-cli.js"],
  pnpm: ["node_modules", "corepack", "dist", "pnpm.js"],
  pnpx: ["node_modules", "corepack", "dist", "pnpx.js"],
  yarn: ["node_modules", "corepack", "dist", "yarn.js"],
  yarnpkg: ["node_modules", "corepack", "dist", "yarnpkg.js"],
  corepack: ["node_modules", "corepack", "dist", "corepack.js"],
};

// The script an npm command shim (cmd-shim) runs: `"%dp0%\node_modules\<pkg>\<file>.js" %*`.
const CMD_SHIM_SCRIPT = /"%dp0%\\([^"%]+\.(?:c|m)?js)"/i;

// Finds `command` on PATH. On Windows an .exe or .com runs as it is; a .cmd or .bat runs as `node <script>` when it is
// a known Node shim or a cmd-shim, and is refused otherwise (it would need cmd.exe).
export function resolveProgram(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: string = process.platform,
  fs: ProgramFs = nodeFs,
): ResolvedProgram {
  if (!isProgramName(command)) return { ok: false, reason: `${command} is not a program name` };
  const pathValue = envValue(env, "PATH") ?? "";
  const separator = platform === "win32" ? ";" : delimiter;
  const folders = pathValue.split(separator).filter((folder) => folder.trim() !== "");
  const joinPath = platform === "win32" ? win32.join : join;
  if (platform !== "win32") {
    for (const folder of folders) {
      const file = joinPath(folder, command);
      if (fs.exists(file)) return { ok: true, file, prefix: [] };
    }
    return { ok: false, reason: `${command} is not on PATH` };
  }
  const extensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.toLowerCase())
    .filter((extension) => extension !== "");
  const findNode = (): string | undefined => {
    for (const folder of folders) {
      const file = joinPath(folder, "node.exe");
      if (fs.exists(file)) return file;
    }
    return undefined;
  };
  for (const folder of folders) {
    for (const extension of extensions) {
      const file = joinPath(folder, `${command}${extension}`);
      if (!fs.exists(file)) continue;
      if (extension === ".exe" || extension === ".com") return { ok: true, file, prefix: [] };
      if (extension !== ".cmd" && extension !== ".bat") continue;
      const node = findNode();
      if (node === undefined)
        return { ok: false, reason: `${command} needs node, which is not on PATH` };
      const known = NODE_SHIMS[command.toLowerCase()];
      if (known !== undefined) {
        const script = joinPath(win32.dirname(node), ...known);
        if (fs.exists(script)) return { ok: true, file: node, prefix: [script] };
      }
      const shim = CMD_SHIM_SCRIPT.exec(fs.readText(file) ?? "");
      if (shim?.[1] !== undefined) {
        const script = joinPath(win32.dirname(file), shim[1]);
        if (fs.exists(script)) return { ok: true, file: node, prefix: [script] };
      }
      return {
        ok: false,
        reason: `${command} is a batch file, and HARIL runs commands without a shell`,
      };
    }
  }
  return { ok: false, reason: `${command} is not on PATH` };
}

export type HostCommandResult =
  | {
      readonly ok: true;
      // null when the command was killed (its time limit) or ended by a signal.
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly timedOut: boolean;
      readonly durationMs: number;
      readonly stdout: string;
      readonly stderr: string;
      // Some output was left out: only the end of each stream came back.
      readonly truncated: boolean;
      // The turn was aborted while the command ran: its tree was killed.
      readonly aborted?: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export interface HostCommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  // The agent's worktree.
  readonly cwd: string;
  readonly settings: HostCommandSettings;
  // The Core classified it already (classifyGitCommand): the allow list does not apply.
  readonly classified?: boolean;
  // The environment the clean one is taken from; defaults to this process's.
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
  // Kills the command's whole tree when its time passes (the host's verified tree kill). Without it, the process (and
  // its group on POSIX) is killed.
  readonly killTree?: (process: {
    readonly pid: number;
    readonly startedAt: number;
  }) => Promise<void>;
  // The turn's end: when it aborts, the command's tree is killed (and a command not started yet never starts).
  readonly signal?: AbortSignal;
  // The command's process once it started, and once it ended (the runtime records it and marks it gone).
  readonly onSpawn?: (process: HostCommandProcess) => void;
  readonly onExit?: (process: HostCommandProcess) => void;
}

export interface HostCommandProcess {
  readonly pid: number;
  readonly startedAt: number;
}

// How long the output streams may stay open after the command exited or was killed (a process it left behind may hold
// them); then they are closed and the answer comes back.
const DRAIN_MS = 1_500;

// The end of a stream, kept within `max` bytes as chunks arrive.
class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  cut = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 0) {
      const first = this.chunks[0] as Buffer;
      const extra = this.size - this.max;
      this.cut = true;
      if (first.length <= extra) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(extra);
        this.size -= extra;
      }
    }
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export function runHostCommand(request: HostCommandRequest): Promise<HostCommandResult> {
  const platform = request.platform ?? process.platform;
  const { settings } = request;
  if (
    request.classified !== true &&
    !allowedCommand(settings.allow, request.command, request.args, platform)
  ) {
    const allowed = settings.allow.length === 0 ? "none" : settings.allow.join("; ");
    return Promise.resolve({
      ok: false,
      reason: `"${[request.command, ...request.args].join(" ").slice(0, 200)}" is not in the allow list (allowed: ${allowed})`,
    });
  }
  if (request.signal?.aborted === true) {
    return Promise.resolve({ ok: false, reason: "the turn ended; the command was not started" });
  }
  const env = cleanEnvironment(request.env ?? process.env, platform);
  const program = resolveProgram(request.command, env, platform);
  if (!program.ok) return Promise.resolve(program);
  return new Promise((resolve) => {
    const started = Date.now();
    const stdout = new Tail(settings.outputMaxBytes);
    const stderr = new Tail(settings.outputMaxBytes);
    let timedOut = false;
    let aborted = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program.file, [...program.prefix, ...request.args], {
        cwd: request.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: `${request.command} could not start: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    const spawnedAt = Date.now();
    const pid = child.pid;
    const spawned: HostCommandProcess | undefined =
      pid === undefined ? undefined : { pid, startedAt: spawnedAt };
    if (spawned !== undefined) {
      try {
        request.onSpawn?.(spawned);
      } catch {
        // An unrecorded command only leaves a stop blind to it; the command itself goes on.
      }
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let drain: NodeJS.Timeout | undefined;
    // Closes the output streams after a short drain: a process the command left behind may still hold them open.
    const closeStreamsSoon = (): void => {
      if (drain !== undefined) return;
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, DRAIN_MS);
      drain.unref?.();
    };
    const killTree = (): void => {
      const fallback = (): void => {
        try {
          if (pid !== undefined && platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      if (spawned !== undefined && request.killTree !== undefined) {
        request.killTree(spawned).then(() => child.kill("SIGKILL"), fallback);
      } else {
        fallback();
      }
      closeStreamsSoon();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, settings.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let done = false;
    const finish = (result: HostCommandResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.on("error", (error) => {
      finish({ ok: false, reason: `${request.command} could not start: ${error.message}` });
    });
    child.on("exit", () => {
      if (spawned !== undefined) {
        try {
          request.onExit?.(spawned);
        } catch {
          // Unmarked, the next sweep checks the process once more.
        }
      }
      closeStreamsSoon();
    });
    child.on("close", (code, signal) => {
      finish({
        ok: true,
        exitCode: timedOut || aborted ? null : code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.cut || stderr.cut,
        ...(aborted ? { aborted: true } : {}),
      });
    });
  });
}
