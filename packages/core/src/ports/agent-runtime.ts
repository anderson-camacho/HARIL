// Minimal AgentRuntime port for M1 (agent-runtime contract, ARCH 5.1). The real adapter (Pi) arrives in M2.
import type { HarilError, Result } from "./result.js";

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
}

export interface AgentHello {
  readonly tools: readonly string[];
}

export type AgentOutcome =
  | { readonly status: "succeeded"; readonly summary: string }
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
