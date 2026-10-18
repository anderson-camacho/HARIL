import { isStop, type Stop } from "./delegation.js";

// The `delegation` section of haril.json (docs/modos-y-delegacion.md 5, 3.11, 3.12, 3.13, 3.16, 7.7, 7.10; phase F7).
// One table of fields drives everything that reads or writes the section: the validation (every value checked with its
// JSON path, unknown keys refused), the defaults, `haril config get|set` and the console's Delegation section. Keys are
// never stored here: a key-like name (apiKey, managementKey, token...) is refused at any depth, and the management key
// lives in the environment variable that quota.managementKeyEnv names (P7). Pure: no I/O.

// The top-level keys haril.json may hold; anything else is refused with its path.
export const HARIL_CONFIG_TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  "providers",
  "ui",
  "delegation",
]);

export const DELEGATION_LAYERS = ["orchestrator", "delegator", "executor", "auditor"] as const;
export type DelegationLayer = (typeof DELEGATION_LAYERS)[number];

// Pi's reasoning levels (`--thinking`). Whether a model offers one is known only from the live catalog; Pi clamps a
// level the model does not offer to the nearest one it does.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

// Anti-rework (P3, the user's rule): at most one relaunch after a rejected audit and one escalation per task.
export const MAX_REWORK_CAP = 1;

export type DelegationGroup =
  | "context"
  | "limits"
  | "models"
  | "quota"
  | "watchdog"
  | "autonomy"
  | "commands"
  | "git"
  | "research";

// When a change takes effect, as the console says it next to each field.
export type DelegationEffect =
  | "new workflows"
  | "next model choice"
  | "next agent launch"
  | "next runtime start"
  | "next research file";

export type DelegationFieldKind =
  // A whole number in [min, max]. `inherits`: absent means "the value of that field" (a per-layer override).
  | {
      readonly type: "integer";
      readonly min: number;
      readonly max: number;
      readonly unit: "tokens" | "ms" | "count";
      readonly inherits?: string;
    }
  | { readonly type: "percent" }
  | { readonly type: "boolean" }
  // Accepted only as true: the rule it names is the user's, not a knob (residual tasks close at once, R-D14).
  | { readonly type: "always-true" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "env-name" }
  | { readonly type: "url-or-null" }
  | { readonly type: "model-or-null" }
  | { readonly type: "level-or-null" }
  | { readonly type: "model-list" }
  | { readonly type: "command-list" }
  | { readonly type: "stop-list" }
  | { readonly type: "folder" }
  // A local branch name git accepts and HARIL may hand to it, or null (detect it).
  | { readonly type: "branch-or-null" };

type JsonLeaf = string | number | boolean | null | readonly string[];

export interface DelegationField {
  // The path below `delegation`, dot-separated: "limits.maxAuditRetries".
  readonly path: string;
  readonly group: DelegationGroup;
  readonly label: string;
  readonly kind: DelegationFieldKind;
  // null: no value (a nullable field), or "inherits" for a per-layer override.
  readonly default: JsonLeaf;
  readonly effect: DelegationEffect;
}

const int = (
  min: number,
  max: number,
  unit: "tokens" | "ms" | "count",
  inherits?: string,
): DelegationFieldKind =>
  inherits === undefined
    ? { type: "integer", min, max, unit }
    : { type: "integer", min, max, unit, inherits };

// haril_run's allow list when haril.json does not set commands.allow (docs/modos-y-delegacion.md 3.10.5; phase F8): the
// test, build and check commands of the usual toolchains, and the installs a fresh worktree needs (it starts without
// dependencies). Never a shell, never an evaluator such as `node -e`. An entry allows exactly that argv; one ending in
// " *" allows any further arguments. An empty list in the file allows no command at all.
export const DEFAULT_COMMAND_ALLOW: readonly string[] = Object.freeze([
  "npm test",
  "npm test *",
  "npm run test",
  "npm run build",
  "npm run lint",
  "npm run check",
  "npm run typecheck",
  "npm ci",
  "pnpm test",
  "pnpm test *",
  "pnpm run test",
  "pnpm run build",
  "pnpm run lint",
  "pnpm run check",
  "pnpm run typecheck",
  "pnpm install --frozen-lockfile",
  "yarn test",
  "yarn build",
  "yarn lint",
  "node --test",
  "npx vitest run",
  "npx tsc --noEmit",
  "pytest",
  "python -m pytest",
  "go test ./...",
  "go build ./...",
  "cargo test",
  "cargo build",
]);

