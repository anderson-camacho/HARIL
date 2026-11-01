import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DIFFICULTIES, type Difficulty } from "@haril/contracts";
import type { DifficultyTable, ModelStats } from "@haril/core";
import type { ModelStatRow } from "@haril/core/ports";
import type { HostInfo } from "./context.js";
import { harilConfigPath } from "./providers.js";

// The difficulty table (docs/modos-y-delegacion.md 3.11, R-Q2, R-Q3): per difficulty class, the minimum success rate a
// model needs and the models to try in order; per model, its cost tier; and the success rates the last calibration
// measured. It lives in config/difficulty.json, next to haril.json, as section 3.11 places it: a person reads, edits and
// reviews it like any other setting, and the evidence it is computed from stays in the store (the model_stats view).
// Only `haril difficulty calibrate --yes`, the user's manual trigger, writes it; nothing updates it on its own.
//
// An order entry or a model key is an exact model reference or a pattern where "*" stands for any text ("*flash" is
// every model whose reference ends in "flash", on every account prefix), so one entry follows a model across the
// accounts of CLIProxyAPI (S2). A value the file does not give takes the built-in default below, and every view says
// which one it shows.
//
// The defaults are provisional (P6: the user picks the models in the table): they name model families by their usual
// names, cheapest first, with nothing measured yet. Image models do not match ("*flash" leaves "...flash-image" out).

const DIFFICULTY_FILE = "difficulty.json";

export interface DifficultyFileStat {
  readonly successRate: number;
  readonly samples: number;
}

export interface DifficultyFile {
  readonly schemaVersion: 1;
  readonly classes?: Partial<
    Record<Difficulty, { readonly minSuccessRate?: number; readonly order?: readonly string[] }>
  >;
  readonly models?: Readonly<Record<string, { readonly costTier: number }>>;
  readonly stats?: Readonly<Record<string, Partial<Record<Difficulty, DifficultyFileStat>>>>;
  readonly calibratedAt?: string | null;
}

export type ValueSource = "file" | "default";

interface ClassPolicy {
  readonly minSuccessRate: number;
  readonly order: readonly string[];
  readonly source: { readonly minSuccessRate: ValueSource; readonly order: ValueSource };
}

export interface DifficultyPolicy {
  readonly classes: Readonly<Record<Difficulty, ClassPolicy>>;
  // In the order the first matching pattern wins.
  readonly models: readonly {
    readonly pattern: string;
    readonly costTier: number;
    readonly source: ValueSource;
  }[];
  readonly stats: ModelStats;
  readonly calibratedAt: string | null;
}

const DEFAULT_CLASSES: Readonly<
  Record<Difficulty, { readonly minSuccessRate: number; readonly order: readonly string[] }>
> = {
  trivial: { minSuccessRate: 0.7, order: ["*flash-lite", "*flash"] },
  easy: { minSuccessRate: 0.75, order: ["*flash", "*flash-lite"] },
  medium: { minSuccessRate: 0.8, order: ["*flash", "*flash-high", "*sonnet*"] },
  // Sonnet first: flash-high scored 19.1% on Terminal-Bench 4.0 (a secondary source), too low to lead hard work.
  hard: { minSuccessRate: 0.8, order: ["*sonnet*", "*flash-high", "*pro"] },
  expert: { minSuccessRate: 0.85, order: ["*opus*", "*sonnet*", "*pro"] },
};

const DEFAULT_MODELS: readonly (readonly [string, number])[] = [
  ["*flash-lite", 1],
  ["*flash", 1],
  ["*flash-high", 2],
  ["*sonnet*", 3],
  ["*pro", 3],
  ["*opus*", 4],
];

const FILE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "classes",
  "models",
  "stats",
  "calibratedAt",
]);
const MAX_ORDER = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

