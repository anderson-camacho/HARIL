import { createOpenAiCompatibleClient } from "@haril/gateway";
import { namespacedRef, type ProviderEntry } from "./providers.js";

// The models agents may run on (docs/modos-y-delegacion.md 3.11, R-Q1; ADR-0021 S8, P24): what each configured provider
// lists, as "<provider>/<model id>". The listing asked first is CLIProxyAPI's `?client_version=` one, the only one that
// publishes each model's reasoning levels, default level and real context window (the console reads the same, FM); a
// gateway that does not answer it gives its plain `/models` listing instead, with no levels. A provider whose key is not
// set lists nothing: none of its models can run.

// The client version CLIProxyAPI expects before it publishes the levels (S8), the same the console sends.
const GATEWAY_CLIENT_VERSION = "0.99.0";

export interface CatalogEntry {
  readonly ref: string;
  readonly providerId: string;
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  // The reasoning levels the gateway publishes (empty when none, or from the plain listing).
  readonly levels: readonly string[];
  // The level the gateway uses when a request asks for none.
  readonly defaultLevel: string | null;
}

async function providerCatalog(entry: ProviderEntry, timeoutMs: number): Promise<CatalogEntry[]> {
  if (entry.keyEnv !== undefined && entry.credential === undefined) return [];
  const client = createOpenAiCompatibleClient({
    baseUrl: entry.baseUrl,
    credential: entry.credential,
    timeoutMs,
  });
  try {
    const details = await client.listModelDetails(GATEWAY_CLIENT_VERSION);
    return details.map((detail) => ({
      ref: namespacedRef(entry.id, detail.id),
      providerId: entry.id,
      contextWindow: detail.contextWindow ?? null,
      maxTokens: detail.maxTokens ?? null,
      levels: detail.levels,
      defaultLevel: detail.defaultLevel ?? null,
    }));
  } catch {
    try {
      const listed = await client.listModels();
      return listed.map((model) => ({
        ref: namespacedRef(entry.id, model.id),
        providerId: entry.id,
        contextWindow: model.contextWindow ?? null,
        maxTokens: model.maxOutputTokens ?? null,
        levels: [],
        defaultLevel: null,
      }));
    } catch {
      return [];
    }
  }
}

// Every provider at once; one that does not answer lists nothing.
export async function readModelCatalog(
  providers: readonly ProviderEntry[],
  timeoutMs: number,
): Promise<CatalogEntry[]> {
  const lists = await Promise.all(providers.map((entry) => providerCatalog(entry, timeoutMs)));
  return lists.flat();
}
