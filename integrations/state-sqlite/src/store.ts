import type { DatabaseSync } from "node:sqlite";
import type {
  AcquireLeaseInput,
  AgentMetrics,
  AppendEventInput,
  AppliedCommand,
  ClaimedTask,
  Clock,
  CommandRecord,
  CompletedRun,
  EnqueueCommandInput,
  EnqueueResult,
  EventFilter,
  EventRecord,
  Ids,
  JsonObject,
  LeaseGrant,
  MetricsSnapshot,
  ProjectRecord,
  PromoteResult,
  RecoveredTask,
  RegisterProjectInput,
  Result,
  RunCompletion,
  RuntimeBusyError,
  RuntimeLeaseSummary,
  Store,
  StoreGate,
  StoreInfo,
  StoreRules,
  TaskDetail,
  TaskFilter,
  TaskRecord,
} from "@haril/core/ports";

// The task states as the Core defines them (the adapter imports types from @haril/core/ports only).
type TaskState = TaskRecord["state"];

import { createBudgetFacets } from "./budgets.js";
import { readPragmas, readUserVersion } from "./connection.js";
import { StoreError } from "./errors.js";
import { createMaintenance } from "./maintenance.js";

// Implementation of the Store port over one node:sqlite connection. Writes run in BEGIN IMMEDIATE.
// Core rules (transition table, plan checks) arrive through `rules`; this file never imports Core values.

interface StoreOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly rules: StoreRules;
  readonly isPidAlive: (pid: number) => boolean;
  readonly storeId: string;
  readonly sqliteVersion: string;
  readonly gates: readonly StoreGate[];
  // The WAL file of this database, null for an in-memory store (INV-14).
  readonly walPath: string | null;
}

const PROJECT_COLUMNS =
  "project_id AS projectId, slug, name, root_path AS rootPath, manifest_sha256 AS manifestSha256, created_at AS createdAt";

const TASK_COLUMNS =
  "task_id AS taskId, project_id AS projectId, goal, state, agent_ref AS agentRef, created_at AS createdAt";

// The error column is the newest failed attempt's JSON error (M2-T6), read as text and parsed in getTask.
const TASK_DETAIL_COLUMNS = `${TASK_COLUMNS}, description, model, budget_max_tokens AS maxTokens, attempt, attempts_used AS attemptsUsed, max_attempts AS maxAttempts, timeout_ms AS timeoutMs, claim_epoch AS claimEpoch, infra_restarts AS infraRestarts, retry_reason AS retryReason, block_reason AS blockReason, result, (SELECT r.error FROM runs r WHERE r.task_id = tasks.task_id AND r.error IS NOT NULL ORDER BY r.attempt DESC LIMIT 1) AS errorJson`;

const LEASE_COLUMNS =
  "instance_id AS instanceId, pid, started_at AS startedAt, heartbeat_at AS heartbeatAt, expires_at AS expiresAt, status, node_version AS nodeVersion, sqlite_version AS sqliteVersion";

const COMMAND_COLUMNS =
  "command_id AS commandId, project_id AS projectId, type, args, idempotency_key AS idempotencyKey, request_hash AS requestHash, enqueued_at AS enqueuedAt";

const EVENT_COLUMNS =
  "seq, event_id AS eventId, ts, aggregate_type AS aggregateType, aggregate_id AS aggregateId, type, schema_version AS schemaVersion, actor_kind AS actorKind, actor_id AS actorId, correlation_id AS correlationId, causation_id AS causationId, audit, payload, project_id AS projectId, task_id AS taskId, run_id AS runId, agent_id AS agentId";

const PRIORITY_MIN = 0;
const PRIORITY_MAX = 9;

interface EventRow
  extends Omit<
    EventRecord,
    | "audit"
    | "payload"
    | "correlationId"
    | "causationId"
    | "projectId"
    | "taskId"
    | "runId"
    | "agentId"
  > {
  readonly audit: number;
  readonly payload: string;
  readonly correlationId: string | null;
  readonly causationId: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly agentId: string | null;
}

interface CommandRow extends Omit<CommandRecord, "args" | "projectId"> {
  readonly projectId: string | null;
  readonly args: string;
}

interface TaskDetailRow extends Omit<TaskDetail, "result" | "error" | "dependsOn"> {
  readonly result: string | null;
  readonly errorJson: string | null;
}

interface OrphanRow {
  readonly taskId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly infraRestarts: number;
}

interface ReadyRow {
  readonly taskId: string;
  readonly projectId: string;
  readonly goal: string;
  readonly description: string;
  readonly agentRef: string;
  readonly model: string | null;
  readonly maxTokens: number;
  readonly acceptance: string;
  readonly attempt: number;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly claimEpoch: number;
}

type LeaseRow = Extract<RuntimeLeaseSummary, { status: "active" | "released" | "lost" }>;

// Outcome of applying one command: applied with the ids it created, or rejected with a reason.
type ApplyVerdict =
  | { readonly ok: true; readonly taskIds: readonly string[]; readonly planId?: string }
  | { readonly ok: false; readonly reason: string };

