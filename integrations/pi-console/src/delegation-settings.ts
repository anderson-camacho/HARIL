// The delegation settings as the console shows and edits them (docs/modos-y-delegacion.md 7.7; phase F7). They come from
// `haril config get delegation --json`: every field of haril.json's delegation section with its value, its default, its
// source (the file or the default), its kind (which says the valid range) and when a change takes effect. The shape is
// HARIL's DelegationFieldValue (@haril/contracts); the console keeps this local copy because it imports no other
// workspace (check-layers R6). Edits go back through `haril config set`, which checks them again. Pure: no I/O.

type SettingKind =
  | {
      readonly type: "integer";
      readonly min: number;
      readonly max: number;
      readonly unit: "tokens" | "ms" | "count";
      readonly inherits?: string;
    }
  | { readonly type: "percent" }
  | { readonly type: "boolean" }
  | { readonly type: "always-true" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "env-name" }
  | { readonly type: "url-or-null" }
  | { readonly type: "model-or-null" }
  | { readonly type: "level-or-null" }
  | { readonly type: "model-list" }
  | { readonly type: "command-list" }
  | { readonly type: "stop-list" }
  | { readonly type: "folder" };

export type SettingValue = string | number | boolean | null | readonly string[];

export interface SettingField {
  readonly path: string;
  readonly group: string;
  readonly label: string;
  readonly kind: SettingKind;
  readonly value: SettingValue;
  readonly default: SettingValue;
  readonly source: "file" | "default";
  readonly effect: string;
}

export interface DelegationView {
  readonly configPath: string;
  readonly fields: readonly SettingField[];
}

export const GROUP_TITLES: Readonly<Record<string, string>> = {
  context: "CONTEXT",
  limits: "LIMITS",
  models: "MODELS AND LEVELS",
  quota: "QUOTA",
  watchdog: "WATCHDOG",
  autonomy: "AUTONOMY",
  commands: "COMMANDS",
  research: "RESEARCH (CONSULT)",
};

