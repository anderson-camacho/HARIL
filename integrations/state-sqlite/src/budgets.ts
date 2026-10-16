import type { DatabaseSync } from "node:sqlite";
import type {
  ActiveVirtualKey,
  BudgetRecord,
  BudgetsPort,
  Clock,
  CommitInput,
  CommitStatus,
  EnsureBudgetInput,
  Ids,
  IssueKeyInput,
  JsonObject,
  ReleaseStatus,
  ReserveInput,
  ReserveResult,
  UsageBreakdownRow,
  UsageSummary,
  UsageSummaryFilter,
  VirtualKeysPort,
} from "@haril/core/ports";
import { StoreError } from "./errors.js";

// Token budgets, the budget ledger and virtual keys (M2-T2, ADR-0005 BR-3, BR-5, BR-8, BR-12). Every write runs in
// the transaction the store hands in, so a reservation over several budgets is all-or-nothing. The ledger is
// append-only; `budgets` holds the running totals that the ledger sums to.

interface BudgetFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly transaction: <T>(work: () => T) => T;
}

export interface BudgetFacets {
  readonly budgets: BudgetsPort;
  readonly virtualKeys: VirtualKeysPort;
}

const BUDGET_COLUMNS =
  "budget_id AS budgetId, scope_type AS scopeType, scope_id AS scopeId, project_id AS projectId, hard_limit AS hardLimit, spent, reserved, overrun";

// The reserve rows of one reservation: one per budget, carrying the identity the settlement rows copy.
interface ReserveRow {
  readonly budgetId: string;
  readonly amount: number;
  readonly routeId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
}

interface LedgerEntry {
  readonly budgetId: string;
  readonly reservationId: string;
  readonly kind: "reserve" | "commit" | "release" | "adjust";
  readonly amount: number;
  readonly unreconciled: 0 | 1;
  readonly costSource: string;
  readonly routeId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly tokensInput: number | null;
  readonly tokensOutput: number | null;
  readonly modelRequested: string | null;
  readonly modelServed: string | null;
  readonly idempotencyKey: string;
}

interface KeyRow {
  readonly keyId: string;
  readonly runId: string;
  readonly routeGrant: string;
  readonly budgetIds: string;
  readonly expiresAt: number;
}

