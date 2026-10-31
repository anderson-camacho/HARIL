import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { DetectDeps } from "./detect.js";
import { type ExecResult, readInstallVersion } from "./version.js";

// The real process and filesystem behind the detection. Everything above this file is injected, so tests need neither.

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CAP = 4096;

export interface RunLimits {
  readonly timeoutMs?: number;
  readonly capBytes?: number;
  // The child gets exactly this environment; absent, it inherits the parent's.
  readonly env?: Readonly<Record<string, string>>;
}

// Runs a command with limits; the real one is runCapped, a test passes a fake.
export type ExecFn = (
  file: string,
  args: readonly string[],
  limits?: RunLimits,
) => Promise<ExecResult>;

// Runs a command with no shell and no stdin. The first `capBytes` of stdout and stderr are kept (the version is at the
// top), and a command that outlives `timeoutMs` is killed. It never rejects: a failure is part of the result.
export function runCapped(
  file: string,
  args: readonly string[],
  limits: RunLimits = {},
): Promise<ExecResult> {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = limits.capBytes ?? DEFAULT_CAP;
  return new Promise<ExecResult>((done) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(limits.env === undefined ? {} : { env: { ...limits.env } }),
      });
    } catch (error) {
      done({ code: null, output: "", timedOut: false, error: reason(error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // A killed child normally closes; this guards a process that ignores the signal.
      setTimeout(() => finish({ code: null, output, timedOut: true }), 500).unref();
    }, timeoutMs);
    const collect = (chunk: Buffer) => {
      if (output.length < cap) output = (output + chunk.toString("utf8")).slice(0, cap);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish({ code: null, output, timedOut, error: reason(error) }));
    child.once("close", (code) => finish({ code, output, timedOut }));
  });
}

const TAIL_LINES = 20;
// What is kept while the program runs; only the last TAIL_LINES lines of it are reported.
const TAIL_BUFFER = 32_768;
const TAIL_LINE_LENGTH = 400;

export interface TailLimits {
  readonly timeoutMs: number;
  // The child gets exactly this environment; absent, it inherits the parent's.
  readonly env?: Readonly<Record<string, string>>;
  // Aborting kills the program.
  readonly signal?: AbortSignal;
}

export interface InstallRun extends ExecResult {
  // The signal stopped it before it finished.
  readonly aborted?: boolean;
}

// Runs a long command (go install); the real one is runTail, a test passes a fake.
export type InstallFn = (
  file: string,
  args: readonly string[],
  limits: TailLimits,
) => Promise<InstallRun>;

// The last `count` non-empty lines of an output, each cut to a sane length.
export function lastLines(output: string, count = TAIL_LINES): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(-count)
    .map((line) =>
      line.length > TAIL_LINE_LENGTH ? `${line.slice(0, TAIL_LINE_LENGTH)}...` : line,
    );
  return lines.join("\n");
}

// Runs a command with no shell and no stdin, for as long as `timeoutMs` allows, and keeps the END of its output (the
// reason a build failed is at the bottom). A timeout or an abort kills the program. It never rejects: a failure is part
// of the result.
export function runTail(
  file: string,
  args: readonly string[],
  limits: TailLimits,
): Promise<InstallRun> {
  return new Promise<InstallRun>((done) => {
    const { signal } = limits;
    if (signal?.aborted === true) {
      done({ code: null, output: "", timedOut: false, aborted: true });
      return;
    }
    let buffer = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const finish = (result: InstallRun) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done(result);
    };
    const report = (code: number | null, error?: string): InstallRun => ({
      // A program killed on purpose has no meaningful exit code (Windows reports 1).
      code: timedOut || aborted ? null : code,
      output: lastLines(buffer),
      timedOut,
      ...(aborted ? { aborted: true } : {}),
      ...(error === undefined ? {} : { error }),
    });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(limits.env === undefined ? {} : { env: { ...limits.env } }),
      });
    } catch (error) {
      done({ code: null, output: "", timedOut: false, error: reason(error) });
      return;
    }
    // Killing the program ends it; a program that ignores the signal is reported without waiting for it.
    function stop() {
      child.kill();
      setTimeout(() => finish(report(null)), 500).unref();
    }
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, limits.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (chunk: string) => {
      buffer = (buffer + chunk).slice(-TAIL_BUFFER);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish(report(null, reason(error))));
    child.once("close", (code) => finish(report(code)));
  });
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export const SYSTEM_DETECT_DEPS: DetectDeps = {
  isFile,
  realPath,
  readVersion: (path, tool) => readInstallVersion(path, tool, runCapped),
};
