import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  type RunEvent,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { harness, makeSandbox, parseJson, type Sandbox } from "./helpers.js";

// Approvals in the runtime (LD-T3, ARCH 4.2, 4.3): each turn applies the decided approvals, a granted plan becomes a
// plan.submit, and a decision that is not applied yet keeps the runtime up within its idle window.
const EXAMPLE_VALID = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));

const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
let sb: Sandbox;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({
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
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

function projectOf(store: Store): string {
  return store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root }).projectId;
}

// A model makes it a planner proposal (LD-T7a): requested by a run, with the model of its task.
function proposeValid(store: Store, projectId: string, model?: string): string {
  const proposed = store.approvals.proposePlan({
    projectId,
    plan: JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")) as unknown,
    requestedBy: model === undefined ? "cli" : "run-planner",
    ...(model === undefined ? {} : { model }),
  });
  if (!proposed.ok) throw new Error("the example plan should be valid");
  return proposed.value.approval.approvalId;
}

function loop(store: Store, events: RunEvent[], idleExitMs: number) {
  return runUntilIdle({
    store,
    agentRuntime: new FakeAgentRuntime({ clock }),
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: (event) => events.push(event),
    idleExitMs,
    pollMs: 50,
    shutdown: createShutdown(),
  });
}

describe("approvals in the runtime (LD-T3)", () => {
  it("applies a granted plan during the idle window: its tasks are created and the runtime exits afterwards", async () => {
    const store = open();
    const projectId = projectOf(store);
    const approvalId = proposeValid(store, projectId);
    const events: RunEvent[] = [];
    const started = Date.now();
    const run = loop(store, events, 1_000);

    await new Promise((resolve) => setTimeout(resolve, 200));
    open().approvals.decide({ approvalId, outcome: "granted", decidedBy: "ana" });
    const result = await run;

    expect(result.kind).toBe("idle");
    expect(store.tasks.list()).toHaveLength(4);
    expect(events).toContainEqual({
      type: "approval.applied",
      approvalId,
      outcome: "granted",
      alreadySubmitted: false,
    });
    expect(store.approvals.get(approvalId)?.appliedAt).not.toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  }, 15_000);

  it("a denied decision is applied and creates nothing", async () => {
    const store = open();
    const projectId = projectOf(store);
    const approvalId = proposeValid(store, projectId);
    const events: RunEvent[] = [];
    const run = loop(store, events, 0);

    open().approvals.decide({ approvalId, outcome: "denied", decidedBy: "ana" });
    const result = await run;

    expect(result.kind).toBe("idle");
    expect(store.tasks.list()).toHaveLength(0);
    expect(events).toContainEqual({
      type: "approval.applied",
      approvalId,
      outcome: "denied",
      alreadySubmitted: false,
    });
  }, 15_000);

  it("granting a plan that was already submitted queues nothing new and says so", async () => {
    const store = open();
    const projectId = projectOf(store);
    const first = proposeValid(store, projectId);
    store.approvals.decide({ approvalId: first, outcome: "granted", decidedBy: "ana" });
    await loop(store, [], 0);
    expect(store.tasks.list()).toHaveLength(4);

    // The same plan proposed again is a new approval, but its plan.submit is the same request as the first one.
    const second = proposeValid(store, projectId);
    expect(second).not.toBe(first);
    store.approvals.decide({ approvalId: second, outcome: "granted", decidedBy: "ana" });
    const events: RunEvent[] = [];
    await loop(store, events, 0);

    expect(store.tasks.list()).toHaveLength(4);
    expect(events).toContainEqual({
      type: "approval.applied",
      approvalId: second,
      outcome: "granted",
      alreadySubmitted: true,
    });
    expect(store.approvals.get(second)?.appliedAt).not.toBeNull();
  }, 15_000);

  it("a pending approval with no decision does not keep the runtime up", async () => {
    const store = open();
    const projectId = projectOf(store);
    proposeValid(store, projectId);
    const started = Date.now();

    const result = await loop(store, [], 300);

    expect(result.kind).toBe("idle");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(store.tasks.list()).toHaveLength(0);
  }, 15_000);
});

// LD-T7a: a granted plan's tasks get the model of the task that proposed it. The plan.submit key and hash stay those of
// the plan alone, so `haril plan import` of the same plan and an approved one are one request: whichever is queued
// first creates the tasks, and the other is a duplicate, never a conflict.
describe("the model of an approved plan (LD-T7a)", () => {
  function modelsOf(store: Store): (string | null | undefined)[] {
    return store.tasks.list().map((task) => store.tasks.get(task.taskId)?.model);
  }

  function importExample(): { duplicate: boolean } {
    const h = harness();
    expect(
      run(["plan", "import", EXAMPLE_VALID, "--project", "demo", "--json"], h.io, sb.host),
    ).toBe(0);
    return parseJson<{ duplicate: boolean }>(h.out);
  }

  it("gives every task of a granted plan the model of the task that proposed it", async () => {
    const store = open();
    const approvalId = proposeValid(store, projectOf(store), "e2e-model");
    store.approvals.decide({ approvalId, outcome: "granted", decidedBy: "ana" });

    await loop(store, [], 0);

    expect(modelsOf(store)).toEqual(["e2e-model", "e2e-model", "e2e-model", "e2e-model"]);
  }, 15_000);

  it("a granted plan without a model creates tasks that name none", async () => {
    const store = open();
    const approvalId = proposeValid(store, projectOf(store));
    store.approvals.decide({ approvalId, outcome: "granted", decidedBy: "ana" });

    await loop(store, [], 0);

    expect(modelsOf(store)).toEqual([null, null, null, null]);
  }, 15_000);

  it("an approved plan with a model, then plan import of the same plan: a duplicate, the tasks keep the model", async () => {
    const store = open();
    const approvalId = proposeValid(store, projectOf(store), "e2e-model");
    store.approvals.decide({ approvalId, outcome: "granted", decidedBy: "ana" });
    await loop(store, [], 0);

    expect(importExample().duplicate).toBe(true);
    await loop(store, [], 0);

    expect(modelsOf(store)).toEqual(["e2e-model", "e2e-model", "e2e-model", "e2e-model"]);
  }, 15_000);

  it("plan import first, then the same plan approved with a model: a duplicate, no conflict, the tasks keep no model", async () => {
    const store = open();
    const projectId = projectOf(store);
    expect(importExample().duplicate).toBe(false);
    await loop(store, [], 0);

    const approvalId = proposeValid(store, projectId, "e2e-model");
    store.approvals.decide({ approvalId, outcome: "granted", decidedBy: "ana" });
    const events: RunEvent[] = [];
    await loop(store, events, 0);

    expect(events).toContainEqual({
      type: "approval.applied",
      approvalId,
      outcome: "granted",
      alreadySubmitted: true,
    });
    expect(modelsOf(store)).toEqual([null, null, null, null]);
  }, 15_000);
});
