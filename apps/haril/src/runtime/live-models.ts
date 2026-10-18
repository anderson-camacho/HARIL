import type { QuotaPolicy } from "@haril/core";
import type { Clock, Store, WorkflowRecord } from "@haril/core/ports";
import type { HostInfo } from "../context.js";
import { loadDelegationSettings } from "../delegation-config.js";
import { type DelegationSettings, delegationSettingsOf } from "../delegation-section.js";
import { loadDifficulty, resolveDifficulty, tableFor } from "../difficulty.js";
import { type CatalogEntry, readModelCatalog } from "../model-catalog.js";
import { loadProviderConfig, MODELS_TIMEOUT_MS, type ProviderEntry } from "../providers.js";
import { type ProviderQuota, readProviderQuota } from "../quota-source.js";
import { quotaKeyOf } from "../quota-view.js";
import { type DelegationModels, type DelegationOptions, defaultModels } from "./workflow-view.js";

// The models of real workflows while a runtime runs (docs/modos-y-delegacion.md 3.11; phase F6): the live catalog of
// the providers, the difficulty table (config/difficulty.json over its provisional defaults, its patterns expanded
// against the catalog), the success rates of the last manual calibration and the quota policy of haril.json. The catalog
// is read again every 10 minutes and the quota every 5, in the background, so a decision never waits for the network;
// the quota readings go to the store, where every decision reads them with the cooldowns (model-context.ts). A
// management key the server refuses stops the sampling for the rest of the run: repeated failures would lock the
// address out. A simulated workflow keeps the orchestrator's model for every child, as before.

const CATALOG_TTL_MS = 10 * 60_000;
const QUOTA_REFRESH_MS = 5 * 60_000;
// The files are read again at most this often (haril.json and difficulty.json are user-edited).
const SETTINGS_TTL_MS = 5_000;

export interface LiveModelsDeps {
  readonly host: HostInfo;
  readonly store: Store;
  readonly clock: Clock;
  // Test seams: the catalog and quota readers default to the real ones.
  readonly readCatalog?: (providers: readonly ProviderEntry[]) => Promise<CatalogEntry[]>;
  readonly readQuota?: (
    providers: readonly ProviderEntry[],
    settings: DelegationSettings,
  ) => Promise<ProviderQuota[]>;
}

export interface LiveModels {
  readonly options: DelegationOptions;
  // Waits at most `ms` for the first catalog reading, so the first turns already see the catalog.
  ready(ms: number): Promise<void>;
  // Waits for the readings in flight.
  close(): Promise<void>;
}

interface Cached<T> {
  readonly value: T;
  readonly at: number;
}

