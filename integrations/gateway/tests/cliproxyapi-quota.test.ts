import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sealSecret } from "@haril/contracts";
import type { QuotaSnapshot } from "@haril/core/ports";
import { afterEach, describe, expect, it } from "vitest";
import { createCliProxyQuotaProvider } from "../src/quota/cliproxyapi-quota.js";

// The CLIProxyAPI quota adapter against a scripted management server on 127.0.0.1 (ephemeral port): auth-files and
// api-call, /v8 with the /v0 fallback, a refused key, a missing API, a timeout and malformed answers. The key below is a
// test value, not a real one.

const KEY = "test-management-value";
const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface Script {
  // Which versions answer: a version not listed answers 404.
  readonly versions?: readonly ("v8" | "v0")[];
  readonly authFiles?: unknown;
  readonly authFilesStatus?: number;
  readonly rawAuthFiles?: string;
  // The usage answer by upstream URL: { status_code, body } as CLIProxyAPI's api-call returns it.
  readonly usage?: Readonly<Record<string, { status_code: number; body: unknown }>>;
  readonly delayMs?: number;
}

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function startServer(script: Script) {
  const requests: Recorded[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? null : (JSON.parse(raw) as unknown);
      const path = request.url ?? "/";
      requests.push({
        method: request.method ?? "",
        path,
        authorization: request.headers.authorization,
        body,
      });
      const send = (status: number, payload: unknown, rawText?: string) => {
        const write = () => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(rawText ?? JSON.stringify(payload));
        };
        if (script.delayMs === undefined) write();
        else setTimeout(write, script.delayMs);
      };
      const match = /^\/(v8|v0)\/management\/(auth-files|api-call)$/.exec(path);
      const versions = script.versions ?? ["v0"];
      if (match === null || !versions.includes(match[1] as "v8" | "v0")) {
        send(404, { error: "not found" });
        return;
      }
      if (request.headers.authorization !== `Bearer ${KEY}`) {
        send(401, { error: "invalid management key" });
        return;
      }
      if (match[2] === "auth-files") {
        send(script.authFilesStatus ?? 200, script.authFiles ?? { files: [] }, script.rawAuthFiles);
        return;
      }
      const call = body as { url: string };
      const answer = script.usage?.[call.url];
      send(200, answer ?? { status_code: 404, body: "{}" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function provider(url: string, options: { key?: string | null; timeoutMs?: number } = {}) {
  const key = options.key === undefined ? KEY : options.key;
  return createCliProxyQuotaProvider({
    providerId: "cliproxy",
    baseUrl: `${url}/v1`,
    credential: key === null ? undefined : sealSecret(key),
    keyEnv: "CLIPROXYAPI_MANAGEMENT_KEY",
    timeoutMs: options.timeoutMs ?? 2000,
    now: () => NOW,
  });
}

function okOf(snapshot: QuotaSnapshot) {
  if (!snapshot.ok) throw new Error(`unavailable: ${snapshot.reason} ${snapshot.detail}`);
  return snapshot;
}

const CLAUDE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_URL = "https://chatgpt.com/backend-api/wham/usage";
const GOOGLE_DAILY =
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const GOOGLE_LOAD = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

describe("the CLIProxyAPI quota adapter", () => {
  it("reads each account's 5-hour and weekly windows through auth-files and api-call", async () => {
    const server = await startServer({
      versions: ["v0"],
      authFiles: {
        files: [
          { auth_index: "a1", provider: "claude", email: "someone@example.test" },
          { auth_index: "a2", type: "antigravity", prefix: "Gemini1", project_id: "proj-1" },
          { auth_index: "a3", provider: "codex" },
          { auth_index: "a4", provider: "x_ai" },
          { auth_index: "a5", provider: "claude", disabled: true },
          { name: "no-index.json", provider: "claude" },
        ],
      },
      usage: {
        [CLAUDE_URL]: {
          status_code: 200,
          body: JSON.stringify({
            five_hour: { utilization: 38, resets_at: "2026-10-18T12:00:00Z" },
            seven_day: { utilization: 52.5, resets_at: "2026-10-21T00:00:00Z" },
          }),
        },
        [GOOGLE_DAILY]: {
          status_code: 200,
          body: JSON.stringify({
            groups: [
              {
                displayName: "Gemini",
                buckets: [
                  { window: "5h", remainingFraction: 0.17, resetTime: "2026-10-18T13:00:00Z" },
                  { window: "weekly", remainingFraction: 0.6, resetTime: "2026-10-23T00:00:00Z" },
                ],
              },
              {
                displayName: "Claude",
                buckets: [
                  { window: "5h", remainingFraction: 0.5, resetTime: "2026-10-18T11:00:00Z" },
                ],
              },
            ],
          }),
        },
        [CODEX_URL]: {
          status_code: 200,
          body: JSON.stringify({
            rate_limits: {
              primary: { used_percent: 12, resets_in_seconds: 600 },
              secondary: { used_percent: 81, resets_at: 1792800000 },
            },
          }),
        },
      },
    });
    const snapshot = okOf(await provider(server.url).sample("cliproxy"));
    expect(snapshot.source).toBe("cliproxyapi-management/v0");
    expect(snapshot.sampledAt).toBe(NOW);
    expect(snapshot.accounts).toHaveLength(4);
    const [claude, gemini, codex, xai] = snapshot.accounts;
    expect(claude).toMatchObject({ kind: "claude", prefix: null, note: null });
    expect(claude?.windows).toEqual([
      { name: "5h", usedPct: 38, resetsAt: Date.parse("2026-10-18T12:00:00Z") },
      { name: "7d", usedPct: 52.5, resetsAt: Date.parse("2026-10-21T00:00:00Z") },
    ]);
    // The worst bucket of each window counts.
    expect(gemini).toMatchObject({ kind: "antigravity", prefix: "Gemini1" });
    expect(gemini?.windows.filter((item) => item.group === undefined)).toEqual([
      { name: "5h", usedPct: 83, resetsAt: Date.parse("2026-10-18T13:00:00Z") },
      { name: "7d", usedPct: 40, resetsAt: Date.parse("2026-10-23T00:00:00Z") },
    ]);
    // Every named group keeps its own windows, so one spent group does not hold back the others.
    expect(gemini?.windows.filter((item) => item.group !== undefined)).toEqual([
      {
        name: "5h",
        usedPct: 83,
        resetsAt: Date.parse("2026-10-18T13:00:00Z"),
        group: "Gemini",
      },
      {
        name: "7d",
        usedPct: 40,
        resetsAt: Date.parse("2026-10-23T00:00:00Z"),
        group: "Gemini",
      },
      {
        name: "5h",
        usedPct: 50,
        resetsAt: Date.parse("2026-10-18T11:00:00Z"),
        group: "Claude",
      },
    ]);
    expect(codex?.windows).toEqual([
      { name: "5h", usedPct: 12, resetsAt: NOW + 600_000 },
      { name: "7d", usedPct: 81, resetsAt: 1792800000 * 1000 },
    ]);
    expect(xai).toMatchObject({ kind: "x-ai", windows: [], note: "no usage probe for x-ai" });
    // The credential reference is opaque: no index, file name or e-mail.
    for (const account of snapshot.accounts) {
      expect(account.credentialRef).toMatch(/^acct-[0-9a-f]{12}$/);
      expect(JSON.stringify(account)).not.toContain("example.test");
    }
    // Every call carried the management key as Bearer and asked with the account's token placeholder.
    expect(server.requests.every((request) => request.authorization === `Bearer ${KEY}`)).toBe(
      true,
    );
    const claudeCall = server.requests.find(
      (request) => (request.body as { url?: string } | null)?.url === CLAUDE_URL,
    );
    expect(claudeCall?.body).toMatchObject({
      auth_index: "a1",
      method: "GET",
      header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" },
    });
    const googleCall = server.requests.find(
      (request) => (request.body as { url?: string } | null)?.url === GOOGLE_DAILY,
    );
    expect(googleCall?.body).toMatchObject({ auth_index: "a2", data: '{"project":"proj-1"}' });
  });

  it("prefers /v8/management and falls back to /v0 only when /v8 does not exist", async () => {
    const v8 = await startServer({ versions: ["v8", "v0"], authFiles: { files: [] } });
    expect(okOf(await provider(v8.url).sample("cliproxy")).source).toBe(
      "cliproxyapi-management/v8",
    );
    expect(v8.requests.map((request) => request.path)).toEqual(["/v8/management/auth-files"]);

    const v0 = await startServer({ versions: ["v0"], authFiles: { files: [] } });
    expect(okOf(await provider(v0.url).sample("cliproxy")).source).toBe(
      "cliproxyapi-management/v0",
    );
    expect(v0.requests.map((request) => request.path)).toEqual([
      "/v8/management/auth-files",
      "/v0/management/auth-files",
    ]);
  });

  it("discovers a Google account's project with loadCodeAssist when the account names none", async () => {
    const server = await startServer({
      authFiles: { files: [{ auth_index: "g1", provider: "antigravity" }] },
      usage: {
        [GOOGLE_LOAD]: {
          status_code: 200,
          body: JSON.stringify({ cloudaicompanionProject: { id: "found-project" } }),
        },
        [GOOGLE_DAILY]: {
          status_code: 200,
          body: JSON.stringify({
            buckets: [
              { window: "weekly", remainingFraction: 0.1, resetTime: "2026-10-20T00:00:00Z" },
            ],
          }),
        },
      },
    });
    const [account] = okOf(await provider(server.url).sample("cliproxy")).accounts;
    expect(account?.windows).toEqual([
      { name: "7d", usedPct: 90, resetsAt: Date.parse("2026-10-20T00:00:00Z") },
    ]);
    const quotaCall = server.requests.find(
      (request) => (request.body as { url?: string } | null)?.url === GOOGLE_DAILY,
    );
    expect(quotaCall?.body).toMatchObject({ data: '{"project":"found-project"}' });
  });

  it("says unauthorized on a refused key and never tries the key a second time", async () => {
    const server = await startServer({ versions: ["v8", "v0"] });
    const snapshot = await provider(server.url, { key: "wrong-test-value" }).sample("cliproxy");
    expect(snapshot).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("wrong-test-value");
  });

  it("says not_found when neither management API exists", async () => {
    const server = await startServer({ versions: [] });
    expect(await provider(server.url).sample("cliproxy")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("says timeout when the server does not answer in time", async () => {
    const server = await startServer({ versions: ["v8"], delayMs: 500 });
    expect(await provider(server.url, { timeoutMs: 50 }).sample("cliproxy")).toMatchObject({
      ok: false,
      reason: "timeout",
    });
  });

  it("says unreachable when nothing listens", async () => {
    const server = await startServer({});
    for (const item of servers.splice(0)) item.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await provider(server.url).sample("cliproxy")).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });

  it("says malformed for an auth-files answer that is not JSON or has no list", async () => {
    const notJson = await startServer({ rawAuthFiles: "<html>oops</html>" });
    expect(await provider(notJson.url).sample("cliproxy")).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    const noList = await startServer({ authFiles: { accounts: 3 } });
    expect(await provider(noList.url).sample("cliproxy")).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("keeps an account with a note when its usage answer is refused, not JSON or out of shape", async () => {
    const server = await startServer({
      authFiles: {
        files: [
          { auth_index: "c1", provider: "claude" },
          { auth_index: "c2", provider: "codex" },
          { auth_index: "c3", provider: "antigravity", project_id: "p" },
        ],
      },
      usage: {
        [CLAUDE_URL]: { status_code: 403, body: "{}" },
        [CODEX_URL]: { status_code: 200, body: "not json" },
      },
    });
    const accounts = okOf(await provider(server.url).sample("cliproxy")).accounts;
    expect(accounts.map((account) => [account.windows.length, account.note])).toEqual([
      [0, "the usage endpoint answered HTTP 403"],
      [0, "the usage endpoint did not answer JSON"],
      [0, "the usage endpoint answered HTTP 404"],
    ]);
  });

  it("is not configured without a key or for another provider, and sends nothing then", async () => {
    const server = await startServer({});
    expect(await provider(server.url, { key: null }).sample("cliproxy")).toMatchObject({
      ok: false,
      reason: "not_configured",
      detail: "CLIPROXYAPI_MANAGEMENT_KEY is not set",
    });
    expect(await provider(server.url).sample("ollama")).toMatchObject({
      ok: false,
      reason: "not_configured",
    });
    expect(server.requests).toHaveLength(0);
  });
});
