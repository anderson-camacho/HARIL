import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventInput,
  Clock,
  EventRecord,
  Ids,
  JsonObject,
  MemoryOutboxCounts,
  MemoryRefRecord,
  MemoryStatus,
  MemoryStorePort,
  OutboxRow,
  PromotedTask,
  RuntimeLeaseSummary,
  StoreRules,
} from "@haril/core/ports";
import {
  BUSY_TIMEOUT_MS,
  DB_FILE_NAME,
  isForeignApplication,
  readApplicationId,
} from "./connection.js";
import { foreignApplicationError, StoreError } from "./errors.js";
import { readLeaseSummary } from "./lease.js";

// The memory module of the Store (MC-T4; task-store.md 4.10, memory.md 4.4): memory_outbox and its delivery protocol,
// memory_refs, the provider state in the meta keys memory.*, and the tasks that wait for memory. Every write runs in the
// transaction the store hands in and is fenced by the runtime epoch. The Core builds the payloads; this module only
// stores them, and never reads a recalled memory's content.

interface MemoryFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly rules: Pick<StoreRules, "canTransition" | "canonicalJson">;
  readonly transaction: <T>(work: () => T) => T;
  readonly appendEvent: (input: AppendEventInput) => EventRecord;
  readonly assertActiveEpoch: (epoch: number) => void;
}

const OUTBOX_COLUMNS =
  "outbox_seq AS outboxSeq, operation_id AS operationId, project_id AS projectId, op, payload, schema_version AS schemaVersion, session_id AS sessionId, status, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError, receipt, delivered_provider AS deliveredProvider, enqueued_at AS enqueuedAt, delivered_at AS deliveredAt";

const REF_COLUMNS =
  "ref_id AS refId, project_id AS projectId, task_id AS taskId, provider, provider_ref AS providerRef, sync_id AS syncId, topic_key AS topicKey, direction, kind, origin, content_sha256 AS contentSha256, operation_id AS operationId, created_at AS createdAt";

// The JSON columns are text in the row and parsed on read.
interface OutboxDbRow extends Omit<OutboxRow, "payload" | "receipt"> {
  readonly payload: string;
  readonly receipt: string | null;
}

// A ready task whose requires[] has the memory capability (ARCH 5.3: requiresMemory is not a column of Task v1).
const NEEDS_MEMORY = "EXISTS (SELECT 1 FROM json_each(tasks.requires) WHERE value = 'memory')";

const META = {
  provider: "memory.provider",
  persistent: "memory.persistent",
  lastState: "memory.last_state",
  lastStateAt: "memory.last_state_at",
  lastError: "memory.last_error",
} as const;

const STATES = new Set(["active", "degraded", "blocked_by_policy"]);

