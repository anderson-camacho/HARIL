import type { ModelDescriptor, Usage } from "@haril/contracts";
import type { UpstreamBody, UpstreamChunk } from "../broker/types.js";
import { ProviderError } from "./errors.js";
import { createSseParser, type SseEvent } from "./sse.js";

// OpenAI-compatible adapter (model-provider.md; MODEL_ROUTING 3.3). One client per connection. It never
// retries and never keeps a body: each call is one request that the caller accounts for.

const PROVIDER_ID = "openai-compatible";
const DETAIL_LIMIT = 200;
const RETRY_AFTER_SECONDS = /^\d+$/;

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

// Text deltas as they arrive, then exactly one done event. usage is null when the upstream sent no usage.
export type ChatEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "done"; readonly usage: Usage | null; readonly finishReason: string | null };

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  // Omitted means no Authorization header (used by the doctor probe to tell "key not set" apart).
  readonly apiKey?: string | undefined;
  // Connect/first-byte timeout for a request; for a stream, the maximum silence between two reads.
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

export interface OpenAiCompatibleClient {
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  // The chat completions body as sent (stream true: one chunk per SSE event; false: one chunk, the reply).
  chatRaw(body: UpstreamBody, signal?: AbortSignal): AsyncGenerator<UpstreamChunk, void, undefined>;
  // The text-only view of chatRaw: text deltas, then one done event.
  chat(request: ChatRequest): AsyncGenerator<ChatEvent, void, undefined>;
}

interface Deadline {
  readonly signal: AbortSignal;
  touch(): void;
  dispose(): void;
  timedOut(): boolean;
  callerAborted(): boolean;
}

