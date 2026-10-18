import { planProcessKills, processStartWindow } from "@haril/core";
import type {
  ProcessControl,
  RecordedProcess,
  RecordedProcessFilter,
  Store,
} from "@haril/core/ports";

// The recorded agent processes (docs/modos-y-delegacion.md 3.14): the runtime's startup sweep and the CLI's emergency
// stop kill the ones that still run as the process that was recorded, and nothing else. A pid is checked against the
// start time recorded at spawn before anything is killed, so a pid the OS reused for another program is never touched.

export interface ProcessKillReport {
  // Every recorded process the filter selected.
  readonly checked: number;
  // Still the recorded process: its tree was killed.
  readonly killed: readonly RecordedProcess[];
  // The pid now names another process: kept.
  readonly kept: readonly RecordedProcess[];
}

// `select` narrows the filtered records further (haril workflow stop keeps one workflow's runs).
export async function killRecordedProcesses(
  store: Pick<Store, "runs">,
  control: ProcessControl,
  filter: RecordedProcessFilter,
  select: (record: RecordedProcess) => boolean = () => true,
): Promise<ProcessKillReport> {
  const records = store.runs.processes(filter).filter(select);
  if (records.length === 0) return { checked: 0, killed: [], kept: [] };
  const startTimes = await control.startTimes(records.map((record) => record.pid));
  const plan = planProcessKills(records, startTimes, processStartWindow(process.platform));
  if (plan.kill.length > 0) await control.killTrees(plan.kill);
  return { checked: records.length, killed: plan.kill, kept: plan.reused };
}

// The killed processes that still run as the recorded process after their kill: none, unless a kill failed.
export async function stillRunning(
  control: ProcessControl,
  records: readonly RecordedProcess[],
): Promise<RecordedProcess[]> {
  if (records.length === 0) return [];
  const startTimes = await control.startTimes(records.map((record) => record.pid));
  return [...planProcessKills(records, startTimes, processStartWindow(process.platform)).kill];
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
