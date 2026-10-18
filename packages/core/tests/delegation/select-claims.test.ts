import type { WorkflowState } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import {
  type ClaimCandidate,
  type ClaimSnapshot,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationArchetype,
  type DelegationLimits,
  globsMayOverlap,
  type LiveTask,
  selectClaims,
} from "../../src/delegation/index.js";
import { seededRandom } from "./random.js";

// selectClaims (docs/modos-y-delegacion.md 3.9): which ready tasks start now. Three levels of limits at once
// (simultaneous per role, live children per thread, workflow total), one writer at a time until F8, and never two
// tasks with overlapping write surfaces.

const PARENT_OF: Record<DelegationArchetype, DelegationArchetype | null> = {
  orchestrator: null,
  delegator: "orchestrator",
  executor: "delegator",
  auditor: "delegator",
};

let sequence = 0;

function ready(
  taskId: string,
  archetype: DelegationArchetype,
  parentThreadId: string | null,
  extra: Partial<ClaimCandidate> = {},
): ClaimCandidate {
  sequence += 1;
  return {
    taskId,
    threadId: `thread-${taskId}`,
    parentThreadId,
    parentArchetype: parentThreadId === null ? null : PARENT_OF[archetype],
    archetype,
    priority: 0,
    createdSeq: sequence,
    writeSurface: [],
    started: false,
    ...extra,
  };
}

function live(
  taskId: string,
  archetype: DelegationArchetype,
  parentThreadId: string | null,
  extra: Partial<LiveTask> = {},
): LiveTask {
  return {
    taskId,
    threadId: `thread-${taskId}`,
    parentThreadId,
    archetype,
    writeSurface: [],
    ...extra,
  };
}

function snapshot(change: Partial<ClaimSnapshot> = {}): ClaimSnapshot {
  return { workflowState: "running", ready: [], running: [], tasksStarted: 0, ...change };
}

function limits(change: {
  maxConcurrent?: Partial<DelegationLimits["maxConcurrent"]>;
  maxActiveChildren?: Partial<DelegationLimits["maxActiveChildren"]>;
  maxAgentsPerWorkflow?: number;
}): DelegationLimits {
  return {
    ...DEFAULT_DELEGATION_LIMITS,
    maxConcurrent: { ...DEFAULT_DELEGATION_LIMITS.maxConcurrent, ...change.maxConcurrent },
    maxActiveChildren: {
      ...DEFAULT_DELEGATION_LIMITS.maxActiveChildren,
      ...change.maxActiveChildren,
    },
    maxAgentsPerWorkflow:
      change.maxAgentsPerWorkflow ?? DEFAULT_DELEGATION_LIMITS.maxAgentsPerWorkflow,
  };
}

const claimed = (result: ReturnType<typeof selectClaims>) =>
  result.claims.map((claim) => claim.taskId);
const deferredAs = (result: ReturnType<typeof selectClaims>, reason: string) =>
  result.deferred.filter((entry) => entry.reason === reason).map((entry) => entry.taskId);