const CONTEXT_MIN = 32_768;
const CONTEXT_MAX = 10_000_000;
const CHILDREN_MAX = 20;
const WEEK_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

function layerFields(): DelegationField[] {
  const fields: DelegationField[] = [];
  for (const layer of DELEGATION_LAYERS) {
    fields.push({
      path: `context.perLayer.${layer}`,
      group: "context",
      label: `Compact at, ${layer}`,
      kind: int(CONTEXT_MIN, CONTEXT_MAX, "tokens", "context.compactAtTokens"),
      default: null,
      effect: "new workflows",
    });
  }
  return fields;
}

function modelFields(): DelegationField[] {
  const fields: DelegationField[] = [];
  for (const layer of DELEGATION_LAYERS) {
    fields.push(
      {
        path: `models.layers.${layer}.model`,
        group: "models",
        label: `Model, ${layer}`,
        kind: { type: "model-or-null" },
        default: null,
        effect: "next model choice",
      },
      {
        path: `models.layers.${layer}.level`,
        group: "models",
        label: `Reasoning level, ${layer}`,
        kind: { type: "level-or-null" },
        default: null,
        effect: "next agent launch",
      },
    );
  }
  for (const layer of ["delegator", "executor", "auditor"] as const) {
    fields.push({
      path: `models.allow.${layer}`,
      group: "models",
      label: `Allowed models, ${layer}`,
      kind: { type: "model-list" },
      default: [],
      effect: "next model choice",
    });
  }
  fields.push({
    path: "models.auditorDistinctFromExecutor",
    group: "models",
    label: "Auditor on another model than its executor",
    kind: { type: "boolean" },
    default: true,
    effect: "next model choice",
  });
  return fields;
}

