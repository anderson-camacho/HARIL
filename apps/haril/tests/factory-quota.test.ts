import { randomUUID } from "node:crypto";
import type { FactoryModel } from "@haril/contracts";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Clock, QuotaSnapshot, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFactoryQuota } from "../src/commands/factory-quota.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// The quota part of the factory's read model (feature haril-factory, F5): what each reading says, where it came from, and
// that nothing is made up when a provider gives nothing.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const clock: Clock = { now: () => NOW, schedule: () => () => undefined };
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

let sb: Sandbox;
let store: Store;

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

const READ: QuotaSnapshot = {
  ok: true,
  sampledAt: NOW - 60_000,
  source: "cliproxyapi-management/v8",
  accounts: [
    {
      credentialRef: "acct-aaa",
      kind: "antigravity",
      prefix: "Anti1",
      plan: "ultra",
      windows: [
        { name: "5h", usedPct: 90, resetsAt: NOW + HOUR },
        { name: "7d", usedPct: 40, resetsAt: NOW + 24 * HOUR },
        { name: "5h", usedPct: 90, resetsAt: NOW + HOUR, group: "Gemini" },
        { name: "7d", usedPct: 40, resetsAt: NOW + 24 * HOUR, group: "Gemini" },
        { name: "5h", usedPct: 5, resetsAt: NOW + 2 * HOUR, group: "Claude and GPT" },
      ],
      note: null,
    },
    {
      credentialRef: "acct-bbb",
      kind: "xai",
      prefix: "Grok",
      windows: [],
      note: "no usage probe for xai",
    },
    {
      credentialRef: "acct-ccc",
      kind: "claude",
      prefix: "Cl1",
      windows: [],
      note: "the usage endpoint answered HTTP 500",
    },
  ],
};

function agent(code: string, model: string, status = "running"): FactoryModel["agents"][number] {
  return {
    workflowId: "wf",
    code,
    role: "executor",
    status,
    taskId: code,
    task: "t",
    model,
    tokens: 0,
    elapsedMs: null,
    context: null,
    parent: null,
    depth: 1,
  };
}

function logUse(model: string, tokensIn: number, ts: number, extra = {}): void {
  store.usageLog.appendUsage({
    kind: "agent_run",
    modelRequested: model,
    modelServed: model,
    tokensIn,
    tokensOut: 10,
    startedAt: ts,
    outcome: "assigned",
    ...extra,
  });
}

