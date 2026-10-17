import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// The shell starts the runtime (LD-T6, ADR-0022): `haril start --started-by shell`, the same CLI on the same Node, as a
// detached child that outlives the shell. Its output goes to logs/runtime-<date>.log under the runtime root, its
// environment is the shell's (so the provider key variables reach it as they reach a haril start typed by the user),
// and nothing secret is in its argv. The runtime keeps its own rules: lease, epoch, reconciliation and idle exit. The
// app decides when to start one; this module only builds the command and runs it.

const LOGS_DIR = "logs";

// A runtime the shell started. `running` turns false when the child exits; the exit listeners run then, with its exit
// code (null when it ended by a signal or could not run).
export interface SpawnedRuntime {
  readonly pid: number;
  readonly running: boolean;
  onExit(listener: (code: number | null) => void): void;
}

export interface RuntimeCommand {
  // The haril bundle (haril.mjs) the shell's actions run.
  readonly harilEntry: string;
  readonly args: readonly string[];
  // Appended to, never truncated: one file per day holds every start of that day.
  readonly logFile: string;
  // The runtime root, so the child holds no project folder as its working directory.
  readonly cwd: string;
  // Tests only: the child's environment. Production passes none, so the child inherits the shell's.
  readonly env?: NodeJS.ProcessEnv;
}

// Starts the command as a detached child; throws when it cannot. Injected in tests, which never start a real one.
export type SpawnRuntime = (command: RuntimeCommand) => SpawnedRuntime;

// `log` is the child's log file relative to the runtime root, as the status line names it.
type StartOutcome =
  | { readonly ok: true; readonly runtime: SpawnedRuntime; readonly log: string }
  | { readonly ok: false; readonly message: string };

export interface RuntimeStarter {
  start(): StartOutcome;
}

export interface RuntimeStarterOptions {
  readonly harilEntry: string;
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly spawn?: SpawnRuntime;
  readonly now?: () => number;
}

export function createRuntimeStarter(options: RuntimeStarterOptions): RuntimeStarter {
  const run = options.spawn ?? spawnDetached;
  const now = options.now ?? (() => Date.now());
  return {
    start() {
      try {
        const logFile = runtimeLogFile(options.runtimeRoot, now());
        const runtime = run({
          harilEntry: options.harilEntry,
          args: ["start", "--started-by", "shell", "--data-dir", options.dataDir],
          logFile,
          cwd: options.runtimeRoot,
        });
        return { ok: true, runtime, log: relative(options.runtimeRoot, logFile) };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// logs/runtime-<YYYY-MM-DD>.log under the runtime root, by the local date.
export function runtimeLogFile(runtimeRoot: string, at: number): string {
  const date = new Date(at);
  const day = [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return join(runtimeRoot, LOGS_DIR, `runtime-${day}.log`);
}

// Detached with its own process group, stdout and stderr appended to the log, no window on Windows and unref'd: the
// shell can exit while the runtime finishes its work and exits idle, as any haril start does.
export const spawnDetached: SpawnRuntime = (command) => {
  mkdirSync(dirname(command.logFile), { recursive: true });
  const log = openSync(command.logFile, "a");
  try {
    const child = spawn(process.execPath, [command.harilEntry, ...command.args], {
      cwd: command.cwd,
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      ...(command.env === undefined ? {} : { env: command.env }),
    });
    const pid = child.pid;
    if (pid === undefined) {
      // The spawn failed; its error event follows and is not the shell's to crash on.
      child.once("error", () => undefined);
      throw new Error("haril could not be started");
    }
    let running = true;
    let exitCode: number | null = null;
    const listeners: ((code: number | null) => void)[] = [];
    const exited = (code: number | null): void => {
      if (!running) return;
      running = false;
      exitCode = code;
      for (const listener of listeners.splice(0)) listener(code);
    };
    child.once("error", () => exited(null));
    child.once("exit", (code) => exited(code));
    child.unref();
    return {
      pid,
      get running() {
        return running;
      },
      onExit(listener) {
        if (running) listeners.push(listener);
        else listener(exitCode);
      },
    };
  } finally {
    // The child holds its own copy of the descriptor.
    closeSync(log);
  }
};