// Every field of the section, in the order the console shows them. Section 5's values are the defaults.
export const DELEGATION_FIELDS: readonly DelegationField[] = Object.freeze([
  {
    path: "context.compactAtTokens",
    group: "context",
    label: "Compact at, every layer",
    kind: int(CONTEXT_MIN, CONTEXT_MAX, "tokens"),
    default: 300_000,
    effect: "new workflows",
  },
  ...layerFields(),
  {
    path: "limits.maxActiveChildren.orchestrator",
    group: "limits",
    label: "Live children of the orchestrator",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 5,
    effect: "new workflows",
  },
  {
    path: "limits.maxActiveChildren.delegator",
    group: "limits",
    label: "Live children of a delegator",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 4,
    effect: "new workflows",
  },
  {
    path: "limits.maxConcurrent.executors",
    group: "limits",
    label: "Executors at once",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 5,
    effect: "new workflows",
  },
  {
    path: "limits.maxConcurrent.auditors",
    group: "limits",
    label: "Auditors at once",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 5,
    effect: "new workflows",
  },
  {
    path: "limits.maxConcurrent.delegators",
    group: "limits",
    label: "Delegators at once",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 5,
    effect: "new workflows",
  },
  {
    path: "limits.maxConcurrent.writers",
    group: "limits",
    label: "Writers at once",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 1,
    effect: "new workflows",
  },
  {
    path: "limits.maxQueuedTasksPerThread",
    group: "limits",
    label: "Queued children per thread",
    kind: int(1, 1_000, "count"),
    default: 100,
    effect: "new workflows",
  },
  {
    path: "limits.maxProposalsPerThread",
    group: "limits",
    label: "Proposals per thread",
    kind: int(1, CHILDREN_MAX, "count"),
    default: 3,
    effect: "new workflows",
  },
  {
    path: "limits.maxAgentsPerWorkflow",
    group: "limits",
    label: "Agents per workflow",
    kind: int(1, 1_000, "count"),
    default: 100,
    effect: "new workflows",
  },
  {
    path: "limits.maxAuditRetries",
    group: "limits",
    label: "Relaunches after a rejected audit",
    kind: int(0, MAX_REWORK_CAP, "count"),
    default: 1,
    effect: "new workflows",
  },
  {
    path: "limits.maxEscalationsPerTask",
    group: "limits",
    label: "Escalations per task",
    kind: int(0, MAX_REWORK_CAP, "count"),
    default: 1,
    effect: "new workflows",
  },
  {
    path: "limits.maxWorkflowTokens",
    group: "limits",
    label: "Workflow token budget",
    kind: int(10_000, 1_000_000_000, "tokens"),
    default: 20_000_000,
    effect: "new workflows",
  },
  {
    path: "limits.maxWorkflowWallMs",
    group: "limits",
    label: "Workflow wall time",
    kind: int(60_000, WEEK_MS, "ms"),
    default: 7_200_000,
    effect: "new workflows",
  },
  {
    path: "limits.largeTaskTokens",
    group: "limits",
    label: "A task is large from",
    kind: int(1_000, 10_000_000, "tokens"),
    default: 50_000,
    effect: "new workflows",
  },
  {
    path: "limits.attemptTimeoutMs",
    group: "limits",
    label: "Longest attempt",
    kind: int(10_000, DAY_MS, "ms"),
    default: 3_600_000,
    effect: "new workflows",
  },
  ...modelFields(),
  {
    path: "quota.source",
    group: "quota",
    label: "Quota source",
    kind: { type: "enum", values: ["cliproxyapi-management"] },
    default: "cliproxyapi-management",
    effect: "next model choice",
  },
  {
    path: "quota.managementBaseUrl",
    group: "quota",
    label: "Management server URL",
    kind: { type: "url-or-null" },
    default: null,
    effect: "next model choice",
  },
  {
    path: "quota.managementKeyEnv",
    group: "quota",
    label: "Management key variable",
    kind: { type: "env-name" },
    default: "CLIPROXYAPI_MANAGEMENT_KEY",
    effect: "next model choice",
  },
  {
    path: "quota.switchAtPercent5h",
    group: "quota",
    label: "Switch model above (5-hour window)",
    kind: { type: "percent" },
    default: 80,
    effect: "next model choice",
  },
  {
    path: "quota.stopAtPercentWeekly",
    group: "quota",
    label: "Stop using a model above (week)",
    kind: { type: "percent" },
    default: 80,
    effect: "next model choice",
  },
  {
    path: "quota.minRemainingPercentForLargeTask",
    group: "quota",
    label: "Left for a large task, at least",
    kind: { type: "percent" },
    default: 20,
    effect: "next model choice",
  },
  {
    path: "quota.maxWaitMs",
    group: "quota",
    label: "Longest wait for a quota reset",
    kind: int(0, WEEK_MS, "ms"),
    default: 18_000_000,
    effect: "next model choice",
  },
  {
    path: "watchdog.intervalMs",
    group: "watchdog",
    label: "Check every",
    kind: int(60_000, DAY_MS, "ms"),
    default: 900_000,
    effect: "next runtime start",
  },
  {
    path: "watchdog.idleStrikesToClose",
    group: "watchdog",
    label: "Checks without progress before closing",
    kind: int(1, 10, "count"),
    default: 1,
    effect: "next runtime start",
  },
  {
    path: "watchdog.closeResidualImmediately",
    group: "watchdog",
    label: "Close residual tasks at once",
    kind: { type: "always-true" },
    default: true,
    effect: "next runtime start",
  },
  {
    path: "autonomy.defaultStops",
    group: "autonomy",
    label: "Default stops",
    kind: { type: "stop-list" },
    default: ["after_plan"],
    effect: "new workflows",
  },
  {
    path: "commands.allow",
    group: "commands",
    label: "Commands agents may run",
    kind: { type: "command-list" },
    default: DEFAULT_COMMAND_ALLOW,
    effect: "next runtime start",
  },
  {
    path: "commands.timeoutMs",
    group: "commands",
    label: "Longest command",
    kind: int(1_000, DAY_MS, "ms"),
    default: 300_000,
    effect: "next runtime start",
  },
  {
    path: "commands.outputMaxBytes",
    group: "commands",
    label: "Output kept per stream (bytes)",
    kind: int(1_024, 1_048_576, "count"),
    default: 16_384,
    effect: "next runtime start",
  },
  {
    path: "git.baseBranch",
    group: "git",
    label: "Base branch of writing workflows",
    kind: { type: "branch-or-null" },
    default: null,
    effect: "new workflows",
  },
  {
    path: "research.folder",
    group: "research",
    label: "Research folder (CONSULT)",
    kind: { type: "folder" },
    default: "docs/investigacion",
    effect: "next research file",
  },
] satisfies DelegationField[]);

