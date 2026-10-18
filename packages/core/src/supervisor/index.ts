// The supervisor's rule for agent processes (docs/modos-y-delegacion.md 3.14.5): a recorded pid is killed only while it
// still names the process that was recorded. The runtime records each attempt's pid with the wall-clock time taken right
// after the spawn returned, so the process itself started a little before that time. A pid the OS reused belongs to a
// process that started after the recorded one ended, so it always starts after the recorded time. The window is
// therefore asymmetric: wide before the recorded time, narrow after it. A process whose start time cannot be read is
// never killed. Pure: the OS is read by the ProcessControl port.

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
  observedStartedAt: number | undefined,
  window: ProcessStartWindow = PROCESS_START_WINDOW,
): boolean {
  if (observedStartedAt === undefined) return false;
  if (!Number.isFinite(recordedStartedAt) || !Number.isFinite(observedStartedAt)) return false;
  const delta = observedStartedAt - recordedStartedAt;
  return delta >= -window.beforeMs && delta <= window.afterMs;
}

export interface ProcessKillPlan<T> {
  // Running and still the recorded process: kill its tree. Each pid appears once.
  readonly kill: readonly T[];
  // Running, but the pid now names another process: never touch it.
  readonly reused: readonly T[];
  // Not running (or its start time cannot be read): nothing to do.
  readonly gone: readonly T[];
}

// Sorts recorded processes by what may be done with them, given the start times the OS reported for the running pids.
export function planProcessKills<T extends { readonly pid: number; readonly startedAt: number }>(
  records: readonly T[],
  startTimes: ReadonlyMap<number, number>,
  window: ProcessStartWindow = PROCESS_START_WINDOW,
): ProcessKillPlan<T> {
  const kill: T[] = [];
  const reused: T[] = [];
  const gone: T[] = [];
  const killed = new Set<number>();
  for (const record of records) {
    const observed =
      Number.isSafeInteger(record.pid) && record.pid > 0 ? startTimes.get(record.pid) : undefined;
    if (observed === undefined) {
      gone.push(record);
    } else if (!sameProcess(record.startedAt, observed, window)) {
      reused.push(record);
    } else if (!killed.has(record.pid)) {
      killed.add(record.pid);
      kill.push(record);
    }
  }
  return { kill, reused, gone };
}
