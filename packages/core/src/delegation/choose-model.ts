import { DIFFICULTIES, type Difficulty } from "@haril/contracts";
import type { DelegationArchetype } from "./archetypes.js";

// Model choice for a delegated agent (docs/modos-y-delegacion.md 3.11). Precedence, inspired by how Codex resolves a
// subagent's model:
//   1. the model the user specified (for the task in the message or card, or for the layer in delegation.models):
//      used exactly as given, never substituted; when its quota blocks it, the task waits or the workflow stops;
//   2. the model the parent proposed, which the Core validates (rejected at proposal time, substituted at launch);
//   3. the difficulty table.
// Quota rule, per quota key (provider or account prefix, ADR-0021 P25), skipped when there is no data ("sin dato"). The
// boundaries follow the user's wording ("más del 80 %", "menos del 20 %"), not the strict formula of 3.11, so exactly
// 80% used and exactly 20% left are still allowed:
//   ok = used5h <= switchAtPercent5h  and  usedWeekly <= stopAtPercentWeekly
//        and (not large or remaining5h >= minRemainingPercentForLargeTask)
// A percentage that is not a number between 0 and 100 makes the whole sample unknown: the rule is skipped, never passed.
// A task is large at difficulty "hard" or above, or with a budget of at least largeTaskTokens.

export interface CatalogModel {
  // The model id as requested from the gateway, for example "Gemini1/gemini-3-flash".
  readonly ref: string;
  // Whose quota it spends: the provider, or the account prefix when CLIProxyAPI exposes one.
  readonly quotaKey: string;
  // Its provider has a key configured.
  readonly hasKey: boolean;
  // End of a 402/429 cooldown (epoch ms), or null.
  readonly coolingUntil: number | null;
}

// One quota reading; a window the provider does not report is null.
export type QuotaSample =
  | {
      readonly available: true;
      readonly window5hUsedPct: number | null;
      readonly window5hResetsAt: number | null;
      readonly weeklyUsedPct: number | null;
      readonly weeklyResetsAt: number | null;
    }
  | { readonly available: false; readonly reason: string };

export interface QuotaPolicy {
  readonly switchAtPercent5h: number;
  readonly stopAtPercentWeekly: number;
  readonly minRemainingPercentForLargeTask: number;
  // The longest a task waits for a reset before the workflow gives up on that model.
  readonly maxWaitMs: number;
}

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = Object.freeze({
  switchAtPercent5h: 80,
  stopAtPercentWeekly: 80,
  minRemainingPercentForLargeTask: 20,
  maxWaitMs: 18_000_000,
});

// config/difficulty.json (3.11): per class, the minimum success rate and the preferred models; per model, its cost.
export interface DifficultyTable {
  readonly classes: Readonly<
    Record<Difficulty, { readonly minSuccessRate: number; readonly order: readonly string[] }>
  >;
  readonly models: Readonly<Record<string, { readonly costTier: number }>>;
}

export interface ModelStat {
  readonly successRate: number;
  readonly samples: number;
}
// model_stats keyed by (model, difficulty class).
export type ModelStats = Readonly<Record<string, Partial<Readonly<Record<Difficulty, ModelStat>>>>>;

export interface ModelSelectionContext {
  readonly now: number;
  readonly catalog: readonly CatalogModel[];
  // delegation.models.allow by archetype; an absent or empty list allows every catalog model.
  readonly allow: Partial<Readonly<Record<DelegationArchetype, readonly string[]>>>;
  // Models the user pinned per layer (delegation.models). null, empty or blank means the layer is not pinned.
  readonly pinned: Partial<Readonly<Record<DelegationArchetype, string | null>>>;
  // Quota by quota key; an absent key means no data.
  readonly quota: Readonly<Record<string, QuotaSample>>;
  readonly table: DifficultyTable;
  readonly stats: ModelStats;
  readonly policy: QuotaPolicy;
  readonly largeTaskTokens: number;
}

export interface ModelRequest {
  readonly archetype: DelegationArchetype;
  readonly difficulty: Difficulty;
  readonly budgetTokens: number;
  // "propose": checking a parent's proposal (an ineligible model is rejected so the parent corrects it).
  // "launch": starting the task (an ineligible proposal is replaced by the next eligible model).
  readonly phase: "propose" | "launch";
  // The model the user specified for this task. Empty or blank counts as none.
  readonly explicit?: string | null;
  // The model the parent proposed.
  readonly proposed?: string | null;
  // For an auditor: its executor's model, avoided when another one is eligible (3.8 rule 2).
  readonly avoid?: string | null;
}

