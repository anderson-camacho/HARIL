import type { ModelTier, RoleProfile } from "@haril/contracts";
import { MODEL_TIERS } from "@haril/contracts";

// What a role's model list means against a catalog (feature haril-factory, F6): which real models each entry names, and
// how strong a model is. Vendor and tier are read from the model's id alone, so nothing here depends on one account or
// provider. Pure.

// Applied from the top, the first that matches wins, so "flash-high" is read before "flash" and "flash-lite".
const TIER_RULES: readonly (readonly [RegExp, ModelTier])[] = [
  [/opus|astra|argon/, "high"],
  [/haiku/, "low"],
  [/sonnet|terra/, "mid"],
  [/flash-high/, "mid"],
  [/deepseek.*pro/, "mid"],
  [/deepseek.*flash/, "low"],
  [/flash/, "low"],
];
// Sol is a mid model that reaches the high tier only at the maximum reasoning level.
const MAX_LEVEL_HIGH = /sol/;

// Not offered to a role unless its list names them on purpose: an image model cannot do text work, and the open-weight GPT
// models have not been evaluated.
const LEFT_OUT = /image|gpt-oss-/;

const VENDORS: readonly (readonly [RegExp, string])[] = [
  [/claude/, "anthropic"],
  [/gpt|^o\d/, "openai"],
  [/gemini/, "google"],
  [/deepseek/, "deepseek"],
  [/grok/, "xai"],
];

function modelIdOf(ref: string): string {
  return (ref.split("/").pop() ?? ref).toLowerCase();
}

// null: the id says nothing about its strength. Such a model passes no floor but the lowest.
export function modelTier(ref: string, atMaxLevel = false): ModelTier | null {
  const id = modelIdOf(ref);
  if (MAX_LEVEL_HIGH.test(id)) return atMaxLevel ? "high" : "mid";
  return TIER_RULES.find(([rule]) => rule.test(id))?.[1] ?? null;
}

export function meetsFloor(ref: string, floor: ModelTier, atMaxLevel = false): boolean {
  const tier = modelTier(ref, atMaxLevel);
  if (tier === null) return floor === "low";
  return MODEL_TIERS.indexOf(tier) >= MODEL_TIERS.indexOf(floor);
}

export function vendorOf(ref: string): string {
  const id = modelIdOf(ref);
  return VENDORS.find(([rule]) => rule.test(id))?.[1] ?? id.split(/[-_.]/)[0] ?? id;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/\./g, "-");
}

function globMatches(pattern: string, text: string): boolean {
  const body = normalized(pattern)
    .split("*")
    .map((part) => part.replace(/[+?^${}()|[\]\\-]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`).test(normalized(text));
}

// An entry matches a whole reference or the model's own id, on any account prefix, and a dot and a hyphen count as the
// same ("claude-sonnet-4-6" and "claude-sonnet-4.6" are one model to a person).
export function matchesRolePattern(pattern: string, ref: string): boolean {
  return globMatches(pattern, ref) || globMatches(pattern, modelIdOf(ref));
}

// The catalog's models a list names, in the list's order and then the catalog's.
export function expandRoleList(
  entries: readonly string[],
  catalog: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const asked = LEFT_OUT.test(entry.toLowerCase());
    for (const ref of catalog) {
      if (!asked && LEFT_OUT.test(ref.toLowerCase())) continue;
      if (matchesRolePattern(entry, ref) && !out.includes(ref)) out.push(ref);
    }
  }
  return out;
}

export interface RoleWarning {
  readonly role: string;
  readonly vendor: string;
  readonly models: readonly string[];
}

// A role whose list reaches one vendor among the connected models: if that vendor goes down, nobody takes the role.
export function roleVendorWarnings(
  roles: Readonly<Record<string, Pick<RoleProfile, "models" | "enabled">>>,
  catalog: readonly string[],
): RoleWarning[] {
  const warnings: RoleWarning[] = [];
  for (const [role, profile] of Object.entries(roles)) {
    if (!profile.enabled) continue;
    const models = expandRoleList(profile.models, catalog);
    const vendors = [...new Set(models.map(vendorOf))];
    if (vendors.length === 1) {
      warnings.push({ role, vendor: vendors[0] as string, models });
    }
  }
  return warnings;
}
