import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canTransition, checkAcceptance, checkPlanSubmission } from "@haril/core";
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

// `haril stop` (LD-T1): enqueues runtime.stop for the runtime that holds the lease. The runtime runs in a child
// process here, as it does in production, so the stop crosses processes through the command queue.
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "src", "main.ts");
const REGISTER = join(
  HERE,
  "..",
  "..",
  "..",
  "integrations",
  "state-sqlite",
  "tests",
  "crash",
  "register.mjs",
);
const CHILD_TIMEOUT_MS = 30_000;

let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(() => {
  sb.cleanup();
});

function queuedCommands(): unknown[] {
  const report = harness();
  run(["status", "--json"], report.io, sb.host);
  return parseJson<{ queuedCommands: unknown[] }>(report.out).queuedCommands;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe("haril stop", () => {
  it("says so and enqueues nothing when no runtime is active", async () => {
    h = harness();
    expect(await run(["stop"], h.io, sb.host)).toBe(0);
    expect(h.out.join("\n")).toContain("no runtime is active");
    expect(queuedCommands()).toEqual([]);
  });

  it("ends a running start: the in-flight task returns to ready uncharged, the lease is released, exit 0", async () => {
    const add = harness();
    expect(run(["task", "add", "Slow", "--agent", "fake:slow:60000"], add.io, sb.host)).toBe(0);

    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", pathToFileURL(REGISTER).href, MAIN, "start"],
      {
        cwd: sb.root,
        env: { ...process.env, HARIL_HOME: sb.dataDir },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );

    try {
      // The runtime has claimed the task once its lease is active and the task runs.
      await until(
        () => stdout.join("").includes("claimed ") || child.exitCode !== null,
        CHILD_TIMEOUT_MS,
        `the child to claim the task (out: ${stdout.join("")} err: ${stderr.join("")})`,
      );

      if (child.exitCode !== null)
        throw new Error(`child exited ${child.exitCode}: ${stderr.join("")}`);
      h = harness();
      expect(await run(["stop"], h.io, sb.host)).toBe(0);
      expect(h.out.join("\n")).toMatch(/^command \S+: queued/);

      const code = await Promise.race([
        exited,
        sleep(CHILD_TIMEOUT_MS).then(() => "timeout" as const),
      ]);
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
    }

    const store = openStore({
      dataDir: sb.dataDir,
      clock: { now: () => Date.now(), schedule: () => () => undefined },
      ids: { next: () => randomUUID() },
      rules: { canTransition, checkPlan: checkPlanSubmission, checkAcceptance },
    });
    try {
      const task = store.tasks.list().find((candidate) => candidate.goal === "Slow");
      expect(store.tasks.get(task?.taskId ?? "")).toMatchObject({
        state: "ready",
        retryReason: "orphaned",
        attemptsUsed: 0,
        infraRestarts: 0,
      });
      expect(store.runtime.leaseSummary()).toMatchObject({ status: "released" });
    } finally {
      store.close();
    }
    expect(stdout.join("")).toContain("stopping (command)");
  }, 90_000);
});
