import { describe, expect, it } from "vitest";
import {
  ARCHETYPES,
  archetypeTools,
  checkArchetypeTaskKind,
  childArchetypeOf,
  DEFAULT_DELEGATION_LIMITS,
  DELEGATION_ARCHETYPES,
  isDelegationArchetype,
  mayUseTool,
} from "../../src/delegation/index.js";

// Archetypes of docs/modos-y-delegacion.md 3.4 and the defaults of section 5.

describe("archetypes", () => {
  it("maps each archetype to its layer and existing task kind", () => {
    expect(DELEGATION_ARCHETYPES).toEqual(["orchestrator", "delegator", "executor", "auditor"]);
    expect(
      DELEGATION_ARCHETYPES.map((name) => [
        name,
        ARCHETYPES[name].layer,
        ARCHETYPES[name].taskKind,
      ]),
    ).toEqual([
      ["orchestrator", 1, "plan"],
      ["delegator", 2, "plan"],
      ["executor", 3, "work"],
      ["auditor", 3, "verify"],
    ]);
  });

  it("gives each archetype the bridge tools of the spec before writing exists", () => {
    expect(archetypeTools("orchestrator", { writes: false })).toEqual([
      "read",
      "haril_delegate",
      "haril_request_audit",
      "haril_abort",
    ]);
    expect(archetypeTools("delegator", { writes: false })).toEqual([
      "read",
      "haril_assign",
      "haril_report",
      "haril_run",
    ]);
    expect(archetypeTools("executor", { writes: false })).toEqual(["read"]);
    expect(archetypeTools("auditor", { writes: false })).toEqual([
      "read",
      "haril_run",
      "haril_verdict",
    ]);
  });

  it("adds the write tools only when writing is enabled (phase F8)", () => {
    expect(archetypeTools("delegator", { writes: true })).toContain("haril_merge");
    expect(archetypeTools("executor", { writes: true })).toEqual([
      "read",
      "write",
      "edit",
      "haril_run",
    ]);
    expect(archetypeTools("auditor", { writes: true })).not.toContain("write");
  });

  it("lets only the orchestrator delegate and only the delegator assign", () => {
    expect(mayUseTool("orchestrator", "haril_delegate", { writes: false })).toBe(true);
    expect(mayUseTool("delegator", "haril_delegate", { writes: false })).toBe(false);
    expect(mayUseTool("delegator", "haril_assign", { writes: false })).toBe(true);
    expect(mayUseTool("executor", "haril_assign", { writes: false })).toBe(false);
    expect(mayUseTool("auditor", "haril_verdict", { writes: false })).toBe(true);
    expect(mayUseTool("executor", "haril_verdict", { writes: false })).toBe(false);
    expect(mayUseTool("delegator", "haril_merge", { writes: false })).toBe(false);
  });

  it("names the child archetype of each proposing tool", () => {
    expect(childArchetypeOf("haril_delegate")).toBe("delegator");
    expect(childArchetypeOf("haril_assign")).toBe("executor");
    expect(childArchetypeOf("haril_report")).toBeNull();
    expect(ARCHETYPES.orchestrator.children).toEqual(["delegator"]);
    expect(ARCHETYPES.delegator.children).toEqual(["executor"]);
    expect(ARCHETYPES.executor.children).toEqual([]);
    expect(ARCHETYPES.auditor.children).toEqual([]);
  });

  it("recognizes the archetype names", () => {
    expect(isDelegationArchetype("auditor")).toBe(true);
    expect(isDelegationArchetype("planner")).toBe(false);
  });
});

describe("checkArchetypeTaskKind", () => {
  it("accepts the kind of the archetype", () => {
    expect(checkArchetypeTaskKind("orchestrator", "plan")).toEqual({ ok: true, kind: "plan" });
    expect(checkArchetypeTaskKind("auditor", "verify")).toEqual({ ok: true, kind: "verify" });
  });

  it("refuses any other kind with a reason that names the allowed one", () => {
    const result = checkArchetypeTaskKind("executor", "plan");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"work"');
    expect(checkArchetypeTaskKind("auditor", "summarize").ok).toBe(false);
    expect(checkArchetypeTaskKind("delegator", undefined).ok).toBe(false);
  });
});

describe("DEFAULT_DELEGATION_LIMITS", () => {
  it("holds the initial values of section 5 and reading L1", () => {
    expect(DEFAULT_DELEGATION_LIMITS).toEqual({
      maxActiveChildren: { orchestrator: 5, delegator: 4 },
      maxQueuedTasksPerThread: 100,
      maxProposalsPerThread: 3,
      maxConcurrent: { executors: 5, auditors: 5, delegators: 5, writers: 1 },
      maxAgentsPerWorkflow: 100,
      maxDepth: 3,
      maxAuditRetries: 1,
      maxEscalationsPerTask: 1,
      maxWorkflowTokens: 20_000_000,
      maxWorkflowWallMs: 7_200_000,
      largeTaskTokens: 50_000,
      attemptTimeoutMs: 3_600_000,
    });
  });

  it("is frozen, so no caller can change the shared defaults", () => {
    expect(Object.isFrozen(DEFAULT_DELEGATION_LIMITS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DELEGATION_LIMITS.maxConcurrent)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DELEGATION_LIMITS.maxActiveChildren)).toBe(true);
  });
});
