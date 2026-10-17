// One HTTP exchange with a verified `engram serve`, bounded by the call's own deadline (memory.md 4.1 "Plazos"): a
// call in flight is not interrupted by the outbox drain's budget, so the adapter cuts it itself. The Bearer token goes
// on every request but the identity check (it protects only some routes, 06 sec3.2, and a server that has not proven
// it is ours must not see it), a redirect is an error (the adapter never leaves loopback), and a cancelled
// CancelSignal aborts the request at once.
import type { CancelSignal } from "@haril/core/ports";

// A serve the adapter may talk to, as the supervisor (or a test) hands it over.
export interface EngramEndpoint {
  // http://127.0.0.1:<port>; anything else is refused before it is contacted.
  readonly baseUrl: string;
  // ENGRAM_HTTP_TOKEN of this launch; it lives only in the Runtime's memory and the child's environment.
  readonly token: string;
  // The .instance-id of HARIL's data dir: GET /health must answer the same (ADR-0008 D4).
  readonly instanceId: string;
  readonly dataDir: string | null;
}

// The time and the cancellation one port call has, shared by every request it makes.
export interface CallBudget {
  readonly deadlineAt: number;
  readonly signal: CancelSignal | undefined;
}

export interface EngramRequest {
  readonly method: "GET" | "POST" | "DELETE";
  // Already encoded.
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  // JSON-encoded unless it is a string, which is sent as it is (an export file).
  readonly body?: unknown;
  // Without the token: the identity check, before the server has proven it is the serve HARIL launched.
  readonly anonymous?: true;
}

export interface Answer {
  readonly kind: "answer";
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

// No answer: the deadline passed, the caller cancelled, or the connection failed or was dropped.
export interface Lost {
  readonly kind: "lost";
  readonly cause: "timeout" | "cancelled" | "network";
  readonly message: string;
}

export type Exchange = Answer | Lost;

export type FetchFn = typeof globalThis.fetch;

function lost(cause: Lost["cause"], message: string): Lost {
  return { kind: "lost", cause, message };
}

function urlOf(endpoint: EngramEndpoint, request: EngramRequest): URL {
  const url = new URL(request.path, endpoint.baseUrl);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url;
}

function parsed(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function reasonOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return error instanceof Error ? error.message : String(error);
}

// Each request waits at most requestTimeoutMs and never past the call's deadline.
export async function exchange(
  fetchFn: FetchFn,
  endpoint: EngramEndpoint,
  budget: CallBudget,
  requestTimeoutMs: number,
  request: EngramRequest,
): Promise<Exchange> {
  if (budget.signal?.cancelled === true) return lost("cancelled", "the memory call was cancelled");
  const remaining = budget.deadlineAt - Date.now();
  if (remaining <= 0) return lost("timeout", "the memory call ran out of time");
  const controller = new AbortController();
  let stopped: "timeout" | "cancelled" | undefined;
  const timer = setTimeout(
    () => {
      stopped = "timeout";
      controller.abort();
    },
    Math.min(remaining, requestTimeoutMs),
  );
  const unlisten = budget.signal?.onCancel(() => {
    stopped = "cancelled";
    controller.abort();
  });
  const headers: Record<string, string> = { accept: "application/json" };
  if (request.anonymous !== true) headers.authorization = `Bearer ${endpoint.token}`;
  let body: string | undefined;
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
  }
  try {
    const response = await fetchFn(urlOf(endpoint, request), {
      method: request.method,
      headers,
      body,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    return { kind: "answer", status: response.status, body: parsed(text), text };
  } catch (error) {
    if (stopped === "cancelled") return lost("cancelled", "the memory call was cancelled");
    if (stopped === "timeout") return lost("timeout", "the request to engram serve timed out");
    return lost("network", `engram serve could not be reached: ${reasonOf(error)}`);
  } finally {
    clearTimeout(timer);
    unlisten?.();
  }
}
