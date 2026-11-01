import type { FactoryModel } from "@haril/contracts";
import { evaluateQuota, type QuotaPolicy, type QuotaSample } from "@haril/core";
import type { QuotaSampleRecord, Store, UsageRecord } from "@haril/core/ports";
import { delegationSettingsOf } from "../delegation-section.js";
import { accountViews, quotaGroupOf, quotaKeyOf } from "../quota-view.js";
import { QUOTA_FRESH_MS } from "../runtime/model-context.js";

// The quota part of the factory's read model (feature haril-factory, F5). Each reading says where it came from: the
// provider ("api"), the usage log's tokens ("estimated", which is a count and never a percentage), or nothing ("none"),
// and why. Reads the store only.

type FactoryQuota = FactoryModel["quota"];
type Account = FactoryQuota["accounts"][number];
type Reading = Account["groups"][number]["window5h"];
type Group = Account["groups"][number];

export type FactoryQuotaSettings = QuotaPolicy & {
  readonly colorWarnPercent: number;
  readonly colorDangerPercent: number;
};

const NOT_ALLOWED = "El proveedor no permite ver este dato";
const NOT_APPLICABLE = "No aplica";
const NO_DATA_YET = "Sin lectura: todavía no hay datos";
const OLD_READING = "Sin lectura: la última lectura es antigua";
const WINDOW_5H_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;
const USAGE_ROWS = 5_000;
const HISTORY_POINTS = 120;
const FAILED_OUTCOME = /fail|retry|wait|no_capacity|refused|timeout|closed_idle|abort/;

const REASON_TEXT: Readonly<Record<string, string>> = {
  not_configured: "falta la clave de gestión",
  unauthorized: "el servidor rechazó la clave de gestión",
  unreachable: "el servidor de gestión no responde",
  timeout: "el servidor de gestión tardó demasiado",
  not_found: "la API de gestión no está activa",
  malformed: "la respuesta no se pudo leer",
};

function unreadState(note: string | null): string {
  const reason = note?.split(":")[0] ?? "";
  return `Sin lectura: ${REASON_TEXT[reason] ?? note ?? "el proveedor no se pudo leer"}`;
}

function absentState(note: string | null): string | null {
  if (note === null) return null;
  return /no usage probe/.test(note) ? NOT_ALLOWED : `Sin lectura: ${note}`;
}

// What a person may read: the prefix, unless it holds an address; else the kind and the opaque reference.
function safeLabel(prefix: string | null, kind: string | null, reference: string): string {
  return prefix !== null && !prefix.includes("@") ? prefix : `${kind ?? "cuenta"} ${reference}`;
}

function refOf(row: UsageRecord): string | null {
  return row.modelServed ?? row.modelRequested;
}

function modelIdOf(ref: string): string {
  return ref.split("/").slice(quotaKeyOf(ref).split("/").length).join("/");
}

function usageByAccount(rows: readonly UsageRecord[], now: number) {
  const byKey = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const ref = refOf(row);
    if (ref === null) continue;
    const key = quotaKeyOf(ref);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const tokens = (list: readonly UsageRecord[], sinceMs: number): number =>
    list
      .filter((row) => (row.startedAt ?? row.ts) >= now - sinceMs)
      .reduce((sum, row) => sum + (row.tokensIn ?? 0) + (row.tokensOut ?? 0), 0);
  return { byKey, tokens };
}

function groupRule(window5h: Reading, weekly: Reading, policy: QuotaPolicy): string {
  const fresh = (reading: Reading): number | null => (reading.stale ? null : reading.pct);
  const used5h = fresh(window5h);
  const usedWeek = fresh(weekly);
  if (used5h === null && usedWeek === null) return "Sin dato";
  const sample: QuotaSample = {
    available: true,
    window5hUsedPct: used5h,
    window5hResetsAt: window5h.resetsAt,
    weeklyUsedPct: usedWeek,
    weeklyResetsAt: weekly.resetsAt,
  };
  const plain = evaluateQuota(sample, false, policy);
  if (!plain.ok) {
    return plain.cause === "weekly"
      ? `No se usa: pasó el ${policy.stopAtPercentWeekly} % de su semana`
      : `Evitada: pasó el ${policy.switchAtPercent5h} % de su ventana de 5 horas`;
  }
  return evaluateQuota(sample, true, policy).ok
    ? "Disponible"
    : `Sin tareas grandes: le queda menos del ${policy.minRemainingPercentForLargeTask} %`;
}

