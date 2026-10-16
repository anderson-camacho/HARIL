import type { IncomingMessage } from "node:http";
import type { UpstreamMessage } from "./types.js";

// Parsing and request guards of the Broker: the body limit, the bearer token, the chat body and the route grant.

const MAX_BODY_BYTES = 1024 * 1024;
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;
const ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant"]);
const UPSTREAM_CODE = /^[a-z_]{1,40}$/;

export interface ChatInput {
  readonly model: string;
  readonly messages: readonly UpstreamMessage[];
  readonly stream: boolean;
  readonly maxTokens: number | undefined;
}

export type ParsedChat =
  | { readonly ok: true; readonly input: ChatInput }
  | { readonly ok: false; readonly reason: string };

// What a virtual key may do, as stored with it (the store keeps it as opaque JSON).
export interface RouteGrant {
  readonly models: readonly string[];
  readonly maxTokensPerRequest: number;
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRole(value: unknown): value is UpstreamMessage["role"] {
  return typeof value === "string" && ROLES.has(value);
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

// Only the fields HARIL knows reach the upstream (GWY-14): everything else in the body is dropped.
export function parseChat(text: string): ParsedChat {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  if (!isRecord(body)) return { ok: false, reason: "body must be a JSON object" };
  const { model, messages, stream, max_tokens: maxTokens } = body;
  if (typeof model !== "string" || model.length === 0) {
    return { ok: false, reason: "model is required" };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, reason: "messages is required" };
  }
  const parsed: UpstreamMessage[] = [];
  for (const item of messages) {
    if (!isRecord(item) || !isRole(item.role) || typeof item.content !== "string") {
      return {
        ok: false,
        reason: "messages must be {role: system|user|assistant, content: string}",
      };
    }
    parsed.push({ role: item.role, content: item.content });
  }
  if (stream !== undefined && typeof stream !== "boolean") {
    return { ok: false, reason: "stream must be a boolean" };
  }
  if (
    maxTokens !== undefined &&
    !(typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= 1)
  ) {
    return { ok: false, reason: "max_tokens must be a positive integer" };
  }
  return {
    ok: true,
    input: {
      model,
      messages: parsed,
      stream: stream === true,
      maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
    },
  };
}

export function parseGrant(value: unknown): RouteGrant | undefined {
  if (!isRecord(value)) return undefined;
  const { models, maxTokensPerRequest, runId, taskId, projectId } = value;
  if (!Array.isArray(models) || !models.every((model) => typeof model === "string")) {
    return undefined;
  }
  if (
    typeof maxTokensPerRequest !== "number" ||
    typeof runId !== "string" ||
    typeof taskId !== "string" ||
    typeof projectId !== "string"
  ) {
    return undefined;
  }
  return { models: models as string[], maxTokensPerRequest, runId, taskId, projectId };
}

// An upstream error code is echoed only when it is a plain word; any other text is replaced (no leaks).
export function upstreamCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && UPSTREAM_CODE.test(code) ? code : "unknown";
}
