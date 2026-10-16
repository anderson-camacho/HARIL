// Executor rules (M1-T5): the AgentSpec built from a claimed task, the handshake check that runs
// before any prompt is sent, and the mapping of an agent outcome to the run completion. Pure.
import type { AgentOutcome, AgentSpec, HarilError, Result, RunCompletion } from "../ports/index.js";

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

export function completionFor(runId: string, outcome: AgentOutcome): RunCompletion {
  switch (outcome.status) {
    case "succeeded":
      return outcome.simulated === true
        ? { runId, outcome: "succeeded", result: { simulated: true } }
        : { runId, outcome: "succeeded", result: { summary: outcome.summary } };
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
