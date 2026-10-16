import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Usage } from "@haril/contracts";
import { estimateInputTokens, streamedOutputTokens, tokensForBytes } from "./estimate.js";
import {
  bearerToken,
  type ChatInput,
  parseChat,
  parseGrant,
  type RouteGrant,
  readBody,
  upstreamCode,
} from "./guards.js";
import { hashVirtualKey, newVirtualKey } from "./keys.js";
import type { Broker, BrokerOptions, IssueKeyInput } from "./types.js";
import {
  completion,
  contentEvent,
  DONE_EVENT,
  errorBody,
  errorEvent,
  finishEvent,
  type ReplyContext,
  type UsageCounts,
  usageEvent,
} from "./wire.js";

// The OpenAI-compatible Broker (ADR-0005 BR-1..BR-13, M2-D7). It sits between Pi and the upstream: it checks
// the virtual key, reserves the worst case before contacting the upstream, caps max_tokens, cuts a stream at
// the reservation and settles the ledger exactly once per reservation.

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
const HOST = "127.0.0.1";

type Outcome =
  | {
      readonly kind: "done";
      readonly text: string;
      readonly finishReason: string;
      readonly usage: Usage | null;
    }
  | { readonly kind: "cut" }
  | { readonly kind: "failed"; readonly code: string };

