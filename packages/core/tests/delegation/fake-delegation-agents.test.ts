import { validateDelegationToolInput } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import { checkVerdict } from "../../src/delegation/index.js";
import {
  demoScenario,
  FAKE_DELEGATION_AGENT_REFS,
  fakeAudit,
  fakeDelegate,
  fakeExecute,
  fakeOrchestrate,
  isFakeDelegationAgentRef,
} from "../../testing/index.js";

// The simulated agents of the delegation (docs/modos-y-delegacion.md 9, F1): fake:orchestrate, fake:delegate,
// fake:execute and fake:audit. Deterministic: the same turn and seed always give the same call and the same cost, and
// every call they make passes the tool contracts.

describe("FAKE_DELEGATION_AGENT_REFS", () => {
  it("names the four simulated agents", () => {
    expect(FAKE_DELEGATION_AGENT_REFS).toEqual([
      "fake:orchestrate",
      "fake:delegate",
      "fake:execute",
      "fake:audit",
    ]);
    expect(isFakeDelegationAgentRef("fake:audit")).toBe(true);
    expect(isFakeDelegationAgentRef("fake:succeed")).toBe(false);
  });
});

describe("demoScenario", () => {
  it("places each scripted behavior on a distinct step, the same way for the same seed", () => {
    const scenario = demoScenario(1, 2, 3);
    expect(scenario).toEqual(demoScenario(1, 2, 3));
    const behaviors = [...scenario.values()].sort();
    expect(behaviors).toEqual(["reject-once", "reject-twice", "stall-once"]);
    expect(new Set(scenario.keys()).size).toBe(3);
    for (const key of scenario.keys()) expect(key).toMatch(/^part-[12]\/step-[123]$/);
  });

  it("drops behaviors when there are fewer steps than behaviors", () => {
    expect([...demoScenario(7, 1, 2).values()]).toHaveLength(2);
  });
});

describe("fakeOrchestrate", () => {
  const plan = {
    kind: "plan" as const,
    goal: "Ship the button",
    seed: 1,
    delegators: 2,
    executorsPerDelegator: 3,
  };

  it("delegates one part per delegator with a call that passes the haril_delegate contract", () => {
    const turn = fakeOrchestrate({ ...plan, previousRejection: [] });
    expect(turn.call.tool).toBe("haril_delegate");
    expect(validateDelegationToolInput("haril_delegate", turn.call.input).ok).toBe(true);
    if (turn.call.tool !== "haril_delegate") throw new Error("unexpected tool");
    expect(turn.call.input.delegations.map((item) => item.localId)).toEqual(["part-1", "part-2"]);
    expect(turn.cost.tokensIn).toBeGreaterThan(0);
    expect(fakeOrchestrate({ ...plan, previousRejection: [] })).toEqual(turn);
  });

  it("proposes a retired model on its first call and corrects it once the Core refuses it", () => {
    const first = fakeOrchestrate({ ...plan, previousRejection: [], makeMistake: true });
    if (first.call.tool !== "haril_delegate") throw new Error("unexpected tool");
    expect(first.call.input.delegations.at(-1)?.model).toBe("fake/retired-model");
    const second = fakeOrchestrate({
      ...plan,
      previousRejection: ["model_unavailable"],
      makeMistake: true,
    });
    if (second.call.tool !== "haril_delegate") throw new Error("unexpected tool");
    expect(second.call.input.delegations.every((item) => item.model === null)).toBe(true);
  });

  it("writes each part's scripted behaviors into its description, as data the delegator reads", () => {
    const turn = fakeOrchestrate({ ...plan, previousRejection: [] });
    if (turn.call.tool !== "haril_delegate") throw new Error("unexpected tool");
    const text = turn.call.input.delegations.map((item) => item.description).join(" ");
    expect(text.match(/\[demo:step-\d=[a-z-]+\]/g)).toHaveLength(3);
  });

  it("asks for the final audit in its continuation, naming what did not finish", () => {
    const turn = fakeOrchestrate({
      kind: "continuation",
      goal: "Ship the button",
      seed: 1,
      memo: "two parts",
      reports: [
        { localId: "part-1", status: "done", summary: "all steps approved", issues: [] },
        {
          localId: "part-2",
          status: "partial",
          summary: "one step failed",
          issues: ["step-2 failed its audit"],
        },
      ],
    });
    expect(turn.call).toEqual({
      tool: "haril_request_audit",
      input: {
        summary: "1 of 2 parts done; 1 partial or failed",
        outstanding: ["part-2: step-2 failed its audit"],
      },
    });
    expect(validateDelegationToolInput("haril_request_audit", turn.call.input).ok).toBe(true);
  });
});

