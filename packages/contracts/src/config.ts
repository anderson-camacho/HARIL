import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Provider configuration read from haril.json (M3-T7, ACE-06). The file never holds a key: keyEnv names the
// environment variable that does, and a literal apiKey field is refused before anything else is checked.

export const PROVIDER_ID_PATTERN = "^[a-z][a-z0-9-]{0,31}$";
const ENV_NAME_PATTERN = "^[A-Z_][A-Z0-9_]{0,127}$";
const MAX_PROVIDERS = 16;

export const ProviderConfigSchema = Type.Object(
  {
    id: Type.String({ pattern: PROVIDER_ID_PATTERN }),
    baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    keyEnv: Type.Optional(Type.String({ pattern: ENV_NAME_PATTERN })),
  },
  { additionalProperties: false },
);
export type ProviderConfig = Static<typeof ProviderConfigSchema>;

export const UiLocaleSchema = Type.Union([Type.Literal("es"), Type.Literal("en")]);
export type UiLocale = Static<typeof UiLocaleSchema>;
export const DEFAULT_UI_LOCALE: UiLocale = "es";

export const UiConfigSchema = Type.Object(
  {
    theme: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
    locale: Type.Optional(UiLocaleSchema),
    plugins: Type.Optional(
      Type.Array(
        Type.Object(
          { id: Type.String(), visible: Type.Boolean() },
          { additionalProperties: false },
        ),
        // Four dock slots today; a file written before the TREE slot was removed may still hold five.
        { maxItems: 5 },
      ),
    ),
  },
  { additionalProperties: false },
);
export type UiConfig = Static<typeof UiConfigSchema>;

export function isUiLocale(value: unknown): value is UiLocale {
  return Value.Check(UiLocaleSchema, value);
}

export function effectiveUiLocale(ui: Pick<UiConfig, "locale"> | undefined): UiLocale {
  return ui?.locale ?? DEFAULT_UI_LOCALE;
}

export const HarilConfigSchema = Type.Object(
  {
    providers: Type.Array(ProviderConfigSchema, { minItems: 1, maxItems: MAX_PROVIDERS }),
    ui: Type.Optional(UiConfigSchema),
  },
  { additionalProperties: false },
);
export type HarilConfig = Static<typeof HarilConfigSchema>;

export type HarilConfigValidation =
  | { readonly ok: true; readonly config: HarilConfig }
  | { readonly ok: false; readonly errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Scheme, host (name, IPv4 or bracketed IPv6), optional port and path. The contracts package has no URL global.
const HTTP_URL = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?([/?#]\S*)?$/;

function isHttpUrl(text: string): boolean {
  return HTTP_URL.test(text);
}

// Schema check of a parsed haril.json, plus the rules a schema cannot state: no key literal, http(s) URLs
// and unique provider ids. Every problem is reported with its JSON path.
export function validateHarilConfig(value: unknown): HarilConfigValidation {
  if (!isRecord(value) || !Array.isArray(value.providers)) {
    return { ok: false, errors: ["/providers: must be an array of provider entries"] };
  }
  const keyErrors: string[] = [];
  if ("apiKey" in value) {
    keyErrors.push("/apiKey: keys are never stored in haril.json; use keyEnv");
  }
  value.providers.forEach((entry, index) => {
    if (isRecord(entry) && "apiKey" in entry) {
      keyErrors.push(
        `/providers/${index}/apiKey: keys are never stored in haril.json; use keyEnv with an environment variable name`,
      );
    }
  });
  if (keyErrors.length > 0) return { ok: false, errors: keyErrors };

  const errors: string[] = [];
  const seen = new Set<string>();
  value.providers.forEach((entry, index) => {
    if (isRecord(entry) && typeof entry.baseUrl === "string" && !isHttpUrl(entry.baseUrl)) {
      errors.push(`/providers/${index}/baseUrl: must be an http or https URL`);
    }
    if (isRecord(entry) && typeof entry.id === "string") {
      if (seen.has(entry.id)) errors.push(`/providers/${index}/id: "${entry.id}" is repeated`);
      seen.add(entry.id);
    }
  });
  for (const error of Value.Errors(HarilConfigSchema, value)) {
    errors.push(`${error.instancePath || "/"}: ${error.message}`);
  }
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, config: value as HarilConfig };
}
