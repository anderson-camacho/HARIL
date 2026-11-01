import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_QUOTA_POLICY,
  DEFAULT_WATCHDOG_POLICY,
} from "@haril/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostInfo } from "../src/context.js";
import { loadDelegationSettings } from "../src/delegation-config.js";
import { delegationFieldsOf, delegationLimitsOf } from "../src/delegation-section.js";
import { loadProviderConfig } from "../src/providers.js";

// haril.json's whole `delegation` section (docs/modos-y-delegacion.md 5; phase F7): section 5's defaults, strict
// validation with each JSON path (unknown keys and key-like names refused at any depth), the anti-rework caps, and the
// source of every value (the file or the default). No network here.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-delegation-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function hostWith(config: unknown): HostInfo {
  const path = join(root, "haril.json");
  if (config !== undefined) writeFileSync(path, JSON.stringify(config));
  return {
    nodeVersion: "v24.21.0",
    platform: "linux",
    arch: "x64",
    homeDir: root,
    env: {
      HARIL_HOME: join(root, "data"),
      ...(config === undefined ? {} : { HARIL_CONFIG: path }),
    },
  };
}

function errorsOf(section: unknown): string[] {
  const loaded = loadDelegationSettings(hostWith({ delegation: section }));
  return loaded.ok ? [] : loaded.errors;
}

describe("the delegation section's defaults", () => {
  it("are section 5's values without a file, and the runtime's own defaults agree with them", () => {
    const loaded = loadDelegationSettings(hostWith(undefined));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const { settings } = loaded;
    expect(settings.context).toEqual({ compactAtTokens: 300_000, perLayer: {} });
    expect(settings.limits.maxActiveChildren).toEqual({ orchestrator: 5, delegator: 4 });
    // Writers follow the executors unless the file sets them (phase F8: each writer has its own worktree).
    expect(settings.limits.maxConcurrent).toEqual({ executors: 5, auditors: 5, delegators: 5 });
    expect(settings.autonomy.defaultStops).toEqual(["after_plan"]);
    expect(settings.research.folder).toBe("docs/investigacion");
    expect(settings.models.layers.executor).toEqual({ model: null, level: null });
    expect(settings.models.auditorDistinctFromExecutor).toBe(true);
    // One set of numbers: the core's defaults are the section's defaults, except the writers, which follow the
    // executors (the core keeps 1 for a workflow without a snapshot of its own).
    expect(delegationLimitsOf(settings.limits)).toEqual({
      ...DEFAULT_DELEGATION_LIMITS,
      maxConcurrent: { ...DEFAULT_DELEGATION_LIMITS.maxConcurrent, writers: 5 },
    });
    expect({
      intervalMs: settings.watchdog.intervalMs,
      idleStrikesToClose: settings.watchdog.idleStrikesToClose,
    }).toEqual(DEFAULT_WATCHDOG_POLICY);
    const {
      source: _source,
      managementBaseUrl: _url,
      managementKeyEnv: _env,
      colorWarnPercent: _warn,
      colorDangerPercent: _danger,
      ...policy
    } = settings.quota;
    expect(policy).toEqual(DEFAULT_QUOTA_POLICY);
  });

  it("let the writers follow the executors unless the file sets the writers", () => {
    const follow = loadDelegationSettings(
      hostWith({ delegation: { limits: { maxConcurrent: { executors: 3 } } } }),
    );
    expect(follow.ok && delegationLimitsOf(follow.settings.limits).maxConcurrent.writers).toBe(3);
    const own = loadDelegationSettings(
      hostWith({ delegation: { limits: { maxConcurrent: { executors: 3, writers: 1 } } } }),
    );
    expect(own.ok && delegationLimitsOf(own.settings.limits).maxConcurrent.writers).toBe(1);
  });

  it("are the same for a file without the section", () => {
    const loaded = loadDelegationSettings(hostWith({ ui: { theme: "haril-dark" } }));
    expect(loaded.ok && loaded.settings.limits.maxAuditRetries).toBe(1);
  });
});