export function buildFactoryQuota(
  store: Pick<Store, "quota" | "usageLog">,
  now: number,
  agents: FactoryModel["agents"],
  settings: FactoryQuotaSettings = delegationSettingsOf(undefined).quota,
): FactoryQuota {
  const latest = store.quota.latest(0);
  const history = store.quota.history(now - WEEK_MS);
  const usage = store.usageLog
    .usage({ from: now - WEEK_MS, simulated: false, limit: USAGE_ROWS })
    .filter((row) => row.kind === "agent_run");
  const unread = new Map<string, string>();
  for (const row of latest) {
    if (row.credentialRef === null && !unread.has(row.provider)) {
      unread.set(row.provider, unreadState(row.note));
    }
  }
  // A provider that cannot be read keeps the last values it gave: the newest batch of its history.
  const lastKnown: QuotaSampleRecord[] = [];
  for (const provider of unread.keys()) {
    const rows = history.filter((row) => row.provider === provider && row.credentialRef !== null);
    const batch = rows[rows.length - 1]?.batchId;
    lastKnown.push(...rows.filter((row) => row.batchId === batch));
  }
  const { byKey, tokens } = usageByAccount(usage, now);
  const seen = new Set<string>();
  const notes = new Map<string, string | null>();
  for (const row of latest) {
    if (row.credentialRef !== null) notes.set(row.credentialRef, row.note);
  }

  const accounts: Account[] = accountViews([...latest, ...lastKnown], settings).map((view) => {
    const key = view.prefix === null ? view.provider : `${view.provider}/${view.prefix}`;
    seen.add(key);
    const rows = byKey.get(key) ?? [];
    const lost = unread.get(view.provider);
    const old = now - view.sampledAt > QUOTA_FRESH_MS;
    const note = notes.get(view.credential) ?? null;
    const pools = view.groups.map((group) => ({ name: group.name, models: group.models }));
    const rowsOf = (name: string | null): readonly UsageRecord[] =>
      name === null
        ? rows
        : rows.filter((row) => quotaGroupOf(modelIdOf(refOf(row) ?? ""), pools) === name);
    const modelsOf = (name: string | null, listed: readonly string[]): string[] => [
      ...new Set([...listed, ...rowsOf(name).map((row) => modelIdOf(refOf(row) ?? ""))]),
    ];
    const reading = (
      value: { usedPct: number | null; resetsAt: number | null },
      sibling: number | null,
      name: string | null,
      sinceMs: number,
    ): Reading => {
      if (value.usedPct !== null) {
        return {
          pct: value.usedPct,
          resetsAt: value.resetsAt,
          source: "api",
          readAt: view.sampledAt,
          stale: lost !== undefined || old,
          state: lost ?? (old ? OLD_READING : null),
          estimatedTokens: null,
        };
      }
      const estimated = tokens(rowsOf(name), sinceMs);
      return {
        pct: null,
        resetsAt: null,
        source: estimated > 0 ? "estimated" : "none",
        readAt: null,
        stale: false,
        state: lost ?? absentState(note) ?? (sibling !== null ? NOT_APPLICABLE : NO_DATA_YET),
        estimatedTokens: estimated > 0 ? estimated : null,
      };
    };
    const shapes =
      view.groups.length > 0
        ? view.groups.map((group) => ({
            name: group.name as string | null,
            listed: group.models,
            window5h: group.window5h,
            weekly: group.weekly,
          }))
        : [
            {
              name: null as string | null,
              listed: [] as readonly string[],
              window5h: view.window5h,
              weekly: view.weekly,
            },
          ];
    const groups = shapes.map((shape): Group => {
      const window5h = reading(shape.window5h, shape.weekly.usedPct, shape.name, WINDOW_5H_MS);
      const weekly = reading(shape.weekly, shape.window5h.usedPct, shape.name, WEEK_MS);
      return {
        name: shape.name,
        models: modelsOf(shape.name, shape.listed),
        state: groupRule(window5h, weekly, settings),
        window5h,
        weekly,
      };
    });
    return accountFrom(key, view, groups, rows, agents, store, now);
  });

  // An account only the usage log knows of: the provider is not read, or lists it no longer.
  for (const [key, rows] of byKey) {
    if (seen.has(key)) continue;
    const provider = key.split("/")[0] ?? key;
    const prefix = key.includes("/") ? key.slice(provider.length + 1) : null;
    const lost = unread.get(provider) ?? NO_DATA_YET;
    const estimate = (sinceMs: number): Reading => {
      const estimated = tokens(rows, sinceMs);
      return {
        pct: null,
        resetsAt: null,
        source: estimated > 0 ? "estimated" : "none",
        readAt: null,
        stale: false,
        state: lost,
        estimatedTokens: estimated > 0 ? estimated : null,
      };
    };
    const group: Group = {
      name: null,
      models: [...new Set(rows.map((row) => modelIdOf(refOf(row) ?? "")))],
      state: "Sin dato",
      window5h: estimate(WINDOW_5H_MS),
      weekly: estimate(WEEK_MS),
    };
    accounts.push(
      accountFrom(
        key,
        {
          provider,
          credential: `usage:${key}`,
          label: safeLabel(prefix, null, provider),
          kind: null,
          plan: null,
          sampledAt: null,
        },
        [group],
        rows,
        agents,
        store,
        now,
      ),
    );
  }

  const known = new Set(accounts.map((account) => account.provider));
  const seriesOwner = new Map(
    accountViews([...latest, ...lastKnown], settings).map((view) => [view.credential, view]),
  );
  return {
    accounts,
    unread: [...unread]
      .filter(([provider]) => !known.has(provider))
      .map(([provider, state]) => ({ provider, state })),
    thresholds: {
      switchAt5h: settings.switchAtPercent5h,
      stopAtWeekly: settings.stopAtPercentWeekly,
      warnPct: settings.colorWarnPercent,
      dangerPct: settings.colorDangerPercent,
    },
    history: historyOf(history, seriesOwner),
  };
}

