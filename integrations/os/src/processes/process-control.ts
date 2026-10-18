import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessControl } from "@haril/core/ports";

// ProcessControl over the operating system (docs/modos-y-delegacion.md 3.14): the start time of running processes and the
// kill of a process tree, without dependencies. Windows asks PowerShell's Get-Process for the start times (one call for
// every pid) and kills with taskkill /F /T, which walks the tree from the root. Linux reads /proc; macOS asks ps. POSIX
// kills the process group first (agents lead their own group: they are spawned detached), then the process. Nothing is
// ever found or killed by name: the caller names pids it recorded and checks their start time first.

export interface ProcessControlOptions {
  readonly platform?: NodeJS.Platform;
  // SystemRoot (Windows): where taskkill.exe and powershell.exe live.
  readonly env?: Readonly<Record<string, string | undefined>>;
  // How long one OS query or kill may take before it is given up (milliseconds).
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
// Windows FILETIME counts 100 ns intervals since 1601-01-01; the Unix epoch is this many milliseconds later.
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
// USER_HZ of Linux /proc times; 100 on every mainstream kernel.
const LINUX_TICKS_PER_SECOND = 100;

function validPids(pids: readonly number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
}

// Runs a command and resolves with its stdout, whatever its exit code; an error or a timeout resolves with what was read.
function capture(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    const finish = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", finish);
    child.once("close", finish);
  });
}

// Resolves once the command exited (or could not start, or the timeout passed).
function runToEnd(command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { shell: false, windowsHide: true, stdio: "ignore" });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("error", done);
    child.once("close", done);
  });
}

async function windowsStartTimes(
  pids: readonly number[],
  systemRoot: string,
  timeoutMs: number,
): Promise<Map<number, number>> {
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // The pids are whole numbers checked above, so the script holds no text from outside.
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-Process -Id ${pids.join(",")} | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTime() } catch {} }`;
  const out = await capture(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
  );
  const times = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) continue;
    const ms = BigInt(match[2] as string) / 10_000n - FILETIME_EPOCH_OFFSET_MS;
    times.set(Number(match[1]), Number(ms));
  }
  return times;
}

// /proc/<pid>/stat field 22 is the start in ticks since boot; /proc/uptime is the time since boot. Both are monotonic,
// so the start is now minus the process's age, unaffected by wall-clock changes since the boot.
function linuxStartTimes(pids: readonly number[]): Map<number, number> {
  const times = new Map<number, number>();
  let uptimeSeconds: number;
  try {
    uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  } catch {
    return times;
  }
  const now = Date.now();
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) may hold spaces and parentheses: the fields after it follow the last ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // fields[0] is field 3 (state), so field 22 is fields[19]; a zombie has exited.
      if (fields[0] === "Z") continue;
      const startTicks = Number(fields[19]);
      if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) continue;
      const ageMs = (uptimeSeconds - startTicks / LINUX_TICKS_PER_SECOND) * 1000;
      times.set(pid, Math.round(now - ageMs));
    } catch {}
  }
  return times;
}

// ps -o etime: the elapsed time as [[dd-]hh:]mm:ss.
function etimeMs(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (match === null) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  );
}

async function psStartTimes(
  pids: readonly number[],
  timeoutMs: number,
): Promise<Map<number, number>> {
  const out = await capture("ps", ["-o", "pid=,etime=", "-p", pids.join(",")], timeoutMs);
  const now = Date.now();
  const times = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const elapsed = etimeMs(match[2] as string);
    if (elapsed !== undefined) times.set(Number(match[1]), now - elapsed);
  }
  return times;
}

function killPosixTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {}
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export function createProcessControl(options: ProcessControlOptions = {}): ProcessControl {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  return {
    async startTimes(pids) {
      const valid = validPids(pids);
      if (valid.length === 0) return new Map();
      if (platform === "win32") return windowsStartTimes(valid, systemRoot, timeoutMs);
      if (platform === "linux") return linuxStartTimes(valid);
      if (platform === "darwin") return psStartTimes(valid, timeoutMs);
      return new Map();
    },
    async killTree(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      if (platform === "win32") {
        await runToEnd(
          join(systemRoot, "System32", "taskkill.exe"),
          ["/F", "/T", "/PID", String(pid)],
          timeoutMs,
        );
        return;
      }
      killPosixTree(pid);
    },
  };
}
