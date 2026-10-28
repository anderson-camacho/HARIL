import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { WorkflowView } from "../src/runtime/workflow-view.js";
import { harness, makeSandbox, projectRoot, type Sandbox, withWorkflowIntake } from "./helpers.js";

// A workflow of real archetype agents on the claude-bridge lane, end to end through `haril workflow start` and `haril run`:
// the real run loop and the real Pi adapter, with no Broker, no provider key and no provider that answers (the setup of
// someone who has only Claude Code's login). Pi is the test-only seam HARIL_PI_CLI_OVERRIDE and pi-claude-bridge is a
// fake package in the sandbox's runtime root, where `haril extensions install` puts the real one. The fake Pi loads the
// extension file it is given with -e, as Pi does, checks that it registers the claude-bridge provider with the model,
// that the run's environment has no Broker or key and that the run's claude-bridge.json keeps AskClaude off, then plays
// each role's call over the bridge pipe and reports the usage of two model calls the way Pi does. Nothing here calls the
// network.

const TEST_TIMEOUT_MS = 60_000;
const MODEL = "claude-bridge/claude-fable-5-1";
const SUMMARY = "The notes part reported both notes.";

// The fake extension: what the real one does at load, minus Claude Code. Its models are the ones /model would offer.
const FAKE_BRIDGE = `
export default function (pi) {
  pi.registerProvider("claude-bridge", {
    baseUrl: "claude-bridge",
    api: "claude-bridge",
    models: [{ id: "claude-fable-5-1" }, { id: "claude-haiku-4-5" }],
  });
}
`;

const FAKE_PI = `
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const argv = process.argv;
const after = (flag) => argv[argv.indexOf(flag) + 1];
const extensions = argv.flatMap((arg, index) => (arg === "-e" ? [argv[index + 1]] : []));
const model = after("--model");
const fail = (why) => { process.stderr.write("fake pi: " + why + "\\n"); process.exit(9); };
if (after("--provider") !== "claude-bridge") fail("not launched on the claude-bridge provider");
if (extensions.length !== 2) fail("expected HARIL's bridge and pi-claude-bridge");
const registered = [];
await (await import(pathToFileURL(extensions[1]).href)).default({
  registerProvider: (name, config) => registered.push({ name, config }),
  registerTool: () => {},
  on: () => {},
});
const provider = registered.find((entry) => entry.name === "claude-bridge");
if (provider === undefined || !provider.config.models.some((entry) => entry.id === model)) {
  fail("the extension does not serve " + model);
}
for (const name of ["HARIL_BROKER_URL", "HARIL_VKEY", "HARIL_MODEL"]) {
  if (process.env[name] !== undefined) fail(name + " reached a claude-bridge run");
}
if (process.env.HARIL_LANE !== "claude-bridge") fail("HARIL_LANE is not claude-bridge");
const config = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json"), "utf8"));
if (config.askClaude?.enabled !== false || config.provider?.strictMcpConfig !== true) fail("bad claude-bridge.json");
const tools = (process.env.HARIL_TOOLS ?? "").split(",").filter((name) => name !== "");
const raw = process.env.HARIL_BRIDGE ?? "";
const cut = raw.lastIndexOf("#");
const pending = new Map();
let seq = 0;
let buffer = "";
let input = "";
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const socket = connect(raw.slice(0, cut));
socket.on("connect", () => {
  const hello = { type: "hello", runId: process.env.HARIL_RUN_ID, token: raw.slice(cut + 1), tools, bridgeVersion: "fake" };
  socket.write(JSON.stringify(hello) + "\\n");
});
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let lf = buffer.indexOf("\\n");
  while (lf !== -1) {
    const reply = JSON.parse(buffer.slice(0, lf));
    buffer = buffer.slice(lf + 1);
    lf = buffer.indexOf("\\n");
    pending.get(reply.id)?.(reply);
  }
});
socket.on("error", () => {});
const request = (operation) => new Promise((resolve) => {
  const id = "op-" + ++seq;
  pending.set(id, resolve);
  socket.write(JSON.stringify({ id, ...operation }) + "\\n");
});
const call = async (tool, payload) => {
  const reply = await request({ op: "delegation.call", tool, input: payload });
  return reply.ok ? tool + " accepted" : tool + " refused: " + reply.error;
};
// The cache read of an auditor's call when the test writes audit-usage.json next to this script (an auditor whose
// context outgrows its budget), else the usual 90.
const auditCacheRead = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./audit-usage.json", import.meta.url), "utf8")).cacheRead;
  } catch {
    return 90;
  }
})();
// The model call that asks for the role's tool, with its usage as Pi reports it.
const toolCall = () => emit({ type: "message_end", message: {
  role: "assistant", content: [{ type: "text", text: "calling" }], stopReason: "toolUse",
  usage: { input: 10, output: 4, cacheRead: tools.includes("haril_verdict") ? auditCacheRead : 90, cacheWrite: 0, totalTokens: 104 },
} });
const budget = (maxTokens) => ({ maxTokens });
async function turn(prompt) {
  toolCall();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const first = prompt.includes("(first).");
  if (tools.includes("haril_delegate")) {
    if (!first) return call("haril_request_audit", { summary: ${JSON.stringify(SUMMARY)}, outstanding: [] });
    return call("haril_delegate", {
      schemaVersion: 1,
      memo: "one part: the notes",
      delegations: [{
        localId: "notes", goal: "Report the facts of the notes folder", description: "Read notes/a.md and notes/b.md.",
        difficulty: "easy", difficultyReason: "two small files", dependsOn: [], priority: 5,
        acceptanceCriteria: ["Both notes are reported"], budget: budget(60000),
      }],
    });
  }
  if (tools.includes("haril_assign")) {
    if (!first) return call("haril_report", { status: "done", summary: "a.md and b.md read", issues: [] });
    const step = (localId, file) => ({
      localId, goal: "Report the first line of " + file, instructions: "Read " + file + " and quote its first line.",
      files: { write: [], read: [file] }, tests: "", acceptanceCriteria: ["The first line of " + file + " is quoted"],
      difficulty: "trivial", difficultyReason: "one small file", dependsOn: [], budget: budget(45000),
    });
    return call("haril_assign", { schemaVersion: 1, memo: "two steps", assignments: [step("read-a", "notes/a.md"), step("read-b", "notes/b.md")] });
  }
  if (tools.includes("haril_verdict")) {
    return call("haril_verdict", { approved: true, reasons: [{ criterion: "The work is done", ok: true, evidence: "seen" }] });
  }
  const file = (/^Files to read: (.+)$/m.exec(prompt) ?? [])[1] ?? "";
  const reply = await request({ op: "read", path: file });
  return reply.ok ? "first line of " + file + ": " + reply.content.split("\\n")[0] : "read denied: " + reply.error;
}
async function runPrompt(prompt) {
  const text = await turn(prompt);
  emit({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
    usage: { input: 2, output: 1, cacheRead: 10, cacheWrite: 0, totalTokens: 13 },
  } });
  emit({ type: "agent_settled", aborted: false });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let lf = input.indexOf("\\n");
  while (lf !== -1) {
    const message = JSON.parse(input.slice(0, lf));
    input = input.slice(lf + 1);
    lf = input.indexOf("\\n");
    if (message.type === "get_state") {
      emit({ type: "response", id: message.id, command: "get_state", success: true, data: { model: { id: model, provider: "claude-bridge" } } });
    }
    if (message.type === "prompt") {
      emit({ type: "response", id: message.id, command: "prompt", success: true, data: { disposition: "started" } });
      void runPrompt(message.message);
    }
  }
});
process.stdin.on("end", () => process.stdout.write("", () => process.exit(0)));
`;

