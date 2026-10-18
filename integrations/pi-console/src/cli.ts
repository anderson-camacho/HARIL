import { type ChildProcess, execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, relative } from "node:path";

// How the console reaches HARIL: the `haril` CLI, never its store. `haril console` sets HARIL_NODE (the Node that ran
// it) and HARIL_CLI (its haril.mjs); every command runs that pair with execFile, no shell, in the inherited
// environment, so the provider key variables reach the CLI as they reach a haril typed in the terminal and nothing
// secret is put in argv.

const NODE_ENV = "HARIL_NODE";
const CLI_ENV = "HARIL_CLI";
const RUNTIME_DIR_ENV = "HARIL_RUNTIME_DIR";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LOGS_DIR = "logs";

export interface CliResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const NOT_LAUNCHED =
  "this Pi was not opened by haril: run haril (or haril console) in a terminal to use the HARIL commands";

interface Launcher {
  readonly node: string;
  readonly cli: string;
}

function launcher(): Launcher | undefined {
  const node = process.env[NODE_ENV];
  const cli = process.env[CLI_ENV];
  if (node === undefined || node === "" || cli === undefined || cli === "") return undefined;
  return { node, cli };
}

export function cliAvailable(): boolean {
  return launcher() !== undefined;
}

// Runs `haril <args>` and collects its output. Never rejects: a CLI that cannot run is a failed result. `input` goes to
// the CLI's stdin (haril usage record --stdin), which keeps text out of argv and the process list.
export function runHaril(
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number; readonly input?: string } = {},
): Promise<CliResult> {
  const found = launcher();
  if (found === undefined) {
    return Promise.resolve({ ok: false, code: null, stdout: "", stderr: NOT_LAUNCHED });
  }
  return new Promise((resolve) => {
    const child = execFile(
      found.node,
      [found.cli, ...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        const detail =
          error !== null && stderr.trim() === "" && code === null ? error.message : stderr;
        resolve({ ok: error === null, code, stdout, stderr: detail });
      },
    );
    if (options.input !== undefined) {
      // A child that exits before reading all of it closes the pipe: that is its answer, not a crash here.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input, "utf8");
    }
  });
}

// The JSON a `--json` command printed, or undefined when it printed none. The exit code does not decide: `haril
// models` prints its listing and exits 1 when only some providers answered.
export async function runHarilJson(
  args: readonly string[],
  options: { readonly timeoutMs?: number } = {},
): Promise<unknown> {
  const result = await runHaril(args, options);
  if (result.stdout.trim() === "") return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

// A `haril` command whose output is read line by line while it runs (haril workflow watch and tail).
export interface HarilStream {
  // False once the child exited (or could not start).
  readonly running: boolean;
  // Ends the child, through its own handle (the console spawned it); safe to call more than once.
  close(): void;
}

// Longest line kept: a line that never ends is dropped, not grown without bound.
const MAX_LINE_CHARS = 4 * 1024 * 1024;

// Runs `haril <args>` and calls onLine with each line of its stdout as it arrives (stderr is ignored), and onExit once
// when it ends. Same launcher as runHaril: execFile's pair, no shell, the inherited environment. Undefined when this
// Pi was not opened by haril. The child's stdin is a pipe the console holds and never writes: when the console goes
// away, even without a chance to end its children, the pipe closes, and a command run with --exit-on-stdin-end exits.
export function streamHaril(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly onLine: (line: string) => void;
    readonly onExit?: (code: number | null) => void;
  },
): HarilStream | undefined {
  const found = launcher();
  if (found === undefined) return undefined;
  let running = true;
  let exited = false;
  const exit = (code: number | null): void => {
    running = false;
    if (exited) return;
    exited = true;
    options.onExit?.(code);
  };
  let child: ChildProcess;
  try {
    child = spawn(found.node, [found.cli, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    exit(null);
    return { running: false, close: () => undefined };
  }
  // A child that exits closes its end of the pipe: nothing is ever written, so the error is only that.
  child.stdin?.on("error", () => undefined);
  let partial = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";
    if (partial.length > MAX_LINE_CHARS) partial = "";
    for (const line of lines) if (line.trim() !== "") options.onLine(line);
  });
  child.once("error", () => exit(null));
  child.once("close", (code) => {
    if (partial.trim() !== "") options.onLine(partial);
    partial = "";
    exit(typeof code === "number" ? code : null);
  });
  return {
    get running() {
      return running;
    },
    close() {
      if (running && child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

// The runtime the console started. `running` turns false when the child exits.
export interface StartedRuntime {
  readonly pid: number;
  readonly log: string;
  readonly running: boolean;
}

// Starts `haril start --started-by shell` the way haril shell does (LD-T6, ADR-0022): the same CLI on the same Node,
// detached with no window, its output appended to <runtime root>/logs/runtime-<date>.log and the runtime root as its
// working directory, so the child holds no project folder. The runtime keeps its own rules (lease, epoch, idle exit).
export function startRuntime(
  now: number = Date.now(),
): StartedRuntime | { readonly error: string } {
  const found = launcher();
  if (found === undefined) return { error: NOT_LAUNCHED };
  const root = process.env[RUNTIME_DIR_ENV];
  if (root === undefined || root === "") return { error: `${RUNTIME_DIR_ENV} is not set` };
  const logFile = runtimeLogFile(root, now);
  try {
    mkdirSync(join(root, LOGS_DIR), { recursive: true });
    const log = openSync(logFile, "a");
    try {
      const child = spawn(found.node, [found.cli, "start", "--started-by", "shell"], {
        cwd: root,
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
      const pid = child.pid;
      if (pid === undefined) {
        // The spawn failed; its error event follows and is not the console's to crash on.
        child.once("error", () => undefined);
        return { error: "haril could not be started" };
      }
      const started = { pid, log: relative(root, logFile), running: true };
      const exited = (): void => {
        started.running = false;
      };
      child.once("error", exited);
      child.once("exit", exited);
      child.unref();
      return started;
    } finally {
      // The child holds its own copy of the descriptor.
      closeSync(log);
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// logs/runtime-<YYYY-MM-DD>.log under the runtime root, by the local date, as haril shell names it.
function runtimeLogFile(root: string, at: number): string {
  const date = new Date(at);
  const day = [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return join(root, LOGS_DIR, `runtime-${day}.log`);
}
