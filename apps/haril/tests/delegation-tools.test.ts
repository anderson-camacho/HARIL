import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDelegationTools, type DelegationTools } from "../src/runtime/delegation-tools.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// The host side of the delegation tools (docs/modos-y-delegacion.md 3.4 to 3.6): only an open workflow turn may call,
// for itself; the tool must be its archetype's, the input must pass the contract and a proposal must pass
// checkDelegation; a turn decides once. Refusals carry a reason the agent can act on.

const clock: Clock = { now: () => Date.now(), schedule: () => () => undefined };
let sb: Sandbox;
let store: Store;
let tools: DelegationTools;
let epoch: number;
let projectId: string;

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
  });
  projectId = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
  const grant = store.runtime.acquire({
    pid: 1,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("no lease");
  epoch = grant.value.epoch;
  tools = createDelegationTools({ store, clock });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

function openOrchestratorTurn() {
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: { goal: "Ship it", model: "fake/high-model", agent: "fake:orchestrate" },
    idempotencyKey: "start",
    requestHash: "start",
  });
  const applied = store.commands.applyNext(epoch);
  const workflowId = applied?.workflowId as string;
  const claimed = store.tasks.claimTask(epoch, applied?.taskIds[0] as string);
  if (claimed === undefined) throw new Error("not claimed");
  const context = { projectId, taskId: claimed.taskId, runId: claimed.runId };
  const close = tools.open({ ...context, workflowId });
  return { context, close };
}

const delegation = (change: Record<string, unknown> = {}) => ({
  localId: "part-1",
  goal: "Part one",
  description: "Do part one.",
  difficulty: "easy",
  difficultyReason: "small",
  dependsOn: [],
  priority: 5,
  acceptanceCriteria: ["Part one is done"],
  model: null,
  budget: { maxTokens: 20_000 },
  ...change,
});
const delegate = (change: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  memo: "one part",
  delegations: [delegation(change)],
});

describe("the delegation tools of a workflow turn", () => {
  it("refuses a run that is not an open workflow turn", () => {
    const reply = tools.call({ projectId, taskId: "t", runId: "r" }, "haril_delegate", delegate());
    expect(reply).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a running workflow turn/),
    });
  });

  it("refuses a tool of another archetype, an unknown tool and a bad input, and keeps every refusal", () => {
    const { context, close } = openOrchestratorTurn();
    expect(tools.call(context, "haril_verdict", { approved: true, reasons: [] })).toMatchObject({
      ok: false,
      reason: "haril_verdict is not a tool of the orchestrator",
    });
    expect(tools.call(context, "haril_explode", {})).toMatchObject({
      ok: false,
      reason: 'unknown tool "haril_explode"',
    });
    expect(tools.call(context, "haril_delegate", { schemaVersion: 1 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^haril_delegate input: /),
    });
    const report = close();
    expect(report.action).toBeNull();
    expect(report.refusals).toHaveLength(3);
  });

  it("refuses the workspace tools to the orchestrator: they are never its own (F8)", async () => {
    const { context, close } = openOrchestratorTurn();
    expect(await tools.call(context, "haril_run", { command: "pnpm" })).toMatchObject({
      ok: false,
      reason: "haril_run is not a tool of the orchestrator",
    });
    expect(await tools.call(context, "haril_merge", { localId: "step-1" })).toMatchObject({
      ok: false,
      reason: "haril_merge is not a tool of the orchestrator",
    });
    expect(await tools.call(context, "write", { path: "a.ts", content: "x" })).toMatchObject({
      ok: false,
      reason: "write is not a tool of the orchestrator",
    });
    const report = close();
    expect(report.action).toBeNull();
    expect(report.refusals).toHaveLength(3);
  });

  it("checks a proposal with the Core rules and answers with the reason, so the agent can correct it", () => {
    const { context, close } = openOrchestratorTurn();
    const refused = tools.call(
      context,
      "haril_delegate",
      delegate({ model: "fake/retired-model" }),
    );
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^model_unavailable: /),
    });
    const accepted = tools.call(context, "haril_delegate", delegate());
    expect(accepted).toMatchObject({ ok: true, delegations: 1, agentsToCreate: 2 });
    const report = close();
    expect(report.action?.tool).toBe("haril_delegate");
    expect(report.refusals).toHaveLength(1);
    // Nothing is created while the turn runs: the call waits for the end of the turn.
    expect(store.workflows.list()[0]?.agentsCreated).toBe(1);
  });

  it("decides a turn once: the same call again is the same answer, any other call is refused", async () => {
    const { context, close } = openOrchestratorTurn();
    expect((await tools.call(context, "haril_delegate", delegate())).ok).toBe(true);
    expect(tools.call(context, "haril_delegate", delegate())).toMatchObject({
      ok: true,
      replay: true,
    });
    expect(tools.call(context, "haril_abort", { reason: "changed my mind" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already called haril_delegate/),
    });
    expect(close().action?.tool).toBe("haril_delegate");
    // A closed window takes no call.
    expect((await tools.call(context, "haril_delegate", delegate())).ok).toBe(false);
  });

  it("refuses a call once the workflow stopped running", () => {
    const { context } = openOrchestratorTurn();
    const workflowId = store.workflows.list()[0]?.workflowId as string;
    store.workflows.setState(epoch, { workflowId, state: "awaiting_human", reason: "after_plan" });
    expect(tools.call(context, "haril_delegate", delegate())).toMatchObject({
      ok: false,
      reason: "the workflow is awaiting_human; it takes no call",
    });
  });
});
