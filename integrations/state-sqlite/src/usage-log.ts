import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  AppendOrderInput,
  AppendResult,
  AppendUsageInput,
  ChainReport,
  Clock,
  Ids,
  ModelStatRow,
  OrderFilter,
  OrderRecord,
  StoreRules,
  UsageFilter,
  UsageGroupBy,
  UsageLogPort,
  UsageRecord,
  UsageSummaryRow,
  UsageVerification,
} from "@haril/core/ports";
import { StoreError } from "./errors.js";

// The orders and usage logs (docs/modos-y-delegacion.md 4.5): append-only tables (triggers refuse UPDATE and DELETE)
// with one hash chain per table. Each append runs in BEGIN IMMEDIATE: it reads the newest row, numbers the new one
// seq + 1, hashes sha256(prev_hash + canonicalJson(row without hash)) over the exact column values it stores, and
// records the new head (seq and hash) in meta, all in one transaction. The first append of a chain also leaves a
// "started" marker in meta that no code removes, so a chain whose rows and head were both deleted is still found.
// verify() reads both chains and their heads inside one read transaction (a consistent snapshot, so an append from
// another connection in the middle never looks like tampering), recomputes every hash in seq order and compares the
// newest row with the recorded head, so a changed row, a deleted row and deleted newest rows are all found. A row
// forged with recomputed hashes, or newest rows deleted together with a consistent rewrite of the head's seq and hash,
// is not detectable this way (anything stored in the database can be rewritten too); the chain proves the log was not
// edited by hand without care, which is the case of 4.5. P14: no lease is needed.

interface UsageLogFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly rules: Pick<StoreRules, "canonicalJson">;
  readonly transaction: <T>(work: () => T) => T;
}

const GENESIS = "0".repeat(64);
const PREVIEW_MAX = 200;

// Column order of each table, hash excluded. The hash covers exactly these columns, so a later migration that adds a
// column keeps old rows verifiable.
const ORDER_COLUMNS = [
  "seq",
  "order_id",
  "ts",
  "session_id",
  "mode",
  "source",
  "workflow_id",
  "project_id",
  "text_sha256",
  "text_chars",
  "preview",
  "idempotency_key",
  "prev_hash",
] as const;

const USAGE_COLUMNS = [
  "seq",
  "usage_id",
  "ts",
  "order_id",
  "kind",
  "session_id",
  "project_id",
  "workflow_id",
  "task_id",
  "run_id",
  "thread_id",
  "layer",
  "role",
  "mode",
  "provider",
  "model_requested",
  "model_served",
  "model_pinned",
  "tokens_in",
  "tokens_out",
  "tokens_cached",
  "tokens_reasoning",
  "cost_micros",
  "unreconciled",
  "started_at",
  "ended_at",
  "duration_ms",
  "difficulty_est",
  "difficulty_reason",
  "outcome",
  "audit_verdict",
  "retries",
  "simulated",
  "idempotency_key",
  "prev_hash",
] as const;

type Table = "orders" | "usage_log";
type Row = Record<string, SQLInputValue>;

interface Chain {
  readonly table: Table;
  readonly idColumn: string;
  readonly columns: readonly string[];
  readonly headKey: string;
  // Set by the first append and never removed: the chain has started, so it must have a head.
  readonly startedKey: string;
}

const ORDERS: Chain = {
  table: "orders",
  idColumn: "order_id",
  columns: ORDER_COLUMNS,
  headKey: "orders.head",
  startedKey: "orders.started",
};
const USAGE: Chain = {
  table: "usage_log",
  idColumn: "usage_id",
  columns: USAGE_COLUMNS,
  headKey: "usage_log.head",
  startedKey: "usage_log.started",
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function camel(column: string): string {
  return column.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase());
}

const flag = (value: boolean | undefined): number => (value === true ? 1 : 0);
const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

function toOrder(row: Row): OrderRecord {
  const out: Record<string, unknown> = {};
  for (const column of [...ORDER_COLUMNS, "hash"]) out[camel(column)] = row[column] ?? null;
  return out as unknown as OrderRecord;
}

