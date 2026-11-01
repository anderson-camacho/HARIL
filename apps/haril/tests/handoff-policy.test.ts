import {
  COUNCIL_MIN_OPINIONS,
  councilProposalProblem,
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_QUOTA_POLICY,
  explainStop,
  type QuotaPolicy,
  quotaHoldsBack,
} from "@haril/core";
import type { Store } from "@haril/core/ports";
import { describe, expect, it } from "vitest";
import { noSuccessorStep, quotaPassed } from "../src/runtime/handoff.js";
import { checkLaunch } from "../src/runtime/model-launch.js";
import type { Task, WorkflowSettings, WorkflowView } from "../src/runtime/workflow-view.js";

const MODEL = "cliproxy/A/claude-haiku-5-5";

function settings(sample: unknown, policy: QuotaPolicy = DEFAULT_QUOTA_POLICY): WorkflowSettings {
  return {
    models: () => ({
      catalog: [{ ref: MODEL, quotaKey: "cliproxy/A", hasKey: true, coolingUntil: null }],
      quota: sample === undefined ? {} : { "cliproxy/A": sample },
      policy,
    }),
  } as unknown as WorkflowSettings;
}

function read(window5hUsedPct: number | null, weeklyUsedPct: number | null = null) {
  return {
    available: true,
    window5hUsedPct,
    window5hResetsAt: null,
    weeklyUsedPct,
    weeklyResetsAt: null,
  };
}

const task = { model: MODEL } as unknown as Task;

describe("when an account's quota sends an agent away", () => {
  const policy: QuotaPolicy = { ...DEFAULT_QUOTA_POLICY, switchAtPercent5h: 80 };

  it("answers exactly what the model choice answers at the boundary", () => {
    expect(quotaPassed(task, settings(read(80), policy), 0)).toBe(false);
    expect(quotaPassed(task, settings(read(80.5), policy), 0)).toBe(true);
    expect(quotaHoldsBack(read(80) as never, policy)).toBe(false);
    expect(quotaHoldsBack(read(81) as never, policy)).toBe(true);
  });

  it("honors the weekly window", () => {
    const weekly: QuotaPolicy = { ...policy, stopAtPercentWeekly: 70 };
    expect(quotaPassed(task, settings(read(10, 70), weekly), 0)).toBe(false);
    expect(quotaPassed(task, settings(read(10, 71), weekly), 0)).toBe(true);
    expect(quotaPassed(task, settings(read(null, 71), weekly), 0)).toBe(true);
  });

  it("honors the reserve", () => {
    const reserved: QuotaPolicy = {
      ...policy,
      switchAtPercent5h: 99,
      stopAtPercentWeekly: 99,
      reservePercent: 10,
    };
    expect(quotaPassed(task, settings(read(90), reserved), 0)).toBe(false);
    expect(quotaPassed(task, settings(read(91), reserved), 0)).toBe(true);
    expect(quotaPassed(task, settings(read(10, 91), reserved), 0)).toBe(true);
  });

  it("does not move on a broken reading or with no reading", () => {
    expect(quotaPassed(task, settings(read(Number.NaN)), 0)).toBe(false);
    expect(quotaPassed(task, settings(read(250)), 0)).toBe(false);
    expect(quotaPassed(task, settings(undefined), 0)).toBe(false);
    expect(quotaPassed(task, settings({ available: false, reason: "x" }), 0)).toBe(false);
  });
});

describe("when nothing can take a task over", () => {
  it("backs off further each time", () => {
    const delays = [0, 1, 2].map((blocks) => noSuccessorStep(blocks, 10, 1_000).retryAt - 1_000);
    expect(delays).toEqual([60_000, 120_000, 240_000]);
    expect(noSuccessorStep(9, 100, 0).retryAt).toBe(15 * 60_000);
  });

  it("stops and says so once it has tried as often as a task may hand over", () => {
    expect(noSuccessorStep(0, 3, 0).stop).toBe(false);
    expect(noSuccessorStep(1, 3, 0).stop).toBe(false);
    expect(noSuccessorStep(2, 3, 0).stop).toBe(true);
  });

  it("explains the stop in words", () => {
    const why = explainStop("handoff_no_successor:web/publicar");
    expect(why).toContain("web/publicar");
    expect(why).toContain("ningún modelo");
  });
});

describe("a sintetizador needs its council", () => {
  const limits = DEFAULT_DELEGATION_LIMITS;

  it("refuses a proposal with a sintetizador and fewer than the minimum", () => {
    expect(councilProposalProblem(["sintetizador"], limits)).toContain("at least 3");
    expect(councilProposalProblem(["consejero", "consejero", "sintetizador"], limits)).toContain(
      "at least 3",
    );
    expect(
      councilProposalProblem(["consejero", "consejero", "consejero", "sintetizador"], limits),
    ).toBeNull();
  });

  it("counts the councillors the thread already has", () => {
    expect(councilProposalProblem(["sintetizador"], limits, 3)).toBeNull();
    expect(councilProposalProblem(["sintetizador"], limits, 2)).toContain("at least 3");
    expect(councilProposalProblem(["backend"], limits)).toBeNull();
  });

  function launch(parent: string | null, council: { text: string | null }[]) {
    const stops: { state: string; reason: string }[] = [];
    const events: string[] = [];
    const store = {
      transaction: (work: () => void) => work(),
      events: { append: (event: { type: string }) => events.push(event.type) },
      workflows: { setState: (_epoch: number, input: never) => stops.push(input) },
    } as unknown as Store;
    const view = {
      workflow: { workflowId: "w", projectId: "p" },
      roleOf: () => "sintetizador",
      parentThreadId: () => parent,
      councillors: () => council.map((row, index) => ({ localId: `c${index}`, ...row })),
    } as unknown as WorkflowView;
    const verdict = checkLaunch(
      store,
      1,
      view,
      { taskId: "t", threadId: "s", role: "executor" } as unknown as Task,
      settings(undefined),
      5,
    );
    return { verdict, stops, events };
  }

  it.each([
    ["no council", "p", [], 0],
    ["no parent", null, [], 0],
    ["two opinions", "p", [{ text: "a" }, { text: "b" }, { text: " " }], 2],
  ])("does not launch with %s: it stops and says why", (_name, parent, council, valid) => {
    const { verdict, stops, events } = launch(parent, council);
    expect(verdict).toEqual({ kind: "deferred", until: 5 });
    expect(stops).toEqual([
      expect.objectContaining({
        state: "awaiting_human",
        reason: `council_below_minimum:${valid}/${COUNCIL_MIN_OPINIONS}`,
      }),
    ]);
    expect(events).toEqual(["council.below_minimum"]);
  });

  it("explains an empty council", () => {
    expect(explainStop("council_below_minimum:0/3")).toContain("no tiene consejo");
    expect(explainStop("council_below_minimum:2/3")).toContain("solo hay 2");
  });
});