interface NewTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly planId: string | null;
  readonly goal: string;
  readonly description: string;
  readonly priority: number;
  readonly kind: string;
  readonly agentRef: string;
  // The model a real-agent task asks for (M2-T6); null for plan tasks and the simulated agents.
  readonly model: string | null;
  readonly requires: readonly unknown[];
  readonly context: readonly unknown[];
  readonly surfaceWrite: readonly string[];
  readonly surfaceRead: readonly string[];
  readonly budget: {
    readonly maxCostMicros: number;
    readonly maxTokens: number;
    readonly maxWallMs: number;
  };
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly acceptance: readonly unknown[];
  readonly state: "pending" | "ready";
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly rules: StoreRules;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly storeId: string;
  private readonly sqliteVersion: string;
  private readonly gates: readonly StoreGate[];

  readonly projects: Store["projects"];
  readonly commands: Store["commands"];
  readonly tasks: Store["tasks"];
  readonly runtime: Store["runtime"];
  readonly runs: Store["runs"];
  readonly events: Store["events"];
  readonly metrics: Store["metrics"];
  readonly budgets: Store["budgets"];
  readonly virtualKeys: Store["virtualKeys"];
  readonly maintenance: Store["maintenance"];

  constructor(options: StoreOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.ids = options.ids;
    this.rules = options.rules;
    this.isPidAlive = options.isPidAlive;
    this.storeId = options.storeId;
    this.sqliteVersion = options.sqliteVersion;
    this.gates = options.gates;
    this.projects = {
      register: (input) => this.registerProject(input),
      list: () => this.listProjects(),
      getBySlug: (slug) => this.findProject("slug", slug),
      getByRootPath: (rootPath) => this.findProject("root_path", rootPath),
    };
    this.commands = {
      enqueue: (input) => this.enqueueCommand(input),
      listQueued: () => this.listQueuedCommands(),
      applyNext: (epoch) => this.applyNextCommand(epoch),
    };
    this.tasks = {
      list: (filter) => this.listTasks(filter),
      get: (taskId) => this.getTask(taskId),
      promote: () => this.promoteTasks(),
      claimNext: (epoch, excludeAgentRefs, excludeTaskIds) =>
        this.claimNextTask(epoch, excludeAgentRefs, excludeTaskIds),
    };
    this.runtime = {
      leaseSummary: () => this.leaseSummary(),
      acquire: (input) => this.acquireLease(input),
      heartbeat: (epoch, ttlMs) => this.heartbeatLease(epoch, ttlMs),
      release: (epoch, cleanExit) => this.releaseLease(epoch, cleanExit),
      reconcile: (epoch, maxInfraRestarts) => this.reconcileOrphans(epoch, maxInfraRestarts),
    };
    this.runs = {
      complete: (completion) => this.completeRun(completion),
    };
    this.events = {
      append: (input) => this.appendEvent(input),
      list: (filter) => this.listEvents(filter),
    };
    this.metrics = {
      snapshot: (projectId) => this.metricsSnapshot(projectId),
    };
    const facets = createBudgetFacets({
      db: this.db,
      clock: this.clock,
      ids: this.ids,
      transaction: (work) => this.inTransaction(work),
    });
    this.budgets = facets.budgets;
    this.virtualKeys = facets.virtualKeys;
    this.maintenance = createMaintenance({ db: this.db, walPath: options.walPath });
  }

  info(): StoreInfo {
    return {
      storeId: this.storeId,
      schemaVersion: readUserVersion(this.db),
      sqliteVersion: this.sqliteVersion,
      pragmas: readPragmas(this.db),
      gates: this.gates,
    };
  }

  close(): void {
    this.db.close();
  }

  private registerProject(input: RegisterProjectInput): ProjectRecord {
    const projectId = input.projectId ?? this.ids.next();
    const createdAt = this.clock.now();
    const manifestSha256 = input.manifestSha256 ?? null;
    const trustedAt = manifestSha256 === null ? null : createdAt;
    try {
      this.db
        .prepare(
          "INSERT INTO projects (project_id, slug, name, root_path, manifest_sha256, manifest_json, trusted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          projectId,
          input.slug,
          input.name,
          input.rootPath,
          manifestSha256,
          input.manifestJson ?? null,
          trustedAt,
          createdAt,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StoreError(
          "store.conflict",
          `project slug "${input.slug}" is already registered`,
          {
            slug: input.slug,
          },
        );
      }
      throw error;
    }
    return {
      projectId,
      slug: input.slug,
      name: input.name,
      rootPath: input.rootPath,
      manifestSha256,
      createdAt,
    };
  }

  private listProjects(): ProjectRecord[] {
    return this.db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at, rowid`)
      .all() as unknown as ProjectRecord[];
  }

  // `column` is one of two fixed names chosen by the Store, never caller input.
  private findProject(column: "slug" | "root_path", value: string): ProjectRecord | undefined {
    return this.db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE ${column} = ?`)
      .get(value) as unknown as ProjectRecord | undefined;
  }

  private listTasks(filter?: TaskFilter): TaskRecord[] {
    return this.db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE (? IS NULL OR project_id = ?) ORDER BY created_seq`,
      )
      .all(filter?.projectId ?? null, filter?.projectId ?? null) as unknown as TaskRecord[];
  }

  private getTask(taskId: string): TaskDetail | undefined {
    const row = this.db
      .prepare(`SELECT ${TASK_DETAIL_COLUMNS} FROM tasks WHERE task_id = ?`)
      .get(taskId) as unknown as TaskDetailRow | undefined;
    if (row === undefined) return undefined;
    const { result, errorJson, ...rest } = row;
    const dependencies = this.db
      .prepare(
        "SELECT depends_on_task_id AS taskId FROM task_dependencies WHERE task_id = ? ORDER BY rowid",
      )
      .all(taskId) as unknown as Array<{ taskId: string }>;
    return {
      ...rest,
      result: result === null ? null : (JSON.parse(result) as JsonObject),
      error: errorJson === null ? null : (JSON.parse(errorJson) as TaskDetail["error"]),
      dependsOn: dependencies.map((dependency) => dependency.taskId),
    };
  }

  // An active lease wins; otherwise the newest lease tells whether the last runtime was released or lost.
  private leaseSummary(): RuntimeLeaseSummary {
    const row = this.db
      .prepare(
        `SELECT ${LEASE_COLUMNS} FROM runtime_leases ORDER BY (status = 'active') DESC, runtime_epoch DESC LIMIT 1`,
      )
      .get() as unknown as LeaseRow | undefined;
    if (row === undefined) return { status: "none" };
    return row;
  }

  // Singleton lease: an active lease refuses the caller only while it has not expired AND its pid is alive.
  // Otherwise it is marked lost and taken over with the next epoch (M1-D6, M1 fix c). The decision and the
  // insert share one transaction.
  private acquireLease(input: AcquireLeaseInput): Result<LeaseGrant, RuntimeBusyError> {
    return this.inTransaction(() => {
      const now = this.clock.now();
      const active = this.db
        .prepare(
          "SELECT runtime_epoch AS epoch, instance_id AS instanceId, pid, expires_at AS expiresAt FROM runtime_leases WHERE status = 'active'",
        )
        .get() as { epoch: number; instanceId: string; pid: number; expiresAt: number } | undefined;
      if (active !== undefined) {
        if (active.expiresAt > now && this.isPidAlive(active.pid)) {
          return {
            ok: false as const,
            error: {
              code: "runtime.busy" as const,
              message: `another runtime is active (pid ${active.pid})`,
              pid: active.pid,
              instanceId: active.instanceId,
              expiresAt: active.expiresAt,
            },
          };
        }
        this.db
          .prepare("UPDATE runtime_leases SET status = 'lost' WHERE runtime_epoch = ?")
          .run(active.epoch);
      }
      const instanceId = this.ids.next();
      // pid_started_at is the acquisition time: the store has no portable process start time (M1).
      const inserted = this.db
        .prepare(
          "INSERT INTO runtime_leases (instance_id, pid, pid_started_at, started_at, heartbeat_at, expires_at, status, node_version, sqlite_version) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
        )
        .run(
          instanceId,
          input.pid,
          now,
          now,
          now,
          now + input.ttlMs,
          input.nodeVersion,
          input.sqliteVersion,
        );
      return {
        ok: true as const,
        value: { epoch: Number(inserted.lastInsertRowid), instanceId },
      };
    });
  }

  private heartbeatLease(epoch: number, ttlMs: number): void {
    this.inTransaction(() => {
      this.assertActiveEpoch(epoch);
      const now = this.clock.now();
      this.db
        .prepare(
          "UPDATE runtime_leases SET heartbeat_at = ?, expires_at = ? WHERE runtime_epoch = ?",
        )
        .run(now, now + ttlMs, epoch);
    });
  }

  private releaseLease(epoch: number, cleanExit: boolean): void {
    this.inTransaction(() => {
      this.assertActiveEpoch(epoch);
      this.db
        .prepare(
          "UPDATE runtime_leases SET status = 'released', clean_exit = ?, released_at = ? WHERE runtime_epoch = ?",
        )
        .run(cleanExit ? 1 : 0, this.clock.now(), epoch);
    });
  }

  // Every write that a runtime makes names its epoch; a lost or released epoch is fenced out.
  private assertActiveEpoch(epoch: number): void {
    const row = this.db
      .prepare("SELECT status FROM runtime_leases WHERE runtime_epoch = ?")
      .get(epoch) as { status: string } | undefined;
    if (row?.status !== "active") {
      throw new StoreError(
        "store.fenced",
        `runtime epoch ${epoch} is not the active lease (another runtime took over or this one released it)`,
        { epoch },
      );
    }
  }

  private enqueueCommand(input: EnqueueCommandInput): EnqueueResult {
    return this.inTransaction(() => {
      const existing = this.db
        .prepare(
          "SELECT command_id AS commandId, request_hash AS requestHash FROM commands WHERE idempotency_key = ?",
        )
        .get(input.idempotencyKey) as { commandId: string; requestHash: string } | undefined;
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) {
          throw new StoreError(
            "store.conflict",
            `idempotency key "${input.idempotencyKey}" was already used for a different request`,
            { idempotencyKey: input.idempotencyKey },
          );
        }
        return { commandId: existing.commandId, duplicate: true };
      }
      const commandId = this.ids.next();
      this.db
        .prepare(
          "INSERT INTO commands (command_id, project_id, type, args, idempotency_key, request_hash, status, enqueued_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
        )
        .run(
          commandId,
          input.projectId ?? null,
          input.type,
          JSON.stringify(input.args),
          input.idempotencyKey,
          input.requestHash,
          this.clock.now(),
        );
      return { commandId, duplicate: false };
    });
  }

  private listQueuedCommands(): CommandRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${COMMAND_COLUMNS} FROM commands WHERE status = 'queued' ORDER BY enqueued_at, rowid`,
      )
      .all() as unknown as CommandRow[];
    return rows.map(parseCommand);
  }

  // Applies the oldest queued command. A rejection is recorded and committed; a fenced epoch throws.
  private applyNextCommand(epoch: number): AppliedCommand | undefined {
    return this.inTransaction(() => {
      this.assertActiveEpoch(epoch);
      const row = this.db
        .prepare(
          `SELECT ${COMMAND_COLUMNS} FROM commands WHERE status = 'queued' ORDER BY enqueued_at, rowid LIMIT 1`,
        )
        .get() as unknown as CommandRow | undefined;
      if (row === undefined) return undefined;

      const command = parseCommand(row);
      const now = this.clock.now();
      const verdict = this.applyCommandBody(command, now);
      const actor = { actorKind: "system" as const, actorId: `runtime:${epoch}` };
      if (verdict.ok) {
        this.db
          .prepare(
            "UPDATE commands SET status = 'applied', applied_at = ?, applied_runtime_epoch = ?, result = ? WHERE command_id = ?",
          )
          .run(
            now,
            epoch,
            JSON.stringify({ taskIds: verdict.taskIds, planId: verdict.planId ?? null }),
            command.commandId,
          );
        this.appendEvent({
          aggregateType: "command",
          aggregateId: command.commandId,
          type: "command.applied",
          ...actor,
          payload: { commandType: command.type, taskIds: verdict.taskIds },
          projectId: command.projectId ?? undefined,
        });
        return {
          commandId: command.commandId,
          type: command.type,
          outcome: "applied",
          taskIds: verdict.taskIds,
          planId: verdict.planId,
        };
      }
      this.db
        .prepare(
          "UPDATE commands SET status = 'rejected', applied_at = ?, applied_runtime_epoch = ?, reject_reason = ? WHERE command_id = ?",
        )
        .run(now, epoch, verdict.reason, command.commandId);
      this.appendEvent({
        aggregateType: "command",
        aggregateId: command.commandId,
        type: "command.rejected",
        ...actor,
        payload: { commandType: command.type, reason: verdict.reason },
        projectId: command.projectId ?? undefined,
      });
      return {
        commandId: command.commandId,
        type: command.type,
        outcome: "rejected",
        reason: verdict.reason,
        taskIds: [],
      };
    });
  }

  private applyCommandBody(command: CommandRecord, now: number): ApplyVerdict {
    if (command.projectId === null) return { ok: false, reason: "command has no project" };
    if (command.type === "task.create") return this.applyTaskCreate(command, now);
    if (command.type === "plan.submit") return this.applyPlanSubmit(command, now);
    return { ok: false, reason: `unsupported command type "${command.type}"` };
  }

  private applyTaskCreate(command: CommandRecord, now: number): ApplyVerdict {
    const projectId = command.projectId ?? "";
    const parsed = parseTaskCreateArgs(command.args, this.rules.checkAcceptance);
    if (typeof parsed === "string") return { ok: false, reason: parsed };

    const dependsOn = [...new Set(parsed.dependsOn)];
    for (const dependency of dependsOn) {
      if (!this.taskInProject(dependency, projectId)) {
        return { ok: false, reason: `unknown dependency "${dependency}"` };
      }
    }

    const taskId = this.ids.next();
    this.insertTask(
      {
        taskId,
        projectId,
        planId: null,
        goal: parsed.goal,
        description: "",
        priority: 5,
        kind: "work",
        agentRef: parsed.agent,
        model: parsed.model,
        requires: [],
        context: [],
        surfaceWrite: [],
        surfaceRead: [],
        // The token ceiling of a real agent (M2-D5). Simulated tasks keep 0; their wall time is the timeout.
        budget: { maxCostMicros: 0, maxTokens: parsed.maxTokens, maxWallMs: parsed.timeoutMs },
        timeoutMs: parsed.timeoutMs,
        maxAttempts: parsed.maxAttempts,
        acceptance: parsed.acceptance,
        state: dependsOn.length === 0 ? "ready" : "pending",
      },
      now,
    );
    for (const dependency of dependsOn) this.insertDependency(taskId, dependency);
    this.appendTaskCreated(
      taskId,
      projectId,
      parsed.goal,
      dependsOn.length === 0 ? "ready" : "pending",
    );
    return { ok: true, taskIds: [taskId] };
  }

  private applyPlanSubmit(command: CommandRecord, now: number): ApplyVerdict {
    const projectId = command.projectId ?? "";
    const check = this.rules.checkPlan(command.args.plan);
    if (!check.ok) return { ok: false, reason: check.reason };

    const byLocalId = new Map(check.plan.tasks.map((task) => [task.localId, task]));
    for (const task of check.plan.tasks) {
      if (
        !Number.isInteger(task.priority) ||
        task.priority < PRIORITY_MIN ||
        task.priority > PRIORITY_MAX
      ) {
        return { ok: false, reason: `priority of "${task.localId}" must be between 0 and 9` };
      }
    }

    const planId = this.ids.next();
    this.db
      .prepare(
        "INSERT INTO plans (plan_id, project_id, root_plan_id, parent_plan_id, depth, submitted_by_task_id, replans_used, created_at) VALUES (?, ?, ?, NULL, 0, NULL, 0, ?)",
      )
      .run(planId, projectId, planId, now);

    // Dependency order from the Core check: every dependency is inserted before its dependents.
    const taskIdByLocalId = new Map<string, string>();
    const taskIds: string[] = [];
    for (const localId of check.order) {
      const task = byLocalId.get(localId);
      if (task === undefined) continue;
      const taskId = this.ids.next();
      taskIdByLocalId.set(localId, taskId);
      const dependencies = task.dependsOn.flatMap((dep) => taskIdByLocalId.get(dep) ?? []);
      const state = dependencies.length === 0 ? "ready" : "pending";
      this.insertTask(
        {
          taskId,
          projectId,
          planId,
          goal: task.goal,
          description: task.description,
          priority: task.priority,
          kind: task.kind,
          agentRef: task.agent,
          model: null,
          requires: task.requires,
          context: task.context,
          surfaceWrite: task.surface.write,
          surfaceRead: task.surface.read,
          budget: task.budget,
          timeoutMs: task.timeoutMs,
          maxAttempts: task.maxAttempts,
          acceptance: task.acceptance,
          state,
        },
        now,
      );
      for (const dependency of dependencies) this.insertDependency(taskId, dependency);
      this.appendTaskCreated(taskId, projectId, task.goal, state);
      taskIds.push(taskId);
    }

    this.appendEvent({
      aggregateType: "plan",
      aggregateId: planId,
      type: "plan.submitted",
      actorKind: "system",
      actorId: "runtime",
      payload: { taskCount: taskIds.length, order: check.order },
      projectId,
    });
    return { ok: true, taskIds, planId };
  }

  private taskInProject(taskId: string, projectId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS found FROM tasks WHERE task_id = ? AND project_id = ?")
        .get(taskId, projectId) !== undefined
    );
  }

  private insertTask(task: NewTask, now: number): void {
    const { next } = this.db
      .prepare("SELECT COALESCE(MAX(created_seq), 0) + 1 AS next FROM tasks")
      .get() as { next: number };
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, project_id, plan_id, root_plan_id, goal, description, priority, kind, agent_ref, model, requires, context, surface_write, surface_read, budget_max_cost_micros, budget_max_tokens, budget_max_wall_ms, timeout_ms, max_attempts, state, acceptance, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.projectId,
        task.planId,
        task.planId,
        task.goal,
        task.description,
        task.priority,
        task.kind,
        task.agentRef,
        task.model,
        JSON.stringify(task.requires),
        JSON.stringify(task.context),
        JSON.stringify(task.surfaceWrite),
        JSON.stringify(task.surfaceRead),
        task.budget.maxCostMicros,
        task.budget.maxTokens,
        task.budget.maxWallMs,
        task.timeoutMs,
        task.maxAttempts,
        task.state,
        JSON.stringify(task.acceptance),
        next,
        now,
        now,
      );
  }

  private insertDependency(taskId: string, dependsOn: string): void {
    this.db
      .prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)")
      .run(taskId, dependsOn);
  }

  private appendTaskCreated(taskId: string, projectId: string, goal: string, state: string): void {
    this.appendEvent({
      aggregateType: "task",
      aggregateId: taskId,
      type: "task.created",
      actorKind: "system",
      actorId: "runtime",
      payload: { goal, state },
      projectId,
      taskId,
    });
  }

  // pending -> ready (all dependencies completed) or pending -> blocked(dep_failed) (a dependency failed, was
  // cancelled or is blocked(dep_failed)). Rounds repeat until nothing changes, so the block propagates down any
  // chain inside this one transaction (M1 fix b).
  private promoteTasks(): PromoteResult {
    return this.inTransaction(() => {
      const pendingTasks = this.db.prepare(
        "SELECT task_id AS taskId, goal, project_id AS projectId FROM tasks WHERE state = 'pending' ORDER BY created_seq",
      );
      const dependencyStates = this.db.prepare(
        "SELECT t.state AS state, t.block_reason AS blockReason FROM task_dependencies d JOIN tasks t ON t.task_id = d.depends_on_task_id WHERE d.task_id = ?",
      );
      const ready: Array<{ taskId: string; goal: string }> = [];
      const blocked: Array<{ taskId: string; goal: string }> = [];
      const now = this.clock.now();
      let changed = true;
      while (changed) {
        changed = false;
        const pending = pendingTasks.all() as unknown as Array<{
          taskId: string;
          goal: string;
          projectId: string;
        }>;
        for (const task of pending) {
          const dependencies = dependencyStates.all(task.taskId) as Array<{
            state: string;
            blockReason: string | null;
          }>;
          if (dependencies.some(isDependencyFailure)) {
            this.transition("pending", "blocked");
            this.db
              .prepare(
                "UPDATE tasks SET state = 'blocked', block_reason = 'dep_failed', updated_at = ? WHERE task_id = ?",
              )
              .run(now, task.taskId);
            this.appendEvent({
              aggregateType: "task",
              aggregateId: task.taskId,
              type: "task.blocked",
              actorKind: "system",
              actorId: "runtime",
              payload: { reason: "dep_failed" },
              projectId: task.projectId,
              taskId: task.taskId,
            });
            blocked.push({ taskId: task.taskId, goal: task.goal });
            changed = true;
          } else if (dependencies.every((dependency) => dependency.state === "completed")) {
            this.transition("pending", "ready");
            this.db
              .prepare("UPDATE tasks SET state = 'ready', updated_at = ? WHERE task_id = ?")
              .run(now, task.taskId);
            this.appendEvent({
              aggregateType: "task",
              aggregateId: task.taskId,
              type: "task.ready",
              actorKind: "system",
              actorId: "runtime",
              payload: {},
              projectId: task.projectId,
              taskId: task.taskId,
            });
            ready.push({ taskId: task.taskId, goal: task.goal });
            changed = true;
          }
        }
      }
      return { ready, blocked };
    });
  }

  // ready -> running in one transaction, with the run row and the next claim epoch (M1-D4: no budget held).
  private claimNextTask(
    epoch: number,
    excludeAgentRefs: readonly string[] = [],
    excludeTaskIds: readonly string[] = [],
  ): ClaimedTask | undefined {
    return this.inTransaction(() => {
      this.assertActiveEpoch(epoch);
      // Excluded agents and tasks are skipped in SQL, so the claim never touches a task that cannot run (M2-T6, M3-T7).
      const excludedAgents = [...new Set(excludeAgentRefs)];
      const excludedTasks = [...new Set(excludeTaskIds)];
      const notExcludedAgents =
        excludedAgents.length === 0
          ? ""
          : ` AND agent_ref NOT IN (${excludedAgents.map(() => "?").join(", ")})`;
      const notExcludedTasks =
        excludedTasks.length === 0
          ? ""
          : ` AND task_id NOT IN (${excludedTasks.map(() => "?").join(", ")})`;
      const row = this.db
        .prepare(
          `SELECT task_id AS taskId, project_id AS projectId, goal, description, agent_ref AS agentRef, model, budget_max_tokens AS maxTokens, acceptance, attempt, attempts_used AS attemptsUsed, max_attempts AS maxAttempts, timeout_ms AS timeoutMs, claim_epoch AS claimEpoch FROM tasks WHERE state = 'ready'${notExcludedAgents}${notExcludedTasks} ORDER BY priority DESC, created_seq LIMIT 1`,
        )
        .get(...excludedAgents, ...excludedTasks) as unknown as ReadyRow | undefined;
      if (row === undefined) return undefined;

      this.transition("ready", "running");
      const now = this.clock.now();
      const attempt = row.attempt + 1;
      const claimEpoch = row.claimEpoch + 1;
      const runId = this.ids.next();
      const sessionId = this.ids.next();
      // M1 placeholder for RouteDecision: the fake runtime serves every task (M1-D7).
      const route = JSON.stringify({ agentRef: row.agentRef, runtime: "fake" });
      this.db
        .prepare(
          "UPDATE tasks SET state = 'running', phase = 'executing', retry_reason = NULL, attempt = ?, claim_epoch = ?, claimed_runtime_epoch = ?, route = ?, updated_at = ? WHERE task_id = ? AND state = 'ready'",
        )
        .run(attempt, claimEpoch, epoch, route, now, row.taskId);
      this.db
        .prepare(
          "INSERT INTO runs (run_id, task_id, project_id, attempt, session_id, agent_id, status, runtime_epoch, claim_epoch, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)",
        )
        .run(
          runId,
          row.taskId,
          row.projectId,
          attempt,
          sessionId,
          row.agentRef,
          epoch,
          claimEpoch,
          now,
          now,
        );
      this.appendEvent({
        aggregateType: "task",
        aggregateId: row.taskId,
        type: "task.claimed",
        actorKind: "system",
        actorId: `runtime:${epoch}`,
        payload: { attempt, claimEpoch },
        projectId: row.projectId,
        taskId: row.taskId,
        runId,
        agentId: row.agentRef,
        ts: now,
      });
      return {
        taskId: row.taskId,
        projectId: row.projectId,
        runId,
        goal: row.goal,
        description: row.description,
        agentRef: row.agentRef,
        model: row.model,
        maxTokens: row.maxTokens,
        acceptance: JSON.parse(row.acceptance) as ClaimedTask["acceptance"],
        attempt,
        attemptsUsed: row.attemptsUsed,
        maxAttempts: row.maxAttempts,
        timeoutMs: row.timeoutMs,
        claimEpoch,
        runtimeEpoch: epoch,
      };
    });
  }

  // Success: the result is written in the same UPDATE that sets `completed`. Failure: one attempt is charged;
  // with attempts left the task returns to ready (transient retry), otherwise it fails.
  private completeRun(completion: RunCompletion): CompletedRun {
    return this.inTransaction(() => {
      const run = this.db
        .prepare(
          "SELECT task_id AS taskId, status, claim_epoch AS claimEpoch, attempt FROM runs WHERE run_id = ?",
        )
        .get(completion.runId) as
        | { taskId: string; status: string; claimEpoch: number; attempt: number }
        | undefined;
      if (run === undefined || run.status !== "running") {
        throw new StoreError("store.stale", `run ${completion.runId} is not running`, {
          runId: completion.runId,
        });
      }
      const task = this.db
        .prepare(
          "SELECT goal, project_id AS projectId, state, claim_epoch AS claimEpoch, attempts_used AS attemptsUsed, max_attempts AS maxAttempts FROM tasks WHERE task_id = ?",
        )
        .get(run.taskId) as
        | {
            goal: string;
            projectId: string;
            state: string;
            claimEpoch: number;
            attemptsUsed: number;
            maxAttempts: number;
          }
        | undefined;
      if (task === undefined || task.state !== "running" || task.claimEpoch !== run.claimEpoch) {
        throw new StoreError(
          "store.stale",
          `task of run ${completion.runId} is no longer claimed by it`,
          {
            runId: completion.runId,
          },
        );
      }
      const now = this.clock.now();
      const base = {
        taskId: run.taskId,
        goal: task.goal,
        attempt: run.attempt,
        attemptsUsed: task.attemptsUsed,
        maxAttempts: task.maxAttempts,
      };
      const eventBase = {
        aggregateType: "task",
        aggregateId: run.taskId,
        actorKind: "system" as const,
        actorId: "runtime",
        projectId: task.projectId,
        taskId: run.taskId,
        runId: completion.runId,
        ts: now,
      };

      if (completion.outcome === "succeeded") {
        this.transition("running", "completed");
        this.db
          .prepare(
            "UPDATE tasks SET result = ?, state = 'completed', phase = NULL, completed_at = ?, updated_at = ? WHERE task_id = ?",
          )
          .run(JSON.stringify(completion.result), now, now, run.taskId);
        this.db
          .prepare(
            "UPDATE runs SET status = 'completed', ended_at = ?, end_cause = 'exit' WHERE run_id = ?",
          )
          .run(now, completion.runId);
        this.appendEvent({
          ...eventBase,
          type: "task.completed",
          payload: { attempt: run.attempt },
        });
        return { ...base, taskState: "completed", retryReason: null };
      }

      const attemptsUsed = task.attemptsUsed + 1;
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', ended_at = ?, end_cause = ?, error = ? WHERE run_id = ?",
        )
        .run(
          now,
          completion.endCause,
          // The host evidence of a verification_failed attempt rides in the error (M3-D7).
          JSON.stringify({
            ...completion.error,
            ...(completion.verification === undefined
              ? {}
              : { verification: completion.verification }),
          }),
          completion.runId,
        );
      if (attemptsUsed < task.maxAttempts) {
        this.transition("running", "ready");
        this.db
          .prepare(
            "UPDATE tasks SET state = 'ready', phase = NULL, retry_reason = 'transient', attempts_used = ?, claimed_runtime_epoch = NULL, updated_at = ? WHERE task_id = ?",
          )
          .run(attemptsUsed, now, run.taskId);
        this.appendEvent({
          ...eventBase,
          type: "task.retried",
          payload: {
            attempt: run.attempt,
            attemptsUsed,
            maxAttempts: task.maxAttempts,
            code: completion.error.code,
          },
        });
        return { ...base, attemptsUsed, taskState: "ready", retryReason: "transient" };
      }
      this.transition("running", "failed");
      this.db
        .prepare(
          "UPDATE tasks SET state = 'failed', phase = NULL, attempts_used = ?, completed_at = ?, updated_at = ? WHERE task_id = ?",
        )
        .run(attemptsUsed, now, now, run.taskId);
      this.appendEvent({
        ...eventBase,
        type: "task.failed",
        payload: { attempt: run.attempt, attemptsUsed, code: completion.error.code },
      });
      return { ...base, attemptsUsed, taskState: "failed", retryReason: null };
    });
  }

  // ARCH 7.5 (M1-T7): tasks still running under another epoch lost their runtime. The attempt is orphaned:
  // its run is closed as orphaned and the task returns to ready without charging attempts_used, or fails once
  // infra_restarts would exceed maxInfraRestarts. Events carry the time of the reconciliation.
  private reconcileOrphans(epoch: number, maxInfraRestarts: number): RecoveredTask[] {
    return this.inTransaction(() => {
      this.assertActiveEpoch(epoch);
      const orphans = this.db
        .prepare(
          "SELECT task_id AS taskId, project_id AS projectId, goal, infra_restarts AS infraRestarts FROM tasks WHERE state = 'running' AND claimed_runtime_epoch <> ? ORDER BY created_seq",
        )
        .all(epoch) as unknown as OrphanRow[];
      const openRun = this.db.prepare(
        "SELECT run_id AS runId FROM runs WHERE task_id = ? AND status IN ('prepared','running','settled') ORDER BY attempt DESC LIMIT 1",
      );
      const recovered: RecoveredTask[] = [];
      const now = this.clock.now();
      for (const orphan of orphans) {
        const run = openRun.get(orphan.taskId) as { runId: string } | undefined;
        const infraRestarts = orphan.infraRestarts + 1;
        const exhausted = infraRestarts > maxInfraRestarts;
        const toState = exhausted ? "failed" : "ready";
        this.transition("running", toState);
        if (run !== undefined) {
          this.db
            .prepare(
              "UPDATE runs SET status = 'orphaned', ended_at = ?, error = ? WHERE run_id = ?",
            )
            .run(
              now,
              JSON.stringify({
                code: "orphaned",
                message: "the runtime that owned the attempt stopped without a clean exit",
              }),
              run.runId,
            );
        }
        if (exhausted) {
          this.db
            .prepare(
              "UPDATE tasks SET state = 'failed', phase = NULL, retry_reason = NULL, claimed_runtime_epoch = NULL, infra_restarts = ?, completed_at = ?, updated_at = ? WHERE task_id = ?",
            )
            .run(infraRestarts, now, now, orphan.taskId);
        } else {
          this.db
            .prepare(
              "UPDATE tasks SET state = 'ready', phase = NULL, retry_reason = 'orphaned', claimed_runtime_epoch = NULL, infra_restarts = ?, updated_at = ? WHERE task_id = ?",
            )
            .run(infraRestarts, now, orphan.taskId);
        }
        this.appendEvent({
          aggregateType: "task",
          aggregateId: orphan.taskId,
          type: "task.orphaned",
          actorKind: "system",
          actorId: `runtime:${epoch}`,
          payload: { toState, infraRestarts, maxInfraRestarts },
          projectId: orphan.projectId,
          taskId: orphan.taskId,
          runId: run?.runId,
          ts: now,
        });
        if (exhausted) {
          // No runId: the failure belongs to the task, the attempt itself was already recorded as orphaned.
          this.appendEvent({
            aggregateType: "task",
            aggregateId: orphan.taskId,
            type: "task.failed",
            actorKind: "system",
            actorId: `runtime:${epoch}`,
            payload: { reason: "infra_restarts_exhausted", infraRestarts },
            projectId: orphan.projectId,
            taskId: orphan.taskId,
            ts: now,
          });
        }
        recovered.push({
          taskId: orphan.taskId,
          goal: orphan.goal,
          runId: run?.runId ?? null,
          outcome: exhausted ? "failed" : "ready",
          infraRestarts,
          maxInfraRestarts,
        });
      }
      return recovered;
    });
  }

  // Counts for `haril metrics`. Each number is also derivable from the events and runs rows alone (ACE-11).
  private metricsSnapshot(projectId?: string): MetricsSnapshot {
    const scope = projectId ?? null;
    const tasksByState: Record<TaskState, number> = {
      pending: 0,
      ready: 0,
      running: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    const stateRows = this.db
      .prepare(
        "SELECT state, COUNT(*) AS n FROM tasks WHERE (? IS NULL OR project_id = ?) GROUP BY state",
      )
      .all(scope, scope) as Array<{ state: TaskState; n: number }>;
    for (const row of stateRows) tasksByState[row.state] = row.n;

    const statusRows = this.db
      .prepare(
        "SELECT status, COUNT(*) AS n FROM runs WHERE (? IS NULL OR project_id = ?) GROUP BY status",
      )
      .all(scope, scope) as Array<{ status: string; n: number }>;
    const runsByStatus: Record<string, number> = {};
    for (const row of statusRows) runsByStatus[row.status] = row.n;

    const countEvents = (type: string): number =>
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events WHERE type = ? AND (? IS NULL OR project_id = ?)",
          )
          .get(type, scope, scope) as { n: number }
      ).n;

    const closed = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(ended_at - started_at), 0) AS totalMs FROM runs WHERE ended_at IS NOT NULL AND (? IS NULL OR project_id = ?)",
      )
      .get(scope, scope) as { n: number; totalMs: number };

    const agentRows = this.db
      .prepare(
        `SELECT agent_id AS agentRef, COUNT(*) AS runs,
           SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed,
           SUM(status = 'orphaned') AS orphaned,
           COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 0 ELSE ended_at - started_at END), 0) AS totalMs
         FROM runs WHERE (? IS NULL OR project_id = ?) GROUP BY agent_id ORDER BY agent_id`,
      )
      .all(scope, scope) as unknown as AgentMetrics[];

    const completedTotal = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE state = 'completed' AND (? IS NULL OR project_id = ?)",
        )
        .get(scope, scope) as { n: number }
    ).n;
    const verifiedCompletions = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE state = 'completed' AND json_extract(result, '$.verification.verified') = 1 AND (? IS NULL OR project_id = ?)",
        )
        .get(scope, scope) as { n: number }
    ).n;

    return {
      tasksByState,
      runsByStatus,
      verifiedCompletions,
      unverifiedCompletions: completedTotal - verifiedCompletions,
      retries: countEvents("task.retried"),
      orphanedRecoveries: countEvents("task.orphaned"),
      closedRuns: closed.n,
      durationTotalMs: closed.totalMs,
      perAgent: agentRows.map((row) => ({
        agentRef: row.agentRef,
        runs: Number(row.runs),
        completed: Number(row.completed),
        failed: Number(row.failed),
        orphaned: Number(row.orphaned),
        totalMs: Number(row.totalMs),
      })),
    };
  }

  // Every task state change passes the Core transition table, injected through `rules`.
  private transition(from: TaskRecord["state"], to: TaskRecord["state"]): void {
    if (!this.rules.canTransition(from, to)) {
      throw new StoreError("store.stale", `illegal task transition ${from} -> ${to}`, { from, to });
    }
  }

  private appendEvent(input: AppendEventInput): EventRecord {
    const eventId = this.ids.next();
    const result = this.db
      .prepare(
        "INSERT INTO events (event_id, ts, aggregate_type, aggregate_id, type, schema_version, actor_kind, actor_id, correlation_id, causation_id, audit, payload, project_id, task_id, run_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        eventId,
        input.ts ?? this.clock.now(),
        input.aggregateType,
        input.aggregateId,
        input.type,
        input.schemaVersion ?? 1,
        input.actorKind,
        input.actorId,
        input.correlationId ?? null,
        input.causationId ?? null,
        input.audit === true ? 1 : 0,
        JSON.stringify(input.payload),
        input.projectId ?? null,
        input.taskId ?? null,
        input.runId ?? null,
        input.agentId ?? null,
      );
    const row = this.db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq = ?`)
      .get(Number(result.lastInsertRowid)) as unknown as EventRow;
    return toEventRecord(row);
  }

  // Newest first in SQL so that `limit` keeps the tail; the result is returned oldest first.
  private listEvents(filter?: EventFilter): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events
         WHERE (? IS NULL OR aggregate_id = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR task_id = ?)
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        filter?.aggregateId ?? null,
        filter?.aggregateId ?? null,
        filter?.projectId ?? null,
        filter?.projectId ?? null,
        filter?.taskId ?? null,
        filter?.taskId ?? null,
        filter?.limit ?? -1,
      ) as unknown as EventRow[];
    return rows.map(toEventRecord).reverse();
  }

  private inTransaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

// A dependency that can never complete: failed, cancelled, or blocked because of an earlier failure.
function isDependencyFailure(dependency: { state: string; blockReason: string | null }): boolean {
  return (
    dependency.state === "failed" ||
    dependency.state === "cancelled" ||
    (dependency.state === "blocked" && dependency.blockReason === "dep_failed")
  );
}

function parseCommand(row: CommandRow): CommandRecord {
  return { ...row, args: JSON.parse(row.args) as Record<string, unknown> };
}

// Validates the task.create arguments written by `haril task add`; a string is the rejection reason.
function parseTaskCreateArgs(
  args: Readonly<Record<string, unknown>>,
  checkAcceptance: StoreRules["checkAcceptance"],
):
  | {
      goal: string;
      dependsOn: string[];
      agent: string;
      model: string | null;
      maxAttempts: number;
      timeoutMs: number;
      maxTokens: number;
      acceptance: ClaimedTask["acceptance"];
    }
  | string {
  const goal = args.goal;
  if (typeof goal !== "string" || goal.trim() === "") return "task goal must not be empty";
  const dependsOn = args.dependsOn;
  if (!Array.isArray(dependsOn) || !dependsOn.every((id) => typeof id === "string")) {
    return "dependsOn must be a list of task ids";
  }
  const agent = args.agent;
  if (typeof agent !== "string" || agent.trim() === "") return "agent reference must not be empty";
  // Optional (M2-T6): absent or null means no model; a token ceiling of 0 means none was set.
  const model = args.model ?? null;
  if (model !== null && (typeof model !== "string" || model.trim() === "")) {
    return "model must be a non-empty model id";
  }
  const maxTokens = args.maxTokens ?? 0;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 0) {
    return "maxTokens must be a whole number of at least 0";
  }
  const maxAttempts = args.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || (maxAttempts as number) < 1) {
    return "maxAttempts must be a whole number of at least 1";
  }
  const timeoutMs = args.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1) {
    return "timeoutMs must be a whole number of at least 1";
  }
  // Optional (M3-D7): absent means no acceptance checks; the rule names the first problem.
  const acceptance = checkAcceptance(args.acceptance ?? []);
  if (!acceptance.ok) return acceptance.reason;
  return {
    goal,
    dependsOn: dependsOn as string[],
    agent,
    model: model as string | null,
    maxAttempts: maxAttempts as number,
    timeoutMs: timeoutMs as number,
    maxTokens: maxTokens as number,
    acceptance: acceptance.acceptance,
  };
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    seq: row.seq,
    eventId: row.eventId,
    ts: row.ts,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    type: row.type,
    schemaVersion: row.schemaVersion,
    actorKind: row.actorKind,
    actorId: row.actorId,
    audit: row.audit === 1,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    correlationId: row.correlationId ?? undefined,
    causationId: row.causationId ?? undefined,
    projectId: row.projectId ?? undefined,
    taskId: row.taskId ?? undefined,
    runId: row.runId ?? undefined,
    agentId: row.agentId ?? undefined,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
