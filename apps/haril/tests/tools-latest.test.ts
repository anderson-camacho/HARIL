import { describe, expect, it } from "vitest";
import { type LatestFetch, lookupDue, lookupLatest } from "../src/tools/latest.js";

function reply(status: number, location?: string): LatestFetch {
  return async () => ({
    status,
    headers: new Headers(location === undefined ? {} : { location }),
    body: null,
  });
}

const TAG = "https://github.com/Gentleman-Programming/gentle-ai/releases/tag";

describe("the latest version from the releases/latest redirect", () => {
  it("reads the tag from the Location header", async () => {
    expect(await lookupLatest("gentle-ai", reply(302, `${TAG}/v4.3.1`))).toEqual({
      ok: true,
      version: "4.3.1",
    });
  });

  it("asks the right URL without following the redirect, with a 3 s limit", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher: LatestFetch = async (url, init) => {
      seen.push({ url, init: init ?? {} });
      return { status: 302, headers: new Headers({ location: `${TAG}/v3.6.0` }), body: null };
    };
    await lookupLatest("engram", fetcher);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://github.com/Gentleman-Programming/engram/releases/latest");
    expect(seen[0]?.init.redirect).toBe("manual");
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a tag without v", `${TAG}/4.3.1`, "4.3.1"],
    ["a relative Location", "/Gentleman-Programming/engram/releases/tag/v3.6.0", "3.6.0"],
    ["a double-digit version", `${TAG}/v10.20.30`, "10.20.30"],
  ])("accepts %s", async (_name, location, expected) => {
    expect(await lookupLatest("gentle-ai", reply(301, location))).toEqual({
      ok: true,
      version: expected,
    });
  });

  it.each([
    ["a prerelease tag", `${TAG}/v4.3.1-rc.1`],
    ["a non-version tag", `${TAG}/nightly`],
    ["a two-part tag", `${TAG}/v4.3`],
    [
      "a redirect to the release list",
      "https://github.com/Gentleman-Programming/gentle-ai/releases",
    ],
  ])("rejects %s", async (_name, location) => {
    const result = await lookupLatest("gentle-ai", reply(302, location));
    expect(result.ok).toBe(false);
  });

  it("explains a redirect without a Location header", async () => {
    const result = await lookupLatest("gentle-ai", reply(302));
    expect(result).toEqual({ ok: false, reason: "the redirect has no Location header" });
  });

  it("explains a 404 and other statuses", async () => {
    expect(await lookupLatest("gentle-ai", reply(404))).toEqual({
      ok: false,
      reason: "no release found (HTTP 404)",
    });
    expect(await lookupLatest("gentle-ai", reply(503))).toEqual({
      ok: false,
      reason: "HTTP 503",
    });
    expect(await lookupLatest("gentle-ai", reply(200))).toEqual({
      ok: false,
      reason: "no redirect (HTTP 200)",
    });
  });

  it("reports a network error without throwing", async () => {
    const fail: LatestFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await lookupLatest("gentle-ai", fail);
    expect(result).toEqual({ ok: false, reason: "network error: fetch failed" });
  });

  it("reports the timeout when the request outlives its limit", async () => {
    const hang: LatestFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const result = await lookupLatest("gentle-ai", hang, { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: "timed out after 20 ms" });
  });

  it("releases the unread body", async () => {
    let cancelled = false;
    const fetcher: LatestFetch = async () => ({
      status: 302,
      headers: new Headers({ location: `${TAG}/v4.3.1` }),
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    });
    await lookupLatest("gentle-ai", fetcher);
    expect(cancelled).toBe(true);
  });
});

describe("when a lookup is due", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  const HOUR = 3_600_000;
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("is due when nothing was ever recorded", () => {
    expect(lookupDue(undefined, now)).toBe(true);
    expect(lookupDue({}, now)).toBe(true);
  });

  it("is not due inside the 24 h TTL and is due after it", () => {
    const fresh = { latest: "4.3.1", latestCheckedAt: ago(24 * HOUR - 60_000) };
    const stale = { latest: "4.3.1", latestCheckedAt: ago(24 * HOUR + 60_000) };
    expect(lookupDue(fresh, now)).toBe(false);
    expect(lookupDue(stale, now)).toBe(true);
  });

  it("waits 1 h after a failure, then tries again", () => {
    const cooling = { lastFailureAt: ago(HOUR - 60_000), lastFailure: "HTTP 503" };
    const over = { lastFailureAt: ago(HOUR + 60_000), lastFailure: "HTTP 503" };
    expect(lookupDue(cooling, now)).toBe(false);
    expect(lookupDue(over, now)).toBe(true);
  });

  it("applies the cooldown even when an old good value exists", () => {
    const record = {
      latest: "4.3.1",
      latestCheckedAt: ago(25 * HOUR),
      lastFailureAt: ago(60_000),
      lastFailure: "timed out after 3000 ms",
    };
    expect(lookupDue(record, now)).toBe(false);
  });

  it("is due when a timestamp is in the future (the clock moved back)", () => {
    const future = new Date(now + 3_600_000).toISOString();
    expect(lookupDue({ latest: "4.3.1", latestCheckedAt: future }, now)).toBe(true);
    expect(lookupDue({ lastFailureAt: future, lastFailure: "x" }, now)).toBe(true);
  });

  it("is due when a latest has no check time", () => {
    expect(lookupDue({ latest: "4.3.1" }, now)).toBe(true);
  });
});
