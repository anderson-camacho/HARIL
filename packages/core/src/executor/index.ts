// Executor rules (M1-T5): the AgentSpec built from a claimed task, the handshake check that runs
// before any prompt is sent, and the mapping of an agent outcome to the run completion. Pure.
import type { AgentOutcome, AgentSpec, HarilError, Result, RunCompletion } from "../ports/index.js";
import { hasFailedCheck, type Verification, verificationFailureMessage } from "./verification.js";

// M1 gives every agent the same single tool; the real tool policy arrives with Pi (M2).
export const M1_ALLOWED_TOOLS: readonly string[] = ["read"];

// ARCH 7.5: infra_restarts ceiling per task. The fourth orphaning fails the task (M1-T7).
export const MAX_INFRA_RESTARTS = 3;

export interface ExecutableTask {
  readonly taskId: string;
  readonly goal: string;
  readonly description: string;
  readonly agentRef: string;
  readonly timeoutMs: number;
  // Real agents only (M2-T6).
  readonly projectId?: string;
  readonly model?: string | null;
  readonly maxTokens?: number;
}

// Agent references served by a real runtime (Pi through the Broker, M2-D6). Every other reference keeps the
// simulated behaviour of M1.
export const REAL_AGENT_REFS: readonly string[] = ["analyst"];

export function isRealAgent(agentRef: string): boolean {
  return REAL_AGENT_REFS.includes(agentRef);
}

export interface RunIdentity {
  readonly runId: string;
  readonly attempt: number;
}

export function buildAgentSpec(task: ExecutableTask, run: RunIdentity): AgentSpec {
  const prompt = [task.goal, task.description].filter((part) => part.trim() !== "").join("\n\n");
  return {
    runId: run.runId,
    taskId: task.taskId,
    attempt: run.attempt,
    agentRef: task.agentRef,
    allowedTools: [...M1_ALLOWED_TOOLS],
    prompt,
    timeoutMs: task.timeoutMs,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    ...(task.model ? { model: task.model } : {}),
    ...(task.maxTokens === undefined ? {} : { maxTokens: task.maxTokens }),
  };
}

// The announced tool list must equal allowedTools as a set; otherwise the prompt is never sent.
export function checkHandshake(
  allowedTools: readonly string[],
  announced: readonly string[],
): Result<void, HarilError> {
  const expected = [...allowedTools].sort();
  const actual = [...announced].sort();
  const same = expected.length === actual.length && expected.every((tool, i) => tool === actual[i]);
  if (same) return { ok: true, value: undefined };
  return {
    ok: false,
    error: {
      code: "handshake_mismatch",
      message: `agent announced [${actual.join(", ")}]; expected [${expected.join(", ")}]`,
    },
  };
}

// `verification` is the host evaluation of the acceptance checks after a succeeded outcome (M3-D7). A failed
// check turns the attempt into a verification_failed failure that keeps the evidence; a passing or unverified
// success keeps it in the result.
export function completionFor(
  runId: string,
  outcome: AgentOutcome,
  verification?: Verification,
): RunCompletion {
  switch (outcome.status) {
    case "succeeded": {
      if (verification !== undefined && hasFailedCheck(verification)) {
        return {
          runId,
          outcome: "failed",
          error: {
            code: "verification_failed",
            message: verificationFailureMessage(verification),
          },
          endCause: "exit",
          verification: { ...verification },
        };
      }
      const evidence = verification === undefined ? {} : { verification: { ...verification } };
      if (outcome.simulated === true) {
        return { runId, outcome: "succeeded", result: { simulated: true, ...evidence } };
      }
      if (outcome.model !== undefined) {
        return {
          runId,
          outcome: "succeeded",
          result: {
            text: outcome.summary,
            model: outcome.model,
            warnings: [...(outcome.warnings ?? [])],
            ...evidence,
          },
        };
      }
      return { runId, outcome: "succeeded", result: { summary: outcome.summary, ...evidence } };
    }
    case "failed":
      return {
        runId,
        outcome: "failed",
        error: { code: outcome.code, message: outcome.message },
        endCause: "exit",
      };
    case "timed_out":
      return {
        runId,
        outcome: "failed",
        error: { code: "timeout", message: "the attempt exceeded its timeout" },
        endCause: "timeout",
      };
    case "aborted":
      return {
        runId,
        outcome: "failed",
        error: { code: "aborted", message: "the run was aborted" },
        endCause: "exit",
      };
  }
}

export * from "./verification.js";
