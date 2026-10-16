// HARIL bridge: a Pi extension loaded with `-e` (ADR-0004 decision 5, ARCHITECTURE 9.4). It sends the
// handshake `hello` over the run's pipe, registers the `haril` provider and the `read` tool, and forwards
// every tool operation to the Runtime, which decides. Self-contained: node:* imports and local types only
// (R6), so it bundles into one file. The Pi ExtensionAPI shapes below are UNVERIFIED against Pi 1.2.0.

import { connect, type Socket } from "node:net";

export const BRIDGE_VERSION = "0.1.0";

// Declared locally: the real types come from Pi's ExtensionAPI, which is not installed here (UNVERIFIED).
export interface ProviderModel {
  readonly id: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: { readonly input: number; readonly output: number };
}

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly api: "openai-completions";
  readonly apiKey: string;
  readonly models: readonly ProviderModel[];
}

export interface BridgeToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

export interface BridgeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(toolCallId: string, params: { readonly path?: unknown }): Promise<BridgeToolResult>;
}

export interface BridgePiApi {
  registerProvider(name: string, config: ProviderConfig): void;
  registerTool(tool: BridgeToolDefinition): void;
}

// UNVERIFIED placeholders until the route grant carries the real limits for the model.
const CONTEXT_WINDOW = 128_000;
const MAX_TOKENS = 4_096;

const BRIDGE_ENV = "HARIL_BRIDGE";
const TOOLS_ENV = "HARIL_TOOLS";
const VKEY_ENV = "HARIL_VKEY";
const LF = "\n";

interface Channel {
  send(message: Record<string, unknown>): void;
  request(message: { id: string } & Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface PendingReply {
  resolve(reply: Record<string, unknown>): void;
  reject(error: Error): void;
}

export default async function harilBridge(pi: BridgePiApi): Promise<void> {
  // Read and remove the handshake secrets before anything else can see them.
  const bridgeValue = process.env[BRIDGE_ENV];
  const toolsValue = process.env[TOOLS_ENV];
  const vkey = process.env[VKEY_ENV];
  delete process.env[BRIDGE_ENV];
  delete process.env[TOOLS_ENV];
  delete process.env[VKEY_ENV];

  const runId = process.env.HARIL_RUN_ID;
  const brokerUrl = process.env.HARIL_BROKER_URL;
  const model = process.env.HARIL_MODEL;
  if (!bridgeValue || !toolsValue || !vkey || !runId || !brokerUrl || !model) {
    throw new Error("haril bridge: the run environment is incomplete");
  }

  const split = bridgeValue.lastIndexOf("#");
  if (split <= 0) throw new Error("haril bridge: HARIL_BRIDGE has no token");
  const pipePath = bridgeValue.slice(0, split);
  const token = bridgeValue.slice(split + 1);
  const tools = toolsValue.split(",").filter((name) => name !== "");

  // A failed connection throws, so Pi fails to load the extension (fail closed).
  const channel = await openChannel(pipePath);
  channel.send({ type: "hello", runId, token, tools, bridgeVersion: BRIDGE_VERSION });

  pi.registerProvider("haril", {
    baseUrl: brokerUrl,
    api: "openai-completions",
    apiKey: vkey,
    models: [
      {
        id: model,
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
        cost: { input: 0, output: 0 },
      },
    ],
  });

  let sequence = 0;
  pi.registerTool({
    name: "read",
    description: "Read a UTF-8 text file inside the project. The runtime decides what may be read.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute(_toolCallId, params) {
      const path = typeof params.path === "string" ? params.path : "";
      const reply = await channel.request({ id: `op-${++sequence}`, op: "read", path });
      if (reply.ok === true && typeof reply.content === "string") {
        return { content: [{ type: "text", text: reply.content }] };
      }
      const error = typeof reply.error === "string" ? reply.error : "denied";
      return { content: [{ type: "text", text: `denied: ${error}` }], isError: true };
    },
  });
}

function openChannel(pipePath: string): Promise<Channel> {
  return new Promise<Channel>((resolve, reject) => {
    const socket: Socket = connect(pipePath);
    const waiting = new Map<string, PendingReply>();
    let connected = false;
    let closed = false;
    let buffer = "";

    const closeChannel = (reason: string) => {
      if (closed) return;
      closed = true;
      for (const pending of waiting.values()) pending.reject(new Error(reason));
      waiting.clear();
    };

    socket.once("error", (error) => {
      if (!connected) reject(error);
      closeChannel("haril bridge: the channel failed");
    });
    socket.on("close", () => closeChannel("haril bridge: the channel is closed"));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let lf = buffer.indexOf(LF);
      while (lf !== -1) {
        const line = buffer.slice(0, lf).replace(/\r$/, "");
        buffer = buffer.slice(lf + 1);
        lf = buffer.indexOf(LF);
        if (line === "") continue;
        const reply = parseReply(line);
        if (reply === undefined || typeof reply.id !== "string") continue;
        const pending = waiting.get(reply.id);
        waiting.delete(reply.id);
        pending?.resolve(reply);
      }
    });

    socket.once("connect", () => {
      connected = true;
      resolve({
        send(message) {
          if (!closed) socket.write(`${JSON.stringify(message)}${LF}`);
        },
        request(message) {
          return new Promise<Record<string, unknown>>((done, fail) => {
            if (closed) {
              fail(new Error("haril bridge: the channel is closed"));
              return;
            }
            waiting.set(message.id, { resolve: done, reject: fail });
            socket.write(`${JSON.stringify(message)}${LF}`);
          });
        },
      });
    });
  });
}

function parseReply(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
