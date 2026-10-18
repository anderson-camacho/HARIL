import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHandle, AgentSpec } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPiAgentRuntime,
  type PiAgentHandle,
  type PiAgentRuntimeOptions,
} from "../src/index.js";
import { buildPiArgv, compactionReserveTokens, thinkingLevelFor } from "../src/launch.js";

// A Pi agent's real context, its compaction point and its reasoning level (docs/modos-y-delegacion.md 3.12, 7.10;
// ADR-0021 S3; phase F7). Pi compacts when contextTokens > contextWindow - reserveTokens, so a layer that compacts at
// N tokens on a model of window W gets reserveTokens = max(16384, W - N) in its run's agent settings. The level reaches
// Pi as --thinking, and the bridge registers the model's published levels so Pi sends it as reasoning_effort.

const FAKE_PI = fileURLToPath(new URL("../testing/fake-pi.mjs", import.meta.url));

describe("the compaction reserve", () => {
  it("makes Pi compact at the layer's threshold when the model's window is larger", () => {
    expect(compactionReserveTokens(1_048_576, 300_000)).toBe(748_576);
    expect(compactionReserveTokens(1_048_576, 400_000)).toBe(648_576);
    expect(compactionReserveTokens(320_000, 300_000)).toBe(20_000);
  });

  it("leaves Pi's own reserve when the window is at most the threshold: the window decides", () => {
    expect(compactionReserveTokens(200_000, 300_000)).toBe(16_384);
    expect(compactionReserveTokens(300_000, 300_000)).toBe(16_384);
    expect(compactionReserveTokens(32_768, 300_000)).toBe(16_384);
  });
});

describe("the level Pi runs at", () => {
  it("is the requested level when the model publishes it", () => {
    expect(thinkingLevelFor(["minimal", "low", "medium", "high"], "high")).toBe("high");
    expect(thinkingLevelFor(["none", "low", "high"], "off")).toBe("off");
  });

  it("is the nearest published level otherwise, as Pi clamps it", () => {
    expect(thinkingLevelFor(["low", "medium", "high"], "minimal")).toBe("low");
    expect(thinkingLevelFor(["low", "medium", "high", "xhigh"], "max")).toBe("xhigh");
    expect(thinkingLevelFor(["low", "high"], "off")).toBe("low");
  });

  it("is none for a model that publishes no reasoning level", () => {
    expect(thinkingLevelFor([], "high")).toBeUndefined();
    expect(thinkingLevelFor(["auto"], "high")).toBeUndefined();
  });

  it("goes to Pi as --thinking, and nothing is added without a level", () => {
    const base = { piCliPath: "/pi", bridgePath: "/bridge", sessionDir: "/s", model: "m" };
    expect(buildPiArgv(base).includes("--thinking")).toBe(false);
    expect(buildPiArgv({ ...base, thinking: "high" }).slice(-2)).toEqual(["--thinking", "high"]);
  });
});

let tmp = "";
const handles: AgentHandle[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "haril-pi-limits-"));
  mkdirSync(join(tmp, "project"), { recursive: true });
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

