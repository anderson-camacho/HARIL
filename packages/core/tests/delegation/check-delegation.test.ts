import type { AssignInput, DelegateInput } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import {
  checkDelegation,
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_QUOTA_POLICY,
  type DelegationCaller,
  type DelegationLimits,
  type DelegationProposal,
  type DelegationState,
  type ProposedChild,
  proposalFromAssign,
  proposalFromDelegate,
} from "../../src/delegation/index.js";

// checkDelegation (docs/modos-y-delegacion.md 3.6): every rule rejects with its exact code, and limits come from the
// limits object. Each test starts from an accepted proposal and changes one thing.

const ORCHESTRATOR: DelegationCaller = { threadId: "o1", archetype: "orchestrator", depth: 1 };
const DELEGATOR: DelegationCaller = { threadId: "d1", archetype: "delegator", depth: 2 };

function child(localId: string, change: Partial<ProposedChild> = {}): ProposedChild {
  return {
    localId,
    dependsOn: [],
    difficulty: "easy",
    budgetTokens: 10_000,
    model: null,
    writeSurface: [],
    ...change,
  };
}

function proposal(change: Partial<DelegationProposal> = {}): DelegationProposal {
  return {
    tool: "haril_delegate",
    caller: ORCHESTRATOR,
    children: [child("a"), child("b", { dependsOn: ["a"] })],
    checkpoints: [],
    ...change,
  };
}

function state(
  change: {
    workflow?: Partial<DelegationState["workflow"]>;
    thread?: Partial<DelegationState["thread"]>;
    models?: Partial<DelegationState["models"]>;
  } = {},
): DelegationState {
  return {
    workflow: {
      state: "running",
      agentsCreated: 1,
      tokensCommitted: 0,
      autonomy: { mode: "stops", stops: ["after_plan"] },
      ...change.workflow,
    },
    thread: { queuedChildren: 0, proposals: 0, ...change.thread },
    models: {
      now: 0,
      catalog: [
        { ref: "cheap/a", quotaKey: "cheap", hasKey: true, coolingUntil: null },
        { ref: "mid/m", quotaKey: "mid", hasKey: true, coolingUntil: null },
      ],
      allow: {},
      pinned: {},
      quota: {},
      table: {
        classes: {
          trivial: { minSuccessRate: 0.7, order: ["cheap/a"] },
          easy: { minSuccessRate: 0.7, order: ["cheap/a"] },
          medium: { minSuccessRate: 0.8, order: ["mid/m"] },
          hard: { minSuccessRate: 0.8, order: ["mid/m"] },
          expert: { minSuccessRate: 0.9, order: ["mid/m"] },
        },
        models: { "cheap/a": { costTier: 1 }, "mid/m": { costTier: 2 } },
      },
      stats: {},
      policy: DEFAULT_QUOTA_POLICY,
      largeTaskTokens: 50_000,
      ...change.models,
    },
  };
}

