import { createHash } from "node:crypto";
import type { SecretMaterial } from "@haril/contracts";
import type {
  QuotaAccountReading,
  QuotaProvider,
  QuotaSnapshot,
  QuotaUnavailableReason,
  QuotaWindowReading,
} from "@haril/core/ports";

// Quota read through CLIProxyAPI's management API (docs/modos-y-delegacion.md 3.11; ADR-0021 S1, S2, P25, P26). With the
// management key (Bearer), GET <base>/v<n>/management/auth-files lists the accounts, and POST .../api-call asks each
// account's usage endpoint with that account's own token, which CLIProxyAPI puts where the "$TOKEN$" placeholder is.
// /v8/management is tried first because /v0 is marked close to deprecation; a 404 there falls back to /v0. A 401 or
// 403 stops at once: five failed attempts lock the address out for about 30 minutes, so the key is never retried.
// Unreachable, refused or unparsable answers are "sin dato" (Unavailable), never a guess and never a crash. The key is
// revealed only for the Authorization header; no message, note or result carries it, an account's e-mail, file name or
// a response body.
//
// The usage endpoints and their shapes come from the S1 spike and the community extension pi-cliproxyapi-quota
// (https://github.com/songhuiming2007-coder/pi-cliproxyapi-quota), not from official documentation:
//   - claude: GET https://api.anthropic.com/api/oauth/usage, five_hour and seven_day with utilization (percent) and
//     resets_at (verified by the extension's author);
//   - antigravity and gemini: POST .../v1internal:retrieveUserQuotaSummary with the account's project, groups[].buckets[]
//     with remainingFraction (0 to 1), window ("5h" or "weekly") and resetTime (verified by the extension's author);
//   - codex: GET https://chatgpt.com/backend-api/wham/usage, primary and secondary used_percent (unverified).
// Every other kind is listed with a note and no window. The api-call body carries auth_index and data, as the S1 spike
// read in CLIProxyAPI v8.0.32 (P26), and also the extension's authIndex and body, which the server ignores when it does
// not know them.

const API_VERSIONS = ["v8", "v0"] as const;
const TOKEN = "Bearer $TOKEN$";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GOOGLE_LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const GOOGLE_QUOTA_HOSTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
] as const;
const GOOGLE_QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
const GOOGLE_USER_AGENT = "antigravity/cli/1.0.13";
const GOOGLE_KINDS: ReadonlySet<string> = new Set(["antigravity", "gemini", "gemini-cli"]);
const SIX_HOURS_S = 6 * 3600;
const SIX_DAYS_S = 6 * 86_400;

export interface CliProxyQuotaOptions {
  // The haril.json provider this management server stands behind; any other provider is not_configured.
  readonly providerId: string;
  // The server's origin, for example http://127.0.0.1:8317 (a path after it is ignored).
  readonly baseUrl: string;
  // The management key, sealed. Undefined when its variable is not set: the provider is then not_configured.
  readonly credential: SecretMaterial | undefined;
  // The name of the variable that holds the key, for the not_configured message.
  readonly keyEnv: string;
  // Deadline of each request.
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly fetch?: typeof fetch;
}

interface Account {
  readonly authIndex: string;
  readonly kind: string;
  readonly prefix: string | null;
  readonly projectId: string | null;
  readonly credentialRef: string;
  readonly plan: string | null;
}

