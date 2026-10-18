// The supervisor's rule for agent processes (docs/modos-y-delegacion.md 3.14.5): a recorded pid is killed only while it
// still names the process that was recorded. The runtime records each attempt's pid with the wall-clock time taken right
// after the spawn; the OS reports the process's own start time. The two agree within a small window for the same
// process, while a pid the OS reused belongs to a process that started after the recorded one ended, so its start time
// falls outside the window. A process whose start time cannot be read is never killed. Pure: the OS is read by the
// ProcessControl port.

// The window covers the time between the spawn and the clock reading (milliseconds), the OS's resolution (Linux reads
// ticks of 10 ms, macOS whole seconds) and clock adjustments in the meantime.
export const PROCESS_START_TOLERANCE_MS = 2_000;

export function sameProcess(
  recordedStartedAt: number,
  observedStartedAt: number | undefined,
  toleranceMs: number = PROCESS_START_TOLERANCE_MS,
): boolean {
  if (observedStartedAt === undefined) return false;
  if (!Number.isFinite(recordedStartedAt) || !Number.isFinite(observedStartedAt)) return false;
  return Math.abs(observedStartedAt - recordedStartedAt) <= toleranceMs;
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
  toleranceMs: number = PROCESS_START_TOLERANCE_MS,
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
    } else if (!sameProcess(record.startedAt, observed, toleranceMs)) {
      reused.push(record);
    } else if (!killed.has(record.pid)) {
      killed.add(record.pid);
      kill.push(record);
    }
  }
  return { kill, reused, gone };
}
