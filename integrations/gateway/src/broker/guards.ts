import type { IncomingMessage } from "node:http";
import type { UpstreamBody } from "./types.js";

// Parsing and request guards of the Broker: the body limit, the bearer token, the chat body and the route grant.

const MAX_BODY_BYTES = 1024 * 1024;
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;
const UPSTREAM_CODE = /^[a-z_]{1,40}$/;

// The fields the Broker forwards unchanged (GWY-14). Everything else in the body is dropped. The Broker itself
// reads model, messages, stream and the max-token fields, and decides max_tokens; the rest reaches the upstream as sent.
const PASS_THROUGH_FIELDS: readonly string[] = [
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "stop",
  "seed",
  "response_format",
  "stream_options",
  "reasoning_effort",
];

export interface ChatInput {
  readonly model: string;
  // Any roles, including tool and assistant tool_calls: forwarded verbatim.
  readonly messages: readonly unknown[];
  readonly stream: boolean;
  // The client's own cap (max_tokens or max_completion_tokens); the Broker decides the value it forwards.
  readonly maxTokens: number | undefined;
  // The allowlisted pass-through fields, as the client sent them.
  readonly fields: Readonly<Record<string, unknown>>;
}

export type ParsedChat =
  | { readonly ok: true; readonly input: ChatInput }
  | { readonly ok: false; readonly reason: string };

// What a virtual key may do, as stored with it (the store keeps it as opaque JSON).
export interface RouteGrant {
  readonly providerId: string;
  readonly models: readonly string[];
  readonly maxTokensPerRequest: number;
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// The whole body, or null when it is over the limit. Over-limit bytes are drained, not buffered.
export function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    request.on("close", () => resolve(null));
    request.on("error", reject);
  });
}

export function bearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : BEARER.exec(header)?.[1];
}

export function parseChat(text: string): ParsedChat {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  if (!isRecord(body)) return { ok: false, reason: "body must be a JSON object" };
  const { model, messages, stream } = body;
  if (typeof model !== "string" || model.length === 0) {
    return { ok: false, reason: "model is required" };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: "messages is required" };
  }
  for (const item of messages) {
    if (!isRecord(item) || typeof item.role !== "string" || item.role.length === 0) {
      return { ok: false, reason: "messages must be objects with a role" };
    }
  }
  if (stream !== undefined && typeof stream !== "boolean") {
    return { ok: false, reason: "stream must be a boolean" };
  }
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const value = body[field];
    if (value !== undefined && !isPositiveInteger(value)) {
      return { ok: false, reason: `${field} must be a positive integer` };
    }
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    return { ok: false, reason: "tools must be an array" };
  }
  if (body.stream_options !== undefined && !isRecord(body.stream_options)) {
    return { ok: false, reason: "stream_options must be an object" };
  }
  const fields: Record<string, unknown> = {};
  for (const field of PASS_THROUGH_FIELDS) {
    if (body[field] !== undefined) fields[field] = body[field];
  }
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  return {
    ok: true,
    input: {
      model,
      messages,
      stream: stream === true,
      maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
      fields,
    },
  };
}

// The body the upstream receives: the allowlisted fields verbatim, the Broker's max_tokens, and include_usage
// on every stream (stream_options is sent only with a stream, as the OpenAI API requires).
export function upstreamBody(input: ChatInput, maxTokens: number): UpstreamBody {
  const { stream_options: streamOptions, ...fields } = input.fields;
  return {
    ...fields,
    model: input.model,
    messages: input.messages,
    max_tokens: maxTokens,
    stream: input.stream,
    ...(input.stream
      ? {
          stream_options: {
            ...(isRecord(streamOptions) ? streamOptions : {}),
            include_usage: true,
          },
        }
      : {}),
  };
}

export function parseGrant(value: unknown): RouteGrant | undefined {
  if (!isRecord(value)) return undefined;
  const { providerId, models, maxTokensPerRequest, runId, taskId, projectId } = value;
  if (!Array.isArray(models) || !models.every((model) => typeof model === "string")) {
    return undefined;
  }
  if (
    typeof providerId !== "string" ||
    typeof maxTokensPerRequest !== "number" ||
    typeof runId !== "string" ||
    typeof taskId !== "string" ||
    typeof projectId !== "string"
  ) {
    return undefined;
  }
  return {
    providerId,
    models: models as string[],
    maxTokensPerRequest,
    runId,
    taskId,
    projectId,
  };
}

// An upstream error code is echoed only when it is a plain word; any other text is replaced (no leaks).
export function upstreamCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && UPSTREAM_CODE.test(code) ? code : "unknown";
}
