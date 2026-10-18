import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { isStop, type Stop } from "@haril/contracts";
import type {
  AppendEventInput,
  ApplyTurnsInput,
  ApplyTurnsResult,
  AuditRecord,
  Clock,
  CommandRecord,
  DelegationRecord,
  DelegationRole,
  DependencyKind,
  EventRecord,
  Ids,
  JsonObject,
  RecordAuditInput,
  SetWorkflowStateInput,
  WorkflowAutonomy,
  WorkflowRecord,
  WorkflowsPort,
  WorkflowTaskRecord,
} from "@haril/core/ports";
import { StoreError } from "./errors.js";
import type { ApplyVerdict, NewTask } from "./store.js";

// The delegation module of the Store (docs/modos-y-delegacion.md 4.2, 4.3, 4.4; ADR-0021). The Core decides and this
// module records each decision in one transaction, fenced by the runtime epoch:
//   - workflow.start (a queued command): the workflow row and the orchestrator's first turn, ready;
//   - workflow.continue (a queued command, the human's own action): awaiting_human back to running, optionally without
//     the stops the human removes (3.13: only the human removes a stop);
//   - applyTurns (delegation.apply, internal): the turns a proposal or the Core creates, their dependencies, the
//     inheritance of a thread's dependents by its latest turn, and the proposal row, deduplicated by payload hash;
//   - recordAudit, setState, scheduleCheck.
// Every turn runs with maxAttempts 1: a relaunch after a rejection is a new turn of the same thread, governed by the
// rework machine (3.8), so the store's own retry path never adds a second relaunch.

export type WorkflowCommandHandler = (
  command: CommandRecord,
  now: number,
) => ApplyVerdict | undefined;

interface WorkflowsFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly transaction: <T>(work: () => T) => T;
  readonly appendEvent: (input: AppendEventInput) => EventRecord;
  readonly assertActiveEpoch: (epoch: number) => void;
  readonly insertTask: (task: NewTask, now: number) => void;
  readonly insertDependency: (taskId: string, dependsOn: string, kind: DependencyKind) => void;
  readonly appendTaskCreated: (
    taskId: string,
    projectId: string,
    goal: string,
    state: string,
    extra: Readonly<Record<string, unknown>>,
  ) => void;
}

// The archetype table of core (3.4) as far as the store checks it: the layer and the task kind of each role.
const ROLE_SHAPE: Readonly<Record<DelegationRole, { layer: 1 | 2 | 3; kind: string }>> = {
  orchestrator: { layer: 1, kind: "plan" },
  delegator: { layer: 2, kind: "plan" },
  executor: { layer: 3, kind: "work" },
  auditor: { layer: 3, kind: "verify" },
};

// P1: with nothing said, a workflow stops after the orchestrator's first plan.
const DEFAULT_AUTONOMY: WorkflowAutonomy = { mode: "stops", stops: ["after_plan"] };
const DEFAULT_TIMEOUT_MS = 3_600_000;
const TERMINAL = new Set(["completed", "failed", "stopped"]);
const TERMINAL_TASK = new Set(["completed", "failed", "cancelled"]);

const WORKFLOW_COLUMNS =
  "workflow_id AS workflowId, project_id AS projectId, root_task_id AS rootTaskId, goal, state, autonomy, limits, orchestrator_model AS orchestratorModel, agents_created AS agentsCreated, stop_reason AS stopReason, base_branch AS baseBranch, base_sha AS baseSha, simulated, created_at AS createdAt, ended_at AS endedAt";

const TASK_COLUMNS =
  "task_id AS taskId, workflow_id AS workflowId, thread_id AS threadId, parent_task_id AS parentTaskId, role, layer, kind, local_id AS localId, delegation_id AS delegationId, goal, description, state, block_reason AS blockReason, agent_ref AS agentRef, model, model_pinned AS modelPinned, difficulty, difficulty_reason AS difficultyReason, priority, created_seq AS createdSeq, attempt, budget_max_tokens AS budgetTokens, timeout_ms AS timeoutMs, surface_write AS surfaceWrite, surface_read AS surfaceRead, result, next_check_at AS nextCheckAt, created_at AS createdAt, completed_at AS completedAt";

