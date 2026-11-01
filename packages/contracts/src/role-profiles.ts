// Role profiles (feature haril-factory, F6): a role is data on top of the four archetypes, never a new archetype. Each
// names the archetype it runs as, the models it prefers in order and the lowest tier of model it accepts. A list holds the
// catalog's current ids and then the models to come, so it works today and when more accounts are connected. An entry is
// an exact id or a pattern where "*" stands for any text; it matches across account prefixes (patterns in
// @haril/core's roles.ts). Each role can be changed under delegation.roles.<role> in haril.json. Pure: no I/O.

export const MODEL_TIERS = ["low", "mid", "high"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface RoleProfile {
  readonly archetype: "orchestrator" | "delegator" | "executor" | "auditor";
  readonly models: readonly string[];
  readonly floor: ModelTier;
  readonly enabled: boolean;
}

function role(
  archetype: RoleProfile["archetype"],
  floor: ModelTier,
  models: readonly string[],
): RoleProfile {
  return Object.freeze({ archetype, floor, models: Object.freeze([...models]), enabled: true });
}

export const ROLE_PROFILES = Object.freeze({
  arquitecto: role("orchestrator", "high", [
    "claude-opus-5-5*",
    "gpt-6-astra*",
    "gpt-6.1-sol*",
    "gemini-4-argon*",
    "*claude-opus-4-6*",
  ]),
  sintetizador: role("orchestrator", "high", [
    "claude-opus-5-5*",
    "gpt-6.1-sol*",
    "gemini-4-argon*",
    "*claude-opus-4-6*",
  ]),
  auditor: role("auditor", "high", [
    "gpt-6-astra*",
    "claude-opus-5-5*",
    "gemini-4-argon*",
    "gpt-6.1-sol*",
    "*claude-opus-4-6*",
  ]),
  seguridad: role("auditor", "high", [
    "claude-opus-5-5*",
    "gpt-6.1-sol*",
    "gpt-6-astra*",
    "*claude-opus-4-6*",
  ]),
  consejero: role("auditor", "mid", [
    "claude-opus-5-5*",
    "gpt-6.1-sol*",
    "gemini-4-argon*",
    "deepseek-v4-pro*",
    "*claude-opus-4-6*",
    "*claude-sonnet-4-6*",
    "*gemini-3.8-flash-high*",
  ]),
  "product-owner": role("auditor", "mid", [
    "claude-sonnet-5-5*",
    "gpt-6.1-sol*",
    "gemini-4-argon*",
    "*claude-sonnet-4-6*",
    "*gemini-3.8-flash-high*",
  ]),
  backend: role("executor", "mid", [
    "gpt-6.1-sol*",
    "claude-sonnet-5-5*",
    "deepseek-v4-pro*",
    "*claude-sonnet-4-6*",
    "*claude-opus-4-6*",
  ]),
  frontend: role("executor", "mid", [
    "claude-sonnet-5-5*",
    "gpt-6.1-sol*",
    "claude-opus-5-5*",
    "*claude-sonnet-4-6*",
    "*claude-opus-4-6*",
  ]),
  disenador: role("executor", "mid", [
    "claude-opus-5-5*",
    "gpt-6-astra*",
    "claude-sonnet-5-5*",
    "*claude-opus-4-6*",
    "*claude-sonnet-4-6*",
  ]),
  tester: role("executor", "mid", [
    "claude-sonnet-5-5*",
    "gpt-6.1-terra*",
    "deepseek-v4-pro*",
    "*claude-sonnet-4-6*",
    "*gemini-3.8-flash-high*",
  ]),
  fixer: role("executor", "mid", [
    "gpt-6.1-sol*",
    "claude-sonnet-5-5*",
    "claude-opus-5-5*",
    "*claude-sonnet-4-6*",
    "*claude-opus-4-6*",
  ]),
  investigador: role("executor", "low", [
    "*gemini-3.8-flash*",
    "gpt-6.1-terra*",
    "deepseek-flash*",
    "*gemini-3-flash*",
  ]),
  consultor: role("executor", "low", [
    "claude-haiku-5-5*",
    "deepseek-flash*",
    "*gemini-3.8-flash*",
    "*gemini-3.5-flash-lite*",
    "*gemini-3.1-flash-lite*",
    "*gemini-3-flash*",
  ]),
  sanitizador: role("executor", "low", [
    "gpt-6.1-terra*",
    "deepseek-v4-pro*",
    "*gemini-3.8-flash*",
    "*gemini-3-flash*",
  ]),
  documentador: role("executor", "low", [
    "claude-haiku-5-5*",
    "gpt-6.1-terra*",
    "*gemini-3.5-flash-lite*",
    "*gemini-3-flash*",
  ]),
  git: role("executor", "low", [
    "claude-haiku-5-5*",
    "deepseek-flash*",
    "*gemini-3.5-flash-lite*",
    "*gemini-3.1-flash-lite*",
  ]),
  vigilante: role("executor", "low", [
    "claude-haiku-5-5*",
    "deepseek-flash*",
    "*gemini-3.1-flash-lite*",
  ]),
} satisfies Record<string, RoleProfile>);

export type RoleName = keyof typeof ROLE_PROFILES;
export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_PROFILES)) as readonly RoleName[];
