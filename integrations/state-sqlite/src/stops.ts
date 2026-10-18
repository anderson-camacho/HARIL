import type { DatabaseSync } from "node:sqlite";
import type {
  AgentProcess,
  AppendEventInput,
  CancelledTask,
  CancelReason,
  CommandRecord,
  EventRecord,
  HaltState,
  RecordedProcess,
  RecordedProcessFilter,
  RunActivity,
  TaskRecord,
} from "@haril/core/ports";
import type { ApplyVerdict } from "./store.js";

// The stops of the Store (docs/modos-y-delegacion.md 3.14, 3.16): cancelling a task that has not ended, the emergency
// stop (runtime.stop with {mode: "now"}) and its halt, runtime.resume, and the reads of the startup sweep and the
// watchdog (the processes runs recorded, and a run's progress since a time). Every write joins the caller's transaction;
// the store's own facade fences each one with the runtime epoch.

// The meta key that holds the halt of an emergency stop: {at, commandId} while halted, absent otherwise.
const HALT_KEY = "runtime.halted";
// The run states of an attempt still in flight.
const OPEN_RUN = "('prepared','running','settled')";
const LIVE_TASK = "('pending','ready','running','blocked')";
const CANCEL_MESSAGES: Readonly<Record<CancelReason, string>> = {
  user_stop: "the human stopped the run",
  residual: "the watchdog cancelled the run: nobody will consume its result",
};

interface StopsFacetOptions {
  readonly db: DatabaseSync;
  readonly appendEvent: (input: AppendEventInput) => EventRecord;
  readonly transition: (from: TaskRecord["state"], to: TaskRecord["state"]) => void;
  readonly revokeKeys: (runId: string, reason: string) => void;
  readonly settleOpenReservations: (runId: string) => void;
}

export interface StopsFacet {
  // Cancels one task that has not ended, inside the caller's transaction; undefined when it had ended.
  cancelTask(taskId: string, reason: CancelReason, now: number): CancelledTask | undefined;
  // runtime.stop with {mode: "now"}, workflow.stop and runtime.resume, applied inside applyNext's transaction.
  emergencyStop(command: CommandRecord, now: number): ApplyVerdict;
  workflowStop(command: CommandRecord, now: number): ApplyVerdict;
  resume(command: CommandRecord): ApplyVerdict;
  haltState(): HaltState;
  // Writes the pid and start time of a run in flight of this epoch; false when the run is not one.
  recordProcess(epoch: number, runId: string, process: AgentProcess): boolean;
  processes(filter?: RecordedProcessFilter): RecordedProcess[];
  activity(runId: string, since: number): RunActivity;
}

