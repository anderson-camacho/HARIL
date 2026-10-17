import { describe, expect, it } from "vitest";
import { checkPlanSubmission } from "../src/domain/index.js";
import type {
  AgentHandle,
  AgentSpec,
  PlanProposalContext,
  PlanProposer,
} from "../src/ports/index.js";
import { FakeAgentRuntime, FakeClock } from "../testing/index.js";

// Contract suite for the AgentRuntime port, run against FakeAgentRuntime (M1-D7).
// Time is virtual: FakeClock.advance(ms) fires the timers the fake scheduled.

const TOOLS = ["read", "write"];

function spec(agentRef: string, timeoutMs = 1000): AgentSpec {
  return {
    runId: "run-1",
    taskId: "task-1",
    attempt: 1,
    agentRef,
    allowedTools: TOOLS,
    prompt: "do the work",
    timeoutMs,
  };
}

function setup(helloTools?: (allowed: readonly string[]) => readonly string[]) {
  const clock = new FakeClock();
  const runtime = new FakeAgentRuntime({ clock, helloTools });
  return { clock, runtime };
}

async function startHandle(runtime: FakeAgentRuntime, agentSpec: AgentSpec): Promise<AgentHandle> {
  const result = await runtime.start(agentSpec);
  if (!result.ok) throw new Error(`start failed: ${result.error.code}`);
  return result.value;
}

