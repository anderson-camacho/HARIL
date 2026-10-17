import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  isValidModelDescriptor,
  type ModelDescriptor,
  validateHarilConfig,
} from "@haril/contracts";
import { createOpenAiCompatibleClient, ProviderError } from "@haril/gateway";
import type { HostInfo } from "./context.js";
import { runtimeRootFor } from "./runtime.js";

// Providers of HARIL (M3-T7, ACE-06). They come from haril.json (HARIL_CONFIG, else <runtime root>/config/haril.json);
// without a file, one default applies: cliproxy (keyed, HARIL_GATEWAY_URL may move it). Ollama is not a default:
// local inference is too heavy for the reference machine (RL-D4); a user may still add it in haril.json.
// Keys are read from the environment named by keyEnv here only; no output ever prints a key value.

const CONFIG_ENV = "HARIL_CONFIG";
const GATEWAY_URL_ENV = "HARIL_GATEWAY_URL";
const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";
const DEFAULT_CLIPROXY_URL = "http://127.0.0.1:8317/v1";
export const PROBE_TIMEOUT_MS = 3000;
export const MODELS_TIMEOUT_MS = 10000;
export const KEY_REJECTED = "key rejected";
const KEY_NOT_SET = "key not set";
const NAMESPACE_SEPARATOR = "/";

export interface ProviderEntry {
  readonly id: string;
  readonly baseUrl: string;
  readonly keyEnv?: string;
  // The value of keyEnv, read once. Never printed and never stored outside the process.
  readonly apiKey: string | undefined;
}

export type ProviderLoad =
  | {
      readonly ok: true;
      readonly source: "defaults" | "file";
      readonly path: string;
      readonly providers: ProviderEntry[];
    }
  | { readonly ok: false; readonly path: string; readonly errors: string[] };

