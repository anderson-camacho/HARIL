import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessControl, ProcessEntry } from "@haril/core/ports";

// ProcessControl over the operating system (docs/modos-y-delegacion.md 3.14): the start time of running processes and the
// kill of a process tree, without dependencies. Windows asks PowerShell's Get-Process for the start times (one call for
// every pid); Linux reads /proc; macOS asks ps. A tree is never left to the OS's own tree kill: taskkill /T walks the tree
// by parent pid alone, and Windows keeps a dead parent's pid in its children's ParentProcessId, so a stranger whose dead
// parent's pid was reused would be taken along. Instead one snapshot of every process (pid, parent pid, start time) is
// read, Core's planTreeKills keeps only the children that started at or after their parent, and each pid is killed on
// its own, children first, with process.kill: no shell, no command line, a validated whole-number pid. On Linux each
// kill first checks that the pid still has the start of the snapshot; on POSIX a root's process group goes with it
// (agents lead their own group: they are spawned detached). The walk itself is the caller's (Core's planTreeKills, run
// by the runtime and the CLI). Nothing is ever found or killed by name: the caller names pids it recorded with their
// start time.

export interface ProcessControlOptions {
  readonly platform?: NodeJS.Platform;
  // SystemRoot (Windows): where powershell.exe lives.
  readonly env?: Readonly<Record<string, string | undefined>>;
  // How long one OS query may take before it is given up (milliseconds).
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

function powershellPath(systemRoot: string): string {
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function windowsStartTimes(
  pids: readonly number[],
  systemRoot: string,
  timeoutMs: number,
): Promise<Map<number, number>> {
  // The pids are whole numbers checked above, so the script holds no text from outside.
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-Process -Id ${pids.join(",")} | ForEach-Object { try { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTime() } catch {} }`;
  const out = await capture(
    powershellPath(systemRoot),
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

// WMI's CIM_DATETIME: yyyymmddHHMMSS.ffffff in local time, then the offset from UTC in minutes (+060, -300).
export function cimDateTimeMs(text: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(
    text.trim(),
  );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, micros, sign, offset] = match;
  const local = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const offsetMs = Number(offset) * 60_000 * (sign === "-" ? -1 : 1);
  return local + Math.floor(Number(micros) / 1000) - offsetMs;
}

// Every process with its parent pid and creation time, in one WMI query. undefined when nothing could be read: the list
// always holds at least the PowerShell that answers.
async function windowsTable(
  systemRoot: string,
  timeoutMs: number,
): Promise<ProcessEntry[] | undefined> {
  // A fixed script: it holds no text from outside.
  const script =
    "$ErrorActionPreference='SilentlyContinue'; foreach ($p in ([wmisearcher]'SELECT ProcessId,ParentProcessId,CreationDate FROM Win32_Process').Get()) { if ($p.CreationDate) { '{0} {1} {2}' -f $p.ProcessId, $p.ParentProcessId, $p.CreationDate } }";
  const out = await capture(
    powershellPath(systemRoot),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    timeoutMs,
  );
  const table: ProcessEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const startedAt = cimDateTimeMs(match[3] as string);
    if (startedAt === undefined) continue;
    table.push({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt });
  }
  return table.length === 0 ? undefined : table;
}

// One process's parent pid and start (ticks since boot) from /proc/<pid>/stat; undefined for a zombie or a pid that is
// gone.
function linuxStat(pid: number): { parentPid: number; startTicks: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name (field 2) may hold spaces and parentheses: the fields after it follow the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // fields[0] is field 3 (state): a zombie has exited. fields[1] is field 4 (ppid), fields[19] field 22 (start).
    if (fields[0] === "Z") return undefined;
    const parentPid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(parentPid) || !Number.isFinite(startTicks)) return undefined;
    return { parentPid, startTicks };
  } catch {
    return undefined;
  }
}

function readUptimeSeconds(): number | undefined {
  try {
    const value = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// The start of a process from its ticks since boot: now minus its age. Both /proc times are monotonic, so the start is
// unaffected by wall-clock changes since the boot.
function linuxStartMs(startTicks: number, uptimeSeconds: number, now: number): number {
  return Math.round(now - (uptimeSeconds - startTicks / LINUX_TICKS_PER_SECOND) * 1000);
}

function linuxStartTimes(pids: readonly number[]): Map<number, number> {
  const times = new Map<number, number>();
  const uptimeSeconds = readUptimeSeconds();
  if (uptimeSeconds === undefined) return times;
  const now = Date.now();
  for (const pid of pids) {
    const stat = linuxStat(pid);
    if (stat !== undefined) times.set(pid, linuxStartMs(stat.startTicks, uptimeSeconds, now));
  }
  return times;
}

// Two reads of one process's start differ by the resolution of /proc/uptime (10 ms) and the clock's drift between them.
const LINUX_SAME_START_MS = 50;

// The pid runs and started when the snapshot said: the guard of a kill on Linux.
function linuxStartsAt(pid: number, startedAt: number): boolean {
  const uptimeSeconds = readUptimeSeconds();
  const stat = linuxStat(pid);
  if (uptimeSeconds === undefined || stat === undefined) return false;
  return (
    Math.abs(linuxStartMs(stat.startTicks, uptimeSeconds, Date.now()) - startedAt) <=
    LINUX_SAME_START_MS
  );
}

function linuxTable(): ProcessEntry[] | undefined {
  const uptimeSeconds = readUptimeSeconds();
  if (uptimeSeconds === undefined) return undefined;
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const now = Date.now();
  const table: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const stat = linuxStat(pid);
    if (stat === undefined) continue;
    table.push({
      pid,
      parentPid: stat.parentPid,
      startedAt: linuxStartMs(stat.startTicks, uptimeSeconds, now),
    });
  }
  return table.length === 0 ? undefined : table;
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

async function psTable(timeoutMs: number): Promise<ProcessEntry[] | undefined> {
  const out = await capture("ps", ["-A", "-o", "pid=,ppid=,etime="], timeoutMs);
  const now = Date.now();
  const table: ProcessEntry[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const elapsed = etimeMs(match[3] as string);
    if (elapsed !== undefined) {
      table.push({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: now - elapsed });
    }
  }
  return table.length === 0 ? undefined : table;
}

// Kills one validated pid, never its children: process.kill opens the process and terminates it on Windows
// (TerminateProcess), and sends SIGKILL on POSIX. A pid already gone is ignored.
function killPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
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
      // The query also asks for this process, which always runs: when it is missing, the OS was not read.
      const asked = [...new Set([...valid, process.pid])];
      let times: Map<number, number> | undefined;
      if (platform === "win32") times = await windowsStartTimes(asked, systemRoot, timeoutMs);
      else if (platform === "linux") times = linuxStartTimes(asked);
      else if (platform === "darwin") times = await psStartTimes(asked, timeoutMs);
      if (times === undefined || !times.has(process.pid)) return undefined;
      if (!valid.includes(process.pid)) times.delete(process.pid);
      return times;
    },
    async processTable() {
      if (platform === "win32") return windowsTable(systemRoot, timeoutMs);
      if (platform === "linux") return linuxTable();
      if (platform === "darwin") return psTable(timeoutMs);
      return undefined;
    },
    killProcess(target, killOptions) {
      if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid === process.pid)
        return;
      // Linux: the pid still has the start of the snapshot (one file read, no process started).
      if (platform === "linux" && !linuxStartsAt(target.pid, target.startedAt)) return;
      // POSIX: a root leads its own process group (agents are spawned detached); the group goes with it.
      if (platform !== "win32" && killOptions?.group === true) {
        try {
          process.kill(-target.pid, "SIGKILL");
        } catch {}
      }
      killPid(target.pid);
    },
  };
}
