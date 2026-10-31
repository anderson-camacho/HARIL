import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type FactoryModel, isFactoryModel } from "@haril/contracts";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_AUTONOMY,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationLimits,
} from "@haril/core";
import type { Clock, Store, WorkflowAutonomy } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run as runCli } from "../src/cli.js";
import { buildFactoryModel } from "../src/commands/factory-model.js";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { harness, makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";
import { until } from "./process-helpers.js";

// The factory's read model across workflows, on the real store with the fake workflow agents, and `haril factory`.

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
const EXAMPLE_VALID = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));
const AUTONOMOUS: WorkflowAutonomy = { mode: "autonomous", stops: [] };

let sb: Sandbox;
const stores: Store[] = [];
let keySeq = 0;

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
    rules,
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

function register(store: Store, slug = "demo"): string {
  const existing = store.projects.getBySlug(slug);
  return (
    existing?.projectId ??
    store.projects.register({ slug, name: slug, rootPath: `${sb.root}/${slug}` }).projectId
  );
}

function start(
  store: Store,
  goal: string,
  autonomy: WorkflowAutonomy = AUTONOMOUS,
  slug = "demo",
): void {
  const projectId = register(store, slug);
  keySeq += 1;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(`${sb.root}/${slug}`),
      goal,
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy,
      limits: {},
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: `wf-${keySeq}`,
    requestHash: `wf-${keySeq}`,
  });
}

