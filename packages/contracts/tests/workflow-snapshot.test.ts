import { describe, expect, it } from "vitest";
import {
  validateWorkflowSnapshot,
  type WorkflowNode,
  type WorkflowSnapshot,
} from "../src/index.js";

// WorkflowSnapshot v1 (docs/ADR-0021): the data of the orchestration view. null means "not available".

const node: WorkflowNode = {
  id: "e1",
  parentId: "d1",
  threadId: "t-e1",
  depth: 2,
  layer: 3,
  role: "executor",
  label: "E1",
  goal: "Create tintColor() in theme.ts",
  state: "running",
  model: "fast-model",
  modelSource: "table",
  thinkingLevel: null,
  tokens: 12000,
  elapsedMs: null,
  lastProgress: { at: 1000, text: "write src/theme.ts" },
  nextCheckAt: null,
  context: null,
  quota: { window5hPct: 38, weeklyPct: null },
  difficulty: { estimated: "easy", reason: "One function" },
  files: { write: ["src/theme.ts"], read: [] },
  memo: null,
  audit: null,
  waitingReason: null,
  turn: { index: 1, of: 1 },
};

const snapshot: WorkflowSnapshot = {
  schemaVersion: 1,
  demo: false,
  workflow: {
    id: "wf1",
    goal: "Change the primary button color and test it",
    state: "running",
    startedAt: 0,
    elapsedMs: 1000,
    autonomy: { mode: "stops", stops: ["after_plan"] },
    orchestratorModel: "high-model",
  },
  totals: {
    tokensUsed: 12000,
    tokensBudget: null,
    agentsCreated: 1,
    agentsCap: 100,
    queued: 0,
    retries: 0,
    escalations: 0,
  },
  capacity: {
    executors: { live: 1, max: 5 },
    auditors: { live: 0, max: 5 },
    delegators: { live: 0, max: 5 },
  },
  nodes: [node],
  quota: [
    {
      provider: "codex",
      credential: "account 1",
      window5hPct: null,
      weeklyPct: null,
      resetAt: null,
      note: "sin dato",
    },
  ],
  events: [{ at: 1000, type: "watchdog.checked", text: "e1 active" }],
  usage: [
    {
      at: 1000,
      kind: "agent_run",
      role: "executor",
      model: "fast-model",
      tokensIn: null,
      tokensOut: null,
      durationMs: null,
      difficulty: "easy",
      outcome: null,
    },
  ],
};

describe("validateWorkflowSnapshot", () => {
  it("returns the typed snapshot when it is valid, nulls included", () => {
    expect(validateWorkflowSnapshot(snapshot)).toEqual({ ok: true, snapshot });
  });

  it("reads the additive stop reason and explanations, and still reads a snapshot without them", () => {
    const explanation = {
      code: "ready_stopped",
      what: "Detenida",
      why: "after_plan",
      systemAction: "haril workflow continue wf-1",
      needsHuman: true,
      until: null,
    };
    const result = validateWorkflowSnapshot({
      ...snapshot,
      workflow: { ...snapshot.workflow, stopReason: "after_plan", explanation },
      nodes: [{ ...node, explanation }],
    });
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        workflow: { stopReason: "after_plan", explanation: { needsHuman: true } },
        nodes: [{ explanation: { code: "ready_stopped" } }],
      },
    });
    const broken = validateWorkflowSnapshot({
      ...snapshot,
      workflow: { ...snapshot.workflow, explanation: { code: "x" } },
    });
    expect(broken.ok).toBe(false);
  });

  it("carries an auditor target independently from its structural parent", () => {
    const auditor = { ...node, id: "a1", parentId: "d1", auditedId: "e1", role: "auditor" };
    const result = validateWorkflowSnapshot({ ...snapshot, nodes: [auditor] });
    expect(result).toMatchObject({
      ok: true,
      snapshot: { nodes: [{ parentId: "d1", auditedId: "e1" }] },
    });
  });

  it("rejects a node role or state outside the closed vocabulary", () => {
    for (const change of [
      { role: "boss" },
      { state: "sleeping" },
      { layer: 4 },
      { modelSource: "guess" },
    ]) {
      const result = validateWorkflowSnapshot({ ...snapshot, nodes: [{ ...node, ...change }] });
      expect(result.ok).toBe(false);
    }
  });

  it("reports the path of a missing field", () => {
    const { nextCheckAt: _gone, ...withoutNextCheck } = node;
    const result = validateWorkflowSnapshot({ ...snapshot, nodes: [withoutNextCheck] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.startsWith("/nodes/0"))).toBe(true);
  });

  it("rejects an unknown workflow state and a schema version other than 1", () => {
    const badState = { ...snapshot, workflow: { ...snapshot.workflow, state: "paused" } };
    expect(validateWorkflowSnapshot(badState).ok).toBe(false);
    expect(validateWorkflowSnapshot({ ...snapshot, schemaVersion: 2 }).ok).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    expect(validateWorkflowSnapshot({ ...snapshot, secret: "x" }).ok).toBe(false);
  });

  it("takes the integration branch of a workflow that writes, or null, or nothing (phase F8)", () => {
    const git = {
      baseBranch: "main",
      baseSha: "a".repeat(40),
      integrationBranch: "haril/wf1/integration",
      integrationHead: null,
      merged: 0,
      unmerged: [],
      worktrees: 2,
    };
    expect(validateWorkflowSnapshot({ ...snapshot, git }).ok).toBe(true);
    expect(validateWorkflowSnapshot({ ...snapshot, git: null }).ok).toBe(true);
    expect(validateWorkflowSnapshot({ ...snapshot, git: { ...git, pushed: true } }).ok).toBe(false);
    expect(validateWorkflowSnapshot({ ...snapshot, git: { ...git, merged: -1 } }).ok).toBe(false);
  });
});