function openDeadline(timeoutMs: number, parent: AbortSignal | undefined): Deadline {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const onParentAbort = (): void => controller.abort();
  if (parent?.aborted === true) controller.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
    timedOut: () => timedOut,
    callerAborted: () => parent?.aborted === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// A key echoed back by the upstream must not reach an error message, a log or the output.
function redact(text: string, key: string | undefined): string {
  return key === undefined ? text : text.split(key).join("[redacted]");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (RETRY_AFTER_SECONDS.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function toUsage(raw: Record<string, unknown>): Usage {
  const promptDetails = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completionDetails = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : {};
  return {
    schemaVersion: 1,
    inputTokens: count(raw.prompt_tokens),
    outputTokens: count(raw.completion_tokens),
    cachedInputTokens: count(promptDetails.cached_tokens),
    reasoningTokens: count(completionDetails.reasoning_tokens),
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// The bytes of one message or delta that the in-flight guard counts: content, and each tool call's name and arguments.
function outputBytesOf(part: Record<string, unknown>): number {
  let bytes = typeof part.content === "string" ? byteLength(part.content) : 0;
  if (Array.isArray(part.tool_calls)) {
    for (const call of part.tool_calls as unknown[]) {
      const fn = isRecord(call) && isRecord(call.function) ? call.function : undefined;
      if (fn === undefined) continue;
      if (typeof fn.name === "string") bytes += byteLength(fn.name);
      if (typeof fn.arguments === "string") bytes += byteLength(fn.arguments);
    }
  }
  return bytes;
}

// The parsed view of one upstream object. An error object is reported as the chunk's error; the caller stops there.
function toChunk(json: Record<string, unknown>, key: string | undefined): UpstreamChunk {
  if (json.error !== undefined && json.error !== null) {
    const raw = isRecord(json.error) ? json.error.message : json.error;
    const detail = typeof raw === "string" ? raw : "gateway reported an error in the stream";
    return {
      json,
      outputBytes: 0,
      usage: null,
      finishReason: null,
      error: redact(`stream error: ${detail}`, key),
    };
  }
  const choices: unknown[] = Array.isArray(json.choices) ? json.choices : [];
  let outputBytes = 0;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const part = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : undefined;
    if (part !== undefined) outputBytes += outputBytesOf(part);
  }
  const first = choices[0];
  const finishReason =
    isRecord(first) && typeof first.finish_reason === "string" ? first.finish_reason : null;
  return {
    json,
    outputBytes,
    usage: isRecord(json.usage) ? toUsage(json.usage) : null,
    finishReason,
    error: null,
  };
}

// The text delta of a streamed chunk, for the text-only view.
function textOf(json: Record<string, unknown>): string | undefined {
  const first: unknown = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const delta = isRecord(first) && isRecord(first.delta) ? first.delta.content : undefined;
  return typeof delta === "string" ? delta : undefined;
}

// One `data:` payload of a chat stream. A payload that is not an object is fatal: the stream is not trusted past it.
function parseEvent(data: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new ProviderError("upstream_stream_error", "stream event is not valid JSON");
  }
  if (!isRecord(payload)) {
    throw new ProviderError("upstream_stream_error", "stream event is not an object");
  }
  return payload;
}

function parseModels(body: unknown): ModelDescriptor[] {
  if (!isRecord(body) || !Array.isArray(body.data)) {
    throw new ProviderError("upstream", "gateway returned an unexpected model list");
  }
  const byId = new Map<string, ModelDescriptor>();
  for (const item of body.data) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) continue;
    if (byId.has(item.id)) continue;
    const descriptor: ModelDescriptor = { providerId: PROVIDER_ID, id: item.id };
    const contextWindow = count(item.context_length);
    if (contextWindow !== null && contextWindow > 0) descriptor.contextWindow = contextWindow;
    const maxOutputTokens = count(item.max_output_tokens);
    if (maxOutputTokens !== null && maxOutputTokens > 0)
      descriptor.maxOutputTokens = maxOutputTokens;
    byId.set(item.id, descriptor);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function createOpenAiCompatibleClient(
  options: OpenAiCompatibleOptions,
): OpenAiCompatibleClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const origin = new URL(options.baseUrl).origin;
  const key =
    options.apiKey !== undefined && options.apiKey.length > 0 ? options.apiKey : undefined;
  const timeoutMs = options.timeoutMs;
  const fetchImpl = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));

  const headers = (extra: Record<string, string>): Record<string, string> =>
    key === undefined ? extra : { ...extra, authorization: `Bearer ${key}` };

  function transportError(error: unknown, deadline: Deadline, phase: "connect" | "body"): unknown {
    if (deadline.callerAborted()) return error;
    if (deadline.timedOut()) {
      return new ProviderError(
        "unreachable",
        `gateway timed out after ${timeoutMs} ms (${origin})`,
      );
    }
    if (phase === "connect")
      return new ProviderError("unreachable", `gateway unreachable at ${origin}`);
    return new ProviderError("upstream_stream_error", "stream interrupted before completion");
  }

  async function send(url: string, init: RequestInit, deadline: Deadline): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: deadline.signal });
    } catch (error) {
      throw transportError(error, deadline, "connect");
    }
  }

  async function errorDetail(response: Response): Promise<string | undefined> {
    try {
      const body: unknown = JSON.parse(await response.text());
      const error = isRecord(body) ? body.error : undefined;
      const message = isRecord(error) ? error.message : error;
      return typeof message === "string" && message.length > 0
        ? redact(message, key).slice(0, DETAIL_LIMIT)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function httpFailure(response: Response): Promise<ProviderError> {
    const status = response.status;
    if (status === 401 || status === 403) {
      return new ProviderError("auth", `gateway rejected the credentials (HTTP ${status})`, {
        httpStatus: status,
      });
    }
    const detail = await errorDetail(response);
    const suffix = detail === undefined ? "" : `: ${detail}`;
    if (status === 402) {
      return new ProviderError("quota", `gateway quota exhausted (HTTP 402)${suffix}`, {
        httpStatus: status,
      });
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      return new ProviderError("rate_limited", `gateway rate limit (HTTP 429)${suffix}`, {
        httpStatus: status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }
    return new ProviderError("upstream", `gateway returned HTTP ${status}${suffix}`, {
      httpStatus: status,
    });
  }

  async function readJson(response: Response, deadline: Deadline): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch (error) {
      if (deadline.callerAborted() || deadline.timedOut()) {
        throw transportError(error, deadline, "body");
      }
      throw new ProviderError("upstream", "gateway returned a body that is not JSON");
    }
  }

  async function* chatRaw(
    body: UpstreamBody,
    signal?: AbortSignal,
  ): AsyncGenerator<UpstreamChunk, void, undefined> {
    const deadline = openDeadline(timeoutMs, signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const streaming = body.stream === true;
      const response = await send(
        `${base}/chat/completions`,
        {
          method: "POST",
          headers: headers({
            "content-type": "application/json",
            accept: streaming ? "text/event-stream" : "application/json",
          }),
          body: JSON.stringify(body),
        },
        deadline,
      );
      if (!response.ok) throw await httpFailure(response);
      if (!streaming) {
        const json = await readJson(response, deadline);
        if (!isRecord(json)) {
          throw new ProviderError("upstream", "gateway returned an unexpected reply");
        }
        yield toChunk(json, key);
        return;
      }
      if (response.body === null) {
        throw new ProviderError("upstream_stream_error", "gateway sent no stream body");
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      const parser = createSseParser();
      let finishReason: string | null = null;
      let sawDone = false;
      let ended = false;

      while (!sawDone && !ended) {
        deadline.touch();
        let events: SseEvent[];
        try {
          const next = await reader.read();
          if (next.done) {
            ended = true;
            events = parser.push(decoder.decode()).concat(parser.end());
          } else {
            events = parser.push(decoder.decode(next.value, { stream: true }));
          }
        } catch (error) {
          throw transportError(error, deadline, "body");
        }
        for (const event of events) {
          if (event.data === "[DONE]") {
            sawDone = true;
            break;
          }
          const chunk = toChunk(parseEvent(event.data), key);
          yield chunk;
          // An error object ends the stream: nothing after it is trusted.
          if (chunk.error !== null) return;
          if (chunk.finishReason !== null) finishReason = chunk.finishReason;
        }
      }

      if (!sawDone && finishReason === null) {
        throw new ProviderError("upstream_stream_error", "stream ended before completion");
      }
    } finally {
      deadline.dispose();
      if (reader !== undefined) void reader.cancel().catch(() => undefined);
    }
  }

  return {
    async listModels(signal) {
      const deadline = openDeadline(timeoutMs, signal);
      try {
        const response = await send(
          `${base}/models`,
          { method: "GET", headers: headers({ accept: "application/json" }) },
          deadline,
        );
        if (!response.ok) throw await httpFailure(response);
        return parseModels(await readJson(response, deadline));
      } finally {
        deadline.dispose();
      }
    },

    chatRaw,

    async *chat(request) {
      let usage: Usage | null = null;
      let finishReason: string | null = null;
      const stream = chatRaw(
        {
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        request.signal,
      );
      for await (const chunk of stream) {
        if (chunk.error !== null) throw new ProviderError("upstream_stream_error", chunk.error);
        const delta = textOf(chunk.json);
        if (delta !== undefined && delta.length > 0) yield { type: "text", delta };
        if (chunk.usage !== null) usage = chunk.usage;
        if (chunk.finishReason !== null) finishReason = chunk.finishReason;
      }
      yield { type: "done", usage, finishReason };
    },
  };
}