export async function startBroker(options: BrokerOptions): Promise<Broker> {
  const { resolveUpstream, ledger, clock } = options;
  const inFlight = new Map<string, Set<AbortController>>();
  const pending = new Set<Promise<void>>();
  let allowedHosts: ReadonlySet<string> = new Set();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHosts.has(request.headers.host ?? "")) {
      sendJson(
        response,
        421,
        errorBody("misdirected_request", "the Host header is not the broker address"),
      );
      return;
    }
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, errorBody("forbidden_origin", "browser origins are not accepted"));
      return;
    }
    const path = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    const token = bearerToken(request.headers.authorization);
    const record =
      token === undefined ? undefined : ledger.virtualKeys.findActiveByHash(hashVirtualKey(token));
    if (record === undefined || clock.now() >= record.expiresAt) {
      sendJson(
        response,
        401,
        errorBody("invalid_api_key", "the key is missing, unknown, revoked or expired"),
      );
      return;
    }
    const grant = parseGrant(record.routeGrant);
    if (grant === undefined) {
      sendJson(response, 500, errorBody("internal_error", "the key carries an invalid grant"));
      return;
    }
    if (request.method === "GET" && path === MODELS_PATH) {
      sendJson(response, 200, {
        object: "list",
        data: grant.models.map((id) => ({ id, object: "model", created: 0, owned_by: "haril" })),
      });
      return;
    }
    if (path !== CHAT_PATH) {
      sendJson(response, 404, errorBody("not_found", "no such route"));
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, errorBody("method_not_allowed", "use POST"));
      return;
    }
    const text = await readBody(request);
    if (text === null) {
      sendJson(response, 413, errorBody("payload_too_large", "the body exceeds 1 MiB"));
      return;
    }
    const parsed = parseChat(text);
    if (!parsed.ok) {
      sendJson(response, 400, errorBody("invalid_request", parsed.reason));
      return;
    }
    if (!grant.models.includes(parsed.input.model)) {
      sendJson(response, 403, errorBody("model_not_granted", "the key does not grant this model"));
      return;
    }
    await chat(response, grant, record.budgetIds, parsed.input);
  }

  // Reserve first, then contact the upstream; the reservation is settled exactly once, before the last bytes.
  async function chat(
    response: ServerResponse,
    grant: RouteGrant,
    budgetIds: readonly string[],
    input: ChatInput,
  ): Promise<void> {
    const inputTokens = estimateInputTokens(input.messages);
    // The ledger records the route as <provider>/<model>: Pi only sees the bare model id (M3-T7).
    const routeId = `${grant.providerId}/${input.model}`;
    const rooms = budgetIds.map((id) => {
      const budget = ledger.budgets.get(id);
      return budget === undefined ? 0 : budget.hardLimit - budget.spent - budget.reserved;
    });
    const available = rooms.length === 0 ? 0 : Math.min(...rooms);
    // BR-6: the broker decides max_tokens; it never exceeds what the client, the grant or the budget allows.
    const maxTokens = Math.min(
      input.maxTokens ?? grant.maxTokensPerRequest,
      grant.maxTokensPerRequest,
      available - inputTokens,
    );
    if (maxTokens < 1) {
      sendJson(response, 402, insufficientQuota("the token budget cannot hold this request"));
      return;
    }
    const reservation = ledger.budgets.reserve({
      budgetIds,
      amount: inputTokens + maxTokens,
      idempotencyKey: `request:${randomUUID()}`,
      runId: grant.runId,
      taskId: grant.taskId,
      routeId,
    });
    if (!reservation.ok) {
      sendJson(
        response,
        402,
        insufficientQuota(`budget ${reservation.budgetId} cannot hold this request`),
      );
      return;
    }

    const controller = new AbortController();
    track(grant.runId, controller);
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const context: ReplyContext = {
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(clock.now() / 1000),
      model: input.model,
    };
    const reserved = inputTokens + maxTokens;
    let started = false;
    const startStream = (): void => {
      if (started) return;
      started = true;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    };
    let bytes = 0;
    let text = "";
    let outcome: Outcome = { kind: "failed", code: "unknown" };
    const iterator = resolveUpstream(grant.providerId)
      .chat({ model: input.model, messages: input.messages, maxTokens, signal: controller.signal })
      [Symbol.asyncIterator]();
    try {
      let next = await iterator.next();
      while (next.done !== true) {
        const event = next.value;
        if (event.type === "done") {
          outcome = {
            kind: "done",
            text,
            finishReason: event.finishReason ?? "stop",
            usage: event.usage,
          };
          break;
        }
        // BR-7: the output counted so far, as an upper bound, may not take the reservation past its amount.
        const nextBytes = bytes + Buffer.byteLength(event.delta, "utf8");
        if (inputTokens + streamedOutputTokens(nextBytes) > reserved) {
          outcome = { kind: "cut" };
          break;
        }
        bytes = nextBytes;
        text += event.delta;
        if (input.stream) {
          startStream();
          response.write(contentEvent(context, event.delta));
        }
        next = await iterator.next();
      }
    } catch (error) {
      outcome = { kind: "failed", code: upstreamCode(error) };
    } finally {
      untrack(grant.runId, controller);
    }
    // Every path returns the upstream stream: a completed reply leaves the generator suspended at its done event,
    // and only return() runs its cleanup (the request deadline and the reader). Without it the timer stays armed
    // and keeps the runtime process alive until the timeout (M2-T6).
    if (outcome.kind === "cut") controller.abort();
    await iterator.return?.(undefined).catch(() => undefined);

    // Settle before the last bytes: a client that reads to the end then sees the final ledger state.
    const usage =
      outcome.kind === "done" && outcome.usage !== null
        ? { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens }
        : null;
    ledger.budgets.commit({
      reservationId: reservation.reservationId,
      usage,
      // The upstream was capped at max_tokens, so real use never exceeds the reservation: bound the estimate by it.
      upperBound: Math.min(reserved, inputTokens + tokensForBytes(bytes)),
      modelRequested: routeId,
      modelServed: null,
    });

    if (outcome.kind === "done") {
      if (input.stream) {
        startStream();
        response.write(finishEvent(context, outcome.finishReason));
        const counts = countsOf(outcome.usage);
        if (counts !== undefined) response.write(usageEvent(context, counts));
        response.end(DONE_EVENT);
      } else {
        sendJson(
          response,
          200,
          completion(context, outcome.text, outcome.finishReason, countsOf(outcome.usage)),
        );
      }
      return;
    }
    if (outcome.kind === "cut") {
      const message = "insufficient_quota: the token budget was reached before the reply ended";
      if (input.stream) {
        startStream();
        response.write(errorEvent("insufficient_quota", message));
        response.end(DONE_EVENT);
      } else {
        sendJson(response, 402, errorBody("insufficient_quota", message));
      }
      return;
    }
    const message = `upstream failed (${outcome.code})`;
    if (input.stream && started) {
      response.write(errorEvent("upstream_error", message));
      response.end(DONE_EVENT);
      return;
    }
    sendJson(
      response,
      outcome.code === "rate_limited" ? 429 : 502,
      errorBody("upstream_error", message),
    );
  }

  function track(runId: string, controller: AbortController): void {
    const set = inFlight.get(runId) ?? new Set<AbortController>();
    set.add(controller);
    inFlight.set(runId, set);
  }

  function untrack(runId: string, controller: AbortController): void {
    const set = inFlight.get(runId);
    if (set === undefined) return;
    set.delete(controller);
    if (set.size === 0) inFlight.delete(runId);
  }

  const server = createServer((request, response) => {
    response.on("error", () => undefined);
    const work: Promise<void> = handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, errorBody("internal_error", "the broker failed"));
    });
    pending.add(work);
    void work.then(() => {
      pending.delete(work);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);

  return {
    url: `http://${HOST}:${port}/v1`,

    issueKey(input: IssueKeyInput): string {
      if (!Number.isInteger(input.maxTokensPerRequest) || input.maxTokensPerRequest < 1) {
        throw new RangeError("maxTokensPerRequest must be a positive integer");
      }
      if (!(input.ttlMs > 0)) throw new RangeError("ttlMs must be positive");
      const key = newVirtualKey();
      ledger.virtualKeys.issue({
        runId: input.runId,
        keyHash: hashVirtualKey(key),
        routeGrant: {
          providerId: input.providerId,
          models: [...input.models],
          maxTokensPerRequest: input.maxTokensPerRequest,
          runId: input.runId,
          taskId: input.taskId,
          projectId: input.projectId,
        },
        budgetIds: [...input.budgetIds],
        expiresAt: clock.now() + input.ttlMs,
      });
      return key;
    },

    revokeRun(runId: string): number {
      const revoked = ledger.virtualKeys.revoke(runId, "run ended");
      for (const controller of inFlight.get(runId) ?? []) controller.abort();
      inFlight.delete(runId);
      return revoked;
    },

    async close(): Promise<void> {
      for (const controllers of inFlight.values()) {
        for (const controller of controllers) controller.abort();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.allSettled([...pending]);
    },
  };
}

function insufficientQuota(detail: string): Record<string, unknown> {
  return errorBody("insufficient_quota", `insufficient_quota: ${detail}`);
}

function countsOf(usage: Usage | null): UsageCounts | undefined {
  if (usage === null || usage.inputTokens === null || usage.outputTokens === null) return undefined;
  return { prompt: usage.inputTokens, completion: usage.outputTokens };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
