import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { createRealAgents } from "../src/runtime/real-agent.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// M2-T6, end to end through the real Broker and the real Pi adapter. Pi itself is replaced by the test-only
// seam HARIL_PI_CLI_OVERRIDE, which runs fake-pi.mjs with the current Node (M2-T6 item 3). The upstream is the
// OpenAI-compatible fake server of @haril/gateway/testing. Nothing here calls the network.
const GATEWAY_KEY = "gateway-test-key-0123456789";
const FAKE_PI = new URL("../../../integrations/agent-pi/testing/fake-pi.mjs", import.meta.url);
const TEST_TIMEOUT_MS = 30_000;

let sb: Sandbox;
let upstream: FakeOpenAiServer;
let providersFile: string;

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
  // One provider, so a bare model resolves to it without touching any other address (M3-T7).
  providersFile = join(sb.root, "haril.json");
  writeFileSync(
    providersFile,
    JSON.stringify({
      providers: [{ id: "cliproxy", baseUrl: upstream.baseUrl, keyEnv: "HARIL_CLIPROXYAPI_KEY" }],
    }),
  );
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
function piWrapper(scenario: string, env: Record<string, string> = {}): string {
  const path = join(sb.root, `pi-${scenario}.mjs`);
  const fakePi = pathToFileURL(fileURLToPath(FAKE_PI)).href;
  const extra = Object.entries(env)
    .map(([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};\n`)
    .join("");
  writeFileSync(
    path,
    `process.env.FAKE_PI_SCENARIO = ${JSON.stringify(scenario)};\n${extra}await import(${JSON.stringify(fakePi)});\n`,
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
      HARIL_CONFIG: providersFile,
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
  readonly attempts?: { used: number; max: number };
  readonly result: { text?: string; model?: string } | null;
  readonly error: { code: string; message?: string } | null;
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
  const code = await run(["run", "--project", "demo"], h.io, host);
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
      expect(view.result?.model).toBe("cliproxy/fake-model");
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
        expect.objectContaining({ agentRef: "analyst", model: "cliproxy/fake-model", input: 12 }),
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
    "records each PathGuard denial as security.pathguard.denied, counts it in metrics and task show, and keeps the path and content out of the store",
    async () => {
      const outside = join(sb.root, "outside.txt");
      writeFileSync(outside, "secret outside", "utf8");
      addAnalyst("Read outside the project", ["--model", "fake-model"]);
      const host = realHost("read_outside");
      host.env.HARIL_PI_CLI_OVERRIDE = piWrapper("read_outside", {
        FAKE_PI_OUTSIDE_PATH: outside,
      });

      const result = await startRuntime(host);

      expect(result.code).toBe(0);
      const taskId = taskIdOf("Read outside the project");
      const db = ledgerDb();
      const denied = db
        .prepare(
          "SELECT payload FROM events WHERE type = 'security.pathguard.denied' AND task_id = ?",
        )
        .all(taskId) as Array<{ payload: string }>;
      db.close();
      expect(denied).toHaveLength(3);
      const payloads = denied.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
      expect(payloads.map((payload) => payload.reason)).toEqual([
        "outside_root",
        "outside_root",
        "unc_or_device_path",
      ]);
      for (const payload of payloads) {
        expect(payload).toMatchObject({ tool: "read" });
        expect(typeof payload.pathHash).toBe("string");
      }

      const metrics = harness();
      expect(run(["metrics", "--json"], metrics.io, sb.host)).toBe(0);
      expect(parseJson<{ permissionDenials: number }>(metrics.out).permissionDenials).toBe(3);

      const show = harness();
      expect(run(["task", "show", taskId, "--json"], show.io, sb.host)).toBe(0);
      expect(parseJson<{ permissionDenials: number }>(show.out).permissionDenials).toBe(3);

      for (const entry of readdirSync(sb.dataDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const bytes = readFileSync(join(sb.dataDir, entry.name));
        expect(bytes.includes("secret outside")).toBe(false);
      }
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
    "skips the analyst task whose provider key is unset before any claim, and completes it once the key is set (M3-T7)",
    async () => {
      addAnalyst("Needs key", ["--model", "cliproxy/fake-model"]);
      const add = harness();
      run(["task", "add", "Plain succeed"], add.io, sb.host);

      const host = realHost("ok_via_broker", { HARIL_CLIPROXYAPI_KEY: undefined });
      const result = await startRuntime(host);

      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toContain("completed");
      const skipped = result.out.filter((line) => line.startsWith("skipped "));
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatch(
        /skipped \S+ Needs key: needs setup \(HARIL_CLIPROXYAPI_KEY is not set/,
      );
      expect(taskView("Needs key")).toMatchObject({
        state: "ready",
        attempts: { used: 0 },
        error: null,
      });
      expect(upstream.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);

      const again = await startRuntime(realHost("ok_via_broker"));

      expect(again.code).toBe(0);
      expect(taskView("Needs key").state).toBe("completed");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives Pi and the virtual key the bare model id, and keeps the namespaced ref in task show (M3-T7)",
    async () => {
      addAnalyst("Bare to Pi", ["--model", "fake-model"]);
      const seen = join(sb.root, "pi-model-seen.txt");
      const wrapper = join(sb.root, "pi-dump-model.mjs");
      const fakePi = pathToFileURL(fileURLToPath(FAKE_PI)).href;
      writeFileSync(
        wrapper,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, process.env.HARIL_MODEL ?? "");\nprocess.env.FAKE_PI_SCENARIO = "ok_via_broker";\nawait import(${JSON.stringify(fakePi)});\n`,
      );
      const host = realHost("ok_via_broker");
      host.env.HARIL_PI_CLI_OVERRIDE = wrapper;

      const result = await startRuntime(host);

      expect(result.code).toBe(0);
      expect(readFileSync(seen, "utf8")).toBe("fake-model");
      const db = ledgerDb();
      try {
        const grants = db.prepare("SELECT route_grant AS grant FROM virtual_keys").all() as Array<{
          grant: string;
        }>;
        expect(grants).toHaveLength(1);
        expect(JSON.parse(grants[0]?.grant ?? "{}")).toMatchObject({
          providerId: "cliproxy",
          models: ["fake-model"],
        });
      } finally {
        db.close();
      }
      expect(taskView("Bare to Pi").result?.model).toBe("cliproxy/fake-model");
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

// LD-T4 on the Pi lane: a planner task runs in the fake Pi, which proposes through the bridge's plan.propose the way the
// haril_propose_plan tool does. Both lanes share the host handler, so the proposal waits as a requested approval.
describe("haril start with a planner task (LD-T4)", () => {
  it(
    "proposes the plan through the bridge, retries after a refusal, and runs the plan once it is approved",
    async () => {
      const add = harness();
      expect(
        run(
          [
            "task",
            "add",
            "Plan the docs",
            "--kind",
            "plan",
            "--agent",
            "planner",
            "--model",
            "fake-model",
          ],
          add.io,
          sb.host,
        ),
      ).toBe(0);
      const host = realHost("propose_plan_retry");

      const first = await startRuntime(host);

      expect(first.code).toBe(0);
      const pending = harness();
      expect(run(["approvals", "--json"], pending.io, sb.host)).toBe(0);
      const approvals = parseJson<
        { approvalId: string; status: string; tasks: number; model: string | null }[]
      >(pending.out);
      expect(approvals).toHaveLength(1);
      const [approval] = approvals;
      // LD-T7a: the approval names the planner task's model, which every task of the plan will run with.
      expect(approval).toMatchObject({ status: "requested", tasks: 2, model: "fake-model" });
      if (approval === undefined) return;
      const pendingText = harness();
      expect(run(["approvals"], pendingText.io, sb.host)).toBe(0);
      expect(pendingText.out.join("\n")).toContain("model fake-model");
      expect(first.out.join("\n")).toContain(`approval ${approval.approvalId} requested`);
      const view = taskView("Plan the docs");
      expect(view.state).toBe("completed");
      expect(view.result?.text).toContain(`plan ok: proposed plan ${approval.approvalId}`);
      expect(view.result?.text).toContain("plan refused: invalid plan");

      const db = ledgerDb();
      try {
        const rows = db
          .prepare(
            "SELECT type, payload FROM events WHERE type IN ('tool.plan.propose', 'run.handshake.ok') ORDER BY seq",
          )
          .all() as Array<{ type: string; payload: string }>;
        const handshake = rows.find((row) => row.type === "run.handshake.ok");
        expect(JSON.parse(handshake?.payload ?? "{}")).toEqual({
          tools: ["read", "haril_propose_plan"],
        });
        const proposals = rows
          .filter((row) => row.type === "tool.plan.propose")
          .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
        // LD-T7c fix: the refusal keeps the reason HARIL gave the planner (never the plan itself).
        expect(proposals).toEqual([
          {
            outcome: "plan_refused",
            planSha256: expect.any(String),
            planBytes: expect.any(Number),
            reason: expect.stringMatching(/^invalid plan: /),
          },
          {
            outcome: "ok",
            planSha256: expect.any(String),
            planBytes: expect.any(Number),
            approvalId: approval.approvalId,
          },
        ]);
        // The plan body stays in the approval: no tool event carries it.
        expect(JSON.stringify(proposals)).not.toContain("fake Pi planner");
      } finally {
        db.close();
      }
      const events = harness();
      expect(run(["events", "--task", taskIdOf("Plan the docs")], events.io, sb.host)).toBe(0);
      expect(events.out.join("\n")).toMatch(
        /tool\.plan\.propose .*outcome=plan_refused .*reason=invalid plan: /,
      );

      const approve = harness();
      expect(
        await run(["approve", approval.approvalId], approve.io, { ...sb.host, user: "ana" }),
      ).toBe(0);
      const second = await startRuntime(host);

      expect(second.code).toBe(0);
      const status = harness();
      run(["status", "--json"], status.io, sb.host);
      const tasks = parseJson<{ taskList: { taskId: string; state: string }[] }>(
        status.out,
      ).taskList;
      expect(tasks).toHaveLength(1 + approval.tasks);
      expect(tasks.every((task) => task.state === "completed")).toBe(true);
      // Every task, the planner and the two of its plan, shows the planner's model.
      for (const task of tasks) {
        const show = harness();
        expect(run(["task", "show", task.taskId, "--json"], show.io, sb.host)).toBe(0);
        expect(parseJson<{ model: string | null }>(show.out).model).toBe("fake-model");
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// LD-T7a on the Pi lane: a granted plan gives its analyst the planner's model, but the plan's own budget decides the
// token ceiling. A ceiling below 1 fails the attempt, and the refusal names only what is missing: the token ceiling.
describe("haril start with a plan-created analyst (LD-T7a)", () => {
  const clock = { now: () => Date.now(), schedule: () => () => undefined };

  function openDemoStore() {
    return openStore({
      dataDir: sb.dataDir,
      clock,
      ids: { next: () => randomUUID() },
      rules: {
        canTransition,
        checkPlan: checkPlanSubmission,
        checkAcceptance,
        checkTaskKind,
        canonicalJson,
      },
    });
  }

  // The planner's proposal as the runtime records it: requested by its run, with the model of its task.
  function proposeAnalystPlan(maxTokens: number): string {
    const store = openDemoStore();
    try {
      const project = store.projects.getBySlug("demo");
      if (project === undefined) throw new Error("project demo is missing");
      const proposed = store.approvals.proposePlan({
        projectId: project.projectId,
        requestedBy: "run-planner",
        model: "fake-model",
        plan: {
          schemaVersion: 1,
          tasks: [
            {
              localId: "read",
              dependsOn: [],
              goal: "Summarize the README",
              description: "",
              priority: 5,
              kind: "work",
              agent: "analyst",
              requires: [],
              context: [],
              surface: { write: [], read: ["README.md"] },
              budget: { maxCostMicros: 0, maxTokens, maxWallMs: 60_000 },
              timeoutMs: 60_000,
              maxAttempts: 1,
              acceptance: [],
            },
          ],
        },
      });
      if (!proposed.ok) throw new Error(proposed.error.message);
      return proposed.value.approval.approvalId;
    } finally {
      store.close();
    }
  }

  it(
    "fails an analyst whose plan gives it no token ceiling, and the refusal names the ceiling, not the model",
    async () => {
      const approvalId = proposeAnalystPlan(0);
      const approve = harness();
      expect(await run(["approve", approvalId], approve.io, { ...sb.host, user: "ana" })).toBe(0);

      const result = await startRuntime(realHost("ok_via_broker"));

      expect(result.code).toBe(1);
      const view = taskView("Summarize the README");
      expect(view.state).toBe("failed");
      expect(view.error?.code).toBe("agent.invalid_spec");
      expect(view.error?.message).toContain("token ceiling");
      expect(view.error?.message).not.toContain("model");
      expect(view.error?.message).not.toContain("project");
    },
    TEST_TIMEOUT_MS,
  );

  // The run loop skips a real task without a model before its claim, so only the agent runtime sees the other cases.
  it.each([
    [
      "a model only",
      { model: "fake-model", maxTokens: 0 },
      "a token ceiling (budget.maxTokens of at least 1)",
    ],
    ["a token ceiling only", { maxTokens: 20_000 }, "a model"],
    ["neither", { maxTokens: 0 }, "a model and a token ceiling (budget.maxTokens of at least 1)"],
  ])("refuses a spec with %s and names exactly what is missing", async (_name, parts, needs) => {
    const store = openDemoStore();
    const agents = createRealAgents({
      host: realHost("ok_via_broker"),
      store,
      clock,
      dataDir: sb.dataDir,
    });
    try {
      const projectId = store.projects.getBySlug("demo")?.projectId;
      const started = await agents.runtime.start({
        runId: "run-1",
        taskId: "task-1",
        attempt: 1,
        agentRef: "analyst",
        allowedTools: ["read"],
        prompt: "Summarize the README",
        timeoutMs: 60_000,
        ...(projectId === undefined ? {} : { projectId }),
        ...parts,
      });
      expect(started).toEqual({
        ok: false,
        error: { code: "agent.invalid_spec", message: `a real agent needs ${needs}` },
      });
    } finally {
      await agents.close();
      store.close();
    }
  });
});