interface Spawned {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

function runtime(overrides: Partial<PiAgentRuntimeOptions>, calls: Spawned[]) {
  return createPiAgentRuntime({
    nodePath: process.execPath,
    piCliPath: FAKE_PI,
    bridgePath: join(tmp, "bridge-not-loaded.mjs"),
    brokerUrl: "http://127.0.0.1:9/v1",
    projectRoot: join(tmp, "project"),
    runsDir: join(tmp, "runs"),
    model: "haril-test-model",
    virtualKey: "vkey-test-0123456789abcdef",
    timings: { helloTimeoutMs: 3000, startupTimeoutMs: 3000, graceMs: 200 },
    ...overrides,
    spawn: (command, args, options) => {
      calls.push({ args, env: { ...options.env } });
      return nodeSpawn(command, args, {
        ...options,
        env: { ...options.env, FAKE_PI_SCENARIO: "ok" },
      });
    },
  });
}

const SPEC: AgentSpec = {
  runId: "run-1",
  taskId: "task-1",
  attempt: 1,
  agentRef: "executor",
  allowedTools: ["read"],
  prompt: "do the work",
  timeoutMs: 5000,
};

describe("a Pi launch with the model's limits, its compaction point and its level", () => {
  it("gets the real window and output, --thinking, the published levels and the reserve in its settings", async () => {
    const calls: Spawned[] = [];
    const started = await runtime(
      {
        modelContextWindow: 1_048_576,
        modelMaxTokens: 65_536,
        thinkingLevel: "high",
        modelLevels: ["minimal", "low", "medium", "high"],
        compactAtTokens: 300_000,
      },
      calls,
    ).start(SPEC);
    if (!started.ok) throw new Error(started.error.message);
    handles.push(started.value);
    await started.value.hello;
    const [call] = calls;
    expect(call?.args.slice(-2)).toEqual(["--thinking", "high"]);
    expect(call?.env.HARIL_MODEL_CONTEXT).toBe("1048576");
    expect(call?.env.HARIL_MODEL_MAX_TOKENS).toBe("65536");
    expect(call?.env.HARIL_MODEL_LEVELS).toBe("minimal,low,medium,high");
    const settings = join(tmp, "runs", "run-1", "agent", "settings.json");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      compaction: { reserveTokens: 748_576 },
    });
    expect((started.value as PiAgentHandle).diagnostics.launch).toEqual({
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      compactionReserveTokens: 748_576,
      thinkingLevel: "high",
    });
  });

  it("runs at the nearest published level, and asks for none when the model publishes none", async () => {
    const calls: Spawned[] = [];
    const clamped = await runtime(
      { thinkingLevel: "minimal", modelLevels: ["low", "high"] },
      calls,
    ).start(SPEC);
    if (!clamped.ok) throw new Error(clamped.error.message);
    handles.push(clamped.value);
    await clamped.value.hello;
    expect(calls[0]?.args.slice(-2)).toEqual(["--thinking", "low"]);
    expect((clamped.value as PiAgentHandle).diagnostics.launch.thinkingLevel).toBe("low");
    await clamped.value.dispose();
    const none = await runtime({ thinkingLevel: "high", modelLevels: [] }, calls).start({
      ...SPEC,
      runId: "run-2",
    });
    if (!none.ok) throw new Error(none.error.message);
    handles.push(none.value);
    await none.value.hello;
    expect(calls[1]?.args.includes("--thinking")).toBe(false);
    expect(calls[1]?.env.HARIL_MODEL_LEVELS).toBeUndefined();
    expect((none.value as PiAgentHandle).diagnostics.launch).toEqual({
      contextWindow: 32_768,
      maxTokens: 4_096,
      compactionReserveTokens: null,
      thinkingLevel: null,
    });
  });

  it("keeps the previous launch without them: no level, no levels and no settings file", async () => {
    const calls: Spawned[] = [];
    const started = await runtime({}, calls).start(SPEC);
    if (!started.ok) throw new Error(started.error.message);
    handles.push(started.value);
    await started.value.hello;
    expect(calls[0]?.args.includes("--thinking")).toBe(false);
    expect(calls[0]?.env.HARIL_MODEL_LEVELS).toBeUndefined();
    expect(existsSync(join(tmp, "runs", "run-1", "agent", "settings.json"))).toBe(false);
  });

  it("refuses a level Pi does not know, a malformed level list and a threshold that is not a positive integer", async () => {
    for (const overrides of [
      { thinkingLevel: "ultra" },
      { modelLevels: ["low,high"] },
      { compactAtTokens: 0 },
    ] as Partial<PiAgentRuntimeOptions>[]) {
      const calls: Spawned[] = [];
      const result = await runtime(overrides, calls).start(SPEC);
      expect(result).toMatchObject({ ok: false, error: { code: "agent.invalid_spec" } });
      expect(calls).toHaveLength(0);
    }
  });
});