describe("a full delegation section", () => {
  const full = {
    limits: {
      maxActiveChildren: { orchestrator: 3, delegator: 2 },
      maxConcurrent: { executors: 4, auditors: 2, delegators: 3, writers: 1 },
      maxAuditRetries: 0,
      maxEscalationsPerTask: 1,
      attemptTimeoutMs: 600_000,
    },
    context: { compactAtTokens: 250_000, perLayer: { orchestrator: 400_000 } },
    models: {
      layers: {
        orchestrator: { model: "cliproxy/Gemini1/gemini-3-flash", level: "high" },
        executor: { model: null, level: "low" },
      },
      allow: { executor: ["cliproxy/Gemini1/gemini-3-flash"] },
      auditorDistinctFromExecutor: false,
    },
    quota: { switchAtPercent5h: 70 },
    autonomy: { defaultStops: ["after_plan", "at_end"] },
    watchdog: { intervalMs: 600_000, idleStrikesToClose: 2, closeResidualImmediately: true },
    commands: { allow: ["pnpm test"] },
    research: { folder: "notes/research/" },
  };

  it("is accepted, and every value it sets applies over the defaults", () => {
    const loaded = loadDelegationSettings(hostWith({ delegation: full }));
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
    if (!loaded.ok) return;
    const { settings } = loaded;
    expect(settings.limits.maxActiveChildren).toEqual({ orchestrator: 3, delegator: 2 });
    expect(settings.limits.maxAuditRetries).toBe(0);
    expect(settings.limits.maxWorkflowTokens).toBe(20_000_000);
    expect(settings.context).toEqual({
      compactAtTokens: 250_000,
      perLayer: { orchestrator: 400_000 },
    });
    expect(settings.models.layers.orchestrator).toEqual({
      model: "cliproxy/Gemini1/gemini-3-flash",
      level: "high",
    });
    expect(settings.models.layers.executor).toEqual({ model: null, level: "low" });
    expect(settings.models.layers.delegator).toEqual({ model: null, level: null });
    expect(settings.models.allow).toEqual({
      delegator: [],
      executor: ["cliproxy/Gemini1/gemini-3-flash"],
      auditor: [],
    });
    expect(settings.quota.switchAtPercent5h).toBe(70);
    expect(settings.quota.stopAtPercentWeekly).toBe(80);
    expect(settings.watchdog).toEqual({
      intervalMs: 600_000,
      idleStrikesToClose: 2,
      closeResidualImmediately: true,
    });
    expect(settings.commands.allow).toEqual(["pnpm test"]);
    expect(settings.research.folder).toBe("notes/research/");
  });

  it("is accepted by the provider loader too, which reads the same file", () => {
    const loaded = loadProviderConfig(hostWith({ delegation: full }));
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
  });

  it("names the source of every value, and a per-layer threshold inherits the general one", () => {
    const fields = delegationFieldsOf({ delegation: full });
    const field = (path: string) => fields.find((item) => item.path === path);
    expect(field("delegation.limits.maxActiveChildren.orchestrator")).toMatchObject({
      value: 3,
      default: 5,
      source: "file",
    });
    expect(field("delegation.limits.maxAgentsPerWorkflow")).toMatchObject({
      value: 100,
      source: "default",
    });
    expect(field("delegation.context.perLayer.orchestrator")).toMatchObject({
      value: 400_000,
      source: "file",
    });
    expect(field("delegation.context.perLayer.executor")).toMatchObject({
      value: 250_000,
      default: null,
      source: "default",
    });
    expect(field("delegation.models.layers.orchestrator.level")).toMatchObject({
      value: "high",
      effect: "next agent launch",
    });
  });
});

