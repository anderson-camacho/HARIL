import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  type RunEvent,
} from "@haril/core";
import type { AgentRuntime, Clock, ProcessControl, ProcessRoot, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// The sweeps never forget a recorded agent process (docs/modos-y-delegacion.md 3.14): a run a stop cancelled while the
// kill of its process failed stays on the list of both sweeps, the CLI's emergency stop and the runtime's startup
// sweep, until its process is verified gone. The OS is a fake here: it says which recorded pids still run as the
// recorded process, and whether a kill takes.

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
const DEAD_PID = 2_000_000_000;

// The OS as a map of running pids to start times; a kill removes a pid only while kills take.
class FakeOs implements ProcessControl {
  readonly running = new Map<number, number>();
  readonly kills: ProcessRoot[][] = [];
  killsTake = true;
  unreadable = false;

  async startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, number> | undefined> {
    if (this.unreadable) return undefined;
    const times = new Map<number, number>();
    for (const pid of pids) {
      const at = this.running.get(pid);
      if (at !== undefined) times.set(pid, at);
    }
    return times;
  }

  async killTrees(roots: readonly ProcessRoot[]) {
    if (this.unreadable) return undefined;
    this.kills.push([...roots]);
    const killed = roots.filter((root) => this.running.get(root.pid) === root.startedAt);
    if (this.killsTake) for (const root of killed) this.running.delete(root.pid);
    return { roots: killed.map((root) => root.pid), killed: killed.length };
  }
}

let sb: Sandbox;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    harness().io,
    sb.host,
  );
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules,
    isPidAlive: (pid) => pid !== DEAD_PID,
  });
  stores.push(store);
  return store;
}

// A runtime that is gone now ran a task whose run recorded `pid`; a stop cancelled that run long ago.
function cancelledRunOf(store: Store, pid: number, startedAt: number): string {
  run(["task", "add", "Slow", "--agent", "fake:slow:600000"], harness().io, sb.host);
  const grant = store.runtime.acquire({
    pid: DEAD_PID,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 1,
  });
  if (!grant.ok) throw new Error("lease not granted");
  store.commands.applyNext(grant.value.epoch);
  const claimed = store.tasks.claimNext(grant.value.epoch);
  if (claimed === undefined) throw new Error("nothing claimed");
  store.runs.recordProcess(grant.value.epoch, claimed.runId, { pid, startedAt });
  store.runs.cancel(claimed.runId, "user_stop");
  store.runtime.release(grant.value.epoch, false);
  return claimed.runId;
}

interface StopJson {
  readonly runtime: string;
  readonly processes: {
    readonly recorded: number;
    readonly killed: number;
    readonly alive: number;
    readonly unverified: number;
  };
}

async function stopNow(host: HostInfo): Promise<{ code: number; report: StopJson }> {
  const out = harness();
  const code = await run(["stop", "--now", "--json"], out.io, host);
  return { code, report: parseJson<StopJson>(out.out) };
}