export type ExclusionCause =
  | "not_allowed"
  | "not_in_catalog"
  | "no_key"
  | "cooldown"
  | "window_5h"
  | "weekly"
  | "large_task";

// The problem codes of 3.6 for a proposed model.
export type ModelRejection = "model_not_allowed" | "model_unavailable" | "quota_blocked";

export type ModelChoice =
  | {
      readonly kind: "use";
      readonly model: string;
      readonly source: "pinned" | "parent" | "table";
      readonly reason:
        | "explicit"
        | "layer_pin"
        | "parent"
        | "success_rate"
        | "table_order"
        | "substituted";
      // "no_data" when the quota rule was skipped for lack of data: the view says "sin dato".
      readonly quota: "ok" | "no_data";
      // The parent's model this choice replaced at launch (event model.substituted), or null.
      readonly substitutedFrom: string | null;
      // True when an auditor ended on its executor's model because nothing else was eligible.
      readonly sameAsAvoided: boolean;
    }
  | {
      readonly kind: "reject";
      readonly code: ModelRejection;
      readonly model: string;
      readonly cause: ExclusionCause;
    }
  // Blocked until a known time within maxWaitMs: the task waits (blocked with cooldown_until).
  | {
      readonly kind: "wait";
      readonly model: string | null;
      readonly until: number;
      readonly cause: ExclusionCause;
    }
  // Nothing usable within maxWaitMs: a pinned model stops the workflow; otherwise it fails with no_capacity.
  | {
      readonly kind: "unavailable";
      readonly model: string | null;
      readonly cause: ExclusionCause | null;
    };

export type QuotaStatus =
  | { readonly ok: true; readonly data: "ok" | "no_data" }
  | {
      readonly ok: false;
      readonly cause: "window_5h" | "weekly" | "large_task";
      readonly until: number | null;
    };

const REJECTION: Record<ExclusionCause, ModelRejection> = {
  not_allowed: "model_not_allowed",
  not_in_catalog: "model_unavailable",
  no_key: "model_unavailable",
  cooldown: "quota_blocked",
  window_5h: "quota_blocked",
  weekly: "quota_blocked",
  large_task: "quota_blocked",
};

interface Exclusion {
  readonly cause: ExclusionCause;
  // When the exclusion ends, if known.
  readonly until: number | null;
}

export function isLargeTask(
  difficulty: Difficulty,
  budgetTokens: number,
  largeTaskTokens: number,
): boolean {
  return (
    DIFFICULTIES.indexOf(difficulty) >= DIFFICULTIES.indexOf("hard") ||
    budgetTokens >= largeTaskTokens
  );
}

function validPercent(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
}

// A sample that reports, with every percentage it gives between 0 and 100. NaN, a negative or an above-100 value comes
// from a broken reading: the sample is treated as unknown, never as ok.
function usableSample(
  sample: QuotaSample | undefined,
): Extract<QuotaSample, { available: true }> | null {
  if (sample === undefined || !sample.available) return null;
  if (!validPercent(sample.window5hUsedPct) || !validPercent(sample.weeklyUsedPct)) return null;
  return sample;
}

// The quota rule for one sample. Each window is checked only when it is reported; with neither, the rule is skipped.
export function evaluateQuota(
  sample: QuotaSample | undefined,
  large: boolean,
  policy: QuotaPolicy,
): QuotaStatus {
  const usable = usableSample(sample);
  if (usable === null) return { ok: true, data: "no_data" };
  const { window5hUsedPct: used5h, weeklyUsedPct: usedWeekly } = usable;
  if (used5h === null && usedWeekly === null) return { ok: true, data: "no_data" };
  if (usedWeekly !== null && usedWeekly > policy.stopAtPercentWeekly) {
    return { ok: false, cause: "weekly", until: usable.weeklyResetsAt };
  }
  if (used5h !== null && used5h > policy.switchAtPercent5h) {
    return { ok: false, cause: "window_5h", until: usable.window5hResetsAt };
  }
  if (large && used5h !== null && 100 - used5h < policy.minRemainingPercentForLargeTask) {
    return { ok: false, cause: "large_task", until: usable.window5hResetsAt };
  }
  return { ok: true, data: "ok" };
}

