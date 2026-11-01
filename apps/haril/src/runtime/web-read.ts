import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// The investigador's read of a public web page (feature haril-factory, F7): https only, no address that is not public, no
// redirect followed without checking it again, one time limit for the whole read and a limit on what is read of the body,
// applied as it streams. It reads; it sends nothing but the request.
// A name is checked by resolving it: every address it answers must be public, on every hop. The default fetch then pins
// that check to the connection: the socket's own lookup refuses the same way and hands the connection only addresses it
// checked, so a name that answers differently the second time (DNS rebinding) gets no way in. A fetch passed in place of
// the default (tests) has only the first check.

const MAX_CHARS = 200_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;
const PRIVATE_NAME = /(^localhost$|\.localhost$|\.local$|\.internal$)/i;

// Two lists: a BlockList also matches an IPv4 address against IPv4-in-IPv6 rules, and those here cover every IPv4 address.
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4 in IPv6, whatever the address inside: IPv4-compatible, IPv4-mapped, NAT64 and 6to4 and Teredo.
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["2002::", 16],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC_V6.addSubnet(network, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4
    ? !NOT_PUBLIC_V4.check(address, "ipv4")
    : !NOT_PUBLIC_V6.check(address, "ipv6");
}

// Every address a name answers; an empty answer is no answer.
export type WebLookup = (hostname: string) => Promise<readonly string[]>;

interface WebAnswer {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
  // Ends the connection when the read stops before the body does.
  readonly cancel?: () => void;
}

export type WebFetch = (
  url: string,
  init: { readonly redirect: "manual"; readonly signal: AbortSignal },
) => Promise<WebAnswer>;

export type WebRead =
  | { readonly ok: true; readonly text: string; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string };

function hostOf(parsed: URL): string {
  return parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function webUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `"${url.slice(0, 200)}" is not a URL`;
  }
  if (parsed.protocol !== "https:") return "only https pages are read";
  if (parsed.username !== "" || parsed.password !== "") return "a URL with credentials is refused";
  const host = hostOf(parsed);
  const hidden = isIP(host) === 0 ? PRIVATE_NAME.test(host) : !isPublicAddress(host);
  return hidden ? `${parsed.hostname} is not a public address` : null;
}

const systemLookup: WebLookup = async (hostname) =>
  (await dnsLookupAll(hostname, { all: true, verbatim: true })).map((row) => row.address);

// What the socket connects to: only addresses that pass, all of them or none.
const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
    const fail = (cause: NodeJS.ErrnoException): void => {
      callback(cause, "", 0);
    };
    if (error !== null) return fail(error);
    const first = addresses[0];
    if (first === undefined) return fail(new Error(`${hostname} has no address`));
    if (addresses.some((row) => !isPublicAddress(row.address))) {
      return fail(new Error(`${hostname} is not a public address`));
    }
    if (options.all === true) {
      (callback as unknown as (cause: null, rows: LookupAddress[]) => void)(null, addresses);
    } else {
      callback(null, first.address, first.family);
    }
  });
};

// One request with no shared connection, on addresses pinnedLookup checked. No compression is asked for, so the limit on
// the body is a limit on what arrives.
export const pinnedWebFetch: WebFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup,
        signal: init.signal,
        headers: { "user-agent": "HARIL", accept: "text/html,text/plain,*/*;q=0.5" },
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: {
            get: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
            },
          },
          body: response,
          cancel: () => request.destroy(),
        });
      },
    );
    request.once("error", reject);
    request.end();
  });

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(new Error("the read passed its time limit"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

export interface WebReadOptions {
  readonly lookup?: WebLookup;
  readonly timeoutMs?: number;
}

async function readBody(
  answer: WebAnswer,
  deadline: Promise<never>,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (answer.body === null) return { text: "", truncated: false };
  const decoder = new TextDecoder();
  const chunks = answer.body[Symbol.asyncIterator]();
  let text = "";
  for (;;) {
    const step = await Promise.race([chunks.next(), deadline]);
    if (step.done === true) return { text: text + decoder.decode(), truncated: false };
    text += decoder.decode(step.value, { stream: true });
    if (text.length > MAX_CHARS) {
      // A generator that is parked awaiting its next chunk answers return() only when that chunk comes: never waited on.
      void chunks.return?.()?.catch(() => undefined);
      return { text: text.slice(0, MAX_CHARS), truncated: true };
    }
  }
}

async function follow(
  url: string,
  fetcher: WebFetch,
  lookup: WebLookup,
  signal: AbortSignal,
): Promise<WebRead> {
  const deadline = aborted(signal);
  deadline.catch(() => undefined);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const problem = webUrlProblem(current);
    if (problem !== null) return { ok: false, reason: problem };
    const parsed = new URL(current);
    const host = hostOf(parsed);
    if (isIP(host) === 0) {
      const addresses = await Promise.race([lookup(host), deadline]);
      if (addresses.length === 0) return { ok: false, reason: `${host} has no address` };
      if (addresses.some((address) => !isPublicAddress(address))) {
        return { ok: false, reason: `${host} is not a public address` };
      }
    }
    const answer = await Promise.race([fetcher(current, { redirect: "manual", signal }), deadline]);
    if (answer.status >= 300 && answer.status < 400) {
      answer.cancel?.();
      const next = answer.headers.get("location");
      if (next === null) {
        return { ok: false, reason: `a redirect (${answer.status}) with no target` };
      }
      current = new URL(next, current).toString();
      continue;
    }
    if (answer.status < 200 || answer.status >= 300) {
      answer.cancel?.();
      return { ok: false, reason: `the page answered ${answer.status}` };
    }
    try {
      const body = await readBody(answer, deadline);
      return { ok: true, ...body };
    } finally {
      answer.cancel?.();
    }
  }
  return { ok: false, reason: "too many redirects" };
}

export async function readWebPage(
  url: string,
  fetcher: WebFetch = pinnedWebFetch,
  options: WebReadOptions = {},
): Promise<WebRead> {
  const stop = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
  try {
    return await follow(url, fetcher, options.lookup ?? systemLookup, stop);
  } catch (error) {
    const reason = stop.aborted
      ? "the read passed its time limit"
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, reason };
  }
}
