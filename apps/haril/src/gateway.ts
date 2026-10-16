import { createOpenAiCompatibleClient, ProviderError } from "@haril/gateway";
import type { GatewaySettings, GatewayStatus, HostInfo } from "./context.js";

// Gateway wiring of the CLI (M2-D1). HARIL reads the URL and the key from the environment here only; the
// key never goes to AgentSpec, events, logs or the repository, and no output shows its value.

export const GATEWAY_URL_ENV = "HARIL_GATEWAY_URL";
export const GATEWAY_KEY_ENV = "HARIL_CLIPROXYAPI_KEY";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8317/v1";
const DOCTOR_PROBE_TIMEOUT_MS = 3000;
export const MODELS_TIMEOUT_MS = 10000;

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

export function gatewaySettings(host: HostInfo): GatewaySettings {
  const env = host.env ?? {};
  const url = nonEmpty(env[GATEWAY_URL_ENV]) ?? DEFAULT_GATEWAY_URL;
  return { url, urlValid: isHttpUrl(url), apiKey: nonEmpty(env[GATEWAY_KEY_ENV]) };
}

// The real probe behind `doctor`: GET /v1/models with a short timeout. Without a key, a 401 means the
// gateway is reachable and the key is missing; with a key, a 401 means the key was rejected.
export async function probeGateway(settings: GatewaySettings): Promise<GatewayStatus> {
  if (!settings.urlValid) {
    return { status: "error", detail: `${GATEWAY_URL_ENV} is not a valid URL` };
  }
  const client = createOpenAiCompatibleClient({
    baseUrl: settings.url,
    apiKey: settings.apiKey,
    timeoutMs: DOCTOR_PROBE_TIMEOUT_MS,
  });
  try {
    const models = await client.listModels();
    return { status: "ok", detail: `reachable, ${models.length} models`, models: models.length };
  } catch (error) {
    if (!(error instanceof ProviderError)) return { status: "warn", detail: "probe failed" };
    if (error.code === "auth") {
      return settings.apiKey === undefined
        ? { status: "warn", detail: "reachable, key not set" }
        : { status: "error", detail: "key rejected" };
    }
    if (error.code === "unreachable") return { status: "warn", detail: "unreachable" };
    return { status: "warn", detail: error.message };
  }
}
