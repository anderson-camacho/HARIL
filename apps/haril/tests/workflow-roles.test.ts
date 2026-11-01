import { randomUUID } from "node:crypto";
import { DIFFICULTIES } from "@haril/contracts";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_QUOTA_POLICY,
  type DifficultyTable,
  type ModelSelectionContext,
} from "@haril/core";
import type { Clock, Store, WorkflowAutonomy } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFactoryModel } from "../src/commands/factory-model.js";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import type { DelegationOptions } from "../src/runtime/workflow-view.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// A role travels from the proposal to the launch (feature haril-factory, F6): the store keeps it in the proposal, the
// executor runs on the role's model, the choice is recorded, and a workflow with no role runs as before.

const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};
const AUTONOMOUS: WorkflowAutonomy = { mode: "autonomous", stops: [] };
const ORCHESTRATOR = "fake/opus-high";
const TABLE_MODEL = "cliproxy/A/gemini-3-flash";
const ROLE_MODEL = "cliproxy/B/claude-sonnet-4-6";
const AUDIT_MODEL = "cliproxy/C/claude-opus-4-6";

function classes(order: readonly string[]): DifficultyTable["classes"] {
  return Object.fromEntries(
    DIFFICULTIES.map((name) => [name, { minSuccessRate: 0, order: [...order] }]),
  ) as unknown as DifficultyTable["classes"];
}

function options(roles: ModelSelectionContext["roles"]): DelegationOptions {
  return {
    models: {
      catalog: [ORCHESTRATOR, TABLE_MODEL, ROLE_MODEL, AUDIT_MODEL].map((ref) => ({
        ref,
        quotaKey: ref.split("/").slice(0, 2).join("/"),
        hasKey: true,
        coolingUntil: null,
      })),
      allow: {},
      pinned: {},
      quota: {},
      table: { classes: classes([TABLE_MODEL, AUDIT_MODEL]), models: {} },
      stats: {},
      policy: DEFAULT_QUOTA_POLICY,
      ...(roles === undefined ? {} : { roles }),
    },
  };
}

let sb: Sandbox;
let store: Store;

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
  const { projectId } = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root });
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(sb.root),
      goal: "Report [fake:parts=1] [fake:steps=1]",
      model: ORCHESTRATOR,
      agent: "fake:orchestrate",
      autonomy: AUTONOMOUS,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: "wf",
    requestHash: "wf",
  });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

async function run(delegation: DelegationOptions, addRoles: boolean): Promise<void> {
  const tools = createDelegationTools({ store, clock, options: delegation });
  const call: typeof tools.call = (runId, name, input) => {
    const given = input as { assignments?: Record<string, unknown>[] };
    const changed =
      addRoles && given.assignments !== undefined
        ? {
            ...given,
            assignments: given.assignments.map((row) => ({
              ...row,
              role: "backend",
              auditorRole: "auditor",
            })),
          }
        : input;
    return tools.call(runId, name, changed);
  };
  const agents = new FakeAgentRuntime({ clock, delegationTools: call });
  await runUntilIdle({
    store,
    agentRuntime: agents,
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: () => undefined,
    idleExitMs: 0,
    pollMs: 20,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation,
  });
}

function turns() {
  const [workflow] = store.workflows.list();
  return store.workflows.tasks(workflow?.workflowId ?? "");
}

const ROLES: ModelSelectionContext["roles"] = {
  backend: { archetype: "executor", floor: "mid", order: [ROLE_MODEL] },
  auditor: { archetype: "auditor", floor: "high", order: [AUDIT_MODEL] },
};

describe("a task with a role", () => {
  it("runs on the role's model, and the choice says why", async () => {
    await run(options(ROLES), true);
    const executor = turns().find((task) => task.role === "executor");
    expect(executor?.model).toBe(ROLE_MODEL);
    const auditor = turns().find((task) => task.auditedTaskId === executor?.taskId);
    expect(auditor?.model).toBe(AUDIT_MODEL);
    const selected = store.events
      .list({ aggregateId: executor?.taskId ?? "" })
      .find((event) => event.type === "model.selected");
    expect(selected?.payload).toMatchObject({ reason: "role_order", role: "backend" });
  });

  it("shows its role in the factory's read model", async () => {
    await run(options(ROLES), true);
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(model.agents.map((agent) => agent.role)).toContain("backend");
    expect(model.tasks.map((task) => task.role)).toContain("backend");
  });
});

describe("a task with no role", () => {
  it("keeps the table's model even when profiles exist", async () => {
    await run(options(ROLES), false);
    expect(turns().find((task) => task.role === "executor")?.model).toBe(TABLE_MODEL);
  });

  it("keeps the table's model when a role's profile is off or absent", async () => {
    await run(options({}), true);
    expect(turns().find((task) => task.role === "executor")?.model).toBe(TABLE_MODEL);
  });
});