export function createBudgetFacets(options: BudgetFacetOptions): BudgetFacets {
  const { db, clock, ids, transaction } = options;

  function write<T>(work: () => T): T {
    try {
      return transaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StoreError(
          "store.conflict",
          "a budget entry or virtual key with the same identity already exists",
        );
      }
      throw error;
    }
  }

  function budgetRow(budgetId: string): BudgetRecord | undefined {
    return db
      .prepare(`SELECT ${BUDGET_COLUMNS} FROM budgets WHERE budget_id = ?`)
      .get(budgetId) as unknown as BudgetRecord | undefined;
  }

  function reserveRows(reservationId: string): ReserveRow[] {
    return db
      .prepare(
        `SELECT budget_id AS budgetId, amount, route_id AS routeId, project_id AS projectId,
                task_id AS taskId, run_id AS runId
         FROM budget_ledger WHERE reservation_id = ? AND kind = 'reserve' ORDER BY entry_id`,
      )
      .all(reservationId) as unknown as ReserveRow[];
  }

  function isSettled(reservationId: string): boolean {
    const row = db
      .prepare(
        "SELECT 1 AS found FROM budget_ledger WHERE reservation_id = ? AND kind IN ('commit','release') LIMIT 1",
      )
      .get(reservationId);
    return row !== undefined;
  }

  function insertLedger(entry: LedgerEntry): void {
    db.prepare(
      `INSERT INTO budget_ledger (budget_id, reservation_id, kind, amount, unreconciled, cost_source,
         route_id, project_id, task_id, run_id, tokens_input, tokens_output, model_requested,
         model_served, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.budgetId,
      entry.reservationId,
      entry.kind,
      entry.amount,
      entry.unreconciled,
      entry.costSource,
      entry.routeId,
      entry.projectId,
      entry.taskId,
      entry.runId,
      entry.tokensInput,
      entry.tokensOutput,
      entry.modelRequested,
      entry.modelServed,
      entry.idempotencyKey,
      clock.now(),
    );
  }

  const budgets: BudgetsPort = {
    ensure(input: EnsureBudgetInput): BudgetRecord {
      return write(() => {
        const existing = db
          .prepare(
            "SELECT budget_id AS budgetId FROM budgets WHERE scope_type = ? AND scope_id = ? AND unit = 'tokens' AND period_start = 0",
          )
          .get(input.scopeType, input.scopeId) as { budgetId: string } | undefined;
        if (existing !== undefined) return requireBudget(existing.budgetId);
        const budgetId = ids.next();
        db.prepare(
          `INSERT INTO budgets (budget_id, scope_type, scope_id, project_id, unit, period_start, hard_limit)
           VALUES (?, ?, ?, ?, 'tokens', 0, ?)`,
        ).run(budgetId, input.scopeType, input.scopeId, input.projectId, input.hardLimit);
        return requireBudget(budgetId);
      });
    },

    get(budgetId: string): BudgetRecord | undefined {
      return budgetRow(budgetId);
    },

    reserve(input: ReserveInput): ReserveResult {
      return write((): ReserveResult => {
        // Check every budget before writing any: a refusal leaves all of them untouched.
        const rows: BudgetRecord[] = [];
        for (const budgetId of new Set(input.budgetIds)) {
          const row = budgetRow(budgetId);
          if (row === undefined) return { ok: false, reason: "unknown_budget", budgetId };
          if (row.spent + row.reserved + input.amount > row.hardLimit) {
            return { ok: false, reason: "insufficient", budgetId };
          }
          rows.push(row);
        }
        const reservationId = ids.next();
        for (const row of rows) {
          db.prepare("UPDATE budgets SET reserved = reserved + ? WHERE budget_id = ?").run(
            input.amount,
            row.budgetId,
          );
          insertLedger({
            budgetId: row.budgetId,
            reservationId,
            kind: "reserve",
            amount: input.amount,
            unreconciled: 0,
            costSource: "estimated",
            routeId: input.routeId,
            projectId: row.projectId,
            taskId: input.taskId,
            runId: input.runId,
            tokensInput: null,
            tokensOutput: null,
            modelRequested: null,
            modelServed: null,
            idempotencyKey: `${input.idempotencyKey}:${row.budgetId}`,
          });
        }
        return { ok: true, reservationId };
      });
    },

    commit(input: CommitInput): CommitStatus {
      return write((): CommitStatus => {
        const reserves = reserveRows(input.reservationId);
        if (reserves.length === 0) return "unknown_reservation";
        if (isSettled(input.reservationId)) return "already_settled";
        const inputTokens = input.usage?.inputTokens ?? null;
        const outputTokens = input.usage?.outputTokens ?? null;
        const exact = inputTokens !== null && outputTokens !== null;
        // Raw usage when the provider reported it; otherwise the upper bound, flagged as unreconciled.
        const spend =
          inputTokens !== null && outputTokens !== null
            ? inputTokens + outputTokens
            : input.upperBound;
        for (const reserve of reserves) {
          const row = requireBudget(reserve.budgetId);
          const reservedAfter = row.reserved - reserve.amount;
          // spent may not pass hard_limit with the reservations still open: the excess goes to overrun.
          const room = Math.max(0, row.hardLimit - row.spent - reservedAfter);
          const inHard = Math.min(spend, room);
          const over = spend - inHard;
          db.prepare(
            "UPDATE budgets SET spent = spent + ?, reserved = ?, overrun = overrun + ? WHERE budget_id = ?",
          ).run(inHard, reservedAfter, over, row.budgetId);
          const settlement = {
            budgetId: row.budgetId,
            reservationId: input.reservationId,
            costSource: exact ? "provider_reported" : "unknown",
            routeId: reserve.routeId,
            projectId: reserve.projectId,
            taskId: reserve.taskId,
            runId: reserve.runId,
            tokensInput: inputTokens,
            tokensOutput: outputTokens,
            modelRequested: input.modelRequested,
            modelServed: input.modelServed,
          };
          insertLedger({
            ...settlement,
            kind: "commit",
            amount: spend,
            unreconciled: exact ? 0 : 1,
            idempotencyKey: `commit:${input.reservationId}:${row.budgetId}`,
          });
          if (over > 0) {
            insertLedger({
              ...settlement,
              kind: "adjust",
              amount: over,
              unreconciled: 0,
              idempotencyKey: `adjust:${input.reservationId}:${row.budgetId}`,
            });
          }
        }
        return "committed";
      });
    },

    release(reservationId: string): ReleaseStatus {
      return write((): ReleaseStatus => {
        const reserves = reserveRows(reservationId);
        if (reserves.length === 0) return "unknown_reservation";
        if (isSettled(reservationId)) return "already_settled";
        for (const reserve of reserves) {
          db.prepare("UPDATE budgets SET reserved = reserved - ? WHERE budget_id = ?").run(
            reserve.amount,
            reserve.budgetId,
          );
          insertLedger({
            budgetId: reserve.budgetId,
            reservationId,
            kind: "release",
            amount: reserve.amount,
            unreconciled: 0,
            costSource: "estimated",
            routeId: reserve.routeId,
            projectId: reserve.projectId,
            taskId: reserve.taskId,
            runId: reserve.runId,
            tokensInput: null,
            tokensOutput: null,
            modelRequested: null,
            modelServed: null,
            idempotencyKey: `release:${reservationId}:${reserve.budgetId}`,
          });
        }
        return "released";
      });
    },

    usageSummary(filter?: UsageSummaryFilter): UsageSummary | null {
      // Counted once per reservation, on the budget of the scope: the task budget when a task is named,
      // otherwise the project budget (every broker reservation holds one).
      const taskId = filter?.taskId ?? null;
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(l.tokens_input), 0) AS inputTokens,
                  COALESCE(SUM(l.tokens_output), 0) AS outputTokens,
                  COUNT(*) AS settled,
                  COALESCE(SUM(l.unreconciled), 0) AS unreconciled
           FROM budget_ledger l JOIN budgets b ON b.budget_id = l.budget_id
           WHERE l.kind = 'commit' AND b.scope_type = ?
             AND (? IS NULL OR b.scope_id = ?) AND (? IS NULL OR b.project_id = ?)`,
        )
        .get(
          taskId === null ? "project" : "task",
          taskId,
          taskId,
          filter?.projectId ?? null,
          filter?.projectId ?? null,
        ) as unknown as UsageSummary;
      return row.settled === 0 ? null : row;
    },

    // Counted on the project budget only, once per reservation, grouped by the agent of the task and the
    // model that was requested (M2-T6). Rows are the settled commits; reserves and releases are not spend.
    usageBreakdown(projectId?: string): readonly UsageBreakdownRow[] {
      return db
        .prepare(
          `SELECT t.agent_ref AS agentRef, l.model_requested AS model,
                  COALESCE(SUM(l.tokens_input), 0) AS inputTokens,
                  COALESCE(SUM(l.tokens_output), 0) AS outputTokens,
                  COALESCE(SUM(l.unreconciled), 0) AS unreconciled
           FROM budget_ledger l
             JOIN budgets b ON b.budget_id = l.budget_id
             JOIN tasks t ON t.task_id = l.task_id
           WHERE l.kind = 'commit' AND b.scope_type = 'project'
             AND (? IS NULL OR b.project_id = ?)
           GROUP BY t.agent_ref, l.model_requested
           ORDER BY t.agent_ref, l.model_requested`,
        )
        .all(projectId ?? null, projectId ?? null) as unknown as UsageBreakdownRow[];
    },
  };

  const virtualKeys: VirtualKeysPort = {
    issue(input: IssueKeyInput): string {
      return write(() => {
        const keyId = ids.next();
        db.prepare(
          `INSERT INTO virtual_keys (key_id, run_id, key_hash, route_grant, budget_ids, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          keyId,
          input.runId,
          input.keyHash,
          JSON.stringify(input.routeGrant),
          JSON.stringify(input.budgetIds),
          input.expiresAt,
          clock.now(),
        );
        return keyId;
      });
    },

    findActiveByHash(keyHash: string): ActiveVirtualKey | undefined {
      const row = db
        .prepare(
          `SELECT key_id AS keyId, run_id AS runId, route_grant AS routeGrant,
                  budget_ids AS budgetIds, expires_at AS expiresAt
           FROM virtual_keys WHERE key_hash = ? AND revoked_at IS NULL`,
        )
        .get(keyHash) as unknown as KeyRow | undefined;
      if (row === undefined) return undefined;
      return {
        keyId: row.keyId,
        runId: row.runId,
        routeGrant: JSON.parse(row.routeGrant) as JsonObject,
        budgetIds: JSON.parse(row.budgetIds) as string[],
        expiresAt: row.expiresAt,
      };
    },

    revoke(runId: string, reason: string): number {
      return write(() =>
        Number(
          db
            .prepare(
              "UPDATE virtual_keys SET revoked_at = ?, revoke_reason = ? WHERE run_id = ? AND revoked_at IS NULL",
            )
            .run(clock.now(), reason, runId).changes,
        ),
      );
    },
  };

  function requireBudget(budgetId: string): BudgetRecord {
    const row = budgetRow(budgetId);
    if (row === undefined) {
      throw new StoreError("store.conflict", "budget not found", { budgetId });
    }
    return row;
  }

  return { budgets, virtualKeys };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
