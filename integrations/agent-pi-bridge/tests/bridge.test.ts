import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bridge, {
  type BridgePiApi,
  type BridgeToolDefinition,
  type ProviderConfig,
} from "../src/bridge.js";

// Bridge tests use a fake `pi` object and a fake pipe server: the real ExtensionAPI is not installed (UNVERIFIED).

const TOKEN = randomBytes(32).toString("hex");
const VKEY = "vkey-bridge-test-0123456789";
const MODEL = "haril-test-model";
const BROKER = "http://127.0.0.1:9/v1";
const ENV_KEYS = [
  "HARIL_BRIDGE",
  "HARIL_TOOLS",
  "HARIL_VKEY",
  "HARIL_RUN_ID",
  "HARIL_BROKER_URL",
  "HARIL_MODEL",
  "HARIL_MODEL_CONTEXT",
  "HARIL_MODEL_MAX_TOKENS",
] as const;

interface RecordedPi extends BridgePiApi {
  readonly providers: { name: string; config: ProviderConfig }[];
  readonly tools: BridgeToolDefinition[];
}

interface FakePipe {
  readonly path: string;
  readonly hellos: Record<string, unknown>[];
  readonly ops: Record<string, unknown>[];
  respond(handler: (op: Record<string, unknown>) => Record<string, unknown>): void;
  close(): Promise<void>;
}

