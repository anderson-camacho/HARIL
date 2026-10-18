import { envSecretRef } from "@haril/contracts";
import type { QuotaSnapshot } from "@haril/core/ports";
import { createCliProxyQuotaProvider } from "@haril/gateway";
import type { HostInfo } from "./context.js";
import { quotaSourceOf } from "./delegation-config.js";
import type { DelegationSettings } from "./delegation-section.js";
import { PROBE_TIMEOUT_MS, type ProviderEntry, secretStoreFor } from "./providers.js";

// Reads the quota of every configured provider (docs/modos-y-delegacion.md 3.11; ADR-0021 S1, P7, P26): the provider the
// CLIProxyAPI management API stands behind is asked through it, with the management key from the variable that
// delegation.quota.managementKeyEnv names (read by reference, sealed, never printed); every other provider has no quota
// source and is "sin dato".

export interface ProviderQuota {
  readonly providerId: string;
  readonly snapshot: QuotaSnapshot;
}

// How long one management request may take; the default is the provider probe's.
const QUOTA_TIMEOUT_MS = PROBE_TIMEOUT_MS * 2;

export async function readProviderQuota(
  host: HostInfo,
  providers: readonly ProviderEntry[],
  settings: DelegationSettings,
  now: () => number,
): Promise<ProviderQuota[]> {
  const source = quotaSourceOf(settings, providers);
  const keyEnv = settings.quota.managementKeyEnv;
  const got = secretStoreFor(host).get(envSecretRef(keyEnv));
  const credential = got.ok ? got.value : undefined;
  return Promise.all(
    providers.map(async (entry): Promise<ProviderQuota> => {
      if (source === undefined || source.providerId !== entry.id) {
        return {
          providerId: entry.id,
          snapshot: {
            ok: false,
            sampledAt: now(),
            reason: "not_configured",
            detail: "no quota source for this provider",
          },
        };
      }
      const reader = createCliProxyQuotaProvider({
        providerId: entry.id,
        baseUrl: source.baseUrl,
        credential,
        keyEnv,
        timeoutMs: host.gatewayTimeoutMs ?? QUOTA_TIMEOUT_MS,
        now,
      });
      return { providerId: entry.id, snapshot: await reader.sample(entry.id) };
    }),
  );
}
