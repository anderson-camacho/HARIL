// The investigador's read of a public web page (feature haril-factory, F7): https only, no private address, no redirect
// followed without checking it again, and a size limit. It reads; it sends nothing but the request.

const MAX_CHARS = 200_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;
const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.localhost|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:|172\.(1[6-9]|2\d|3[01])\.)/i;

export type WebFetch = (
  url: string,
  init: { readonly redirect: "manual"; readonly signal: AbortSignal },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type WebRead =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string };

export function webUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url.slice(0, 200)}" is not a URL`;
  }
  if (parsed.protocol !== "https:") return "only https pages are read";
  if (parsed.username !== "" || parsed.password !== "") return "a URL with credentials is refused";
  if (PRIVATE_HOST.test(parsed.hostname)) return `${parsed.hostname} is not a public address`;
  return null;
}

export async function readWebPage(url: string, fetcher: WebFetch): Promise<WebRead> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = webUrlProblem(current);
    if (problem !== null) return { ok: false, reason: problem };
    const answer = await fetcher(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (answer.status >= 300 && answer.status < 400) {
      const next = answer.headers.get("location");
      if (next === null)
        return { ok: false, reason: `a redirect (${answer.status}) with no target` };
      current = new URL(next, current).toString();
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) {
      return { ok: false, reason: `the page answered ${answer.status}` };
    }
    const text = await answer.text();
    return { ok: true, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
  }
  return { ok: false, reason: "too many redirects" };
}
