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
}

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
      child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
