import type { ModelCooldownRecord, Store, WorkflowRecord } from "@haril/core/ports";
import { groupIndex, quotaByKey, quotaKeyFor, quotaKeyOf } from "../quota-view.js";
import { type DelegationModels, type DelegationOptions, defaultModels } from "./workflow-view.js";

// What the store adds to every model decision of a workflow (docs/modos-y-delegacion.md 3.11; phase F6): the cooldowns
// that 402 and 429 answers started (a model's own, and its account's, keyed "quota:<quota key>") and the newest quota
// reading of each provider while it is fresh. The decisions read them at each call, so a cooldown recorded by one turn
// holds back the next turn's model at once. A quota the options give themselves wins over the store's.

// A model whose account reports pools of models counts against its pool only (quota-view.ts); a key the options set
// themselves (the claude bridge's) stays.

// A quota reading older than this is no longer evidence: its rule is skipped ("sin dato").
export const QUOTA_FRESH_MS = 15 * 60_000;

export function withStoreState(
  store: Pick<Store, "quota">,
  options: DelegationOptions | undefined,
): DelegationOptions {
  const source = options?.models;
  const baseOf = (now: number, workflow: WorkflowRecord): DelegationModels =>
    source === undefined
      ? defaultModels(workflow.orchestratorModel)
      : typeof source === "function"
        ? source(now, workflow)
        : source;
  return {
    ...options,
    models: (now, workflow) => {
      const base = baseOf(now, workflow);
      const cooldowns = new Map<string, ModelCooldownRecord>(
        store.quota.cooldowns(now).map((row) => [row.model, row]),
      );
      const until = (key: string): number | null => cooldowns.get(key)?.until ?? null;
      const later = (...values: (number | null)[]): number | null => {
        const known = values.filter((value): value is number => value !== null);
        return known.length === 0 ? null : Math.max(...known);
      };
      const records = store.quota.latest(now - QUOTA_FRESH_MS);
      const groups = groupIndex(records);
      return {
        ...base,
        catalog: base.catalog.map((entry) => ({
          ...entry,
          quotaKey:
            entry.quotaKey === quotaKeyOf(entry.ref)
              ? quotaKeyFor(entry.ref, groups)
              : entry.quotaKey,
          coolingUntil: later(
            entry.coolingUntil,
            until(entry.ref),
            until(`quota:${entry.quotaKey}`),
            until(`quota:${quotaKeyOf(entry.ref)}`),
          ),
        })),
        quota: {
          ...quotaByKey(records, base.policy),
          ...base.quota,
        },
      };
    },
  };
}
