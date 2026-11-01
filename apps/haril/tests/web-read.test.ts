import { describe, expect, it } from "vitest";
import {
  isPublicAddress,
  pinnedWebFetch,
  readWebPage,
  type WebFetch,
  type WebLookup,
  webUrlProblem,
} from "../src/runtime/web-read.js";

const publicDns: WebLookup = async () => [
  "93.184.216.34",
  "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
];

function bytes(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield new TextEncoder().encode(text);
  })();
}

function page(body: string, status = 200, location: string | null = null) {
  return { status, headers: { get: () => location }, body: bytes(body) };
}

describe("an address the investigador may reach", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "not an address",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"])(
    "accepts %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("a URL the investigador may read", () => {
  it.each([
    "https://localhost/x",
    "https://localhost./x",
    "https://a.localhost/x",
    "https://printer.local/x",
    "https://db.internal/x",
    "https://127.0.0.1/x",
    "https://2130706433/x",
    "https://0x7f.0.0.1/x",
    "https://100.64.0.1/x",
    "https://169.254.169.254/latest",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[64:ff9b::7f00:1]/x",
  ])("refuses %s", (url) => {
    expect(webUrlProblem(url)).toContain("not a public");
  });

  it("does not take a public name for an address", () => {
    expect(webUrlProblem("https://10.example.com/x")).toBeNull();
    expect(webUrlProblem("https://example.com/x")).toBeNull();
  });
});

describe("the connection itself", () => {
  it("refuses at the socket a name that answers a private address, whatever was checked before", async () => {
    // "localhost" answers without the network: what a name that rebinds would answer the second time.
    await expect(
      pinnedWebFetch("https://localhost:9/", {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow("not a public address");
  });
});

describe("reading a page", () => {
  it("refuses a name that resolves to a private address, without connecting", async () => {
    let connected = 0;
    const fetcher: WebFetch = async () => {
      connected += 1;
      return page("secret");
    };
    for (const addresses of [
      ["10.0.0.1"],
      ["93.184.216.34", "127.0.0.1"],
      ["::ffff:169.254.169.254"],
      ["64:ff9b::a00:1"],
      [],
    ]) {
      const read = await readWebPage("https://rebind.example.com/", fetcher, {
        lookup: async () => addresses,
      });
      expect(read.ok, addresses.join()).toBe(false);
    }
    expect(connected).toBe(0);
  });

  it("checks the addresses of every hop", async () => {
    const asked: string[] = [];
    const fetcher: WebFetch = async (url) => {
      asked.push(url);
      return page("", 302, "https://inner.example.com/secret");
    };
    const read = await readWebPage("https://example.com/a", fetcher, {
      lookup: async (host) => (host === "inner.example.com" ? ["192.168.0.5"] : ["8.8.8.8"]),
    });
    expect(read.ok).toBe(false);
    expect(asked).toEqual(["https://example.com/a"]);
  });

  it("stops reading a long body as it streams", async () => {
    let produced = 0;
    let cancelled = false;
    const fetcher: WebFetch = async () => ({
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
        for (;;) {
          produced += 1;
          yield chunk;
        }
      })(),
      cancel: () => {
        cancelled = true;
      },
    });
    const read = await readWebPage("https://example.com/big", fetcher, { lookup: publicDns });
    expect(read).toMatchObject({ ok: true, truncated: true });
    if (read.ok) expect(read.text).toHaveLength(200_000);
    expect(produced).toBeLessThan(10);
    expect(cancelled).toBe(true);
  });

  it("keeps one time limit across every hop and the body", async () => {
    const fetcher: WebFetch = async (url) => {
      if (url.endsWith("/a")) {
        await new Promise((done) => setTimeout(done, 30));
        return page("", 302, "https://example.com/b");
      }
      await new Promise((done) => setTimeout(done, 30));
      return {
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          await new Promise(() => undefined);
          yield new Uint8Array();
        })(),
      };
    };
    const started = Date.now();
    const read = await readWebPage("https://example.com/a", fetcher, {
      lookup: publicDns,
      timeoutMs: 100,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("time");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("answers a failed connection as a reason, not an exception", async () => {
    const fetcher: WebFetch = async () => {
      throw new Error("connect refused");
    };
    expect(await readWebPage("https://example.com/", fetcher, { lookup: publicDns })).toEqual({
      ok: false,
      reason: expect.stringContaining("connect refused"),
    });
  });

  it("reads a public page", async () => {
    const read = await readWebPage("https://example.com/b", async () => page("hola"), {
      lookup: publicDns,
    });
    expect(read).toEqual({ ok: true, text: "hola", truncated: false });
  });
});