export function createMemoryFacet(options: MemoryFacetOptions): MemoryStorePort {
  const { db, clock, rules, transaction, appendEvent, assertActiveEpoch } = options;

  const findRow = (operationId: string): OutboxRow | undefined => {
    const row = db
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM memory_outbox WHERE operation_id = ?`)
      .get(operationId) as unknown as OutboxDbRow | undefined;
    return row === undefined ? undefined : toOutboxRow(row);
  };

  // The row a write closes: sending and claimed by this epoch, or store.stale.
  const claimedRow = (epoch: number, operationId: string): OutboxRow => {
    const found = db
      .prepare(
        `SELECT ${OUTBOX_COLUMNS}, claimed_runtime_epoch AS claimedBy FROM memory_outbox WHERE operation_id = ?`,
      )
      .get(operationId) as unknown as (OutboxDbRow & { claimedBy: number | null }) | undefined;
    if (found?.status !== "sending" || found.claimedBy !== epoch) {
      throw new StoreError(
        "store.stale",
        `outbox row "${operationId}" is not sending under runtime epoch ${epoch}`,
        { operationId, status: found?.status ?? null },
      );
    }
    const { claimedBy: _claimedBy, ...row } = found;
    return toOutboxRow(row);
  };

  const writeMeta = (key: string, value: string, now: number): void => {
    db.prepare(
      "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, now);
  };

  const memoryEvent = (
    epoch: number,
    aggregateId: string,
    type: string,
    payload: JsonObject,
    projectId?: string,
  ): void => {
    appendEvent({
      aggregateType: "memory",
      aggregateId,
      type,
      actorKind: "system",
      actorId: `runtime:${epoch}`,
      payload,
      ...(projectId === undefined ? {} : { projectId }),
    });
  };

  // Moves the matching tasks from one state to the other, with their events; a read first, since a degraded runtime
  // asks every turn and almost every turn finds nothing to move.
  const moveTasks = (
    epoch: number,
    where: string,
    from: "ready" | "blocked",
    to: "ready" | "blocked",
  ): PromotedTask[] => {
    const select = db.prepare(
      `SELECT task_id AS taskId, goal, project_id AS projectId FROM tasks WHERE ${where} ORDER BY created_seq`,
    );
    if (select.all().length === 0) return [];
    return transaction(() => {
      assertActiveEpoch(epoch);
      if (!rules.canTransition(from, to)) {
        throw new StoreError("store.stale", `illegal task transition ${from} -> ${to}`, {
          from,
          to,
        });
      }
      const now = clock.now();
      const tasks = select.all() as unknown as Array<PromotedTask & { projectId: string }>;
      for (const task of tasks) {
        db.prepare(
          "UPDATE tasks SET state = ?, block_reason = ?, updated_at = ? WHERE task_id = ? AND state = ?",
        ).run(to, to === "blocked" ? "memory_unavailable" : null, now, task.taskId, from);
        const scope = { projectId: task.projectId, taskId: task.taskId };
        const event = {
          aggregateType: "task",
          aggregateId: task.taskId,
          actorKind: "system" as const,
        };
        if (to === "blocked") {
          appendEvent({
            ...event,
            ...scope,
            type: "task.blocked",
            actorId: `runtime:${epoch}`,
            payload: { reason: "memory_unavailable" },
          });
        } else {
          appendEvent({
            ...event,
            ...scope,
            type: "task.unblocked",
            actorId: `runtime:${epoch}`,
            payload: { reason: "memory_unavailable", to: "ready" },
          });
          appendEvent({
            ...event,
            ...scope,
            type: "task.ready",
            actorId: `runtime:${epoch}`,
            payload: {},
          });
        }
      }
      return tasks.map((task) => ({ taskId: task.taskId, goal: task.goal }));
    });
  };

  return {
    enqueue(epoch, rows) {
      return transaction(() => {
        assertActiveEpoch(epoch);
        const now = clock.now();
        let enqueued = 0;
        let deduped = 0;
        for (const row of rows) {
          const payload = rules.canonicalJson(row.payload);
          const existing = db
            .prepare("SELECT payload FROM memory_outbox WHERE operation_id = ?")
            .get(row.operationId) as { payload: string } | undefined;
          if (existing !== undefined) {
            if (existing.payload !== payload) {
              throw new StoreError(
                "store.conflict",
                `operation id "${row.operationId}" was already queued with another payload`,
                { operationId: row.operationId },
              );
            }
            deduped += 1;
            continue;
          }
          if (row.source !== undefined) {
            const mirrored = db
              .prepare(
                "SELECT 1 AS found FROM memory_outbox WHERE source_table = ? AND source_id = ?",
              )
              .get(row.source.table, row.source.id);
            if (mirrored !== undefined) {
              deduped += 1;
              continue;
            }
          }
          db.prepare(
            "INSERT INTO memory_outbox (operation_id, project_id, op, payload, schema_version, source_table, source_id, session_id, status, attempts, next_attempt_at, enqueued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)",
          ).run(
            row.operationId,
            row.projectId,
            row.op,
            payload,
            row.schemaVersion,
            row.source?.table ?? null,
            row.source?.id ?? null,
            row.sessionId,
            now,
            now,
          );
          const kind = kindOf(row.payload);
          memoryEvent(
            epoch,
            row.operationId,
            "memory.outbox.enqueued",
            { operationId: row.operationId, op: row.op, ...(kind === undefined ? {} : { kind }) },
            row.projectId,
          );
          enqueued += 1;
        }
        return { enqueued, deduped };
      });
    },

    claimDue(epoch, limit) {
      return transaction(() => {
        assertActiveEpoch(epoch);
        // A summarize ends its provider session, so it waits while another row of the session is not terminal; a
        // later summarize of the same session does not hold an earlier one back.
        const due = db
          .prepare(
            `SELECT ${OUTBOX_COLUMNS} FROM memory_outbox o WHERE o.status = 'pending' AND o.next_attempt_at <= ? AND (o.op <> 'summarize' OR o.session_id IS NULL OR NOT EXISTS (SELECT 1 FROM memory_outbox s WHERE s.session_id = o.session_id AND s.outbox_seq <> o.outbox_seq AND s.status IN ('pending','sending','needs_review') AND NOT (s.op = 'summarize' AND s.outbox_seq > o.outbox_seq))) ORDER BY o.outbox_seq LIMIT ?`,
          )
          .all(clock.now(), limit) as unknown as OutboxDbRow[];
        const claim = db.prepare(
          "UPDATE memory_outbox SET status = 'sending', attempts = attempts + 1, claimed_runtime_epoch = ? WHERE outbox_seq = ? AND status = 'pending'",
        );
        return due.map((row) => {
          claim.run(epoch, row.outboxSeq);
          return { ...toOutboxRow(row), status: "sending" as const, attempts: row.attempts + 1 };
        });
      });
    },

    markDelivered(epoch, input) {
      transaction(() => {
        assertActiveEpoch(epoch);
        const row = claimedRow(epoch, input.operationId);
        const now = clock.now();
        db.prepare(
          "UPDATE memory_outbox SET status = 'delivered', receipt = ?, delivered_provider = ?, delivered_at = ? WHERE operation_id = ?",
        ).run(JSON.stringify(input.receipt), input.provider, now, input.operationId);
        // One pointer per provider record: a redelivery that answers the same record adds none (MEM-04). The task is
        // kept only when it exists.
        const insertRef = db.prepare(
          "INSERT INTO memory_refs (ref_id, project_id, task_id, provider, provider_ref, sync_id, topic_key, direction, kind, origin, content_sha256, operation_id, created_at) VALUES (?, ?, (SELECT task_id FROM tasks WHERE task_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (provider, provider_ref) DO NOTHING",
        );
        for (const ref of input.refs) {
          insertRef.run(
            options.ids.next(),
            ref.projectId,
            ref.taskId ?? null,
            ref.provider,
            ref.providerRef,
            ref.syncId ?? null,
            ref.topicKey ?? null,
            ref.direction,
            ref.kind,
            ref.origin,
            ref.contentSha256 ?? null,
            input.operationId,
            now,
          );
        }
        memoryEvent(epoch, input.operationId, input.event.type, input.event.payload, row.projectId);
      });
    },

    markFailed(epoch, input) {
      transaction(() => {
        assertActiveEpoch(epoch);
        const row = claimedRow(epoch, input.operationId);
        db.prepare(
          "UPDATE memory_outbox SET status = ?, last_error = ?, next_attempt_at = ? WHERE operation_id = ?",
        ).run(
          input.to,
          input.code,
          input.to === "pending" ? (input.nextAttemptAt ?? clock.now()) : row.nextAttemptAt,
          input.operationId,
        );
        const base = { operationId: input.operationId, op: row.op, code: input.code };
        if (input.to === "needs_review") {
          memoryEvent(epoch, input.operationId, "memory.outbox.needs_review", base, row.projectId);
        } else if (input.to === "dead") {
          memoryEvent(
            epoch,
            input.operationId,
            "memory.outbox.dead",
            { ...base, attempts: row.attempts },
            row.projectId,
          );
        }
      });
    },

    requeueStale(epoch) {
      return transaction(() => {
        assertActiveEpoch(epoch);
        const result = db
          .prepare(
            "UPDATE memory_outbox SET status = 'pending' WHERE status = 'sending' AND claimed_runtime_epoch < ?",
          )
          .run(epoch);
        return Number(result.changes);
      });
    },

    setState(epoch, input) {
      return transaction(() => {
        assertActiveEpoch(epoch);
        const before = memoryStatusOf(db);
        const now = clock.now();
        const changed = before.lastState !== input.state;
        if (before.provider !== input.provider) writeMeta(META.provider, input.provider, now);
        if (before.persistent !== input.persistent) {
          writeMeta(META.persistent, String(input.persistent), now);
        }
        if (!changed) return false;
        writeMeta(META.lastState, input.state, now);
        writeMeta(META.lastStateAt, String(now), now);
        const outboxDepth = depthOf(before.outbox);
        if (input.state !== "active") {
          if (input.code !== undefined) {
            writeMeta(META.lastError, JSON.stringify({ code: input.code, at: now }), now);
          }
          memoryEvent(epoch, input.provider, "memory.degraded", {
            provider: input.provider,
            state: input.state,
            ...(input.code === undefined ? {} : { code: input.code }),
            since: now,
            outboxDepth,
          });
        } else if (before.lastState !== null) {
          memoryEvent(epoch, input.provider, "memory.recovered", {
            provider: input.provider,
            downMs: now - (before.lastStateAt ?? now),
            outboxDepth,
          });
        }
        return true;
      });
    },

    blockTasks: (epoch) =>
      moveTasks(epoch, `state = 'ready' AND ${NEEDS_MEMORY}`, "ready", "blocked"),

    releaseTasks: (epoch) =>
      moveTasks(
        epoch,
        "state = 'blocked' AND block_reason = 'memory_unavailable'",
        "blocked",
        "ready",
      ),

    nextDueAt() {
      const row = db
        .prepare("SELECT MIN(next_attempt_at) AS due FROM memory_outbox WHERE status = 'pending'")
        .get() as { due: number | null };
      return row.due;
    },

    status: () => memoryStatusOf(db),

    get: findRow,

    refs(projectId) {
      const rows = db
        .prepare(
          `SELECT ${REF_COLUMNS} FROM memory_refs WHERE (? IS NULL OR project_id = ?) ORDER BY created_at, rowid`,
        )
        .all(projectId ?? null, projectId ?? null) as unknown as Array<Record<string, unknown>>;
      return rows.map(toRefRecord);
    },
  };
}

// What the CLI reads without a runtime (haril memory status, RF-132): the status and the lease, in one read
// transaction, without writing or migrating haril.db. Undefined when there is no HARIL store: no file, or one without
// the HARIL schema (an empty file). A database of another application is the gate's refusal. A database from before
// migration 0006 has no outbox and nothing recorded.
export interface MemoryStatusReading {
  readonly status: MemoryStatus;
  readonly lease: RuntimeLeaseSummary;
}

export function readMemoryStatus(dataDir: string): MemoryStatusReading | undefined {
  const path = join(dataDir, DB_FILE_NAME);
  if (!existsSync(path)) return undefined;
  // The data dir is left as it was found (MC-T4 fix). While a runtime holds the store, or after one crashed, its -wal
  // and -shm exist: a read-only connection reads through them and leaves them. Without them, a read-only connection
  // would create both and leave them behind, so the read goes through a connection that cannot write (query_only);
  // as the last one, its close removes the files its open created, like the close of the store haril status opens.
  const sideFiles = existsSync(`${path}-wal`) || existsSync(`${path}-shm`);
  const db = new DatabaseSync(path, sideFiles ? { readOnly: true } : {});
  try {
    if (!sideFiles) db.exec("PRAGMA query_only = ON");
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const applicationId = readApplicationId(db);
    if (isForeignApplication(applicationId)) throw foreignApplicationError(applicationId);
    db.exec("BEGIN");
    try {
      if (!hasTable(db, "meta")) return undefined;
      return { status: memoryStatusOf(db), lease: readLeaseSummary(db) };
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

// The meta keys memory.* (null before a runtime wrote them; a value this release does not know reads as null) and the
// outbox counts.
function memoryStatusOf(db: DatabaseSync): MemoryStatus {
  const meta = new Map(
    (
      db.prepare("SELECT key, value FROM meta WHERE key LIKE 'memory.%'").all() as Array<{
        key: string;
        value: string;
      }>
    ).map((row) => [row.key, row.value]),
  );
  const state = meta.get(META.lastState);
  const persistent = meta.get(META.persistent);
  const stateAt = Number(meta.get(META.lastStateAt));
  return {
    provider: meta.get(META.provider) ?? null,
    persistent: persistent === "true" ? true : persistent === "false" ? false : null,
    lastState:
      state !== undefined && STATES.has(state) ? (state as MemoryStatus["lastState"]) : null,
    lastStateAt: state !== undefined && Number.isSafeInteger(stateAt) ? stateAt : null,
    lastError: parseLastError(meta.get(META.lastError)),
    outbox: outboxCounts(db),
  };
}

function outboxCounts(db: DatabaseSync): MemoryOutboxCounts {
  const empty = {
    pending: 0,
    sending: 0,
    needsReview: 0,
    dead: 0,
    delivered: 0,
    oldestPendingAt: null,
  };
  if (!hasTable(db, "memory_outbox")) return empty;
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) AS n, MIN(enqueued_at) AS oldest FROM memory_outbox GROUP BY status",
    )
    .all() as Array<{ status: string; n: number; oldest: number }>;
  const count = (status: string): number =>
    Number(rows.find((row) => row.status === status)?.n ?? 0);
  return {
    pending: count("pending"),
    sending: count("sending"),
    needsReview: count("needs_review"),
    dead: count("dead"),
    delivered: count("delivered"),
    oldestPendingAt: rows.find((row) => row.status === "pending")?.oldest ?? null,
  };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function depthOf(outbox: MemoryOutboxCounts): number {
  return outbox.pending + outbox.sending + outbox.needsReview;
}

function parseLastError(text: string | undefined): MemoryStatus["lastError"] {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as { code?: unknown; at?: unknown };
    return typeof value.code === "string" && Number.isSafeInteger(value.at)
      ? { code: value.code, at: value.at as number }
      : null;
  } catch {
    return null;
  }
}

function toOutboxRow(row: OutboxDbRow): OutboxRow {
  return {
    ...row,
    payload: JSON.parse(row.payload) as JsonObject,
    receipt: row.receipt === null ? null : (JSON.parse(row.receipt) as JsonObject),
  };
}

// The MemoryKind of a write, for memory.outbox.enqueued.
function kindOf(payload: JsonObject): string | undefined {
  const scope = payload.scope as { kind?: unknown } | undefined;
  return typeof scope?.kind === "string" ? scope.kind : undefined;
}

// The optional columns of a pointer are left out when null, as MemoryRefInsert has them.
const OPTIONAL_REF_FIELDS = new Set(["taskId", "syncId", "topicKey", "contentSha256"]);

function toRefRecord(row: Record<string, unknown>): MemoryRefRecord {
  return Object.fromEntries(
    Object.entries(row).filter(([key, value]) => value !== null || !OPTIONAL_REF_FIELDS.has(key)),
  ) as unknown as MemoryRefRecord;
}
