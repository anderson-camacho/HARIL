import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMMAND_ALLOW, type WorkflowSnapshot } from "@haril/contracts";
import type { Clock, Store, WorkflowRecord } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { runtimeDelegationOf } from "../src/commands/start.js";
import { storeAccess } from "../src/host.js";
import { createLiveModels } from "../src/runtime/live-models.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// The runtime and haril workflow start read haril.json's delegation section (docs/modos-y-delegacion.md 5, 3.11, 3.13,
// 3.16; phase F7): a workflow keeps the limits, the compaction thresholds, the default stops and the orchestrator's model
// it started with (P11); the runtime takes its limits and watchdog cadence at start; each decision reads the models
// pinned per layer, the allowed lists and whether an auditor avoids its executor's model.

let sb: Sandbox;
let h: Harness;
let config: string;
const stores: Store[] = [];

beforeEach(async () => {
  sb = makeSandbox();
  config = join(sb.root, "haril.json");
  await invoke([
    "project",
    "init",
    projectRoot(sb, "demo"),
    "--name",
    "Demo",
    "--slug",
    "demo",
    "--yes",
  ]);
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function host() {
  return { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: config } };
}

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, host());
}

function writeDelegation(delegation: unknown): void {
  writeFileSync(config, JSON.stringify({ delegation }));
}

// The runtime applies the queued workflow.start (and runs the fake agents as far as the workflow goes), then lists it.
async function onlyWorkflow(): Promise<WorkflowRecord> {
  expect(await invoke(["run"])).toBe(0);
  expect(await invoke(["workflow", "list", "--json"])).toBe(0);
  const [first] = parseJson<WorkflowRecord[]>(h.out);
  if (first === undefined) throw new Error("no workflow");
  return first;
}

describe("haril workflow start with haril.json's delegation section", () => {
  it("keeps the configured limits, thresholds, default stops and orchestrator model in the workflow", async () => {
    writeDelegation({
      limits: { maxActiveChildren: { delegator: 1 }, maxConcurrent: { executors: 1 } },
      context: { perLayer: { orchestrator: 400_000 } },
      autonomy: { defaultStops: ["at_end"] },
      models: { layers: { orchestrator: { model: "fake/configured-model", level: "high" } } },
    });
    expect(await invoke(["workflow", "start", "Ship it [fake:parts=2]"])).toBe(0);
    const workflow = await onlyWorkflow();
    expect(workflow.orchestratorModel).toBe("fake/configured-model");
    expect(workflow.autonomy).toEqual({ mode: "stops", stops: ["at_end"] });
    expect(workflow.limits).toMatchObject({
      maxActiveChildren: { orchestrator: 5, delegator: 1 },
      maxConcurrent: { executors: 1, auditors: 5 },
      maxAuditRetries: 1,
      context: { compactAtTokens: 300_000, perLayer: { orchestrator: 400_000 } },
    });

    expect(await invoke(["workflow", "show", workflow.workflowId, "--json"])).toBe(0);
    const snapshot = parseJson<WorkflowSnapshot>(h.out);
    expect(snapshot.capacity.executors.max).toBe(1);
    // The detail's context bar: each node against its layer's threshold.
    const node = (role: string) => snapshot.nodes.find((item) => item.role === role);
    expect(node("orchestrator")?.context?.threshold).toBe(400_000);
    expect(node("executor")?.context?.threshold).toBe(300_000);
    expect(node("executor")?.context?.used).toBeGreaterThan(0);
  });

  it("lets --model, --stop-at and --autonomous win over the configured values", async () => {
    writeDelegation({
      autonomy: { defaultStops: ["at_end"] },
      models: { layers: { orchestrator: { model: "fake/configured-model" } } },
    });
    expect(
      await invoke([
        "workflow",
        "start",
        "Job",
        "--model",
        "fake/given",
        "--stop-at",
        "after_plan",
      ]),
    ).toBe(0);
    const workflow = await onlyWorkflow();
    expect(workflow.orchestratorModel).toBe("fake/given");
    expect(workflow.autonomy).toEqual({ mode: "stops", stops: ["after_plan"] });
  });

  it("starts autonomous when the configured default stops are empty", async () => {
    writeDelegation({ autonomy: { defaultStops: [] } });
    expect(await invoke(["workflow", "start", "Job", "--model", "fake/m"])).toBe(0);
    expect((await onlyWorkflow()).autonomy).toEqual({ mode: "autonomous", stops: [] });
  });

  it("refuses to start with a haril.json the section rules refuse", async () => {
    writeDelegation({ limits: { maxEscalationsPerTask: 2 } });
    expect(await invoke(["workflow", "start", "Job", "--model", "fake/m"])).toBe(2);
    expect(h.err.join("\n")).toContain("/delegation/limits/maxEscalationsPerTask");
  });
});