function toUsage(row: Row): UsageRecord {
  const out: Record<string, unknown> = {};
  for (const column of [...USAGE_COLUMNS, "hash"]) out[camel(column)] = row[column] ?? null;
  out.modelPinned = row.model_pinned === 1;
  out.unreconciled = row.unreconciled === 1;
  out.simulated = row.simulated === 1;
  return out as unknown as UsageRecord;
}

// One filter clause per given field, in a fixed order, so the SQL text stays small and the values bind positionally.
function whereOf(clauses: readonly [string, SQLInputValue | undefined][]): {
  sql: string;
  values: SQLInputValue[];
} {
  const used = clauses.filter(([, value]) => value !== undefined);
  return {
    sql: used.length === 0 ? "" : ` WHERE ${used.map(([clause]) => clause).join(" AND ")}`,
    values: used.map(([, value]) => value as SQLInputValue),
  };
}

function usageWhere(filter: UsageFilter | undefined, alias = ""): ReturnType<typeof whereOf> {
  const p = alias === "" ? "" : `${alias}.`;
  return whereOf([
    [`${p}ts >= ?`, filter?.from],
    [`${p}ts < ?`, filter?.to],
    [`${p}kind = ?`, filter?.kind],
    [`COALESCE(${p}model_served, ${p}model_requested) = ?`, filter?.model],
    [`${p}workflow_id = ?`, filter?.workflowId],
    [`${p}layer = ?`, filter?.layer],
    [`${p}mode = ?`, filter?.mode],
    [`${p}difficulty_est = ?`, filter?.difficulty],
    [`${p}simulated = ?`, filter?.simulated === undefined ? undefined : filter.simulated ? 1 : 0],
  ]);
}

const GROUP_KEYS: Record<UsageGroupBy, string> = {
  day: "strftime('%Y-%m-%d', u.ts / 1000, 'unixepoch')",
  model: "COALESCE(u.model_served, u.model_requested)",
  layer: "CAST(u.layer AS TEXT)",
  difficulty: "u.difficulty_est",
  workflow: "u.workflow_id",
  mode: "u.mode",
  role: "u.role",
};

