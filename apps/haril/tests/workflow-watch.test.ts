import { EventEmitter } from "node:events";
import { validateWorkflowSnapshot, type WorkflowSnapshot } from "@haril/contracts";
import type { ControlClient } from "@haril/control";
import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import { storeAccess } from "../src/host.js";
import { harness, makeSandbox, projectRoot, type Sandbox } from "./helpers.js";
import { until } from "./process-helpers.js";

// `haril workflow watch <id>` (docs/modos-y-delegacion.md 6, 7.6): JSON lines of WorkflowSnapshot v1, one at once and
// one more on each wake of the runtime's control channel; without a runtime it polls the store and prints a snapshot
// when something changed. It ends when the workflow ends, or on Ctrl+C. The control channel is a fake here: the test
// fires its wakes.

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
  const store = storeAccess(sb.host).open(sb.dataDir);
  stores.push(store);
  return store;
}

// Applies the queued commands as a runtime would, without running any turn, and gives the lease back.
function applyQueued(store: Store): void {
  const grant = store.runtime.acquire({
    pid: process.pid,
    nodeVersion: process.version,
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  while (store.commands.applyNext(grant.value.epoch) !== undefined);
  store.runtime.release(grant.value.epoch, true);
}

// A running workflow whose turns never run: the watch sees it until the test stops it.
function runningWorkflow(store: Store): string {
  const queued = harness();
  expect(
    run(
      ["workflow", "start", "Watch me", "--model", "fake/high-model", "--autonomous"],
      queued.io,
      sb.host,
    ),
  ).toBe(0);
  applyQueued(store);
  const [workflow] = store.workflows.list();
  if (workflow === undefined) throw new Error("no workflow");
  return workflow.workflowId;
}

function stopWorkflow(store: Store, workflowId: string): void {
  const project = store.projects.list()[0];
  store.commands.enqueue({
    type: "workflow.stop",
    projectId: project?.projectId,
    args: { workflowId },
    idempotencyKey: `stop-${workflowId}`,
    requestHash: `stop-${workflowId}`,
  });
  applyQueued(store);
}

class FakeChannel implements ControlClient {
  readonly wakes = new Set<(seq: number) => void>();
  readonly closes = new Set<() => void>();
  closed = false;
  private seq = 0;

  onWake(listener: (seq: number) => void) {
    this.wakes.add(listener);
    return () => this.wakes.delete(listener);
  }
  onEvent() {
    return () => undefined;
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  nudge() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closes]) listener();
  }
  wake() {
    this.seq += 1;
    for (const listener of [...this.wakes]) listener(this.seq);
  }
}

interface Watch {
  readonly lines: WorkflowSnapshot[];
  readonly done: Promise<number>;
  readonly signals: EventEmitter;
}

function watch(workflowId: string, channel: FakeChannel | undefined): Watch {
  const lines: WorkflowSnapshot[] = [];
  const signals = new EventEmitter();
  const host: HostInfo = {
    ...sb.host,
    signals,
    connectControl: async () => channel,
  };
  const io = {
    out: (line: string) => lines.push(JSON.parse(line) as WorkflowSnapshot),
    err: () => undefined,
    readFile: () => "",
  };
  const done = Promise.resolve(
    run(["workflow", "watch", workflowId, "--interval-ms", "40"], io, host),
  );
  return { lines, done, signals };
}

describe("haril workflow watch", () => {
  it("prints a snapshot at once and another on each wake, and ends when the workflow ends", async () => {
    const store = open();
    const workflowId = runningWorkflow(store);
    const channel = new FakeChannel();
    const watching = watch(workflowId, channel);
    await until(() => watching.lines.length === 1, "the first snapshot", 5000);
    expect(validateWorkflowSnapshot(watching.lines[0]).ok).toBe(true);
    expect(watching.lines[0]?.workflow).toMatchObject({ id: workflowId, state: "running" });
    await until(() => channel.wakes.size === 1, "the subscription", 5000);

    channel.wake();
    await until(() => watching.lines.length === 2, "the snapshot of the first wake", 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    channel.wake();
    await until(() => watching.lines.length === 3, "the snapshot of the second wake", 5000);
    // Nothing changed meanwhile, so the poll printed nothing between the wakes.
    expect(watching.lines).toHaveLength(3);

    stopWorkflow(store, workflowId);
    channel.wake();
    expect(await watching.done).toBe(0);
    expect(watching.lines.at(-1)?.workflow.state).toBe("stopped");
    expect(channel.closed).toBe(true);
  });

  it("without a runtime, polls the store and prints a snapshot when it changed", async () => {
    const store = open();
    const workflowId = runningWorkflow(store);
    const watching = watch(workflowId, undefined);
    await until(() => watching.lines.length === 1, "the first snapshot", 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(watching.lines).toHaveLength(1);

    stopWorkflow(store, workflowId);
    expect(await watching.done).toBe(0);
    expect(watching.lines.map((line) => line.workflow.state)).toEqual(["running", "stopped"]);
  });

  it("ends on Ctrl+C, and prints one snapshot and ends for a workflow that already ended", async () => {
    const store = open();
    const workflowId = runningWorkflow(store);
    const watching = watch(workflowId, new FakeChannel());
    await until(() => watching.lines.length === 1, "the first snapshot", 5000);
    watching.signals.emit("SIGINT");
    expect(await watching.done).toBe(0);

    stopWorkflow(store, workflowId);
    const ended = watch(workflowId, new FakeChannel());
    expect(await ended.done).toBe(0);
    expect(ended.lines.map((line) => line.workflow.state)).toEqual(["stopped"]);
  });

  it("ends when its stdin ends with --exit-on-stdin-end: the console that started it went away", async () => {
    const store = open();
    const workflowId = runningWorkflow(store);
    const lines: WorkflowSnapshot[] = [];
    let endStdin: (() => void) | undefined;
    const host: HostInfo = {
      ...sb.host,
      signals: new EventEmitter(),
      connectControl: async () => undefined,
      onStdinEnd: (listener) => {
        endStdin = listener;
        return () => {
          endStdin = undefined;
        };
      },
    };
    const io = {
      out: (line: string) => lines.push(JSON.parse(line) as WorkflowSnapshot),
      err: () => undefined,
      readFile: () => "",
    };
    const done = Promise.resolve(
      run(
        ["workflow", "watch", workflowId, "--interval-ms", "40", "--exit-on-stdin-end"],
        io,
        host,
      ),
    );
    await until(() => lines.length === 1 && endStdin !== undefined, "the first snapshot", 5000);
    endStdin?.();
    expect(await done).toBe(0);
    expect(endStdin).toBeUndefined();
  });

  it("takes --json as the spec writes it: its lines are JSON already", async () => {
    const store = open();
    const workflowId = runningWorkflow(store);
    stopWorkflow(store, workflowId);
    const out = harness();
    expect(await run(["workflow", "watch", workflowId, "--json"], out.io, sb.host)).toBe(0);
    expect(out.out.map((line) => (JSON.parse(line) as WorkflowSnapshot).workflow.state)).toEqual([
      "stopped",
    ]);
  });

  it("refuses a workflow that does not exist", async () => {
    const out = harness();
    expect(await run(["workflow", "watch", "wf-none"], out.io, sb.host)).toBe(2);
    expect(out.err.join("\n")).toContain('no workflow with id "wf-none"');
  });
});
