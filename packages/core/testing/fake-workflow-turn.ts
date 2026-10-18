import type { ReportInput } from "@haril/contracts";
import type {
  AgentOutcome,
  AgentSpec,
  DelegationToolHandler,
  DelegationToolResult,
  DelegationTurnInput,
} from "../src/ports/index.js";
import {
  type FakeScenario,
  type FakeTurnCost,
  fakeAudit,
  fakeDelegate,
  fakeExecute,
  fakeOrchestrate,
  fakeResultIsComplete,
  fakeScenarioOf,
} from "./fake-delegation-agents.js";

// One turn of fake:orchestrate, fake:delegate, fake:execute or fake:audit inside FakeAgentRuntime (phase F2). The
// fakes are the pure functions of fake-delegation-agents.ts; this feeds them the turn input of the spec, the same data a
// real agent's prompt renders, and sends their calls to the host's delegation tools. The scenario comes from the
// workflow's goal (fakeScenarioOf), as visible text, the way a real agent follows its prompt.

export type WorkflowTurnResult =
  | { readonly outcome: AgentOutcome; readonly cost: FakeTurnCost }
  // No progress at all: the turn never settles until its timeout.
  | "stalled";

type Call = (tool: string, payload: unknown) => DelegationToolResult;

function sumCost(a: FakeTurnCost, b: FakeTurnCost): FakeTurnCost {
  return {
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    durationMs: a.durationMs + b.durationMs,
  };
}

function succeeded(summary: string, cost: FakeTurnCost): WorkflowTurnResult {
  return {
    outcome: {
      status: "succeeded",
      summary,
      usage: { tokensIn: cost.tokensIn, tokensOut: cost.tokensOut },
    },
    cost,
  };
}

function replyText(tool: string, reply: DelegationToolResult): string {
  return reply.ok ? `${tool} accepted` : `${tool} refused: ${reply.reason}`;
}

// A provider error the goal scripts for one turn: [fake:provider=<target>:<kind>] where the target is "orchestrator",
// "part-<i>" (a delegator) or "part-<i>/step-<j>" (an executor), and the kind is 402, 429 (with Retry-After 60 s), 500,
// or one of them followed by "-after-call" (the turn first makes its deciding call, which is accepted, then the error
// comes). It hits the first attempt of the target's first turn only: the retried attempt runs normally.
const PROVIDER_DIRECTIVE = /\[fake:provider=([A-Za-z0-9_/-]+):(402|429|500)(-after-call)?\]/g;

function scriptedProviderError(
  spec: AgentSpec,
  input: DelegationTurnInput,
): { readonly status: 402 | 429 | 500; readonly afterCall: boolean } | null {
  if (spec.attempt !== 1 || input.turnKind !== "first") return null;
  const target = input.role === "orchestrator" ? "orchestrator" : input.label;
  for (const match of input.workflowGoal.matchAll(PROVIDER_DIRECTIVE)) {
    if (match[1] === target) {
      return { status: Number(match[2]) as 402 | 429 | 500, afterCall: match[3] !== undefined };
    }
  }
  return null;
}

function providerFailed(spec: AgentSpec, status: 402 | 429 | 500): WorkflowTurnResult {
  return {
    outcome: {
      status: "failed",
      code: "provider_error",
      message: `the gateway answered HTTP ${status}`,
      provider: {
        kind: status === 402 ? "quota" : status === 429 ? "rate_limited" : "transient",
        httpStatus: status,
        retryAfterMs: status === 429 ? 60_000 : null,
        model: spec.model ?? null,
      },
    },
    cost: { tokensIn: 0, tokensOut: 0, durationMs: 1_000 },
  };
}

export function fakeWorkflowTurn(
  spec: AgentSpec,
  tools: DelegationToolHandler | undefined,
): WorkflowTurnResult {
  const input = spec.delegation;
  if (input === undefined) {
    throw new Error(`${spec.agentRef} runs only workflow turns: its spec has no turn input`);
  }
  const scripted = scriptedProviderError(spec, input);
  if (scripted !== null && !scripted.afterCall) return providerFailed(spec, scripted.status);
  const result = turnOf(spec, tools, input);
  return scripted === null ? result : providerFailed(spec, scripted.status);
}

function turnOf(
  spec: AgentSpec,
  tools: DelegationToolHandler | undefined,
  input: DelegationTurnInput,
): WorkflowTurnResult {
  const scenario = fakeScenarioOf(input.workflowGoal);
  const call: Call = (tool, payload) => {
    if (tools === undefined || spec.projectId === undefined) {
      throw new Error(
        `${spec.agentRef} has no delegation tools: the agent runtime was created without them`,
      );
    }
    const context = { projectId: spec.projectId, taskId: spec.taskId, runId: spec.runId };
    return tools(context, tool, payload);
  };
  switch (spec.agentRef) {
    case "fake:orchestrate":
      return orchestratorTurn(input, scenario, call);
    case "fake:delegate":
      return delegatorTurn(input, scenario, call);
    case "fake:execute":
      return executorTurn(input, scenario);
    default:
      return auditorTurn(input, scenario, call);
  }
}