class Unavailable extends Error {
  readonly reason: QuotaUnavailableReason;
  constructor(reason: QuotaUnavailableReason, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

interface Response200 {
  readonly status: number;
  readonly body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

// A used percentage the rule can trust: a negative or non-numeric value is unknown; a value over 100 means the window
// is spent, so it reads as 100.
function percent(value: unknown): number | null {
  const number = numberOf(value);
  if (number === null || number < 0) return null;
  return Math.min(100, number);
}

// An instant as an ISO date, epoch seconds or epoch milliseconds; null when it is none of them.
function instant(value: unknown): number | null {
  const number = numberOf(value);
  if (number !== null) return number > 0 ? (number < 1e12 ? number * 1000 : number) : null;
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

// The account kind as the extension normalizes it: provider (else type), lower case, "_" as "-".
function kindOf(entry: Record<string, unknown>): string {
  const raw = text(entry.provider) ?? text(entry.type) ?? "unknown";
  return raw.toLowerCase().replace(/_/g, "-");
}

// The plan the gateway names, when it is a short word: anything else (an address, a file name) is not shown.
function planOf(entry: Record<string, unknown>): string | null {
  const plan = text(entry.plan) ?? text(entry.plan_type) ?? text(entry.account_type);
  return plan !== null && /^[A-Za-z0-9 _.-]{1,32}$/.test(plan) ? plan : null;
}

function opaqueRef(providerId: string, authIndex: string): string {
  return `acct-${createHash("sha256").update(`${providerId}\u0000${authIndex}`, "utf8").digest("hex").slice(0, 12)}`;
}

function accountsOf(providerId: string, body: unknown): Account[] {
  const files = isRecord(body) ? body.files : Array.isArray(body) ? body : undefined;
  if (!Array.isArray(files)) throw new Unavailable("malformed", "auth-files has no file list");
  const accounts: Account[] = [];
  for (const entry of files) {
    if (!isRecord(entry) || entry.disabled === true) continue;
    const authIndex = text(entry.auth_index);
    if (authIndex === null) continue;
    accounts.push({
      authIndex,
      kind: kindOf(entry),
      prefix: text(entry.prefix),
      projectId: text(entry.project_id),
      credentialRef: opaqueRef(providerId, authIndex),
      plan: planOf(entry),
    });
  }
  return accounts;
}

// --- usage parsers -------------------------------------------------------------------------------------------------

function window(
  name: QuotaWindowReading["name"],
  usedPct: number | null,
  resetsAt: number | null,
): QuotaWindowReading {
  return { name, usedPct, resetsAt };
}

function claudeWindows(body: unknown): QuotaWindowReading[] {
  if (!isRecord(body)) return [];
  const out: QuotaWindowReading[] = [];
  for (const [key, name] of [
    ["five_hour", "5h"],
    ["seven_day", "7d"],
  ] as const) {
    const slot = body[key];
    if (!isRecord(slot)) continue;
    const used = percent(slot.utilization);
    if (used !== null) out.push(window(name, used, instant(slot.resets_at)));
  }
  return out;
}

// A list of model ids as a usage answer may give it: strings, or objects that name the model.
function modelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const id = isRecord(item)
      ? (text(item.id) ?? text(item.modelId) ?? text(item.model) ?? text(item.name))
      : text(item);
    return id === null ? [] : [id];
  });
}

function modelsOf(entry: Record<string, unknown>): string[] {
  return [...modelIds(entry.models), ...modelIds(entry.modelIds)];
}

function groupName(group: Record<string, unknown>): string | null {
  return (
    text(group.displayName) ??
    text(group.display_name) ??
    text(group.name) ??
    text(group.title) ??
    text(group.label)
  );
}

// Google's answer holds pools of models. The most used bucket of each window is the account's worst reading, which holds
// back a model no group is known for (P4's spirit); each named group keeps its own readings as well.
function googleWindows(body: unknown): QuotaWindowReading[] {
  if (!isRecord(body)) return [];
  const buckets: { bucket: unknown; group: string | null; models: readonly string[] }[] = [];
  if (Array.isArray(body.buckets)) {
    for (const bucket of body.buckets) buckets.push({ bucket, group: null, models: [] });
  }
  if (Array.isArray(body.groups)) {
    for (const group of body.groups) {
      if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
      for (const bucket of group.buckets) {
        buckets.push({ bucket, group: groupName(group), models: modelsOf(group) });
      }
    }
  }
  const worst = new Map<QuotaWindowReading["name"], QuotaWindowReading>();
  const grouped = new Map<string, QuotaWindowReading>();
  for (const { bucket, group, models } of buckets) {
    if (!isRecord(bucket)) continue;
    const label = text(bucket.window)?.toLowerCase();
    const name = label === "5h" ? "5h" : label === "weekly" || label === "7d" ? "7d" : null;
    const remaining = numberOf(bucket.remainingFraction);
    if (name === null || remaining === null || remaining < 0) continue;
    const used = Math.round((1 - Math.min(1, remaining)) * 10_000) / 100;
    const reading = window(name, used, instant(bucket.resetTime));
    const current = worst.get(name);
    if (current === undefined || used > (current.usedPct ?? -1)) worst.set(name, reading);
    if (group === null) continue;
    const key = `${group}\u0000${name}`;
    const own = grouped.get(key);
    const known = [...new Set([...models, ...modelsOf(bucket), ...(own?.models ?? [])])];
    if (own === undefined || used > (own.usedPct ?? -1)) {
      grouped.set(key, { ...reading, group, ...(known.length === 0 ? {} : { models: known }) });
    } else if (known.length > 0) {
      grouped.set(key, { ...own, models: known });
    }
  }
  return [...worst.values(), ...grouped.values()];
}

// Codex (unverified): primary and secondary slots; a slot names its length in window_minutes or limit_window_seconds
// when it can, else primary is the 5-hour window and secondary the weekly one, as the extension reads them.
function codexWindows(body: unknown, now: number): QuotaWindowReading[] {
  if (!isRecord(body)) return [];
  const root = isRecord(body.rate_limits)
    ? body.rate_limits
    : isRecord(body.rate_limit)
      ? body.rate_limit
      : body;
  const out: QuotaWindowReading[] = [];
  for (const [keys, fallback] of [
    [["primary", "primary_window"], "5h"],
    [["secondary", "secondary_window"], "7d"],
  ] as const) {
    const slot = keys.map((key) => root[key]).find(isRecord);
    if (slot === undefined) continue;
    const used = percent(slot.used_percent ?? slot.usedPercent);
    if (used === null) continue;
    const minutes = numberOf(slot.window_minutes);
    const seconds = minutes !== null ? minutes * 60 : numberOf(slot.limit_window_seconds);
    const name =
      seconds === null
        ? fallback
        : seconds <= SIX_HOURS_S
          ? "5h"
          : seconds >= SIX_DAYS_S
            ? "7d"
            : null;
    if (name === null) continue;
    const inSeconds = numberOf(
      slot.resets_in_seconds ?? slot.resetsInSeconds ?? slot.reset_after_seconds,
    );
    const resetsAt =
      inSeconds !== null && inSeconds >= 0
        ? now + inSeconds * 1000
        : instant(slot.resets_at ?? slot.reset_at);
    out.push(window(name, used, resetsAt));
  }
  return out;
}

function googleProject(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const project = body.cloudaicompanionProject;
  return text(project) ?? (isRecord(project) ? text(project.id) : null);
}

// --- the adapter ---------------------------------------------------------------------------------------------------

export function createCliProxyQuotaProvider(options: CliProxyQuotaOptions): QuotaProvider {
  const origin = (() => {
    try {
      return new URL(options.baseUrl).origin;
    } catch {
      return null;
    }
  })();
  const fetchImpl = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

  async function request(
    url: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<Response200> {
    const key = options.credential?.reveal() ?? "";
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: init.method,
          headers: {
            authorization: `Bearer ${key}`,
            accept: "application/json",
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: controller.signal,
        });
      } catch {
        throw timedOut
          ? new Unavailable(
              "timeout",
              `the management API did not answer within ${options.timeoutMs} ms`,
            )
          : new Unavailable("unreachable", `the management API is unreachable at ${origin}`);
      }
      let raw: string;
      try {
        raw = await response.text();
      } catch {
        throw timedOut
          ? new Unavailable(
              "timeout",
              `the management API did not answer within ${options.timeoutMs} ms`,
            )
          : new Unavailable("unreachable", "the management API closed the answer early");
      }
      let body: unknown = null;
      if (raw.trim() !== "") {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          body = undefined;
        }
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  // auth-files on /v8, then on /v0 when /v8 does not exist. Returns the version that answered and its accounts.
  async function listAccounts(): Promise<{ version: string; accounts: Account[] }> {
    for (const version of API_VERSIONS) {
      const answer = await request(`${origin}/${version}/management/auth-files`, { method: "GET" });
      if (answer.status === 401 || answer.status === 403) {
        throw new Unavailable(
          "unauthorized",
          `the management API refused the key in ${options.keyEnv} (HTTP ${answer.status}); it is not retried, since repeated failures lock the address out`,
        );
      }
      if (answer.status === 404) continue;
      if (answer.status < 200 || answer.status > 299) {
        throw new Unavailable("unreachable", `the management API answered HTTP ${answer.status}`);
      }
      if (answer.body === undefined) {
        throw new Unavailable("malformed", "auth-files did not answer JSON");
      }
      return { version, accounts: accountsOf(options.providerId, answer.body) };
    }
    throw new Unavailable(
      "not_found",
      "the management API is not enabled (no /v8/management or /v0/management)",
    );
  }

  // One call through the account's token. Its answer, or a note saying why there is none.
  async function apiCall(
    version: string,
    account: Account,
    call: { method: "GET" | "POST"; url: string; header: Record<string, string>; data?: unknown },
  ): Promise<{ ok: true; body: unknown } | { ok: false; note: string }> {
    const data = call.data === undefined ? undefined : JSON.stringify(call.data);
    let answer: Response200;
    try {
      answer = await request(`${origin}/${version}/management/api-call`, {
        method: "POST",
        body: {
          auth_index: account.authIndex,
          authIndex: account.authIndex,
          method: call.method,
          url: call.url,
          header: call.header,
          ...(data === undefined ? {} : { data, body: data }),
        },
      });
    } catch (error) {
      return { ok: false, note: error instanceof Unavailable ? error.message : "api-call failed" };
    }
    if (answer.status < 200 || answer.status > 299) {
      return { ok: false, note: `the management API refused api-call (HTTP ${answer.status})` };
    }
    if (!isRecord(answer.body)) return { ok: false, note: "api-call did not answer JSON" };
    const status = numberOf(answer.body.status_code ?? answer.body.statusCode);
    if (status === null || status < 200 || status > 299) {
      return {
        ok: false,
        note: `the usage endpoint answered HTTP ${status === null ? "?" : status}`,
      };
    }
    const inner = answer.body.body;
    if (typeof inner !== "string") return { ok: true, body: inner };
    try {
      return { ok: true, body: JSON.parse(inner) as unknown };
    } catch {
      return { ok: false, note: "the usage endpoint did not answer JSON" };
    }
  }

  async function readAccount(version: string, account: Account): Promise<QuotaAccountReading> {
    const base = {
      credentialRef: account.credentialRef,
      kind: account.kind,
      prefix: account.prefix,
      ...(account.plan === null ? {} : { plan: account.plan }),
    };
    const done = (windows: QuotaWindowReading[], note: string | null): QuotaAccountReading => ({
      ...base,
      windows,
      note: windows.length === 0 && note === null ? "the usage answer had no window" : note,
    });
    if (account.kind === "claude") {
      const answer = await apiCall(version, account, {
        method: "GET",
        url: CLAUDE_USAGE_URL,
        header: {
          Authorization: TOKEN,
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      return answer.ok ? done(claudeWindows(answer.body), null) : done([], answer.note);
    }
    if (account.kind === "codex") {
      const answer = await apiCall(version, account, {
        method: "GET",
        url: CODEX_USAGE_URL,
        header: { Authorization: TOKEN, "Content-Type": "application/json" },
      });
      return answer.ok
        ? done(codexWindows(answer.body, options.now()), "codex windows are unverified")
        : done([], answer.note);
    }
    if (GOOGLE_KINDS.has(account.kind)) {
      const header = {
        Authorization: TOKEN,
        "Content-Type": "application/json",
        "User-Agent": GOOGLE_USER_AGENT,
      };
      let project = account.projectId;
      if (project === null) {
        const loaded = await apiCall(version, account, {
          method: "POST",
          url: GOOGLE_LOAD_URL,
          header,
          data: { metadata: { ideType: "ANTIGRAVITY" } },
        });
        if (!loaded.ok) return done([], loaded.note);
        project = googleProject(loaded.body);
        if (project === null) return done([], "the account names no project");
      }
      let last = "the quota endpoint did not answer";
      for (const host of GOOGLE_QUOTA_HOSTS) {
        const answer = await apiCall(version, account, {
          method: "POST",
          url: `${host}${GOOGLE_QUOTA_PATH}`,
          header,
          data: { project },
        });
        if (!answer.ok) {
          last = answer.note;
          continue;
        }
        const windows = googleWindows(answer.body);
        if (windows.length > 0) return done(windows, null);
        last = "the quota answer had no 5h or weekly bucket";
      }
      return done([], last);
    }
    return done([], `no usage probe for ${account.kind}`);
  }

  return {
    async sample(providerId) {
      const sampledAt = options.now();
      const unavailable = (reason: QuotaUnavailableReason, detail: string): QuotaSnapshot => ({
        ok: false,
        sampledAt,
        reason,
        detail,
      });
      if (providerId !== options.providerId) {
        return unavailable("not_configured", `no quota source for provider ${providerId}`);
      }
      if (origin === null) {
        return unavailable("not_configured", "the management URL is not a valid URL");
      }
      if (options.credential === undefined || options.credential.reveal() === "") {
        return unavailable("not_configured", `${options.keyEnv} is not set`);
      }
      try {
        const { version, accounts } = await listAccounts();
        const readings = await Promise.all(
          accounts.map((account) => readAccount(version, account)),
        );
        return {
          ok: true,
          sampledAt,
          source: `cliproxyapi-management/${version}`,
          accounts: readings,
        };
      } catch (error) {
        if (error instanceof Unavailable) return unavailable(error.reason, error.message);
        return unavailable("malformed", "the management API answer could not be read");
      }
    },
  };
}
