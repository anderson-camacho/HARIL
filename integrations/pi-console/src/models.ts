import { runHarilJson } from "./cli.js";
import type {
  ConsoleContext,
  ConsolePi,
  PiModel,
  ProviderConfig,
  ProviderModelConfig,
} from "./pi-types.js";

// HARIL's providers in Pi's /model (PS-T4). `haril models --json` lists the providers of haril.json, their URLs, the
// NAME of each key variable (never a key) and the models of the ones that answered; each answering provider is
// registered as an OpenAI-compatible Pi provider named haril-<id>, so it never replaces one of Pi's own. Its apiKey is
// the variable's name as ${NAME}: Pi reads the variable from its own environment when it sends a request, so no key
// passes through this extension, its argv or a file.

const PROVIDER_PREFIX = "haril-";
// `haril models` waits up to 10 s for each provider, all of them at once.
const MODELS_TIMEOUT_MS = 30_000;
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

// What the registration did: the Pi provider name of each HARIL provider, and the lines to tell the user.
export interface ModelRegistration {
  readonly harilIdOf: ReadonlyMap<string, string>;
  readonly notes: readonly string[];
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

// A model as Pi registers it. What the provider reported wins; Pi's own catalog fills in what a proxy does not say
// (whether the model reasons, its inputs and limits) when it knows a model of the same id. The cost stays zero:
// HARIL does not know what a provider charges.
function piModel(listed: ListedModel, catalog: readonly PiModel[]): ProviderModelConfig {
  const known = catalog.find(
    (model) => model.id === listed.id && !model.provider.startsWith(PROVIDER_PREFIX),
  );
  return {
    id: listed.id,
    name: listed.displayName ?? listed.id,
    input: known?.input === undefined ? ["text"] : [...known.input],
    reasoning: known?.reasoning === true,
    contextWindow: listed.contextWindow ?? known?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: listed.maxOutputTokens ?? known?.maxTokens ?? FALLBACK_MAX_TOKENS,
    cost: { ...ZERO_COST },
  };
}

// Registers every HARIL provider that answered with models. The others are named in the notes: an unset key
// variable by its name, an unreachable provider by HARIL's own detail.
export async function registerHarilModels(
  pi: ConsolePi,
  ctx: ConsoleContext,
): Promise<ModelRegistration> {
  const listing = await runHarilJson(["models", "--json"], { timeoutMs: MODELS_TIMEOUT_MS });
  if (listing === undefined) {
    return { harilIdOf: new Map(), notes: ["HARIL models unavailable: see haril models"] };
  }
  const { providers, models } = parseListing(listing);
  let catalog: readonly PiModel[] = [];
  try {
    catalog = ctx.modelRegistry.getAll();
  } catch {
    // Without Pi's catalog the models keep HARIL's facts and the fallbacks.
  }
  const harilIdOf = new Map<string, string>();
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
    const config: ProviderConfig = {
      name: `HARIL ${provider.id}`,
      baseUrl: provider.url,
      apiKey: provider.keyEnv === undefined ? NO_KEY : `\${${provider.keyEnv}}`,
      api: "openai-completions",
      models: own.map((model) => piModel(model, catalog)),
    };
    try {
      pi.registerProvider(name, config);
      harilIdOf.set(name, provider.id);
    } catch (error) {
      notes.push(
        `HARIL provider ${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { harilIdOf, notes };
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
  } else if (current === undefined) {
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
