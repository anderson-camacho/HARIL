import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { WorkflowView } from "../src/runtime/workflow-view.js";
import { harness, makeSandbox, projectRoot, type Sandbox, withWorkflowIntake } from "./helpers.js";

// A workflow of real archetype agents (phase F2b), end to end through `haril workflow start` and `haril run`: the real
// run loop, the real Broker and the real Pi adapter, with Pi replaced by the test-only seam HARIL_PI_CLI_OVERRIDE. The
// fake Pi below plays one turn of each role the way a model would: one chat through the Broker (so the ledger has its
// tokens), then the role's call over the bridge pipe, as the bridge's tools send it (delegation.call), or for an
// executor a read of the file its prompt names. The upstream is the OpenAI-compatible fake of @haril/gateway/testing.
// Nothing here calls the network.

const GATEWAY_KEY = "gateway-test-key-0123456789";
const TEST_TIMEOUT_MS = 60_000;
const SUMMARY = "The notes part reported both notes.";

const FAKE_PI = `
import { connect } from "node:net";
const tools = (process.env.HARIL_TOOLS ?? "").split(",").filter((name) => name !== "");
const raw = process.env.HARIL_BRIDGE ?? "";
const cut = raw.lastIndexOf("#");
const model = process.argv[process.argv.indexOf("--model") + 1];
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
async function chat(prompt) {
  const response = await fetch(process.env.HARIL_BROKER_URL + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.HARIL_VKEY },
    body: JSON.stringify({ model: process.env.HARIL_MODEL, stream: true, messages: [{ role: "user", content: prompt }] }),
  });
  await response.text();
}
const budget = (maxTokens) => ({ maxTokens });
async function turn(prompt) {
  await chat(prompt);
  const first = prompt.includes("(first).");
  if (tools.includes("haril_delegate")) {
    if (prompt.includes("[abort]")) return call("haril_abort", { reason: "the notes folder is empty" });
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
    const seen = prompt.includes("| summary: " + ${JSON.stringify(SUMMARY)}) ? "request seen" : "no request";
    return call("haril_verdict", { approved: true, reasons: [{ criterion: "The work is done", ok: true, evidence: seen }] });
  }
  const file = (/^Files to read: (.+)$/m.exec(prompt) ?? [])[1] ?? "";
  const reply = await request({ op: "read", path: file });
  return reply.ok ? "first line of " + file + ": " + reply.content.split("\\n")[0] : "read denied: " + reply.error;
}
async function runPrompt(prompt) {
  const text = await turn(prompt);
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
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
      emit({ type: "response", id: message.id, command: "get_state", success: true, data: { model: { id: model } } });
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
let upstream: FakeOpenAiServer;
let providersFile: string;
let fakePi: string;

beforeEach(async () => {
  sb = makeSandbox();
  upstream = await startFakeOpenAiServer({
    apiKey: GATEWAY_KEY,
    models: ["fake-model"],
    completion: { textChunks: ["Noted."], usage: { prompt_tokens: 12, completion_tokens: 5 } },
  });
  providersFile = join(sb.root, "haril.json");
  writeFileSync(
    providersFile,
    JSON.stringify({
      providers: [{ id: "cliproxy", baseUrl: upstream.baseUrl, keyEnv: "HARIL_CLIPROXYAPI_KEY" }],
    }),
  );
  fakePi = join(sb.root, "fake-pi-workflow.mjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");
  const project = projectRoot(sb, "demo");
  mkdirSync(join(project, "notes"));
  writeFileSync(join(project, "notes", "a.md"), "Alpha has three moons.\nmore\n");
  writeFileSync(join(project, "notes", "b.md"), "Beta has no rings.\n");
  const init = harness();
  run(["project", "init", project, "--name", "Demo", "--slug", "demo", "--yes"], init.io, sb.host);
});

afterEach(async () => {
  await upstream.close();
  sb.cleanup();
});

function realHost() {
  return {
    ...sb.host,
    env: {
      ...sb.host.env,
      HARIL_PI_CLI_OVERRIDE: fakePi,
      HARIL_CLIPROXYAPI_KEY: GATEWAY_KEY,
      HARIL_CONFIG: providersFile,
    },
  };
}

async function cli(args: string[], host = sb.host) {
  const h = harness();
  const code = await run(withWorkflowIntake(sb, projectRoot(sb, "demo"), args), h.io, host);
  return { code, out: h.out, err: h.err };
}

function inspect<T>(read: (view: WorkflowView, store: ReturnType<typeof openStore>) => T): T {
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
    const [workflow] = store.workflows.list();
    if (workflow === undefined) throw new Error("no workflow");
    return read(WorkflowView.load(store, workflow.workflowId) as WorkflowView, store);
  } finally {
    store.close();
  }
}

describe("a workflow of real archetype agents (F2b)", () => {
  it(
    "runs the orchestrator, a delegator, two executors, their auditors and the final auditor to completion",
    async () => {
      const started = await cli([
        "workflow",
        "start",
        "Report the facts of the notes folder",
        "--read-only",
        "--model",
        "cliproxy/fake-model",
        "--agent",
        "orchestrator",
        "--autonomous",
        "--project",
        "demo",
      ]);
      expect(started.code, started.err.join("\n")).toBe(0);

      const ran = await cli(["run", "--project", "demo"], realHost());
      const output = ran.out.join("\n");
      expect(ran.code, output).toBe(0);
      expect(output).toMatch(
        /^workflow \S+ completed: read-only consultation; no implementation or tests claimed$/m,
      );
      // The summary counts the workflow's turns and how the workflow ended.
      expect(ran.out[ran.out.length - 1]).toBe(
        "done: 0 completed, 0 failed, 0 blocked; workflows: 9 turns, 1 completed, 0 failed",
      );

      const tree = inspect((view, store) => {
        const labels = view.tasks.map((task) => `${view.label(task.threadId)}:${task.state}`);
        const usage = store.usageLog.usage({ workflowId: view.workflow.workflowId });
        const events = store.events
          .list({ limit: 10_000 })
          .filter((event) => event.type.startsWith("tool.haril_"))
          .map((event) => `${event.type}:${(event.payload as { outcome?: string }).outcome}`);
        return {
          state: view.workflow.state,
          labels,
          agents: [...new Set(view.tasks.map((task) => task.agentRef))].sort(),
          results: view.tasks
            .filter((task) => task.role === "executor")
            .map((task) => task.result?.text),
          finalEvidence: view.finalAudit()?.reasons.map((reason) => reason.evidence),
          usage,
          verify: store.usageLog.verify().ok,
          events,
        };
      });
      expect(tree.state).toBe("completed");
      expect(tree.agents).toEqual(["auditor", "delegator", "executor", "orchestrator"]);
      expect(tree.labels.sort()).toEqual(
        [
          "orchestrator:completed",
          "orchestrator:completed",
          "notes:completed",
          "notes:completed",
          "notes/read-a:completed",
          "notes/read-b:completed",
          "audit of notes/read-a:completed",
          "audit of notes/read-b:completed",
          "final audit:completed",
        ].sort(),
      );
      // The executors read through the bridge; the final auditor heard the orchestrator's audit request.
      expect(tree.results.sort()).toEqual([
        "first line of notes/a.md: Alpha has three moons.",
        "first line of notes/b.md: Beta has no rings.",
      ]);
      expect(tree.finalEvidence).toEqual(["request seen"]);
      // Every turn left one agent_run row with the tokens of its own run, from the Broker's ledger.
      expect(tree.usage).toHaveLength(9);
      for (const row of tree.usage) {
        expect(row).toMatchObject({
          kind: "agent_run",
          tokensIn: 12,
          tokensOut: 5,
          simulated: false,
        });
      }
      expect(tree.verify).toBe(true);
      expect(tree.events.sort()).toEqual(
        [
          "tool.haril_delegate:ok",
          "tool.haril_assign:ok",
          "tool.haril_verdict:ok",
          "tool.haril_verdict:ok",
          "tool.haril_report:ok",
          "tool.haril_request_audit:ok",
          "tool.haril_verdict:ok",
        ].sort(),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "shows a failed workflow in the run summary and exits 1, as a failed task does",
    async () => {
      const started = await cli([
        "workflow",
        "start",
        "Report the facts of the notes folder [abort]",
        "--read-only",
        "--model",
        "cliproxy/fake-model",
        "--agent",
        "orchestrator",
        "--autonomous",
      ]);
      expect(started.code, started.err.join("\n")).toBe(0);

      const ran = await cli(["run"], realHost());
      expect(ran.code).toBe(1);
      expect(ran.out.join("\n")).toMatch(
        /^workflow \S+ failed: aborted: the notes folder is empty$/m,
      );
      expect(ran.out[ran.out.length - 1]).toBe(
        "done: 0 completed, 0 failed, 0 blocked; workflows: 1 turn, 0 completed, 1 failed",
      );

      // --json carries the same tally and the exit code.
      const again = await cli([
        "workflow",
        "start",
        "Report again [abort]",
        "--read-only",
        "--model",
        "cliproxy/fake-model",
        "--agent",
        "orchestrator",
        "--autonomous",
      ]);
      expect(again.code).toBe(0);
      const json = await cli(["run", "--json"], realHost());
      expect(json.code).toBe(1);
      const summary = JSON.parse(json.out.join("\n")) as {
        workflows: { turns: number; completed: string[]; failed: string[]; waiting: string[] };
        exitCode: number;
      };
      expect(summary.exitCode).toBe(1);
      expect(summary.workflows).toMatchObject({ turns: 1, completed: [], waiting: [] });
      expect(summary.workflows.failed).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it("refuses an agent that is neither the real orchestrator nor the simulated one", async () => {
    const refused = await cli([
      "workflow",
      "start",
      "Report the facts",
      "--model",
      "cliproxy/fake-model",
      "--agent",
      "analyst",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain(
      "--agent takes orchestrator (real agents) or fake:orchestrate (simulated agents)",
    );
  });

  it("keeps the workflow archetypes out of standalone tasks", async () => {
    const refused = await cli([
      "task",
      "add",
      "Judge it",
      "--agent",
      "auditor",
      "--model",
      "cliproxy/fake-model",
    ]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain("agent auditor runs only inside a workflow");
  });
});