describe("the factory's quota", () => {
  it("shows each group with an API reading and its reset", () => {
    store.quota.recordSnapshot("cliproxy", READ);
    const quota = buildFactoryQuota(store, NOW, []);
    const account = quota.accounts.find((row) => row.label === "Anti1");
    expect(account).toMatchObject({
      provider: "cliproxy",
      kind: "antigravity",
      plan: "ultra",
      readAt: NOW - 60_000,
    });
    const gemini = account?.groups.find((group) => group.name === "Gemini");
    expect(gemini?.window5h).toMatchObject({
      pct: 90,
      source: "api",
      stale: false,
      state: null,
      resetsAt: NOW + HOUR,
    });
    expect(gemini?.state).toContain("Evitada");
    const other = account?.groups.find((group) => group.name === "Claude and GPT");
    expect(other?.state).toBe("Disponible");
    // The provider reports the group's 5-hour window only.
    expect(other?.weekly).toMatchObject({ pct: null, source: "none", state: "No aplica" });
  });

  it("says when the provider does not let the data be seen", () => {
    store.quota.recordSnapshot("cliproxy", READ);
    const account = buildFactoryQuota(store, NOW, []).accounts.find((row) => row.label === "Grok");
    expect(account?.groups[0]?.window5h).toMatchObject({
      pct: null,
      source: "none",
      state: "El proveedor no permite ver este dato",
    });
  });

  it("says why an account could not be read", () => {
    store.quota.recordSnapshot("cliproxy", READ);
    const account = buildFactoryQuota(store, NOW, []).accounts.find((row) => row.label === "Cl1");
    expect(account?.groups[0]?.window5h.state).toBe(
      "Sin lectura: the usage endpoint answered HTTP 500",
    );
  });

  it("keeps the last value, marked stale, when the provider stops answering", () => {
    store.quota.recordSnapshot("cliproxy", READ);
    store.quota.recordSnapshot("cliproxy", {
      ok: false,
      sampledAt: NOW,
      reason: "unreachable",
      detail: "the management API is unreachable",
    });
    const account = buildFactoryQuota(store, NOW, []).accounts.find((row) => row.label === "Anti1");
    const gemini = account?.groups.find((group) => group.name === "Gemini");
    expect(gemini?.window5h).toMatchObject({
      pct: 90,
      source: "api",
      stale: true,
      state: "Sin lectura: el servidor de gestión no responde",
      readAt: NOW - 60_000,
    });
  });

  it("marks a reading too old to trust as stale", () => {
    store.quota.recordSnapshot("cliproxy", { ...READ, sampledAt: NOW - 2 * HOUR });
    const account = buildFactoryQuota(store, NOW, []).accounts.find((row) => row.label === "Anti1");
    expect(account?.groups[0]?.window5h).toMatchObject({ pct: 90, stale: true });
  });

  it("estimates from the usage log's tokens, and never invents a percentage", () => {
    store.quota.recordSnapshot("cliproxy", {
      ok: false,
      sampledAt: NOW,
      reason: "not_configured",
      detail: "CLIPROXYAPI_MANAGEMENT_KEY is not set",
    });
    logUse("cliproxy/Anti1/gpt-6.1-sol", 1_000, NOW - HOUR);
    logUse("cliproxy/Anti1/gpt-6.1-sol", 5_000, NOW - 6 * HOUR);
    const quota = buildFactoryQuota(store, NOW, []);
    const reading = quota.accounts.find((row) => row.label === "Anti1")?.groups[0];
    expect(reading?.window5h).toMatchObject({
      pct: null,
      source: "estimated",
      estimatedTokens: 1_010,
      state: "Sin lectura: falta la clave de gestión",
    });
    expect(reading?.weekly.estimatedTokens).toBe(6_020);
    expect(reading?.models).toEqual(["gpt-6.1-sol"]);
  });

  it("names a provider it knows nothing else about", () => {
    store.quota.recordSnapshot("cliproxy", {
      ok: false,
      sampledAt: NOW,
      reason: "unauthorized",
      detail: "refused",
    });
    expect(buildFactoryQuota(store, NOW, []).unread).toEqual([
      { provider: "cliproxy", state: "Sin lectura: el servidor rechazó la clave de gestión" },
    ]);
  });

  it("counts outcomes and cached tokens, and names who holds the account", () => {
    store.quota.recordSnapshot("cliproxy", READ);
    logUse("cliproxy/Anti1/gpt-6.1-sol", 100, NOW - HOUR, { tokensCached: 40 });
    logUse("cliproxy/Anti1/gpt-6.1-sol", 100, NOW - HOUR, { outcome: "failed" });
    logUse("cliproxy/Anti1/gpt-6.1-sol", 100, NOW - HOUR, { outcome: "provider_retry" });
    const account = buildFactoryQuota(store, NOW, [
      agent("e1", "cliproxy/Anti1/gpt-6.1-sol"),
      agent("e2", "cliproxy/Anti1/gpt-6.1-sol", "done"),
      agent("e3", "cliproxy/Grok/grok-5"),
    ]).accounts.find((row) => row.label === "Anti1");
    expect(account).toMatchObject({
      successes: 1,
      failures: 2,
      holders: ["e1"],
      cachedTokens: 40,
      inputTokens: 300,
    });
  });

  it("leaves cached tokens unknown when nothing reported them", () => {
    store.quota.recordSnapshot("cliproxy", READ);
    logUse("cliproxy/Anti1/gpt-6.1-sol", 100, NOW - HOUR);
    const account = buildFactoryQuota(store, NOW, []).accounts.find((row) => row.label === "Anti1");
    expect(account?.cachedTokens).toBeNull();
  });

  it("charts each group's 5-hour use over time", () => {
    store.quota.recordSnapshot("cliproxy", { ...READ, sampledAt: NOW - 2 * HOUR });
    store.quota.recordSnapshot("cliproxy", READ);
    const series = buildFactoryQuota(store, NOW, []).history.find(
      (row) => row.label === "Anti1 Gemini",
    );
    expect(series?.points).toEqual([
      { at: NOW - 2 * HOUR, pct: 90 },
      { at: NOW - 60_000, pct: 90 },
    ]);
  });

  it("never carries an address, even in a prefix", () => {
    store.quota.recordSnapshot("cliproxy", {
      ...READ,
      accounts: [
        {
          credentialRef: "acct-mail",
          kind: "claude",
          prefix: "person@example.com",
          windows: [],
          note: null,
        },
      ],
    });
    const text = JSON.stringify(buildFactoryQuota(store, NOW, []));
    expect(text).not.toContain("@");
    expect(text).toContain("claude acct-mail");
  });
});
