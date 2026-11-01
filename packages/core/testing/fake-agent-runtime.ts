import type { Plan, PlanTask } from "@haril/contracts";
import { PROPOSE_PLAN_TOOL } from "../src/executor/index.js";
import type {
  AgentHandle,
  AgentHello,
  AgentOutcome,
  AgentRuntime,
  AgentSpec,
  Cancel,
  Clock,
  DelegationToolHandler,
  DelegationToolResult,
  HarilError,
  PlanProposer,
  Result,
} from "../src/ports/index.js";
import { type FakeTurnCost, isFakeDelegationAgentRef } from "./fake-delegation-agents.js";
import {
  fakeWorkflowTurn,
  fakeWritingTurn,
  type WorkflowTurnResult,
} from "./fake-workflow-turn.js";

// Simulated agent (M1-D7). The behaviour is chosen by agentRef:
//   fake:succeed (default), fake:fail, fake:slow:<ms>, fake:say:<text> (its final output is <text>, M3-T6a),
//   fake:plan (proposes a fixed plan through the injected proposer, LD-T4);
//   fake:orchestrate, fake:delegate, fake:execute and fake:audit (a workflow turn, phase F2): they read the turn input
//   of their spec and call the injected delegation tools, as the real agents will through Pi's bridge;
//   any other ref succeeds as a simulated run until M2.
// Work starts when prompt() is accepted; a slow run settles at its completion time or at timeoutMs.

export interface FakeAgentRuntimeOptions {
  readonly clock: Clock;
  // Test hook: the tool list announced in hello. Defaults to the spec's allowedTools.
  readonly helloTools?: (allowedTools: readonly string[]) => readonly string[];
  // The host handler of haril_propose_plan (LD-T4). Without it, fake:plan fails its attempt.
  readonly proposePlan?: PlanProposer;
  // The host handler of the delegation tools (phase F2). Without it, a fake workflow agent that must call one fails.
  readonly delegationTools?: DelegationToolHandler;
  // How long a fake workflow turn takes, from the cost it draws (minutes of model time); default 0, so a test runs
  // fast while several turns are still in flight together.
  readonly delegationDelayMs?: (cost: FakeTurnCost) => number;
  // A scripted workflow turn, in place of the fake agents' own: what it answers is its final message; a thrown error fails
  // the attempt; `stall` never settles until an abort or its timeout. For a test that plays a whole scenario.
  readonly turnScript?: (
    spec: AgentSpec,
    call: (tool: string, input: unknown) => Promise<DelegationToolResult>,
  ) => Promise<string | "stall" | AgentOutcome>;
  // Tells listeners a model turn ended this long after the prompt, as a real agent does between its turns.
  readonly turnEndAfterMs?: number;
}

type Behaviour =
  | { readonly kind: "succeed" }
  | { readonly kind: "fail" }
  | { readonly kind: "slow"; readonly ms: number }
  | { readonly kind: "simulated" }
  | { readonly kind: "say"; readonly text: string }
  | { readonly kind: "plan" }
  | { readonly kind: "delegation" };

const SLOW_REF = /^fake:slow:(\d+)$/;
const SAY_REF = /^fake:say:(.+)$/s;

