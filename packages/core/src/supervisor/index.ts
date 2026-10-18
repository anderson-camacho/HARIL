// The supervisor's rule for agent processes (docs/modos-y-delegacion.md 3.14.5): a recorded pid is killed only while it
// still names the process that was recorded. The runtime records each attempt's pid with the wall-clock time taken right
// after the spawn returned, so the process itself started a little before that time. A pid the OS reused belongs to a
// process that started after the recorded one ended, so it always starts after the recorded time. The window is
// therefore asymmetric: wide before the recorded time, narrow after it. A process whose start time cannot be read is
// never killed. On Linux the start is also compared as boot ticks with the boot's id, which no wall-clock step changes:
// the wall-clock start there is rebuilt as "now minus age", so an NTP or WSL2 clock step of more than the window would
// otherwise make a live agent look like a reused pid. Pure: the OS is read by the ProcessControl port.

import type { BootStart, ProcessEntry } from "../ports/index.js";

// How far the OS's start time may fall before and after the recorded one for the same process (milliseconds).
export interface ProcessStartWindow {
  readonly beforeMs: number;
  readonly afterMs: number;
}

// Windows (FILETIME, 100 ns) and Linux (/proc ticks of 10 ms): the spawn returns, then the clock is read, so the OS's
// start is before the recorded time; 100 ms after it absorbs the resolution and clock adjustments in the meantime, and
// 2 s before it covers a slow spawn.
export const PROCESS_START_WINDOW: ProcessStartWindow = { beforeMs: 2_000, afterMs: 100 };
// macOS reads the start as now minus ps's elapsed time, which ps truncates to whole seconds: up to 1 s late.
const MACOS_START_WINDOW: ProcessStartWindow = { beforeMs: 2_000, afterMs: 1_000 };

// The window of the OS a process runs on (a value of process.platform).
export function processStartWindow(platform: string): ProcessStartWindow {
  return platform === "darwin" ? MACOS_START_WINDOW : PROCESS_START_WINDOW;
}

export function sameProcess(
  recordedStartedAt: number,
  observedStartedAt: number | null | undefined,
  window: ProcessStartWindow = PROCESS_START_WINDOW,
): boolean {
  if (observedStartedAt === undefined || observedStartedAt === null) return false;
  if (!Number.isFinite(recordedStartedAt) || !Number.isFinite(observedStartedAt)) return false;
  const delta = observedStartedAt - recordedStartedAt;
  return delta >= -window.beforeMs && delta <= window.afterMs;
}

export interface ProcessStart {
  readonly startedAt: number;
  readonly boot?: BootStart | null | undefined;
}

// same: the pid still names the recorded process. other: it names another process (the recorded one ended). unknown: only
// a wall-clock step could tell the two apart (a Linux start without boot ticks on one side), so nothing may be concluded.
export type ProcessMatch = "same" | "other" | "unknown";

function validBoot(boot: BootStart | null | undefined): boot is BootStart {
  return (
    boot !== undefined &&
    boot !== null &&
    boot.bootId !== "" &&
    Number.isSafeInteger(boot.ticks) &&
    boot.ticks >= 0
  );
}

// Boot ticks decide when both sides have them: the same boot and the same ticks is the same process, whatever the wall
// clocks say; another boot (a reboot ended every process of the last one) or other ticks is another process. Otherwise
// the wall-clock window decides; outside it, a Linux reading (boot ticks on one side) may only be off by a clock step,
// so the answer is unknown, never "other".
export function matchProcess(
  recorded: ProcessStart,
  observed: ProcessStart,
  window: ProcessStartWindow = PROCESS_START_WINDOW,
): ProcessMatch {
  if (validBoot(recorded.boot) && validBoot(observed.boot)) {
    return recorded.boot.bootId === observed.boot.bootId &&
      recorded.boot.ticks === observed.boot.ticks
      ? "same"
      : "other";
  }
  if (sameProcess(recorded.startedAt, observed.startedAt, window)) return "same";
  return validBoot(recorded.boot) || validBoot(observed.boot) ? "unknown" : "other";
}

export interface ProcessKillPlan<T> {
  // Running and still the recorded process: kill its tree. Each pid appears once.
  readonly kill: readonly T[];
  // Running, but the pid now names another process: never touch it.
  readonly reused: readonly T[];
  // Not running (or its start time cannot be read): nothing to do.
  readonly gone: readonly T[];
  // Nothing may be concluded: its part of the OS query failed, or only a clock step could explain its mismatch. Neither
  // killed nor taken for gone: the next check looks again.
  readonly uncertain: readonly T[];
}

// Sorts recorded processes by what may be done with them, given the start times the OS reported for the running pids
// and, on Linux, their boot ticks.
export function planProcessKills<
  T extends {
    readonly pid: number;
    readonly startedAt: number;
    readonly boot?: BootStart | null;
  },
