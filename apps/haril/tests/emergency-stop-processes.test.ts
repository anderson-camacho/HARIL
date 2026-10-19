import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiAgentRuntime } from "@haril/agent-pi";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { AgentRuntime, Store } from "@haril/core/ports";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HostInfo, run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
  withWorkflowIntake,
} from "./helpers.js";
import { alive, killNoted, sleep, toolProcesses, until } from "./process-helpers.js";

// The emergency stop with real processes (docs/modos-y-delegacion.md 3.14, 9.2): every agent is the fake Pi of the
// adapter tests in its hang_with_tool scenario, a real Node process that starts a tool command through the shell (a
// grandchild) and then ignores abort and EOF, as a stuck agent would. The runtime runs in this process with the real
// store, the real control channel and the real CLI; the stop must leave no process alive within 2 s. This file runs on
// its own (npm run test:stop, a step of npm test): alone the agents are dead about 0.6 s after the command, while the
// CPU contention of every other test file in parallel stretches the OS's tree kill past the budget.

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(HERE, "..", "..", "..", "integrations", "agent-pi", "testing", "fake-pi.mjs");
const STOP_BUDGET_MS = 2000;
const TEST_TIMEOUT_MS = 90_000;

let sb: Sandbox;
let runsDir: string;
const stores: Store[] = [];
// The runtimes a test started, so a failed test still stops them before its sandbox is removed.
const runtimes: { host: HostInfo; done: Promise<number> }[] = [];