// Lets pending promise continuations run without relying on host timers.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("AgentRuntime contract (FakeAgentRuntime)", () => {
  it("hello lists exactly the allowedTools of the spec", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:succeed"));
    expect((await handle.hello).tools).toEqual(TOOLS);
  });

  it("fake:succeed settles succeeded once the prompt is accepted", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:succeed"));
    const prompted = await handle.prompt("go");
    expect(prompted.ok).toBe(true);
    expect((await handle.settled).status).toBe("succeeded");
  });

  it("fake:fail settles failed with a stable code", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:fail"));
    await handle.prompt("go");
    const outcome = await handle.settled;
    expect(outcome).toMatchObject({ status: "failed", code: "fake.failed" });
  });

  it("fake:slow:<ms> settles succeeded only after that much virtual time", async () => {
    const { clock, runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:500", 1000));
    await handle.prompt("go");
    let settled = false;
    void handle.settled.then(() => {
      settled = true;
    });

    clock.advance(499);
    await flush();
    expect(settled).toBe(false);

    clock.advance(1);
    await flush();
    expect(settled).toBe(true);
    expect((await handle.settled).status).toBe("succeeded");
  });

  it("settles timed_out at timeoutMs when the work is slower than the timeout", async () => {
    const { clock, runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:5000", 1000));
    await handle.prompt("go");
    clock.advance(1000);
    expect(await handle.settled).toEqual({ status: "timed_out" });
  });

  it("abort settles aborted and cancels the pending work", async () => {
    const { clock, runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:500", 1000));
    await handle.prompt("go");
    await handle.abort();
    expect(await handle.settled).toEqual({ status: "aborted" });
    clock.advance(2000);
    await flush();
    expect((await handle.settled).status).toBe("aborted");
  });

  it("a hello list that differs from allowedTools rejects the prompt and fails the run", async () => {
    const { runtime } = setup(() => ["read", "delete_everything"]);
    const handle = await startHandle(runtime, spec("fake:succeed"));
    const prompted = await handle.prompt("go");
    expect(prompted.ok).toBe(false);
    if (!prompted.ok) expect(prompted.error.code).toBe("agent.handshake_mismatch");
    expect(await handle.settled).toMatchObject({
      status: "failed",
      code: "agent.handshake_mismatch",
    });
  });

  it("dispose is idempotent and never throws", async () => {
    const { runtime } = setup();
    const handle = await startHandle(runtime, spec("fake:slow:500", 1000));
    await handle.prompt("go");
    await handle.dispose();
    await handle.dispose();
    expect(await handle.settled).toEqual({ status: "aborted" });
  });

  it("any other agentRef runs as a simulated success until M2 (M1 fix a)", async () => {
    const { runtime } = setup();
    const result = await runtime.start(spec("developer-block"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await result.value.hello).tools).toEqual(TOOLS);
    await result.value.prompt("go");
    expect(await result.value.settled).toEqual({
      status: "succeeded",
      summary: "simulated: no real agent until M2",
      simulated: true,
    });
  });

  it("fake:say:<text> succeeds with exactly that text as its final output (M3-T6a)", async () => {
    const { runtime } = setup();
    const result = await runtime.start(spec("fake:say:Hello from fake, with spaces"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.value.prompt("go");
    expect(await result.value.settled).toEqual({
      status: "succeeded",
      summary: "Hello from fake, with spaces",
    });
  });
});

// fake:plan (LD-T4): the hermetic planner. It proposes a fixed plan derived from the goal (the first line of the
// prompt) through the injected host handler, and settles with the approval id; it never touches a store itself.
describe("fake:plan", () => {
  const PLAN_TOOLS = ["read", "haril_propose_plan"];

  function planSpec(goal: string, allowedTools: readonly string[] = PLAN_TOOLS): AgentSpec {
    return {
      runId: "run-p",
      taskId: "task-p",
      attempt: 1,
      agentRef: "fake:plan",
      allowedTools,
      prompt: `${goal}\n\nPropose a plan with haril_propose_plan.`,
      timeoutMs: 1000,
      projectId: "project-p",
      kind: "plan",
    };
  }

  interface Call {
    readonly context: PlanProposalContext;
    readonly plan: unknown;
  }

  function recording(result: ReturnType<PlanProposer>): { calls: Call[]; proposer: PlanProposer } {
    const calls: Call[] = [];
    return {
      calls,
      proposer: (context, plan) => {
        calls.push({ context, plan });
        return result;
      },
    };
  }

  async function settle(runtime: FakeAgentRuntime, agentSpec: AgentSpec) {
    const handle = await startHandle(runtime, agentSpec);
    expect((await handle.hello).tools).toEqual(agentSpec.allowedTools);
    await handle.prompt(agentSpec.prompt);
    return await handle.settled;
  }

  it("proposes a valid hermetic plan once, with its run as context, and names the approval", async () => {
    const { calls, proposer } = recording({ ok: true, approvalId: "appr-1", created: true });
    const runtime = new FakeAgentRuntime({ clock: new FakeClock(), proposePlan: proposer });
    const outcome = await settle(runtime, planSpec("Document the CLI"));

    expect(outcome).toMatchObject({ status: "succeeded" });
    if (outcome.status === "succeeded") expect(outcome.summary).toContain("appr-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.context).toEqual({
      projectId: "project-p",
      taskId: "task-p",
      runId: "run-p",
    });
    const check = checkPlanSubmission(calls[0]?.plan);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.plan.tasks.length).toBeGreaterThanOrEqual(2);
    expect(check.plan.tasks.length).toBeLessThanOrEqual(4);
    for (const planned of check.plan.tasks) {
      expect(planned.agent).toMatch(/^fake:(succeed|slow:\d+)$/);
      expect(planned.kind).toBe("work");
      expect(planned.surface.write).toEqual([]);
      expect(planned.goal).toContain("Document the CLI");
    }
  });

  it("derives the plan from the goal: the same goal gives the same plan, and goals vary its size", async () => {
    const proposedFor = async (goal: string) => {
      const { calls, proposer } = recording({ ok: true, approvalId: "x", created: true });
      await settle(
        new FakeAgentRuntime({ clock: new FakeClock(), proposePlan: proposer }),
        planSpec(goal),
      );
      return calls[0]?.plan as { tasks: unknown[] };
    };
    expect(await proposedFor("Document the CLI")).toEqual(await proposedFor("Document the CLI"));
    const sizes: number[] = [];
    for (const goal of ["a", "ab", "abc"]) sizes.push((await proposedFor(goal)).tasks.length);
    expect(new Set(sizes).size).toBe(3);
  });

  it("says when the same plan was already waiting for a decision", async () => {
    const { proposer } = recording({ ok: true, approvalId: "appr-1", created: false });
    const runtime = new FakeAgentRuntime({ clock: new FakeClock(), proposePlan: proposer });
    const outcome = await settle(runtime, planSpec("Document the CLI"));
    expect(outcome).toMatchObject({ status: "succeeded" });
    if (outcome.status === "succeeded") expect(outcome.summary).toContain("already");
  });

  it("fails with the reason when the host refuses the plan", async () => {
    const { proposer } = recording({ ok: false, reason: "invalid plan: /tasks: too short" });
    const runtime = new FakeAgentRuntime({ clock: new FakeClock(), proposePlan: proposer });
    expect(await settle(runtime, planSpec("Document the CLI"))).toEqual({
      status: "failed",
      code: "plan.refused",
      message: "invalid plan: /tasks: too short",
    });
  });

  it("fails without a proposer, and when the proposal tool is not allowed, proposing nothing", async () => {
    const bare = new FakeAgentRuntime({ clock: new FakeClock() });
    expect(await settle(bare, planSpec("Document the CLI"))).toMatchObject({
      status: "failed",
      code: "fake.no_proposer",
    });

    const { calls, proposer } = recording({ ok: true, approvalId: "x", created: true });
    const runtime = new FakeAgentRuntime({ clock: new FakeClock(), proposePlan: proposer });
    expect(await settle(runtime, planSpec("Document the CLI", ["read"]))).toMatchObject({
      status: "failed",
      code: "fake.plan_tool_missing",
    });
    expect(calls).toEqual([]);
  });

  it("fails, and does not throw, when the proposer throws", async () => {
    const runtime = new FakeAgentRuntime({
      clock: new FakeClock(),
      proposePlan: () => {
        throw new Error("store closed");
      },
    });
    expect(await settle(runtime, planSpec("Document the CLI"))).toEqual({
      status: "failed",
      code: "plan.refused",
      message: "store closed",
    });
  });
});

describe("FakeClock", () => {
  it("runs scheduled callbacks in due order and honours cancellation", () => {
    const clock = new FakeClock();
    const fired: string[] = [];
    clock.schedule(20, () => fired.push("b"));
    clock.schedule(10, () => fired.push("a"));
    const cancel = clock.schedule(15, () => fired.push("cancelled"));
    cancel();
    clock.advance(30);
    expect(fired).toEqual(["a", "b"]);
    expect(clock.now()).toBe(30);
  });
});