const FIELD_BY_PATH: ReadonlyMap<string, DelegationField> = new Map(
  DELEGATION_FIELDS.map((field) => [field.path, field]),
);

export function delegationField(path: string): DelegationField | undefined {
  return FIELD_BY_PATH.get(path);
}

// The objects of the section and the keys each may hold, derived from the field paths ("" is the section itself).
const OBJECT_KEYS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const keys = new Map<string, Set<string>>();
  for (const field of DELEGATION_FIELDS) {
    const parts = field.path.split(".");
    for (let index = 0; index < parts.length; index++) {
      const parent = parts.slice(0, index).join(".");
      const set = keys.get(parent) ?? new Set<string>();
      set.add(parts[index] as string);
      keys.set(parent, set);
    }
  }
  return keys;
})();

// Names that would hold a secret: never accepted, at any depth.
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "apikey",
  "managementkey",
  "key",
  "token",
  "secret",
  "password",
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Scheme, host (name, IPv4 or bracketed IPv6), optional port and path, as config.ts checks a provider URL.
const HTTP_URL = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?([/?#]\S*)?$/;
const FOLDER_SEGMENT = /^[A-Za-z0-9._ -]+$/;
// The branch names HARIL hands to git (integrations/git's isSafeBranchName): ASCII letters, digits, "-", "_", "." and
// "/", never starting with "-", never "..", "//" or a trailing "/", no segment starting with "." or ending in ".lock".
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const MAX_LIST = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// A model reference as the gateway lists it: 1 to 200 characters, no whitespace and no control characters.
function isModelRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  );
}

function jsonPath(path: string): string {
  return path === "" ? "/delegation" : `/delegation/${path.split(".").join("/")}`;
}

function wholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function folderProblem(value: string): string | null {
  if (value.trim() === "" || value.length > 200)
    return "must be a folder path of 1 to 200 characters";
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value))
    return "must be a path inside the project, not an absolute path";
  const segments = value.split(/[\\/]/).filter((segment, index, all) => {
    // One trailing separator is allowed ("docs/investigacion/").
    return !(segment === "" && index === all.length - 1);
  });
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      return 'must not hold empty, "." or ".." segments';
    if (!FOLDER_SEGMENT.test(segment))
      return "may hold only letters, digits, spaces, '.', '_' and '-' in each folder name";
  }
  return null;
}