beforeEach(() => {
  sb = makeSandbox();
  runsDir = join(sb.root, "pi-runs");
  mkdirSync(runsDir, { recursive: true });
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await run(["stop", "--now"], harness().io, runtime.host);
    await Promise.race([runtime.done, sleep(10_000)]);
  }
  // Even after a failure, nothing this test started outlives it: the agents it recorded and their tool commands.
  const recorded = stores[0]?.runs.processes({ endedSince: 0 }) ?? [];
  await killNoted([...recorded, ...toolProcesses(runsDir)]);
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function open(): Store {
  const store = openStore({
    dataDir: sb.dataDir,
    clock: { now: () => Date.now(), schedule: () => () => undefined },
    ids: { next: () => randomUUID() },
    rules: {
      canTransition,
      checkPlan: checkPlanSubmission,
      checkAcceptance,
      checkTaskKind,
      canonicalJson,
    },
  });
  stores.push(store);
  return store;
}

// The fake Pi as the agent runtime of every task: it hangs with a tool command until it is killed.
function stuckAgents(): AgentRuntime {
  return createPiAgentRuntime({
    nodePath: process.execPath,
    piCliPath: FAKE_PI,
    bridgePath: join(sb.root, "bridge-not-loaded.mjs"),
    brokerUrl: "http://127.0.0.1:9/v1",
    projectRoot: join(sb.root, "demo"),
    runsDir,
    model: "haril-test-model",
    virtualKey: "vkey-test-not-a-real-key",
    timings: { helloTimeoutMs: 20_000, startupTimeoutMs: 20_000, graceMs: 30_000 },
    spawn: (command, args, options) =>
      nodeSpawn(command, args, {
        ...options,
        env: { ...options.env, FAKE_PI_SCENARIO: "hang_with_tool" },
      }),
  });
}

interface Agent {
  readonly runId: string;
  readonly pi: number;
  readonly tool: number;
}

// The agents in flight once each recorded its process and started its tool command.
async function agentsInFlight(store: Store, count: number): Promise<Agent[]> {
  let agents: Agent[] = [];
  await until(() => {
    const recorded = store.runs.processes();
    agents = recorded
      .filter((record) => existsSync(join(runsDir, record.runId, "fake-tool.pid")))
      .map((record) => ({
        runId: record.runId,
        pi: record.pid,
        tool: Number(readFileSync(join(runsDir, record.runId, "fake-tool.pid"), "utf8")),
      }))
      .filter((agent) => Number.isSafeInteger(agent.tool) && agent.tool > 0);
    return agents.length >= count;
  }, `${count} agents in flight`);
  return agents;
}

async function queue(host: HostInfo, argv: readonly string[]): Promise<void> {
  const h = harness();
  // These process-stop scenarios need explicit intake but never write project files.
  const command =
    argv[0] === "workflow" && argv[1] === "start"
      ? withWorkflowIntake(sb, projectRoot(sb, "demo"), [...argv, "--read-only"])
      : [...argv];
  const code = await run(command, h.io, host);
  if (code !== 0)
    throw new Error(`haril ${command.join(" ")} exited ${String(code)}: ${h.err.join(" ")}`);
}

function startRuntime(host: HostInfo): { out: Harness; done: Promise<number> } {
  const out = harness();
  const done = Promise.resolve(run(["start", "--idle-exit-sec", "60"], out.io, host));
  const entry = { host, done };
  runtimes.push(entry);
  void done.finally(() => {
    const index = runtimes.indexOf(entry);
    if (index >= 0) runtimes.splice(index, 1);
  });
  return { out, done };
}

describe("haril stop --now with real agent processes", () => {
  it(
    "kills every agent and its tool within 2 s, cancels the tasks, stops the workflows, settles the reservations and halts; a second stop is harmless",
    async () => {
      const host: HostInfo = {
        ...sb.host,
        agentRuntime: stuckAgents(),
        signals: new EventEmitter(),
        forceExit: () => undefined,
      };
      await queue(host, [
        "workflow",
        "start",
        "Ship the button",
        "--model",
        "fake/high-model",
        "--autonomous",
      ]);
      await queue(host, [
        "workflow",
        "start",
        "Write the tests",
        "--model",
        "fake/high-model",
        "--autonomous",
      ]);
      await queue(host, ["task", "add", "Slow standalone", "--agent", "fake:slow:600000"]);
      await queue(host, ["task", "add", "Later standalone", "--agent", "fake:succeed"]);
      const runtime = startRuntime(host);
      const store = open();
      const agents = await agentsInFlight(store, 3);
      for (const agent of agents) {
        expect(alive(agent.pi)).toBe(true);
        expect(alive(agent.tool)).toBe(true);
      }
      // One agent holds an open model call: the Broker's reservation on its project budget.
      const project = store.projects.list()[0];
      const reservedRun = store.runs.processes()[0];
      if (project === undefined || reservedRun === undefined) throw new Error("no run in flight");
      const budget = store.budgets.ensure({
        scopeType: "project",
        scopeId: project.projectId,
        projectId: project.projectId,
        hardLimit: 1_000_000,
      });
      const reserved = store.budgets.reserve({
        budgetIds: [budget.budgetId],
        amount: 5000,
        idempotencyKey: `reserve-${reservedRun.runId}`,
        runId: reservedRun.runId,
        taskId: reservedRun.taskId,
        routeId: "route-test",
      });
      expect(reserved.ok).toBe(true);

      const stop = harness();
      const stoppedAt = Date.now();
      expect(await run(["stop", "--now", "--json"], stop.io, host)).toBe(0);
      await until(
        () => agents.every((agent) => !alive(agent.pi) && !alive(agent.tool)),
        "every agent process gone",
        STOP_BUDGET_MS,
      );
      const elapsed = Date.now() - stoppedAt;
      expect(elapsed).toBeLessThan(STOP_BUDGET_MS);
      expect(parseJson(stop.out)).toMatchObject({
        runtime: "stopped",
        halted: true,
        cancelledTasks: 3,
        stoppedWorkflows: 2,
        processes: { alive: 0 },
      });

      expect(await runtime.done).toBe(0);
      expect(runtime.out.out.join("\n")).toContain("stopping now (emergency stop)");
      // The run's last line counts what the stop ended: cancelled tasks and stopped workflows are not failures.
      expect(runtime.out.out.join("\n")).toMatch(
        /done: 0 completed, 0 failed, 0 blocked, 3 cancelled; workflows: 0 turns, 0 completed, 0 failed, 2 stopped/,
      );
      for (const workflow of store.workflows.list()) {
        expect(workflow).toMatchObject({ state: "stopped", stopReason: "user_stop" });
        for (const task of store.workflows.tasks(workflow.workflowId))
          expect(task.state).toBe("cancelled");
      }
      const byGoal = (goal: string) => store.tasks.list().find((task) => task.goal === goal);
      expect(byGoal("Slow standalone")?.state).toBe("cancelled");
      expect(byGoal("Later standalone")?.state).toBe("ready");
      expect(store.runtime.haltState().halted).toBe(true);
      expect(store.runtime.leaseSummary()).toMatchObject({ status: "released" });
      expect(store.budgets.get(budget.budgetId)).toMatchObject({ reserved: 0, spent: 5000 });
      expect(store.runs.processes()).toEqual([]);

      // A second stop finds nothing to stop and changes nothing.
      const again = harness();
      expect(await run(["stop", "--now"], again.io, host)).toBe(0);
      expect(again.out.join("\n")).toContain("already halted");
      expect(store.commands.listQueued()).toEqual([]);

      // Halted: a run claims nothing until haril resume, then the waiting task runs.
      const fakeHost: HostInfo = sb.host;
      const halted = harness();
      expect(await run(["run"], halted.io, fakeHost)).toBe(0);
      expect(halted.out.join("\n")).toContain("halted");
      expect(byGoal("Later standalone")?.state).toBe("ready");
      const resume = harness();
      expect(await run(["resume"], resume.io, fakeHost)).toBe(0);
      expect(resume.out.join("\n")).toContain("queued");
      const after = harness();
      expect(await run(["run"], after.io, fakeHost)).toBe(0);
      expect(byGoal("Later standalone")?.state).toBe("completed");
      expect(byGoal("Slow standalone")?.state).toBe("cancelled");
      expect(store.runtime.haltState().halted).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "haril workflow stop kills only that workflow's agents; the runtime and the other workflow go on",
    async () => {
      const host: HostInfo = {
        ...sb.host,
        agentRuntime: stuckAgents(),
        signals: new EventEmitter(),
        forceExit: () => undefined,
      };
      await queue(host, [
        "workflow",
        "start",
        "Ship the button",
        "--model",
        "fake/high-model",
        "--autonomous",
      ]);
      await queue(host, [
        "workflow",
        "start",
        "Write the tests",
        "--model",
        "fake/high-model",
        "--autonomous",
      ]);
      const runtime = startRuntime(host);
      const store = open();
      const agents = await agentsInFlight(store, 2);
      const [target, other] = [...store.workflows.list()].reverse();
      if (target === undefined || other === undefined) throw new Error("two workflows expected");
      const targetTasks = new Set(
        store.workflows.tasks(target.workflowId).map((task) => task.taskId),
      );
      const runTask = new Map(
        store.runs.processes().map((record) => [record.runId, record.taskId]),
      );
      const targetAgent = agents.find((agent) => targetTasks.has(runTask.get(agent.runId) ?? ""));
      const otherAgent = agents.find((agent) => agent !== targetAgent);
      if (targetAgent === undefined || otherAgent === undefined)
        throw new Error("agents not found");

      const stop = harness();
      const stoppedAt = Date.now();
      expect(await run(["workflow", "stop", target.workflowId], stop.io, host)).toBe(0);
      await until(
        () => !alive(targetAgent.pi) && !alive(targetAgent.tool),
        "the stopped workflow's agent gone",
        STOP_BUDGET_MS,
      );
      expect(Date.now() - stoppedAt).toBeLessThan(STOP_BUDGET_MS);
      expect(stop.out.join("\n")).toContain(`workflow ${target.workflowId} stopped`);
      expect(store.workflows.get(target.workflowId)).toMatchObject({ state: "stopped" });
      expect(store.workflows.get(other.workflowId)).toMatchObject({ state: "running" });
      expect(alive(otherAgent.pi)).toBe(true);
      expect(alive(otherAgent.tool)).toBe(true);
      expect(store.runtime.haltState().halted).toBe(false);
      expect(store.runtime.leaseSummary()).toMatchObject({ status: "active" });

      const end = harness();
      expect(await run(["stop", "--now"], end.io, host)).toBe(0);
      await until(
        () => !alive(otherAgent.pi) && !alive(otherAgent.tool),
        "the other agent gone",
        STOP_BUDGET_MS,
      );
      expect(await runtime.done).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stop --now after a graceful stop still kills every agent within 2 s, and the runtime applies it itself",
    async () => {
      const host: HostInfo = {
        ...sb.host,
        agentRuntime: stuckAgents(),
        signals: new EventEmitter(),
        forceExit: () => undefined,
      };
      await queue(host, [
        "workflow",
        "start",
        "Ship the button",
        "--model",
        "fake/high-model",
        "--autonomous",
      ]);
      await queue(host, ["task", "add", "Slow standalone", "--agent", "fake:slow:600000"]);
      const runtime = startRuntime(host);
      const store = open();
      const agents = await agentsInFlight(store, 2);

      // The graceful stop: each hung agent is asked to abort, ignores it and waits out its grace period.
      const graceful = harness();
      expect(await run(["stop", "--json"], graceful.io, host)).toBe(0);
      const { commandId } = parseJson<{ commandId: string }>(graceful.out);
      await until(() => store.commands.get(commandId)?.status === "applied", "the graceful stop");
      for (const agent of agents) expect(alive(agent.pi)).toBe(true);

      const stop = harness();
      const stoppedAt = Date.now();
      expect(await run(["stop", "--now", "--json"], stop.io, host)).toBe(0);
      await until(
        () => agents.every((agent) => !alive(agent.pi) && !alive(agent.tool)),
        "every agent process gone",
        STOP_BUDGET_MS,
      );
      expect(Date.now() - stoppedAt).toBeLessThan(STOP_BUDGET_MS);
      expect(parseJson(stop.out)).toMatchObject({
        runtime: "stopped",
        halted: true,
        processes: { alive: 0, unverified: 0 },
      });
      expect(await runtime.done).toBe(0);
      expect(runtime.out.out.join("\n")).toContain("stopping now (emergency stop)");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a second signal kills the agents and their tools before the forced exit",
    async () => {
      const signals = new EventEmitter();
      const forced: { code: number; aliveAtExit: boolean[] }[] = [];
      let agents: Agent[] = [];
      const host: HostInfo = {
        ...sb.host,
        agentRuntime: stuckAgents(),
        signals,
        forceExit: (code) => {
          forced.push({
            code,
            aliveAtExit: agents.flatMap((agent) => [alive(agent.pi), alive(agent.tool)]),
          });
        },
      };
      await queue(host, [
        "workflow",
        "start",
        "Ship the button",
        "--model",
        "fake/high-model",
        "--autonomous",
      ]);
      const runtime = startRuntime(host);
      const store = open();
      agents = await agentsInFlight(store, 1);

      signals.emit("SIGINT");
      signals.emit("SIGINT");
      await until(() => forced.length === 1, "the forced exit", 5000);
      expect(forced[0]?.code).toBe(130);
      // Pi is gone when the exit happens; its tool command (outside Pi's job object on Windows) is gone with it.
      expect(forced[0]?.aliveAtExit[0]).toBe(false);
      await until(() => agents.every((agent) => !alive(agent.tool)), "the tool command gone", 2000);
      // The spy did not exit, so the ordered stop of the first signal finishes and returns the turn to ready.
      expect(await runtime.done).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