describe("the CLI's emergency stop", () => {
  it("keeps checking a cancelled run whose process survived the kill, and stops once it is verified gone", async () => {
    const store = open();
    const os = new FakeOs();
    const startedAt = Date.now() - 60_000;
    os.running.set(4242, startedAt);
    cancelledRunOf(store, 4242, startedAt);
    const host: HostInfo = {
      ...sb.host,
      processControl: os,
      isPidAlive: (pid) => pid !== DEAD_PID,
    };

    // The kill fails: the process is reported alive, never an all-clear.
    os.killsTake = false;
    const first = await stopNow(host);
    expect(first.code).toBe(1);
    expect(first.report.processes).toMatchObject({ recorded: 1, killed: 1, alive: 1 });
    expect(os.kills).toEqual([[expect.objectContaining({ pid: 4242, startedAt })]]);

    // A second stop, minutes later, still sees it and tries again.
    const second = await stopNow(host);
    expect(second.code).toBe(1);
    expect(second.report.processes).toMatchObject({ recorded: 1, killed: 1, alive: 1 });

    // When the OS cannot be read, nothing is claimed either way.
    os.unreadable = true;
    const blind = await stopNow(host);
    expect(blind.code).toBe(1);
    expect(blind.report.processes).toMatchObject({ recorded: 1, killed: 0, unverified: 1 });
    os.unreadable = false;

    // This time the kill takes: verified gone, and never checked again.
    os.killsTake = true;
    const third = await stopNow(host);
    expect(third.code).toBe(0);
    expect(third.report.processes).toMatchObject({ recorded: 1, killed: 1, alive: 0 });
    const fourth = await stopNow(host);
    expect(fourth.code).toBe(0);
    expect(fourth.report.processes).toMatchObject({ recorded: 0, killed: 0, alive: 0 });
    expect(os.kills).toHaveLength(3);
  });

  it("marks a pid the OS reused as gone without touching it", async () => {
    const store = open();
    const os = new FakeOs();
    const startedAt = Date.now() - 3_600_000;
    // The pid now names a program that started an hour after the recorded one.
    os.running.set(4243, startedAt + 3_600_000);
    cancelledRunOf(store, 4243, startedAt);
    const host: HostInfo = {
      ...sb.host,
      processControl: os,
      isPidAlive: (pid) => pid !== DEAD_PID,
    };

    const first = await stopNow(host);
    expect(first.code).toBe(0);
    expect(first.report.processes).toMatchObject({ recorded: 1, killed: 0, kept: 1, alive: 0 });
    expect(os.kills).toEqual([]);
    expect((await stopNow(host)).report.processes.recorded).toBe(0);
  });
});

describe("the startup sweep", () => {
  it("kills a cancelled run's process that survived its stop, then forgets it once it is gone", async () => {
    const store = open();
    const os = new FakeOs();
    const startedAt = Date.now() - 60_000;
    os.running.set(4244, startedAt);
    const runId = cancelledRunOf(store, 4244, startedAt);

    const events: RunEvent[] = [];
    const start = () =>
      runUntilIdle({
        store,
        agentRuntime: new FakeAgentRuntime({ clock }),
        clock,
        pid: process.pid,
        nodeVersion: process.version,
        onEvent: (event) => events.push(event),
        idleExitMs: 0,
        pollMs: 20,
        shutdown: createShutdown(),
        processControl: os,
      });
    expect((await start()).kind).toBe("idle");
    expect(os.kills).toEqual([[expect.objectContaining({ pid: 4244, startedAt })]]);
    expect(events).toContainEqual({ type: "runtime.swept", killed: 1, kept: 0 });
    expect(
      store.events
        .list()
        .filter((event) => event.runId === runId && event.type === "run.process_killed")
        .map((event) => event.payload.reason),
    ).toEqual(["startup_sweep"]);

    // The next start finds nothing left to check.
    events.length = 0;
    expect((await start()).kind).toBe("idle");
    expect(os.kills).toHaveLength(1);
    expect(events.some((event) => event.type === "runtime.swept")).toBe(false);
  });
});

describe("the runtime", () => {
  it("marks an attempt's process verified gone once its agent exited, so no sweep checks it again", async () => {
    const store = open();
    run(["task", "add", "Quick", "--agent", "fake:succeed"], harness().io, sb.host);
    const inner = new FakeAgentRuntime({ clock });
    // A fake agent with a process of its own, as a Pi agent has: dispose resolves once that process exited.
    const agents: AgentRuntime = {
      async start(spec) {
        const started = await inner.start(spec);
        if (!started.ok) return started;
        const handle = started.value;
        const process = { pid: 4246, startedAt: Date.now() };
        return {
          ok: true,
          value: {
            runId: handle.runId,
            hello: handle.hello,
            settled: handle.settled,
            process,
            prompt: (text) => handle.prompt(text),
            abort: () => handle.abort(),
            dispose: () => handle.dispose(),
          },
        };
      },
    };
    const result = await runUntilIdle({
      store,
      agentRuntime: agents,
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: () => undefined,
      idleExitMs: 0,
      pollMs: 20,
      shutdown: createShutdown(),
      processControl: new FakeOs(),
    });
    expect(result.kind).toBe("idle");
    expect(store.tasks.list()[0]?.state).toBe("completed");
    expect(store.runs.processes({ unverified: true })).toEqual([]);
  });
});