describe("the validation of the delegation section", () => {
  it("refuses more than 1 relaunch or 1 escalation (anti-rework)", () => {
    const errors = errorsOf({ limits: { maxAuditRetries: 2, maxEscalationsPerTask: 3 } });
    expect(errors).toEqual([
      "/delegation/limits/maxAuditRetries: must be a whole number from 0 to 1 (anti-rework: at most 1 relaunch and 1 escalation)",
      "/delegation/limits/maxEscalationsPerTask: must be a whole number from 0 to 1 (anti-rework: at most 1 relaunch and 1 escalation)",
    ]);
  });

  it("refuses unknown keys at any depth, each with its JSON path", () => {
    expect(
      errorsOf({
        limitz: {},
        limits: { maxChildren: 3, maxActiveChildren: { planner: 1 } },
        context: { perLayer: { planner: 400_000 } },
        models: { layers: { executor: { model: null, budget: 1 } } },
      }),
    ).toEqual([
      "/delegation/limitz: unknown key",
      "/delegation/limits/maxChildren: unknown key",
      "/delegation/limits/maxActiveChildren/planner: unknown key",
      "/delegation/context/perLayer/planner: unknown key",
      "/delegation/models/layers/executor/budget: unknown key",
    ]);
  });

  it("refuses a key-like name anywhere: keys are never stored in haril.json", () => {
    expect(errorsOf({ quota: { managementKey: "x" }, models: { apiKey: "x" } })).toEqual([
      "/delegation/quota/managementKey: keys are never stored in haril.json; use managementKeyEnv",
      "/delegation/models/apiKey: keys are never stored in haril.json",
    ]);
  });

  it("checks every value against its field", () => {
    expect(
      errorsOf({
        context: { compactAtTokens: "300k", perLayer: { auditor: 1_000 } },
        limits: { maxConcurrent: { executors: 0 } },
        models: {
          layers: { auditor: { model: "has space", level: "ultra" } },
          allow: { executor: "one" },
          auditorDistinctFromExecutor: "yes",
        },
        quota: { stopAtPercentWeekly: 120, managementBaseUrl: "ftp://x" },
        watchdog: { closeResidualImmediately: false, intervalMs: 1_000 },
        autonomy: { defaultStops: ["nope"] },
        commands: { allow: ["ok", "ok"] },
        research: { folder: "../outside" },
      }),
    ).toEqual([
      "/delegation/context/compactAtTokens: must be a whole number from 32768 to 10000000",
      "/delegation/context/perLayer/auditor: must be a whole number from 32768 to 10000000",
      "/delegation/limits/maxConcurrent/executors: must be a whole number from 1 to 20",
      "/delegation/models/layers/auditor/model: must be null or a model reference without spaces (see haril models)",
      "/delegation/models/layers/auditor/level: must be null or one of off, minimal, low, medium, high, xhigh, max",
      "/delegation/models/allow/executor: must be a list of model references without spaces",
      "/delegation/models/auditorDistinctFromExecutor: must be true or false",
      "/delegation/quota/stopAtPercentWeekly: must be a number from 0 to 100",
      "/delegation/quota/managementBaseUrl: must be null or an http(s) URL",
      "/delegation/watchdog/closeResidualImmediately: must be true: residual tasks are always closed at once (the user's rule)",
      "/delegation/watchdog/intervalMs: must be a whole number from 60000 to 86400000",
      "/delegation/autonomy/defaultStops: must be a list of stops (after_plan, after_node:<id>, before_merge, on_audit_failure, on_budget_pct:<n>, at_end)",
      "/delegation/commands/allow: must not repeat an entry",
      '/delegation/research/folder: must not hold empty, "." or ".." segments',
    ]);
  });

  it("refuses an absolute research folder and a section that is not an object", () => {
    expect(errorsOf({ research: { folder: "C:\\notes" } })).toEqual([
      "/delegation/research/folder: must be a path inside the project, not an absolute path",
    ]);
    expect(errorsOf([])).toEqual(["/delegation: must be an object"]);
  });

  it("makes the provider loader refuse the whole file, as for any other problem in it", () => {
    const loaded = loadProviderConfig(hostWith({ delegation: { limits: { maxAuditRetries: 2 } } }));
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.errors.join("\n")).toContain(
      "/delegation/limits/maxAuditRetries",
    );
  });
});