let sb: Sandbox;
let runtimeDir: string;
let fakePi: string;

beforeEach(() => {
  sb = makeSandbox();
  runtimeDir = join(sb.root, "runtime-root");
  fakePi = join(sb.root, "fake-pi-claude-bridge.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const project = projectRoot(sb, "demo");
  mkdirSync(join(project, "notes"));
  writeFileSync(join(project, "notes", "a.md"), "Alpha has three moons.\nmore\n");
  writeFileSync(join(project, "notes", "b.md"), "Beta has no rings.\n");
  const init = harness();
  run(["project", "init", project, "--name", "Demo", "--slug", "demo", "--yes"], init.io, sb.host);
});

afterEach(() => {
  sb.cleanup();
});

// pi-claude-bridge as `haril extensions install npm:pi-claude-bridge` leaves it: HARIL's private Pi directory.
function installFakeBridge(): void {
  const dir = join(runtimeDir, "agent", "npm", "node_modules", "pi-claude-bridge");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "pi-claude-bridge",
      version: "0.9.3",
      pi: { extensions: ["./src/index.mjs"] },
    }),
  );
  writeFileSync(join(dir, "src", "index.mjs"), FAKE_BRIDGE, "utf8");
  // The console's own claude-bridge.json: the plan carries over, AskClaude does not.
  writeFileSync(
    join(runtimeDir, "agent", "claude-bridge.json"),
    JSON.stringify({
      askClaude: { enabled: true },
      provider: { plan: "max", strictMcpConfig: false },
    }),
  );
}

function bridgeHost() {
  const config = join(sb.root, "haril.json");
  return {
    ...sb.host,
    env: {
      ...sb.host.env,
      HARIL_RUNTIME_DIR: runtimeDir,
      HARIL_PI_CLI_OVERRIDE: fakePi,
      ...(existsSync(config) ? { HARIL_CONFIG: config } : {}),
    },
  };
}