function rate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// Every problem of a difficulty file, each with its JSON path; empty when it is valid.
export function difficultyFileErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["/: must be a JSON object"];
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!FILE_KEYS.has(key)) errors.push(`/${key}: unknown key`);
  }
  if (value.schemaVersion !== 1) errors.push("/schemaVersion: must be 1");
  if ("classes" in value) {
    if (!isRecord(value.classes)) errors.push("/classes: must be an object");
    else {
      for (const [name, rule] of Object.entries(value.classes)) {
        const path = `/classes/${name}`;
        if (!isDifficulty(name)) {
          errors.push(`${path}: unknown class (trivial, easy, medium, hard or expert)`);
          continue;
        }
        if (!isRecord(rule)) {
          errors.push(`${path}: must be an object`);
          continue;
        }
        for (const key of Object.keys(rule)) {
          if (key !== "minSuccessRate" && key !== "order")
            errors.push(`${path}/${key}: unknown key`);
        }
        if ("minSuccessRate" in rule && !rate(rule.minSuccessRate)) {
          errors.push(`${path}/minSuccessRate: must be a number from 0 to 1`);
        }
        if (
          "order" in rule &&
          !(
            Array.isArray(rule.order) &&
            rule.order.length <= MAX_ORDER &&
            rule.order.every((item) => typeof item === "string" && item.trim() !== "")
          )
        ) {
          errors.push(`${path}/order: must be a list of up to ${MAX_ORDER} model references`);
        }
      }
    }
  }
  if ("models" in value) {
    if (!isRecord(value.models)) errors.push("/models: must be an object");
    else {
      for (const [pattern, model] of Object.entries(value.models)) {
        const tier = isRecord(model) ? model.costTier : undefined;
        if (
          !isRecord(model) ||
          Object.keys(model).some((key) => key !== "costTier") ||
          !(typeof tier === "number" && Number.isSafeInteger(tier) && tier >= 0 && tier <= 9)
        ) {
          errors.push(`/models/${pattern}: must be {"costTier": a whole number from 0 to 9}`);
        }
      }
    }
  }
  if ("stats" in value) {
    if (!isRecord(value.stats)) errors.push("/stats: must be an object");
    else {
      for (const [model, classes] of Object.entries(value.stats)) {
        if (!isRecord(classes)) {
          errors.push(`/stats/${model}: must be an object`);
          continue;
        }
        for (const [name, stat] of Object.entries(classes)) {
          const ok =
            isDifficulty(name) &&
            isRecord(stat) &&
            rate(stat.successRate) &&
            typeof stat.samples === "number" &&
            Number.isSafeInteger(stat.samples) &&
            stat.samples >= 0 &&
            Object.keys(stat).every((key) => key === "successRate" || key === "samples");
          if (!ok) {
            errors.push(
              `/stats/${model}/${name}: must be {"successRate": 0 to 1, "samples": a whole number} under a class`,
            );
          }
        }
      }
    }
  }
  if (
    "calibratedAt" in value &&
    value.calibratedAt !== null &&
    (typeof value.calibratedAt !== "string" || Number.isNaN(Date.parse(value.calibratedAt)))
  ) {
    errors.push("/calibratedAt: must be null or an ISO date and time");
  }
  return errors;
}

// The table in effect: the file's values over the defaults, each with its source.
export function resolveDifficulty(file: DifficultyFile | undefined): DifficultyPolicy {
  const classes = Object.fromEntries(
    DIFFICULTIES.map((name) => {
      const own = file?.classes?.[name];
      const fallback = DEFAULT_CLASSES[name];
      return [
        name,
        {
          minSuccessRate: own?.minSuccessRate ?? fallback.minSuccessRate,
          order: own?.order ?? fallback.order,
          source: {
            minSuccessRate: own?.minSuccessRate === undefined ? "default" : "file",
            order: own?.order === undefined ? "default" : "file",
          },
        } satisfies ClassPolicy,
      ];
    }),
  ) as unknown as Record<Difficulty, ClassPolicy>;
  const models =
    file?.models === undefined
      ? DEFAULT_MODELS.map(([pattern, costTier]) => ({
          pattern,
          costTier,
          source: "default" as const,
        }))
      : Object.entries(file.models).map(([pattern, model]) => ({
          pattern,
          costTier: model.costTier,
          source: "file" as const,
        }));
  const stats: Record<
    string,
    Partial<Record<Difficulty, { successRate: number; samples: number }>>
  > = {};
  for (const [model, byClass] of Object.entries(file?.stats ?? {})) {
    stats[model] = { ...byClass };
  }
  return { classes, models, stats, calibratedAt: file?.calibratedAt ?? null };
}

// "*" stands for any text; everything else matches itself.
export function matchesPattern(pattern: string, ref: string): boolean {
  if (!pattern.includes("*")) return pattern === ref;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(ref);
}

