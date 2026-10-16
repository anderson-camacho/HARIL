import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHandle, AgentSpec } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPiAgentRuntime,
  type PiAgentHandle,
  type PiAgentRuntimeOptions,
} from "../src/index.js";

// Adapter tests run the fake Pi (testing/fake-pi.mjs) with the host Node. The scenario reaches the fake
// through a test-only spawn wrapper, because the adapter builds the child env from scratch (ADR-0004 l.58).

const FAKE_PI = fileURLToPath(new URL("../testing/fake-pi.mjs", import.meta.url));
const MODEL = "haril-test-model";
const VKEY = "vkey-test-0123456789abcdef";
const TOOLS = ["read", "write"];
const ALLOWED_ENV = new Set([
  "PI_CODING_AGENT_DIR",
  "PI_TELEMETRY",
  "PI_SKIP_VERSION_CHECK",
  "PI_OFFLINE",
  "HARIL_RUN_ID",
  "HARIL_BRIDGE",
  "HARIL_TOOLS",
  "HARIL_BROKER_URL",
  "HARIL_MODEL",
  "HARIL_VKEY",
  "SystemRoot",
  "TEMP",
  "TMP",
  "PATH",
]);

interface Harness {
  readonly root: string;
  readonly runsDir: string;
  readonly events: unknown[];
  readonly spawnCalls: {
    command: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }[];
  runtime(
    scenario: string,
    overrides?: Partial<PiAgentRuntimeOptions> & { readPath?: string },
  ): ReturnType<typeof createPiAgentRuntime>;
}

let tmp = "";
const handles: AgentHandle[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "haril-pi-adapter-"));
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

function harness(): Harness {
  const root = join(tmp, "project");
  const runsDir = join(tmp, "runs");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.txt"), "hello from project", "utf8");
  writeFileSync(join(tmp, "outside.txt"), "secret outside", "utf8");
  const events: unknown[] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  return {
    root,
    runsDir,
    events,
    spawnCalls,
    runtime(scenario, overrides = {}) {
      const { readPath, ...rest } = overrides;
      return createPiAgentRuntime({
        nodePath: process.execPath,
        piCliPath: FAKE_PI,
        bridgePath: join(tmp, "bridge-not-loaded.mjs"),
        brokerUrl: "http://127.0.0.1:9/v1",
        projectRoot: root,
        runsDir,
        model: MODEL,
        virtualKey: VKEY,
        timings: { helloTimeoutMs: 3000, startupTimeoutMs: 3000, graceMs: 200 },
        onBridgeOperation: (event) => events.push(event),
        ...rest,
        spawn: (command, args, options) => {
          spawnCalls.push({ command, args, options: { ...options } });
          const scenarioEnv: Record<string, string> = {
            FAKE_PI_SCENARIO: scenario,
            FAKE_PI_READ_PATH: readPath ?? "",
          };
          return nodeSpawn(command, args, {
            ...options,
            env: { ...options.env, ...scenarioEnv },
          });
        },
      });
    },
  };
}

function spec(runId = "run-1", timeoutMs = 5000): AgentSpec {
  return {
    runId,
    taskId: "task-1",
    attempt: 1,
    agentRef: "pi:analyst",
    allowedTools: TOOLS,
    prompt: "do the work",
    timeoutMs,
  };
}

async function startHandle(
  runtime: ReturnType<typeof createPiAgentRuntime>,
  agentSpec: AgentSpec = spec(),
): Promise<PiAgentHandle> {
  const result = await runtime.start(agentSpec);
  if (!result.ok) throw new Error(`start failed: ${result.error.code}`);
  const handle = result.value as PiAgentHandle;
  handles.push(handle);
  return handle;
}