export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const KIND_TYPES: ReadonlySet<string> = new Set([
  "integer",
  "percent",
  "boolean",
  "always-true",
  "enum",
  "env-name",
  "url-or-null",
  "model-or-null",
  "level-or-null",
  "model-list",
  "command-list",
  "stop-list",
  "folder",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function settingValue(value: unknown): value is SettingValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function decodeField(value: unknown): SettingField | undefined {
  const row = record(value);
  const kind = record(row?.kind);
  if (
    row === undefined ||
    kind === undefined ||
    typeof row.path !== "string" ||
    !row.path.startsWith("delegation.") ||
    typeof row.group !== "string" ||
    typeof row.label !== "string" ||
    typeof row.effect !== "string" ||
    (row.source !== "file" && row.source !== "default") ||
    typeof kind.type !== "string" ||
    !KIND_TYPES.has(kind.type) ||
    !settingValue(row.value) ||
    !settingValue(row.default)
  ) {
    return undefined;
  }
  if (
    kind.type === "integer" &&
    (typeof kind.min !== "number" || typeof kind.max !== "number" || typeof kind.unit !== "string")
  ) {
    return undefined;
  }
  return {
    path: row.path,
    group: row.group,
    label: row.label,
    kind: kind as unknown as SettingKind,
    value: row.value,
    default: row.default,
    source: row.source,
    effect: row.effect,
  };
}

// The view of `haril config get delegation --json`, or undefined when the output is not that.
export function decodeDelegationView(value: unknown): DelegationView | undefined {
  const root = record(value);
  if (root === undefined || !Array.isArray(root.fields) || typeof root.configPath !== "string") {
    return undefined;
  }
  const fields: SettingField[] = [];
  for (const item of root.fields) {
    const field = decodeField(item);
    if (field === undefined) return undefined;
    fields.push(field);
  }
  return fields.length === 0 ? undefined : { configPath: root.configPath, fields };
}

export function fieldAt(view: DelegationView, path: string): SettingField | undefined {
  return view.fields.find((field) => field.path === path);
}

// 300000 → "300,000"; 1048576 → "1,048,576".
function groupedNumber(value: number): string {
  const [whole, fraction] = String(value).split(".");
  const grouped = (whole ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

// 900000 → "15 min"; 7200000 → "2 h"; 5400000 → "1 h 30 min"; 45000 → "45 s".
function durationText(ms: number): string {
  if (ms === 0) return "0 s";
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3_600],
    ["min", 60],
    ["s", 1],
  ] as const) {
    const amount = Math.floor(rest / size);
    if (amount > 0) parts.push(`${amount} ${unit}`);
    rest -= amount * size;
  }
  return parts.slice(0, 2).join(" ");
}

function integerText(value: number, unit: "tokens" | "ms" | "count"): string {
  if (unit === "ms") return durationText(value);
  return unit === "tokens" ? `${groupedNumber(value)} tokens` : groupedNumber(value);
}

function listText(field: SettingField, list: readonly string[]): string {
  if (list.length > 0) return list.join(", ");
  if (field.kind.type === "model-list") return "every model";
  if (field.kind.type === "stop-list") return "none (autonomous)";
  return "none";
}

// What a field holds, as the console writes it.
export function valueText(field: SettingField, value: SettingValue = field.value): string {
  const kind = field.kind;
  if (Array.isArray(value)) return listText(field, value);
  switch (kind.type) {
    case "integer":
      return typeof value === "number" ? integerText(value, kind.unit) : "inherits";
    case "percent":
      return typeof value === "number" ? `${value} %` : String(value);
    case "boolean":
      return value === true ? "yes" : "no";
    case "always-true":
      return "always";
    case "url-or-null":
      return value === null ? "the cliproxy provider's server" : String(value);
    case "model-or-null":
      return value === null ? "not pinned" : String(value);
    case "level-or-null":
      return value === null ? "gateway default" : String(value);
    default:
      return value === null ? "not set" : String(value);
  }
}

// Where the value comes from, shown next to it.
export function sourceText(field: SettingField): string {
  if (field.source === "file") return "haril.json";
  return field.kind.type === "integer" && field.kind.inherits !== undefined
    ? "inherits"
    : "default";
}

// The valid values of a field, as the footer and the edit dialogs say them.
export function rangeText(field: SettingField): string {
  const kind = field.kind;
  switch (kind.type) {
    case "integer": {
      if (kind.min === 0 && kind.max === 1) return "0 or 1 (anti-rework: at most 1)";
      const range = `${integerText(kind.min, kind.unit)} to ${integerText(kind.max, kind.unit)}`;
      return kind.inherits === undefined ? range : `${range}, or empty to inherit`;
    }
    case "percent":
      return "0 to 100 %";
    case "boolean":
      return "yes or no";
    case "always-true":
      return "always on: residual tasks close at once (your rule)";
    case "enum":
      return kind.values.join(" or ");
    case "env-name":
      return "the NAME of an environment variable, never the key itself";
    case "url-or-null":
      return "an http(s) URL, or empty for the cliproxy provider's server";
    case "model-or-null":
      return "a model from haril models, or not pinned (the parent or the table chooses)";
    case "level-or-null":
      return "a level the layer's model publishes, or the gateway default";
    case "model-list":
      return "models from haril models; none allows every model";
    case "command-list":
      return "command names; none allows no command";
    case "stop-list":
      return "after_plan, after_node:<id>, before_merge, on_audit_failure, on_budget_pct:<n>, at_end";
    case "folder":
      return "a folder inside the project";
  }
}

export function effectText(field: SettingField): string {
  return `affects ${field.effect}`;
}

export type ParsedEntry =
  | { readonly ok: true; readonly arg: string; readonly value: SettingValue }
  | { readonly ok: false; readonly error: string };

const SCALE: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };
const DURATION: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  min: 60_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// A whole number typed for a field: "300000", "300,000", "300_000" or "300k" for tokens and counts, "15 min", "90s" or
// "2h" (or plain milliseconds) for a duration. Undefined when it does not read as one.
function typedInteger(text: string, unit: "tokens" | "ms" | "count"): number | undefined {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[,_\s]/g, "");
  if (/^\d+$/.test(word)) return Number(word);
  const match = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(word);
  if (match === null) return undefined;
  const factor = unit === "ms" ? DURATION[match[2] as string] : SCALE[match[2] as string];
  if (factor === undefined) return undefined;
  const value = Number(match[1]) * factor;
  return Number.isSafeInteger(value) ? value : undefined;
}

