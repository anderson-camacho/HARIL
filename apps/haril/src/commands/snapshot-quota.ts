import type { WorkflowSnapshot } from "@haril/contracts";
import type { QuotaPolicy } from "@haril/core";
import type { Store } from "@haril/core/ports";
import type { HostInfo } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import { delegationSettingsOf } from "../delegation-section.js";
import { accountViews, quotaByKey, quotaKeyOf } from "../quota-view.js";
import { QUOTA_FRESH_MS } from "../runtime/model-context.js";
import type { SnapshotOptions } from "./workflow-snapshot.js";

// The quota part of a real workflow's snapshot (ADR-0021 WorkflowSnapshot v1; phase F6): one row per account of each
// provider's newest reading while it is fresh (the same reading the runtime decides with), with what the 80/80/20 rule
// says about it, a row that says "sin dato" for a provider that could not be read, and each node's quota from its model's
// account. Without a reading the rows are empty and every node's quota is null.
export function storeQuota(
  store: Pick<Store, "quota">,
  host: HostInfo,
  now: number,
): Pick<SnapshotOptions, "quota" | "quotaOf"> {
  const loaded = loadDelegationSettings(host);
  const settings = loaded.ok ? loaded.settings : delegationSettingsOf(undefined);
  const policy: QuotaPolicy = {
    switchAtPercent5h: settings.quota.switchAtPercent5h,
    stopAtPercentWeekly: settings.quota.stopAtPercentWeekly,
    minRemainingPercentForLargeTask: settings.quota.minRemainingPercentForLargeTask,
    maxWaitMs: settings.quota.maxWaitMs,
  };
  const records = store.quota.latest(now - QUOTA_FRESH_MS);
  const rows: WorkflowSnapshot["quota"] = accountViews(records, policy).map((account) => ({
    provider: account.provider,
    credential: account.label,
    window5hPct: account.window5h.usedPct,
    weeklyPct: account.weekly.usedPct,
    resetAt: account.window5h.resetsAt ?? account.weekly.resetsAt,
    note: account.note,
  }));
  const unread = new Map<string, string>();
  for (const row of records) {
    if (row.credentialRef === null && !unread.has(row.provider)) {
      unread.set(row.provider, row.note ?? "unavailable");
    }
  }
  for (const [provider, note] of unread) {
    rows.push({
      provider,
      credential: "all accounts",
      window5hPct: null,
      weeklyPct: null,
      resetAt: null,
      note: `sin dato: ${note}`,
    });
  }
  const byKey = quotaByKey(records, policy);
  return {
    quota: rows,
    quotaOf: (model) => {
      const sample = byKey[quotaKeyOf(model)];
      return sample?.available === true
        ? { window5hPct: sample.window5hUsedPct, weeklyPct: sample.weeklyUsedPct }
        : null;
    },
  };
}
