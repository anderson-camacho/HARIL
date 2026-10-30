import type { ToolRecord } from "./state.js";
import type { ToolId } from "./types.js";

// The latest published version of each tool, read from the redirect of github.com/<owner>/<repo>/releases/latest
// (".../releases/tag/v4.3.1"). The web redirect has no rate limit, unlike the API, and needs no token.

export const LATEST_TTL_MS = 24 * 3_600_000;
const FAILURE_COOLDOWN_MS = 3_600_000;
const LOOKUP_TIMEOUT_MS = 3_000;

const REPOSITORIES: Record<ToolId, string> = {
  engram: "Gentleman-Programming/engram",
  "gentle-ai": "Gentleman-Programming/gentle-ai",
};

// The part of fetch's Response that is read; the real fetch fits it and tests fake it.
interface LatestResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: { cancel(): Promise<unknown> } | null;
}

export type LatestFetch = (url: string, init?: RequestInit) => Promise<LatestResponse>;

export type LatestResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: string };

// Never throws: a failure is a short reason.
export async function lookupLatest(
  tool: ToolId,
  fetcher: LatestFetch,
  options: { readonly timeoutMs?: number } = {},
): Promise<LatestResult> {
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  let response: LatestResponse;
  try {
    response = await fetcher(`https://github.com/${REPOSITORIES[tool]}/releases/latest`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "HARIL-tools" },
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, reason: `timed out after ${timeoutMs} ms` };
    }
    return { ok: false, reason: `network error: ${shortMessage(error)}` };
  }
  try {
    await response.body?.cancel();
  } catch {
    // The body is not needed; failing to release it changes nothing.
  }
  const { status } = response;
  if (status >= 300 && status < 400) return tagFrom(response.headers.get("location"));
  if (status === 404) return { ok: false, reason: "no release found (HTTP 404)" };
  if (status >= 200 && status < 300) return { ok: false, reason: `no redirect (HTTP ${status})` };
  return { ok: false, reason: `HTTP ${status}` };
}

function tagFrom(location: string | null): LatestResult {
  if (location === null || location === "") {
    return { ok: false, reason: "the redirect has no Location header" };
  }
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1];
  if (tag === undefined) return { ok: false, reason: "no published release" };
  let decoded = tag;
  try {
    decoded = decodeURIComponent(tag);
  } catch {
    // An undecodable tag cannot be a version; the pattern below rejects it as it is.
  }
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(decoded)?.[1];
  if (version === undefined) {
    return { ok: false, reason: `unrecognized release tag "${decoded.slice(0, 40)}"` };
  }
  return { ok: true, version };
}

function shortMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 120);
}

function ageMs(iso: string | undefined, now: number): number | undefined {
  if (iso === undefined) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const age = now - at;
  // A timestamp in the future means the clock moved back: it proves nothing about how fresh the value is.
  return age < 0 ? undefined : age;
}

// Whether a background check should ask GitHub now: not inside the cooldown after a failure, not while the last good
// value is younger than the TTL. An explicit refresh ignores both.
export function lookupDue(record: ToolRecord | undefined, now: number): boolean {
  const sinceFailure = ageMs(record?.lastFailureAt, now);
  if (sinceFailure !== undefined && sinceFailure < FAILURE_COOLDOWN_MS) return false;
  const sinceCheck = ageMs(record?.latestCheckedAt, now);
  if (record?.latest !== undefined && sinceCheck !== undefined && sinceCheck < LATEST_TTL_MS) {
    return false;
  }
  return true;
}