// haril.json with these delegation limits.
function writeLimits(limits: Record<string, number>): void {
  writeFileSync(join(sb.root, "haril.json"), JSON.stringify({ delegation: { limits } }));
}

async function cli(args: string[], host = bridgeHost()) {
  const h = harness();
  const code = await run(withWorkflowIntake(sb, projectRoot(sb, "demo"), args), h.io, host);
  return { code, out: h.out, err: h.err };
}

const START = [
  "workflow",
  "start",
  "Report the facts of the notes folder",
  "--read-only",
  "--model",
  MODEL,
  "--agent",
  "orchestrator",
  "--autonomous",
  "--project",
  "demo",
];

function inspect<T>(read: (view: WorkflowView, store: ReturnType<typeof openStore>) => T): T {
  return withStore((store) => {
    const [workflow] = store.workflows.list();
    if (workflow === undefined) throw new Error("no workflow");
    return read(WorkflowView.load(store, workflow.workflowId) as WorkflowView, store);
  });
}

function withStore<T>(work: (store: ReturnType<typeof openStore>) => T): T {
  const store = openStore({
    dataDir: sb.dataDir,
    clock: { now: () => Date.now(), schedule: () => () => undefined },
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
  });
  try {
    return work(store);
  } finally {
    store.close();
  }
}

