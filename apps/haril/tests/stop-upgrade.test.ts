import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  type RunEvent,
} from "@haril/core";
import type { AgentHandle, AgentOutcome, AgentRuntime, Clock, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type RunLoopResult, runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { harness, makeSandbox, projectRoot, type Sandbox } from "./helpers.js";
import { until } from "./process-helpers.js";

// An emergency stop after a graceful one (docs/modos-y-delegacion.md 3.14): `haril stop --now` after a `haril stop`
// or one Ctrl+C must still kill every attempt at once, and an attempt whose agent is in its grace period (dispose) stays
// killable until its process is gone. Each agent here is hung: it ignores abort and EOF, and only a kill ends it.

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
const BUDGET_MS = 2000;

class HungAgents implements AgentRuntime {
  readonly killed: string[] = [];
  readonly aborted: string[] = [];
  readonly kills: (() => Promise<void>)[] = [];
  // Ends an agent from outside the runtime, as the CLI's kill of an unresponsive runtime's agent does: Pi exits.
  readonly exits = new Map<string, () => void>();

  async start(spec: { readonly runId: string; readonly allowedTools: readonly string[] }) {
    let settle: (outcome: AgentOutcome) => void = () => undefined;
    let exit: () => void = () => undefined;
    const settled = new Promise<AgentOutcome>((resolve) => {
      settle = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const handle: AgentHandle = {
      runId: spec.runId,
      hello: Promise.resolve({ tools: [...spec.allowedTools] }),
      settled,
      prompt: async () => ({ ok: true, value: undefined }),
      // A hung agent: the abort is sent, and nothing happens.
      abort: async () => {
        this.aborted.push(spec.runId);
      },
      kill: async () => {
        this.killed.push(spec.runId);
        settle({ status: "aborted" });
        exit();
      },
      // dispose aborts, and the hung agent's process exits only once it is killed: its grace period.
      dispose: () => {
        this.aborted.push(spec.runId);
        return exited;
      },
    };
    this.kills.push(handle.kill as () => Promise<void>);
    this.exits.set(spec.runId, () => {
      settle({ status: "failed", code: "pi_exited", message: "Pi exited before agent_settled" });
      exit();
    });
    return { ok: true as const, value: handle };
  }
}

let sb: Sandbox;
const stores: Store[] = [];
// What a test started, so a failed test still ends its runtime before its store closes.
const started: {
  agents: HungAgents;
  done: Promise<unknown>;
  shutdown: ReturnType<typeof createShutdown>;
}[] = [];

beforeEach(() => {
  sb = makeSandbox();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    harness().io,
    sb.host,
  );
});

afterEach(async () => {
  for (const item of started.splice(0)) {
    item.shutdown.request("emergency");
    await Promise.all(item.agents.kills.map((kill) => kill()));
    await within(item.done, 5000);
  }
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules,
    isPidAlive: () => true,
  });
  stores.push(store);
  return store;
}

function enqueueStop(store: Store, args: Record<string, unknown>): string {
  const key = randomUUID();
  return store.commands.enqueue({
    type: "runtime.stop",
    args,
    idempotencyKey: `stop-${key}`,
    requestHash: `stop-${key}`,
  }).commandId;
}

function startRuntime(store: Store, agents: HungAgents) {
  const events: RunEvent[] = [];
  const shutdown = createShutdown();
  const done: Promise<RunLoopResult> = runUntilIdle({
    store,
    agentRuntime: agents,
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: (event) => events.push(event),
    idleExitMs: 0,
    pollMs: 20,
    shutdown,
  });
  started.push({ agents, done, shutdown });
  return { events, done };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed out">((resolve) => {
    timer = setTimeout(() => resolve("timed out"), ms);
  });
  const result = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return result;
}

function taskState(store: Store, goal: string): string | undefined {
  return store.tasks.list().find((task) => task.goal === goal)?.state;
}

