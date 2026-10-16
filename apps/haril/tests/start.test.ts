import { existsSync } from "node:fs";
import { join } from "node:path";
import { canTransition, checkPlanSubmission } from "@haril/core";
import type { AgentHandle, AgentRuntime, AgentSpec, Clock } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
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

// `haril start` (M1-T5): foreground runtime that applies the queue, runs tasks and exits when idle.
let sb: Sandbox;
let h: Harness;

const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, runNow) => {
    const timer = setTimeout(runNow, delayMs);
    return () => clearTimeout(timer);
  },
};

beforeEach(async () => {
  sb = makeSandbox();
  h = harness();
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(async () => {
  sb.cleanup();
});

async function start(args: string[] = [], host = sb.host): Promise<number> {
  h = harness();
  return await run(["start", ...args], h.io, host);
}

function status(): {
  taskList: { taskId: string; goal: string; state: string }[];
  queuedCommands: unknown[];
} {
  const report = harness();
  run(["status", "--json"], report.io, sb.host);
  return parseJson(report.out);
}

function taskIdOf(goal: string): string {
  const task = status().taskList.find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task.taskId;
}

function stateOf(goal: string): string | undefined {
  return status().taskList.find((candidate) => candidate.goal === goal)?.state;
}

function addTask(title: string, extra: string[] = []): void {
  const add = harness();
  const code = run(["task", "add", title, ...extra], add.io, sb.host);
  if (code !== 0) throw new Error(add.err.join("\n"));
}

describe("haril start", async () => {
  it("runs the queued tasks, prints one line per event and exits 0", async () => {
    addTask("A");
    expect(await start()).toBe(0);
    expect(h.out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^command .* applied/),
        expect.stringMatching(/^claimed .* A/),
        expect.stringMatching(/^completed .* A/),
        "done: 1 completed, 0 failed, 0 blocked",
      ]),
    );
    expect(stateOf("A")).toBe("completed");
  });

  it("retries a failing task, then blocks its dependent and exits 1", async () => {
    addTask("B", ["--agent", "fake:fail", "--max-attempts", "2"]);
    expect(await start()).toBe(1);
    expect(h.out.join("\n")).toContain("failed (retrying 2/2)");
    expect(h.out).toContain("done: 0 completed, 1 failed, 0 blocked");
    expect(stateOf("B")).toBe("failed");

    addTask("C", ["--depends-on", taskIdOf("B")]);
    expect(await start()).toBe(1);
    expect(h.out.join("\n")).toContain("blocked: dep_failed");
    expect(h.out).toContain("done: 0 completed, 0 failed, 1 blocked");
    expect(stateOf("C")).toBe("blocked");
  });

  it("reports a rejected command and keeps running", async () => {
    addTask("D", ["--depends-on", "no-such-task"]);
    expect(await start()).toBe(0);
    expect(h.out.join("\n")).toContain("rejected");
    expect(stateOf("D")).toBeUndefined();
  });

  it("prints a JSON summary with --json", async () => {
    addTask("E");
    expect(await start(["--json"])).toBe(0);
    const summary = parseJson<{
      completed: string[];
      failed: string[];
      blocked: string[];
      exitCode: number;
    }>(h.out);
    expect(summary).toMatchObject({
      completed: [taskIdOf("E")],
      failed: [],
      blocked: [],
      exitCode: 0,
    });
  });

  it("exits 2 naming the holder when another runtime holds the lease", async () => {
    let counter = 0;
    const store = openStore({
      dataDir: sb.dataDir,
      clock: systemClock,
      ids: { next: () => `holder-${++counter}` },
      rules: { canTransition, checkPlan: checkPlanSubmission },
    });
    const grant = store.runtime.acquire({
      pid: 4242,
      nodeVersion: "v24.19.0",
      sqliteVersion: "3.53.3",
      ttlMs: 60_000,
    });
    expect(grant.ok).toBe(true);
    store.close();

    expect(await start()).toBe(2);
    expect(h.err.join("\n")).toContain("another runtime is active (pid 4242)");
  });

  it("does not send the prompt when the handshake announces other tools (handshake_mismatch)", async () => {
    const fake = new FakeAgentRuntime({ clock: systemClock, helloTools: () => ["write"] });
    const prompts: string[] = [];
    const spy: AgentRuntime = {
      start: async (spec: AgentSpec) => {
        const started = await fake.start(spec);
        if (!started.ok) return started;
        const handle: AgentHandle = started.value;
        return {
          ok: true,
          value: {
            runId: handle.runId,
            hello: handle.hello,
            settled: handle.settled,
            prompt: async (text: string) => {
              prompts.push(text);
              return handle.prompt(text);
            },
            abort: () => handle.abort(),
            dispose: () => handle.dispose(),
          },
        };
      },
    };
    addTask("F");
    expect(await start([], { ...sb.host, agentRuntime: spy })).toBe(1);
    expect(prompts).toEqual([]);
    expect(h.out.join("\n")).toContain("handshake_mismatch");
  });

  it("exits 2 without creating the store when the project is not initialized", async () => {
    const fresh = makeSandbox();
    try {
      const out = harness();
      expect(await run(["start"], out.io, fresh.host)).toBe(2);
      expect(out.err.join("\n")).toContain("not initialized");
      expect(existsSync(join(fresh.dataDir, "haril.db"))).toBe(false);
    } finally {
      fresh.cleanup();
    }
  });
});
