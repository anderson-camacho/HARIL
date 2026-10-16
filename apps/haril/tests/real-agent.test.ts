import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// M2-T6, end to end through the real Broker and the real Pi adapter. Pi itself is replaced by the test-only
// seam HARIL_PI_CLI_OVERRIDE, which runs fake-pi.mjs with the current Node (M2-T6 item 3). The upstream is the
// OpenAI-compatible fake server of @haril/gateway/testing. Nothing here calls the network.
const GATEWAY_KEY = "gateway-test-key-0123456789";
const FAKE_PI = new URL("../../../integrations/agent-pi/testing/fake-pi.mjs", import.meta.url);
const TEST_TIMEOUT_MS = 30_000;

let sb: Sandbox;
let upstream: FakeOpenAiServer;

beforeEach(async () => {
  sb = makeSandbox();
  upstream = await startFakeOpenAiServer({
    apiKey: GATEWAY_KEY,
    models: ["fake-model"],
    completion: {
      textChunks: ["Hello ", "from the model."],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
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
  await upstream.close();
  sb.cleanup();
});

// A wrapper that selects one fake-pi scenario and then runs fake-pi.mjs with the current Node.
function piWrapper(scenario: string): string {
  const path = join(sb.root, `pi-${scenario}.mjs`);
  const fakePi = pathToFileURL(fileURLToPath(FAKE_PI)).href;
  writeFileSync(
    path,
    `process.env.FAKE_PI_SCENARIO = ${JSON.stringify(scenario)};\nawait import(${JSON.stringify(fakePi)});\n`,
  );
  return path;
}

function realHost(scenario: string, extra: Record<string, string | undefined> = {}) {
  return {
    ...sb.host,
    env: {
      ...sb.host.env,
      HARIL_PI_CLI_OVERRIDE: piWrapper(scenario),
      HARIL_CLIPROXYAPI_KEY: GATEWAY_KEY,
      HARIL_GATEWAY_URL: upstream.baseUrl,
      HARIL_DEFAULT_MODEL: "fake-model",
      ...extra,
    },
  };
}

function addAnalyst(title: string, extra: string[] = []): void {
  const add = harness();
  const code = run(["task", "add", title, "--agent", "analyst", ...extra], add.io, sb.host);
  if (code !== 0) throw new Error(add.err.join("\n"));
}

function taskIdOf(goal: string): string {
  const status = harness();
  run(["status", "--json"], status.io, sb.host);
  const found = parseJson<{ taskList: { taskId: string; goal: string }[] }>(
    status.out,
  ).taskList.find((task) => task.goal === goal);
  if (found === undefined) throw new Error(`no task "${goal}"`);
  return found.taskId;
}

interface TaskView {
  readonly state: string;
  readonly result: { text?: string; model?: string } | null;
  readonly error: { code: string } | null;
  readonly tokens: { input: number; output: number; unreconciled: number } | null;
}

function taskView(goal: string): TaskView {
  const show = harness();
  expect(run(["task", "show", taskIdOf(goal), "--json"], show.io, sb.host)).toBe(0);
  return parseJson<TaskView>(show.out);
}

function ledgerDb(): DatabaseSync {
  return new DatabaseSync(join(sb.dataDir, "haril.db"), { readOnly: true });
}

async function startRuntime(
  host = sb.host,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const h = harness();
  const code = await run(["start", "--project", "demo"], h.io, host);
  return { code, out: h.out, err: h.err };
}

describe("haril start with an analyst task (M2-T6)", () => {
  it(
    "completes the task through the Broker, keeps the reply text and counts the ledger tokens",
    async () => {
      addAnalyst("Read README.md and summarize it", ["--model", "fake-model"]);
      const host = realHost("ok_via_broker");

      const result = await startRuntime(host);

      expect(result.code).toBe(0);
      expect(result.out.join("\n")).toContain("completed");
      const view = taskView("Read README.md and summarize it");
      expect(view.state).toBe("completed");
      expect(view.result?.text).toBe("Hello from the model.");
      expect(view.result?.model).toBe("fake-model");
      expect(view.tokens?.input).toBe(12);
      expect(view.tokens?.output).toBe(5);

      const metrics = harness();
      run(["metrics", "--json"], metrics.io, sb.host);
      const usage = parseJson<{
        tokens: { input: number; output: number };
        tokensByAgentModel: { agentRef: string; model: string; input: number }[];
      }>(metrics.out);
      expect(usage.tokens.input + usage.tokens.output).toBeGreaterThan(0);
      expect(usage.tokensByAgentModel).toEqual([
        expect.objectContaining({ agentRef: "analyst", model: "fake-model", input: 12 }),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "records run events without content and never stores the gateway key",
    async () => {
      addAnalyst("Events", ["--model", "fake-model"]);
      await startRuntime(realHost("ok_via_broker"));

      const db = ledgerDb();
      try {
        const types = db
          .prepare("SELECT type FROM events WHERE run_id IS NOT NULL ORDER BY seq")
          .all()
          .map((row) => (row as { type: string }).type);
        expect(types).toEqual(
          expect.arrayContaining(["run.started", "run.handshake.ok", "run.settled"]),
        );
        const payloads = db
          .prepare("SELECT payload FROM events")
          .all()
          .map((row) => JSON.stringify(row));
        expect(payloads.join("\n")).not.toContain(GATEWAY_KEY);
        expect(payloads.join("\n")).not.toContain("Hello from the model");
      } finally {
        db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the attempt on a handshake mismatch and revokes the virtual key",
    async () => {
      addAnalyst("Handshake", ["--model", "fake-model"]);

      const result = await startRuntime(realHost("wrong_hello_tools"));

      expect(result.code).toBe(1);
      expect(taskView("Handshake")).toMatchObject({
        state: "failed",
        error: { code: "agent.handshake_mismatch" },
      });
      const db = ledgerDb();
      try {
        const active = db
          .prepare("SELECT COUNT(*) AS n FROM virtual_keys WHERE revoked_at IS NULL")
          .get() as { n: number };
        const total = db.prepare("SELECT COUNT(*) AS n FROM virtual_keys").get() as { n: number };
        expect(total.n).toBe(1);
        expect(active.n).toBe(0);
      } finally {
        db.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops a request that the task budget cannot hold with insufficient_quota and spends nothing",
    async () => {
      addAnalyst("Tiny budget", ["--model", "fake-model", "--max-tokens", "1"]);

      const result = await startRuntime(realHost("ok_via_broker"));

      expect(result.code).toBe(1);
      const view = taskView("Tiny budget");
      expect(view.state).toBe("failed");
      expect(view.error?.code).toBe("insufficient_quota");
      expect((view.tokens?.input ?? 0) + (view.tokens?.output ?? 0)).toBeLessThanOrEqual(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails the attempt when Pi exits before agent_settled",
    async () => {
      addAnalyst("Crash", ["--model", "fake-model"]);

      const result = await startRuntime(realHost("crash_before_settled"));

      expect(result.code).toBe(1);
      expect(taskView("Crash").error?.code).toBe("pi_exited");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "skips the analyst task without claiming it when the gateway key is missing, and keeps the others",
    async () => {
      addAnalyst("Needs key", ["--model", "fake-model"]);
      const add = harness();
      run(["task", "add", "Plain succeed"], add.io, sb.host);

      const host = realHost("ok_via_broker", { HARIL_CLIPROXYAPI_KEY: undefined });
      const result = await startRuntime(host);

      expect(result.code).toBe(1);
      const line = result.out.find((text) => text.startsWith("skipped "));
      expect(line).toMatch(/^skipped \S+ Needs key: needs setup \(.*HARIL_CLIPROXYAPI_KEY.*\)$/);
      expect(result.out.join("\n")).toContain("completed");
      expect(taskView("Needs key").state).toBe("ready");
      expect(taskView("Needs key").error).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "skips the analyst task when the Pi runtime is not installed",
    async () => {
      addAnalyst("No runtime", ["--model", "fake-model"]);
      const host = {
        ...sb.host,
        env: {
          ...sb.host.env,
          HARIL_CLIPROXYAPI_KEY: GATEWAY_KEY,
          HARIL_GATEWAY_URL: upstream.baseUrl,
          HARIL_RUNTIME_DIR: join(sb.root, "empty-runtime"),
        },
      };

      const result = await startRuntime(host);

      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/skipped \S+ No runtime: needs setup \(Pi runtime/);
      expect(taskView("No runtime").state).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses to start Pi on a Node below the INV-19 range (M2-D2) and keeps the task ready",
    async () => {
      addAnalyst("Old node", ["--model", "fake-model"]);
      const host = {
        ...realHost("ok_via_broker"),
        // Node 24.19.0 has the libuv defect of ADR-0009; the isolated runtime must be 24.21 or later.
        inspectRuntime: (root: string) => ({
          status: "ok" as const,
          root,
          manifest: join(root, "runtime", "manifest.json"),
          detail: "installed",
          node: { version: "24.19.0", path: process.execPath },
          pi: { version: "1.2.0", cliPath: FAKE_PI.pathname },
        }),
      };
      const override = { ...host.env, HARIL_PI_CLI_OVERRIDE: undefined };

      const result = await startRuntime({ ...host, env: override });

      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(
        /skipped \S+ Old node: needs setup \(isolated Node 24\.19\.0/,
      );
      expect(taskView("Old node").state).toBe("ready");
    },
    TEST_TIMEOUT_MS,
  );
});