function accountFrom(
  key: string,
  view: {
    readonly provider: string;
    readonly credential: string;
    readonly label: string;
    readonly kind: string | null;
    readonly prefix?: string | null;
    readonly plan: string | null;
    readonly sampledAt: number | null;
  },
  groups: Group[],
  rows: readonly UsageRecord[],
  agents: FactoryModel["agents"],
  store: Pick<Store, "quota">,
  now: number,
): Account {
  const cooldown = store.quota.cooldowns(now).find((row) => row.model === `quota:${key}`);
  const outcomes = rows.flatMap((row) => (row.outcome === null ? [] : [row.outcome]));
  const failures = outcomes.filter((outcome) => FAILED_OUTCOME.test(outcome)).length;
  const reported = rows.flatMap((row) => (row.tokensCached === null ? [] : [row.tokensCached]));
  const available = groups.every((group) => group.state === "Disponible");
  const state =
    cooldown !== undefined
      ? `Enfriándose (${cooldown.reason})`
      : available
        ? "Disponible"
        : groups.length === 1
          ? (groups[0] as Group).state
          : groups.map((group) => `${group.name ?? "Cuenta"}: ${group.state}`).join(" · ");
  return {
    id: view.credential,
    provider: view.provider,
    label:
      view.prefix === undefined ? view.label : safeLabel(view.prefix, view.kind, view.credential),
    kind: view.kind,
    plan: view.plan,
    state,
    groups,
    successes: outcomes.length - failures,
    failures,
    holders: agents
      .filter(
        (agent) =>
          agent.status === "running" && agent.model !== null && quotaKeyOf(agent.model) === key,
      )
      .map((agent) => agent.code),
    cachedTokens: reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0),
    inputTokens: rows.reduce((sum, row) => sum + (row.tokensIn ?? 0), 0),
    readAt: view.sampledAt,
  };
}

function historyOf(
  rows: readonly QuotaSampleRecord[],
  owners: ReadonlyMap<string, { readonly prefix: string | null; readonly kind: string | null }>,
): FactoryQuota["history"] {
  const grouped = new Set(
    rows.flatMap((row) =>
      row.group !== undefined && row.credentialRef !== null ? [row.credentialRef] : [],
    ),
  );
  const series = new Map<
    string,
    FactoryQuota["history"][number] & { points: { at: number; pct: number }[] }
  >();
  for (const row of rows) {
    if (row.window !== "5h" || row.credentialRef === null || row.usedPct === null) continue;
    if (row.group === undefined && grouped.has(row.credentialRef)) continue;
    const key = `${row.credentialRef}#${row.group ?? ""}`;
    const owner = owners.get(row.credentialRef);
    const name = safeLabel(owner?.prefix ?? row.prefix, owner?.kind ?? row.kind, row.credentialRef);
    const entry = series.get(key) ?? {
      key,
      label: row.group === undefined ? name : `${name} ${row.group}`,
      points: [],
    };
    entry.points.push({ at: row.sampledAt, pct: row.usedPct });
    series.set(key, entry);
  }
  return [...series.values()].map((entry) => ({
    ...entry,
    points: entry.points.slice(-HISTORY_POINTS),
  }));
}