let tmp = "";
let pipe: FakePipe | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "haril-bridge-"));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(async () => {
  await pipe?.close();
  pipe = undefined;
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function pipePath(): string {
  const suffix = randomBytes(6).toString("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\haril-bridge-test-${suffix}`
    : join(tmp, `bridge-${suffix}.sock`);
}

async function startFakePipe(): Promise<FakePipe> {
  const path = pipePath();
  const hellos: Record<string, unknown>[] = [];
  const ops: Record<string, unknown>[] = [];
  let handler: (op: Record<string, unknown>) => Record<string, unknown> = () => ({
    ok: false,
    error: "unsupported",
  });
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let lf = buffer.indexOf("\n");
      while (lf !== -1) {
        const message = JSON.parse(buffer.slice(0, lf)) as Record<string, unknown>;
        buffer = buffer.slice(lf + 1);
        if (message.type === "hello") {
          hellos.push(message);
        } else {
          ops.push(message);
          socket.write(`${JSON.stringify({ id: message.id, ...handler(message) })}\n`);
        }
        lf = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    path,
    hellos,
    ops,
    respond(next) {
      handler = next;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function setEnv(bridgeValue: string, tools = "read"): void {
  process.env.HARIL_BRIDGE = bridgeValue;
  process.env.HARIL_TOOLS = tools;
  process.env.HARIL_VKEY = VKEY;
  process.env.HARIL_RUN_ID = "run-1";
  process.env.HARIL_BROKER_URL = BROKER;
  process.env.HARIL_MODEL = MODEL;
  delete process.env.HARIL_MODEL_CONTEXT;
  delete process.env.HARIL_MODEL_MAX_TOKENS;
}

function fakePi(): RecordedPi {
  const providers: RecordedPi["providers"] = [];
  const tools: BridgeToolDefinition[] = [];
  return {
    providers,
    tools,
    registerProvider(name, config) {
      providers.push({ name, config });
    },
    registerTool(tool) {
      tools.push(tool);
    },
  };
}

async function loadWithPipe(tools = "read"): Promise<{ pi: RecordedPi; fake: FakePipe }> {
  const fake = await startFakePipe();
  pipe = fake;
  setEnv(`${fake.path}#${TOKEN}`, tools);
  const pi = fakePi();
  await bridge(pi);
  return { pi, fake };
}

function readTool(pi: RecordedPi): BridgeToolDefinition {
  return toolNamed(pi, "read");
}

function toolNamed(pi: RecordedPi, name: string): BridgeToolDefinition {
  const tool = pi.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name} registered`);
  return tool;
}

const PLAN_TOOLS = "read,haril_propose_plan";
const DELEGATION_TOOLS = [
  "haril_delegate",
  "haril_assign",
  "haril_report",
  "haril_verdict",
  "haril_request_audit",
  "haril_abort",
] as const;
const WORKSPACE_TOOLS = [
  "write",
  "edit",
  "haril_run",
  "haril_merge",
  "haril_merge_continue",
  "haril_merge_abort",
] as const;
const PLAN = { schemaVersion: 1, tasks: [{ localId: "survey", goal: "Survey the CLI" }] };

describe("agent-pi-bridge extension", () => {
  it("deletes HARIL_BRIDGE, HARIL_TOOLS and HARIL_VKEY from the environment on load", async () => {
    await loadWithPipe();
    expect(process.env.HARIL_BRIDGE).toBeUndefined();
    expect(process.env.HARIL_TOOLS).toBeUndefined();
    expect(process.env.HARIL_VKEY).toBeUndefined();
  });

  it("sends hello over the pipe with runId, token, tools and bridgeVersion", async () => {
    const { fake } = await loadWithPipe();
    await waitFor(() => fake.hellos.length === 1);
    expect(fake.hellos[0]).toMatchObject({
      type: "hello",
      runId: "run-1",
      token: TOKEN,
      tools: ["read"],
      bridgeVersion: expect.any(String),
    });
  });

  it("registers the haril provider with the broker URL, the virtual key and declared model fields", async () => {
    const { pi } = await loadWithPipe();
    expect(pi.providers).toHaveLength(1);
    const provider = pi.providers[0];
    expect(provider?.name).toBe("haril");
    expect(provider?.config).toMatchObject({
      baseUrl: BROKER,
      api: "openai-completions",
      apiKey: VKEY,
      models: [
        {
          id: MODEL,
          contextWindow: expect.any(Number),
          maxTokens: expect.any(Number),
          cost: { input: 0, output: 0 },
        },
      ],
    });
  });

  it("registers each model with the full Pi model shape and the default limits", async () => {
    const { pi } = await loadWithPipe();
    expect(pi.providers[0]?.config.models).toEqual([
      {
        id: MODEL,
        name: MODEL,
        input: ["text"],
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it("takes the context window and max tokens from the environment", async () => {
    const fake = await startFakePipe();
    pipe = fake;
    setEnv(`${fake.path}#${TOKEN}`);
    process.env.HARIL_MODEL_CONTEXT = "65536";
    process.env.HARIL_MODEL_MAX_TOKENS = "8192";
    const pi = fakePi();
    await bridge(pi);
    expect(pi.providers[0]?.config.models[0]).toMatchObject({
      contextWindow: 65536,
      maxTokens: 8192,
    });
  });

  it("falls back to the default limits when the environment values are not positive integers", async () => {
    const fake = await startFakePipe();
    pipe = fake;
    setEnv(`${fake.path}#${TOKEN}`);
    process.env.HARIL_MODEL_CONTEXT = "0";
    process.env.HARIL_MODEL_MAX_TOKENS = "many";
    const pi = fakePi();
    await bridge(pi);
    expect(pi.providers[0]?.config.models[0]).toMatchObject({
      contextWindow: 32768,
      maxTokens: 4096,
    });
  });

  it("registers exactly one tool, read, and never grep, find, ls or bash", async () => {
    const { pi } = await loadWithPipe();
    expect(pi.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("registers read with a label, as Pi's tool definition requires", async () => {
    const { pi } = await loadWithPipe();
    expect(readTool(pi).label).toEqual(expect.any(String));
    expect(readTool(pi).label.length).toBeGreaterThan(0);
  });

  it("read forwards the path over the pipe and returns the content", async () => {
    const { pi, fake } = await loadWithPipe();
    fake.respond((op) =>
      op.path === "a.txt" ? { ok: true, content: "hello" } : { ok: false, error: "x" },
    );
    const result = await readTool(pi).execute("call-1", { path: "a.txt" });
    expect(fake.ops).toEqual([expect.objectContaining({ op: "read", path: "a.txt" })]);
    expect(result).toEqual({ content: [{ type: "text", text: "hello" }], details: {} });
  });

  it("read maps a denial from the runtime to an error result", async () => {
    const { pi, fake } = await loadWithPipe();
    fake.respond(() => ({ ok: false, error: "path_denied" }));
    const result = await readTool(pi).execute("call-2", { path: "../secret" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("path_denied");
    expect(result.details).toEqual({});
  });

  it.each(["missing", "not_a_file", "unreadable", "path_denied", "too_large"])(
    "shows the safe %s read denial category to the agent",
    async (reason) => {
      const { pi, fake } = await loadWithPipe();
      fake.respond(() => ({ ok: false, error: reason }));
      const result = await readTool(pi).execute("call-denied", { path: "candidate.txt" });
      expect(result).toEqual({
        content: [{ type: "text", text: `denied: ${reason}` }],
        details: {},
        isError: true,
      });
    },
  );

  it("does not expose an unexpected read error from the runtime", async () => {
    const { pi, fake } = await loadWithPipe();
    fake.respond(() => ({ ok: false, error: "secret internal path" }));
    const result = await readTool(pi).execute("call-denied", { path: "candidate.txt" });
    expect(result.content).toEqual([{ type: "text", text: "denied: denied" }]);
    expect(result.isError).toBe(true);
  });

  it("registers haril_propose_plan next to read when HARIL_TOOLS announces it, and the hello lists both", async () => {
    const { pi, fake } = await loadWithPipe(PLAN_TOOLS);
    expect(pi.tools.map((tool) => tool.name)).toEqual(["read", "haril_propose_plan"]);
    expect(toolNamed(pi, "haril_propose_plan").label.length).toBeGreaterThan(0);
    expect(toolNamed(pi, "haril_propose_plan").parameters).toMatchObject({ type: "object" });
    await waitFor(() => fake.hellos.length === 1);
    expect(fake.hellos[0]?.tools).toEqual(["read", "haril_propose_plan"]);
  });

  it("announces only the tools it registers: a name it does not serve stays out of the hello", async () => {
    const { pi, fake } = await loadWithPipe("read,bash");
    expect(pi.tools.map((tool) => tool.name)).toEqual(["read"]);
    await waitFor(() => fake.hellos.length === 1);
    expect(fake.hellos[0]?.tools).toEqual(["read"]);
  });

  it("haril_propose_plan sends the plan over the pipe as plan.propose and returns the host's text", async () => {
    const { pi, fake } = await loadWithPipe(PLAN_TOOLS);
    fake.respond((op) =>
      op.op === "plan.propose"
        ? { ok: true, content: "proposed plan appr-1; it waits for haril approve appr-1" }
        : { ok: false, error: "unsupported" },
    );
    const result = await toolNamed(pi, "haril_propose_plan").execute("call-3", PLAN);
    expect(fake.ops).toEqual([expect.objectContaining({ op: "plan.propose", plan: PLAN })]);
    expect(result).toEqual({
      content: [{ type: "text", text: "proposed plan appr-1; it waits for haril approve appr-1" }],
      details: {},
    });
  });

  it("haril_propose_plan maps a refusal to an error result with the reason, so the model can fix the plan", async () => {
    const { pi, fake } = await loadWithPipe(PLAN_TOOLS);
    fake.respond(() => ({ ok: false, error: "invalid plan: schemaVersion must be 1" }));
    const result = await toolNamed(pi, "haril_propose_plan").execute("call-4", {
      schemaVersion: 2,
      tasks: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid plan: schemaVersion must be 1");
    expect(result.details).toEqual({});
  });

  it("registers exactly the tools the host announces for each workflow role, and the hello lists them", async () => {
    const roles: [string, string[]][] = [
      ["orchestrator", ["read", "haril_delegate", "haril_request_audit", "haril_abort"]],
      ["delegator", ["read", "haril_assign", "haril_report"]],
      ["executor", ["read"]],
      ["auditor", ["read", "haril_verdict"]],
    ];
    for (const [role, tools] of roles) {
      const { pi, fake } = await loadWithPipe(tools.join(","));
      expect(
        pi.tools.map((tool) => tool.name),
        role,
      ).toEqual(tools);
      await waitFor(() => fake.hellos.length === 1);
      expect(fake.hellos[0]?.tools, role).toEqual(tools);
      await fake.close();
      pipe = undefined;
    }
  });

  it("never registers Pi's shell or search tools, even when HARIL_TOOLS names them", async () => {
    const { pi, fake } = await loadWithPipe("read,bash,powershell,grep,find,ls,haril_verdict");
    expect(pi.tools.map((tool) => tool.name)).toEqual(["read", "haril_verdict"]);
    await waitFor(() => fake.hellos.length === 1);
    // The hello lists only what is served, so the host's handshake refuses the run (fail closed).
    expect(fake.hellos[0]?.tools).toEqual(["read", "haril_verdict"]);
  });

  it("registers the workspace tools of a turn in a worktree only when the host announces them (F8)", async () => {
    const { pi, fake } = await loadWithPipe(`read,${WORKSPACE_TOOLS.join(",")},bash,haril_report`);
    expect(pi.tools.map((tool) => tool.name)).toEqual(["read", ...WORKSPACE_TOOLS, "haril_report"]);
    await waitFor(() => fake.hellos.length === 1);
    expect(fake.hellos[0]?.tools).toEqual(["read", ...WORKSPACE_TOOLS, "haril_report"]);
    // Pi's write and edit shapes: a whole file, or exact replacements.
    expect(toolNamed(pi, "write").parameters).toMatchObject({ required: ["path", "content"] });
    expect(toolNamed(pi, "edit").parameters).toMatchObject({ required: ["path", "edits"] });
    expect(toolNamed(pi, "haril_run").parameters).toMatchObject({ required: ["command"] });
    expect(toolNamed(pi, "haril_merge").parameters).toMatchObject({ required: ["localId"] });
    for (const name of WORKSPACE_TOOLS) {
      expect(toolNamed(pi, name).description.length, name).toBeGreaterThan(20);
    }
  });

  it("sends each workspace tool's arguments to the host as delegation.call (F8)", async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      write: { path: "src/a.ts", content: "x" },
      edit: { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] },
      haril_run: { command: "npm", args: ["test"] },
      haril_merge: { localId: "step-1" },
      haril_merge_continue: {},
      haril_merge_abort: {},
    };
    const { pi, fake } = await loadWithPipe(WORKSPACE_TOOLS.join(","));
    fake.respond((op) => ({ ok: true, content: `done ${String(op.tool)}`, reply: { ok: true } }));
    for (const name of WORKSPACE_TOOLS) {
      const result = await toolNamed(pi, name).execute(`call-${name}`, inputs[name] ?? {});
      expect(result.content[0]?.text, name).toBe(`done ${name}`);
    }
    expect(fake.ops.map((op) => [op.op, op.tool, op.input])).toEqual(
      WORKSPACE_TOOLS.map((name) => ["delegation.call", name, inputs[name]]),
    );
  });

  it("describes every delegation tool with a label and an object schema of named, required fields", async () => {
    const { pi } = await loadWithPipe(DELEGATION_TOOLS.join(","));
    for (const name of DELEGATION_TOOLS) {
      const tool = toolNamed(pi, name);
      expect(tool.label.length, name).toBeGreaterThan(0);
      expect(tool.description.length, name).toBeGreaterThan(20);
      expect(tool.parameters, name).toMatchObject({
        type: "object",
        properties: expect.any(Object),
        required: expect.any(Array),
      });
      const properties = Object.keys(tool.parameters.properties as object);
      for (const field of tool.parameters.required as string[]) expect(properties).toContain(field);
    }
    expect(Object.keys(toolNamed(pi, "haril_verdict").parameters.properties as object)).toEqual([
      "approved",
      "reasons",
    ]);
  });

  it("offers each child's model as an optional field a parent may propose (3.11)", async () => {
    const { pi } = await loadWithPipe(DELEGATION_TOOLS.join(","));
    for (const [tool, list] of [
      ["haril_delegate", "delegations"],
      ["haril_assign", "assignments"],
    ] as const) {
      const items = (
        toolNamed(pi, tool).parameters.properties as Record<
          string,
          { items: { properties: Record<string, { type: string }>; required: string[] } }
        >
      )[list]?.items;
      expect(items?.properties.model?.type, tool).toBe("string");
      expect(items?.required, tool).not.toContain("model");
    }
  });

  it("sends each delegation tool's arguments to the host as delegation.call and returns the typed reply", async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      haril_delegate: { schemaVersion: 1, memo: "m", delegations: [{ localId: "part-1" }] },
      haril_assign: { schemaVersion: 1, memo: "m", assignments: [{ localId: "step-1" }] },
      haril_report: { status: "done", summary: "read both notes", issues: [] },
      haril_verdict: { approved: true, reasons: [{ criterion: "c", ok: true, evidence: "e" }] },
      haril_request_audit: { summary: "all done", outstanding: [] },
      haril_abort: { reason: "nothing to do" },
    };
    const { pi, fake } = await loadWithPipe(DELEGATION_TOOLS.join(","));
    fake.respond((op) => ({
      ok: true,
      content: `accepted ${String(op.tool)}`,
      reply: { ok: true, tool: op.tool },
    }));
    for (const name of DELEGATION_TOOLS) {
      const result = await toolNamed(pi, name).execute(`call-${name}`, inputs[name] ?? {});
      expect(result, name).toEqual({
        content: [{ type: "text", text: `accepted ${name}` }],
        details: { reply: { ok: true, tool: name } },
      });
    }
    expect(fake.ops.map((op) => [op.op, op.tool])).toEqual(
      DELEGATION_TOOLS.map((name) => ["delegation.call", name]),
    );
    expect(fake.ops.map((op) => op.input)).toEqual(DELEGATION_TOOLS.map((name) => inputs[name]));
  });

  it("maps a refused delegation call to an error result with the host's reason, so the model can fix it", async () => {
    const { pi, fake } = await loadWithPipe("read,haril_report");
    fake.respond(() => ({
      ok: false,
      error: "haril_report input: /status: must be done, partial or failed",
      reply: { ok: false, reason: "haril_report input: /status: must be done, partial or failed" },
    }));
    const result = await toolNamed(pi, "haril_report").execute("call-r", { status: "finished" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "refused: haril_report input: /status: must be done, partial or failed",
    );
    expect(result.details).toEqual({
      reply: { ok: false, reason: "haril_report input: /status: must be done, partial or failed" },
    });
  });

  it("throws when the pipe cannot be reached, so Pi fails to load the extension", async () => {
    setEnv(`${join(tmp, "missing-pipe.sock")}#${TOKEN}`);
    await expect(bridge(fakePi())).rejects.toThrow();
  });

  it("throws when the bridge environment is incomplete", async () => {
    setEnv(`${join(tmp, "x.sock")}#${TOKEN}`);
    delete process.env.HARIL_BRIDGE;
    await expect(bridge(fakePi())).rejects.toThrow();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