function isBranchName(value: unknown): value is string {
  if (typeof value !== "string" || !BRANCH.test(value)) return false;
  if (value.includes("..") || value.includes("//") || value.endsWith("/")) return false;
  return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function listProblem(
  value: unknown,
  item: (entry: unknown) => boolean,
  what: string,
): string | null {
  if (!Array.isArray(value)) return `must be a list of ${what}`;
  if (value.length > MAX_LIST) return `holds at most ${MAX_LIST} entries`;
  if (!value.every(item)) return `must be a list of ${what}`;
  if (new Set(value).size !== value.length) return "must not repeat an entry";
  return null;
}

// Why a value does not fit its field, or null when it does.
export function delegationValueProblem(field: DelegationField, value: unknown): string | null {
  const kind = field.kind;
  switch (kind.type) {
    case "integer": {
      if (value === null && kind.inherits !== undefined) return null;
      if (wholeNumber(value) && value >= kind.min && value <= kind.max) return null;
      const cap =
        kind.max === MAX_REWORK_CAP && kind.min === 0
          ? " (anti-rework: at most 1 relaunch and 1 escalation)"
          : "";
      return `must be a whole number from ${kind.min} to ${kind.max}${cap}`;
    }
    case "percent":
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
        ? null
        : "must be a number from 0 to 100";
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "always-true":
      return value === true
        ? null
        : "must be true: residual tasks are always closed at once (the user's rule)";
    case "enum":
      return typeof value === "string" && kind.values.includes(value)
        ? null
        : `must be ${kind.values.map((item) => `"${item}"`).join(" or ")}`;
    case "env-name":
      return typeof value === "string" && ENV_NAME.test(value)
        ? null
        : "must be an environment variable name (letters, digits and _)";
    case "url-or-null":
      return value === null || (typeof value === "string" && HTTP_URL.test(value))
        ? null
        : "must be null or an http(s) URL";
    case "model-or-null":
      return value === null || isModelRef(value)
        ? null
        : "must be null or a model reference without spaces (see haril models)";
    case "level-or-null":
      return value === null ||
        (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value))
        ? null
        : `must be null or one of ${THINKING_LEVELS.join(", ")}`;
    case "model-list":
      return listProblem(value, isModelRef, "model references without spaces");
    case "command-list":
      return listProblem(
        value,
        (entry) =>
          typeof entry === "string" &&
          entry.trim() !== "" &&
          entry.length <= 200 &&
          !hasControlCharacter(entry),
        "command names (1 to 200 characters, no control characters)",
      );
    case "stop-list":
      return listProblem(
        value,
        isStop,
        "stops (after_plan, after_node:<id>, before_merge, on_audit_failure, on_budget_pct:<n>, at_end)",
      );
    case "folder":
      return typeof value === "string" ? folderProblem(value) : "must be a folder path";
    case "branch-or-null":
      return value === null || isBranchName(value)
        ? null
        : "must be null (detect main, else the repository's default branch) or a local branch name";
  }
}

function secretKeyError(path: string, key: string): string | null {
  if (!SECRET_KEYS.has(key.toLowerCase())) return null;
  const hint = path.startsWith("quota") || key === "managementKey" ? "; use managementKeyEnv" : "";
  return `${jsonPath(path === "" ? key : `${path}.${key}`)}: keys are never stored in haril.json${hint}`;
}

function walk(path: string, value: unknown, errors: string[]): void {
  const field = FIELD_BY_PATH.get(path);
  if (field !== undefined) {
    const problem = delegationValueProblem(field, value);
    if (problem !== null) errors.push(`${jsonPath(path)}: ${problem}`);
    return;
  }
  const allowed = OBJECT_KEYS.get(path);
  if (allowed === undefined) {
    errors.push(`${jsonPath(path)}: unknown key`);
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${jsonPath(path)}: must be an object`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`;
    const secret = secretKeyError(path, key);
    if (secret !== null) errors.push(secret);
    else if (!allowed.has(key)) errors.push(`${jsonPath(childPath)}: unknown key`);
    else walk(childPath, child, errors);
  }
}

// Every problem of the section, each with its JSON path; empty when it is valid.
export function delegationSectionErrors(value: unknown): string[] {
  const errors: string[] = [];
  walk("", value, errors);
  return errors;
}

