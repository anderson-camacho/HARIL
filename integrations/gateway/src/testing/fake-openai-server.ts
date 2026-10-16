import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

// A scripted OpenAI-compatible HTTP server on 127.0.0.1 (node:http, port 0).
// Routes: GET /v1/models and POST /v1/chat/completions. Every request needs `Authorization: Bearer <apiKey>`,
// otherwise the server answers 401; apiKey null is a keyless server that accepts any request (M3-T7). Each request is recorded (method, path, lower-case headers, parsed body)
// so tests can assert the wire shape. Streaming replies follow the script: text chunks, a finish chunk, a
// usage chunk with `choices: []`, then `data: [DONE]`. Scripts can add a mid-stream error object (HTTP 200),
// a delay before each chunk, or a non-200 status with a JSON body.

export interface FakeModel {
  readonly id: string;
  readonly context_length?: number;
  readonly max_output_tokens?: number;
}

export interface FakeUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_tokens_details?: { readonly cached_tokens: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens: number };
}

export interface FakeToolCall {
  readonly id: string;
  readonly name: string;
  // The arguments JSON in order: a stream sends one fragment per chunk, a reply joins them.
  readonly argumentFragments: readonly string[];
}

export interface FakeCompletion {
  // HTTP status of the reply; any value other than 200 sends `body` as JSON and no stream.
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  // One content delta per entry.
  readonly textChunks?: readonly string[];
  // Tool calls after the text: streamed as tool_calls deltas (name first, then the argument fragments), or sent
  // as message.tool_calls when the request has "stream": false. A call makes the default finish "tool_calls".
  readonly toolCalls?: readonly FakeToolCall[];
  // A usage chunk after the finish chunk. Absent or null: the stream carries no usage.
  readonly usage?: FakeUsage | null;
  // finish_reason of the finish chunk; null: no finish chunk. Default "stop".
  readonly finishReason?: string | null;
  // An error object sent after the text chunks, then the stream ends (no finish, usage or [DONE]).
  readonly errorAfterChunks?: { readonly message: string; readonly type?: string };
  // Pause before each chunk, in milliseconds.
  readonly delayMs?: number;
  // Send `data: [DONE]` at the end. Default true.
  readonly done?: boolean;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  // Parsed JSON, or the raw text when the body is not JSON; undefined when empty.
  readonly body: unknown;
}

type CompletionScript = FakeCompletion | ((request: RecordedRequest) => FakeCompletion);

export interface FakeOpenAiOptions {
  // null: keyless; the server checks no Authorization header.
  readonly apiKey: string | null;
  readonly models?: readonly (string | FakeModel)[];
  readonly completion?: CompletionScript;
}

export interface FakeOpenAiServer {
  // Base URL including /v1, for example http://127.0.0.1:41234/v1.
  readonly baseUrl: string;
  // Every request received so far, in order.
  readonly requests: RecordedRequest[];
  clearRequests(): void;
  setModels(models: readonly (string | FakeModel)[]): void;
  setCompletion(completion: CompletionScript): void;
  close(): Promise<void>;
}

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    flat[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (piece: string) => {
      text += piece;
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function modelOf(body: unknown): string {
  if (typeof body === "object" && body !== null && "model" in body) {
    const model = (body as { model: unknown }).model;
    if (typeof model === "string") return model;
  }
  return "fake";
}

function listing(models: readonly (string | FakeModel)[]): unknown {
  return {
    object: "list",
    data: models.map((entry) => {
      const model = typeof entry === "string" ? { id: entry } : entry;
      return {
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "fake",
        ...(model.context_length === undefined ? {} : { context_length: model.context_length }),
        ...(model.max_output_tokens === undefined
          ? {}
          : { max_output_tokens: model.max_output_tokens }),
      };
    }),
  };
}

function chunk(model: string, choices: unknown[]): unknown {
  return { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model, choices };
}

function toolDelta(call: unknown): unknown {
  return { index: 0, delta: { tool_calls: [call] }, finish_reason: null };
}

function finishReasonOf(script: FakeCompletion): string | null {
  if (script.finishReason !== undefined) return script.finishReason;
  return (script.toolCalls ?? []).length > 0 ? "tool_calls" : "stop";
}

// The whole reply of a request with "stream": false: the same script, as one message.
function completionJson(model: string, script: FakeCompletion): unknown {
  const text = (script.textChunks ?? []).join("");
  const calls = script.toolCalls ?? [];
  const message = {
    role: "assistant",
    content: text.length > 0 || calls.length === 0 ? text : null,
    ...(calls.length === 0
      ? {}
      : {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.argumentFragments.join("") },
          })),
        }),
  };
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReasonOf(script) }],
    ...(script.usage === undefined || script.usage === null ? {} : { usage: script.usage }),
  };
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A non-streaming reply: the script's failure status, its mid-stream error as a body, or the whole completion.
function replyJson(
  response: ServerResponse,
  request: RecordedRequest,
  script: FakeCompletion,
): void {
  const status = script.status ?? 200;
  if (status !== 200) {
    sendJson(
      response,
      status,
      script.body ?? { error: { message: "scripted failure" } },
      script.headers,
    );
    return;
  }
  if (script.errorAfterChunks !== undefined) {
    const { message, type } = script.errorAfterChunks;
    sendJson(response, 200, { error: { message, type: type ?? "server_error" } }, script.headers);
    return;
  }
  sendJson(response, 200, completionJson(modelOf(request.body), script), script.headers);
}