// P4 (until spike S2 said more): a provider served by several accounts counts as its worst account, per window.
export function worstQuota(samples: readonly QuotaSample[]): QuotaSample {
  const reporting = samples.flatMap((sample) => usableSample(sample) ?? []);
  if (reporting.length === 0) return { available: false, reason: "no account reports quota" };
  const worst = (
    pick: (sample: (typeof reporting)[number]) => [number | null, number | null],
  ): [number | null, number | null] => {
    let best: [number | null, number | null] = [null, null];
    for (const sample of reporting) {
      const [pct, resetsAt] = pick(sample);
      if (pct !== null && (best[0] === null || pct > best[0])) best = [pct, resetsAt];
    }
    return best;
  };
  const [window5hUsedPct, window5hResetsAt] = worst((s) => [s.window5hUsedPct, s.window5hResetsAt]);
  const [weeklyUsedPct, weeklyResetsAt] = worst((s) => [s.weeklyUsedPct, s.weeklyResetsAt]);
  return { available: true, window5hUsedPct, window5hResetsAt, weeklyUsedPct, weeklyResetsAt };
}

// Remaining share of the most used window, for the tie-break; -1 when unknown so an unknown quota ranks last.
function remainingQuota(sample: QuotaSample | undefined): number {
  const usable = usableSample(sample);
  if (usable === null) return -1;
  const known = [usable.window5hUsedPct, usable.weeklyUsedPct].filter(
    (pct): pct is number => pct !== null,
  );
  return known.length === 0 ? -1 : 100 - Math.max(...known);
}

function catalogEntry(ref: string, context: ModelSelectionContext): CatalogModel | undefined {
  return context.catalog.find((entry) => entry.ref === ref);
}

// Cooldown and quota: the only things that may hold back a model the user specified.
function usageExclusion(
  entry: CatalogModel | undefined,
  large: boolean,
  context: ModelSelectionContext,
): Exclusion | null {
  if (entry === undefined) return null;
  if (entry.coolingUntil !== null && entry.coolingUntil > context.now) {
    return { cause: "cooldown", until: entry.coolingUntil };
  }
  const quota = evaluateQuota(context.quota[entry.quotaKey], large, context.policy);
  return quota.ok ? null : { cause: quota.cause, until: quota.until };
}

// Why a parent's or the table's model may not run now, or null when it is eligible.
function exclusionOf(
  ref: string,
  archetype: DelegationArchetype,
  large: boolean,
  context: ModelSelectionContext,
): Exclusion | null {
  const allow = context.allow[archetype];
  if (allow !== undefined && allow.length > 0 && !allow.includes(ref)) {
    return { cause: "not_allowed", until: null };
  }
  const entry = catalogEntry(ref, context);
  if (entry === undefined) return { cause: "not_in_catalog", until: null };
  if (!entry.hasKey) return { cause: "no_key", until: null };
  return usageExclusion(entry, large, context);
}

// Whether the quota rule had data for a model already found usable (so its quota, when known, passed).
function quotaData(ref: string, large: boolean, context: ModelSelectionContext): "ok" | "no_data" {
  const entry = catalogEntry(ref, context);
  if (entry === undefined) return "no_data";
  const quota = evaluateQuota(context.quota[entry.quotaKey], large, context.policy);
  return quota.ok && quota.data === "no_data" ? "no_data" : "ok";
}

// Wait for the earliest known end of an exclusion within maxWaitMs, or give up.
function waitOrGiveUp(
  model: string | null,
  exclusions: readonly Exclusion[],
  context: ModelSelectionContext,
): ModelChoice {
  let earliest: Exclusion | null = null;
  for (const exclusion of exclusions) {
    if (exclusion.until === null) continue;
    if (earliest === null || exclusion.until < (earliest.until as number)) earliest = exclusion;
  }
  if (earliest !== null && (earliest.until as number) - context.now <= context.policy.maxWaitMs) {
    return { kind: "wait", model, until: earliest.until as number, cause: earliest.cause };
  }
  return { kind: "unavailable", model, cause: earliest?.cause ?? exclusions[0]?.cause ?? null };
}