describe("the runtime's delegation settings", () => {
  it("are haril.json's limits and watchdog cadence, read at start", () => {
    writeDelegation({
      limits: { maxConcurrent: { auditors: 2 }, maxAuditRetries: 0 },
      watchdog: { intervalMs: 300_000, idleStrikesToClose: 3 },
    });
    const read = runtimeDelegationOf(host());
    expect(read.warning).toBeUndefined();
    expect(read.limits.maxConcurrent.auditors).toBe(2);
    expect(read.limits.maxAuditRetries).toBe(0);
    expect(read.limits.maxDepth).toBe(3);
    expect(read.watchdog).toEqual({ intervalMs: 300_000, idleStrikesToClose: 3 });
  });

  it("give haril_run haril.json's allow list, time limit and output cap, else the defaults", () => {
    writeDelegation({});
    expect(runtimeDelegationOf(host()).commands).toEqual({
      allow: DEFAULT_COMMAND_ALLOW,
      timeoutMs: 300_000,
      outputMaxBytes: 16_384,
    });
    writeDelegation({
      commands: { allow: ["node --version"], timeoutMs: 60_000, outputMaxBytes: 4_096 },
    });
    expect(runtimeDelegationOf(host()).commands).toEqual({
      allow: ["node --version"],
      timeoutMs: 60_000,
      outputMaxBytes: 4_096,
    });
    // An empty list is the user's choice: no command at all.
    writeDelegation({ commands: { allow: [] } });
    expect(runtimeDelegationOf(host()).commands.allow).toEqual([]);
  });

  it("fall back to the defaults with a warning when the section is invalid", () => {
    writeDelegation({ watchdog: { intervalMs: 5 } });
    const read = runtimeDelegationOf(host());
    expect(read.warning).toContain("/delegation/watchdog/intervalMs");
    expect(read.watchdog).toEqual({ intervalMs: 900_000, idleStrikesToClose: 1 });
  });
});

describe("the models of a real workflow and haril.json", () => {
  it("pin each layer's configured model, keep the allowed lists and the auditor rule", async () => {
    writeFileSync(
      config,
      JSON.stringify({
        delegation: {
          models: {
            layers: { executor: { model: "cliproxy/Gemini2/gemini-3-flash", level: "low" } },
            allow: { auditor: ["cliproxy/Gemini1/gemini-3-flash"] },
            auditorDistinctFromExecutor: false,
          },
        },
      }),
    );
    const store = storeAccess(sb.host).open(sb.dataDir);
    stores.push(store);
    const grant = store.runtime.acquire({
      pid: process.pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 60_000,
    });
    if (!grant.ok) throw new Error("lease not granted");
    store.commands.enqueue({
      type: "workflow.start",
      projectId: store.projects.list()[0]?.projectId,
      args: {
        goal: "Answer from the notes",
        model: "cliproxy/Gemini1/gemini-3-flash",
        agent: "orchestrator",
        autonomy: { mode: "autonomous", stops: [] },
        budgetTokens: 50_000,
        timeoutMs: 60_000,
      },
      idempotencyKey: "wf-real",
      requestHash: "wf-real",
    });
    store.commands.applyNext(grant.value.epoch);
    store.runtime.release(grant.value.epoch, true);
    const workflow = store.workflows.list()[0] as WorkflowRecord;
    const clock: Clock = { now: () => 1_800_000_000_000, schedule: () => () => undefined };
    const live = createLiveModels({
      host: { ...host(), env: { ...host().env, HARIL_CLIPROXYAPI_KEY: "test-gateway-value" } },
      store,
      clock,
      readCatalog: async () =>
        ["cliproxy/Gemini1/gemini-3-flash", "cliproxy/Gemini2/gemini-3-flash"].map((ref) => ({
          ref,
          providerId: "cliproxy",
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          levels: ["low", "high"],
          defaultLevel: null,
        })),
      readQuota: async () => [],
    });
    await live.ready(2000);
    const models = live.options.models;
    if (typeof models !== "function") throw new Error("models are read at each decision");
    const context = models(clock.now(), workflow);
    expect(context.pinned).toEqual({
      orchestrator: null,
      delegator: null,
      executor: "cliproxy/Gemini2/gemini-3-flash",
      auditor: null,
    });
    expect(context.allow).toEqual({
      delegator: [],
      executor: [],
      auditor: ["cliproxy/Gemini1/gemini-3-flash"],
    });
    expect(context.auditorDistinctFromExecutor).toBe(false);
    expect(live.factsOf("cliproxy/Gemini2/gemini-3-flash")).toEqual({
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      levels: ["low", "high"],
    });
    await live.close();
  });
});
