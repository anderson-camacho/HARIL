import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CliIo, type HostInfo, run } from "../src/cli.js";

// doctor's gateway section: the real probe of /v1/models against the fake server (3 s timeout).
// The key is read from the environment and must never be printed.
const KEY = "doctor-key-value-0a9f";
let root = "";
let server: FakeOpenAiServer;

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

// A fresh data dir keeps the store section "not initialized" (ok) so only the gateway decides the exit.
const host = (env: Record<string, string | undefined>): HostInfo => ({
  nodeVersion: "v24.21.0",
  platform: "linux",
  arch: "x64",
  homeDir: root,
  env: { HARIL_HOME: join(root, "data"), ...env },
});

describe("doctor gateway section", () => {
  it("reports ok with the model count when the key is set and accepted (exit 0)", async () => {
    const { io, out } = harness();
    const code = await run(
      ["doctor"],
      io,
      host({ HARIL_GATEWAY_URL: server.baseUrl, HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/gateway\s+ok\s+/);
    expect(text).toContain("reachable, 2 models");
    expect(text).toMatch(/key\s+set/);
    expect(text).not.toContain(KEY);
  });

  it("warns 'reachable, key not set' on a 401 when no key is set (exit 1)", async () => {
    const { io, out, err } = harness();
    const code = await run(["doctor"], io, host({ HARIL_GATEWAY_URL: server.baseUrl }));
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("reachable, key not set");
    expect(out.join("\n") + err.join("\n")).not.toContain(KEY);
  });

  it("reports an error 'key rejected' on a 401 when the key is set (exit 2)", async () => {
    const { io, out } = harness();
    const code = await run(
      ["doctor"],
      io,
      host({ HARIL_GATEWAY_URL: server.baseUrl, HARIL_CLIPROXYAPI_KEY: "not-the-key" }),
    );
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("key rejected");
    expect(out.join("\n")).not.toContain("not-the-key");
  });

  it("warns when the gateway is unreachable (exit 1)", async () => {
    const closed = await startFakeOpenAiServer({ apiKey: KEY });
    const url = closed.baseUrl;
    await closed.close();
    const { io, out } = harness();
    const code = await run(
      ["doctor"],
      io,
      host({ HARIL_GATEWAY_URL: url, HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/gateway\s+warn\s+/);
    expect(out.join("\n")).toContain("unreachable");
  });

  it("reports an invalid HARIL_GATEWAY_URL as an error (exit 2)", async () => {
    const { io, out } = harness();
    const code = await run(
      ["doctor"],
      io,
      host({ HARIL_GATEWAY_URL: "::nope::", HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("HARIL_GATEWAY_URL is not a valid URL");
  });

  it("prints the gateway in the JSON report with key 'set' or 'not set', never the value", async () => {
    const withKey = harness();
    await run(
      ["doctor", "--json"],
      withKey.io,
      host({ HARIL_GATEWAY_URL: server.baseUrl, HARIL_CLIPROXYAPI_KEY: KEY }),
    );
    const report = JSON.parse(withKey.out.join("\n")) as {
      gateway: { status: string; url: string; key: string; models?: number };
    };
    expect(report.gateway).toMatchObject({
      status: "ok",
      url: server.baseUrl,
      key: "set",
      models: 2,
    });
    expect(withKey.out.join("\n")).not.toContain(KEY);

    const withoutKey = harness();
    await run(["doctor", "--json"], withoutKey.io, host({ HARIL_GATEWAY_URL: server.baseUrl }));
    const second = JSON.parse(withoutKey.out.join("\n")) as { gateway: { key: string } };
    expect(second.gateway.key).toBe("not set");
  });
});