function costOf(ref: string, context: ModelSelectionContext): number {
  return context.table.models[ref]?.costTier ?? Number.POSITIVE_INFINITY;
}

function chooseFromTable(
  request: ModelRequest,
  large: boolean,
  context: ModelSelectionContext,
  substitutedFrom: string | null,
): ModelChoice {
  const rule = context.table.classes[request.difficulty];
  // A class that lists no model ranks every catalog model by cost.
  const candidates =
    rule.order.length > 0
      ? [...new Set(rule.order)]
      : context.catalog
          .map((entry) => entry.ref)
          .sort((a, b) => costOf(a, context) - costOf(b, context) || (a < b ? -1 : a > b ? 1 : 0));

  const exclusions: Exclusion[] = [];
  let eligible: string[] = [];
  for (const ref of candidates) {
    const exclusion = exclusionOf(ref, request.archetype, large, context);
    if (exclusion === null) eligible.push(ref);
    else exclusions.push(exclusion);
  }
  if (eligible.length === 0) return waitOrGiveUp(null, exclusions, context);

  const avoid = request.avoid ?? null;
  if (avoid !== null && eligible.some((ref) => ref !== avoid)) {
    eligible = eligible.filter((ref) => ref !== avoid);
  }

  const qualified = eligible.filter((ref) => {
    const stat = context.stats[ref]?.[request.difficulty];
    return stat !== undefined && stat.samples > 0 && stat.successRate >= rule.minSuccessRate;
  });
  let chosen: string;
  let reason: "success_rate" | "table_order";
  if (qualified.length > 0) {
    const quotaOf = (ref: string) =>
      remainingQuota(context.quota[catalogEntry(ref, context)?.quotaKey ?? ""]);
    chosen = [...qualified].sort(
      (a, b) =>
        costOf(a, context) - costOf(b, context) ||
        quotaOf(b) - quotaOf(a) ||
        candidates.indexOf(a) - candidates.indexOf(b),
    )[0] as string;
    reason = "success_rate";
  } else {
    chosen = eligible[0] as string;
    reason = "table_order";
  }
  return {
    kind: "use",
    model: chosen,
    source: "table",
    reason: substitutedFrom === null ? reason : "substituted",
    quota: quotaData(chosen, large, context),
    substitutedFrom,
    sameAsAvoided: chosen === avoid,
  };
}

// A model id the user gave, or null when it is absent, null, empty or blank: such a value never pins a model.
export function modelPin(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function chooseModel(request: ModelRequest, context: ModelSelectionContext): ModelChoice {
  const large = isLargeTask(request.difficulty, request.budgetTokens, context.largeTaskTokens);
  const avoid = request.avoid ?? null;

  // 1. A model the user specified: exactly that one, or a wait, never another model.
  const explicit = modelPin(request.explicit);
  const pinned = explicit ?? modelPin(context.pinned[request.archetype]);
  if (pinned !== null) {
    const exclusion = usageExclusion(catalogEntry(pinned, context), large, context);
    if (exclusion !== null) return waitOrGiveUp(pinned, [exclusion], context);
    return {
      kind: "use",
      model: pinned,
      source: "pinned",
      reason: explicit !== null ? "explicit" : "layer_pin",
      quota: quotaData(pinned, large, context),
      substitutedFrom: null,
      sameAsAvoided: pinned === avoid,
    };
  }

  // 2. The parent's choice, validated.
  const proposed = request.proposed ?? null;
  if (proposed !== null) {
    const exclusion = exclusionOf(proposed, request.archetype, large, context);
    if (exclusion === null) {
      return {
        kind: "use",
        model: proposed,
        source: "parent",
        reason: "parent",
        quota: quotaData(proposed, large, context),
        substitutedFrom: null,
        sameAsAvoided: proposed === avoid,
      };
    }
    if (request.phase === "propose") {
      return {
        kind: "reject",
        code: REJECTION[exclusion.cause],
        model: proposed,
        cause: exclusion.cause,
      };
    }
    return chooseFromTable(request, large, context, proposed);
  }

  // 3. The difficulty table.
  return chooseFromTable(request, large, context, null);
}
