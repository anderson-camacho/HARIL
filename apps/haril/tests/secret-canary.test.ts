import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// V20-4 (ADR-0020 C12, C25; executor.md CT-EXE-23; BL-070), hermetic part: a canary provider key, read by reference
// through the SecretStore, reaches the upstream only as the Authorization header the gateway adapter sets. It never
// shows, in any form of FORMS, in the output of the commands of a run that uses it, in the environment or argv of the
// Pi child, in any row of haril.db, or in any file under the data directory. The key is in the test process's own
// environment too, so a Pi child that inherited its parent's environment would show it. The key is a fake fixture, Pi
// is fake-pi.mjs and the upstream is the fake OpenAI-compatible server: nothing calls the network.

// The quote and the backslash change its JSON and URL forms; its bytes give "+" and "/" in base64, so base64url differs.
const FAKE_SECRET = String.raw`fake-"canary"\run~ab?`;
// The upstream expects it as its bearer.
const KEY = FAKE_SECRET;
const HALF = Math.ceil(FAKE_SECRET.length / 2);
// V20-4: in clear, base64, URL and JSON-escaped, and split in two fragments (each half alone), plus the base64 of the
// Authorization header value it travels in.
const NAMED_FORMS: readonly (readonly [string, string])[] = [
  ["in clear", FAKE_SECRET],
  ["in base64", Buffer.from(FAKE_SECRET).toString("base64")],
  ["in base64url", Buffer.from(FAKE_SECRET).toString("base64url")],
  ["URL-encoded", encodeURIComponent(FAKE_SECRET)],
  ["JSON-escaped", JSON.stringify(FAKE_SECRET).slice(1, -1)],
  ["first fragment", FAKE_SECRET.slice(0, HALF)],
  ["second fragment", FAKE_SECRET.slice(HALF)],
  ["Bearer header in base64", Buffer.from(`Bearer ${FAKE_SECRET}`).toString("base64")],
];
const FORMS = NAMED_FORMS.map(([, form]) => form);
const FAKE_PI = new URL("../../../integrations/agent-pi/testing/fake-pi.mjs", import.meta.url);
const TEST_TIMEOUT_MS = 30_000;

let sb: Sandbox;
let upstream: FakeOpenAiServer;

beforeEach(async () => {
  sb = makeSandbox();
  upstream = await startFakeOpenAiServer({
    apiKey: KEY,
    models: ["fake-model"],
    completion: {
      textChunks: ["Canary ", "reply."],
      usage: { prompt_tokens: 9, completion_tokens: 3 },
    },
  });
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await upstream.close();
  sb.cleanup();
});

// A Pi wrapper that records the environment and argv the child received, then runs fake-pi.mjs.
function recordingPi(record: string): string {
  const path = join(sb.root, "pi-recording.mjs");
  const fakePi = pathToFileURL(fileURLToPath(FAKE_PI)).href;
  writeFileSync(
    path,
    [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv, env: process.env }));`,
      `process.env.FAKE_PI_SCENARIO = "ok_via_broker";`,
      `await import(${JSON.stringify(fakePi)});`,
    ].join("\n"),
  );
  return path;
}

function expectNoCanary(what: string, text: string | Buffer): void {
  for (const [name, form] of NAMED_FORMS) {
    expect(text.includes(form), `${what} holds the canary ${name}`).toBe(false);
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function everyRow(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    return tables.flatMap((table) =>
      db
        .prepare(`SELECT * FROM "${table}"`)
        .all()
        .map((row) =>
          JSON.stringify(row, (_key, value: unknown) =>
            value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : value,
          ),
        ),
    );
  } finally {
    db.close();
  }
}

describe("a canary provider key in a real-agent run (V20-4)", () => {
  it("looks for pairwise distinct forms and detects each of them", () => {
    expect(new Set(FORMS).size).toBe(FORMS.length);
    const base64 = Buffer.from(FAKE_SECRET).toString("base64");
    expect(base64).toContain("+");
    expect(base64).toContain("/");
    for (const form of FORMS) {
      expect(() => expectNoCanary("a probe", `before ${form} after`)).toThrow();
      expect(() => expectNoCanary("a probe", Buffer.from(`before ${form} after`))).toThrow();
    }
  });

  it(
    "goes to the upstream only as the Authorization header and shows nowhere else",
    async () => {
      const record = join(sb.root, "pi-process.json");
      // In the parent's own environment as well: a child that inherited it would carry the key.
      vi.stubEnv("HARIL_CLIPROXYAPI_KEY", FAKE_SECRET);
      const host = {
        ...sb.host,
        env: {
          ...sb.host.env,
          HARIL_PI_CLI_OVERRIDE: recordingPi(record),
          HARIL_CLIPROXYAPI_KEY: FAKE_SECRET,
          HARIL_GATEWAY_URL: upstream.baseUrl,
          HARIL_DEFAULT_MODEL: "fake-model",
        },
      };
      const add = harness();
      expect(
        run(["task", "add", "Canary", "--agent", "analyst", "--model", "fake-model"], add.io, host),
      ).toBe(0);

      const outputs: string[] = [...add.out, ...add.err];
      const runOnce = harness();
      expect(await run(["run", "--project", "demo"], runOnce.io, host)).toBe(0);
      outputs.push(...runOnce.out, ...runOnce.err);

      const status = harness();
      await run(["status", "--json"], status.io, host);
      const taskId = parseJson<{ taskList: { taskId: string }[] }>(status.out).taskList[0]?.taskId;
      expect(taskId).toBeDefined();
      for (const argv of [
        ["task", "show", taskId ?? "", "--json"],
        ["events", "--project", "demo", "--json"],
        ["metrics", "--json"],
        ["models", "--json"],
        ["doctor"],
      ]) {
        const h = harness();
        await run(argv, h.io, host);
        outputs.push(...h.out, ...h.err);
      }
      outputs.push(...status.out, ...status.err);

      // The key was used: the upstream saw it as the bearer of both the catalog and the completion requests.
      const bearers = upstream.requests.map((request) => request.headers.authorization);
      expect(upstream.requests.map((request) => request.path)).toContain("/v1/chat/completions");
      expect(new Set(bearers)).toEqual(new Set([`Bearer ${FAKE_SECRET}`]));
      expect(outputs.join("\n")).toContain("Canary reply.");

      expectNoCanary("the command output", outputs.join("\n"));
      const child = readFileSync(record, "utf8");
      expectNoCanary("the Pi child's environment and argv", child);
      const vkey = (JSON.parse(child) as { env: Record<string, string | undefined> }).env
        .HARIL_VKEY;
      expect(vkey?.length ?? 0).toBeGreaterThan(0);
      for (const row of everyRow(join(sb.dataDir, "haril.db")))
        expectNoCanary("a haril.db row", row);
      const files = filesUnder(sb.dataDir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expectNoCanary(file, readFileSync(file));
    },
    TEST_TIMEOUT_MS,
  );
});
