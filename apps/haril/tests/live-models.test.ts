import { sealSecret } from "@haril/contracts";
import type { Clock, Store, WorkflowRecord } from "@haril/core/ports";
import { type FakeOpenAiServer, startFakeOpenAiServer } from "@haril/gateway/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { storeAccess } from "../src/host.js";
import { readModelCatalog } from "../src/model-catalog.js";
import type { ProviderQuota } from "../src/quota-source.js";
import { createLiveModels } from "../src/runtime/live-models.js";
import { harness, makeSandbox, projectRoot, type Sandbox } from "./helpers.js";

// The models of real workflows while a runtime runs (docs/modos-y-delegacion.md 3.11; phase F6): the live catalog of the
// providers, the difficulty table expanded against it, the quota policy, and the background quota sampling that writes
// the readings to the store. A simulated workflow keeps the orchestrator's model for every child.

const KEY = "test-gateway-value";

let sb: Sandbox;
const stores: Store[] = [];
let upstream: FakeOpenAiServer | undefined;

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await upstream?.close();
  upstream = undefined;
  sb.cleanup();
});

describe("the model catalog", () => {
  it("lists every keyed provider's models as <provider>/<model>, and nothing for a provider without its key", async () => {
    upstream = await startFakeOpenAiServer({
      apiKey: KEY,
      models: [{ id: "Gemini1/gemini-3-flash", context_length: 1_048_576 }, "gemini-3-flash"],
    });
    const entries = await readModelCatalog(
      [
        { id: "cliproxy", baseUrl: upstream.baseUrl, keyEnv: "K", credential: sealSecret(KEY) },
        { id: "nokey", baseUrl: upstream.baseUrl, keyEnv: "MISSING", credential: undefined },
        { id: "down", baseUrl: "http://127.0.0.1:9/v1", credential: undefined },
      ],
      2000,
    );
    expect(entries.map((entry) => entry.ref)).toEqual([
      "cliproxy/Gemini1/gemini-3-flash",
      "cliproxy/gemini-3-flash",
    ]);
    expect(entries[0]).toMatchObject({ providerId: "cliproxy", contextWindow: 1_048_576 });
    // The fake answers ?client_version= with its plain listing: no level is invented.
    expect(entries[0]?.levels).toEqual([]);
    expect(upstream.requests.filter((request) => request.path === "/v1/models")).toHaveLength(1);
  });
});

function workflowOf(store: Store, agent: string): WorkflowRecord {
  run(
    [
      "project",
      "init",
      projectRoot(sb, `demo-${agent.replace(/\W/g, "")}`),
      "--name",
      "Demo",
      "--yes",
    ],
    harness().io,
    sb.host,
  );
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
      model: "cliproxy/Gemini1/gemini-3-pro",
      agent,
      autonomy: { mode: "autonomous", stops: [] },
      budgetTokens: 50_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: `wf-${agent}`,
    requestHash: `wf-${agent}`,
  });
  store.commands.applyNext(grant.value.epoch);
  store.runtime.release(grant.value.epoch, true);
  const workflow = store.workflows.list()[0];
  if (workflow === undefined) throw new Error("no workflow");
  return workflow;
}

