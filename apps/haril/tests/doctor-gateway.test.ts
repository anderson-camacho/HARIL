import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, type HostInfo, run } from "../src/cli.js";

// doctor's providers section: the real catalog query against a fake server (M3-T7). Each test names one
// provider in haril.json, so no default provider is probed. The key is read from the environment and
// must never be printed.
const KEY = "doctor-key-value-0a9f";
const KEY_ENV = "HARIL_CLIPROXYAPI_KEY";
let root = "";
let server: FakeOpenAiServer;
let configCount = 0;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "haril-doctor-gw-"));
  server = await startFakeOpenAiServer({ apiKey: KEY, models: ["alpha", "beta"] });
});

afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readFile: () => {
      throw new Error("not used");
    },
  };
  return { io, out, err };
}

// One provider named "cliproxy" that needs KEY_ENV, at the given URL.
function configFor(baseUrl: string): string {
  configCount += 1;
  const path = join(root, `haril-${configCount}.json`);
  writeFileSync(
    path,
    JSON.stringify({ providers: [{ id: "cliproxy", baseUrl, keyEnv: KEY_ENV }] }),
  );
  return path;
}

// A fresh data dir keeps the store section "not initialized" (ok) so only the providers decide the exit.
const host = (env: Record<string, string | undefined>): HostInfo => ({
  nodeVersion: "v24.21.0",
  platform: "linux",
  arch: "x64",
  homeDir: root,
  env: { HARIL_HOME: join(root, "data"), ...env },
  // A generous bound: the flaky 3 s probe must never decide these tests under load (M2-T2 log).
  gatewayTimeoutMs: 30_000,
});

describe("doctor providers section", () => {
  it("reports ok with the model count when the key is set and accepted (exit 0)", async () => {
    const { io, out } = harness();
    const code = await run(
      ["doctor"],
      io,
      host({ HARIL_CONFIG: configFor(server.baseUrl), [KEY_ENV]: KEY }),
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/providers\s+ok\s+/);
    expect(text).toContain("reachable, 2 models");
    expect(text).toMatch(/key set/);
    expect(text).not.toContain(KEY);
  });

  it("warns 'key not set' and sends no request when the key is not set (exit 1)", async () => {
    const { io, out, err } = harness();
    const code = await run(["doctor"], io, host({ HARIL_CONFIG: configFor(server.baseUrl) }));
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("key not set");
    expect(server.requests).toHaveLength(0);
    expect(out.join("\n") + err.join("\n")).not.toContain(KEY);
  });

  it("reports an error 'key rejected' on a 401 when the key is set (exit 2)", async () => {
    const { io, out } = harness();
    const code = await run(
      ["doctor"],
      io,
      host({ HARIL_CONFIG: configFor(server.baseUrl), [KEY_ENV]: "not-the-key" }),
    );
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("key rejected");
    expect(out.join("\n")).not.toContain("not-the-key");
  });

  it("warns when the provider is unreachable (exit 1)", async () => {
    const closed = await startFakeOpenAiServer({ apiKey: KEY });
    const url = closed.baseUrl;
    await closed.close();
    const { io, out } = harness();
    const code = await run(["doctor"], io, host({ HARIL_CONFIG: configFor(url), [KEY_ENV]: KEY }));
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/providers\s+warn\s+/);
    expect(out.join("\n")).toContain("unreachable");
  });

  it("reports an invalid HARIL_GATEWAY_URL as an error (exit 2)", async () => {
    const { io, out } = harness();
    const code = await run(["doctor"], io, host({ HARIL_GATEWAY_URL: "::nope::", [KEY_ENV]: KEY }));
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("HARIL_GATEWAY_URL is not a valid URL");
  });

  it("applies the injected probe timeout, so a slow provider is 'unreachable' within that bound", async () => {
    // A server that accepts and never answers: the probe must give up at gatewayTimeoutMs, not at 3 s.
    const hanging = createServer(() => {});
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const port = (hanging.address() as AddressInfo).port;
    try {
      const { io, out } = harness();
      const started = Date.now();
      await run(["doctor"], io, {
        ...host({ HARIL_CONFIG: configFor(`http://127.0.0.1:${port}/v1`), [KEY_ENV]: KEY }),
        gatewayTimeoutMs: 200,
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out.join("\n")).toContain("unreachable");
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("prints each provider in the JSON report with key 'set' or 'not set', never the value", async () => {
    const withKey = harness();
    await run(
      ["doctor", "--json"],
      withKey.io,
      host({ HARIL_CONFIG: configFor(server.baseUrl), [KEY_ENV]: KEY }),
    );
    const report = JSON.parse(withKey.out.join("\n")) as {
      providers: { status: string; entries: Record<string, unknown>[] };
    };
    expect(report.providers.status).toBe("ok");
    expect(report.providers.entries).toEqual([
      {
        id: "cliproxy",
        url: server.baseUrl,
        keyEnv: KEY_ENV,
        key: "set",
        status: "ok",
        detail: "reachable, 2 models",
        models: 2,
      },
    ]);
    expect(withKey.out.join("\n")).not.toContain(KEY);

    const withoutKey = harness();
    await run(
      ["doctor", "--json"],
      withoutKey.io,
      host({ HARIL_CONFIG: configFor(server.baseUrl) }),
    );
    const second = JSON.parse(withoutKey.out.join("\n")) as {
      providers: { entries: { key: string }[] };
    };
    expect(second.providers.entries[0]?.key).toBe("not set");
  });
});