describe("createPiAgentRuntime launch", () => {
  it("launches the absolute node with the ADR-0004 argv and no shell", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ok"));
    await handle.hello;
    expect(h.spawnCalls).toHaveLength(1);
    const call = h.spawnCalls[0];
    if (call === undefined) throw new Error("no spawn call");
    const runDir = join(h.runsDir, "run-1");
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([
      FAKE_PI,
      "--mode",
      "rpc",
      "--no-builtin-tools",
      "--no-extensions",
      "-e",
      join(tmp, "bridge-not-loaded.mjs"),
      "--no-context-files",
      "--no-approve",
      "--offline",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--session-dir",
      join(runDir, "pi"),
      "--provider",
      "haril",
      "--model",
      MODEL,
    ]);
    expect(call.options.shell).toBeFalsy();
    expect(call.options.windowsHide).toBe(true);
    expect(call.args.join(" ")).not.toContain(VKEY);
    expect(call.args.join(" ")).not.toContain("#");
  });

  it("builds the child env from scratch: whitelisted keys only, no inherited secrets", async () => {
    const h = harness();
    process.env.HARIL_LEAK_CANARY = "inherited-value";
    try {
      const handle = await startHandle(h.runtime("ok"));
      await handle.hello;
      const env = h.spawnCalls[0]?.options.env as Record<string, string>;
      expect(env.HARIL_LEAK_CANARY).toBeUndefined();
      for (const key of Object.keys(env)) expect(ALLOWED_ENV.has(key), key).toBe(true);
      expect(env.PI_CODING_AGENT_DIR).toBe(join(h.runsDir, "run-1", "agent"));
      expect(env.PI_TELEMETRY).toBe("0");
      expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
      expect(env.PI_OFFLINE).toBe("1");
      expect(env.HARIL_RUN_ID).toBe("run-1");
      expect(env.HARIL_TOOLS).toBe("read,write");
      expect(env.HARIL_BROKER_URL).toBe("http://127.0.0.1:9/v1");
      expect(env.HARIL_MODEL).toBe(MODEL);
      expect(env.HARIL_VKEY).toBe(VKEY);
      expect(env.PATH).toBe(dirname(process.execPath));
      expect(env.HARIL_BRIDGE).toMatch(/#[0-9a-f]{64}$/);
    } finally {
      delete process.env.HARIL_LEAK_CANARY;
    }
  });

  it("rejects a relative node path before spawning anything", async () => {
    const h = harness();
    const result = await h.runtime("ok", { nodePath: "node" }).start(spec());
    expect(result).toMatchObject({ ok: false, error: { code: "agent.invalid_spec" } });
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("writes stderr to <run>/pi/stderr.log", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ok"));
    await handle.prompt("go");
    await handle.settled;
    await handle.dispose();
    const log = readFileSync(join(h.runsDir, "run-1", "pi", "stderr.log"), "utf8");
    expect(log).toContain("fake-pi stderr marker");
  });
});

describe("createPiAgentRuntime lifecycle", () => {
  it("succeeds with the final assistant text, after agent_settled, ignoring unknown events", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ok"));
    expect((await handle.hello).tools).toEqual(TOOLS);
    expect(await handle.prompt("go")).toEqual({ ok: true, value: undefined });
    expect(await handle.settled).toEqual({ status: "succeeded", summary: "fake reply" });
    const diagnostics = handle.diagnostics;
    expect(diagnostics.ignoredEvents).toBeGreaterThanOrEqual(1);
    expect(diagnostics.warnings).toEqual([]);
  });

  it("serves bridge read through the PathGuard and records the operation without content", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ok_with_read", { readPath: "notes.txt" }));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({
      status: "succeeded",
      summary: "read ok: hello from project",
    });
    expect(h.events).toEqual([
      expect.objectContaining({ runId: "run-1", op: "read", outcome: "ok" }),
    ]);
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain("hello from project");
    expect(serialized).not.toContain("notes.txt");
  });

  it("denies a read outside the project root with path_denied and no content", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ok_with_read", { readPath: "../outside.txt" }));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({
      status: "succeeded",
      summary: "read denied: path_denied",
    });
    expect(h.events).toEqual([expect.objectContaining({ op: "read", outcome: "path_denied" })]);
    expect(JSON.stringify(h.events)).not.toContain("secret outside");
  });

  it("answers extension_ui_request with a cancellation", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ui_request"));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({ status: "succeeded", summary: "ui cancelled=true" });
  });

  it("fails closed when the bridge announces tools different from allowedTools", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("wrong_hello_tools"));
    await expect(handle.hello).rejects.toMatchObject({ code: "agent.handshake_mismatch" });
    expect(await handle.prompt("go")).toMatchObject({
      ok: false,
      error: { code: "agent.handshake_mismatch" },
    });
    expect(await handle.settled).toMatchObject({
      status: "failed",
      code: "agent.handshake_mismatch",
    });
  });

  it("fails closed on a wrong token", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("wrong_token"));
    expect(await handle.prompt("go")).toMatchObject({ ok: false });
    expect(await handle.settled).toMatchObject({
      status: "failed",
      code: "agent.handshake_mismatch",
    });
  });

  it("fails with a handshake timeout when hello never arrives", async () => {
    const h = harness();
    const started = Date.now();
    const handle = await startHandle(
      h.runtime("no_hello", {
        timings: { helloTimeoutMs: 300, startupTimeoutMs: 3000, graceMs: 200 },
      }),
    );
    expect(await handle.prompt("go")).toMatchObject({
      ok: false,
      error: { code: "agent.handshake_timeout" },
    });
    expect(await handle.settled).toMatchObject({
      status: "failed",
      code: "agent.handshake_timeout",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses the prompt when get_state reports another model", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("wrong_model"));
    expect(await handle.prompt("go")).toMatchObject({
      ok: false,
      error: { code: "agent.model_mismatch" },
    });
    expect(await handle.settled).toMatchObject({ status: "failed", code: "agent.model_mismatch" });
  });

  it("fails with pi_exited when Pi exits before agent_settled", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("crash_before_settled"));
    expect((await handle.prompt("go")).ok).toBe(true);
    expect(await handle.settled).toMatchObject({ status: "failed", code: "pi_exited" });
  });

  it("accepts a non-zero exit after agent_settled with a warning", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("nonzero_after_settled"));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({ status: "succeeded", summary: "fake reply" });
    await handle.dispose();
    const diagnostics = handle.diagnostics;
    expect(diagnostics.warnings).toEqual([expect.stringMatching(/exited with code 3/)]);
  });

  it("aborts a hung Pi: abort RPC, EOF, then a tree kill after the grace period", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("hang"));
    await handle.prompt("go");
    const started = Date.now();
    await handle.abort();
    expect(await handle.settled).toEqual({ status: "aborted" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("aborts cooperatively when Pi answers abort with agent_settled", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("hang_abortable"));
    await handle.prompt("go");
    await handle.abort();
    expect(await handle.settled).toEqual({ status: "aborted" });
  });

  it("settles timed_out when the task deadline passes", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("hang"), spec("run-1", 300));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({ status: "timed_out" });
  });

  it("fails with protocol_line_too_long when a stdout line exceeds 8 MiB", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("huge_line"));
    await handle.prompt("go");
    expect(await handle.settled).toMatchObject({
      status: "failed",
      code: "protocol_line_too_long",
    });
  });

  it("dispose is idempotent and settles an unfinished run as aborted", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("hang"));
    await handle.prompt("go");
    await handle.dispose();
    await handle.dispose();
    expect(await handle.settled).toEqual({ status: "aborted" });
    expect(existsSync(join(h.runsDir, "run-1", "pi"))).toBe(true);
  });
});
