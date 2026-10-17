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
