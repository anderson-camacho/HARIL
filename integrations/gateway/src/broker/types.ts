import type { Usage } from "@haril/contracts";
import type { BudgetsPort, Clock, VirtualKeysPort } from "@haril/core/ports";

// Public types of the Broker (ADR-0005 BR-1..BR-14, M2-D7). The Broker never imports providers/ (R9): the
// composition root hands it an UpstreamClient, normally the OpenAI-compatible adapter, whose shapes match.

export interface UpstreamMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface UpstreamRequest {
  readonly model: string;
  readonly messages: readonly UpstreamMessage[];
  // Already capped by the Broker (BR-6): never the value the client sent when it is larger.
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

// Text deltas as they arrive, then exactly one done event. usage is null when the upstream sent none.
export type UpstreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "done"; readonly usage: Usage | null; readonly finishReason: string | null };

export interface UpstreamClient {
  chat(request: UpstreamRequest): AsyncIterable<UpstreamEvent>;
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

export interface BrokerOptions {
  readonly resolveUpstream: UpstreamResolver;
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
