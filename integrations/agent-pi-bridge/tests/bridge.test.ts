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

function setEnv(bridgeValue: string): void {
  process.env.HARIL_BRIDGE = bridgeValue;
  process.env.HARIL_TOOLS = "read";
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

async function loadWithPipe(): Promise<{ pi: RecordedPi; fake: FakePipe }> {
  const fake = await startFakePipe();
  pipe = fake;
  setEnv(`${fake.path}#${TOKEN}`);
  const pi = fakePi();
  await bridge(pi);
  return { pi, fake };
}

function readTool(pi: RecordedPi): BridgeToolDefinition {
  const tool = pi.tools[0];
  if (tool === undefined) throw new Error("no tool registered");
  return tool;
}

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