describe("an emergency stop after a graceful one", () => {
  it("kills the hung attempt at once, cancels its task and stops the runtime", async () => {
    run(["task", "add", "Hung", "--agent", "fake:slow:600000"], harness().io, sb.host);
    const store = open();
    const agents = new HungAgents();
    const runtime = startRuntime(store, agents);
    await until(() => taskState(store, "Hung") === "running", "the task running");

    const graceful = enqueueStop(store, {});
    await until(() => store.commands.get(graceful)?.status === "applied", "the graceful stop");
    await until(() => agents.aborted.length === 1, "the abort sent");
    expect(agents.killed).toEqual([]);

    const stoppedAt = Date.now();
    enqueueStop(store, { mode: "now" });
    const result = await within(runtime.done, BUDGET_MS);
    expect(result).not.toBe("timed out");
    expect(Date.now() - stoppedAt).toBeLessThan(BUDGET_MS);
    expect((result as RunLoopResult).kind).toBe("stopped");
    expect(agents.killed).toHaveLength(1);
    expect(taskState(store, "Hung")).toBe("cancelled");
    expect(runtime.events).toContainEqual({ type: "runtime.stopping", reason: "emergency" });
  });

  it("kills an attempt whose agent is in its grace period after its timeout", async () => {
    run(
      ["task", "add", "Timed out", "--agent", "fake:slow:600000", "--timeout-ms", "50"],
      harness().io,
      sb.host,
    );
    const store = open();
    const agents = new HungAgents();
    const runtime = startRuntime(store, agents);
    // The attempt timed out: dispose aborted it, and the hung agent waits out its grace period.
    await until(() => agents.aborted.length === 1, "the timed-out attempt aborted");
    expect(agents.killed).toEqual([]);

    const stoppedAt = Date.now();
    enqueueStop(store, { mode: "now" });
    const result = await within(runtime.done, BUDGET_MS);
    expect(result).not.toBe("timed out");
    expect(Date.now() - stoppedAt).toBeLessThan(BUDGET_MS);
    expect(agents.killed).toHaveLength(1);
    expect(taskState(store, "Timed out")).toBe("cancelled");
  });
});

// The unresponsive path (3.14): the CLI killed the agents of a runtime that had not applied its stop yet. When the
// runtime wakes, those attempts have settled as failed (Pi exited) and the stop is still queued: the stop applies first,
// so the attempts end cancelled and never consume an attempt.
describe("agents killed before their stop was applied", () => {
  it("end cancelled, not failed, and charge no attempt (haril stop --now)", async () => {
    run(
      ["task", "add", "Hung", "--agent", "fake:slow:600000", "--max-attempts", "2"],
      harness().io,
      sb.host,
    );
    const store = open();
    const agents = new HungAgents();
    const runtime = startRuntime(store, agents);
    await until(() => taskState(store, "Hung") === "running", "the task running");
    const [runId] = [...agents.exits.keys()];

    enqueueStop(store, { mode: "now" });
    agents.exits.get(runId as string)?.();
    const result = await within(runtime.done, BUDGET_MS);
    expect(result).not.toBe("timed out");
    const task = store.tasks.list().find((item) => item.goal === "Hung");
    expect(task?.state).toBe("cancelled");
    expect(store.tasks.get(task?.taskId ?? "")).toMatchObject({ attemptsUsed: 0 });
    expect(runtime.events.some((event) => event.type === "task.retrying")).toBe(false);
    expect(runtime.events.some((event) => event.type === "task.failed")).toBe(false);
  });

  it("end cancelled for a workflow stop too: the turn is not charged as failed", async () => {
    const store = open();
    const projectId = store.projects.list()[0]?.projectId as string;
    store.commands.enqueue({
      type: "workflow.start",
      projectId,
      args: {
        goal: "Read the notes",
        model: "fake/high-model",
        agent: "fake:orchestrate",
        autonomy: { mode: "autonomous", stops: [] },
        budgetTokens: 50_000,
        timeoutMs: 600_000,
      },
      idempotencyKey: "wf-1",
      requestHash: "wf-1",
    });
    const agents = new HungAgents();
    const runtime = startRuntime(store, agents);
    await until(() => agents.exits.size === 1, "the orchestrator turn running");
    const [workflow] = store.workflows.list();
    const [runId] = [...agents.exits.keys()];

    const key = randomUUID();
    store.commands.enqueue({
      type: "workflow.stop",
      projectId,
      args: { workflowId: workflow?.workflowId },
      idempotencyKey: key,
      requestHash: key,
    });
    agents.exits.get(runId as string)?.();
    await until(
      () => store.workflows.get(workflow?.workflowId ?? "")?.state === "stopped",
      "the workflow stopped",
    );
    await until(
      () => runtime.events.some((event) => event.type === "task.cancelled"),
      "the turn cancelled",
    );
    const turns = store.workflows.tasks(workflow?.workflowId ?? "");
    expect(turns.map((turn) => turn.state)).toEqual(["cancelled"]);
    expect(store.tasks.get(turns[0]?.taskId ?? "")).toMatchObject({ attemptsUsed: 0 });
    expect(runtime.events.some((event) => event.type === "workflow.turn")).toBe(false);
    enqueueStop(store, { mode: "now" });
    expect(await within(runtime.done, BUDGET_MS)).not.toBe("timed out");
  });
});