const DELEGATION_COLUMNS =
  "delegation_id AS delegationId, workflow_id AS workflowId, thread_id AS threadId, parent_task_id AS parentTaskId, proposed_by_run_id AS proposedByRunId, tool, payload_hash AS payloadHash, memo, created_at AS createdAt";

const AUDIT_COLUMNS =
  "audit_id AS auditId, workflow_id AS workflowId, subject_task_id AS subjectTaskId, auditor_task_id AS auditorTaskId, scope, verdict, reasons, rework_action AS reworkAction, created_at AS createdAt";

type Row = Record<string, SQLInputValue>;

function conflict(message: string, details: Record<string, unknown> = {}): StoreError {
  return new StoreError("store.conflict", message, details);
}

function toWorkflow(row: Row): WorkflowRecord {
  return {
    ...(row as unknown as WorkflowRecord),
    autonomy: JSON.parse(String(row.autonomy)) as WorkflowAutonomy,
    limits: JSON.parse(String(row.limits)) as JsonObject,
    simulated: row.simulated === 1,
  };
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

// The autonomy of a workflow.start, or a reason it is refused. The mode follows the stops (no stop is autonomous),
// and a contradictory pair is refused rather than guessed.
function parseAutonomy(value: unknown): WorkflowAutonomy | string {
  if (value === undefined || value === null) return DEFAULT_AUTONOMY;
  if (typeof value !== "object" || Array.isArray(value)) return "autonomy must be an object";
  const { mode, stops } = value as { mode?: unknown; stops?: unknown };
  if (mode !== "autonomous" && mode !== "stops") {
    return 'autonomy.mode must be "autonomous" or "stops"';
  }
  if (!Array.isArray(stops)) return "autonomy.stops must be a list";
  const bad = stops.find((stop) => !isStop(stop));
  if (bad !== undefined) return `autonomy.stops has an unknown stop ${JSON.stringify(bad)}`;
  const unique = [...new Set(stops as Stop[])];
  if (mode === "autonomous" && unique.length > 0) {
    return "an autonomous workflow has no stops; use mode stops";
  }
  return { mode: unique.length > 0 ? "stops" : "autonomous", stops: unique };
}

function optionalInteger(value: unknown, fallback: number, minimum: number): number | undefined {
  if (value === undefined || value === null) return fallback;
  return Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : undefined;
}

export function createWorkflowsFacet(options: WorkflowsFacetOptions): {
  port: WorkflowsPort;
  applyCommand: WorkflowCommandHandler;
} {
  const { db, clock, ids, transaction, appendEvent, assertActiveEpoch } = options;

  const findWorkflow = (workflowId: string): WorkflowRecord | undefined => {
    const row = db
      .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE workflow_id = ?`)
      .get(workflowId) as Row | undefined;
    return row === undefined ? undefined : toWorkflow(row);
  };

  const requireWorkflow = (workflowId: string): WorkflowRecord => {
    const workflow = findWorkflow(workflowId);
    if (workflow === undefined) {
      throw new StoreError("store.not_found", `no workflow with id "${workflowId}"`, {
        workflowId,
      });
    }
    return workflow;
  };

  const workflowEvent = (
    workflow: Pick<WorkflowRecord, "workflowId" | "projectId">,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): void => {
    appendEvent({
      aggregateType: "workflow",
      aggregateId: workflow.workflowId,
      type,
      actorKind: "system",
      actorId: "runtime",
      payload,
      projectId: workflow.projectId,
    });
  };

  // The dependencies of every turn of a workflow, in one query, in the order they were declared.
  const dependenciesIn = (workflowId: string) => {
    const rows = db
      .prepare(
        "SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOn, d.kind AS kind FROM task_dependencies d JOIN tasks t ON t.task_id = d.task_id WHERE t.workflow_id = ? ORDER BY d.rowid",
      )
      .all(workflowId) as Array<{ taskId: string; dependsOn: string; kind: DependencyKind }>;
    const byTask = new Map<string, { taskId: string; kind: DependencyKind }[]>();
    for (const row of rows) {
      const list = byTask.get(row.taskId) ?? [];
      list.push({ taskId: row.dependsOn, kind: row.kind });
      byTask.set(row.taskId, list);
    }
    return byTask;
  };

  const toTask = (
    row: Row,
    dependencies: ReadonlyMap<string, readonly { taskId: string; kind: DependencyKind }[]>,
  ): WorkflowTaskRecord => ({
    ...(row as unknown as WorkflowTaskRecord),
    modelPinned: row.modelPinned === 1,
    surfaceWrite: JSON.parse(String(row.surfaceWrite)) as string[],
    surfaceRead: JSON.parse(String(row.surfaceRead)) as string[],
    result: row.result === null ? null : (JSON.parse(String(row.result)) as JsonObject),
    dependsOn: [...(dependencies.get(String(row.taskId)) ?? [])],
  });

  const applyStart = (command: CommandRecord, now: number): ApplyVerdict => {
    const args = command.args;
    const projectId = command.projectId ?? "";
    if (!nonBlank(args.goal)) return { ok: false, reason: "goal must be a non-empty text" };
    if (!nonBlank(args.model)) {
      return { ok: false, reason: "model (the orchestrator's model) must be a non-empty model id" };
    }
    const agent = args.agent === undefined ? "orchestrator" : args.agent;
    if (!nonBlank(agent)) return { ok: false, reason: "agent must be a non-empty agent ref" };
    const autonomy = parseAutonomy(args.autonomy);
    if (typeof autonomy === "string") return { ok: false, reason: autonomy };
    const limits = args.limits ?? {};
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
      return { ok: false, reason: "limits must be an object (the limits snapshot)" };
    }
    const budgetTokens = optionalInteger(args.budgetTokens, 0, 0);
    if (budgetTokens === undefined)
      return { ok: false, reason: "budgetTokens must be a whole number >= 0" };
    const timeoutMs = optionalInteger(args.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
    if (timeoutMs === undefined)
      return { ok: false, reason: "timeoutMs must be a whole number >= 1" };
    for (const key of ["baseBranch", "baseSha"] as const) {
      if (args[key] !== undefined && args[key] !== null && !nonBlank(args[key])) {
        return { ok: false, reason: `${key} must be a non-empty text` };
      }
    }

    const workflowId = ids.next();
    const taskId = ids.next();
    const threadId = ids.next();
    db.prepare(
      "INSERT INTO workflows (workflow_id, project_id, root_task_id, goal, state, autonomy, limits, orchestrator_model, agents_created, base_branch, base_sha, simulated, created_at) VALUES (?, ?, NULL, ?, 'running', ?, ?, ?, 0, ?, ?, ?, ?)",
    ).run(
      workflowId,
      projectId,
      args.goal as string,
      JSON.stringify(autonomy),
      JSON.stringify(limits),
      args.model as string,
      (args.baseBranch as string | undefined) ?? null,
      (args.baseSha as string | undefined) ?? null,
      args.simulated === true ? 1 : 0,
      now,
    );
    options.insertTask(
      {
        taskId,
        projectId,
        planId: null,
        goal: args.goal as string,
        description: "",
        priority: 5,
        kind: "plan",
        agentRef: agent,
        model: args.model as string,
        requires: [],
        context: [],
        surfaceWrite: [],
        surfaceRead: [],
        budget: { maxCostMicros: 0, maxTokens: budgetTokens, maxWallMs: timeoutMs },
        timeoutMs,
        maxAttempts: 1,
        acceptance: [],
        state: "ready",
        delegation: {
          workflowId,
          layer: 1,
          role: "orchestrator",
          threadId,
          parentTaskId: null,
          difficulty: null,
          difficultyReason: null,
          // The orchestrator's model is the one the user chose (3.11): pinned, never substituted.
          modelPinned: true,
          localId: null,
          delegationId: null,
        },
      },
      now,
    );
    db.prepare(
      "UPDATE workflows SET root_task_id = ?, agents_created = 1 WHERE workflow_id = ?",
    ).run(taskId, workflowId);
    workflowEvent({ workflowId, projectId }, "workflow.created", {
      rootTaskId: taskId,
      autonomy: autonomy.mode,
      stops: autonomy.stops.length,
      simulated: args.simulated === true,
    });
    options.appendTaskCreated(taskId, projectId, args.goal as string, "ready", {
      workflowId,
      role: "orchestrator",
      layer: 1,
    });
    return { ok: true, taskIds: [taskId], workflowId };
  };

  const applyContinue = (command: CommandRecord): ApplyVerdict => {
    const { workflowId, removeStops } = command.args;
    if (!nonBlank(workflowId)) return { ok: false, reason: "workflowId must be a workflow id" };
    const workflow = findWorkflow(workflowId);
    if (workflow === undefined || workflow.projectId !== command.projectId) {
      return { ok: false, reason: `no workflow "${workflowId}" in this project` };
    }
    if (workflow.state !== "awaiting_human") {
      return {
        ok: false,
        reason: `workflow ${workflowId} is ${workflow.state}, not awaiting_human`,
      };
    }
    const remove = removeStops ?? [];
    if (!Array.isArray(remove) || !remove.every(isStop)) {
      return { ok: false, reason: "removeStops must be a list of stops" };
    }
    const stops = workflow.autonomy.stops.filter((stop) => !remove.includes(stop));
    const autonomy: WorkflowAutonomy = { mode: stops.length > 0 ? "stops" : "autonomous", stops };
    db.prepare(
      "UPDATE workflows SET state = 'running', stop_reason = NULL, autonomy = ? WHERE workflow_id = ?",
    ).run(JSON.stringify(autonomy), workflowId);
    workflowEvent(workflow, "workflow.continued", {
      resumedFrom: workflow.stopReason,
      removedStops: remove,
    });
    return { ok: true, taskIds: [], workflowId };
  };

  const applyCommand: WorkflowCommandHandler = (command, now) => {
    if (command.type === "workflow.start") return applyStart(command, now);
    if (command.type === "workflow.continue") return applyContinue(command);
    return undefined;
  };

  const applyTurns = (epoch: number, input: ApplyTurnsInput): ApplyTurnsResult =>
    transaction(() => {
      assertActiveEpoch(epoch);
      const workflow = requireWorkflow(input.workflowId);
      if (workflow.state !== "running") {
        throw conflict(
          `workflow ${workflow.workflowId} is ${workflow.state}; it takes no new turns`,
          {
            workflowId: workflow.workflowId,
          },
        );
      }
      const proposal = input.delegation;
      if (proposal !== undefined) {
        const replay = db
          .prepare(
            "SELECT delegation_id AS delegationId FROM delegations WHERE workflow_id = ? AND thread_id = ? AND payload_hash = ?",
          )
          .get(workflow.workflowId, proposal.threadId, proposal.payloadHash) as
          | { delegationId: string }
          | undefined;
        if (replay !== undefined) {
          return { created: false, delegationId: replay.delegationId, taskIds: {}, threadIds: {} };
        }
      }
      const now = clock.now();
      const delegationId = proposal === undefined ? null : ids.next();
      if (proposal !== undefined) {
        db.prepare(
          "INSERT INTO delegations (delegation_id, workflow_id, thread_id, parent_task_id, proposed_by_run_id, tool, payload_hash, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          delegationId,
          workflow.workflowId,
          proposal.threadId,
          proposal.parentTaskId,
          proposal.proposedByRunId,
          proposal.tool,
          proposal.payloadHash,
          proposal.memo,
          now,
        );
      }

      // The tasks of the workflow by id, with their thread and role, and the keys of this call.
      const known = new Map(
        (
          db
            .prepare(
              "SELECT task_id AS taskId, thread_id AS threadId, role FROM tasks WHERE workflow_id = ?",
            )
            .all(workflow.workflowId) as Array<{ taskId: string; threadId: string; role: string }>
        ).map((row) => [row.taskId, row]),
      );
      const byKey = new Map<string, string>();
      const resolve = (reference: string, where: string): string => {
        const taskId = byKey.get(reference) ?? (known.has(reference) ? reference : undefined);
        if (taskId === undefined) {
          throw conflict(
            `${where}: unknown reference "${reference}" (not a task of this workflow nor an earlier turn)`,
          );
        }
        return taskId;
      };

      const taskIds: Record<string, string> = {};
      const threadIds: Record<string, string> = {};
      try {
        for (const turn of input.turns) {
          const where = `turn "${turn.key}"`;
          if (byKey.has(turn.key)) throw conflict(`${where}: the key is used twice`);
          const shape = ROLE_SHAPE[turn.role];
          if (shape === undefined) throw conflict(`${where}: unknown role "${String(turn.role)}"`);
          if (turn.layer !== shape.layer) {
            throw conflict(
              `${where}: a ${turn.role} runs at layer ${shape.layer}, not ${turn.layer}`,
            );
          }
          if (turn.kind !== shape.kind) {
            throw conflict(
              `${where}: a ${turn.role} runs tasks of kind "${shape.kind}", not "${turn.kind}"`,
            );
          }
          if (turn.parentTaskId === null && turn.role !== "orchestrator") {
            throw conflict(`${where}: a ${turn.role} needs a parent task`);
          }
          const parentTaskId =
            turn.parentTaskId === null ? null : resolve(turn.parentTaskId, where);
          let threadId = turn.threadId;
          if (threadId === null) {
            threadId = ids.next();
          } else {
            const sameThread = [...known.values()].filter((task) => task.threadId === threadId);
            if (sameThread.length === 0 || sameThread.some((task) => task.role !== turn.role)) {
              throw conflict(
                `${where}: thread "${threadId}" is not a ${turn.role} thread of this workflow`,
              );
            }
          }
          const dependencies = new Map<string, DependencyKind>();
          for (const dependency of turn.dependsOn) {
            dependencies.set(resolve(dependency.on, where), dependency.kind);
          }
          const taskId = ids.next();
          const state = dependencies.size === 0 ? "ready" : "pending";
          options.insertTask(
            {
              taskId,
              projectId: workflow.projectId,
              planId: null,
              goal: turn.goal,
              description: turn.description,
              priority: turn.priority,
              kind: turn.kind,
              agentRef: turn.agentRef,
              model: turn.model,
              requires: [],
              context: [],
              surfaceWrite: turn.surfaceWrite,
              surfaceRead: turn.surfaceRead,
              budget: { maxCostMicros: 0, maxTokens: turn.budgetTokens, maxWallMs: turn.timeoutMs },
              timeoutMs: turn.timeoutMs,
              maxAttempts: 1,
              acceptance: [],
              state,
              delegation: {
                workflowId: workflow.workflowId,
                layer: turn.layer,
                role: turn.role,
                threadId,
                parentTaskId,
                difficulty: turn.difficulty,
                difficultyReason: turn.difficultyReason,
                modelPinned: turn.modelPinned,
                localId: turn.localId,
                delegationId,
              },
            },
            now,
          );
          for (const [dependsOn, kind] of dependencies)
            options.insertDependency(taskId, dependsOn, kind);
          options.appendTaskCreated(taskId, workflow.projectId, turn.goal, state, {
            workflowId: workflow.workflowId,
            role: turn.role,
            layer: turn.layer,
          });
          byKey.set(turn.key, taskId);
          known.set(taskId, { taskId, threadId, role: turn.role });
          taskIds[turn.key] = taskId;
          threadIds[turn.key] = threadId;
        }

        const dependents = db.prepare(
          "SELECT d.task_id AS taskId, d.kind AS kind FROM task_dependencies d JOIN tasks t ON t.task_id = d.task_id WHERE d.depends_on_task_id = ? AND t.state = 'pending' ORDER BY d.rowid",
        );
        // A dependent that already waits on the new turn keeps one link: settled when either link is settled, so a moved
        // continuation link never turns into one a failure would block.
        const addDependency = db.prepare(
          "INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?) ON CONFLICT (task_id, depends_on_task_id) DO UPDATE SET kind = CASE WHEN excluded.kind = 'settled' OR task_dependencies.kind = 'settled' THEN 'settled' ELSE 'completed' END",
        );
        const dropDependency = db.prepare(
          "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?",
        );
        // The dependency moves: a dependent of the earlier turn waits for the latest one instead, so a relaunched
        // turn's failed predecessor does not block it. The excepted dependents (the earlier turn's own auditor) stay.
        for (const link of input.inherit ?? []) {
          const from = resolve(link.from, "inherit");
          const to = resolve(link.to, "inherit");
          const except = new Set((link.except ?? []).map((item) => resolve(item, "inherit")));
          for (const row of dependents.all(from) as Array<{ taskId: string; kind: string }>) {
            if (row.taskId === to || except.has(row.taskId)) continue;
            dropDependency.run(row.taskId, from);
            addDependency.run(row.taskId, to, row.kind);
          }
        }
      } catch (error) {
        if (error instanceof StoreError) throw error;
        throw conflict(`turns refused: ${error instanceof Error ? error.message : String(error)}`);
      }

      const stops = [...workflow.autonomy.stops];
      for (const stop of input.addStops ?? []) if (!stops.includes(stop)) stops.push(stop);
      const autonomy: WorkflowAutonomy = { mode: stops.length > 0 ? "stops" : "autonomous", stops };
      db.prepare(
        "UPDATE workflows SET agents_created = agents_created + ?, autonomy = ? WHERE workflow_id = ?",
      ).run(input.turns.length, JSON.stringify(autonomy), workflow.workflowId);
      if (proposal !== undefined && delegationId !== null) {
        appendEvent({
          aggregateType: "delegation",
          aggregateId: delegationId,
          type: "delegation.applied",
          actorKind: "system",
          actorId: `runtime:${epoch}`,
          payload: {
            workflowId: workflow.workflowId,
            threadId: proposal.threadId,
            tool: proposal.tool,
            turns: input.turns.length,
          },
          projectId: workflow.projectId,
          runId: proposal.proposedByRunId ?? undefined,
        });
      }
      return { created: true, delegationId, taskIds, threadIds };
    });

  const roleOf = (workflowId: string, taskId: string): string | undefined =>
    (
      db
        .prepare("SELECT role FROM tasks WHERE task_id = ? AND workflow_id = ?")
        .get(taskId, workflowId) as { role: string } | undefined
    )?.role;

  const findAudit = (where: string, value: string): AuditRecord | undefined => {
    const row = db.prepare(`SELECT ${AUDIT_COLUMNS} FROM audits WHERE ${where} = ?`).get(value) as
      | Row
      | undefined;
    return row === undefined
      ? undefined
      : ({ ...row, reasons: JSON.parse(String(row.reasons)) } as unknown as AuditRecord);
  };

  const recordAudit = (epoch: number, input: RecordAuditInput): AuditRecord =>
    transaction(() => {
      assertActiveEpoch(epoch);
      const workflow = requireWorkflow(input.workflowId);
      if (roleOf(workflow.workflowId, input.auditorTaskId) !== "auditor") {
        throw conflict(`task ${input.auditorTaskId} is not an auditor turn of this workflow`);
      }
      if (input.scope === "task") {
        if (
          input.subjectTaskId === null ||
          roleOf(workflow.workflowId, input.subjectTaskId) !== "executor"
        ) {
          throw conflict("a task audit judges an executor turn of this workflow");
        }
      } else if (input.subjectTaskId !== null) {
        throw conflict("a workflow audit has no subject task");
      }
      if (findAudit("auditor_task_id", input.auditorTaskId) !== undefined) {
        throw conflict(`auditor turn ${input.auditorTaskId} already gave its verdict`);
      }
      // A verdict comes from an auditor turn that has not closed yet: its run records it before the turn ends.
      const auditorState = (
        db.prepare("SELECT state FROM tasks WHERE task_id = ?").get(input.auditorTaskId) as
          | { state: string }
          | undefined
      )?.state;
      if (auditorState !== undefined && TERMINAL_TASK.has(auditorState)) {
        throw conflict(
          `auditor turn ${input.auditorTaskId} is ${auditorState}; a closed turn gives no verdict`,
        );
      }
      // One task-scope verdict per executor turn: a relaunch is a new turn with its own auditor (3.8), so a second
      // verdict on the same turn would count its run twice.
      if (input.scope === "task" && findAudit("subject_task_id", input.subjectTaskId as string)) {
        throw conflict(`executor turn ${input.subjectTaskId} was already audited`);
      }
      const auditId = ids.next();
      db.prepare(
        "INSERT INTO audits (audit_id, workflow_id, subject_task_id, auditor_task_id, scope, verdict, reasons, rework_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        auditId,
        workflow.workflowId,
        input.subjectTaskId,
        input.auditorTaskId,
        input.scope,
        input.verdict,
        JSON.stringify(input.reasons),
        input.reworkAction,
        clock.now(),
      );
      const event = (type: string, payload: Readonly<Record<string, unknown>>): void => {
        appendEvent({
          aggregateType: "audit",
          aggregateId: auditId,
          type,
          actorKind: "system",
          actorId: `runtime:${epoch}`,
          payload: { workflowId: workflow.workflowId, ...payload },
          projectId: workflow.projectId,
          taskId: input.auditorTaskId,
        });
      };
      event("audit.verdict", {
        scope: input.scope,
        verdict: input.verdict,
        reworkAction: input.reworkAction,
        unmet: input.reasons.filter((reason) => !reason.ok).length,
      });
      if (input.reworkAction === "retry")
        event("audit.retry", { subjectTaskId: input.subjectTaskId });
      if (input.reworkAction === "escalate") {
        event("audit.escalated", { subjectTaskId: input.subjectTaskId });
      }
      return findAudit("audit_id", auditId) as AuditRecord;
    });

  const setState = (epoch: number, input: SetWorkflowStateInput): WorkflowRecord =>
    transaction(() => {
      assertActiveEpoch(epoch);
      const workflow = requireWorkflow(input.workflowId);
      const allowed =
        workflow.state === "running" ||
        (workflow.state === "awaiting_human" && TERMINAL.has(input.state));
      if (!allowed) {
        throw conflict(
          `workflow ${workflow.workflowId} is ${workflow.state}; it cannot become ${input.state}`,
          {
            workflowId: workflow.workflowId,
          },
        );
      }
      const now = clock.now();
      db.prepare(
        "UPDATE workflows SET state = ?, stop_reason = ?, ended_at = ? WHERE workflow_id = ?",
      ).run(
        input.state,
        input.reason ?? null,
        TERMINAL.has(input.state) ? now : null,
        workflow.workflowId,
      );
      workflowEvent(
        workflow,
        `workflow.${input.state}`,
        input.reason === undefined ? {} : { reason: input.reason },
      );
      return requireWorkflow(workflow.workflowId);
    });

  const port: WorkflowsPort = {
    get: findWorkflow,
    list(filter) {
      const rows = db
        .prepare(
          `SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE (? IS NULL OR project_id = ?) ORDER BY created_at DESC, rowid DESC`,
        )
        .all(filter?.projectId ?? null, filter?.projectId ?? null) as Row[];
      return rows.map(toWorkflow);
    },
    tasks(workflowId) {
      const rows = db
        .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE workflow_id = ? ORDER BY created_seq`)
        .all(workflowId) as Row[];
      const dependencies = dependenciesIn(workflowId);
      return rows.map((row) => toTask(row, dependencies));
    },
    delegations(workflowId) {
      return db
        .prepare(
          `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE workflow_id = ? ORDER BY created_at, rowid`,
        )
        .all(workflowId) as unknown as DelegationRecord[];
    },
    audits(workflowId) {
      const rows = db
        .prepare(
          `SELECT ${AUDIT_COLUMNS} FROM audits WHERE workflow_id = ? ORDER BY created_at, rowid`,
        )
        .all(workflowId) as Row[];
      return rows.map(
        (row) => ({ ...row, reasons: JSON.parse(String(row.reasons)) }) as unknown as AuditRecord,
      );
    },
    applyTurns,
    recordAudit,
    setState,
    scheduleCheck(epoch, taskId, at) {
      transaction(() => {
        assertActiveEpoch(epoch);
        const changed = db
          .prepare(
            "UPDATE tasks SET next_check_at = ? WHERE task_id = ? AND workflow_id IS NOT NULL",
          )
          .run(at, taskId);
        if (Number(changed.changes) === 0) {
          throw new StoreError("store.not_found", `no workflow turn with id "${taskId}"`, {
            taskId,
          });
        }
      });
    },
  };
  return { port, applyCommand };
}