function codes(result: ReturnType<typeof checkDelegation>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

const limitsWith = (change: Partial<DelegationLimits>): DelegationLimits => ({
  ...DEFAULT_DELEGATION_LIMITS,
  ...change,
});

describe("checkDelegation: accepted proposals", () => {
  it("accepts a valid haril_delegate and counts its children plus one continuation", () => {
    expect(checkDelegation(proposal(), state(), DEFAULT_DELEGATION_LIMITS)).toEqual({
      ok: true,
      childArchetype: "delegator",
      agentsToCreate: 3,
      tokensToCommit: 20_000,
      serialize: [],
      autonomy: { mode: "stops", stops: ["after_plan"] },
    });
  });

  it("counts an executor, its auditor and the delegator's continuation for haril_assign", () => {
    const result = checkDelegation(
      proposal({ tool: "haril_assign", caller: DELEGATOR }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result).toMatchObject({ ok: true, childArchetype: "executor", agentsToCreate: 5 });
  });

  it("adds the stops the agent asked for", () => {
    const result = checkDelegation(
      proposal({ checkpoints: ["at_end", "after_node:a"] }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result).toMatchObject({
      ok: true,
      autonomy: { mode: "stops", stops: ["after_plan", "at_end", "after_node:a"] },
    });
  });

  it("serializes siblings whose write surfaces overlap instead of rejecting them", () => {
    const children = [
      child("theme", { writeSurface: ["src/theme.ts"] }),
      child("docs", { writeSurface: ["docs/**"] }),
      child("button", { writeSurface: ["src/**"] }),
      child("readme", { writeSurface: ["*.md", "docs/readme.md"], dependsOn: ["docs"] }),
    ];
    const result = checkDelegation(
      proposal({ tool: "haril_assign", caller: DELEGATOR, children }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result).toMatchObject({ ok: true, serialize: [{ localId: "button", after: "theme" }] });
  });

  it("orders a serialization along the existing dependencies, so it never closes a cycle", () => {
    const children = [
      child("late", { writeSurface: ["src/a.ts"], dependsOn: ["early"] }),
      child("middle", { writeSurface: ["src/a.ts"] }),
      child("early", { writeSurface: ["lib/x.ts"] }),
    ];
    const result = checkDelegation(
      proposal({ tool: "haril_assign", caller: DELEGATOR, children }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result).toMatchObject({ ok: true, serialize: [{ localId: "late", after: "middle" }] });
  });
});

describe("checkDelegation: serialization chains", () => {
  it("adds no edge a chain already implies", () => {
    const children = [
      child("first", { writeSurface: ["src/**"] }),
      child("second", { writeSurface: ["src/a.ts"] }),
      child("third", { writeSurface: ["src/b.ts"], dependsOn: ["second"] }),
    ];
    const result = checkDelegation(
      proposal({ tool: "haril_assign", caller: DELEGATOR, children }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result).toMatchObject({ ok: true, serialize: [{ localId: "second", after: "first" }] });
  });
});

describe("checkDelegation: each rule of 3.6", () => {
  it("workflow_not_running: the workflow is stopped, paused or finished", () => {
    for (const workflowState of ["stopped", "awaiting_human", "completed", "failed"] as const) {
      const result = checkDelegation(
        proposal(),
        state({ workflow: { state: workflowState } }),
        DEFAULT_DELEGATION_LIMITS,
      );
      expect(codes(result)).toEqual(["workflow_not_running"]);
    }
  });

  it("tool_not_allowed: the caller's archetype may not use the tool", () => {
    const cases: DelegationProposal[] = [
      proposal({ caller: DELEGATOR }),
      proposal({ tool: "haril_assign", caller: ORCHESTRATOR }),
      proposal({
        tool: "haril_assign",
        caller: { threadId: "e1", archetype: "executor", depth: 3 },
      }),
      proposal({ tool: "haril_report", caller: DELEGATOR }),
    ];
    for (const value of cases) {
      const result = checkDelegation(value, state(), DEFAULT_DELEGATION_LIMITS);
      expect(codes(result)).toEqual(["tool_not_allowed"]);
    }
  });

  it("too_deep: the children would sit below the deepest layer", () => {
    const result = checkDelegation(
      proposal({ tool: "haril_assign", caller: DELEGATOR }),
      state(),
      limitsWith({ maxDepth: 2 }),
    );
    expect(codes(result)).toEqual(["too_deep"]);
    const deepCaller = { ...DELEGATOR, depth: 3 };
    expect(
      codes(
        checkDelegation(
          proposal({ tool: "haril_assign", caller: deepCaller }),
          state(),
          DEFAULT_DELEGATION_LIMITS,
        ),
      ),
    ).toEqual(["too_deep"]);
  });

  it("too_many_proposals: the thread already used its proposals", () => {
    expect(
      codes(
        checkDelegation(proposal(), state({ thread: { proposals: 3 } }), DEFAULT_DELEGATION_LIMITS),
      ),
    ).toEqual(["too_many_proposals"]);
    expect(
      codes(
        checkDelegation(
          proposal(),
          state({ thread: { proposals: 1 } }),
          limitsWith({ maxProposalsPerThread: 1 }),
        ),
      ),
    ).toEqual(["too_many_proposals"]);
    expect(
      checkDelegation(proposal(), state({ thread: { proposals: 2 } }), DEFAULT_DELEGATION_LIMITS)
        .ok,
    ).toBe(true);
  });

  it("too_many_queued: the thread's backlog would pass its limit", () => {
    expect(
      codes(
        checkDelegation(
          proposal(),
          state({ thread: { queuedChildren: 99 } }),
          DEFAULT_DELEGATION_LIMITS,
        ),
      ),
    ).toEqual(["too_many_queued"]);
    expect(
      checkDelegation(
        proposal(),
        state({ thread: { queuedChildren: 98 } }),
        DEFAULT_DELEGATION_LIMITS,
      ).ok,
    ).toBe(true);
  });

  it("workflow_agent_cap: the workflow would create more agents than its total", () => {
    expect(
      codes(
        checkDelegation(
          proposal(),
          state({ workflow: { agentsCreated: 98 } }),
          DEFAULT_DELEGATION_LIMITS,
        ),
      ),
    ).toEqual(["workflow_agent_cap"]);
    expect(
      checkDelegation(
        proposal(),
        state({ workflow: { agentsCreated: 97 } }),
        DEFAULT_DELEGATION_LIMITS,
      ).ok,
    ).toBe(true);
  });

  it("workflow_token_cap: the children's budgets would pass the workflow's tokens", () => {
    const result = checkDelegation(
      proposal(),
      state({ workflow: { tokensCommitted: 19_990_000 } }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(codes(result)).toEqual(["workflow_token_cap"]);
  });

  it("duplicate_task_id, unknown_dependency and cycle, with the local id in each issue", () => {
    const duplicate = proposal({ children: [child("a"), child("a")] });
    const unknown = proposal({ children: [child("a", { dependsOn: ["ghost"] })] });
    const cycle = proposal({
      children: [child("a", { dependsOn: ["b"] }), child("b", { dependsOn: ["a"] })],
    });
    expect(codes(checkDelegation(duplicate, state(), DEFAULT_DELEGATION_LIMITS))).toEqual([
      "duplicate_task_id",
    ]);
    const unknownResult = checkDelegation(unknown, state(), DEFAULT_DELEGATION_LIMITS);
    expect(unknownResult).toMatchObject({
      ok: false,
      issues: [{ code: "unknown_dependency", localId: "a" }],
    });
    const cycleResult = checkDelegation(cycle, state(), DEFAULT_DELEGATION_LIMITS);
    expect(cycleResult).toMatchObject({
      ok: false,
      issues: [{ code: "cycle", path: ["a", "b", "a"] }],
    });
  });

  it("model_not_allowed, model_unavailable and quota_blocked for a child's proposed model", () => {
    const notAllowed = checkDelegation(
      proposal({ children: [child("a", { model: "mid/m" })] }),
      state({ models: { allow: { delegator: ["cheap/a"] } } }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(notAllowed).toMatchObject({
      ok: false,
      issues: [{ code: "model_not_allowed", localId: "a" }],
    });
    const unavailable = checkDelegation(
      proposal({ children: [child("a", { model: "ghost/g" })] }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(codes(unavailable)).toEqual(["model_unavailable"]);
    const blocked = checkDelegation(
      proposal({ children: [child("a", { model: "mid/m" })] }),
      state({
        models: {
          quota: {
            mid: {
              available: true,
              window5hUsedPct: 91,
              window5hResetsAt: null,
              weeklyUsedPct: null,
              weeklyResetsAt: null,
            },
          },
        },
      }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(codes(blocked)).toEqual(["quota_blocked"]);
  });

  it("does not judge the parent's model when the user pinned the layer: the pin wins anyway", () => {
    const result = checkDelegation(
      proposal({ children: [child("a", { model: "ghost/g" })] }),
      state({ models: { pinned: { delegator: "mid/m" } } }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result.ok).toBe(true);
  });

  it("checkpoint_removes_stop: the agent asked to remove a stop", () => {
    const result = checkDelegation(
      proposal({ checkpoints: ["at_end", { remove: "after_plan" }] }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(codes(result)).toEqual(["checkpoint_removes_stop"]);
  });

  it("reports every independent problem at once, in a fixed order", () => {
    const result = checkDelegation(
      proposal({
        children: [child("a", { model: "ghost/g" }), child("a")],
        checkpoints: [{ remove: "after_plan" }],
      }),
      state({ thread: { proposals: 3, queuedChildren: 100 }, workflow: { agentsCreated: 100 } }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(codes(result)).toEqual([
      "too_many_proposals",
      "too_many_queued",
      "workflow_agent_cap",
      "duplicate_task_id",
      "model_unavailable",
      "checkpoint_removes_stop",
    ]);
  });

  it("gives the agent a readable reason it can act on", () => {
    const result = checkDelegation(
      proposal({ caller: DELEGATOR }),
      state(),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toContain("haril_delegate");
    expect(result.issues[0]?.message).toContain("delegator");
  });
});

describe("proposals from the tool inputs", () => {
  it("reads a haril_delegate input: no write surface, budget and model per delegation", () => {
    const input: DelegateInput = {
      schemaVersion: 1,
      memo: "",
      delegations: [
        {
          localId: "d1",
          goal: "g",
          description: "",
          difficulty: "hard",
          difficultyReason: "r",
          dependsOn: [],
          priority: 1,
          acceptanceCriteria: ["c"],
          model: "mid/m",
          budget: { maxTokens: 7 },
        },
      ],
      checkpoints: ["at_end"],
    };
    expect(proposalFromDelegate(ORCHESTRATOR, input)).toEqual({
      tool: "haril_delegate",
      caller: ORCHESTRATOR,
      children: [
        {
          localId: "d1",
          dependsOn: [],
          difficulty: "hard",
          budgetTokens: 7,
          model: "mid/m",
          writeSurface: [],
        },
      ],
      checkpoints: ["at_end"],
    });
  });

  it("reads a haril_assign input with its write surface and an absent model as null", () => {
    const input: AssignInput = {
      schemaVersion: 1,
      memo: "",
      assignments: [
        {
          localId: "e1",
          goal: "g",
          instructions: "i",
          files: { write: ["src/a.ts"], read: [] },
          tests: "",
          acceptanceCriteria: ["c"],
          difficulty: "easy",
          difficultyReason: "r",
          dependsOn: ["e0"],
          budget: { maxTokens: 9 },
        },
      ],
    };
    expect(proposalFromAssign(DELEGATOR, input).children).toEqual([
      {
        localId: "e1",
        dependsOn: ["e0"],
        difficulty: "easy",
        budgetTokens: 9,
        model: null,
        writeSurface: ["src/a.ts"],
      },
    ]);
    expect(proposalFromAssign(DELEGATOR, input).checkpoints).toEqual([]);
  });
});
