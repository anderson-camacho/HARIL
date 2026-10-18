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
  "provider, batch_id AS batchId, credential_ref AS credentialRef, account_kind AS kind, account_prefix AS prefix, window, used_pct AS usedPct, resets_at AS resetsAt, sampled_at AS sampledAt, source, note";

type Row = Record<string, SQLInputValue>;

export function createQuotaFacet(options: QuotaFacetOptions): QuotaStorePort {
  const { db, clock, ids, transaction } = options;

  const insert = (row: QuotaSampleRecord): void => {
    db.prepare(
      "INSERT INTO quota_samples (sample_id, provider, credential_ref, window, used_pct, resets_at, sampled_at, source, batch_id, account_kind, account_prefix, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
          for (const window of WINDOWS) {
            const reading = account.windows.find((item) => item.name === window);
            const usedPct =
              reading?.usedPct !== undefined &&
              reading.usedPct !== null &&
              Number.isFinite(reading.usedPct) &&
              reading.usedPct >= 0
                ? reading.usedPct
                : null;
            insert({
              ...base,
              credentialRef: account.credentialRef,
              kind: account.kind,
              prefix: account.prefix,
              window,
              usedPct,
              resetsAt: usedPct === null ? null : (reading?.resetsAt ?? null),
              source: snapshot.source,
              note: account.note,
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
      return rows as unknown as QuotaSampleRecord[];
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