export function createLiveModels(deps: LiveModelsDeps): LiveModels {
  const { host, store, clock } = deps;
  const readCatalog =
    deps.readCatalog ?? ((providers) => readModelCatalog(providers, MODELS_TIMEOUT_MS));
  const readQuota =
    deps.readQuota ??
    ((providers, settings) => readProviderQuota(host, providers, settings, () => clock.now()));
  let catalog: Cached<CatalogEntry[]> | undefined;
  let catalogRead: Promise<void> | undefined;
  let quotaAt = Number.NEGATIVE_INFINITY;
  let quotaRead: Promise<void> | undefined;
  let quotaStopped = false;
  let providers: Cached<ProviderEntry[]> | undefined;
  let settings: Cached<DelegationSettings> | undefined;
  let difficulty: Cached<ReturnType<typeof resolveDifficulty>> | undefined;

  const providersNow = (now: number): ProviderEntry[] => {
    if (providers === undefined || now - providers.at > SETTINGS_TTL_MS) {
      const loaded = loadProviderConfig(host);
      providers = { value: loaded.ok ? loaded.providers : [], at: now };
    }
    return providers.value;
  };
  const settingsNow = (now: number): DelegationSettings => {
    if (settings === undefined || now - settings.at > SETTINGS_TTL_MS) {
      const loaded = loadDelegationSettings(host);
      settings = {
        value: loaded.ok ? loaded.settings : delegationSettingsOf(undefined),
        at: now,
      };
    }
    return settings.value;
  };
  // An invalid difficulty.json leaves the defaults in effect; haril difficulty show says what is wrong.
  const difficultyNow = (now: number) => {
    if (difficulty === undefined || now - difficulty.at > SETTINGS_TTL_MS) {
      const loaded = loadDifficulty(host);
      difficulty = { value: loaded.ok ? loaded.policy : resolveDifficulty(undefined), at: now };
    }
    return difficulty.value;
  };

  const refreshCatalog = (now: number): void => {
    if (catalogRead !== undefined) return;
    if (catalog !== undefined && now - catalog.at < CATALOG_TTL_MS) return;
    catalogRead = readCatalog(providersNow(now))
      .then((entries) => {
        catalog = { value: entries, at: clock.now() };
      })
      .catch(() => {
        catalog = { value: catalog?.value ?? [], at: clock.now() };
      })
      .finally(() => {
        catalogRead = undefined;
      });
  };

  const refreshQuota = (now: number): void => {
    if (quotaStopped || quotaRead !== undefined || now - quotaAt < QUOTA_REFRESH_MS) return;
    quotaAt = now;
    quotaRead = readQuota(providersNow(now), settingsNow(now))
      .then((readings) => {
        for (const { providerId, snapshot } of readings) {
          // A provider with no quota source leaves no rows: there is nothing to keep.
          if (!snapshot.ok && snapshot.reason === "not_configured") continue;
          store.quota.recordSnapshot(providerId, snapshot);
          if (!snapshot.ok && snapshot.reason === "unauthorized") quotaStopped = true;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        quotaRead = undefined;
      });
  };

  const policyOf = (value: DelegationSettings): QuotaPolicy => ({
    switchAtPercent5h: value.quota.switchAtPercent5h,
    stopAtPercentWeekly: value.quota.stopAtPercentWeekly,
    minRemainingPercentForLargeTask: value.quota.minRemainingPercentForLargeTask,
    maxWaitMs: value.quota.maxWaitMs,
  });

  const simulated = (workflow: WorkflowRecord): boolean => {
    const root = workflow.rootTaskId === null ? undefined : store.tasks.get(workflow.rootTaskId);
    return workflow.simulated || root?.agentRef.startsWith("fake:") === true;
  };

  const models = (now: number, workflow: WorkflowRecord): DelegationModels => {
    const policy = policyOf(settingsNow(now));
    if (simulated(workflow)) return { ...defaultModels(workflow.orchestratorModel), policy };
    refreshCatalog(now);
    refreshQuota(now);
    const entries = catalog?.value ?? [];
    if (entries.length === 0) return { ...defaultModels(workflow.orchestratorModel), policy };
    const keyed = new Map(
      providersNow(now).map((entry) => [
        entry.id,
        entry.keyEnv === undefined || entry.credential !== undefined,
      ]),
    );
    const refs = entries.map((entry) => entry.ref);
    const table = difficultyNow(now);
    return {
      catalog: entries.map((entry) => ({
        ref: entry.ref,
        quotaKey: quotaKeyOf(entry.ref),
        hasKey: keyed.get(entry.providerId) ?? false,
        coolingUntil: null,
      })),
      allow: {},
      pinned: {},
      quota: {},
      table: tableFor(table, refs),
      stats: table.stats,
      policy,
    };
  };

  return {
    options: {
      models,
      levelOf: (ref) => catalog?.value.find((entry) => entry.ref === ref)?.defaultLevel ?? null,
    },
    async ready(ms) {
      refreshCatalog(clock.now());
      const pending = catalogRead;
      if (pending === undefined) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
    async close() {
      await Promise.allSettled([catalogRead, quotaRead].filter((item) => item !== undefined));
    },
  };
}
