// Downloads one file from GitHub into memory, with the limits a stranger's server is held to: https only, a short list
// of hosts that every redirect must stay inside, one overall deadline, and a size cap that stops the reading.

export const ALLOWED_DOWNLOAD_HOSTS: readonly string[] = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

const MAX_REDIRECTS = 5;

interface BodyReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
}

// The part of fetch's Response that is read; the real fetch fits it and tests use real Response objects.
interface DownloadResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: { getReader(): BodyReader } | null;
}

export type DownloadFetch = (url: string, init?: RequestInit) => Promise<DownloadResponse>;

export type DownloadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

// Why a URL may not be requested, or undefined when it may.
export function downloadProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return `${url.protocol}// is not allowed, only https`;
  if (url.username !== "" || url.password !== "") return "credentials in a URL are not allowed";
  if (url.port !== "") return "a custom port is not allowed";
  if (!ALLOWED_DOWNLOAD_HOSTS.includes(url.hostname)) return `host ${url.hostname} is not allowed`;
  return undefined;
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${bytes} bytes`;
}

// Rejects when the signal fires, whether or not the promise (a fetch or a read that ignores it) ever settles.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function release(response: DownloadResponse): Promise<void> {
  try {
    await response.body?.getReader().cancel();
  } catch {
    // The body is not needed; failing to release it changes nothing.
  }
}

async function readBody(
  response: DownloadResponse,
  signal: AbortSignal,
  maxBytes: number,
): Promise<DownloadResult> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { ok: true, bytes: new Uint8Array(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: `the download is larger than ${sizeText(maxBytes)}` };
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

export async function downloadBytes(
  url: string,
  fetcher: DownloadFetch,
  options: { readonly timeoutMs: number; readonly maxBytes?: number },
): Promise<DownloadResult> {
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  // One deadline for the whole download, redirects and body included.
  const signal = AbortSignal.timeout(options.timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const problem = downloadProblem(current);
      if (problem !== undefined) {
        return { ok: false, reason: `${hop === 0 ? "download" : "redirect"} refused: ${problem}` };
      }
      const response = await raceAbort(
        fetcher(current, {
          redirect: "manual",
          signal,
          headers: { "User-Agent": "HARIL-tools" },
        }),
        signal,
      );
      const { status } = response;
      if (status >= 300 && status < 400) {
        await release(response);
        const location = response.headers.get("location");
        if (location === null || location === "") {
          return { ok: false, reason: "a redirect has no Location header" };
        }
        try {
          current = new URL(location, current).href;
        } catch {
          return { ok: false, reason: "a redirect has an invalid Location header" };
        }
        continue;
      }
      if (status !== 200) {
        await release(response);
        return { ok: false, reason: `HTTP ${status}` };
      }
      const announced = Number(response.headers.get("content-length"));
      if (Number.isFinite(announced) && announced > maxBytes) {
        await release(response);
        return { ok: false, reason: `the download is larger than ${sizeText(maxBytes)}` };
      }
      return await readBody(response, signal, maxBytes);
    }
    return { ok: false, reason: "too many redirects" };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { ok: false, reason: `timed out after ${options.timeoutMs} ms` };
    }
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `network error: ${text.slice(0, 120)}` };
  }
}