// What the user typed for a text field, checked as HARIL will check it, and the argument for `haril config set`.
export function parseEntry(field: SettingField, text: string): ParsedEntry {
  const kind = field.kind;
  const word = text.trim();
  switch (kind.type) {
    case "integer": {
      if (word === "" && kind.inherits !== undefined) return { ok: true, arg: "null", value: null };
      const value = typedInteger(word, kind.unit);
      if (value === undefined || value < kind.min || value > kind.max) {
        return { ok: false, error: `${field.label}: ${rangeText(field)}` };
      }
      return { ok: true, arg: String(value), value };
    }
    case "percent": {
      const value = Number(word.replace(/%$/, "").trim());
      if (word === "" || !Number.isFinite(value) || value < 0 || value > 100) {
        return { ok: false, error: `${field.label}: ${rangeText(field)}` };
      }
      return { ok: true, arg: String(value), value };
    }
    case "env-name":
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)
        ? { ok: true, arg: word, value: word }
        : { ok: false, error: `${field.label}: ${rangeText(field)}` };
    case "url-or-null":
      if (word === "") return { ok: true, arg: "null", value: null };
      return /^https?:\/\/\S+$/.test(word)
        ? { ok: true, arg: word, value: word }
        : { ok: false, error: `${field.label}: ${rangeText(field)}` };
    case "folder":
      return word !== "" && !/^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(word)
        ? { ok: true, arg: word, value: word }
        : { ok: false, error: `${field.label}: ${rangeText(field)}` };
    default:
      return { ok: true, arg: word, value: word };
  }
}

// A list as `haril config set` reads it: a JSON array.
export function listArg(list: readonly string[]): string {
  return JSON.stringify(list);
}

// HARIL's model reference of a Pi model the console registered (provider haril-<id>), else undefined: only HARIL's
// providers serve agents.
export function harilRefOf(model: {
  readonly provider: string;
  readonly id: string;
}): string | undefined {
  return model.provider.startsWith("haril-")
    ? `${model.provider.slice("haril-".length)}/${model.id}`
    : undefined;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

// The TOOLS panel's short lines about the section: context per layer, limits, watchdog and stops.
export function delegationSummary(view: DelegationView): string[] {
  const value = (path: string): SettingValue | undefined =>
    fieldAt(view, `delegation.${path}`)?.value;
  const number = (path: string): number => {
    const found = value(path);
    return typeof found === "number" ? found : 0;
  };
  const general = number("context.compactAtTokens");
  const own = ["orchestrator", "delegator", "executor", "auditor"]
    .map((layer) => [layer, fieldAt(view, `delegation.context.perLayer.${layer}`)] as const)
    .filter(([, field]) => field?.source === "file" && typeof field.value === "number")
    .map(([layer, field]) => `${layer} ${compact(field?.value as number)}`);
  const stops = value("autonomy.defaultStops");
  const pinned = ["orchestrator", "delegator", "executor", "auditor"].filter(
    (layer) =>
      value(`models.layers.${layer}.model`) !== null ||
      value(`models.layers.${layer}.level`) !== null,
  );
  const fromFile = view.fields.filter((field) => field.source === "file").length;
  return [
    `Delegation: compact at ${compact(general)}${own.length === 0 ? "" : ` (${own.join(", ")})`} · watchdog ${durationText(number("watchdog.intervalMs"))} · models set for ${pinned.length === 0 ? "no layer" : pinned.join(", ")}`,
    `Delegation limits: children ${number("limits.maxActiveChildren.orchestrator")}/${number("limits.maxActiveChildren.delegator")} · at once ${number("limits.maxConcurrent.executors")} executors, ${number("limits.maxConcurrent.auditors")} auditors · stops ${Array.isArray(stops) && stops.length > 0 ? stops.join(", ") : "none"} · ${fromFile} from haril.json`,
  ];
}