// The table Core's chooseModel reads, its patterns expanded against the catalog: an order lists the catalog's models
// that match each entry, in the entry's order and the catalog's; a model's cost tier is that of its first matching key.
// An exact reference the catalog does not list stays (chooseModel then finds it unavailable).
export function tableFor(policy: DifficultyPolicy, catalog: readonly string[]): DifficultyTable {
  const expand = (entries: readonly string[]): string[] => {
    const out: string[] = [];
    for (const entry of entries) {
      const found = entry.includes("*")
        ? catalog.filter((ref) => matchesPattern(entry, ref))
        : [entry];
      for (const ref of found) if (!out.includes(ref)) out.push(ref);
    }
    return out;
  };
  const classes = Object.fromEntries(
    DIFFICULTIES.map((name) => [
      name,
      {
        minSuccessRate: policy.classes[name].minSuccessRate,
        order: expand(policy.classes[name].order),
      },
    ]),
  ) as unknown as DifficultyTable["classes"];
  const models: Record<string, { costTier: number }> = {};
  for (const ref of catalog) {
    const match = policy.models.find((model) => matchesPattern(model.pattern, ref));
    if (match !== undefined) models[ref] = { costTier: match.costTier };
  }
  return { classes, models };
}

function difficultyPath(host: HostInfo): string {
  return join(dirname(harilConfigPath(host).path), DIFFICULTY_FILE);
}

export type DifficultyLoad =
  | {
      readonly ok: true;
      readonly path: string;
      readonly exists: boolean;
      readonly file: DifficultyFile | undefined;
      readonly policy: DifficultyPolicy;
    }
  | { readonly ok: false; readonly path: string; readonly errors: string[] };

export function loadDifficulty(host: HostInfo): DifficultyLoad {
  const path = difficultyPath(host);
  if (!existsSync(path)) {
    return { ok: true, path, exists: false, file: undefined, policy: resolveDifficulty(undefined) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return { ok: false, path, errors: ["the file is not valid JSON"] };
  }
  const errors = difficultyFileErrors(parsed);
  if (errors.length > 0) return { ok: false, path, errors };
  const file = parsed as DifficultyFile;
  return { ok: true, path, exists: true, file, policy: resolveDifficulty(file) };
}

interface StatChange {
  readonly model: string;
  readonly difficulty: Difficulty;
  readonly before: DifficultyFileStat | null;
  readonly after: DifficultyFileStat | null;
}

export interface Calibration {
  readonly file: DifficultyFile;
  readonly changes: readonly StatChange[];
}

// The manual recalibration (R-Q3, step 3): success rates from the model_stats view, which holds only real executor runs
// (simulated rows are left out by the view). A run counts once an auditor judged it; a model and class with no judged
// run have no rate. The rest of the file stays as the user wrote it.
export function calibrate(
  file: DifficultyFile | undefined,
  rows: readonly ModelStatRow[],
  now: number,
): Calibration {
  const stats: Record<string, Partial<Record<Difficulty, DifficultyFileStat>>> = {};
  for (const row of rows) {
    const samples = row.approved + row.rejected;
    if (samples === 0 || !isDifficulty(row.difficulty)) continue;
    const successRate = Math.round((row.approved / samples) * 1000) / 1000;
    stats[row.model] = { ...(stats[row.model] ?? {}), [row.difficulty]: { successRate, samples } };
  }
  const before = file?.stats ?? {};
  const changes: StatChange[] = [];
  const models = [...new Set([...Object.keys(before), ...Object.keys(stats)])].sort();
  for (const model of models) {
    for (const difficulty of DIFFICULTIES) {
      const old = before[model]?.[difficulty] ?? null;
      const next = stats[model]?.[difficulty] ?? null;
      if (old?.successRate === next?.successRate && old?.samples === next?.samples) continue;
      changes.push({ model, difficulty, before: old, after: next });
    }
  }
  return {
    file: {
      ...(file ?? { schemaVersion: 1 }),
      schemaVersion: 1,
      stats,
      calibratedAt: new Date(now).toISOString(),
    },
    changes,
  };
}

// Writes the file whole, through a temporary file, so a reader never sees half of it.
export function writeDifficultyFile(path: string, file: DifficultyFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
