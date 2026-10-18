import { planProcessKills, processStartWindow, sameProcess } from "@haril/core";
import type {
  ProcessControl,
  RecordedProcess,
  RecordedProcessFilter,
  Store,
} from "@haril/core/ports";

// The recorded agent processes (docs/modos-y-delegacion.md 3.14): the runtime's startup sweep and the CLI's emergency
// stop kill the ones that still run as the process that was recorded, and nothing else. A pid is checked against the
// start time recorded at spawn before anything is killed, so a pid the OS reused for another program is never touched.
// A process is marked verified gone only once the OS was read and showed it gone (not running, or its pid naming another
// program); until then every sweep checks it again, so a kill that failed is never taken for an all-clear.

export interface ProcessKillReport {
  // Every recorded process the filter selected.
  readonly checked: number;
  // Still the recorded process: its tree was killed.
  readonly killed: readonly RecordedProcess[];
  // The pid now names another process: kept, and marked gone (the recorded process is).
  readonly kept: readonly RecordedProcess[];
  // Still running as the recorded process after the kill: a kill that did not take.
  readonly alive: readonly RecordedProcess[];
  // The OS could not be read: nothing is known of these, nothing was killed and nothing marked.
  readonly unverified: readonly RecordedProcess[];
}

export interface KillRecordedOptions {
  // Narrows the filtered records further (haril workflow stop keeps one workflow's runs).
  readonly select?: (record: RecordedProcess) => boolean;
  // When the verified-gone marks are taken.
  readonly now?: () => number;
}

const NOTHING: ProcessKillReport = { checked: 0, killed: [], kept: [], alive: [], unverified: [] };
// A process takes a moment to end after its kill: a survivor is read again this many times, this far apart.
const RECHECK = { times: 4, delayMs: 150 };

export async function killRecordedProcesses(
  store: Pick<Store, "runs">,
  control: ProcessControl,
  filter: RecordedProcessFilter,
  options: KillRecordedOptions = {},
): Promise<ProcessKillReport> {
  const select = options.select ?? (() => true);
  const records = store.runs.processes(filter).filter(select);
  if (records.length === 0) return NOTHING;
  const window = processStartWindow(process.platform);
  const startTimes = await control.startTimes(records.map((record) => record.pid));
  if (startTimes === undefined) return { ...NOTHING, checked: records.length, unverified: records };
  const plan = planProcessKills(records, startTimes, window);
  let alive: RecordedProcess[] = [];
  let unverified: RecordedProcess[] = [];
  if (plan.kill.length > 0) {
    // Every record still running as itself, the second record of a pid two runs recorded included.
    const running = records.filter((record) =>
      sameProcess(record.startedAt, startTimes.get(record.pid), window),
    );
    const killed = await control.killTrees(plan.kill);
    // Nothing was killed when the snapshot could not be read: one look says what still runs.
    const after = await stillRunning(control, running, killed === undefined ? 1 : RECHECK.times);
    alive = after.alive;
    unverified = after.unverified;
  }
  const open = new Set([...alive, ...unverified]);
  const gone = records.filter((record) => !open.has(record));
  if (gone.length > 0) store.runs.markProcessesGone(gone, (options.now ?? Date.now)());
  return { checked: records.length, killed: plan.kill, kept: plan.reused, alive, unverified };
}

// The killed processes that still run as the recorded process: none, unless a kill failed.
async function stillRunning(
  control: ProcessControl,
  records: readonly RecordedProcess[],
  times: number,
): Promise<{ alive: RecordedProcess[]; unverified: RecordedProcess[] }> {
  const window = processStartWindow(process.platform);
  let left = [...records];
  for (let attempt = 0; attempt < times && left.length > 0; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RECHECK.delayMs));
    const startTimes = await control.startTimes(left.map((record) => record.pid));
    if (startTimes === undefined) return { alive: [], unverified: left };
    left = left.filter((record) =>
      sameProcess(record.startedAt, startTimes.get(record.pid), window),
    );
  }
  return { alive: left, unverified: [] };
}

// Each kill and each kept pid of a sweep is an audit event of its run: the pid and why, never more.
export function recordSweep(
  store: Pick<Store, "events">,
  report: ProcessKillReport,
  reason: string,
): void {
  const append = (record: RecordedProcess, type: string): void => {
    store.events.append({
      aggregateType: "run",
      aggregateId: record.runId,
      type,
      actorKind: "system",
      actorId: "runtime",
      audit: true,
      payload: { pid: record.pid, reason },
      projectId: record.projectId,
      taskId: record.taskId,
      runId: record.runId,
    });
  };
  for (const record of report.killed) append(record, "run.process_killed");
  for (const record of report.kept) append(record, "run.process_kept");
}
