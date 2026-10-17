import { spawn } from "node:child_process";

// Actions of the shell (TUI-D13). The shell never writes the store: an action runs the CLI as a short-lived child
// process with the argv as an array (no shell), so the CLI's own validation, defaults and messages apply. The
// outcome is one line: the first line of stdout on success, else the first line of stderr.

const ACTION_TIMEOUT_MS = 30_000;

interface ActionOutcome {
  readonly ok: boolean;
  readonly message: string;
}

export interface ShellActions {
  // Runs the CLI with these arguments and resolves once it exits (or times out).
  run(args: readonly string[]): Promise<ActionOutcome>;
}

export interface HarilActionsOptions {
  // The haril bundle (haril.mjs) the CLI runs from. Undefined when the shell was started without --haril.
  readonly harilEntry: string | undefined;
  readonly timeoutMs?: number;
}

export function createHarilActions(options: HarilActionsOptions): ShellActions {
  const timeoutMs = options.timeoutMs ?? ACTION_TIMEOUT_MS;
  return {
    run(args) {
      const entry = options.harilEntry;
      if (entry === undefined) {
        return Promise.resolve({
          ok: false,
          message: "the shell was not started by haril shell, so it cannot run commands",
        });
      }
      return runChild(entry, args, timeoutMs);
    },
  };
}

function runChild(
  entry: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ActionOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ActionOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: `timed out after ${timeoutMs / 1000} s` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish({ ok: false, message: `could not start haril: ${error.message}` });
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish({ ok: true, message: firstLine(stdout) || "done" });
        return;
      }
      finish({
        ok: false,
        message: firstLine(stderr) || firstLine(stdout) || `haril exited with code ${code ?? "?"}`,
      });
    });
  });
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}