describe("selectClaims", () => {
  it("starts nothing when nothing is ready", () => {
    expect(selectClaims(snapshot(), DEFAULT_DELEGATION_LIMITS)).toEqual({
      claims: [],
      deferred: [],
    });
  });

  it("starts nothing while the workflow is not running", () => {
    for (const workflowState of [
      "awaiting_human",
      "stopped",
      "completed",
      "failed",
    ] as WorkflowState[]) {
      const result = selectClaims(
        snapshot({ workflowState, ready: [ready("e1", "executor", "d1")] }),
        DEFAULT_DELEGATION_LIMITS,
      );
      expect(result.claims).toEqual([]);
      expect(deferredAs(result, "workflow_not_running")).toEqual(["e1"]);
    }
  });

  it("orders by priority (highest first), then creation order, then task id", () => {
    const result = selectClaims(
      snapshot({
        ready: [
          ready("low", "executor", "d1", { priority: 1, createdSeq: 1 }),
          ready("high-late", "executor", "d2", { priority: 9, createdSeq: 5 }),
          ready("high-early", "executor", "d3", { priority: 9, createdSeq: 2 }),
          ready("b", "executor", "d4", { priority: 1, createdSeq: 1 }),
        ],
      }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(claimed(result)).toEqual(["high-early", "high-late", "b", "low"]);
  });

  it("caps live executors per workflow and keeps auditors as an independent limit", () => {
    const executors = Array.from({ length: 7 }, (_, index) =>
      ready(`e${index}`, "executor", `d${index}`),
    );
    const auditors = Array.from({ length: 3 }, (_, index) =>
      ready(`a${index}`, "auditor", `d${index}`),
    );
    const result = selectClaims(
      snapshot({ ready: [...executors, ...auditors] }),
      limits({ maxConcurrent: { executors: 5, auditors: 5 } }),
    );
    expect(claimed(result)).toEqual(["e0", "e1", "e2", "e3", "e4", "a0", "a1", "a2"]);
    expect(deferredAs(result, "role_limit")).toEqual(["e5", "e6"]);
  });

  it("counts running agents against the role limit", () => {
    const running = Array.from({ length: 4 }, (_, index) =>
      live(`r${index}`, "auditor", `d${index}`),
    );
    const result = selectClaims(
      snapshot({ running, ready: [ready("a8", "auditor", "d8"), ready("a9", "auditor", "d9")] }),
      limits({ maxConcurrent: { auditors: 5 } }),
    );
    expect(claimed(result)).toEqual(["a8"]);
    expect(deferredAs(result, "role_limit")).toEqual(["a9"]);
  });

  it("caps live delegators per workflow", () => {
    const delegators = Array.from({ length: 6 }, (_, index) =>
      ready(`d${index}`, "delegator", `o${index}`),
    );
    const result = selectClaims(
      snapshot({ ready: delegators }),
      limits({ maxConcurrent: { delegators: 5 } }),
    );
    expect(claimed(result)).toHaveLength(5);
    expect(deferredAs(result, "role_limit")).toEqual(["d5"]);
  });

  it("caps the live executors of one delegator thread and queues the rest", () => {
    const result = selectClaims(
      snapshot({
        running: [live("r1", "executor", "d1")],
        ready: Array.from({ length: 6 }, (_, index) => ready(`e${index}`, "executor", "d1")),
      }),
      limits({ maxActiveChildren: { delegator: 4 }, maxConcurrent: { executors: 50 } }),
    );
    expect(claimed(result)).toEqual(["e0", "e1", "e2"]);
    expect(deferredAs(result, "thread_limit")).toEqual(["e3", "e4", "e5"]);
  });

  it("caps the live delegators of the orchestrator thread", () => {
    const result = selectClaims(
      snapshot({
        ready: Array.from({ length: 7 }, (_, index) => ready(`d${index}`, "delegator", "o1")),
      }),
      limits({ maxActiveChildren: { orchestrator: 5 }, maxConcurrent: { delegators: 50 } }),
    );
    expect(claimed(result)).toHaveLength(5);
    expect(deferredAs(result, "thread_limit")).toEqual(["d5", "d6"]);
  });

  it("does not count auditors as live children of their delegator (reading L1)", () => {
    const result = selectClaims(
      snapshot({
        running: Array.from({ length: 4 }, (_, index) => live(`e${index}`, "executor", "d1")),
        ready: [ready("a0", "auditor", "d1"), ready("e9", "executor", "d1")],
      }),
      limits({ maxActiveChildren: { delegator: 4 } }),
    );
    expect(claimed(result)).toEqual(["a0"]);
    expect(deferredAs(result, "thread_limit")).toEqual(["e9"]);
  });

  it("starts one writer at a time with the default writer limit", () => {
    const result = selectClaims(
      snapshot({
        ready: [
          ready("w1", "executor", "d1", { writeSurface: ["src/a.ts"] }),
          ready("w2", "executor", "d2", { writeSurface: ["docs/b.md"] }),
          ready("reader", "executor", "d3"),
        ],
      }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(claimed(result)).toEqual(["w1", "reader"]);
    expect(deferredAs(result, "writer_limit")).toEqual(["w2"]);
  });

  it("runs disjoint writers together and overlapping writers in sequence", () => {
    const result = selectClaims(
      snapshot({
        running: [live("busy", "executor", "d9", { writeSurface: ["tests/**"] })],
        ready: [
          ready("w1", "executor", "d1", { writeSurface: ["src/**"] }),
          ready("w2", "executor", "d2", { writeSurface: ["src/theme.ts"] }),
          ready("w3", "executor", "d3", { writeSurface: ["docs/**"] }),
          ready("w4", "executor", "d4", { writeSurface: ["tests/button.test.ts"] }),
        ],
      }),
      limits({ maxConcurrent: { writers: 5 } }),
    );
    expect(claimed(result)).toEqual(["w1", "w3"]);
    expect(deferredAs(result, "surface_conflict")).toEqual(["w2", "w4"]);
  });

  it("never runs two turns of the same thread at once", () => {
    const result = selectClaims(
      snapshot({
        running: [live("d1-turn1", "delegator", "o1", { threadId: "thread-d1" })],
        ready: [
          ready("d1-turn2", "delegator", "o1", { threadId: "thread-d1" }),
          ready("d2-turn1", "delegator", "o1", { threadId: "thread-d2" }),
          ready("d2-turn2", "delegator", "o1", { threadId: "thread-d2" }),
        ],
      }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(claimed(result)).toEqual(["d2-turn1"]);
    expect(deferredAs(result, "thread_busy")).toEqual(["d1-turn2", "d2-turn2"]);
  });

  it("stops starting new tasks at the workflow total but lets a restarted task run", () => {
    const result = selectClaims(
      snapshot({
        tasksStarted: 99,
        ready: [
          ready("fresh1", "executor", "d1"),
          ready("fresh2", "executor", "d2"),
          ready("retry", "executor", "d3", { started: true }),
        ],
      }),
      limits({ maxAgentsPerWorkflow: 100 }),
    );
    expect(claimed(result)).toEqual(["fresh1", "retry"]);
    expect(deferredAs(result, "workflow_agent_cap")).toEqual(["fresh2"]);
  });

  it("gives the same answer whatever the order of its input", () => {
    const tasks = [
      ready("a", "executor", "d1", { priority: 3, writeSurface: ["src/**"] }),
      ready("b", "executor", "d1", { priority: 3, writeSurface: ["src/x.ts"] }),
      ready("c", "auditor", "d1", { priority: 1 }),
      ready("d", "delegator", "o1", { priority: 5 }),
    ];
    const first = selectClaims(snapshot({ ready: tasks }), DEFAULT_DELEGATION_LIMITS);
    const second = selectClaims(
      snapshot({ ready: [...tasks].reverse() }),
      DEFAULT_DELEGATION_LIMITS,
    );
    expect(second).toEqual(first);
  });
});

// Property tests: thousands of generated snapshots with a fixed seed. The running set may already exceed a limit
// (a limit lowered mid-run); selectClaims must then add nothing to that bucket.
describe("selectClaims properties", () => {
  const GLOBS = [
    "src/**",
    "src/a.ts",
    "src/b.ts",
    "src/*.ts",
    "docs/**",
    "tests/a.test.ts",
    "tests/**",
    "README.md",
    "*.md",
  ];
  const ARCHETYPE_LIST: DelegationArchetype[] = ["delegator", "executor", "auditor"];

  function generate(seed: number) {
    const random = seededRandom(seed);
    const limitSet = limits({
      maxConcurrent: {
        executors: random.int(0, 5),
        auditors: random.int(0, 5),
        delegators: random.int(0, 5),
        writers: random.int(0, 3),
      },
      maxActiveChildren: { orchestrator: random.int(0, 5), delegator: random.int(0, 4) },
      maxAgentsPerWorkflow: random.int(0, 40),
    });
    const threads = ["o1", "d1", "d2", "d3"];
    const surface = () =>
      random.bool(0.5) ? [] : Array.from({ length: random.int(1, 2) }, () => random.pick(GLOBS));
    const task = (index: number, prefix: string) => {
      const archetype = random.pick(ARCHETYPE_LIST);
      const parentThreadId = archetype === "delegator" ? "o1" : random.pick(threads.slice(1));
      return {
        taskId: `${prefix}${index}`,
        threadId: random.bool(0.2) ? `shared-${random.int(0, 3)}` : `thread-${prefix}${index}`,
        parentThreadId,
        archetype,
        writeSurface: surface(),
      };
    };
    const running: LiveTask[] = Array.from({ length: random.int(0, 8) }, (_, index) =>
      task(index, "r"),
    );
    const candidates: ClaimCandidate[] = Array.from({ length: random.int(0, 25) }, (_, index) => {
      const base = task(index, "c");
      return {
        ...base,
        parentArchetype: PARENT_OF[base.archetype],
        priority: random.int(0, 9),
        createdSeq: random.int(0, 50),
        started: random.bool(0.2),
      };
    });
    return {
      limits: limitSet,
      snapshot: snapshot({ running, ready: candidates, tasksStarted: random.int(0, 40) }),
      random,
    };
  }

  const ROLE_LIMIT: Record<DelegationArchetype, keyof DelegationLimits["maxConcurrent"] | null> = {
    orchestrator: null,
    delegator: "delegators",
    executor: "executors",
    auditor: "auditors",
  };

  function violations(
    candidate: ClaimCandidate,
    others: readonly LiveTask[],
    started: number,
    limitSet: DelegationLimits,
  ): string[] {
    const found: string[] = [];
    if (others.some((other) => other.threadId === candidate.threadId)) found.push("thread_busy");
    if (!candidate.started && started >= limitSet.maxAgentsPerWorkflow)
      found.push("workflow_agent_cap");
    const role = ROLE_LIMIT[candidate.archetype];
    if (
      role !== null &&
      others.filter((other) => other.archetype === candidate.archetype).length >=
        limitSet.maxConcurrent[role]
    ) {
      found.push("role_limit");
    }
    if (candidate.archetype !== "auditor" && candidate.parentArchetype !== null) {
      const parentLimit =
        candidate.parentArchetype === "orchestrator" || candidate.parentArchetype === "delegator"
          ? limitSet.maxActiveChildren[candidate.parentArchetype]
          : 0;
      const siblings = others.filter(
        (other) =>
          other.parentThreadId === candidate.parentThreadId && other.archetype !== "auditor",
      ).length;
      if (siblings >= parentLimit) found.push("thread_limit");
    }
    if (candidate.writeSurface.length > 0) {
      if (
        others.filter((other) => other.writeSurface.length > 0).length >=
        limitSet.maxConcurrent.writers
      ) {
        found.push("writer_limit");
      }
      const overlaps = others.some((other) =>
        other.writeSurface.some((left) =>
          candidate.writeSurface.some((right) => globsMayOverlap(left, right)),
        ),
      );
      if (overlaps) found.push("surface_conflict");
    }
    return found;
  }

  it("never exceeds a limit, never overlaps surfaces and never idles with capacity left", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const { limits: limitSet, snapshot: input } = generate(seed);
      const result = selectClaims(input, limitSet);
      const byId = new Map(input.ready.map((candidate) => [candidate.taskId, candidate]));
      const chosen = result.claims.map((claim) => byId.get(claim.taskId) as ClaimCandidate);

      // Every ready task is either claimed or deferred, exactly once.
      expect(result.claims.length + result.deferred.length, `seed ${seed}`).toBe(
        input.ready.length,
      );

      // Adding the chosen tasks one by one, none of them breaks a limit or overlaps what is already live.
      const liveSet: LiveTask[] = [...input.running];
      let started = input.tasksStarted;
      for (const candidate of chosen) {
        expect(
          violations(candidate, liveSet, started, limitSet),
          `seed ${seed} ${candidate.taskId}`,
        ).toEqual([]);
        liveSet.push(candidate);
        if (!candidate.started) started += 1;
      }

      // Every deferred task really breaks something against the final set, with the reported reason among them.
      for (const entry of result.deferred) {
        const candidate = byId.get(entry.taskId) as ClaimCandidate;
        const found = violations(candidate, liveSet, started, limitSet);
        expect(found, `seed ${seed} ${entry.taskId}`).toContain(entry.reason);
      }
    }
  });

  it("is deterministic under any permutation of its input", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { limits: limitSet, snapshot: input, random } = generate(seed);
      const expected = selectClaims(input, limitSet);
      const shuffled = {
        ...input,
        ready: random.shuffle(input.ready),
        running: random.shuffle(input.running),
      };
      expect(selectClaims(shuffled, limitSet), `seed ${seed}`).toEqual(expected);
    }
  });
});
