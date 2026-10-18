import type { Usage } from "@haril/contracts";
import type { BudgetsPort, Clock, VirtualKeysPort } from "@haril/core/ports";

// Public types of the Broker (ADR-0005 BR-1..BR-14, M2-D7). The Broker never imports providers/ (R9): the
// composition root hands it an UpstreamClient, normally the OpenAI-compatible adapter, whose shapes match.

// The chat completions body as the Broker forwards it (the allowlisted fields only, with max_tokens decided by the
// Broker). Messages and tools are opaque to the Broker: any role, any tool_calls, passed through verbatim.
export interface UpstreamBody {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly max_tokens: number;
  readonly stream: boolean;
  readonly [field: string]: unknown;
}

// One upstream event: the raw JSON object of an SSE event when streaming, or the whole reply when not. The
// Broker re-emits json unchanged; the parsed fields are the view it needs for the guard and the ledger.
export interface UpstreamChunk {
  readonly json: Readonly<Record<string, unknown>>;
  // Bytes the in-flight guard counts: content, and each tool call's name and arguments.
  readonly outputBytes: number;
  readonly usage: Usage | null;
  readonly finishReason: string | null;
  // Set when the upstream reported an error in the body; such a chunk is never forwarded to the client.
  readonly error: string | null;
}

export interface UpstreamClient {
  chatRaw(body: UpstreamBody, signal?: AbortSignal): AsyncIterable<UpstreamChunk>;
}

// Chooses the upstream of a run from the provider its virtual key was issued for (M3-T7). The composition root
// builds it; the Broker never names a provider or a URL itself.
export type UpstreamResolver = (providerId: string) => UpstreamClient;

// The store facets the Broker uses: the budget ledger and virtual keys (injected, never imported).
export interface BrokerLedger {
  readonly budgets: BudgetsPort;
  readonly virtualKeys: VirtualKeysPort;
}

export interface IssueKeyInput {
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
  // The provider the key is routed to; the resolver picks the upstream from it.
  readonly providerId: string;
  readonly models: readonly string[];
  readonly maxTokensPerRequest: number;
  readonly budgetIds: readonly string[];
  readonly ttlMs: number;
}

// An upstream call that failed (3.11, phase F6): the run, the route "<provider>/<model>", the adapter's error code
// (quota for an HTTP 402, rate_limited for a 429, upstream, unreachable, upstream_stream_error...), the HTTP status and
// the Retry-After wait when the upstream sent them. The Broker's own refusals (its token budget, a model not granted)
// are never reported: they are not the provider's.
export interface UpstreamFailure {
  readonly runId: string;
  readonly taskId: string;
  readonly providerId: string;
  readonly model: string;
  readonly code: string;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
}

export interface BrokerOptions {
  readonly resolveUpstream: UpstreamResolver;
  // Hears each failed upstream call; the runtime turns a 402 or 429 into a cooldown of the model. Never throws back.
  readonly onUpstreamFailure?: (failure: UpstreamFailure) => void;
  readonly ledger: BrokerLedger;
  readonly clock: Clock;
  // Loopback only (GWY-01): the literal type keeps any other address out of the signature.
  readonly host: "127.0.0.1";
  // 0 asks the system for an ephemeral port.
  readonly port: number;
}

export interface Broker {
  // OpenAI-compatible base URL, for example http://127.0.0.1:41234/v1.
  readonly url: string;
  // Returns the plaintext key once; only its SHA-256 hash is stored.
  issueKey(input: IssueKeyInput): string;
  // Revokes every key of the run and aborts its requests in flight. Returns how many keys were revoked.
  revokeRun(runId: string): number;
  close(): Promise<void>;
}
