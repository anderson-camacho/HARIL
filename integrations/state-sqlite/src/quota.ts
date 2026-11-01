import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  Clock,
  Ids,
  ModelCooldownRecord,
  QuotaSampleRecord,
  QuotaSnapshot,
  QuotaStorePort,
  QuotaWindowName,
} from "@haril/core/ports";

// quota_samples and model_cooldowns (docs/modos-y-delegacion.md 3.11, 4.2; phase F6). Observations of the providers, not
// task state: written without the runtime lease, each in one transaction. A sampling is one batch: one row per window of
// each account, an account without a window keeps its two windows unknown, and a provider that could not be read leaves
// one row per window with no account and the reason in note. Nothing here ever holds a key or an account's e-mail.

interface QuotaFacetOptions {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly transaction: <T>(work: () => T) => T;
}

const WINDOWS: readonly QuotaWindowName[] = ["5h", "7d"];

const SAMPLE_COLUMNS =
  "provider, batch_id AS batchId, credential_ref AS credentialRef, account_kind AS kind, account_prefix AS prefix, window, used_pct AS usedPct, resets_at AS resetsAt, sampled_at AS sampledAt, source, note, group_name AS groupName, group_models AS groupModels, account_plan AS accountPlan";
// How many rows of history a view gets: a day of samplings of a few accounts, with their groups.
const HISTORY_LIMIT = 4_000;

type Row = Record<string, SQLInputValue>;

// A stored row as the port gives it: the group's and plan's fields only where they exist.
function sampleOf(row: Row): QuotaSampleRecord {
  const { groupName, groupModels, accountPlan, ...rest } = row;
  return {
    ...(rest as unknown as QuotaSampleRecord),
    ...(typeof groupName === "string" ? { group: groupName } : {}),
    ...(typeof groupModels === "string"
      ? { groupModels: JSON.parse(groupModels) as string[] }
      : {}),
    ...(typeof accountPlan === "string" ? { plan: accountPlan } : {}),
  };
}

function knownPercent(value: number | null | undefined): number | null {
  return value !== undefined && value !== null && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function createQuotaFacet(options: QuotaFacetOptions): QuotaStorePort {
  const { db, clock, ids, transaction } = options;

  const insert = (row: QuotaSampleRecord): void => {
    db.prepare(
      "INSERT INTO quota_samples (sample_id, provider, credential_ref, window, used_pct, resets_at, sampled_at, source, batch_id, account_kind, account_prefix, note, group_name, group_models, account_plan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      ids.next(),
      row.provider,
      row.credentialRef,
      row.window,
      row.usedPct,
      row.resetsAt,
      row.sampledAt,
      row.source,
      row.batchId,
      row.kind,
      row.prefix,
      row.note,
      row.group ?? null,
      row.groupModels === undefined ? null : JSON.stringify(row.groupModels),
      row.plan ?? null,
    );
  };

  const findCooldown = (model: string): ModelCooldownRecord | undefined =>
    db.prepare("SELECT model, until, reason FROM model_cooldowns WHERE model = ?").get(model) as
      | ModelCooldownRecord
      | undefined;

  return {
    recordSnapshot(provider: string, snapshot: QuotaSnapshot): string {
      const batchId = ids.next();
      transaction(() => {
        const base = { provider, batchId, sampledAt: snapshot.sampledAt };
        if (!snapshot.ok) {
          for (const window of WINDOWS) {
            insert({
              ...base,
              credentialRef: null,
              kind: null,
              prefix: null,
              window,
              usedPct: null,
              resetsAt: null,
              source: "unavailable",
              note: `${snapshot.reason}: ${snapshot.detail}`,
            });
          }
          return;
        }
        for (const account of snapshot.accounts) {
          const shared = {
            ...base,
            credentialRef: account.credentialRef,
            kind: account.kind,
            prefix: account.prefix,
            source: snapshot.source,
            note: account.note,
            ...(account.plan === undefined ? {} : { plan: account.plan }),
          };
          for (const window of WINDOWS) {
            const reading = account.windows.find(
              (item) => item.name === window && item.group === undefined,
            );
            const usedPct = knownPercent(reading?.usedPct);
            insert({
              ...shared,
              window,
              usedPct,
              resetsAt: usedPct === null ? null : (reading?.resetsAt ?? null),
            });
          }
          for (const reading of account.windows) {
            const usedPct = knownPercent(reading.usedPct);
            if (reading.group === undefined || usedPct === null) continue;
            insert({
              ...shared,
              window: reading.name,
              usedPct,
              resetsAt: reading.resetsAt,
              group: reading.group,
              ...(reading.models === undefined ? {} : { groupModels: reading.models }),
            });
          }
        }
      });
      return batchId;
    },

    latest(since: number): readonly QuotaSampleRecord[] {
      // The newest batch of each provider: the batch of its newest row, by sampling time, then by insertion.
      const rows = db
        .prepare(
          `SELECT ${SAMPLE_COLUMNS} FROM quota_samples q
           WHERE q.batch_id IS NOT NULL AND q.sampled_at >= ?
             AND q.batch_id = (
               SELECT q2.batch_id FROM quota_samples q2
               WHERE q2.provider = q.provider AND q2.batch_id IS NOT NULL
               ORDER BY q2.sampled_at DESC, q2.rowid DESC LIMIT 1)
           ORDER BY q.provider, q.rowid`,
        )
        .all(since) as Row[];
      return rows.map(sampleOf);
    },

    history(since: number): readonly QuotaSampleRecord[] {
      const rows = db
        .prepare(
          `SELECT ${SAMPLE_COLUMNS} FROM quota_samples
           WHERE batch_id IS NOT NULL AND sampled_at >= ? AND used_pct IS NOT NULL
           ORDER BY sampled_at DESC, rowid DESC LIMIT ?`,
        )
        .all(since, HISTORY_LIMIT) as Row[];
      return rows.reverse().map(sampleOf);
    },

    setCooldown(input: ModelCooldownRecord): ModelCooldownRecord {
      return transaction(() => {
        const existing = findCooldown(input.model);
        // An active cooldown that ends later stays: a short 429 never shortens a 402's wait.
        const keep =
          existing !== undefined && existing.until > input.until && existing.until > clock.now();
        if (!keep) {
          db.prepare(
            "INSERT INTO model_cooldowns (model, until, reason) VALUES (?, ?, ?) ON CONFLICT(model) DO UPDATE SET until = excluded.until, reason = excluded.reason",
          ).run(input.model, input.until, input.reason);
        }
        return findCooldown(input.model) as ModelCooldownRecord;
      });
    },

    cooldowns(now: number): readonly ModelCooldownRecord[] {
      return db
        .prepare("SELECT model, until, reason FROM model_cooldowns WHERE until > ? ORDER BY model")
        .all(now) as unknown as ModelCooldownRecord[];
    },
  };
}