function orchestratorTurn(
  input: DelegationTurnInput,
  scenario: FakeScenario,
  call: Call,
): WorkflowTurnResult {
  const goal = input.workflowGoal;
  if (input.finalAudit !== null && input.finalAudit.verdict === "rejected") {
    const findings = input.finalAudit.reasons
      .filter((reason) => !reason.ok)
      .map((reason) => reason.criterion);
    const turn = fakeOrchestrate({ kind: "final_rejected", goal, seed: scenario.seed, findings });
    return succeeded(replyText(turn.call.tool, call(turn.call.tool, turn.call.input)), turn.cost);
  }
  if (input.turnKind === "first") {
    // The plan, corrected in the same turn when the host refuses it (3.5), up to three calls.
    const rejection: string[] = [];
    let cost: FakeTurnCost | null = null;
    let last = "";
    for (let calls = 0; calls < 3; calls++) {
      const turn = fakeOrchestrate({
        kind: "plan",
        goal,
        seed: scenario.seed,
        delegators: scenario.parts,
        executorsPerDelegator: scenario.steps,
        previousRejection: rejection,
        makeMistake: scenario.mistake,
        scenario: scenario.scenario,
      });
      cost = cost === null ? turn.cost : sumCost(cost, turn.cost);
      const reply = call(turn.call.tool, turn.call.input);
      last = replyText(turn.call.tool, reply);
      if (reply.ok) break;
      rejection.push(reply.reason);
    }
    return succeeded(last, cost as FakeTurnCost);
  }
  const reports = input.children.map((child) => ({
    localId: child.localId,
    status: (child.status === "done" || child.status === "partial"
      ? child.status
      : "failed") as ReportInput["status"],
    summary: child.summary ?? "no report",
    issues: child.issues,
  }));
  const turn = fakeOrchestrate({
    kind: "continuation",
    goal,
    seed: scenario.seed,
    memo: input.memo ?? "",
    reports,
  });
  return succeeded(replyText(turn.call.tool, call(turn.call.tool, turn.call.input)), turn.cost);
}

function delegatorTurn(
  input: DelegationTurnInput,
  scenario: FakeScenario,
  call: Call,
): WorkflowTurnResult {
  const partId = input.localId ?? input.label;
  if (input.turnKind === "first") {
    const steps = /into (\d+) steps/.exec(input.instructions);
    const turn = fakeDelegate({
      kind: "plan",
      goal: input.goal,
      description: input.instructions,
      seed: scenario.seed,
      partId,
      executors: steps === null ? scenario.steps : Math.min(Number(steps[1]), 10),
    });
    return succeeded(replyText(turn.call.tool, call(turn.call.tool, turn.call.input)), turn.cost);
  }
  const turn = fakeDelegate({
    kind: "continuation",
    goal: input.goal,
    seed: scenario.seed,
    partId,
    reformulated: input.children.filter((child) => child.reassigned).map((child) => child.localId),
    children: input.children.map((child) => ({
      localId: child.localId,
      status:
        child.status === "approved" || child.status === "done"
          ? "done"
          : child.status === "escalated" || child.status === "blocked"
            ? child.status
            : "failed",
    })),
  });
  return succeeded(replyText(turn.call.tool, call(turn.call.tool, turn.call.input)), turn.cost);
}

function executorTurn(input: DelegationTurnInput, scenario: FakeScenario): WorkflowTurnResult {
  const outcome = fakeExecute({
    seed: scenario.seed,
    key: input.label,
    goal: input.goal,
    instructions: input.instructions,
    attempt: input.turn,
    reformulated: input.turnKind === "reformulation",
  });
  if (outcome.outcome === "stalled") return "stalled";
  return succeeded(outcome.summary, outcome.cost);
}

function auditorTurn(
  input: DelegationTurnInput,
  scenario: FakeScenario,
  call: Call,
): WorkflowTurnResult {
  const subject = input.subject;
  const workflowScope = subject?.scope === "workflow";
  const reports = subject?.reports ?? [];
  const audit = fakeAudit({
    seed: scenario.seed,
    key: `${input.label}:${input.turn}`,
    scope: workflowScope ? "workflow" : "task",
    acceptanceCriteria: workflowScope
      ? [`The goal is met: ${input.workflowGoal}`]
      : input.acceptanceCriteria.length > 0
        ? input.acceptanceCriteria
        : ["The step is done"],
    complete: workflowScope
      ? reports.length > 0 && reports.every((report) => report.status === "done")
      : fakeResultIsComplete(subject?.result ?? null),
  });
  return succeeded(replyText("haril_verdict", call("haril_verdict", audit.verdict)), audit.cost);
}