describe("the live models of a runtime", () => {
  function setup() {
    run(
      ["project", "init", projectRoot(sb, "base"), "--name", "Base", "--yes"],
      harness().io,
      sb.host,
    );
    const store = storeAccess(sb.host).open(sb.dataDir);
    stores.push(store);
    let now = 1_800_000_000_000;
    const clock: Clock & { advance(ms: number): void } = {
      now: () => now,
      schedule: () => () => undefined,
      advance: (ms) => {
        now += ms;
      },
    };
    const quotaCalls: number[] = [];
    let quotaAnswer: ProviderQuota[] = [
      {
        providerId: "cliproxy",
        snapshot: {
          ok: true,
          sampledAt: now,
          source: "cliproxyapi-management/v0",
          accounts: [
            {
              credentialRef: "acct-000000000001",
              kind: "antigravity",
              prefix: "Gemini1",
              windows: [{ name: "5h", usedPct: 91, resetsAt: now + 3_600_000 }],
              note: null,
            },
          ],
        },
      },
    ];
    const live = createLiveModels({
      host: {
        ...sb.host,
        env: { ...sb.host.env, HARIL_CLIPROXYAPI_KEY: KEY },
      },
      store,
      clock,
      readCatalog: async () => [
        {
          ref: "cliproxy/Gemini1/gemini-3-flash",
          providerId: "cliproxy",
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          levels: ["low", "medium", "high"],
          defaultLevel: "medium",
        },
        {
          ref: "cliproxy/Gemini2/gemini-3-flash",
          providerId: "cliproxy",
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          levels: [],
          defaultLevel: null,
        },
      ],
      readQuota: async () => {
        quotaCalls.push(clock.now());
        return quotaAnswer;
      },
    });
    return {
      store,
      clock,
      live,
      quotaCalls,
      answer: (next: ProviderQuota[]) => {
        quotaAnswer = next;
      },
    };
  }

  it("gives a real workflow the catalog, the table expanded against it and each model's default level", async () => {
    const { store, clock, live } = setup();
    const workflow = workflowOf(store, "orchestrator");
    await live.ready(1000);
    const models = live.options.models;
    if (typeof models !== "function") throw new Error("live models are read at each decision");
    const context = models(clock.now(), workflow);
    expect(context.catalog.map((entry) => [entry.ref, entry.quotaKey, entry.hasKey])).toEqual([
      ["cliproxy/Gemini1/gemini-3-flash", "cliproxy/Gemini1", true],
      ["cliproxy/Gemini2/gemini-3-flash", "cliproxy/Gemini2", true],
    ]);
    // The provisional table's "*flash" follows the model on both accounts.
    expect(context.table.classes.easy.order).toEqual([
      "cliproxy/Gemini1/gemini-3-flash",
      "cliproxy/Gemini2/gemini-3-flash",
    ]);
    expect(context.policy.switchAtPercent5h).toBe(80);
    expect(live.options.levelOf?.("cliproxy/Gemini1/gemini-3-flash")).toBe("medium");
    expect(live.options.levelOf?.("cliproxy/Gemini2/gemini-3-flash")).toBeNull();
    await live.close();
  });

  it("keeps the orchestrator's model for every child of a simulated workflow", async () => {
    const { store, clock, live } = setup();
    const workflow = workflowOf(store, "fake:orchestrate");
    await live.ready(1000);
    const models = live.options.models;
    if (typeof models !== "function") throw new Error("live models are read at each decision");
    expect(models(clock.now(), workflow).catalog.map((entry) => entry.ref)).toEqual([
      "cliproxy/Gemini1/gemini-3-pro",
    ]);
    await live.close();
  });

  it("samples the quota in the background every 5 minutes, and stops for good after a refused key", async () => {
    const { store, clock, live, quotaCalls, answer } = setup();
    const workflow = workflowOf(store, "orchestrator");
    const models = live.options.models;
    if (typeof models !== "function") throw new Error("live models are read at each decision");
    models(clock.now(), workflow);
    await live.close();
    expect(quotaCalls).toHaveLength(1);
    expect(store.quota.latest(0).map((row) => [row.prefix, row.window, row.usedPct])).toEqual([
      ["Gemini1", "5h", 91],
      ["Gemini1", "7d", null],
    ]);
    // Within 5 minutes nothing is asked again.
    clock.advance(60_000);
    models(clock.now(), workflow);
    await live.close();
    expect(quotaCalls).toHaveLength(1);
    // A refused key stops the sampling: repeated failures would lock the address out.
    answer([
      {
        providerId: "cliproxy",
        snapshot: { ok: false, sampledAt: clock.now(), reason: "unauthorized", detail: "refused" },
      },
    ]);
    clock.advance(5 * 60_000);
    models(clock.now(), workflow);
    await live.close();
    clock.advance(10 * 60_000);
    models(clock.now(), workflow);
    await live.close();
    expect(quotaCalls).toHaveLength(2);
  });
});
