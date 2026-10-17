// Executor rules (M1-T5): the AgentSpec built from a claimed task, the handshake check that runs
// before any prompt is sent, and the mapping of an agent outcome to the run completion. Pure.
import type { TaskKind } from "@haril/contracts";
import type { AgentOutcome, AgentSpec, HarilError, Result, RunCompletion } from "../ports/index.js";
import { hasFailedCheck, type Verification, verificationFailureMessage } from "./verification.js";

// M1 gives every agent the same single tool; the real tool policy arrives with Pi (M2).
export const M1_ALLOWED_TOOLS: readonly string[] = ["read"];

// The planning tool (ARCH 9.4, LD-T4): only a plan task gets it, next to read. It proposes; the Core validates.
export const PROPOSE_PLAN_TOOL = "haril_propose_plan";
export const PLAN_ALLOWED_TOOLS: readonly string[] = ["read", PROPOSE_PLAN_TOOL];

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
  // LD-T4: absent is a task without a kind of its own (work).
  readonly kind?: TaskKind;
}

// Agent references served by a real runtime (Pi through the Broker, M2-D6). Every other reference keeps the
// simulated behaviour of M1. The planner archetype (LD-T4, AGENTS.md 3.2) shares the analyst's lane and needs a model.
export const REAL_AGENT_REFS: readonly string[] = ["analyst", "planner"];

export function isRealAgent(agentRef: string): boolean {
  return REAL_AGENT_REFS.includes(agentRef);
}

export interface RunIdentity {
  readonly runId: string;
  readonly attempt: number;
}

export function buildAgentSpec(task: ExecutableTask, run: RunIdentity): AgentSpec {
  const planning = task.kind === "plan";
  const prompt = [task.goal, task.description, ...(planning ? PLANNER_INSTRUCTIONS : [])]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  return {
    runId: run.runId,
    taskId: task.taskId,
    attempt: run.attempt,
    agentRef: task.agentRef,
    allowedTools: planning ? [...PLAN_ALLOWED_TOOLS] : [...M1_ALLOWED_TOOLS],
    prompt,
    timeoutMs: task.timeoutMs,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    ...(task.model ? { model: task.model } : {}),
    ...(task.maxTokens === undefined ? {} : { maxTokens: task.maxTokens }),
    ...(task.kind === undefined ? {} : { kind: task.kind }),
  };
}

// What a planner is asked after the goal and the description (LD-T4): the plan shape of schemas.md section 6, the
// required PlanTask fields and the read-only rule. The Core checks the proposal again; this text only guides the agent.
const PLANNER_INSTRUCTIONS: readonly string[] = [
  `You plan this goal; you do not do the work. Read what you need, then call the tool ${PROPOSE_PLAN_TOOL} once with a plan. A person approves the plan before any of its tasks runs.`,
  [
    'The plan is a JSON object {"schemaVersion": 1, "tasks": [...]} with 2 to 5 tasks. Every task has exactly these fields:',
    '- "localId": a short id of letters, digits, "-" or "_", unique in the plan',
    '- "dependsOn": the localIds of the tasks it waits for, [] for none, without cycles',
    '- "goal": one sentence; "description": what to read and what to report',
    '- "priority": a whole number from 0 to 9',
    '- "kind": "work"; a task of the plan may not plan',
    '- "agent": "analyst"; every task uses a read-only agent',
    '- "requires": [] and "context": []',
    '- "surface": {"write": [], "read": [the paths it reads]}; the tasks are read-only and write nothing',
    '- "budget": {"maxCostMicros": 0, "maxTokens": 20000, "maxWallMs": 120000}',
    '- "timeoutMs": 120000 and "maxAttempts": 1 to 3',
    '- "acceptance": [], or checks such as {"kind": "output_contains", "text": "..."}',
  ].join("\n"),
  `If ${PROPOSE_PLAN_TOOL} refuses the plan, read its reason, fix the plan and call it again.`,
];

// A plan attempt succeeds only by proposing (LD-T4): a success whose run recorded no proposal is a plan.not_proposed
// failure, retried like any other failure. Every other kind and every other outcome passes through.
export function planAttemptOutcome(
  kind: TaskKind | undefined,
  outcome: AgentOutcome,
  proposed: boolean,
): AgentOutcome {
  if (kind !== "plan" || outcome.status !== "succeeded" || proposed) return outcome;
  return {
    status: "failed",
    code: "plan.not_proposed",
    message: `the plan attempt ended without proposing a plan through ${PROPOSE_PLAN_TOOL}`,
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