export function createStopsFacet(options: StopsFacetOptions): StopsFacet {
  const { db, appendEvent } = options;

  const haltState = (): HaltState => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(HALT_KEY) as
      | { value: string }
      | undefined;
    if (row === undefined) return { halted: false, since: null };
    const at = (JSON.parse(row.value) as { at?: unknown }).at;
    return { halted: true, since: typeof at === "number" ? at : null };
  };

  const runtimeEvent = (type: string, payload: Readonly<Record<string, unknown>>): void => {
    appendEvent({
      aggregateType: "runtime",
      aggregateId: "runtime",
      type,
      actorKind: "system",
      actorId: "runtime",
      audit: true,
      payload,
    });
  };

  const cancelTask = (
    taskId: string,
    reason: CancelReason,
    now: number,
  ): CancelledTask | undefined => {
    const task = db
      .prepare(
        "SELECT task_id AS taskId, project_id AS projectId, goal, state, workflow_id AS workflowId FROM tasks WHERE task_id = ?",
      )
      .get(taskId) as
      | {
          taskId: string;
          projectId: string;
          goal: string;
          state: TaskRecord["state"];
          workflowId: string | null;
        }
      | undefined;
    if (task === undefined) return undefined;
    if (
      task.state !== "pending" &&
      task.state !== "ready" &&
      task.state !== "running" &&
      task.state !== "blocked"
    ) {
      return undefined;
    }
    options.transition(task.state, "cancelled");
    let runId: string | null = null;
    if (task.state === "running") {
      const run = db
        .prepare(
          `SELECT run_id AS runId FROM runs WHERE task_id = ? AND status IN ${OPEN_RUN} ORDER BY attempt DESC LIMIT 1`,
        )
        .get(taskId) as { runId: string } | undefined;
      if (run !== undefined) {
        runId = run.runId;
        db.prepare(
          "UPDATE runs SET status = 'cancelled', ended_at = ?, end_cause = 'cancelled', error = ? WHERE run_id = ?",
        ).run(now, JSON.stringify({ code: reason, message: CANCEL_MESSAGES[reason] }), runId);
        // The run's authority ends with the run: keys first, then open reservations (ARCH 13.2 CP1, CP4).
        options.revokeKeys(runId, reason);
        options.settleOpenReservations(runId);
      }
    }
    db.prepare(
      "UPDATE tasks SET state = 'cancelled', phase = NULL, block_reason = NULL, cooldown_until = NULL, retry_reason = NULL, claimed_runtime_epoch = NULL, completed_at = ?, updated_at = ? WHERE task_id = ?",
    ).run(now, now, taskId);
    appendEvent({
      aggregateType: "task",
      aggregateId: taskId,
      type: "task.cancelled",
      actorKind: "system",
      actorId: "runtime",
      payload: {
        reason,
        from: task.state,
        ...(task.workflowId === null ? {} : { workflowId: task.workflowId }),
      },
      projectId: task.projectId,
      taskId,
      ...(runId === null ? {} : { runId }),
      ts: now,
    });
    return {
      taskId,
      projectId: task.projectId,
      goal: task.goal,
      workflowId: task.workflowId,
      from: task.state,
      runId,
    };
  };

  const stopWorkflowRow = (workflow: { workflowId: string; projectId: string }, now: number) => {
    db.prepare(
      "UPDATE workflows SET state = 'stopped', stop_reason = 'user_stop', ended_at = ? WHERE workflow_id = ?",
    ).run(now, workflow.workflowId);
    appendEvent({
      aggregateType: "workflow",
      aggregateId: workflow.workflowId,
      type: "workflow.stopped",
      actorKind: "system",
      actorId: "runtime",
      payload: { reason: "user_stop" },
      projectId: workflow.projectId,
      ts: now,
    });
  };

  // 3.14.2, in one transaction: the halt, every running or waiting workflow stopped, then every non-terminal turn of a
  // workflow and every running standalone task cancelled. A standalone task that waits keeps waiting (3.14.3).
  const emergencyStop = (command: CommandRecord, now: number): ApplyVerdict => {
    const wasHalted = haltState().halted;
    if (!wasHalted) {
      db.prepare(
        "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      ).run(HALT_KEY, JSON.stringify({ at: now, commandId: command.commandId }), now);
    }
    const workflows = db
      .prepare(
        "SELECT workflow_id AS workflowId, project_id AS projectId FROM workflows WHERE state IN ('running','awaiting_human') ORDER BY created_at, rowid",
      )
      .all() as Array<{ workflowId: string; projectId: string }>;
    for (const workflow of workflows) stopWorkflowRow(workflow, now);
    const live = db
      .prepare(
        `SELECT task_id AS taskId FROM tasks WHERE state IN ${LIVE_TASK} AND (workflow_id IS NOT NULL OR state = 'running') ORDER BY created_seq`,
      )
      .all() as Array<{ taskId: string }>;
    const taskIds: string[] = [];
    for (const { taskId } of live) {
      if (cancelTask(taskId, "user_stop", now) !== undefined) taskIds.push(taskId);
    }
    runtimeEvent("stop.requested", {
      mode: "now",
      commandId: command.commandId,
      tasks: taskIds.length,
      workflows: workflows.length,
    });
    if (!wasHalted) runtimeEvent("runtime.halted", { commandId: command.commandId });
    return {
      ok: true,
      taskIds,
      workflowIds: workflows.map((workflow) => workflow.workflowId),
    };
  };

  // workflow.stop (3.14, haril workflow stop): one workflow of the command's project is stopped and its turns cancelled,
  // as the emergency stop does for all of them, without the halt. A workflow that already ended is left as it is.
  const workflowStop = (command: CommandRecord, now: number): ApplyVerdict => {
    const workflowId = command.args.workflowId;
    if (typeof workflowId !== "string" || workflowId.trim() === "") {
      return { ok: false, reason: "workflowId must be a workflow id" };
    }
    const workflow = db
      .prepare(
        "SELECT workflow_id AS workflowId, project_id AS projectId, state FROM workflows WHERE workflow_id = ?",
      )
      .get(workflowId) as { workflowId: string; projectId: string; state: string } | undefined;
    if (workflow === undefined || workflow.projectId !== command.projectId) {
      return { ok: false, reason: `no workflow "${workflowId}" in this project` };
    }
    if (workflow.state !== "running" && workflow.state !== "awaiting_human") {
      return { ok: true, taskIds: [], workflowId, workflowIds: [] };
    }
    stopWorkflowRow(workflow, now);
    const live = db
      .prepare(
        `SELECT task_id AS taskId FROM tasks WHERE workflow_id = ? AND state IN ${LIVE_TASK} ORDER BY created_seq`,
      )
      .all(workflowId) as Array<{ taskId: string }>;
    const taskIds: string[] = [];
    for (const { taskId } of live) {
      if (cancelTask(taskId, "user_stop", now) !== undefined) taskIds.push(taskId);
    }
    return { ok: true, taskIds, workflowId, workflowIds: [workflowId] };
  };

  const resume = (command: CommandRecord): ApplyVerdict => {
    if (Object.keys(command.args).length > 0) {
      return { ok: false, reason: "runtime.resume takes no arguments" };
    }
    if (haltState().halted) {
      db.prepare("DELETE FROM meta WHERE key = ?").run(HALT_KEY);
      runtimeEvent("runtime.resumed", { commandId: command.commandId });
    }
    return { ok: true, taskIds: [] };
  };

  const recordProcess = (epoch: number, runId: string, process: AgentProcess): boolean => {
    const changed = db
      .prepare(
        `UPDATE runs SET pid = ?, pid_started_at = ? WHERE run_id = ? AND runtime_epoch = ? AND status IN ${OPEN_RUN}`,
      )
      .run(process.pid, process.startedAt, runId, epoch);
    return Number(changed.changes) > 0;
  };

  const processes = (filter: RecordedProcessFilter = {}): RecordedProcess[] => {
    const excludeEpoch = filter.excludeEpoch ?? null;
    const endedSince = filter.endedSince ?? null;
    return db
      .prepare(
        `SELECT run_id AS runId, task_id AS taskId, runtime_epoch AS runtimeEpoch, status AS runStatus, pid, pid_started_at AS startedAt
         FROM runs
         WHERE pid IS NOT NULL AND pid_started_at IS NOT NULL
           AND ((status IN ${OPEN_RUN} AND (? IS NULL OR runtime_epoch <> ?))
             OR (? IS NOT NULL AND ended_at IS NOT NULL AND ended_at >= ?))
         ORDER BY created_at, rowid`,
      )
      .all(excludeEpoch, excludeEpoch, endedSince, endedSince) as unknown as RecordedProcess[];
  };

  // Tokens are counted on the project budget only, which every Broker reservation holds, so a call counts once.
  const activity = (runId: string, since: number): RunActivity => {
    const tokens = db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(l.tokens_input, 0) + COALESCE(l.tokens_output, 0)), 0) AS n
         FROM budget_ledger l JOIN budgets b ON b.budget_id = l.budget_id
         WHERE l.run_id = ? AND l.kind = 'commit' AND b.scope_type = 'project' AND l.created_at > ?`,
      )
      .get(runId, since) as { n: number };
    const open = db
      .prepare(
        `SELECT COUNT(DISTINCT reservation_id) AS n FROM budget_ledger
         WHERE run_id = ? AND kind = 'reserve'
           AND reservation_id NOT IN (SELECT reservation_id FROM budget_ledger WHERE run_id = ? AND kind IN ('commit','release'))`,
      )
      .get(runId, runId) as { n: number };
    const tool = db
      .prepare("SELECT MAX(ts) AS at FROM events WHERE run_id = ? AND type LIKE 'tool.%'")
      .get(runId) as { at: number | null };
    return { tokens: Number(tokens.n), openRequests: Number(open.n), lastToolCallAt: tool.at };
  };

  return {
    cancelTask,
    emergencyStop,
    workflowStop,
    resume,
    haltState,
    recordProcess,
    processes,
    activity,
  };
}

// runtime.stop's arguments: none (the ordered stop of ARCH 4.2) or {mode: "now"} (the emergency stop of 3.14).
export function stopModeOf(args: Readonly<Record<string, unknown>>): "graceful" | "now" | null {
  const keys = Object.keys(args);
  if (keys.length === 0) return "graceful";
  if (keys.length === 1 && args.mode === "now") return "now";
  return null;
}