>(
  records: readonly T[],
  startTimes: ReadonlyMap<number, number | null>,
  window: ProcessStartWindow = PROCESS_START_WINDOW,
  boots: ReadonlyMap<number, BootStart> = new Map(),
): ProcessKillPlan<T> {
  const kill: T[] = [];
  const reused: T[] = [];
  const gone: T[] = [];
  const uncertain: T[] = [];
  const killed = new Set<number>();
  for (const record of records) {
    const valid = Number.isSafeInteger(record.pid) && record.pid > 0;
    const observed = valid ? startTimes.get(record.pid) : undefined;
    if (observed === undefined) {
      gone.push(record);
      continue;
    }
    if (observed === null) {
      uncertain.push(record);
      continue;
    }
    const match = matchProcess(
      record,
      { startedAt: observed, boot: boots.get(record.pid) },
      window,
    );
    if (match === "other") reused.push(record);
    else if (match === "unknown") uncertain.push(record);
    else if (!killed.has(record.pid)) {
      killed.add(record.pid);
      kill.push(record);
    }
  }
  return { kill, reused, gone, uncertain };
}

export interface TreeKillPlan {
  // The roots still running as the recorded process, as the snapshot shows them.
  readonly roots: readonly ProcessEntry[];
  // Every process to kill, one pid at a time: each root first, then its descendants, each parent before its children, so
  // a live root cannot start a child the snapshot never saw.
  readonly order: readonly ProcessEntry[];
}

export interface TreeKillOptions {
  readonly window?: ProcessStartWindow;
  // Pids never killed, nor anything under them (the process that kills).
  readonly protectedPids?: ReadonlySet<number>;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

// The processes to kill for recorded roots, from one snapshot of the OS's processes (docs/modos-y-delegacion.md 3.14).
// A root counts only while it matches the recorded process (matchProcess). A child counts only when it names its
// parent's pid and started at or after that parent (in boot ticks when both have them): Windows keeps a dead parent's pid
// in its children's ParentProcessId, so a process that names a pid the OS reused as its parent started before the process
// that now holds that pid. Walking the tree here, instead of letting the OS's tree kill walk it by parent pid alone,
// keeps such a stranger out. A root that runs under another verified root is killed within that root's tree.
export function planTreeKills(
  roots: readonly {
    readonly pid: number;
    readonly startedAt: number;
    readonly boot?: BootStart | null;
  }[],
  table: readonly ProcessEntry[],
  options: TreeKillOptions = {},
): TreeKillPlan {
  const window = options.window ?? PROCESS_START_WINDOW;
  const protectedPids = options.protectedPids ?? new Set<number>();
  const byPid = new Map<number, ProcessEntry>();
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of table) {
    if (!validPid(entry.pid) || !Number.isFinite(entry.startedAt) || byPid.has(entry.pid)) continue;
    byPid.set(entry.pid, entry);
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  const startedBefore = (child: ProcessEntry, parent: ProcessEntry): boolean =>
    validBoot(child.boot) && validBoot(parent.boot) && child.boot.bootId === parent.boot.bootId
      ? child.boot.ticks < parent.boot.ticks
      : child.startedAt < parent.startedAt;
  // Iterative pre-order walk (a deep tree or a loop of parent pids never overflows the stack): each process before its
  // children.
  const walk = (root: ProcessEntry, seen: Set<number>, out: ProcessEntry[]): void => {
    const stack: ProcessEntry[] = [root];
    seen.add(root.pid);
    while (stack.length > 0) {
      const entry = stack.pop() as ProcessEntry;
      out.push(entry);
      const kids = children.get(entry.pid) ?? [];
      for (let index = kids.length - 1; index >= 0; index -= 1) {
        const child = kids[index] as ProcessEntry;
        if (child.pid === entry.pid || seen.has(child.pid) || protectedPids.has(child.pid))
          continue;
        if (startedBefore(child, entry)) continue;
        seen.add(child.pid);
        stack.push(child);
      }
    }
  };
  const verified: ProcessEntry[] = [];
  for (const root of roots) {
    if (!validPid(root.pid) || protectedPids.has(root.pid)) continue;
    const entry = byPid.get(root.pid);
    if (entry === undefined || matchProcess(root, entry, window) !== "same") continue;
    if (!verified.includes(entry)) verified.push(entry);
  }
  // The roots no other verified root reaches: their walks cover the rest, root first.
  const inside = new Set<number>();
  for (const root of verified) {
    const subtree: ProcessEntry[] = [];
    walk(root, new Set<number>(), subtree);
    for (const entry of subtree) if (entry.pid !== root.pid) inside.add(entry.pid);
  }
  const order: ProcessEntry[] = [];
  const seen = new Set<number>();
  for (const root of verified) {
    if (inside.has(root.pid) || seen.has(root.pid)) continue;
    walk(root, seen, order);
  }
  return { roots: verified, order };
}
