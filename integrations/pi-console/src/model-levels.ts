import type { PiModel, ThinkingLevel, ThinkingLevelMap } from "./pi-types.js";

// The reasoning levels of each HARIL model (FM, docs/modos-y-delegacion.md 7.10; ADR-0021 P24 and S8). Where they
// come from, in order:
//   (a) the gateway's `GET /models?client_version=` listing (CLIProxyAPI publishes supported_reasoning_levels,
//       default_reasoning_level, context_window and max_tokens there, and only there);
//   (b) Pi's own catalog, matched by normalized name, copying `reasoning` and `thinkingLevelMap`;
//   (d) otherwise no published levels: the model is registered as not reasoning, so Pi offers only "off" (asking
//       CLIProxyAPI for a level a model does not support is an error).
// A gateway listing that describes the model decides on its own, even with no levels: that is the gateway's answer,
// and Pi's catalog describes the provider's native API, not the gateway's route. (c), an editable family table, is
// not part of FM. Pure: no I/O and no runtime imports, so it can be loaded on its own.
//
// Levels are sent as reasoning_effort (P27, never a model(level) suffix): Pi sends thinkingLevelMap[level] ?? level
// for an OpenAI-compatible model that reasons (pi-ai openai-completions.js). Pi's levels are off, minimal, low,
// medium, high, xhigh and max; the gateway's are none, auto, minimal, low, medium, high, xhigh and max. The five
// shared levels map to themselves, "none" is what Pi's "off" sends when the model publishes it (otherwise "off" is
// not offered, since sending nothing lets the model think at its default), and "auto" has no Pi level, so it is
// never offered.

export const GATEWAY_CLIENT_VERSION = "0.99.0";

const GATEWAY_LEVELS: ReadonlySet<string> = new Set([
  "none",
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PI_LEVELS: readonly ThinkingLevel[] = ["off", ...REASONING_LEVELS];

// What the gateway's listing says about one model. `levels` is undefined when the listing does not describe levels
// at all (a plain OpenAI listing), and empty when it describes the model and publishes none.
export interface ModelDetail {
  readonly id: string;
  readonly displayName: string | undefined;
  readonly contextWindow: number | undefined;
  readonly maxTokens: number | undefined;
  readonly levels: readonly string[] | undefined;
  readonly defaultLevel: string | undefined;
}

export interface ReasoningFacts {
  readonly reasoning: boolean;
  readonly thinkingLevelMap: ThinkingLevelMap | undefined;
  readonly source: "gateway" | "pi-catalog" | "none";
  // The gateway's default level, when it is one the model offers.
  readonly defaultLevel: ThinkingLevel | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function gatewayLevel(value: unknown): string | undefined {
  const level = text(value)?.toLowerCase();
  return level !== undefined && GATEWAY_LEVELS.has(level) ? level : undefined;
}

// A level entry is a string ("high") or an object with an effort ({ effort: "high", description }).
function levelsOf(value: unknown): string[] {
  const levels: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const level = gatewayLevel(typeof entry === "string" ? entry : record(entry)?.effort);
    if (level !== undefined && !levels.includes(level)) levels.push(level);
  }
  return levels;
}

// The models of a `?client_version=` listing by id. The array is `models` (CLIProxyAPI) or `data`, the id is `slug`
// or `id`. Undefined for anything that is not a listing; the first entry of a repeated id wins.
export function parseModelDetails(body: unknown): Map<string, ModelDetail> | undefined {
  const listing = record(body);
  if (listing === undefined) return undefined;
  const items = Array.isArray(listing.models)
    ? listing.models
    : Array.isArray(listing.data)
      ? listing.data
      : undefined;
  if (items === undefined) return undefined;
  const entries = items.map(record).filter((item) => item !== undefined);
  const describesLevels =
    Array.isArray(listing.models) ||
    entries.some(
      (item) =>
        "supported_reasoning_levels" in item ||
        "default_reasoning_level" in item ||
        text(item.slug) !== undefined,
    );
  const details = new Map<string, ModelDetail>();
  for (const item of entries) {
    const id = text(item.slug) ?? text(item.id);
    if (id === undefined || details.has(id)) continue;
    details.set(id, {
      id,
      displayName: text(item.display_name),
      contextWindow: count(item.context_window) ?? count(item.context_length),
      maxTokens: count(item.max_tokens) ?? count(item.max_output_tokens),
      levels: describesLevels ? levelsOf(item.supported_reasoning_levels) : undefined,
      defaultLevel: describesLevels ? gatewayLevel(item.default_reasoning_level) : undefined,
    });
  }
  return details;
}

// A model name compared across catalogs: lower case, without the provider or account prefix (`Gemini1/…`,
// `google/…`) and without the variant suffixes that name the same model (`-preview`, `-latest`, a date).
export function normalizeModelName(id: string): string {
  let name = (id.split("/").pop() ?? id).toLowerCase();
  const suffixes = [
    /-(?:preview|latest)$/,
    /-\d{8}$/,
    /-\d{4}-\d{2}-\d{2}$/,
    /-preview-\d{2}-\d{2}$/,
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of suffixes) {
      const shorter = name.replace(suffix, "");
      if (shorter !== name && shorter !== "") {
        name = shorter;
        changed = true;
      }
    }
  }
  return name;
}

// The catalog model a gateway model stands for: the same id, else the same normalized name. `skip` leaves out
// HARIL's own providers, which would only find the model itself.
export function findCatalogModel(
  id: string,
  catalog: readonly PiModel[],
  skip: (model: PiModel) => boolean,
): PiModel | undefined {
  const candidates = catalog.filter((model) => !skip(model));
  const exact = candidates.find((model) => model.id === id);
  if (exact !== undefined) return exact;
  const name = normalizeModelName(id);
  return candidates.find((model) => normalizeModelName(model.id) === name);
}

// The level map of the levels the gateway publishes; undefined when none of them is one of Pi's.
export function levelMapFromGateway(levels: readonly string[]): ThinkingLevelMap | undefined {
  const published = new Set(levels);
  if (!REASONING_LEVELS.some((level) => published.has(level))) return undefined;
  const map: Partial<Record<ThinkingLevel, string | null>> = {
    off: published.has("none") ? "none" : null,
  };
  for (const level of REASONING_LEVELS) map[level] = published.has(level) ? level : null;
  return map;
}

// A level map from Pi's catalog made safe for the gateway: a value the gateway does not know marks the level as
// unsupported, and an unknown "off" value is dropped (off then sends nothing).
export function gatewayLevelMap(map: ThinkingLevelMap | undefined): ThinkingLevelMap | undefined {
  if (map === undefined) return undefined;
  const safe: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const level of PI_LEVELS) {
    const value = map[level];
    if (value === undefined) continue;
    if (value === null || GATEWAY_LEVELS.has(value)) safe[level] = value;
    else if (level !== "off") safe[level] = null;
  }
  return safe;
}