describe("a workflow of real agents on claude-bridge models", () => {
  it(
    "runs every layer on the claude-bridge model without a Broker and charges each turn's usage",
    async () => {
      installFakeBridge();
      const started = await cli(START);
      expect(started.code, started.err.join("\n")).toBe(0);

      const ran = await cli(["run", "--project", "demo"]);
      const output = ran.out.join("\n");
      expect(ran.code, `${output}\n${ran.err.join("\n")}`).toBe(0);
      expect(output).toMatch(
        /^workflow \S+ completed: read-only consultation; no implementation or tests claimed$/m,
      );
      expect(ran.out[ran.out.length - 1]).toBe(
        "done: 0 completed, 0 failed, 0 blocked; workflows: 9 turns, 1 completed, 0 failed",
      );

      const tree = inspect((view, store) => ({
        state: view.workflow.state,
        models: [...new Set(view.tasks.map((task) => task.model))],
        results: view.tasks
          .filter((task) => task.role === "executor")
          .map((task) => task.result?.text)
          .sort(),
        usage: store.usageLog.usage({ workflowId: view.workflow.workflowId }),
        verify: store.usageLog.verify().ok,
        auditorBudgets: view.tasks
          .filter((task) => task.role === "auditor" && task.goal.startsWith("Audit read-"))
          .map((task) => task.budgetTokens),
        projectLimit: store.budgets.find("project", view.workflow.projectId)?.hardLimit,
        started: store.events
          .list({ limit: 10_000 })
          .filter((event) => event.type === "run.started")
          .map((event) => event.payload),
      }));
      expect(tree.state).toBe("completed");
      // No layer is pinned and no provider answers: every child runs on the orchestrator's model.
      expect(tree.models).toEqual([MODEL]);
      expect(tree.results).toEqual([
        "first line of notes/a.md: Alpha has three moons.",
        "first line of notes/b.md: Beta has no rings.",
      ]);
      // Each turn's two model calls, prompt with its cache: (10 + 90) + (2 + 10) in, 4 + 1 out.
      expect(tree.usage).toHaveLength(9);
      for (const row of tree.usage) {
        expect(row).toMatchObject({
          kind: "agent_run",
          provider: "claude-bridge",
          modelRequested: MODEL,
          tokensIn: 112,
          tokensOut: 5,
          simulated: false,
        });
      }
      expect(tree.verify).toBe(true);
      // Each step's executor holds 45000: its auditor gets the floor, not a third (15000) that a few calls spend.
      expect(tree.auditorBudgets).toEqual([60_000, 60_000]);
      // delegation.limits.projectTokens' default.
      expect(tree.projectLimit).toBe(50_000_000);
      expect(tree.started).toHaveLength(9);
      for (const payload of tree.started) {
        expect(payload).toMatchObject({
          agentRuntime: "pi",
          lane: "claude-bridge",
          limitsSource: "bridge",
          contextWindow: null,
        });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ends a turn as insufficient_quota once its budget is spent before a tool call",
    async () => {
      installFakeBridge();
      const started = await cli([...START, "--budget-tokens", "60"]);
      expect(started.code, started.err.join("\n")).toBe(0);

      const ran = await cli(["run", "--project", "demo"]);
      expect(ran.code).toBe(1);
      const usage = inspect((view, store) =>
        store.usageLog.usage({ workflowId: view.workflow.workflowId }),
      );
      // The orchestrator's first call (100 prompt tokens and 4 out) was charged in full; nothing ran after it.
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ tokensIn: 100, tokensOut: 4, role: "orchestrator" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "settles a step whose auditor spent its budget before its verdict without relaunching the executor",
    async () => {
      installFakeBridge();
      // Every auditor call carries more context than the auditor's 60000 tokens.
      writeFileSync(join(sb.root, "audit-usage.json"), JSON.stringify({ cacheRead: 100_000 }));
      const started = await cli(START);
      expect(started.code, started.err.join("\n")).toBe(0);

      const ran = await cli(["run", "--project", "demo"]);
      expect(ran.code).toBe(1);
      const tree = inspect((view, store) => ({
        executors: view.tasks.filter((task) => task.role === "executor").length,
        audits: view.tasks
          .filter((task) => task.role === "auditor" && task.goal.startsWith("Audit read-"))
          .map((task) => ({
            state: task.state,
            code: store.events
              .list({ taskId: task.taskId, limit: 100 })
              .find((event) => event.type === "task.failed")?.payload.code,
          })),
      }));
      // One executor turn per step: a relaunch would have redone work no auditor judged.
      expect(tree.executors).toBe(2);
      expect(tree.audits).toEqual([
        { state: "failed", code: "insufficient_quota" },
        { state: "failed", code: "insufficient_quota" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sets the project's budget to delegation.limits.projectTokens, also one an earlier launch created",
    async () => {
      installFakeBridge();
      writeLimits({ projectTokens: 7_000_000 });
      // The budget an earlier HARIL created with its fixed 1000000 tokens.
      withStore((store) => {
        const project = store.projects.getBySlug("demo");
        if (project === undefined) throw new Error("no project");
        store.budgets.ensure({
          scopeType: "project",
          scopeId: project.projectId,
          projectId: project.projectId,
          hardLimit: 1_000_000,
        });
      });
      const started = await cli(START);
      expect(started.code, started.err.join("\n")).toBe(0);
      const ran = await cli(["run", "--project", "demo"]);
      expect(ran.code, ran.err.join("\n")).toBe(0);
      const budget = inspect((view, store) =>
        store.budgets.find("project", view.workflow.projectId),
      );
      expect(budget).toMatchObject({ hardLimit: 7_000_000 });
      expect(budget?.spent).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the preflight of a claude-bridge workflow", () => {
  const PREFLIGHT = [
    "workflow",
    "start",
    "Report the facts",
    "--preflight",
    "--read-only",
    "--agent",
    "orchestrator",
    "--project",
    "demo",
    "--json",
  ];

  it("accepts it when pi-claude-bridge is installed, and carries the Agent SDK billing notice", async () => {
    installFakeBridge();
    const checked = await cli([...PREFLIGHT, "--model", MODEL]);
    expect(checked.code, checked.err.join("\n")).toBe(0);
    const reply = JSON.parse(checked.out.join("\n")) as { status: string; notices: string[] };
    expect(reply.status).toBe("ready");
    expect(reply.notices).toHaveLength(1);
    expect(reply.notices[0]).toContain("Agent SDK");
  });

  it("refuses it with the fix when pi-claude-bridge is not installed", async () => {
    const checked = await cli([...PREFLIGHT, "--model", MODEL]);
    expect(checked.code).toBe(2);
    expect(checked.err.join("\n")).toContain(
      "the real agents cannot run yet: pi-claude-bridge is not installed in HARIL's Pi (run haril extensions install npm:pi-claude-bridge --yes, then pick a claude-bridge model with /model); nothing was queued",
    );
  });

  it("refuses a claude-bridge ref that names no Claude model", async () => {
    installFakeBridge();
    const checked = await cli([...PREFLIGHT, "--model", "claude-bridge/gpt-5"]);
    expect(checked.code).toBe(2);
    expect(checked.err.join("\n")).toContain("claude-bridge/gpt-5 is not a claude-bridge model");
  });

  it("refuses it while the project's token budget cannot cover the orchestrator's turn, and queues nothing", async () => {
    installFakeBridge();
    writeLimits({ projectTokens: 150_000 });
    const checked = await cli([...PREFLIGHT, "--model", MODEL]);
    expect(checked.code).toBe(2);
    expect(checked.err.join("\n")).toContain(
      "the real agents cannot run yet: the project's token budget has 150000 of 150000 tokens left and the orchestrator's turn takes 200000 (raise it with haril config set delegation.limits.projectTokens <tokens>); nothing was queued",
    );
    expect(withStore((store) => store.commands.listQueued())).toHaveLength(0);

    writeLimits({ projectTokens: 250_000 });
    const raised = await cli([...PREFLIGHT, "--model", MODEL]);
    expect(raised.code, raised.err.join("\n")).toBe(0);
  });
});
