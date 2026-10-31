import { describe, expect, it } from "vitest";
import {
  ALLOWED_DOWNLOAD_HOSTS,
  type DownloadFetch,
  downloadBytes,
  downloadProblem,
  MAX_DOWNLOAD_BYTES,
} from "../src/tools/download.js";

const URL_OK = "https://github.com/Gentleman-Programming/engram/releases/download/v3.6.0/a.zip";

function bodyOf(text: string, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(text), { status: 200, headers });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function scripted(routes: Record<string, () => Response>): {
  fetcher: DownloadFetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: DownloadFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`unexpected request to ${url}`);
    return route();
  };
  return { fetcher, calls };
}

describe("which download URLs are acceptable", () => {
  it("lists exactly the three GitHub hosts", () => {
    expect([...ALLOWED_DOWNLOAD_HOSTS].sort()).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
  });

  it.each([
    URL_OK,
    "https://objects.githubusercontent.com/github-production-release-asset/x?sig=1",
    "https://release-assets.githubusercontent.com/github-production-release-asset/x",
    "https://GitHub.com/Gentleman-Programming/engram/releases/download/v3.6.0/a.zip",
  ])("accepts %s", (url) => {
    expect(downloadProblem(url)).toBeUndefined();
  });

  it.each([
    ["plain http", "http://github.com/x"],
    ["another host", "https://evil.example.com/x"],
    ["a look-alike suffix", "https://github.com.evil.com/x"],
    ["a look-alike prefix", "https://evilgithub.com/x"],
    ["an unlisted subdomain", "https://api.github.com/x"],
    ["credentials in the URL", "https://user:pw@github.com/x"],
    ["a custom port", "https://github.com:8443/x"],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL", "not a url"],
  ])("rejects %s", (_name, url) => {
    expect(downloadProblem(url)).toEqual(expect.any(String));
  });
});

describe("downloading bytes", () => {
  it("returns the body of a 200 with manual redirects and a timeout signal", async () => {
    const { fetcher, calls } = scripted({ [URL_OK]: () => bodyOf("hello") });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && Buffer.from(result.bytes).toString()).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("follows redirects to the allowed hosts, resolving a relative Location", async () => {
    const cdn = "https://release-assets.githubusercontent.com/obj?sig=1";
    const { fetcher, calls } = scripted({
      [URL_OK]: () => redirect(cdn),
      [cdn]: () => redirect("/obj2?sig=2", 307),
      "https://release-assets.githubusercontent.com/obj2?sig=2": () => bodyOf("archive"),
    });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(result.ok && Buffer.from(result.bytes).toString()).toBe("archive");
    expect(calls).toHaveLength(3);
  });

  it("rejects a redirect to a host that is not allowed without ever requesting it", async () => {
    const { fetcher, calls } = scripted({
      [URL_OK]: () => redirect("https://evil.example.com/steal"),
    });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("not allowed");
    expect(calls.map((call) => call.url)).toEqual([URL_OK]);
  });

  it("rejects a redirect that downgrades to http", async () => {
    const { fetcher } = scripted({ [URL_OK]: () => redirect("http://github.com/x") });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(!result.ok && result.reason).toContain("not allowed");
  });

  it("rejects an initial URL that is not allowed", async () => {
    const { fetcher, calls } = scripted({});
    const result = await downloadBytes("https://evil.example.com/a", fetcher, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("gives up on a redirect loop", async () => {
    const { fetcher, calls } = scripted({ [URL_OK]: () => redirect(URL_OK) });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(!result.ok && result.reason).toContain("too many redirects");
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("fails a redirect without a Location", async () => {
    const { fetcher } = scripted({ [URL_OK]: () => new Response(null, { status: 302 }) });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(!result.ok && result.reason).toContain("Location");
  });

  it("reports an HTTP error status", async () => {
    const { fetcher } = scripted({ [URL_OK]: () => new Response("no", { status: 404 }) });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(!result.ok && result.reason).toBe("HTTP 404");
  });

  it("reports a network failure briefly and never throws", async () => {
    const fetcher: DownloadFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(!result.ok && result.reason).toBe("network error: fetch failed");
  });

  it("times out a request that never answers", async () => {
    const fetcher: DownloadFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 30 });
    expect(!result.ok && result.reason).toBe("timed out after 30 ms");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("times out a body that stalls after the headers, even if the fetch ignores the signal", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      pull: () => new Promise<void>(() => undefined),
    });
    const fetcher: DownloadFetch = async () => new Response(stalled, { status: 200 });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 30 });
    expect(!result.ok && result.reason).toBe("timed out after 30 ms");
  });

  it("caps the download at 150 MiB by default", () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(150 * 1024 * 1024);
  });

  it("refuses at once a body that announces more than the cap", async () => {
    const { fetcher } = scripted({
      [URL_OK]: () => bodyOf("x", { "content-length": String(MAX_DOWNLOAD_BYTES + 1) }),
    });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000 });
    expect(!result.ok && result.reason).toContain("larger than");
  });

  it("stops reading a body that goes past the cap and cancels it", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(400));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: DownloadFetch = async () => new Response(endless, { status: 200 });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000, maxBytes: 1000 });
    expect(!result.ok && result.reason).toContain("larger than");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  it("accepts a body exactly at the cap", async () => {
    const { fetcher } = scripted({ [URL_OK]: () => bodyOf("12345") });
    const result = await downloadBytes(URL_OK, fetcher, { timeoutMs: 1000, maxBytes: 5 });
    expect(result.ok).toBe(true);
  });
});
