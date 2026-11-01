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

interface QuotaGroupView {
  readonly name: string;
  readonly models: readonly string[];
  readonly window5h: QuotaWindowView;
  readonly weekly: QuotaWindowView;
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
  // The pools of models the provider reports for this account; empty when it reports none.
  readonly groups: readonly QuotaGroupView[];
  // The account's plan, when the gateway names one.
  readonly plan: string | null;
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
    const windowOf = (name: "5h" | "7d", group?: string): QuotaWindowView => {
      const row = rows.find((item) => item.window === name && item.group === group);
      return { usedPct: row?.usedPct ?? null, resetsAt: row?.resetsAt ?? null };
    };
    const window5h = windowOf("5h");
    const weekly = windowOf("7d");
    const names = [...new Set(rows.flatMap((row) => (row.group === undefined ? [] : [row.group])))];
    const credential = first.credentialRef as string;
    return {
      provider: first.provider,
      credential,
      label: first.prefix ?? `${first.kind ?? "account"} ${credential}`,
      kind: first.kind,
      prefix: first.prefix,
      window5h,
      weekly,
      groups: names.map((name) => ({
        name,
        models: [
          ...new Set(
            rows.filter((row) => row.group === name).flatMap((row) => row.groupModels ?? []),
          ),
        ],
        window5h: windowOf("5h", name),
        weekly: windowOf("7d", name),
      })),
      plan: first.plan ?? null,
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
    if (account.prefix !== null) {
      const key = `${account.provider}/${account.prefix}`;
      out[key] = sample;
      for (const group of account.groups) {
        out[`${key}#${group.name}`] = sampleOf(group.window5h, group.weekly);
      }
    }
    byProvider.set(account.provider, [...(byProvider.get(account.provider) ?? []), sample]);
  }
  for (const [provider, samples] of byProvider) out[provider] = worstQuota(samples);
  return out;
}

// The pools each account reports, by the account's quota key. Only accounts with a prefix: a model without one counts as
// its provider's worst account (P4), which pools do not change.
export type QuotaGroupIndex = ReadonlyMap<
  string,
  readonly { readonly name: string; readonly models: readonly string[] }[]
>;

export function groupIndex(records: readonly QuotaSampleRecord[]): QuotaGroupIndex {
  const index = new Map<string, { name: string; models: string[] }[]>();
  for (const row of records) {
    if (row.group === undefined || row.prefix === null) continue;
    const key = `${row.provider}/${row.prefix}`;
    const groups = index.get(key) ?? [];
    let group = groups.find((item) => item.name === row.group);
    if (group === undefined) {
      group = { name: row.group, models: [] };
      groups.push(group);
    }
    for (const model of row.groupModels ?? []) {
      if (!group.models.includes(model)) group.models.push(model);
    }
    index.set(key, groups);
  }
  return index;
}

// The pool a model spends: the group whose model list names it, else the only group whose name holds the model's family
// ("gemini-3-flash" -> "Gemini"; "gpt-6.1-sol" -> "Claude and GPT"), else null: the worst window still applies to it.
export function quotaGroupOf(
  modelId: string,
  groups: readonly { readonly name: string; readonly models: readonly string[] }[],
): string | null {
  const id = modelId.toLowerCase();
  const listed = groups.find((group) => group.models.some((model) => model.toLowerCase() === id));
  if (listed !== undefined) return listed.name;
  const family = id.split(/[-_.]/)[0] ?? id;
  const named = groups.filter((group) =>
    group.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .includes(family),
  );
  return named.length === 1 ? (named[0]?.name ?? null) : null;
}

// The key whose quota holds a model back: its pool's on an account that reports pools, else its account's.
export function quotaKeyFor(ref: string, groups: QuotaGroupIndex): string {
  const account = quotaKeyOf(ref);
  const pools = groups.get(account);
  if (pools === undefined) return account;
  const group = quotaGroupOf(ref.split("/").slice(2).join("/"), pools);
  return group === null ? account : `${account}#${group}`;
}

// The quota key of a model reference "<provider>/<model id>": the account prefix when the model id names one
// ("cliproxy/Gemini1/gemini-3-flash" -> "cliproxy/Gemini1"), else the provider.
export function quotaKeyOf(ref: string): string {
  const parts = ref.split("/");
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? ref);
}