// The levels Pi offers for a model, as Pi 1.2.0 computes them (pi-ai models.js getSupportedThinkingLevels): only
// "off" without reasoning; otherwise every level the map does not set to null, with xhigh and max only when mapped.
export function supportedLevels(model: {
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap | undefined;
}): ThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  return PI_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

function piLevel(gateway: string | undefined): ThinkingLevel | undefined {
  if (gateway === "none") return "off";
  return PI_LEVELS.find((level) => level !== "off" && level === gateway);
}

const NO_LEVELS: ReasoningFacts = {
  reasoning: false,
  thinkingLevelMap: undefined,
  source: "none",
  defaultLevel: undefined,
};

// Whether a model reasons and which levels it offers, from the gateway's detail (a) or Pi's catalog (b), else (d).
export function reasoningFor(
  detail: ModelDetail | undefined,
  known: PiModel | undefined,
): ReasoningFacts {
  if (detail?.levels !== undefined) {
    const map = levelMapFromGateway(detail.levels);
    if (map === undefined) return NO_LEVELS;
    const fallback = piLevel(detail.defaultLevel);
    const offered = supportedLevels({ reasoning: true, thinkingLevelMap: map });
    return {
      reasoning: true,
      thinkingLevelMap: map,
      source: "gateway",
      defaultLevel: fallback !== undefined && offered.includes(fallback) ? fallback : undefined,
    };
  }
  if (known?.reasoning === true) {
    const map = gatewayLevelMap(known.thinkingLevelMap);
    const offered = supportedLevels({ reasoning: true, thinkingLevelMap: map });
    if (!offered.some((level) => level !== "off")) return NO_LEVELS;
    return {
      reasoning: true,
      thinkingLevelMap: map,
      source: "pi-catalog",
      defaultLevel: undefined,
    };
  }
  return NO_LEVELS;
}

// What the bar and the headers show next to the model: its level, or that it does not reason.
export function levelLabel(
  model: PiModel | undefined,
  level: ThinkingLevel | undefined,
): string | undefined {
  if (model === undefined) return undefined;
  if (model.reasoning !== true) return "no reasoning";
  return level ?? "unknown";
}

// A token count in a few characters: 1M, 2.1M, 200k, 512.
export function tokenCount(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