// Writes the scripted stream. Stops quietly when the client has gone away.
async function streamCompletion(
  response: ServerResponse,
  request: RecordedRequest,
  script: FakeCompletion,
): Promise<void> {
  const status = script.status ?? 200;
  if (status !== 200) {
    sendJson(
      response,
      status,
      script.body ?? { error: { message: "scripted failure" } },
      script.headers,
    );
    return;
  }
  const model = modelOf(request.body);
  const delayMs = script.delayMs ?? 0;
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...script.headers,
    });
  };
  // Returns false when the client disconnected, so the caller stops.
  const emit = async (payload: string): Promise<boolean> => {
    await pause(delayMs);
    if (response.destroyed) return false;
    start();
    response.write(`data: ${payload}\n\n`);
    return true;
  };

  for (const text of script.textChunks ?? []) {
    const delta = { content: text };
    if (!(await emit(JSON.stringify(chunk(model, [{ index: 0, delta, finish_reason: null }]))))) {
      return;
    }
  }
  if (script.errorAfterChunks !== undefined) {
    const { message, type } = script.errorAfterChunks;
    await emit(JSON.stringify({ error: { message, type: type ?? "server_error" } }));
    if (!response.destroyed) response.end();
    return;
  }
  for (const [index, call] of (script.toolCalls ?? []).entries()) {
    const head = {
      index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: "" },
    };
    if (!(await emit(JSON.stringify(chunk(model, [toolDelta(head)]))))) return;
    for (const fragment of call.argumentFragments) {
      const piece = { index, function: { arguments: fragment } };
      if (!(await emit(JSON.stringify(chunk(model, [toolDelta(piece)]))))) return;
    }
  }
  const finishReason = finishReasonOf(script);
  if (finishReason !== null) {
    const finish = [{ index: 0, delta: {}, finish_reason: finishReason }];
    if (!(await emit(JSON.stringify(chunk(model, finish))))) return;
  }
  if (script.usage !== undefined && script.usage !== null) {
    const usageChunk = { ...(chunk(model, []) as object), usage: script.usage };
    if (!(await emit(JSON.stringify(usageChunk)))) return;
  }
  if (script.done !== false && !(await emit("[DONE]"))) return;
  start();
  if (!response.destroyed) response.end();
}

export async function startFakeOpenAiServer(options: FakeOpenAiOptions): Promise<FakeOpenAiServer> {
  const requests: RecordedRequest[] = [];
  let models: readonly (string | FakeModel)[] = options.models ?? [];
  let completion: CompletionScript = options.completion ?? {};
  const expectedAuthorization = options.apiKey === null ? null : `Bearer ${options.apiKey}`;

  async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const text = await readBody(incoming);
    const record: RecordedRequest = {
      method: incoming.method ?? "",
      path: new URL(incoming.url ?? "/", "http://fake.local").pathname,
      headers: flattenHeaders(incoming.headers),
      body: parseBody(text),
    };
    requests.push(record);

    if (expectedAuthorization !== null && record.headers.authorization !== expectedAuthorization) {
      sendJson(response, 401, {
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      });
      return;
    }
    if (record.method === "GET" && record.path === MODELS_PATH) {
      sendJson(response, 200, listing(models));
      return;
    }
    if (record.method === "POST" && record.path === CHAT_PATH) {
      const script = typeof completion === "function" ? completion(record) : completion;
      if (isRecord(record.body) && record.body.stream === false) {
        replyJson(response, record, script);
      } else {
        await streamCompletion(response, record, script);
      }
      return;
    }
    sendJson(response, 404, { error: { message: `no route for ${record.method} ${record.path}` } });
  }

  const server = createServer((incoming, response) => {
    handle(incoming, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: { message: "fake failure" } });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    clearRequests() {
      requests.length = 0;
    },
    setModels(next) {
      models = next;
    },
    setCompletion(next) {
      completion = next;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
