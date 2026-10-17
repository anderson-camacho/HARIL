// Executor rules (M1-T5): the AgentSpec built from a claimed task, the handshake check that runs
// before any prompt is sent, and the mapping of an agent outcome to the run completion. Pure.
import type { TaskKind } from "@haril/contracts";
import { READ_ONLY_AGENT_REFS } from "../domain/plan-graph.js";
import type {
  AgentOutcome,
  AgentSpec,
  DependencyResult,
  HarilError,
  Result,
  RunCompletion,
} from "../ports/index.js";
import { dependencyResultsSection } from "./dependency-results.js";
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
  // The files the task is told to read (a plan task's surface.read, LD-T7c). They reach the prompt; they are not an
  // access limit: the PathGuard keeps reads inside the project root.
  readonly surfaceRead?: readonly string[];
  // The results of the tasks it depends on, from its claim (MC-T1). They reach the prompt of a real agent only.
  readonly dependencyResults?: readonly DependencyResult[];
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

// The prompt: the goal, the description, the files to read when the task names any, the results of the tasks it
// depends on (MC-T1), then the instructions of its agent (a planner's, or a read-only analyst's, LD-T7c). A simulated
// agent's prompt reaches no model, so it gets neither the results nor instructions.
export function buildAgentSpec(task: ExecutableTask, run: RunIdentity): AgentSpec {
  const planning = task.kind === "plan";
  const reads = task.surfaceRead ?? [];
  const instructions = planning
    ? PLANNER_INSTRUCTIONS
    : READ_ONLY_AGENT_REFS.includes(task.agentRef)
      ? ANALYST_INSTRUCTIONS
      : [];
  const results = isRealAgent(task.agentRef)
    ? dependencyResultsSection(task.dependencyResults ?? [], task.maxTokens)
    : "";
  const prompt = [
    task.goal,
    task.description,
    reads.length === 0 ? "" : `Files to read: ${reads.join(", ")}`,
    results,
    ...instructions,
  ]
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
// required PlanTask fields and the read-only rule. Since LD-T7c it also says what the agent of the plan can do, what
// its read surface means, how the last task asks for a requested file, what a description adds and what an acceptance
// check tests. Since MC-T1 it says that a task receives the results of its dependencies, so a plan may chain tasks,
// while every task still returns a whole piece of the work. The first real demo of MC-T1 merged "list the gaps, then
// write FAQ.md" into one task checked for the text "FAQ.md", which the bare file content never holds, so it also asks
// for one task per result and for no file-name check on a file's content. The Core checks the proposal again
// (plan-graph.ts); this text only guides the agent.
const PLANNER_INSTRUCTIONS: readonly string[] = [
  `You plan this goal; you do not do the work. Read what you need, then call the tool ${PROPOSE_PLAN_TOOL} once with a plan. A person approves the plan before any of its tasks runs.`,
  [
    'The agent of every task is "analyst", a read-only agent: "analyst" reads project files and answers in its result text; it cannot write files or run commands.',
    'A task\'s "surface.read" lists the files the task tells it to read; it is not an access limit.',
    'If the goal asks for a file or a change, the goal of the last task says "Return the full content of <file> as the result", never "write"; the person applies it.',
    "A task gets its goal, its description, its files to read and the results of the tasks in its dependsOn, so a later task can build on an earlier task's result.",
    'Plan one task per result the goal asks for; a task that needs another task\'s result as its input depends on that task: "first list X, then write Y from it" is two tasks, the second depending on the first.',
    "Every task does a whole piece of the work and puts it in its result text, which is all the tasks after it receive: a task that only reads produces nothing.",
    "An acceptance check tests the text of that task's own result: never check for a file's name in a result that is that file's content, and use [] for a task that returns a file's content; when unsure, use [].",
  ].join(" "),
  [
    'The plan is a JSON object {"schemaVersion": 1, "tasks": [...]} with 1 to 5 tasks. Every task has exactly these fields:',
    '- "localId": a short id of letters, digits, "-" or "_", unique in the plan',
    '- "dependsOn": the localIds of the tasks it waits for and whose results it receives, [] for none, without cycles',
    '- "goal": one sentence; "description": the concrete detail the goal lacks (what to read, what the result must contain), never a copy of the goal',
    '- "priority": a whole number from 0 to 9',
    '- "kind": "work"; a task of the plan may not plan',
    '- "agent": "analyst"',
    '- "requires": [] and "context": []',
    '- "surface": {"write": [], "read": [the files the task tells it to read]}; the tasks write nothing',
    '- "budget": {"maxCostMicros": 0, "maxTokens": 20000, "maxWallMs": 120000}',
    '- "timeoutMs": 120000 and "maxAttempts": 1 to 3',
    '- "acceptance": [], or checks such as {"kind": "output_contains", "text": "..."}',
  ].join("\n"),
  `If ${PROPOSE_PLAN_TOOL} refuses the plan, read its reason, fix the plan and call it again.`,
];

// What a read-only analyst is told after its task (LD-T7c): its result is its only output, and a requested file comes
// back as the bare content, since the person applies it as it is. The second real demo wrapped the file in chat and a
// code fence; in the third, an analyst answered a README read with a fragment, so it is told to do the goal in full.
const ANALYST_INSTRUCTIONS: readonly string[] = [
  [
    "Do what the goal asks and put your complete answer in your result text; you cannot write files or run commands.",
    "When the goal asks for the content of a file, the result is that content alone: no preamble, no closing remarks and no code fence around it.",
  ].join(" "),
];

// A plan attempt succeeds only by proposing (LD-T4): a success whose run recorded no proposal is a plan.not_proposed
// failure, retried like any other failure. When the host refused every proposal of the run, the failure is plan.refused
// with the last refusal, so the reason is kept. Every other kind and every other outcome passes through.
export function planAttemptOutcome(
  kind: TaskKind | undefined,
  outcome: AgentOutcome,
  proposed: boolean,
  lastRefusal?: string,
): AgentOutcome {
  if (kind !== "plan" || outcome.status !== "succeeded" || proposed) return outcome;
  if (lastRefusal !== undefined)
    return { status: "failed", code: "plan.refused", message: lastRefusal };
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

export * from "./dependency-results.js";
export * from "./verification.js";
