import { runHarilJson } from "./cli.js";
import {
  findCatalogModel,
  GATEWAY_CLIENT_VERSION,
  type ModelDetail,
  parseModelDetails,
  reasoningFor,
} from "./model-levels.js";
import type {
  ConsoleContext,
  ConsolePi,
  PiModel,
  ProviderConfig,
  ProviderModelConfig,
  ThinkingLevel,
} from "./pi-types.js";

// HARIL's providers in Pi's /model (PS-T4). `haril models --json` lists the providers of haril.json, their URLs, the
// NAME of each key variable (never a key) and the models of the ones that answered; each answering provider is
// registered as an OpenAI-compatible Pi provider named haril-<id>, so it never replaces one of Pi's own. Its apiKey is
// the variable's name as ${NAME}: Pi reads the variable from its own environment when it sends a request, so no key
// is put in argv, a file or the registration.
//
// Each model also carries its reasoning levels (FM, model-levels.ts). They come from the provider's
// `GET <url>/models?client_version=` listing, which this extension reads itself: it takes the key from the same
// environment variable Pi reads, in this process only, and sends it to the same URL Pi sends it to, with redirects
// refused. The key is never logged, stored or shown. A listing that fails, times out or is not JSON leaves the levels
// to Pi's catalog, as before FM.

const PROVIDER_PREFIX = "haril-";
// `haril models` waits up to 10 s for each provider, all of them at once.
const MODELS_TIMEOUT_MS = 30_000;
// The gateway's detailed listing, per provider and all at once.
const DETAILS_TIMEOUT_MS = 10_000;
// A provider that needs no key still gets a literal one: Pi requires an apiKey to register models.
const NO_KEY = "haril-no-key";
// Limits for a model Pi's catalog does not know and the provider did not describe.
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface ListedProvider {
  readonly id: string;
  readonly url: string;
  readonly keyEnv: string | undefined;
  readonly status: string;
  readonly detail: string;
}

interface ListedModel {
  readonly providerId: string;
  readonly id: string;
  readonly displayName: string | undefined;
  readonly contextWindow: number | undefined;
  readonly maxOutputTokens: number | undefined;
}

// What the registration did: the Pi provider name of each HARIL provider, the lines to tell the user and the default
// level the gateway published for each model ("<pi provider>/<model id>"), used when nothing else chose one.
export interface ModelRegistration {
  readonly harilIdOf: ReadonlyMap<string, string>;
  readonly notes: readonly string[];
  readonly defaultLevels: ReadonlyMap<string, ThinkingLevel>;
}

// Where the registration reads from: `haril models --json`, and each provider's detailed listing.
interface ModelSources {
  listing(): Promise<unknown>;
  details(url: string, keyEnv: string | undefined): Promise<Map<string, ModelDetail> | undefined>;
}

const DEFAULT_SOURCES: ModelSources = {
  listing: () => runHarilJson(["models", "--json"], { timeoutMs: MODELS_TIMEOUT_MS }),
  details: (url, keyEnv) =>
    fetchModelDetails(url, keyEnv === undefined ? undefined : process.env[keyEnv]),
};

