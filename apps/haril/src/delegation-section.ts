// The `delegation` section of haril.json (docs/modos-y-delegacion.md 5), as far as this release reads it: `quota`
// (phase F6). Phase F7 adds the rest of the section (limits, context, models, commands, autonomy, watchdog) and its
// editor; until then those keys are refused with their JSON path, as any unknown key is. Keys are never stored here: the
// management key lives in the environment variable that managementKeyEnv names (P7).

interface QuotaSettings {
  readonly source: "cliproxyapi-management";
  // The management server's URL; null means the origin of the cliproxy provider's baseUrl.
  readonly managementBaseUrl: string | null;
  readonly managementKeyEnv: string;
  readonly switchAtPercent5h: number;
  readonly stopAtPercentWeekly: number;
  readonly minRemainingPercentForLargeTask: number;
  readonly maxWaitMs: number;
}

export interface DelegationSettings {
  readonly quota: QuotaSettings;
}

// Section 5's initial values.
const DEFAULT_QUOTA_SETTINGS: QuotaSettings = Object.freeze({
  source: "cliproxyapi-management",
  managementBaseUrl: null,
  managementKeyEnv: "CLIPROXYAPI_MANAGEMENT_KEY",
  switchAtPercent5h: 80,
  stopAtPercentWeekly: 80,
  minRemainingPercentForLargeTask: 20,
  maxWaitMs: 18_000_000,
});

const SECTION_KEYS: ReadonlySet<string> = new Set(["quota"]);
const LATER_KEYS: ReadonlySet<string> = new Set([
  "limits",
  "context",
  "models",
  "commands",
  "autonomy",
  "watchdog",
]);
const QUOTA_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_QUOTA_SETTINGS));
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_WAIT_MS = 7 * 24 * 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function percentError(path: string, value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? null
    : `${path}: must be a number from 0 to 100`;
}

// Every problem of the section, each with its JSON path; empty when it is valid.
export function delegationSectionErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["/delegation: must be an object"];
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (SECTION_KEYS.has(key)) continue;
    errors.push(
      LATER_KEYS.has(key)
        ? `/delegation/${key}: not read by this release yet (phase F7 adds it)`
        : `/delegation/${key}: unknown key`,
    );
  }
  if (!("quota" in value)) return errors;
  const quota = value.quota;
  if (!isRecord(quota)) return [...errors, "/delegation/quota: must be an object"];
  for (const key of Object.keys(quota)) {
    if (key === "managementKey" || key === "apiKey") {
      errors.push(
        `/delegation/quota/${key}: keys are never stored in haril.json; use managementKeyEnv`,
      );
    } else if (!QUOTA_KEYS.has(key)) {
      errors.push(`/delegation/quota/${key}: unknown key`);
    }
  }
  if ("source" in quota && quota.source !== "cliproxyapi-management") {
    errors.push('/delegation/quota/source: must be "cliproxyapi-management"');
  }
  if (
    "managementBaseUrl" in quota &&
    quota.managementBaseUrl !== null &&
    (typeof quota.managementBaseUrl !== "string" || !isHttpUrl(quota.managementBaseUrl))
  ) {
    errors.push("/delegation/quota/managementBaseUrl: must be null or an http(s) URL");
  }
  if (
    "managementKeyEnv" in quota &&
    (typeof quota.managementKeyEnv !== "string" || !ENV_NAME.test(quota.managementKeyEnv))
  ) {
    errors.push(
      "/delegation/quota/managementKeyEnv: must be an environment variable name (letters, digits and _)",
    );
  }
  for (const key of [
    "switchAtPercent5h",
    "stopAtPercentWeekly",
    "minRemainingPercentForLargeTask",
  ] as const) {
    if (key in quota) {
      const error = percentError(`/delegation/quota/${key}`, quota[key]);
      if (error !== null) errors.push(error);
    }
  }
  if (
    "maxWaitMs" in quota &&
    !(
      typeof quota.maxWaitMs === "number" &&
      Number.isSafeInteger(quota.maxWaitMs) &&
      quota.maxWaitMs >= 0 &&
      quota.maxWaitMs <= MAX_WAIT_MS
    )
  ) {
    errors.push(`/delegation/quota/maxWaitMs: must be a whole number from 0 to ${MAX_WAIT_MS}`);
  }
  return errors;
}

// The settings of a section that delegationSectionErrors accepted; absent values take section 5's defaults.
export function delegationSettingsOf(value: unknown): DelegationSettings {
  const quota = isRecord(value) && isRecord(value.quota) ? value.quota : {};
  return { quota: { ...DEFAULT_QUOTA_SETTINGS, ...(quota as Partial<QuotaSettings>) } };
}