// One provider's answer to the catalog query. skipped means no request was sent (its key is not set).
export interface ProviderListing {
  readonly id: string;
  readonly url: string;
  readonly keyEnv?: string;
  readonly key: "none needed" | "set" | "not set";
  readonly status: "ok" | "skipped" | "failed";
  readonly detail: string;
  readonly models: ModelDescriptor[];
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function configPathFor(host: HostInfo): { path: string; explicit: boolean } {
  const env = host.env ?? {};
  const explicit = nonEmpty(env[CONFIG_ENV]);
  if (explicit !== undefined) return { path: explicit, explicit: true };
  const ops = host.platform === "win32" ? win32 : posix;
  return { path: ops.join(runtimeRootFor(host), "config", "haril.json"), explicit: false };
}

// The providers in effect for this run. A problem with the file is an error for the whole command, not a skip.
export function loadProviderConfig(host: HostInfo): ProviderLoad {
  const env = host.env ?? {};
  const { path, explicit } = configPathFor(host);
  if (!existsSync(path)) {
    if (explicit)
      return { ok: false, path, errors: ["the file named by HARIL_CONFIG does not exist"] };
    return defaultProviders(env, path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return { ok: false, path, errors: ["the file is not valid JSON"] };
  }
  if (!isRecord(parsed)) return { ok: false, path, errors: ["/: must be a JSON object"] };
  const ownErrors = ownKeyErrors(parsed);
  if (ownErrors.length > 0) return { ok: false, path, errors: ownErrors };
  // A file without providers (for example one that only holds ui.theme) gives the same defaults as no file.
  if (!("providers" in parsed)) return defaultProviders(env, path);
  const checked = validateHarilConfig({ providers: parsed.providers });
  if (!checked.ok) return { ok: false, path, errors: checked.errors };
  return {
    ok: true,
    source: "file",
    path,
    providers: checked.config.providers.map((entry) => ({
      id: entry.id,
      baseUrl: entry.baseUrl,
      ...(entry.keyEnv === undefined ? {} : { keyEnv: entry.keyEnv }),
      apiKey: entry.keyEnv === undefined ? undefined : nonEmpty(env[entry.keyEnv]),
    })),
  };
}

// The top-level keys haril.json may hold: providers (the provider schema) and ui (TUI-D14). Anything else is refused.
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["providers", "ui"]);
const THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UI_KEYS: ReadonlySet<string> = new Set(["theme"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The rules the provider schema does not own: the top-level keys, the literal apiKey refusal and the ui object.
function ownKeyErrors(value: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ("apiKey" in value) {
    errors.push("/apiKey: keys are never stored in haril.json; use keyEnv");
  }
  for (const key of Object.keys(value)) {
    if (key !== "apiKey" && !TOP_LEVEL_KEYS.has(key)) errors.push(`/${key}: unknown key`);
  }
  if ("ui" in value) errors.push(...uiErrors(value.ui));
  return errors;
}

function uiErrors(ui: unknown): string[] {
  if (!isRecord(ui)) return ["/ui: must be an object"];
  const errors: string[] = [];
  for (const key of Object.keys(ui)) {
    if (!UI_KEYS.has(key)) errors.push(`/ui/${key}: unknown key`);
  }
  if ("theme" in ui && (typeof ui.theme !== "string" || !THEME_NAME_PATTERN.test(ui.theme))) {
    errors.push(
      "/ui/theme: must be a theme name (letters, digits, '.', '_' or '-', starting with a letter or digit)",
    );
  }
  return errors;
}

function defaultProviders(
  env: Readonly<Record<string, string | undefined>>,
  path: string,
): ProviderLoad {
  const url = nonEmpty(env[GATEWAY_URL_ENV]) ?? DEFAULT_CLIPROXY_URL;
  if (!isHttpUrl(url)) {
    return { ok: false, path, errors: [`${GATEWAY_URL_ENV} is not a valid URL`] };
  }
  return {
    ok: true,
    source: "defaults",
    path,
    providers: [
      {
        id: "cliproxy",
        baseUrl: url,
        keyEnv: GATEWAY_KEY_ENV,
        apiKey: nonEmpty(env[GATEWAY_KEY_ENV]),
      },
    ],
  };
}

// Asks one provider for its catalog. Without a key set for a keyEnv, nothing is sent and the provider is skipped.
export async function listProviderModels(
  entry: ProviderEntry,
  timeoutMs: number,
): Promise<ProviderListing> {
  const key =
    entry.keyEnv === undefined ? "none needed" : entry.apiKey === undefined ? "not set" : "set";
  const base = {
    id: entry.id,
    url: entry.baseUrl,
    key,
    ...(entry.keyEnv === undefined ? {} : { keyEnv: entry.keyEnv }),
  } as const;
  if (entry.keyEnv !== undefined && entry.apiKey === undefined) {
    return { ...base, status: "skipped", detail: KEY_NOT_SET, models: [] };
  }
  const client = createOpenAiCompatibleClient({
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    timeoutMs,
  });
  try {
    const listed = await client.listModels();
    const models: ModelDescriptor[] = [];
    for (const model of listed) {
      const descriptor = { ...model, providerId: entry.id };
      if (isValidModelDescriptor(descriptor)) models.push(descriptor);
    }
    return { ...base, status: "ok", detail: `reachable, ${models.length} models`, models };
  } catch (error) {
    return { ...base, status: "failed", detail: failureDetail(error, entry), models: [] };
  }
}

function failureDetail(error: unknown, entry: ProviderEntry): string {
  if (!(error instanceof ProviderError)) return "probe failed";
  if (error.code === "auth") {
    return entry.apiKey === undefined ? "auth required, no key configured" : KEY_REJECTED;
  }
  if (error.code === "unreachable") return "unreachable";
  return error.message;
}

// The model reference of a run: <provider>/<model>. The provider is the segment before the first slash, so a
// model id that itself has slashes keeps them.
export function namespacedRef(providerId: string, model: string): string {
  return `${providerId}${NAMESPACE_SEPARATOR}${model}`;
}

// The model id the upstream knows: the reference without its provider prefix.
export function bareModelOf(ref: string, providerId: string): string {
  const prefix = `${providerId}${NAMESPACE_SEPARATOR}`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

export type ModelResolution =
  | { readonly ok: true; readonly providerId: string; readonly ref: string }
  | { readonly ok: false; readonly code: "model_ambiguous"; readonly message: string };

// A namespaced reference names its provider. A bare model id is resolved only when exactly one provider serves
// it right now (M3-T7); otherwise the task fails with model_ambiguous and the message says why.
export async function resolveModelRef(
  ref: string,
  providers: readonly ProviderEntry[],
  timeoutMs: number,
): Promise<ModelResolution> {
  const owner = providers.find((entry) => ref.startsWith(`${entry.id}${NAMESPACE_SEPARATOR}`));
  if (owner !== undefined) return { ok: true, providerId: owner.id, ref };

  const listings = await Promise.all(
    providers.map((entry) => listProviderModels(entry, timeoutMs)),
  );
  const matches = listings.filter((listing) => listing.models.some((model) => model.id === ref));
  if (matches.length === 1 && matches[0] !== undefined) {
    return { ok: true, providerId: matches[0].id, ref: namespacedRef(matches[0].id, ref) };
  }
  if (matches.length > 1) {
    const names = matches.map((listing) => namespacedRef(listing.id, ref)).join(", ");
    return {
      ok: false,
      code: "model_ambiguous",
      message: `model ${ref} is served by ${matches.length} providers (${names}); name one with <provider>/${ref}`,
    };
  }
  const keyless = listings
    .filter((listing) => listing.status === "skipped")
    .map((listing) => listing.keyEnv ?? listing.id);
  const hint = keyless.length === 0 ? "" : `; providers without a key: ${keyless.join(", ")}`;
  return {
    ok: false,
    code: "model_ambiguous",
    message: `model ${ref} is served by no usable provider${hint}`,
  };
}

// What stops a task's model before its claim (M3-T7, restored): the task stays ready and is reported as skipped.
// Only what needs no network is decided here. A namespaced model whose provider key is unset is a problem; a bare
// id is resolved against the live catalogs at start, where an ambiguity still fails the attempt (model_ambiguous).
export interface ModelProblem {
  readonly what: string;
  readonly fix: string;
}

export function modelProblemOf(
  model: string | null,
  providers: readonly ProviderEntry[],
): ModelProblem | undefined {
  if (model === null) {
    return { what: "the task names no model", fix: "add one with --model <provider>/<model>" };
  }
  const owner = providers.find((entry) => model.startsWith(`${entry.id}${NAMESPACE_SEPARATOR}`));
  if (owner === undefined || owner.keyEnv === undefined || owner.apiKey !== undefined) {
    return undefined;
  }
  return {
    what: `${owner.keyEnv} is not set`,
    fix: `set it to the key of provider ${owner.id}`,
  };
}
