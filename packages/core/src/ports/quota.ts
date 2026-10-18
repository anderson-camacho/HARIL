// The quota port (docs/modos-y-delegacion.md 3.11, 4.2; ADR-0021 S1, S2, P4, P25, P26). A QuotaProvider reads how much
// of each account's 5-hour and weekly windows is used; the store keeps every reading as quota_samples rows and the
// cooldowns that 402 and 429 answers start. Nothing here guesses: a window the provider does not report is null, and a
// provider that cannot be read is Unavailable with its reason, which every view shows as "sin dato".

export type QuotaWindowName = "5h" | "7d";

export interface QuotaWindowReading {
  readonly name: QuotaWindowName;
  // Percent of the window used, from 0 to 100; null when the provider does not report it.
  readonly usedPct: number | null;
  // When the window starts over (epoch ms), or null.
  readonly resetsAt: number | null;
}

export interface QuotaAccountReading {
  // Opaque reference of the account: never an e-mail, a file name or a token.
  readonly credentialRef: string;
  // The account's kind as the gateway names it (claude, antigravity, codex...).
  readonly kind: string;
  // The model prefix that routes requests to this account (S2, P25: "Gemini1/..."), or null.
  readonly prefix: string | null;
  // The windows the provider reported; a missing window is "sin dato" for it.
  readonly windows: readonly QuotaWindowReading[];
  // Why a window is missing (no usage probe for this kind, the usage endpoint refused...), or null.
  readonly note: string | null;
}

export type QuotaUnavailableReason =
  | "not_configured"
  | "unauthorized"
  | "unreachable"
  | "timeout"
  | "not_found"
  | "malformed";

export type QuotaSnapshot =
  | {
      readonly ok: true;
      readonly sampledAt: number;
      // Where the reading came from, for example "cliproxyapi-management/v0".
      readonly source: string;
      readonly accounts: readonly QuotaAccountReading[];
    }
  | {
      readonly ok: false;
      readonly sampledAt: number;
      readonly reason: QuotaUnavailableReason;
      // A short explanation without any key or response body.
      readonly detail: string;
    };

export interface QuotaProvider {
  // The quota of one HARIL provider (haril.json's provider id); a provider this source does not serve is
  // Unavailable with not_configured.
  sample(providerId: string): Promise<QuotaSnapshot>;
}

// One stored reading: one window of one account, or, for a provider that could not be read, one row per window with
// no account and the reason in note. The rows of one sampling share a batch id.
export interface QuotaSampleRecord {
  readonly provider: string;
  readonly batchId: string;
  readonly credentialRef: string | null;
  readonly kind: string | null;
  readonly prefix: string | null;
  readonly window: QuotaWindowName;
  readonly usedPct: number | null;
  readonly resetsAt: number | null;
  readonly sampledAt: number;
  readonly source: string;
  readonly note: string | null;
}

// A model (or an account, keyed "quota:<quota key>") that may not be used before `until` (epoch ms): a 402 or 429
// from the gateway started it (3.11).
export interface ModelCooldownRecord {
  readonly model: string;
  readonly until: number;
  readonly reason: string;
}

// quota_samples and model_cooldowns. Both are observations of the providers, not task state, so they are written
// without the runtime lease: `haril quota` records what it read, and the runtime records a cooldown when a turn hears a
// 402 or 429.
export interface QuotaStorePort {
  // Records one sampling of a provider as one batch and returns the batch id.
  recordSnapshot(provider: string, snapshot: QuotaSnapshot): string;
  // The rows of each provider's newest batch, when that batch was sampled at or after `since`; an older batch is no
  // longer evidence ("sin dato").
  latest(since: number): readonly QuotaSampleRecord[];
  // Starts or extends a cooldown: an active cooldown is never shortened by a later, shorter one.
  setCooldown(input: ModelCooldownRecord): ModelCooldownRecord;
  // The cooldowns still active at `now`.
  cooldowns(now: number): readonly ModelCooldownRecord[];
}
