// Minimal AgentRuntime port for M1 (agent-runtime contract, ARCH 5.1). The real adapter (Pi) arrives in M2.
import type { TaskKind } from "@haril/contracts";
import type { DelegationTurnInput } from "./delegation-channel.js";
import type { BootStart } from "./process-control.js";
import type { HarilError, Result } from "./result.js";

// The host side of haril_propose_plan (LD-T4, ARCH 9.4). An agent runtime calls it with the run it serves and the
// untrusted plan; the host checks the plan with the plan.submit rules and records it as a requested approval. `created`
// is false when the same plan already waits for a decision in the project: that approval is returned. The runtime never
// reaches the store itself.
export interface PlanProposalContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
}

export type PlanProposalResult =
  | { readonly ok: true; readonly approvalId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: string };

export type PlanProposer = (context: PlanProposalContext, plan: unknown) => PlanProposalResult;

export interface AgentSpec {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  // Selects the simulated behaviour in FakeAgentRuntime (M1-D7); opaque to the Core.
  readonly agentRef: string;
  readonly allowedTools: readonly string[];
  // Task prompt, kept for the record; the work starts when AgentHandle.prompt is accepted.
  readonly prompt: string;
  readonly timeoutMs: number;
  // Real agents (M2-T6): the owning project, the model the task asked for and its token ceiling.
  readonly projectId?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  // The kind of the task (LD-T4). A plan task is answered by proposing a plan through haril_propose_plan.
  readonly kind?: TaskKind;
  // A turn of a workflow (3.4): what the host told it, as data. Its prompt carries the same, rendered.
  readonly delegation?: DelegationTurnInput;
}

export interface AgentHello {
  readonly tools: readonly string[];
}

// What the gateway answered when a model call of the attempt failed (docs/modos-y-delegacion.md 3.11, phase F6), as the
// Broker saw it: quota (HTTP 402: the provider's quota, never HARIL's own token budget), rate_limited (HTTP 429),
// transient (a 5xx, a timeout or a broken stream) or fatal (any other refusal). The runtime turns quota and rate_limited
// into a cooldown of the model, and retries a workflow turn once.
export interface ProviderFailure {
  readonly kind: "quota" | "rate_limited" | "transient" | "fatal";
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  // The model reference the failed call asked for, when known.
  readonly model: string | null;
}

export type AgentOutcome =
  // `simulated` marks a run of a non-fake agentRef, which M1 completes without a real agent (M1-D7).
  | {
      readonly status: "succeeded";
      readonly summary: string;
      readonly simulated?: true;
      // Real agents (M2-T6): the requested model and the adapter warnings, kept in the run result.
      readonly model?: string;
      readonly warnings?: readonly string[];
      // Tokens the run reported itself (a fake agent); a real agent's come from the Broker's ledger. null: not reported.
      readonly usage?: { readonly tokensIn: number | null; readonly tokensOut: number | null };
    }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
      // Set when the failure came from the gateway's answer to a model call.
      readonly provider?: ProviderFailure;
    }
  | { readonly status: "timed_out" }
  | { readonly status: "aborted" };

// The operating-system process that serves an attempt (docs/modos-y-delegacion.md 3.14): its pid and the wall-clock
// time it was started, taken right after the spawn. The runtime records both on the run, so the startup sweep and the
// emergency stop kill a process only while its pid still names the same process (a reused pid has a later start). On
// Linux it also carries the process's boot ticks, which no wall-clock step changes (process-control.ts).
export interface AgentProcess {
  readonly pid: number;
  readonly startedAt: number;
  readonly boot?: BootStart;
}

export interface AgentHandle {
  readonly runId: string;
  // Handshake: the tool list the agent announces. A prompt is accepted only if it equals allowedTools.
  readonly hello: Promise<AgentHello>;
  readonly settled: Promise<AgentOutcome>;
  // The process serving the run once it started; absent for an agent with no process of its own (the simulated ones).
  readonly process?: AgentProcess;
  prompt(text: string): Promise<Result<void, HarilError>>;
  abort(): Promise<void>;
  // Ends the run at once (3.14): the process tree is killed without the abort's grace period, and the run settles as
  // aborted. Resolves once the process is gone. An agent without it is ended with abort().
  kill?(): Promise<void>;
  // Idempotent. Settles the run as aborted if it has not settled yet.
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>>;
}