// M1 fix (a): an unknown ref is not an error in M1; it is a simulated success until a real agent exists (M2).
function parseAgentRef(agentRef: string): Behaviour {
  if (agentRef === "fake:succeed") return { kind: "succeed" };
  if (agentRef === "fake:fail") return { kind: "fail" };
  if (agentRef === "fake:plan") return { kind: "plan" };
  if (isFakeDelegationAgentRef(agentRef)) return { kind: "delegation" };
  const slow = SLOW_REF.exec(agentRef);
  if (slow !== null) return { kind: "slow", ms: Number(slow[1]) };
  const say = SAY_REF.exec(agentRef);
  if (say !== null) return { kind: "say", text: say[1] ?? "" };
  return { kind: "simulated" };
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

export class FakeAgentRuntime implements AgentRuntime {
  private readonly options: FakeAgentRuntimeOptions;

  constructor(options: FakeAgentRuntimeOptions) {
    this.options = options;
  }

  async start(spec: AgentSpec): Promise<Result<AgentHandle, HarilError>> {
    const behaviour = parseAgentRef(spec.agentRef);
    return { ok: true, value: new FakeAgentHandle(spec, behaviour, this.options) };
  }
}

class FakeAgentHandle implements AgentHandle {
  readonly runId: string;
  readonly hello: Promise<AgentHello>;
  readonly settled: Promise<AgentOutcome>;
  private resolveSettled!: (outcome: AgentOutcome) => void;
  private finished = false;
  private readonly cancels: Cancel[] = [];
  private readonly spec: AgentSpec;
  private readonly behaviour: Behaviour;
  private readonly options: FakeAgentRuntimeOptions;
  private readonly turnEndListeners: (() => void)[] = [];

  constructor(spec: AgentSpec, behaviour: Behaviour, options: FakeAgentRuntimeOptions) {
    this.spec = spec;
    this.behaviour = behaviour;
    this.options = options;
    this.runId = spec.runId;
    const tools = options.helloTools ? options.helloTools(spec.allowedTools) : spec.allowedTools;
    this.hello = Promise.resolve({ tools: [...tools] });
    this.settled = new Promise<AgentOutcome>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  async prompt(_text: string): Promise<Result<void, HarilError>> {
    if (this.finished) {
      return { ok: false, error: { code: "agent.closed", message: "the run has already settled" } };
    }
    const hello = await this.hello;
    if (!sameTools(hello.tools, this.spec.allowedTools)) {
      const message = "hello tool list differs from allowedTools; the prompt is refused";
      this.finish({ status: "failed", code: "agent.handshake_mismatch", message });
      return { ok: false, error: { code: "agent.handshake_mismatch", message } };
    }
    this.begin();
    return { ok: true, value: undefined };
  }

  async abort(): Promise<void> {
    this.finish({ status: "aborted" });
  }

  onTurnEnd(listener: () => void): void {
    this.turnEndListeners.push(listener);
  }

  async dispose(): Promise<void> {
    this.finish({ status: "aborted" });
  }

  private begin(): void {
    const { behaviour, options, spec } = this;
    if (options.turnEndAfterMs !== undefined) {
      this.cancels.push(
        options.clock.schedule(options.turnEndAfterMs, () => {
          for (const listener of this.turnEndListeners) listener();
        }),
      );
    }
    if (options.turnScript !== undefined && spec.delegation !== undefined) {
      this.runScript(options.turnScript);
    } else if (behaviour.kind === "succeed") {
      this.finish({ status: "succeeded", summary: "fake agent succeeded" });
    } else if (behaviour.kind === "say") {
      this.finish({ status: "succeeded", summary: behaviour.text });
    } else if (behaviour.kind === "simulated") {
      this.finish({
        status: "succeeded",
        summary: "simulated: no real agent until M2",
        simulated: true,
      });
    } else if (behaviour.kind === "plan") {
      this.finish(this.proposePlan());
    } else if (behaviour.kind === "delegation") {
      this.runWorkflowTurn();
    } else if (behaviour.kind === "fail") {
      this.finish({
        status: "failed",
        code: "fake.failed",
        message: "fake agent failed on request",
      });
    } else {
      this.cancels.push(
        options.clock.schedule(behaviour.ms, () =>
          this.finish({ status: "succeeded", summary: "fake agent finished slowly" }),
        ),
        options.clock.schedule(spec.timeoutMs, () => this.finish({ status: "timed_out" })),
      );
    }
  }

  // fake:plan: the plan of the goal (the first line of the prompt) goes to the host handler, as the planner's tool call
  // would. A refusal fails the attempt with its reason; the host, not the fake, decides what counts as proposed.
  private proposePlan(): AgentOutcome {
    const { spec, options } = this;
    if (!spec.allowedTools.includes(PROPOSE_PLAN_TOOL)) {
      return {
        status: "failed",
        code: "fake.plan_tool_missing",
        message: `fake:plan runs only plan tasks: ${PROPOSE_PLAN_TOOL} is not an allowed tool`,
      };
    }
    if (options.proposePlan === undefined || spec.projectId === undefined) {
      return {
        status: "failed",
        code: "fake.no_proposer",
        message: "fake:plan has no plan proposer: the agent runtime was created without one",
      };
    }
    const plan = fakePlanFor(spec.prompt.split("\n")[0] ?? "");
    const context = { projectId: spec.projectId, taskId: spec.taskId, runId: spec.runId };
    let proposed: ReturnType<PlanProposer>;
    try {
      proposed = options.proposePlan(context, plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "failed", code: "plan.refused", message };
    }
    if (!proposed.ok) return { status: "failed", code: "plan.refused", message: proposed.reason };
    const count = `${plan.tasks.length} tasks`;
    return {
      status: "succeeded",
      summary: proposed.created
        ? `proposed plan ${proposed.approvalId} (${count}); it waits for haril approve ${proposed.approvalId}`
        : `plan ${proposed.approvalId} (${count}) was already requested; it waits for haril approve ${proposed.approvalId}`,
    };
  }

  private runScript(script: NonNullable<FakeAgentRuntimeOptions["turnScript"]>): void {
    const { options, spec } = this;
    const call = async (tool: string, input: unknown): Promise<DelegationToolResult> => {
      if (options.delegationTools === undefined || spec.projectId === undefined) {
        throw new Error("a scripted turn needs the delegation tools and a project");
      }
      return await options.delegationTools(
        { projectId: spec.projectId, taskId: spec.taskId, runId: spec.runId },
        tool,
        input,
      );
    };
    script(spec, call).then(
      (answer) => {
        if (answer === "stall") {
          this.cancels.push(
            options.clock.schedule(spec.timeoutMs, () => this.finish({ status: "timed_out" })),
          );
          return;
        }
        this.finish(typeof answer === "string" ? { status: "succeeded", summary: answer } : answer);
      },
      (error: unknown) =>
        this.finish({
          status: "failed",
          code: "fake.turn_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  // A fake workflow turn: its calls go to the host at once; it settles after its drawn time (delegationDelayMs), or at
  // its timeout when it stalls (no progress at all, for the watchdog of 3.16 or the timeout to end). A turn of a workflow
  // that writes (phase F8) waits for the replies of its workspace tools first.
  private runWorkflowTurn(): void {
    const { options, spec } = this;
    const failed = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      this.finish({ status: "failed", code: "fake.turn_failed", message });
    };
    if ((spec.delegation?.workspace ?? null) !== null) {
      fakeWritingTurn(spec, options.delegationTools).then((turn) => this.settleTurn(turn), failed);
      return;
    }
    let turn: WorkflowTurnResult;
    try {
      turn = fakeWorkflowTurn(spec, options.delegationTools);
    } catch (error) {
      failed(error);
      return;
    }
    this.settleTurn(turn);
  }

  private settleTurn(turn: WorkflowTurnResult): void {
    const { options, spec } = this;
    if (this.finished) return;
    if (turn === "stalled") {
      this.cancels.push(
        options.clock.schedule(spec.timeoutMs, () => this.finish({ status: "timed_out" })),
      );
      return;
    }
    const settled = turn.outcome;
    const delay = Math.max(0, options.delegationDelayMs?.(turn.cost) ?? 0);
    this.cancels.push(
      options.clock.schedule(delay, () => this.finish(settled)),
      options.clock.schedule(spec.timeoutMs, () => this.finish({ status: "timed_out" })),
    );
  }

  private finish(outcome: AgentOutcome): void {
    if (this.finished) return;
    this.finished = true;
    for (const cancel of this.cancels) cancel();
    this.resolveSettled(outcome);
  }
}

// The hermetic plan of fake:plan (LD-T4): 2 to 4 steps chained in order, fake:succeed except a short fake:slow last
// step. The step count comes from the goal's length, so the same goal always gives the same plan (and the same
// approval), and different goals give plans of different sizes.
export function fakePlanFor(goal: string): Plan {
  const count = 2 + ([...goal].length % 3);
  const tasks: PlanTask[] = [];
  for (let step = 1; step <= count; step++) {
    tasks.push({
      localId: `step-${step}`,
      dependsOn: step === 1 ? [] : [`step-${step - 1}`],
      goal: `${goal} (step ${step} of ${count})`,
      description: "A hermetic step proposed by fake:plan.",
      priority: 5,
      kind: "work",
      agent: step === count ? "fake:slow:20" : "fake:succeed",
      requires: [],
      context: [],
      surface: { write: [], read: [] },
      budget: { maxCostMicros: 0, maxTokens: 0, maxWallMs: 60000 },
      timeoutMs: 60000,
      maxAttempts: 1,
      acceptance: [],
    });
  }
  return { schemaVersion: 1, tasks };
}
