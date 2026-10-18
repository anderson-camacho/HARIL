import { evaluateQuota, type QuotaPolicy, type QuotaSample, worstQuota } from "@haril/core";
import type { QuotaSampleRecord } from "@haril/core/ports";

// Quota readings as people and the model choice read them (docs/modos-y-delegacion.md 3.11; ADR-0021 P4, P25): one row
// per account of each provider's newest batch, with what the 80/80/20 rule says about it, and the quota of each quota
// key: an account's prefix routes a model to that account (P25), and a model without a prefix counts as the worst
// account of its provider (P4). A window nobody reported is "sin dato", never a number.

export interface QuotaWindowView {
  readonly usedPct: number | null;
  readonly resetsAt: number | null;
}

export interface QuotaAccountView {
  readonly provider: string;
  // Opaque: never an e-mail or a file name.
  readonly credential: string;
  // What a person reads: the account's model prefix, else its kind and opaque reference.
  readonly label: string;
  readonly kind: string | null;
  readonly prefix: string | null;
  readonly window5h: QuotaWindowView;
  readonly weekly: QuotaWindowView;
  // What the rule says (avoided, not used, no large task), or why it says nothing ("sin dato: ...").
  readonly note: string;
  readonly sampledAt: number;
  readonly source: string;
}

function sampleOf(window5h: QuotaWindowView, weekly: QuotaWindowView): QuotaSample {
  if (window5h.usedPct === null && weekly.usedPct === null) {
    return { available: false, reason: "no window reported" };
  }
  return {
    available: true,
    window5hUsedPct: window5h.usedPct,
    window5hResetsAt: window5h.resetsAt,
    weeklyUsedPct: weekly.usedPct,
    weeklyResetsAt: weekly.resetsAt,
  };
}

function noteOf(
  window5h: QuotaWindowView,
  weekly: QuotaWindowView,
  note: string | null,
  policy: QuotaPolicy,
): string {
  const sample = sampleOf(window5h, weekly);
  if (!sample.available) return note === null ? "sin dato" : `sin dato: ${note}`;
  const plain = evaluateQuota(sample, false, policy);
  if (!plain.ok) {
    return plain.cause === "weekly"
      ? `over ${policy.stopAtPercentWeekly}% of its week: not used`
      : `over ${policy.switchAtPercent5h}% of its 5-hour window: avoided`;
  }
  const large = evaluateQuota(sample, true, policy);
  if (!large.ok) {
    return `under ${policy.minRemainingPercentForLargeTask}% left in its 5-hour window: no large task`;
  }
  return plain.data === "no_data" ? "sin dato" : "";
}

// The accounts of the newest batches, in the order they were read.
export function accountViews(
  records: readonly QuotaSampleRecord[],
  policy: QuotaPolicy,
): QuotaAccountView[] {
  const accounts = new Map<string, QuotaSampleRecord[]>();
  for (const row of records) {
    if (row.credentialRef === null) continue;
    const key = `${row.provider}\u0000${row.credentialRef}`;
    accounts.set(key, [...(accounts.get(key) ?? []), row]);
  }
  return [...accounts.values()].map((rows) => {
    const first = rows[0] as QuotaSampleRecord;
    const windowOf = (name: "5h" | "7d"): QuotaWindowView => {
      const row = rows.find((item) => item.window === name);
      return { usedPct: row?.usedPct ?? null, resetsAt: row?.resetsAt ?? null };
    };
    const window5h = windowOf("5h");
    const weekly = windowOf("7d");
    const credential = first.credentialRef as string;
    return {
      provider: first.provider,
      credential,
      label: first.prefix ?? `${first.kind ?? "account"} ${credential}`,
      kind: first.kind,
      prefix: first.prefix,
      window5h,
      weekly,
      note: noteOf(window5h, weekly, first.note, policy),
      sampledAt: first.sampledAt,
      source: first.source,
    };
  });
}

// The quota of each quota key: "<provider>/<prefix>" for an account with a prefix, and "<provider>" for the worst account
// of the provider. A provider that could not be read has no key: "sin dato", and its rule is skipped.
export function quotaByKey(
  records: readonly QuotaSampleRecord[],
  policy: QuotaPolicy,
): Record<string, QuotaSample> {
  const byProvider = new Map<string, QuotaSample[]>();
  const out: Record<string, QuotaSample> = {};
  for (const account of accountViews(records, policy)) {
    const sample = sampleOf(account.window5h, account.weekly);
    if (account.prefix !== null) out[`${account.provider}/${account.prefix}`] = sample;
    byProvider.set(account.provider, [...(byProvider.get(account.provider) ?? []), sample]);
  }
  for (const [provider, samples] of byProvider) out[provider] = worstQuota(samples);
  return out;
}

// The quota key of a model reference "<provider>/<model id>": the account prefix when the model id names one
// ("cliproxy/Gemini1/gemini-3-flash" -> "cliproxy/Gemini1"), else the provider.
export function quotaKeyOf(ref: string): string {
  const parts = ref.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? ref);
}
