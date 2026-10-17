import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// `haril memory status` (MC-T4; BL-082, RF-132; MEMORY.md 12.3): read-only, it works with no runtime running and never
// writes haril.db. It shows the provider, its health (not checked without a live runtime), whether memory is degraded
// and the outbox depth.
let sb: Sandbox;

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  sb.cleanup();
});

interface MemoryStatusJson {
  initialized: boolean;
  dataDir: string;
  runtime: string;
  provider: string;
  providerSource: string;
  persistent: boolean | null;
  health: string;
  degraded: boolean;
  lastState: string | null;
  lastStateAt: number | null;
  lastError: { code: string; at: number } | null;
  outbox: {
    depth: number;
    pending: number;
    sending: number;
    needsReview: number;
    dead: number;
    delivered: number;
    oldestPendingAt: number | null;
  };
}

async function cli(args: string[]): Promise<Harness & { code: number }> {
  const h = harness();
  const code = await run(args, h.io, sb.host);
  return { ...h, code };
}

async function statusJson(): Promise<MemoryStatusJson> {
  const result = await cli(["memory", "status", "--json"]);
  expect(result.code).toBe(0);
  return parseJson<MemoryStatusJson>(result.out);
}

async function initProject(): Promise<void> {
  const result = await cli(["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--yes"]);
  expect(result.code).toBe(0);
}

function openTestStore(): Store {
  return openStore({
    dataDir: sb.dataDir,
    clock: { now: () => Date.now(), schedule: () => () => undefined },
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
  });
}

describe("haril memory status", () => {
  it("on a missing database says not initialized, with the default provider, and creates nothing", async () => {
    const text = await cli(["memory", "status"]);
    expect(text.code).toBe(0);
    expect(text.out.join("\n")).toContain("not initialized");
    expect(existsSync(sb.dataDir)).toBe(false);

    const json = await statusJson();
    expect(json).toMatchObject({
      initialized: false,
      provider: "null",
      providerSource: "default",
      health: "not_checked",
      degraded: false,
      runtime: "not_running",
    });
    expect(existsSync(join(sb.dataDir, "haril.db"))).toBe(false);
  });

  it("prints the JSON shape: provider, health, degradation and the outbox depth", async () => {
    await initProject();
    const json = await statusJson();
    expect(Object.keys(json).sort()).toEqual(
      [
        "dataDir",
        "degraded",
        "health",
        "initialized",
        "lastError",
        "lastState",
        "lastStateAt",
        "outbox",
        "persistent",
        "provider",
        "providerSource",
        "runtime",
      ].sort(),
    );
    expect(json).toEqual({
      initialized: true,
      dataDir: sb.dataDir,
      runtime: "not_running",
      provider: "null",
      providerSource: "default",
      persistent: false,
      health: "not_checked",
      degraded: false,
      lastState: null,
      lastStateAt: null,
      lastError: null,
      outbox: {
        depth: 0,
        pending: 0,
        sending: 0,
        needsReview: 0,
        dead: 0,
        delivered: 0,
        oldestPendingAt: null,
      },
    });
  });

  it("after a run shows the provider the runtime recorded; with the runtime gone its health is not checked", async () => {
    await initProject();
    expect((await cli(["run"])).code).toBe(0);

    const json = await statusJson();
    expect(json).toMatchObject({
      provider: "null",
      providerSource: "recorded",
      persistent: false,
      lastState: "active",
      health: "not_checked",
      degraded: false,
      runtime: "not_running",
    });
    const text = (await cli(["memory", "status"])).out.join("\n");
    expect(text).toContain("null");
    expect(text).toContain("not checked");
    expect(text).toContain("not persistent");
  });

  it("with a live runtime shows its recorded health: degraded, with the last error", async () => {
    await initProject();
    const store = openTestStore();
    try {
      const grant = store.runtime.acquire({
        pid: process.pid,
        nodeVersion: process.version,
        sqliteVersion: store.info().sqliteVersion,
        ttlMs: 600_000,
      });
      if (!grant.ok) throw new Error("lease not granted");
      store.memory.setState(grant.value.epoch, {
        provider: "fake-provider",
        state: "degraded",
        persistent: true,
        code: "Unavailable",
      });

      const json = await statusJson();
      expect(json).toMatchObject({
        runtime: "running",
        provider: "fake-provider",
        providerSource: "recorded",
        persistent: true,
        health: "degraded",
        degraded: true,
        lastError: { code: "Unavailable" },
      });
      const text = (await cli(["memory", "status"])).out.join("\n");
      expect(text).toContain("degraded");
      expect(text).toContain("Unavailable");
    } finally {
      store.close();
    }
  });

  it("never writes haril.db", async () => {
    await initProject();
    expect((await cli(["run"])).code).toBe(0);
    const before = readFileSync(join(sb.dataDir, "haril.db"));
    await cli(["memory", "status"]);
    await cli(["memory", "status", "--json"]);
    expect(readFileSync(join(sb.dataDir, "haril.db")).equals(before)).toBe(true);
  });

  it("rejects an unknown subcommand and stray arguments with the usage, and the help lists it", async () => {
    const unknown = await cli(["memory", "flush"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join("\n")).toContain("usage: haril memory status");
    const missing = await cli(["memory"]);
    expect(missing.code).toBe(2);
    const stray = await cli(["memory", "status", "extra"]);
    expect(stray.code).toBe(2);
    const help = await cli(["help"]);
    expect(help.out.join("\n")).toContain("haril memory status [--json]");
  });
});
