import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { storeAccess } from "../src/host.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// `haril quota [--json]` (docs/modos-y-delegacion.md 6, 3.11; phase F6): per provider and account, the 5-hour and weekly
// used percentages, their resets and the cooldowns, with "sin dato" wherever nothing is known. The management API is a
// scripted server on 127.0.0.1; the keys here are test values.

const MGMT_KEY = "test-mgmt-value-123";
const GATEWAY_KEY = "test-gateway-value-456";

let sb: Sandbox;
const servers: { close(): void }[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  sb.cleanup();
});

async function managementServer(): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${MGMT_KEY}`) return send(401, {});
      if (request.url === "/v0/management/auth-files") {
        return send(200, {
          files: [
            { auth_index: "1", provider: "antigravity", prefix: "Gemini1", project_id: "p1" },
            { auth_index: "2", provider: "antigravity", prefix: "Gemini2", project_id: "p2" },
            { auth_index: "3", provider: "x_ai" },
          ],
        });
      }
      if (request.url === "/v0/management/api-call") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { auth_index: string };
        const remaining = body.auth_index === "1" ? 0.62 : 0.15;
        return send(200, {
          status_code: 200,
          body: JSON.stringify({
            buckets: [
              { window: "5h", remainingFraction: remaining, resetTime: "2026-10-18T13:00:00Z" },
              { window: "weekly", remainingFraction: 0.5, resetTime: "2026-10-23T00:00:00Z" },
            ],
          }),
        });
      }
      return send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function writeConfig(body: unknown): string {
  const dir = join(sb.root, "config");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "haril.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

interface QuotaJson {
  readonly providers: {
    readonly id: string;
    readonly status: "ok" | "sin dato";
    readonly reason: string | null;
    readonly accounts: {
      readonly credential: string;
      readonly prefix: string | null;
      readonly window5h: { readonly usedPct: number | null; readonly resetsAt: number | null };
      readonly weekly: { readonly usedPct: number | null; readonly resetsAt: number | null };
      readonly note: string;
    }[];
  }[];
  readonly cooldowns: { readonly model: string; readonly until: number; readonly reason: string }[];
}

describe("haril quota", () => {
  it('says "sin dato" when the management key variable is not set, and asks nothing', async () => {
    const out = harness();
    expect(await run(["quota"], out.io, sb.host)).toBe(0);
    const text = out.out.join("\n");
    expect(text).toContain("cliproxy");
    expect(text).toContain("sin dato");
    expect(text).toContain("CLIPROXYAPI_MANAGEMENT_KEY is not set");

    const json = harness();
    expect(await run(["quota", "--json"], json.io, sb.host)).toBe(0);
    const report = parseJson<QuotaJson>(json.out);
    expect(report.providers).toEqual([
      expect.objectContaining({ id: "cliproxy", status: "sin dato", accounts: [] }),
    ]);
    expect(report.cooldowns).toEqual([]);
  });

  it("reads each account's windows, records them, applies the 80 % rule and lists the cooldowns", async () => {
    run(
      ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
      harness().io,
      sb.host,
    );
    const url = await managementServer();
    const config = writeConfig({
      providers: [{ id: "cliproxy", baseUrl: `${url}/v1`, keyEnv: "TEST_GATEWAY_KEY" }],
      delegation: { quota: { managementKeyEnv: "TEST_MGMT_KEY" } },
    });
    const host = {
      ...sb.host,
      env: {
        ...sb.host.env,
        HARIL_CONFIG: config,
        TEST_MGMT_KEY: MGMT_KEY,
        TEST_GATEWAY_KEY: GATEWAY_KEY,
      },
    };
    const store = storeAccess(host).open(sb.dataDir);
    store.quota.setCooldown({
      model: "cliproxy/Gemini2/gemini-3-flash",
      until: Date.now() + 600_000,
      reason: "rate_limited",
    });
    store.close();

    const json = harness();
    expect(await run(["quota", "--json"], json.io, host)).toBe(0);
    const report = parseJson<QuotaJson>(json.out);
    const [provider] = report.providers;
    expect(provider).toMatchObject({ id: "cliproxy", status: "ok" });
    expect(provider?.accounts.map((account) => [account.prefix, account.window5h.usedPct])).toEqual([
      ["Gemini1", 38],
      ["Gemini2", 85],
      [null, null],
    ]);
    expect(provider?.accounts[1]?.note).toContain("over 80% of its 5-hour window");
    expect(provider?.accounts[2]?.note).toContain("sin dato");
    expect(report.cooldowns).toEqual([
      expect.objectContaining({ model: "cliproxy/Gemini2/gemini-3-flash", reason: "rate_limited" }),
    ]);
    // The reading is kept, so the runtime and the views read it.
    const after = storeAccess(host).open(sb.dataDir);
    expect(after.quota.latest(0).filter((row) => row.prefix === "Gemini2")).toHaveLength(2);
    after.close();

    const text = harness();
    expect(await run(["quota"], text.io, host)).toBe(0);
    const lines = text.out.join("\n");
    expect(lines).toMatch(/Gemini1 +5h +38% /);
    expect(lines).toContain("cooldowns");
    // No key value ever reaches the output.
    for (const output of [lines, json.out.join("\n"), text.err.join("\n")]) {
      expect(output).not.toContain(MGMT_KEY);
      expect(output).not.toContain(GATEWAY_KEY);
    }
  });

  it("refuses a key written in haril.json and a delegation key it does not read yet", async () => {
    const withKey = writeConfig({ delegation: { quota: { managementKey: "x" } } });
    const refused = harness();
    expect(
      await run(["quota"], refused.io, { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: withKey } }),
    ).toBe(2);
    expect(refused.err.join("\n")).toContain("/delegation/quota/managementKey");

    const unknown = writeConfig({ delegation: { limits: {} } });
    const out = harness();
    expect(
      await run(["quota"], out.io, { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: unknown } }),
    ).toBe(2);
    expect(out.err.join("\n")).toContain("/delegation/limits");

    const badUrl = writeConfig({ delegation: { quota: { managementBaseUrl: "ftp://x" } } });
    const url = harness();
    expect(
      await run(["quota"], url.io, { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: badUrl } }),
    ).toBe(2);
    expect(url.err.join("\n")).toContain("/delegation/quota/managementBaseUrl");
  });
});