describe("fakeDelegate", () => {
  const plan = {
    kind: "plan" as const,
    goal: "Ship the button: part 1 of 2",
    description: "Split part 1 into 3 steps. [demo:step-1=reject-once] [demo:step-3=stall-once]",
    seed: 1,
    partId: "part-1",
    executors: 3,
  };

  it("assigns its steps with a call that passes the haril_assign contract", () => {
    const turn = fakeDelegate(plan);
    expect(turn.call.tool).toBe("haril_assign");
    expect(validateDelegationToolInput("haril_assign", turn.call.input).ok).toBe(true);
    if (turn.call.tool !== "haril_assign") throw new Error("unexpected tool");
    const [one, two, three] = turn.call.input.assignments;
    expect(one?.instructions).toContain("[demo:reject-once]");
    expect(three?.instructions).toContain("[demo:stall-once]");
    expect(two?.instructions).not.toContain("[demo:");
    // The first two steps write the same file, so the Core serializes them; the others only read.
    expect(one?.files.write).toEqual(two?.files.write);
    expect(three?.files.write).toEqual([]);
  });

  it("reformulates an escalated step once, without its scripted behavior", () => {
    const turn = fakeDelegate({
      kind: "continuation",
      goal: plan.goal,
      seed: 1,
      partId: "part-1",
      reformulated: [],
      children: [
        { localId: "step-1", status: "done" },
        { localId: "step-2", status: "escalated" },
      ],
    });
    if (turn.call.tool !== "haril_assign") throw new Error(`unexpected ${turn.call.tool}`);
    expect(turn.call.input.assignments.map((item) => item.localId)).toEqual(["step-2"]);
    expect(turn.call.input.assignments[0]?.instructions).not.toContain("[demo:");
    expect(validateDelegationToolInput("haril_assign", turn.call.input).ok).toBe(true);
  });

  it("reports done, partial or failed from its children's outcomes", () => {
    const report = (
      children: { localId: string; status: "done" | "failed" | "escalated" }[],
      reformulated: string[] = [],
    ) =>
      fakeDelegate({
        kind: "continuation",
        goal: plan.goal,
        seed: 1,
        partId: "part-1",
        reformulated,
        children,
      }).call;
    expect(report([{ localId: "step-1", status: "done" }])).toMatchObject({
      tool: "haril_report",
      input: { status: "done", issues: [] },
    });
    expect(
      report([
        { localId: "step-1", status: "done" },
        { localId: "step-2", status: "failed" },
      ]),
    ).toMatchObject({
      tool: "haril_report",
      input: { status: "partial", issues: ["step-2 failed"] },
    });
    expect(report([{ localId: "step-1", status: "escalated" }], ["step-1"])).toMatchObject({
      tool: "haril_report",
      input: { status: "failed" },
    });
  });
});

describe("fakeExecute", () => {
  const base = {
    seed: 1,
    key: "e1",
    goal: "Step 1",
    instructions: "Do step 1.",
    reformulated: false,
  };

  it("completes plain work, with a deterministic cost", () => {
    const one = fakeExecute({ ...base, attempt: 1 });
    expect(one).toMatchObject({ outcome: "succeeded", complete: true });
    expect(fakeExecute({ ...base, attempt: 1 })).toEqual(one);
    if (one.outcome !== "succeeded") throw new Error("unexpected outcome");
    expect(one.cost.durationMs).toBeGreaterThanOrEqual(60_000);
    expect(one.cost.tokensOut).toBeGreaterThan(0);
  });

  it("follows its scripted behavior: rejected once, twice, or stalled once", () => {
    const run = (directive: string, attempt: number, reformulated = false) =>
      fakeExecute({ ...base, instructions: `Do it. [demo:${directive}]`, attempt, reformulated });
    expect(run("reject-once", 1)).toMatchObject({ outcome: "succeeded", complete: false });
    expect(run("reject-once", 2)).toMatchObject({ outcome: "succeeded", complete: true });
    expect(run("reject-twice", 2)).toMatchObject({ complete: false });
    expect(run("reject-twice", 3, true)).toMatchObject({ complete: true });
    expect(run("stall-once", 1)).toMatchObject({ outcome: "stalled" });
    expect(run("stall-once", 2)).toMatchObject({ outcome: "succeeded", complete: true });
  });
});

describe("fakeAudit", () => {
  const criteria = ["Step 1 is implemented", "Its test passes"];

  it("approves complete work, citing every criterion", () => {
    const turn = fakeAudit({
      seed: 1,
      key: "a1",
      scope: "task",
      acceptanceCriteria: criteria,
      complete: true,
    });
    expect(turn.verdict).toEqual({
      approved: true,
      reasons: criteria.map((criterion) => ({ criterion, ok: true, evidence: expect.any(String) })),
    });
    expect(validateDelegationToolInput("haril_verdict", turn.verdict).ok).toBe(true);
  });

  it("rejects incomplete work with a reason that names an unmet criterion", () => {
    const turn = fakeAudit({
      seed: 1,
      key: "a1",
      scope: "task",
      acceptanceCriteria: criteria,
      complete: false,
    });
    expect(turn.verdict.approved).toBe(false);
    expect(turn.verdict.reasons[0]).toMatchObject({ criterion: criteria[0], ok: false });
    expect(checkVerdict(turn.verdict)).toEqual({ ok: true });
  });
});
