import type { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  Clock,
  CommandRecord,
  EnqueueCommandInput,
  EnqueueResult,
  EventFilter,
  EventRecord,
  Ids,
  ProjectRecord,
  RegisterProjectInput,
  RuntimeLeaseSummary,
  Store,
  StoreGate,
  StoreInfo,
  TaskFilter,
  TaskRecord,
} from "@haril/core/ports";
import { readPragmas, readUserVersion } from "./connection.js";
import { StoreError } from "./errors.js";

// Implementation of the Store port over one node:sqlite connection. Writes run in BEGIN IMMEDIATE.

interface StoreOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly storeId: string;
  readonly sqliteVersion: string;
  readonly gates: readonly StoreGate[];
}

const PROJECT_COLUMNS =
  "project_id AS projectId, slug, name, root_path AS rootPath, manifest_sha256 AS manifestSha256, created_at AS createdAt";

const TASK_COLUMNS =
  "task_id AS taskId, project_id AS projectId, goal, state, agent_ref AS agentRef, created_at AS createdAt";

const LEASE_COLUMNS =
  "instance_id AS instanceId, pid, started_at AS startedAt, heartbeat_at AS heartbeatAt, expires_at AS expiresAt, status, node_version AS nodeVersion, sqlite_version AS sqliteVersion";

const COMMAND_COLUMNS =
  "command_id AS commandId, project_id AS projectId, type, args, idempotency_key AS idempotencyKey, request_hash AS requestHash, enqueued_at AS enqueuedAt";

const EVENT_COLUMNS =
  "seq, event_id AS eventId, ts, aggregate_type AS aggregateType, aggregate_id AS aggregateId, type, schema_version AS schemaVersion, actor_kind AS actorKind, actor_id AS actorId, correlation_id AS correlationId, causation_id AS causationId, audit, payload, project_id AS projectId, task_id AS taskId, run_id AS runId, agent_id AS agentId";

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

type LeaseRow = Extract<RuntimeLeaseSummary, { status: "active" | "released" | "lost" }>;

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly storeId: string;
  private readonly sqliteVersion: string;
  private readonly gates: readonly StoreGate[];

  readonly projects: Store["projects"];
  readonly commands: Store["commands"];
  readonly tasks: Store["tasks"];
  readonly runtime: Store["runtime"];
  readonly events: Store["events"];

  constructor(options: StoreOptions) {
    this.db = options.db;
    this.clock = options.clock;
    this.ids = options.ids;
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
    };
    this.tasks = {
      list: (filter) => this.listTasks(filter),
    };
    this.runtime = {
      leaseSummary: () => this.leaseSummary(),
    };
    this.events = {
      append: (input) => this.appendEvent(input),
      list: (filter) => this.listEvents(filter),
    };
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
      .all() as unknown as Array<Omit<CommandRecord, "args"> & { args: string }>;
    return rows.map((row) => ({ ...row, args: JSON.parse(row.args) as Record<string, unknown> }));
  }

  private appendEvent(input: AppendEventInput): EventRecord {
    const eventId = this.ids.next();
    const result = this.db
      .prepare(
        "INSERT INTO events (event_id, ts, aggregate_type, aggregate_id, type, schema_version, actor_kind, actor_id, correlation_id, causation_id, audit, payload, project_id, task_id, run_id, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        eventId,
        this.clock.now(),
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

  private listEvents(filter?: EventFilter): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE (? IS NULL OR aggregate_id = ?) ORDER BY seq`,
      )
      .all(filter?.aggregateId ?? null, filter?.aggregateId ?? null) as unknown as EventRow[];
    return rows.map(toEventRecord);
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
