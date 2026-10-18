import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  type RunEvent,
} from "@haril/core";
import type { Clock, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { makeSandbox, type Sandbox } from "./helpers.js";
import { alive, killNoted, type NotedProcess, processControl } from "./process-helpers.js";

// The startup sweep (docs/modos-y-delegacion.md 3.14.5): a runtime that exits abruptly (a crash, a process.exit) leaves
// its runs open and, possibly, its agents alive. The next runtime kills the recorded processes that still run as the
// process that was recorded (pid and start time), keeps a pid the OS reused for another program, and only then
// reconciles the orphans as before (back to ready, at most 3 infrastructure restarts).

const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
const rules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};
// A child that starts a grandchild and prints its pid, then idles; it leads its own group on POSIX, as Pi does.
const TREE_SCRIPT =
  "const { spawn } = require('node:child_process');" +
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
  "console.log(g.pid); setInterval(() => {}, 1000);";
const HOUR = 3_600_000;

let sb: Sandbox;
const stores: Store[] = [];
// Every process this test started, with its start time: only those still running as themselves are killed after it.
let strays: NotedProcess[] = [];

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await killNoted(strays);
  strays = [];
  sb.cleanup();
});

function open(): Store {
  const store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
  stores.push(store);
  return store;
}

async function spawnTree(): Promise<{ pid: number; grandchild: number; startedAt: number }> {
  const child: ChildProcess = spawn(process.execPath, ["-e", TREE_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const startedAt = Date.now();
  const pid = child.pid as number;
  strays.push({ pid, startedAt });
  const grandchild = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim())));
    child.once("error", reject);
  });
  strays.push({ pid: grandchild, startedAt: Date.now() });
  return { pid, grandchild, startedAt };
}

// A runtime that claimed two tasks and died without releasing its lease: its runs stay open with their processes.
function crashedRuntime(store: Store): { epoch: number; runs: string[]; tasks: string[] } {
  const grant = store.runtime.acquire({
    pid: 2_000_000_000,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 1,
  });
  if (!grant.ok) throw new Error("lease not granted");
  const epoch = grant.value.epoch;
  const projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: sb.root,
  }).projectId;
  const tasks: string[] = [];
  const runs: string[] = [];
  for (const goal of ["First", "Second"]) {
    store.commands.enqueue({
      type: "task.create",
      projectId,
      args: { goal, dependsOn: [], agent: "fake:succeed", maxAttempts: 1, timeoutMs: 60_000 },
      idempotencyKey: `create-${goal}`,
      requestHash: `create-${goal}`,
    });
    store.commands.applyNext(epoch);
    const claimed = store.tasks.claimNext(epoch);
    if (claimed === undefined) throw new Error("nothing claimed");
    tasks.push(claimed.taskId);
    runs.push(claimed.runId);
  }
  return { epoch, runs, tasks };
}

describe("the startup sweep", () => {
  it("kills the agent tree a dead runtime left, keeps a reused pid, then recovers and runs the orphaned tasks", async () => {
    const store = open();
    const crashed = crashedRuntime(store);
    const orphan = await spawnTree();
    // The second run's pid now names a process that started an hour after the recorded one: a reused pid.
    const reused = await spawnTree();
    store.runs.recordProcess(crashed.epoch, crashed.runs[0] as string, {
      pid: orphan.pid,
      startedAt: orphan.startedAt,
    });
    store.runs.recordProcess(crashed.epoch, crashed.runs[1] as string, {
      pid: reused.pid,
      startedAt: reused.startedAt - HOUR,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const events: RunEvent[] = [];
    const result = await runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: (event) => events.push(event),
      idleExitMs: 0,
      pollMs: 20,
      shutdown: createShutdown(),
      processControl,
    });

    expect(result.kind).toBe("idle");
    expect(alive(orphan.pid)).toBe(false);
    const deadline = Date.now() + 2000;
    while (alive(orphan.grandchild) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive(orphan.grandchild)).toBe(false);
    expect(alive(reused.pid)).toBe(true);
    expect(alive(reused.grandchild)).toBe(true);
    expect(events.find((event) => event.type === "runtime.swept")).toEqual({
      type: "runtime.swept",
      killed: 1,
      kept: 1,
    });
    const audit = store.events
      .list()
      .filter((event) => event.type.startsWith("run.process_"))
      .map((event) => [event.type, event.runId, event.payload.pid]);
    expect(audit).toEqual([
      ["run.process_killed", crashed.runs[0], orphan.pid],
      ["run.process_kept", crashed.runs[1], reused.pid],
    ]);
    // The sweep comes before the reconciliation: both tasks were recovered (one infra restart) and ran again.
    expect(events.filter((event) => event.type === "task.recovered")).toHaveLength(2);
    for (const taskId of crashed.tasks) {
      expect(store.tasks.get(taskId)).toMatchObject({ state: "completed", infraRestarts: 1 });
    }
    // The runs it swept are closed: the next start finds nothing to sweep.
    expect(store.runs.processes()).toEqual([]);
  }, 60_000);
});
