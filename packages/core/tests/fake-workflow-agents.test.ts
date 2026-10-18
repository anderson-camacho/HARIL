import { describe, expect, it } from "vitest";
import type { AgentSpec, DelegationToolHandler, DelegationTurnInput } from "../src/ports/index.js";
import { FakeAgentRuntime, fakeScenarioOf } from "../testing/index.js";

// The fake workflow agents inside FakeAgentRuntime (phase F2): they read the turn input of their spec and call the
// host's delegation tools, correcting a refused call in the same turn, as the real agents will through Pi's bridge.

const clock = {
  now: () => 0,
  schedule: (_ms: number, run: () => void) => {
    void Promise.resolve().then(run);
    return () => undefined;
  },
};

const capacity: DelegationTurnInput["capacity"] = {
  activeChildrenMax: 5,
  queuedChildrenMax: 100,
  proposalsLeft: 3,
  agentsLeft: 99,
  tokensLeft: 1_000_000,
  live: {
    executors: { live: 0, max: 5 },
    auditors: { live: 0, max: 5 },
    delegators: { live: 0, max: 5 },
  },
  models: [],
};

function input(change: Partial<DelegationTurnInput>): DelegationTurnInput {
  return {
    workflowId: "wf-1",
    workflowGoal: "Ship it [fake:parts=3] [fake:steps=2] [fake:mistake]",
    role: "orchestrator",
    layer: 1,
    threadId: "th-1",
    label: "orchestrator",
    localId: null,
    turn: 1,
    turnKind: "first",
    goal: "Ship it",
    instructions: "",
    difficulty: null,
    memo: null,
    acceptanceCriteria: [],
    tests: null,
    files: { write: [], read: [] },
    children: [],
    previousVerdicts: [],
    subject: null,
    finalAudit: null,
    siblings: [],
    capacity,
    ...change,
  };
}

async function runTurn(
  agentRef: string,
  delegation: DelegationTurnInput,
  tools: DelegationToolHandler,
) {
  const runtime = new FakeAgentRuntime({ clock, delegationTools: tools });
  const spec: AgentSpec = {
    runId: "run-1",
    taskId: "t-1",
    attempt: 1,
    agentRef,
    allowedTools: ["read"],
    prompt: "",
    timeoutMs: 60_000,
    projectId: "p-1",
    delegation,
  };
  const started = await runtime.start(spec);
  if (!started.ok) throw new Error("not started");
  await started.value.prompt("");
  return started.value.settled;
}

describe("fake workflow agents", () => {
  it("reads the scenario from the workflow's goal", () => {
    expect(fakeScenarioOf("x")).toMatchObject({ parts: 2, steps: 2, seed: 1, mistake: false });
    expect(fakeScenarioOf("x").scenario.size).toBe(0);
    const named = fakeScenarioOf("x [fake:part-1/step-2=reject-twice] [fake:seed=7]");
    expect([...named.scenario]).toEqual([["part-1/step-2", "reject-twice"]]);
    expect(fakeScenarioOf("x [fake:seed=7]").scenario.size).toBeGreaterThan(0);
  });

  it("corrects a refused haril_delegate in the same turn and reports its tokens", async () => {
    const calls: { tool: string; models: unknown[] }[] = [];
    const tools: DelegationToolHandler = (_context, tool, payload) => {
      const delegations = (payload as { delegations: { model: unknown }[] }).delegations;
      calls.push({ tool, models: delegations.map((item) => item.model ?? null) });
      return calls.length === 1
        ? { ok: false, reason: 'child "part-3" proposes a model that is not in the catalog' }
        : { ok: true };
    };
    const outcome = await runTurn("fake:orchestrate", input({}), tools);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.models).toContain("fake/retired-model");
    expect(calls[1]?.models).toEqual([null, null, null]);
    expect(outcome).toMatchObject({ status: "succeeded", summary: "haril_delegate accepted" });
    expect(outcome.status === "succeeded" && outcome.usage?.tokensIn).toBeGreaterThan(0);
  });

  it("approves a complete result and rejects an incomplete one, citing the criterion", async () => {
    const verdicts: unknown[] = [];
    const tools: DelegationToolHandler = (_context, _tool, payload) => {
      verdicts.push(payload);
      return { ok: true };
    };
    for (const result of [
      "Step 1: done, test passing",
      "Step 1: partly done, the test still fails",
    ]) {
      await runTurn(
        "fake:audit",
        input({
          role: "auditor",
          layer: 3,
          label: "audit of part-1/step-1",
          acceptanceCriteria: ["Step 1 is implemented"],
          subject: { scope: "task", label: "part-1/step-1", goal: "Step 1", result, reports: [] },
        }),
        tools,
      );
    }
    expect(verdicts).toEqual([
      expect.objectContaining({ approved: true }),
      expect.objectContaining({
        approved: false,
        reasons: [expect.objectContaining({ criterion: "Step 1 is implemented", ok: false })],
      }),
    ]);
  });

  it("fails a workflow agent that has no delegation tools to call", async () => {
    const runtime = new FakeAgentRuntime({ clock });
    const started = await runtime.start({
      runId: "r",
      taskId: "t",
      attempt: 1,
      agentRef: "fake:delegate",
      allowedTools: ["read"],
      prompt: "",
      timeoutMs: 1000,
      projectId: "p",
      delegation: input({
        role: "delegator",
        layer: 2,
        localId: "part-1",
        instructions: "Split part 1 into 2 steps.",
      }),
    });
    if (!started.ok) throw new Error("not started");
    await started.value.prompt("");
    expect(await started.value.settled).toMatchObject({
      status: "failed",
      code: "fake.turn_failed",
    });
  });
});