// The value a section gives a field: undefined when the section does not set it.
export function configuredValue(section: unknown, path: string): unknown {
  let node: unknown = section;
  for (const part of path.split(".")) {
    if (!isRecord(node) || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

export interface DelegationFieldValue {
  // The full path, "delegation.limits.maxAuditRetries".
  readonly path: string;
  readonly group: DelegationGroup;
  readonly label: string;
  readonly kind: DelegationFieldKind;
  // What applies: the file's value, else the default (for a per-layer override, the value it inherits).
  readonly value: JsonLeaf;
  readonly default: JsonLeaf;
  readonly source: "file" | "default";
  readonly effect: DelegationEffect;
}

// Each field of a section that delegationSectionErrors accepted, with what applies and where it comes from.
export function delegationFieldValues(section: unknown): DelegationFieldValue[] {
  const effective = (field: DelegationField): JsonLeaf => {
    const configured = configuredValue(section, field.path);
    if (configured !== undefined && configured !== null) return configured as JsonLeaf;
    if (field.kind.type === "integer" && field.kind.inherits !== undefined) {
      const parent = FIELD_BY_PATH.get(field.kind.inherits);
      return parent === undefined ? null : effective(parent);
    }
    return configured === null ? null : field.default;
  };
  return DELEGATION_FIELDS.map((field) => ({
    path: `delegation.${field.path}`,
    group: field.group,
    label: field.label,
    kind: field.kind,
    value: effective(field),
    default: field.default,
    source: configuredValue(section, field.path) === undefined ? "default" : "file",
    effect: field.effect,
  }));
}

interface LayerModel {
  readonly model: string | null;
  readonly level: ThinkingLevelName | null;
}

export interface DelegationSettings {
  readonly limits: {
    readonly maxActiveChildren: { readonly orchestrator: number; readonly delegator: number };
    readonly maxQueuedTasksPerThread: number;
    readonly maxProposalsPerThread: number;
    readonly maxConcurrent: {
      readonly executors: number;
      readonly auditors: number;
      readonly delegators: number;
      readonly writers: number;
    };
    readonly maxAgentsPerWorkflow: number;
    readonly maxAuditRetries: number;
    readonly maxEscalationsPerTask: number;
    readonly maxWorkflowTokens: number;
    readonly maxWorkflowWallMs: number;
    readonly largeTaskTokens: number;
    readonly attemptTimeoutMs: number;
  };
  readonly context: {
    readonly compactAtTokens: number;
    readonly perLayer: Partial<Readonly<Record<DelegationLayer, number>>>;
  };
  readonly quota: {
    readonly source: "cliproxyapi-management";
    // The management server's URL; null means the origin of the cliproxy provider's baseUrl.
    readonly managementBaseUrl: string | null;
    readonly managementKeyEnv: string;
    readonly switchAtPercent5h: number;
    readonly stopAtPercentWeekly: number;
    readonly minRemainingPercentForLargeTask: number;
    readonly maxWaitMs: number;
  };
  readonly models: {
    readonly layers: Readonly<Record<DelegationLayer, LayerModel>>;
    readonly allow: Readonly<Record<"delegator" | "executor" | "auditor", readonly string[]>>;
    readonly auditorDistinctFromExecutor: boolean;
  };
  // haril_run's allow list, the longest a command may run (its tree is killed then) and how many bytes of the end of each
  // output stream come back (phase F8).
  readonly commands: {
    readonly allow: readonly string[];
    readonly timeoutMs: number;
    readonly outputMaxBytes: number;
  };
  readonly autonomy: { readonly defaultStops: readonly Stop[] };
  // The branch a writing workflow's worktrees start from (3.10.2); null: main, else the repository's default branch.
  // `haril workflow start --base` wins over it.
  readonly git: { readonly baseBranch: string | null };
  readonly watchdog: {
    readonly intervalMs: number;
    readonly idleStrikesToClose: number;
    readonly closeResidualImmediately: true;
  };
  readonly research: { readonly folder: string };
}

// The settings of a section that delegationSectionErrors accepted (or of no section); absent values take section 5's
// defaults. A per-layer threshold the file does not set stays absent: the general one applies to that layer.
export function resolveDelegationSettings(section: unknown): DelegationSettings {
  const tree: Record<string, unknown> = {};
  for (const field of DELEGATION_FIELDS) {
    const configured = configuredValue(section, field.path);
    const inherits = field.kind.type === "integer" && field.kind.inherits !== undefined;
    const value = configured === undefined ? field.default : configured;
    if (inherits && value === null) continue;
    const parts = field.path.split(".");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node[part] = isRecord(node[part]) ? node[part] : {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1] as string] = Array.isArray(value) ? [...value] : value;
  }
  const context = tree.context as Record<string, unknown>;
  if (!isRecord(context.perLayer)) context.perLayer = {};
  return tree as unknown as DelegationSettings;
}

// The compaction threshold of a layer: its own, else the general one.
export function compactAtFor(settings: DelegationSettings, layer: DelegationLayer): number {
  return settings.context.perLayer[layer] ?? settings.context.compactAtTokens;
}