async function drain(store: Store, limits?: DelegationLimits): Promise<void> {
  const delegation = limits === undefined ? {} : { limits };
  const tools = createDelegationTools({ store, clock, options: delegation });
  const agents = new FakeAgentRuntime({
    clock,
    delegationTools: tools.call,
    delegationDelayMs: (cost) => Math.round((cost.durationMs / 60_000) * 0.2),
  });
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

function task(model: FactoryModel, agent: string) {
  const found = model.tasks.find((row) => row.agent === agent);
  if (found === undefined) throw new Error(`no task of ${agent}`);
  return found;
}

describe("buildFactoryModel", () => {
  it("is empty and valid on a store with no workflow", () => {
    const model = buildFactoryModel(open(), { now: 5 });
    expect(isFactoryModel(model)).toBe(true);
    expect(model).toMatchObject({ generatedAt: 5, project: null, tasks: [], humanRequests: [] });
  });

  it("puts the children of a stopped plan in detenidas, explains them, and asks the person", async () => {
    const store = open();
    start(store, "Careful [fake:parts=2] [fake:steps=1]", {
      mode: DEFAULT_AUTONOMY.mode,
      stops: [...DEFAULT_AUTONOMY.stops],
    });
    await drain(store);
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(isFactoryModel(model)).toBe(true);

    expect(model.tasks.map((row) => [row.agent, row.column])).toEqual([
      ["o1", "detenidas"],
      ["d1", "detenidas"],
      ["d2", "detenidas"],
    ]);
    const workflowId = model.workflows[0]?.id as string;
    for (const row of model.tasks.filter((item) => item.column === "detenidas")) {
      expect(row.explanation.systemAction, row.agent).toContain(
        `haril workflow continue ${workflowId}`,
      );
      expect(row.explanation.needsHuman, row.agent).toBe(true);
    }
    expect(model.humanRequests).toHaveLength(1);
    expect(model.humanRequests[0]).toMatchObject({
      kind: "stop",
      id: workflowId,
      workflowId,
      projectSlug: "demo",
    });
    expect(model.workflows[0]).toMatchObject({
      state: "awaiting_human",
      stopReason: "after_plan",
      closedTasks: 0,
      totalTasks: 3,
      criteria: null,
    });
    expect(task(model, "d1")).toMatchObject({ delegatedBy: "o1", returnedTo: null });
    expect(task(model, "o1")).toMatchObject({ delegatedBy: null, role: "orchestrator" });
    expect(model.edges).toEqual([
      { workflowId, parent: "o1", child: "d1" },
      { workflowId, parent: "o1", child: "d2" },
    ]);
    expect(model.agents.map((row) => [row.code, row.depth, row.parent])).toEqual([
      ["o1", 0, null],
      ["d1", 1, "o1"],
      ["d2", 1, "o1"],
    ]);
  });

  it("moves a completed workflow to hechas, with its closed tasks, tokens and criteria", async () => {
    const store = open();
    start(store, "Ship [fake:parts=1] [fake:steps=1]");
    await drain(store);
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(isFactoryModel(model)).toBe(true);
    expect(new Set(model.tasks.map((row) => row.column))).toEqual(new Set(["hechas"]));
    expect(model.humanRequests).toEqual([]);
    const [workflow] = model.workflows;
    expect(workflow?.state).toBe("completed");
    expect(workflow?.closedTasks).toBe(model.tasks.length);
    expect(workflow?.totalTasks).toBe(model.tasks.length);
    expect(workflow?.tokensUsed).toBeGreaterThan(0);
    const audited = task(model, "e1");
    expect(audited.criteria?.total).toBeGreaterThan(0);
    expect(audited.criteria?.passed).toBe(audited.criteria?.total);
    expect(audited.closedAt).not.toBeNull();
    expect(workflow?.criteria?.total).toBeGreaterThan(0);
    expect(model.events.length).toBeGreaterThan(0);
    expect(model.events.some((event) => event.agent !== null)).toBe(true);
    expect(model.events.every((event) => event.type !== "task.created")).toBe(true);
    const times = model.events.map((event) => event.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("puts a failed task in errores and says who it went back to", async () => {
    const store = open();
    start(store, "Fragile [fake:parts=2] [fake:steps=1] [fake:part-1/step-1=reject-once]");
    await drain(store, {
      ...DEFAULT_DELEGATION_LIMITS,
      maxAuditRetries: 0,
      maxEscalationsPerTask: 0,
    });
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(isFactoryModel(model)).toBe(true);
    const failed = model.tasks.filter((row) => row.column === "errores");
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect(row.returnedTo, row.agent).toBe(row.delegatedBy ?? "tú");
      expect(row.explanation.why, row.agent).not.toBe("");
    }
    expect(model.workflows[0]?.state).toBe("failed");
  });

  it("explains everything it holds: no task without an explanation, in any column", async () => {
    const store = open();
    start(store, "One [fake:parts=2] [fake:steps=2] [fake:part-1/step-1=reject-once]");
    await drain(store);
    const model = buildFactoryModel(store, { now: Date.now() });
    for (const row of model.tasks) {
      expect(row.explanation.what, row.agent).not.toBe("");
      expect(row.attempts, row.agent).toBeGreaterThanOrEqual(0);
    }
  });

  it("lists a requested approval as something the person must answer", () => {
    const store = open();
    const projectId = register(store);
    const proposed = store.approvals.proposePlan({
      projectId,
      plan: JSON.parse(readFileSync(EXAMPLE_VALID, "utf8")) as unknown,
      requestedBy: "cli",
    });
    expect(proposed.ok).toBe(true);
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(isFactoryModel(model)).toBe(true);
    expect(model.humanRequests).toHaveLength(1);
    const [request] = model.humanRequests;
    expect(request).toMatchObject({ kind: "approval", workflowId: null, projectSlug: "demo" });
    expect(request?.title).toContain("Plan de");
    expect(request?.explanation.needsHuman).toBe(true);
    expect(request?.explanation.systemAction).toContain(`haril approve ${request?.id}`);
  });

  it("keeps to one project when it is asked to", async () => {
    const store = open();
    start(store, "Here [fake:parts=1] [fake:steps=1]", AUTONOMOUS, "demo");
    start(store, "There [fake:parts=1] [fake:steps=1]", AUTONOMOUS, "other");
    await drain(store);
    const everything = buildFactoryModel(store, { now: Date.now() });
    expect(new Set(everything.workflows.map((row) => row.projectSlug))).toEqual(
      new Set(["demo", "other"]),
    );
    const project = store.projects.getBySlug("other");
    const one = buildFactoryModel(store, { now: Date.now(), ...(project ? { project } : {}) });
    expect(one.project).toBe("other");
    expect(one.workflows.map((row) => row.goal)).toEqual([expect.stringContaining("There")]);
    const ids = new Set(one.workflows.map((row) => row.id));
    expect(one.tasks.every((row) => ids.has(row.workflowId))).toBe(true);
    expect(one.events.every((row) => row.workflowId === null || ids.has(row.workflowId))).toBe(
      true,
    );
  });
});

describe("haril factory", () => {
  function seeded(): Store {
    const store = open();
    start(store, "Careful [fake:parts=1] [fake:steps=1]", {
      mode: DEFAULT_AUTONOMY.mode,
      stops: [...DEFAULT_AUTONOMY.stops],
    });
    return store;
  }

  it("show --json prints one valid model and refuses a project that does not exist", async () => {
    const store = seeded();
    await drain(store);
    const shown = harness();
    expect(await runCli(["factory", "show", "--json"], shown.io, sb.host)).toBe(0);
    const model: unknown = JSON.parse(shown.out.join(""));
    expect(isFactoryModel(model)).toBe(true);
    expect((model as FactoryModel).workflows).toHaveLength(1);

    const missing = harness();
    expect(await runCli(["factory", "show", "--project", "nope"], missing.io, sb.host)).not.toBe(0);
    expect(missing.err.join("")).toContain("nope");
  });

  it("show without --json prints the columns in words", async () => {
    const store = seeded();
    await drain(store);
    const shown = harness();
    expect(await runCli(["factory", "show"], shown.io, sb.host)).toBe(0);
    expect(shown.out.join("\n")).toContain("detenidas");
  });

  it("refuses an unknown subcommand and a store that was never created", async () => {
    const usage = harness();
    expect(await runCli(["factory", "nope"], usage.io, sb.host)).not.toBe(0);
    expect(usage.err.join("")).toContain("usage: haril factory");
    const none = harness();
    expect(await runCli(["factory", "show", "--json"], none.io, sb.host)).not.toBe(0);
  });

  it("watch prints a model at once, one on each change and none while nothing changes, until it is stopped", async () => {
    const store = seeded();
    const lines: FactoryModel[] = [];
    const signals = new EventEmitter();
    const host: HostInfo = {
      ...sb.host,
      signals,
      connectControl: async () => undefined,
    };
    const io = {
      out: (line: string) => lines.push(JSON.parse(line) as FactoryModel),
      err: () => undefined,
      readFile: () => "",
    };
    const done = Promise.resolve(
      runCli(["factory", "watch", "--json", "--interval-ms", "30"], io, host),
    );
    await until(() => lines.length === 1, "the first model", 5000);
    expect(isFactoryModel(lines[0])).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lines).toHaveLength(1);

    await drain(store);
    await until(
      () => lines.at(-1)?.workflows[0]?.state === "awaiting_human",
      "the model of the stop",
      5000,
    );

    signals.emit("SIGINT");
    expect(await done).toBe(0);
  });

  it("watch ends with its stdin under --exit-on-stdin-end and refuses a bad interval", async () => {
    const store = seeded();
    await drain(store);
    let endStdin: (() => void) | undefined;
    const host: HostInfo = {
      ...sb.host,
      signals: new EventEmitter(),
      connectControl: async () => undefined,
      onStdinEnd: (listener) => {
        endStdin = listener;
        return () => undefined;
      },
    };
    const silent = { out: () => undefined, err: () => undefined, readFile: () => "" };
    const done = Promise.resolve(
      runCli(["factory", "watch", "--exit-on-stdin-end", "--interval-ms", "30"], silent, host),
    );
    await until(() => endStdin !== undefined, "the stdin listener", 5000);
    endStdin?.();
    expect(await done).toBe(0);

    const bad = harness();
    expect(await runCli(["factory", "watch", "--interval-ms", "1"], bad.io, sb.host)).not.toBe(0);
  });
});