export function createUsageLogFacet(options: UsageLogFacetOptions): UsageLogPort {
  const { db, clock, ids, rules, transaction } = options;

  const head = (chain: Chain): { seq: number; hash: string } => {
    const row = db
      .prepare(`SELECT seq, hash FROM ${chain.table} ORDER BY seq DESC LIMIT 1`)
      .get() as { seq: number; hash: string } | undefined;
    return row ?? { seq: 0, hash: GENESIS };
  };

  const hashOf = (chain: Chain, row: Row): string => {
    const content: Record<string, unknown> = {};
    for (const column of chain.columns) content[column] = row[column] ?? null;
    return sha256(`${String(row.prev_hash)}${rules.canonicalJson(content)}`);
  };

  // Inserts one row at the end of its chain; the caller runs it inside a transaction.
  const append = (chain: Chain, values: Row): Row => {
    const last = head(chain);
    const row: Row = { ...values, seq: last.seq + 1, ts: clock.now(), prev_hash: last.hash };
    row.hash = hashOf(chain, row);
    const columns = [...chain.columns, "hash"];
    try {
      db.prepare(
        `INSERT INTO ${chain.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column] ?? null));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/FOREIGN KEY/i.test(message)) {
        throw new StoreError(
          "store.not_found",
          `${chain.table} row refused: unknown order "${String(row.order_id)}"`,
          {
            orderId: row.order_id,
          },
        );
      }
      throw new StoreError("store.conflict", `${chain.table} row refused: ${message}`, {});
    }
    db.prepare(
      "INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(chain.headKey, JSON.stringify({ seq: row.seq, hash: row.hash }), clock.now());
    // A chain that already had rows before the marker existed gets it on its next append.
    db.prepare("INSERT OR IGNORE INTO meta (key, value, updated_at) VALUES (?, ?, ?)").run(
      chain.startedKey,
      JSON.stringify({ seq: row.seq, at: row.ts }),
      clock.now(),
    );
    return row;
  };

  // Runs reads in one read transaction, so they all see the same snapshot of the database. Inside a transaction the
  // caller already opened, they join it.
  const snapshot = <T>(work: () => T): T => {
    if (db.isTransaction) return work();
    db.exec("BEGIN");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };

  const metaValue = (key: string): string | undefined =>
    (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)
      ?.value;

  const byKey = (chain: Chain, key: string | null | undefined): Row | undefined => {
    if (key === null || key === undefined) return undefined;
    return db.prepare(`SELECT * FROM ${chain.table} WHERE idempotency_key = ?`).get(key) as
      | Row
      | undefined;
  };

  const verifyChain = (chain: Chain): ChainReport => {
    const rows = db.prepare(`SELECT * FROM ${chain.table} ORDER BY seq`).all() as Row[];
    const broken = (seq: number, id: SQLInputValue | null, reason: ChainBreak): ChainReport => ({
      table: chain.table,
      rows: rows.length,
      ok: false,
      firstBroken: { seq, id: typeof id === "string" ? id : null, reason },
    });
    let previous = GENESIS;
    let expectedSeq = 1;
    for (const row of rows) {
      const seq = Number(row.seq);
      const id = row[chain.idColumn] ?? null;
      if (seq !== expectedSeq) return broken(seq, id, "sequence_gap");
      if (row.prev_hash !== previous) return broken(seq, id, "prev_hash_mismatch");
      if (hashOf(chain, row) !== row.hash) return broken(seq, id, "hash_mismatch");
      previous = String(row.hash);
      expectedSeq += 1;
    }
    const recorded = metaValue(chain.headKey);
    if (recorded !== undefined) {
      const expected = JSON.parse(recorded) as { seq?: unknown; hash?: unknown };
      const seq = typeof expected.seq === "number" ? expected.seq : -1;
      if (seq !== rows.length || expected.hash !== previous) {
        return broken(seq, null, "head_mismatch");
      }
    } else if (rows.length > 0 || metaValue(chain.startedKey) !== undefined) {
      // No head, yet rows exist or the chain has started: the head was deleted, with or without the rows.
      return broken(Math.max(rows.length, 1), null, "head_mismatch");
    }
    return { table: chain.table, rows: rows.length, ok: true, firstBroken: null };
  };

  return {
    appendOrder(input: AppendOrderInput): AppendResult<OrderRecord> {
      if (input.preview !== null && Array.from(input.preview).length > PREVIEW_MAX) {
        throw new StoreError(
          "store.conflict",
          `an order preview holds at most ${PREVIEW_MAX} characters; build it with orderPreview`,
          {},
        );
      }
      return transaction(() => {
        const existing = byKey(ORDERS, input.idempotencyKey);
        if (existing !== undefined) return { record: toOrder(existing), created: false };
        const row = append(ORDERS, {
          order_id: ids.next(),
          session_id: orNull(input.sessionId),
          mode: input.mode,
          source: input.source,
          workflow_id: orNull(input.workflowId),
          project_id: orNull(input.projectId),
          text_sha256: sha256(input.text),
          text_chars: Array.from(input.text).length,
          preview: input.preview,
          idempotency_key: orNull(input.idempotencyKey),
        });
        return { record: toOrder(row), created: true };
      });
    },

    appendUsage(input: AppendUsageInput): AppendResult<UsageRecord> {
      return transaction(() => {
        const existing = byKey(USAGE, input.idempotencyKey);
        if (existing !== undefined) return { record: toUsage(existing), created: false };
        const row = append(USAGE, {
          usage_id: ids.next(),
          order_id: orNull(input.orderId),
          kind: input.kind,
          session_id: orNull(input.sessionId),
          project_id: orNull(input.projectId),
          workflow_id: orNull(input.workflowId),
          task_id: orNull(input.taskId),
          run_id: orNull(input.runId),
          thread_id: orNull(input.threadId),
          layer: orNull(input.layer),
          role: orNull(input.role),
          mode: orNull(input.mode),
          provider: orNull(input.provider),
          model_requested: orNull(input.modelRequested),
          model_served: orNull(input.modelServed),
          model_pinned: flag(input.modelPinned),
          tokens_in: input.tokensIn,
          tokens_out: input.tokensOut,
          tokens_cached: orNull(input.tokensCached),
          tokens_reasoning: orNull(input.tokensReasoning),
          cost_micros: orNull(input.costMicros),
          unreconciled: flag(input.unreconciled),
          started_at: orNull(input.startedAt),
          ended_at: orNull(input.endedAt),
          duration_ms: orNull(input.durationMs),
          difficulty_est: orNull(input.difficultyEst),
          difficulty_reason: orNull(input.difficultyReason),
          outcome: orNull(input.outcome),
          audit_verdict: orNull(input.auditVerdict),
          retries: orNull(input.retries),
          simulated: flag(input.simulated),
          idempotency_key: orNull(input.idempotencyKey),
        });
        return { record: toUsage(row), created: true };
      });
    },

    orders(filter?: OrderFilter): readonly OrderRecord[] {
      const where = whereOf([
        ["ts >= ?", filter?.from],
        ["ts < ?", filter?.to],
        ["mode = ?", filter?.mode],
        ["workflow_id = ?", filter?.workflowId],
      ]);
      const rows = db
        .prepare(`SELECT * FROM orders${where.sql} ORDER BY seq DESC LIMIT ?`)
        .all(...where.values, filter?.limit ?? -1) as Row[];
      return rows.map(toOrder).reverse();
    },

    usage(filter?: UsageFilter): readonly UsageRecord[] {
      const where = usageWhere(filter);
      const rows = db
        .prepare(`SELECT * FROM usage_log${where.sql} ORDER BY seq DESC LIMIT ?`)
        .all(...where.values, filter?.limit ?? -1) as Row[];
      return rows.map(toUsage).reverse();
    },

    summary(groupBy: UsageGroupBy, filter?: UsageFilter): readonly UsageSummaryRow[] {
      const where = usageWhere(filter, "u");
      const key = GROUP_KEYS[groupBy];
      // approved and rejected count the executor runs whose task an auditor judged (the model_stats rule). One verdict per
      // subject task, the newest, so a task judged twice never counts its run twice.
      const rows = db
        .prepare(
          `SELECT ${key} AS key, COUNT(*) AS rows,
             COALESCE(SUM(u.tokens_in), 0) AS tokensIn, COALESCE(SUM(u.tokens_out), 0) AS tokensOut,
             SUM(CASE WHEN u.tokens_in IS NULL THEN 1 ELSE 0 END) AS tokensInUnreported,
             SUM(CASE WHEN u.tokens_out IS NULL THEN 1 ELSE 0 END) AS tokensOutUnreported,
             COALESCE(SUM(u.duration_ms), 0) AS durationMs, COALESCE(SUM(u.retries), 0) AS retries,
             SUM(CASE WHEN u.role = 'executor' AND a.verdict = 'approved' THEN 1 ELSE 0 END) AS approved,
             SUM(CASE WHEN u.role = 'executor' AND a.verdict = 'rejected' THEN 1 ELSE 0 END) AS rejected
           FROM usage_log u
           LEFT JOIN (
             SELECT a1.subject_task_id AS subject_task_id, a1.verdict AS verdict
             FROM audits a1
             WHERE a1.scope = 'task'
               AND a1.rowid = (SELECT MAX(a2.rowid) FROM audits a2 WHERE a2.scope = 'task' AND a2.subject_task_id = a1.subject_task_id)
           ) a ON a.subject_task_id = u.task_id
           ${where.sql}
           GROUP BY 1
           ORDER BY (key IS NULL), key`,
        )
        .all(...where.values) as unknown as UsageSummaryRow[];
      return rows.map((row) => ({ ...row }));
    },

    modelStats() {
      return db
        .prepare(
          "SELECT model, difficulty, runs, approved, rejected, retries, tokens_in AS tokensIn, tokens_out AS tokensOut, duration_ms AS durationMs FROM model_stats ORDER BY model, difficulty",
        )
        .all()
        .map((row) => ({ ...row })) as unknown as ModelStatRow[];
    },

    verify(): UsageVerification {
      return snapshot(() => {
        const orders = verifyChain(ORDERS);
        const usage = verifyChain(USAGE);
        return { ok: orders.ok && usage.ok, orders, usage };
      });
    },
  };
}

type ChainBreak = NonNullable<ChainReport["firstBroken"]>["reason"];