// The provider's `?client_version=` listing (model-levels.ts), or undefined when it cannot be read: unreachable,
// slow, not 2xx, a redirect, not JSON or not a listing. Never rejects.
export async function fetchModelDetails(
  baseUrl: string,
  key: string | undefined,
  timeoutMs: number = DETAILS_TIMEOUT_MS,
): Promise<Map<string, ModelDetail> | undefined> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models?client_version=${GATEWAY_CLIENT_VERSION}`;
    const response = await fetch(url, {
      headers: key === undefined || key === "" ? {} : { authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return parseModelDetails(JSON.parse(await response.text()) as unknown);
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseListing(value: unknown): { providers: ListedProvider[]; models: ListedModel[] } {
  const record = (value ?? {}) as { providers?: unknown; models?: unknown };
  const providers: ListedProvider[] = [];
  for (const item of Array.isArray(record.providers) ? record.providers : []) {
    const entry = item as Record<string, unknown>;
    const id = text(entry.id);
    const url = text(entry.url);
    if (id === undefined || url === undefined) continue;
    providers.push({
      id,
      url,
      keyEnv: text(entry.keyEnv),
      status: text(entry.status) ?? "failed",
      detail: text(entry.detail) ?? "",
    });
  }
  const models: ListedModel[] = [];
  for (const item of Array.isArray(record.models) ? record.models : []) {
    const entry = item as Record<string, unknown>;
    const providerId = text(entry.providerId);
    const id = text(entry.id);
    if (providerId === undefined || id === undefined) continue;
    models.push({
      providerId,
      id,
      displayName: text(entry.displayName),
      contextWindow: count(entry.contextWindow),
      maxOutputTokens: count(entry.maxOutputTokens),
    });
  }
  return { providers, models };
}

// A model as Pi registers it. What the provider reported wins: HARIL's listing, then the gateway's detailed listing;
// Pi's own catalog fills in what a proxy does not say (its inputs and limits, and its levels when the gateway does
// not describe the model) when it knows a model of the same id or normalized name. The cost stays zero: HARIL does not
// know what a provider charges.
function piModel(
  listed: ListedModel,
  detail: ModelDetail | undefined,
  catalog: readonly PiModel[],
): { config: ProviderModelConfig; defaultLevel: ThinkingLevel | undefined } {
  const known = findCatalogModel(listed.id, catalog, (model) =>
    model.provider.startsWith(PROVIDER_PREFIX),
  );
  const reasoning = reasoningFor(detail, known);
  return {
    config: {
      id: listed.id,
      name: listed.displayName ?? detail?.displayName ?? listed.id,
      input: known?.input === undefined ? ["text"] : [...known.input],
      reasoning: reasoning.reasoning,
      ...(reasoning.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: reasoning.thinkingLevelMap }),
      contextWindow:
        listed.contextWindow ??
        detail?.contextWindow ??
        known?.contextWindow ??
        FALLBACK_CONTEXT_WINDOW,
      maxTokens:
        listed.maxOutputTokens ?? detail?.maxTokens ?? known?.maxTokens ?? FALLBACK_MAX_TOKENS,
      cost: { ...ZERO_COST },
    },
    defaultLevel: reasoning.defaultLevel,
  };
}

// Registers every HARIL provider that answered with models. The others are named in the notes: an unset key
// variable by its name, an unreachable provider by HARIL's own detail. `sources` replaces the CLI and the network in
// tests.
export async function registerHarilModels(
  pi: ConsolePi,
  ctx: ConsoleContext,
  sources: Partial<ModelSources> = {},
): Promise<ModelRegistration> {
  const read: ModelSources = { ...DEFAULT_SOURCES, ...sources };
  const listing = await read.listing();
  if (listing === undefined) {
    return {
      harilIdOf: new Map(),
      notes: ["HARIL models unavailable: see haril models"],
      defaultLevels: new Map(),
    };
  }
  const { providers, models } = parseListing(listing);
  let catalog: readonly PiModel[] = [];
  try {
    catalog = ctx.modelRegistry.getAll();
  } catch {
    // Without Pi's catalog the models keep HARIL's facts and the fallbacks.
  }
  const answering = providers.filter(
    (provider) =>
      provider.status === "ok" && models.some((model) => model.providerId === provider.id),
  );
  const detailsOf = new Map(
    await Promise.all(
      answering.map(
        async (provider) =>
          [provider.id, await read.details(provider.url, provider.keyEnv)] as const,
      ),
    ),
  );
  const harilIdOf = new Map<string, string>();
  const defaultLevels = new Map<string, ThinkingLevel>();
  const notes: string[] = [];
  for (const provider of providers) {
    const own = models.filter((model) => model.providerId === provider.id);
    if (provider.status !== "ok" || own.length === 0) {
      notes.push(
        provider.status === "skipped" && provider.keyEnv !== undefined
          ? `HARIL provider ${provider.id}: ${provider.keyEnv} is not set, so its models are not in /model`
          : `HARIL provider ${provider.id}: ${provider.detail || "no models"}`,
      );
      continue;
    }
    const name = `${PROVIDER_PREFIX}${provider.id}`;
    const details = detailsOf.get(provider.id);
    if (details === undefined) {
      notes.push(
        `HARIL provider ${provider.id}: its model details did not load, so reasoning levels come from Pi's catalog`,
      );
    }
    const built = own.map((model) => ({
      id: model.id,
      ...piModel(model, details?.get(model.id), catalog),
    }));
    const config: ProviderConfig = {
      name: `HARIL ${provider.id}`,
      baseUrl: provider.url,
      apiKey: provider.keyEnv === undefined ? NO_KEY : `\${${provider.keyEnv}}`,
      api: "openai-completions",
      models: built.map((model) => model.config),
    };
    try {
      pi.registerProvider(name, config);
      harilIdOf.set(name, provider.id);
      for (const model of built) {
        if (model.defaultLevel !== undefined)
          defaultLevels.set(`${name}/${model.id}`, model.defaultLevel);
      }
    } catch (error) {
      notes.push(
        `HARIL provider ${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { harilIdOf, notes, defaultLevels };
}

// After a start, Pi chose its model before HARIL's providers existed. The saved default is put back when it is a
// HARIL model (and no model scope decides instead); a session without any model gets HARIL_DEFAULT_MODEL's, else the
// first HARIL model. Returns the model set, if any.
export async function restoreHarilModel(
  pi: ConsolePi,
  ctx: ConsoleContext,
  registration: ModelRegistration,
  current: PiModel | undefined,
): Promise<PiModel | undefined> {
  if (registration.harilIdOf.size === 0 || ctx.scopedModels.length > 0) return undefined;
  const find = (provider: string, id: string): PiModel | undefined => {
    try {
      return ctx.modelRegistry.find(provider, id);
    } catch {
      return undefined;
    }
  };
  const settings = pi.getSettings();
  const savedProvider = settings.defaultProvider;
  const savedModel = settings.defaultModel;
  let wanted: PiModel | undefined;
  if (
    savedProvider !== undefined &&
    savedModel !== undefined &&
    registration.harilIdOf.has(savedProvider) &&
    (current?.provider !== savedProvider || current.id !== savedModel)
  ) {
    wanted = find(savedProvider, savedModel);
  } else if (current === undefined || find(current.provider, current.id) === undefined) {
    // Without a usable model Pi 1.2.0 reports a placeholder (provider and id "unknown"), not undefined.
    wanted = defaultHarilModel(registration, find) ?? firstHarilModel(ctx, registration);
  }
  if (wanted === undefined) return undefined;
  return (await pi.setModel(wanted)) ? wanted : undefined;
}

// HARIL_DEFAULT_MODEL (<provider>/<model>) as a registered Pi model.
function defaultHarilModel(
  registration: ModelRegistration,
  find: (provider: string, id: string) => PiModel | undefined,
): PiModel | undefined {
  const ref = process.env.HARIL_DEFAULT_MODEL?.trim() ?? "";
  const split = ref.indexOf("/");
  if (split <= 0) return undefined;
  const provider = `${PROVIDER_PREFIX}${ref.slice(0, split)}`;
  return registration.harilIdOf.has(provider) ? find(provider, ref.slice(split + 1)) : undefined;
}

function firstHarilModel(
  ctx: ConsoleContext,
  registration: ModelRegistration,
): PiModel | undefined {
  try {
    return ctx.modelRegistry.getAll().find((model) => registration.harilIdOf.has(model.provider));
  } catch {
    return undefined;
  }
}

// The HARIL reference (<provider>/<model>) of a Pi model a HARIL provider serves.
export function harilRef(
  model: PiModel | undefined,
  registration: ModelRegistration | undefined,
): string | undefined {
  if (model === undefined || registration === undefined) return undefined;
  const harilId = registration.harilIdOf.get(model.provider);
  return harilId === undefined ? undefined : `${harilId}/${model.id}`;
}
