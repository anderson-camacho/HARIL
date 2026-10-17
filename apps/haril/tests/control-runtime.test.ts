import { randomUUID } from "node:crypto";
import { type ControlClient, connect, createControlServer } from "@haril/control";
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
import { run } from "../src/cli.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { harness, makeSandbox, projectRoot, type Sandbox } from "./helpers.js";

// The control channel of the runtime (LD-T2, ARCH 4.3): a subscribed client keeps the runtime up, a nudge makes it check
// the queue at once, and the pipe never leaves the process with a payload.
const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

let sb: Sandbox;
const stores: Store[] = [];

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
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition was not reached in time");
    await sleep(20);
  }
}

// The runtime opens its pipe after it takes the lease: poll until a subscriber connects.
async function subscribeWhenUp(): Promise<ControlClient> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const client = await connect(sb.dataDir, { subscribe: true });
    if (client !== undefined) return client;
    if (Date.now() > deadline) throw new Error("no runtime opened its control channel");
    await sleep(50);
  }
}

describe("runtime control channel (LD-T2)", () => {
  it("keeps haril start up past a short idle window while a client is subscribed, and exits after it leaves", async () => {
    const h = harness();
    let exitCode: number | undefined;
    // `start` is the one asynchronous command, so run() may answer a number or a promise.
    const runtime = Promise.resolve(run(["start", "--idle-exit-sec", "1"], h.io, sb.host)).then(
      (code) => {
        exitCode = code;
        return code;
      },
    );

    const client = await subscribeWhenUp();
    await sleep(2500);
    expect(exitCode).toBeUndefined();

    client.close();
    expect(await runtime).toBe(0);
    expect(exitCode).toBe(0);
  }, 20_000);

  it("claims a task at once after a CLI nudge, long before the poll interval would", async () => {
    const store = open();
    const control = createControlServer({ dataDir: sb.dataDir });
    const events: RunEvent[] = [];
    const loop = runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: (event) => events.push(event),
      idleExitMs: 120_000,
      // A poll of one minute: only a nudge can make the claim happen within the wait below.
      pollMs: 60_000,
      shutdown: createShutdown(),
      control,
    });

    (await subscribeWhenUp()).close();
    const add = harness();
    const started = Date.now();
    expect(run(["task", "add", "Nudged"], add.io, sb.host)).toBe(0);

    await waitFor(() => events.some((event) => event.type === "task.completed"), 10_000);
    expect(Date.now() - started).toBeLessThan(10_000);

    const stop = harness();
    expect(run(["stop"], stop.io, sb.host)).toBe(0);
    const result = await loop;
    expect(result.kind).toBe("stopped");
  }, 30_000);

  it("keeps running the queue when the control channel cannot open", async () => {
    const store = open();
    const broken = {
      start: () => Promise.reject(new Error("endpoint taken")),
      close: async () => undefined,
      notify: () => undefined,
      subscriberCount: () => 0,
      onNudge: () => () => undefined,
    };
    const events: RunEvent[] = [];
    const loop = runUntilIdle({
      store,
      agentRuntime: new FakeAgentRuntime({ clock }),
      clock,
      pid: process.pid,
      nodeVersion: process.version,
      onEvent: (event) => events.push(event),
      idleExitMs: 120_000,
      pollMs: 50,
      shutdown: createShutdown(),
      control: broken,
    });

    const add = harness();
    expect(run(["task", "add", "Polled"], add.io, sb.host)).toBe(0);
    await waitFor(() => events.some((event) => event.type === "task.completed"), 10_000);

    const stop = harness();
    expect(run(["stop"], stop.io, sb.host)).toBe(0);
    expect((await loop).kind).toBe("stopped");
  }, 30_000);
});
