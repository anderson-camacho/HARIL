// Minimal AgentRuntime port for M1 (agent-runtime contract, ARCH 5.1). The real adapter (Pi) arrives in M2.
import type { TaskKind } from "@haril/contracts";
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
}

export interface AgentHello {
  readonly tools: readonly string[];
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
    }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "timed_out" }
  | { readonly status: "aborted" };

export interface AgentHandle {
  readonly runId: string;
  // Handshake: the tool list the agent announces. A prompt is accepted only if it equals allowedTools.
  readonly hello: Promise<AgentHello>;
  readonly settled: Promise<AgentOutcome>;
  prompt(text: string): Promise<Result<void, HarilError>>;
  abort(): Promise<void>;
  // Idempotent. Settles the run as aborted if it has not settled yet.
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>>;
}
