import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentHandle, AgentSpec, PlanProposalContext, PlanProposer } from "@haril/core/ports";
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
  "HARIL_MODEL_CONTEXT",
  "HARIL_MODEL_MAX_TOKENS",
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
    overrides?: Partial<PiAgentRuntimeOptions> & { readPath?: string; outsidePath?: string },
  ): ReturnType<typeof createPiAgentRuntime>;
}

let tmp = "";
const handles: AgentHandle[] = [];
// Processes a fake Pi started; any still alive after a test is killed, so a failing test leaks nothing.
const strays: number[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "haril-pi-adapter-"));
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
    await until(() => !alive(pid), `stray ${pid} gone`);
  }
  // A killed process may hold the folder for a moment after it is gone (Windows, under the full suite's load).
  rmSync(tmp, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${what}: not met in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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
      const { readPath, outsidePath, ...rest } = overrides;
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
            FAKE_PI_OUTSIDE_PATH: outsidePath ?? "",
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
      expect(env.HARIL_MODEL_CONTEXT).toBe("32768");
      expect(env.HARIL_MODEL_MAX_TOKENS).toBe("4096");
      expect(env.HARIL_VKEY).toBe(VKEY);
      expect(env.PATH).toBe(dirname(process.execPath));
      expect(env.HARIL_BRIDGE).toMatch(/#[0-9a-f]{64}$/);
    } finally {
      delete process.env.HARIL_LEAK_CANARY;
    }
  });

  it("passes the model limits to the bridge through the child env", async () => {
    const h = harness();
    const handle = await startHandle(
      h.runtime("ok", { modelContextWindow: 65536, modelMaxTokens: 8192 }),
    );
    await handle.hello;
    const env = h.spawnCalls[0]?.options.env as Record<string, string>;
    expect(env.HARIL_MODEL_CONTEXT).toBe("65536");
    expect(env.HARIL_MODEL_MAX_TOKENS).toBe("8192");
  });

  it("rejects a model limit that is not a positive integer before spawning anything", async () => {
    const h = harness();
    const result = await h.runtime("ok", { modelMaxTokens: 0 }).start(spec());
    expect(result).toMatchObject({ ok: false, error: { code: "agent.invalid_spec" } });
    expect(h.spawnCalls).toHaveLength(0);
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

  it("records each denial with its guard reason and never the path or the content (ESC-05)", async () => {
    const h = harness();
    const handle = await startHandle(
      h.runtime("read_outside", { outsidePath: join(h.root, "..", "outside.txt") }),
    );
    await handle.prompt("go");
    expect(await handle.settled).toEqual({
      status: "succeeded",
      summary: "read denials 3: path_denied, path_denied, path_denied",
    });
    expect(h.events).toEqual([
      expect.objectContaining({ op: "read", outcome: "path_denied", reason: "outside_root" }),
      expect.objectContaining({ op: "read", outcome: "path_denied", reason: "outside_root" }),
      expect.objectContaining({ op: "read", outcome: "path_denied", reason: "unc_or_device_path" }),
    ]);
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain("secret outside");
    expect(serialized).not.toContain("outside.txt");
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

  it("refuses a read through a junction inside the project and records the link reason (ESC-05)", async () => {
    const h = harness();
    const linkedOutside = join(tmp, "linked-outside");
    mkdirSync(linkedOutside, { recursive: true });
    writeFileSync(join(linkedOutside, "secret.txt"), "secret outside", "utf8");
    symlinkSync(linkedOutside, join(h.root, "jout"), "junction");
    const handle = await startHandle(h.runtime("ok_with_read", { readPath: "jout/secret.txt" }));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({
      status: "succeeded",
      summary: "read denied: path_denied",
    });
    expect(h.events).toEqual([
      expect.objectContaining({ op: "read", outcome: "path_denied", reason: "link" }),
    ]);
    expect(JSON.stringify(h.events)).not.toContain("secret outside");
  });

  it("answers extension_ui_request with a cancellation", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ui_request"));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({ status: "succeeded", summary: "ui cancelled=true" });
  });

  it("ignores a notify request without writing any answer to Pi", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ui_notify"));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({ status: "succeeded", summary: "notify ignored" });
  });

  it("judges the last assistant message: an earlier error that Pi retried does not fail the run", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("error_then_retry_ok"));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({ status: "succeeded", summary: "retry reply" });
  });

  it("fails the run when the last assistant message ends with an error", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("error_final"));
    await handle.prompt("go");
    expect(await handle.settled).toEqual({
      status: "failed",
      code: "provider_error",
      message: "model unavailable",
    });
  });

  it("fails the run with reason aborted when the last assistant message ends aborted", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("ended_aborted"));
    await handle.prompt("go");
    expect(await handle.settled).toMatchObject({ status: "failed", code: "aborted" });
  });

  it("prefixes a prompt that starts with a slash so Pi does not read it as a command", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("echo_prompt"));
    await handle.prompt("/plan now");
    expect(await handle.settled).toEqual({
      status: "succeeded",
      summary: "echo: Task: /plan now",
    });
  });

  it("fails the run with agent.prompt_not_run when Pi does not start a run for the prompt", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("prompt_handled"));
    expect(await handle.prompt("go")).toMatchObject({
      ok: false,
      error: { code: "agent.prompt_not_run" },
    });
    expect(await handle.settled).toMatchObject({ status: "failed", code: "agent.prompt_not_run" });
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

  it("the tree kill also takes a tool command Pi started through the shell", async () => {
    const h = harness();
    const handle = await startHandle(h.runtime("hang_with_tool"));
    await handle.prompt("go");
    const pidFile = join(h.runsDir, "run-1", "fake-tool.pid");
    await until(() => existsSync(pidFile), "the tool command started");
    const tool = Number(readFileSync(pidFile, "utf8"));
    strays.push(tool);
    expect(alive(tool)).toBe(true);
    await handle.abort();
    expect(await handle.settled).toEqual({ status: "aborted" });
    await until(() => !alive(tool), "the tool command killed with Pi");
  });

  it("reports the process it started: its pid and the time taken right after the spawn (3.14)", async () => {
    const h = harness();
    const before = Date.now();
    const handle = await startHandle(h.runtime("hang"));
    const after = Date.now();
    const process = handle.process;
    expect(Number.isSafeInteger(process?.pid) && (process?.pid as number) > 0).toBe(true);
    expect(alive(process?.pid as number)).toBe(true);
    expect(process?.startedAt).toBeGreaterThanOrEqual(before);
    expect(process?.startedAt).toBeLessThanOrEqual(after);
  });

  it("records the boot ticks the host reads for the spawned pid, so a Linux clock step cannot hide it (3.14)", async () => {
    const h = harness();
    const asked: number[] = [];
    const boot = { bootId: "boot-test-id", ticks: 777 };
    const handle = await startHandle(
      h.runtime("hang", {
        bootStartOf: (pid) => {
          asked.push(pid);
          return boot;
        },
      }),
    );
    expect(asked).toEqual([handle.process?.pid]);
    expect(handle.process?.boot).toEqual(boot);
    const plain = await startHandle(h.runtime("hang"), spec("run-2"));
    expect(plain.process?.boot).toBeUndefined();
  });

  // What this proves is that kill skips the grace period (60 s here), so the bound is set against the grace period, far
  // above what a loaded machine adds to taskkill: the 2 s budget of the emergency stop (spec 9.2) is measured end to end
  // in the sequential test:stop lane (emergency-stop-processes.test.ts), where no parallel suite loads the machine.
  it("kill ends a hung Pi at once, without the grace period, and its tree with it (3.14)", async () => {
    const graceMs = 60_000;
    const h = harness();
    const handle = await startHandle(h.runtime("hang_with_tool", { timings: { graceMs } }));
    await handle.prompt("go");
    const pidFile = join(h.runsDir, "run-1", "fake-tool.pid");
    await until(() => existsSync(pidFile), "the tool command started");
    const tool = Number(readFileSync(pidFile, "utf8"));
    strays.push(tool);
    const pi = handle.process?.pid as number;
    const started = Date.now();
    await handle.kill?.();
    expect(await handle.settled).toEqual({ status: "aborted" });
    expect(Date.now() - started).toBeLessThan(graceMs / 6);
    expect(alive(pi)).toBe(false);
    await until(() => !alive(tool), "the tool command killed with Pi", graceMs / 6);
    // A second kill, and a dispose after it, change nothing.
    await handle.kill?.();
    await handle.dispose();
    expect(await handle.settled).toEqual({ status: "aborted" });
  }, 30_000);

  it("kills through the host's verified tree kill, never a tree walked by parent pid alone (3.14)", async () => {
    const h = harness();
    const asked: { pid: number; startedAt: number }[] = [];
    const handle = await startHandle(
      h.runtime("hang", {
        timings: { graceMs: 30_000 },
        killTree: async (target) => {
          asked.push({ pid: target.pid, startedAt: target.startedAt });
          process.kill(target.pid, "SIGKILL");
          return "killed";
        },
      }),
    );
    await handle.prompt("go");
    const pi = handle.process?.pid as number;
    await handle.kill?.();
    expect(await handle.settled).toEqual({ status: "aborted" });
    expect(asked).toEqual([{ pid: pi, startedAt: handle.process?.startedAt as number }]);
    expect(alive(pi)).toBe(false);
  });

  it("falls back to the OS's tree kill only when the host cannot read the process table (3.14)", async () => {
    const h = harness();
    const handle = await startHandle(
      h.runtime("hang_with_tool", {
        timings: { graceMs: 30_000 },
        killTree: async () => "unreadable",
      }),
    );
    await handle.prompt("go");
    const pidFile = join(h.runsDir, "run-1", "fake-tool.pid");
    await until(() => existsSync(pidFile), "the tool command started");
    const tool = Number(readFileSync(pidFile, "utf8"));
    strays.push(tool);
    const pi = handle.process?.pid as number;
    await handle.kill?.();
    expect(await handle.settled).toEqual({ status: "aborted" });
    expect(alive(pi)).toBe(false);
    await until(() => !alive(tool), "the tool command killed with Pi", 3000);
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

// haril_propose_plan on the Pi lane (LD-T4): the fake Pi sends plan.propose the way the bridge tool does. The proposer
// stands in for the host handler: it accepts a plan of schemaVersion 1 and refuses any other with a reason.
describe("createPiAgentRuntime plan.propose (LD-T4)", () => {
  const PLAN_TOOLS = ["read", "haril_propose_plan"];
  const ACCEPTED = "plan ok: proposed plan appr-1; it waits for a person (haril approve appr-1)";

  interface ProposalCall {
    readonly context: PlanProposalContext;
    readonly plan: unknown;
  }

  function planSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
    return {
      ...spec("run-plan"),
      projectId: "project-1",
      allowedTools: PLAN_TOOLS,
      kind: "plan",
      ...overrides,
    };
  }

  function proposer(calls: ProposalCall[]): PlanProposer {
    return (context, plan) => {
      calls.push({ context, plan });
      return (plan as { schemaVersion?: unknown }).schemaVersion === 1
        ? { ok: true, approvalId: "appr-1", created: true }
        : { ok: false, reason: "invalid plan: schemaVersion must be 1" };
    };
  }

  function summaryOf(outcome: Awaited<AgentHandle["settled"]>): string {
    if (outcome.status !== "succeeded") throw new Error(`run ${outcome.status}`);
    return outcome.summary;
  }

  it("serves plan.propose through the proposer with the run's context, recording the plan's hash and size only", async () => {
    const h = harness();
    const calls: ProposalCall[] = [];
    const handle = await startHandle(
      h.runtime("propose_plan", { proposePlan: proposer(calls) }),
      planSpec(),
    );
    expect((await handle.hello).tools).toEqual(PLAN_TOOLS);
    await handle.prompt("Plan the docs");

    expect(summaryOf(await handle.settled)).toBe(ACCEPTED);
    expect(calls).toEqual([
      {
        context: { projectId: "project-1", taskId: "task-1", runId: "run-plan" },
        plan: expect.objectContaining({ schemaVersion: 1 }),
      },
    ]);
    const body = JSON.stringify(calls[0]?.plan);
    expect(h.events).toEqual([
      {
        runId: "run-plan",
        op: "plan.propose",
        pathSha256: expect.any(String),
        outcome: "ok",
        planSha256: createHash("sha256").update(body, "utf8").digest("hex"),
        planBytes: Buffer.byteLength(body, "utf8"),
        approvalId: "appr-1",
      },
    ]);
    const serialized = JSON.stringify(h.events);
    expect(serialized).not.toContain("Plan the docs");
    expect(serialized).not.toContain("fake Pi planner");
  });

  it("answers a refused plan with the reason, so the agent can fix the plan and propose again", async () => {
    const h = harness();
    const calls: ProposalCall[] = [];
    const handle = await startHandle(
      h.runtime("propose_plan_retry", { proposePlan: proposer(calls) }),
      planSpec(),
    );
    await handle.prompt("Plan the docs");

    expect(summaryOf(await handle.settled)).toBe(
      `plan refused: invalid plan: schemaVersion must be 1 | ${ACCEPTED}`,
    );
    expect(calls).toHaveLength(2);
    // LD-T7c fix: the record keeps the reason HARIL gave, so the refusal is audited outside the Pi session log.
    expect(h.events).toEqual([
      expect.objectContaining({
        op: "plan.propose",
        outcome: "plan_refused",
        reason: "invalid plan: schemaVersion must be 1",
      }),
      expect.objectContaining({ op: "plan.propose", outcome: "ok", approvalId: "appr-1" }),
    ]);
    expect(h.events[1]).not.toHaveProperty("reason");
  });

  it("records a long refusal reason cut to 500 characters, and never the plan", async () => {
    const h = harness();
    const long = `invalid plan: ${"x".repeat(2000)}`;
    const handle = await startHandle(
      h.runtime("propose_plan", { proposePlan: () => ({ ok: false, reason: long }) }),
      planSpec(),
    );
    await handle.prompt("Plan the docs");
    await handle.settled;

    const [refused] = h.events as { readonly reason?: string }[];
    expect(refused).toMatchObject({ op: "plan.propose", outcome: "plan_refused" });
    expect([...(refused?.reason ?? "")]).toHaveLength(500);
    expect(refused?.reason?.startsWith("invalid plan: xxx")).toBe(true);
    expect(refused?.reason?.endsWith("…")).toBe(true);
    expect(JSON.stringify(h.events)).not.toContain("fake Pi planner");
  });

  it("answers plan.propose as unsupported without a proposer, and for a run that may not propose", async () => {
    const h = harness();
    const bare = await startHandle(h.runtime("propose_plan"), planSpec());
    await bare.prompt("Plan the docs");
    expect(summaryOf(await bare.settled)).toBe("plan refused: unsupported");

    const calls: ProposalCall[] = [];
    // A work run (read and write only) never reaches the proposer, even when one is configured.
    const work = await startHandle(
      h.runtime("propose_plan", { proposePlan: proposer(calls) }),
      spec("run-work"),
    );
    await work.prompt("Plan the docs");
    expect(summaryOf(await work.settled)).toBe("plan refused: unsupported");
    expect(calls).toEqual([]);
    expect(h.events).toEqual([
      expect.objectContaining({ runId: "run-plan", op: "plan.propose", outcome: "unsupported" }),
      expect.objectContaining({ runId: "run-work", op: "plan.propose", outcome: "unsupported" }),
    ]);
  });

  it("refuses the proposal when the run has no project or the proposer throws", async () => {
    const h = harness();
    const calls: ProposalCall[] = [];
    const { projectId: _dropped, ...noProject } = planSpec({ runId: "run-orphan" });
    const orphan = await startHandle(
      h.runtime("propose_plan", { proposePlan: proposer(calls) }),
      noProject,
    );
    await orphan.prompt("Plan the docs");
    expect(summaryOf(await orphan.settled)).toBe("plan refused: the run has no project");
    expect(calls).toEqual([]);

    const failing = await startHandle(
      h.runtime("propose_plan", {
        proposePlan: () => {
          throw new Error("store is closed");
        },
      }),
      planSpec(),
    );
    await failing.prompt("Plan the docs");
    expect(summaryOf(await failing.settled)).toBe("plan refused: the plan could not be recorded");
    expect(h.events).toEqual([
      expect.objectContaining({ runId: "run-orphan", outcome: "plan_refused" }),
      expect.objectContaining({ runId: "run-plan", outcome: "plan_refused" }),
    ]);
  });
});

// The delegation tools on the Pi lane (phase F2b): a fake Pi sends delegation.call the way the bridge's tools do, one
// call per entry of FAKE_PI_CALLS, and settles with the replies it heard. The handler stands in for the host's
// delegation tools: it records each call and answers with a typed reply.
const DELEGATION_FAKE_PI = `
import { connect } from "node:net";
const tools = (process.env.HARIL_TOOLS ?? "").split(",").filter((name) => name !== "");
const raw = process.env.HARIL_BRIDGE ?? "";
const cut = raw.lastIndexOf("#");
const calls = JSON.parse(process.env.FAKE_PI_CALLS ?? "[]");
const model = process.argv[process.argv.indexOf("--model") + 1];
const pending = new Map();
let seq = 0;
let buffer = "";
let input = "";
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const socket = connect(raw.slice(0, cut));
socket.on("connect", () => {
  const hello = { type: "hello", runId: process.env.HARIL_RUN_ID, token: raw.slice(cut + 1), tools, bridgeVersion: "fake" };
  socket.write(JSON.stringify(hello) + "\\n");
});
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let lf = buffer.indexOf("\\n");
  while (lf !== -1) {
    const reply = JSON.parse(buffer.slice(0, lf));
    buffer = buffer.slice(lf + 1);
    lf = buffer.indexOf("\\n");
    pending.get(reply.id)?.(reply);
  }
});
socket.on("error", () => {});
const request = (operation) => new Promise((resolve) => {
  const id = "op-" + ++seq;
  pending.set(id, resolve);
  socket.write(JSON.stringify({ id, ...operation }) + "\\n");
});
async function run() {
  const heard = [];
  for (const call of calls) {
    const reply = await request({ op: "delegation.call", tool: call.tool, input: call.input });
    heard.push(reply.ok ? "ok: " + reply.content : "refused: " + reply.error);
  }
  const text = heard.join(" | ");
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  emit({ type: "agent_settled", aborted: false });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let lf = input.indexOf("\\n");
  while (lf !== -1) {
    const message = JSON.parse(input.slice(0, lf));
    input = input.slice(lf + 1);
    lf = input.indexOf("\\n");
    if (message.type === "get_state") {
      emit({ type: "response", id: message.id, command: "get_state", success: true, data: { model: { id: model } } });
    }
    if (message.type === "prompt") {
      emit({ type: "response", id: message.id, command: "prompt", success: true, data: { disposition: "started" } });
      void run();
    }
  }
});
process.stdin.on("end", () => process.stdout.write("", () => process.exit(0)));
`;

describe("createPiAgentRuntime delegation.call (F2b)", () => {
  type ToolCall = {
    readonly context: { projectId: string; taskId: string; runId: string };
    readonly tool: string;
    readonly input: unknown;
  };
  type Scripted = readonly { readonly tool: string; readonly input: unknown }[];
  const ORCHESTRATOR_TOOLS = ["read", "haril_delegate", "haril_request_audit", "haril_abort"];

  // A workflow turn as the run loop builds it; the adapter only reads that it is one.
  function workflowSpec(allowedTools: readonly string[], runId = "run-turn"): AgentSpec {
    return {
      ...spec(runId),
      projectId: "project-1",
      allowedTools,
      kind: "plan",
      delegation: { role: "orchestrator" } as unknown as NonNullable<AgentSpec["delegation"]>,
    };
  }

  function summaryOf(outcome: Awaited<AgentHandle["settled"]>): string {
    if (outcome.status !== "succeeded") throw new Error(`run ${outcome.status}`);
    return outcome.summary;
  }

  // The fake Pi above, run with the host Node; the scripted calls reach it through FAKE_PI_CALLS.
  function runtimeWith(
    h: Harness,
    calls: Scripted,
    overrides: Partial<PiAgentRuntimeOptions> = {},
  ) {
    const piCliPath = join(tmp, "fake-pi-delegation.mjs");
    writeFileSync(piCliPath, DELEGATION_FAKE_PI, "utf8");
    const scripted = JSON.stringify(calls);
    return createPiAgentRuntime({
      nodePath: process.execPath,
      piCliPath,
      bridgePath: join(tmp, "bridge-not-loaded.mjs"),
      brokerUrl: "http://127.0.0.1:9/v1",
      projectRoot: h.root,
      runsDir: h.runsDir,
      model: MODEL,
      virtualKey: VKEY,
      timings: { helloTimeoutMs: 3000, startupTimeoutMs: 3000, graceMs: 200 },
      onBridgeOperation: (event) => h.events.push(event),
      ...overrides,
      spawn: (command, args, options) => {
        h.spawnCalls.push({ command, args, options: { ...options } });
        return nodeSpawn(command, args, {
          ...options,
          env: { ...options.env, FAKE_PI_CALLS: scripted },
        });
      },
    });
  }

  it("serves delegation.call through the host's handler with the run's context and answers with its typed reply", async () => {
    const h = harness();
    const seen: ToolCall[] = [];
    const handle = await startHandle(
      runtimeWith(
        h,
        [
          { tool: "haril_abort", input: { reason: "" } },
          { tool: "haril_abort", input: { reason: "stop" } },
        ],
        {
          delegationTools: (context, tool, input) => {
            seen.push({ context, tool, input });
            return (input as { reason?: unknown }).reason === "stop"
              ? { ok: true, note: "the workflow ends when your turn ends" }
              : { ok: false, reason: "haril_abort input: /reason: must be a non-empty text" };
          },
        },
      ),
      workflowSpec(ORCHESTRATOR_TOOLS),
    );
    expect((await handle.hello).tools).toEqual(ORCHESTRATOR_TOOLS);
    await handle.prompt("Report the facts");

    const summary = summaryOf(await handle.settled);
    expect(summary).toContain("refused: haril_abort input: /reason: must be a non-empty text");
    expect(summary).toContain('ok: accepted: {"note":"the workflow ends when your turn ends"}');
    const context = { projectId: "project-1", taskId: "task-1", runId: "run-turn" };
    expect(seen).toEqual([
      { context, tool: "haril_abort", input: { reason: "" } },
      { context, tool: "haril_abort", input: { reason: "stop" } },
    ]);
    const stop = JSON.stringify({ reason: "stop" });
    expect(h.events).toEqual([
      expect.objectContaining({
        op: "delegation.call",
        tool: "haril_abort",
        outcome: "delegation_refused",
        reason: "haril_abort input: /reason: must be a non-empty text",
      }),
      {
        runId: "run-turn",
        op: "delegation.call",
        tool: "haril_abort",
        pathSha256: expect.any(String),
        outcome: "ok",
        inputSha256: createHash("sha256").update(stop, "utf8").digest("hex"),
        inputBytes: Buffer.byteLength(stop, "utf8"),
      },
    ]);
    // A record keeps the input's hash and size, never the input.
    expect(JSON.stringify(h.events)).not.toContain('"stop"');
  });

  it("answers delegation.call as unsupported for a tool the run was not offered, or without a handler", async () => {
    const h = harness();
    const seen: string[] = [];
    const offered = await startHandle(
      runtimeWith(h, [{ tool: "haril_verdict", input: { approved: true, reasons: [] } }], {
        delegationTools: (_context, tool) => {
          seen.push(tool);
          return { ok: true };
        },
      }),
      workflowSpec(ORCHESTRATOR_TOOLS),
    );
    await offered.prompt("Report the facts");
    expect(summaryOf(await offered.settled)).toBe("refused: unsupported");
    expect(seen).toEqual([]);

    const bare = await startHandle(
      runtimeWith(h, [{ tool: "haril_abort", input: { reason: "stop" } }]),
      workflowSpec(ORCHESTRATOR_TOOLS, "run-bare"),
    );
    await bare.prompt("Report the facts");
    expect(summaryOf(await bare.settled)).toBe("refused: unsupported");
    expect(h.events).toEqual([
      expect.objectContaining({
        op: "delegation.call",
        tool: "haril_verdict",
        outcome: "unsupported",
      }),
      expect.objectContaining({
        op: "delegation.call",
        tool: "haril_abort",
        outcome: "unsupported",
      }),
    ]);
  });

  it("answers a fixed reason when the host's handler throws, never the host's error", async () => {
    const h = harness();
    const handle = await startHandle(
      runtimeWith(h, [{ tool: "haril_abort", input: { reason: "stop" } }], {
        delegationTools: () => {
          throw new Error("store is closed at D:/private/path");
        },
      }),
      workflowSpec(ORCHESTRATOR_TOOLS),
    );
    await handle.prompt("Report the facts");
    expect(summaryOf(await handle.settled)).toBe("refused: the call could not be recorded");
    expect(JSON.stringify(h.events)).not.toContain("private");
  });

  it("refuses to launch a workflow agent offered a tool that writes, edits or runs a command", async () => {
    const h = harness();
    for (const tool of ["write", "edit", "bash", "haril_run", "haril_merge", "grep"]) {
      const started = await h.runtime("ok").start(workflowSpec(["read", tool], `run-${tool}`));
      expect(started.ok, tool).toBe(false);
      if (!started.ok) {
        expect(started.error.code).toBe("agent.invalid_spec");
        expect(started.error.message).toContain(tool);
      }
    }
    expect(h.spawnCalls).toEqual([]);
    // read and the delegation tools of a role launch.
    const ok = await startHandle(
      h.runtime("ok"),
      workflowSpec(["read", "haril_verdict"], "run-ok"),
    );
    expect((await ok.hello).tools).toEqual(["read", "haril_verdict"]);
  });

  it("sends a workspace tool to the host's handler and answers without ending the turn (F8)", async () => {
    const h = harness();
    const seen: string[] = [];
    const handle = await startHandle(
      runtimeWith(
        h,
        [
          { tool: "write", input: { path: "src/a.ts", content: "x" } },
          { tool: "haril_run", input: { command: "npm", args: ["test"] } },
        ],
        {
          delegationTools: async (_context, tool) => {
            seen.push(tool);
            return tool === "write"
              ? { ok: true, path: "src/a.ts", bytes: 1, created: true }
              : {
                  ok: true,
                  exitCode: 0,
                  signal: null,
                  timedOut: false,
                  durationMs: 5,
                  stdout: "1 passing",
                  stderr: "",
                  truncated: false,
                };
          },
        },
      ),
      {
        ...workflowSpec(["read", "write", "edit", "haril_run"]),
        kind: "work",
        delegation: { role: "executor" } as unknown as NonNullable<AgentSpec["delegation"]>,
        workspace: { root: h.root },
      },
    );
    await handle.prompt("Change the button");
    const summary = summaryOf(await handle.settled);
    expect(seen).toEqual(["write", "haril_run"]);
    expect(summary).toContain('ok: write: {"path":"src/a.ts","bytes":1,"created":true}');
    expect(summary).toContain("haril_run: exit code 0 after 5 ms");
    expect(summary).toContain("stdout:\n1 passing");
    expect(summary).not.toContain("decides your turn");
  });
});

// A turn of a workflow that writes (phase F8): it runs in a git worktree, its role's workspace tools launch, Pi's own
// tools never do, its reads resolve under the worktree, and a workspace tool goes to the host's handler like a
// delegation tool but never ends the turn.
describe("createPiAgentRuntime in a worktree (F8)", () => {
  function worktreeSpec(
    role: string,
    allowedTools: readonly string[],
    root: string,
    runId = "run-wt",
  ): AgentSpec {
    return {
      ...spec(runId),
      projectId: "project-1",
      allowedTools,
      kind: "work",
      delegation: { role } as unknown as NonNullable<AgentSpec["delegation"]>,
      workspace: { root },
    };
  }

  it("launches only the workspace tools the archetype table gives the role, never Pi's own", async () => {
    const h = harness();
    const worktree = join(tmp, "worktree-launch");
    mkdirSync(worktree, { recursive: true });
    for (const [role, tool] of [
      ["executor", "bash"],
      ["executor", "grep"],
      ["executor", "haril_merge"],
      ["auditor", "write"],
      ["orchestrator", "haril_run"],
    ] as const) {
      const started = await h
        .runtime("ok")
        .start(worktreeSpec(role, ["read", tool], worktree, `run-${role}-${tool}`));
      expect(started.ok, `${role} ${tool}`).toBe(false);
      if (!started.ok) expect(started.error.message).toContain(tool);
    }
    const relative = await h
      .runtime("ok")
      .start(worktreeSpec("executor", ["read"], "worktree", "run-rel"));
    expect(relative.ok).toBe(false);
    expect(h.spawnCalls).toEqual([]);
    const executor = await startHandle(
      h.runtime("ok"),
      worktreeSpec("executor", ["read", "write", "edit", "haril_run"], worktree, "run-exec"),
    );
    expect((await executor.hello).tools).toEqual(["read", "write", "edit", "haril_run"]);
  });

  it("reads the worktree, not the project", async () => {
    const h = harness();
    const worktree = join(tmp, "worktree-read");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "notes.txt"), "hello from the worktree", "utf8");
    const handle = await startHandle(
      h.runtime("ok_with_read", { readPath: "notes.txt" }),
      worktreeSpec("executor", ["read", "write", "edit", "haril_run"], worktree, "run-read"),
    );
    await handle.prompt("go");
    expect(await handle.settled).toEqual({
      status: "succeeded",
      summary: "read ok: hello from the worktree",
    });
  });
});
