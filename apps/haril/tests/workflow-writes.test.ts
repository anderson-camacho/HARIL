import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationLimits,
  surfacesMayOverlap,
} from "@haril/core";
import type {
  AgentRuntime,
  AgentSpec,
  Clock,
  DelegationToolHandler,
  DelegationToolResult,
  Store,
} from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown, type Shutdown } from "../src/runtime/shutdown.js";
import { createWorkspaces, integrationBranchOf } from "../src/runtime/worktrees.js";
import { makeSandbox, type Sandbox } from "./helpers.js";

// Real git and real processes: under the load of the full suite one test can take several seconds, so this file gives
// its tests and hooks a minute instead of the suite's 15 s (a hang still fails it).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// Parallel writes end to end (docs/modos-y-delegacion.md 3.10, phase F8), hermetic: a temporary git repository as the
// project, the fake workflow agents inside FakeAgentRuntime, the real SQLite store and the real concurrent loop. Each
// executor writes its files in its own worktree created from main; the auditors run an allowed command there; the
// delegators merge the approved steps into the workflow's integration branch and resolve a conflict themselves. Steps
// whose write surfaces overlap never run at once; the others do. The result is an integration branch, main untouched.

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

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
const LIMITS: DelegationLimits = {
  ...DEFAULT_DELEGATION_LIMITS,
  maxConcurrent: { ...DEFAULT_DELEGATION_LIMITS.maxConcurrent, writers: 5 },
};

let sb: Sandbox;
let repo: string;
let env: NodeJS.ProcessEnv;
const stores: Store[] = [];

beforeEach(() => {
  sb = makeSandbox();
  repo = join(sb.root, "project");
  mkdirSync(join(repo, "src"), { recursive: true });
  const globalConfig = join(sb.root, "empty.gitconfig");
  writeFileSync(globalConfig, "");
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(sb.root),
  };
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  writeFileSync(join(repo, "src", "index.ts"), "export const ready = true;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  sb.cleanup();
});

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=HARIL test", "-c", "user.email=test@haril.invalid", "-C", repo, ...args],
    { windowsHide: true, encoding: "utf8", env },
  ).trim();
}

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

function startWorkflow(store: Store, goal: string): void {
  const projectId = store.projects.register({
    slug: "demo",
    name: "Demo",
    rootPath: repo,
  }).projectId;
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      goal,
      model: "fake/high-model",
      agent: "fake:orchestrate",
      autonomy: { mode: "autonomous", stops: [] },
      limits: LIMITS,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
      baseBranch: "main",
      baseSha: git("rev-parse", "main"),
    },
    idempotencyKey: `wf-${randomUUID()}`,
    requestHash: "h",
  });
}

interface WriterLog {
  peak: number;
  // Two writers whose surfaces may overlap ran at once.
  overlaps: string[];
}

// Watches the writers that run at once, as the store holds them: when an executor's agent starts, every executor task
// with a write surface in state running counts (a task runs from its claim, through its worktree and agent, to the
// close of its turn). Their number, and any pair whose write surfaces may overlap.
function tracked(inner: AgentRuntime, store: Store, log: WriterLog): AgentRuntime {
  return {
    start: async (spec: AgentSpec) => {
      const started = await inner.start(spec);
      if (!started.ok || spec.delegation === undefined) return started;
      const tasks = store.workflows.tasks(spec.delegation.workflowId);
      const task = tasks.find((row) => row.taskId === spec.taskId);
      if (task === undefined || task.role !== "executor" || task.surfaceWrite.length === 0) {
        return started;
      }
      const writers = tasks.filter(
        (row) => row.state === "running" && row.role === "executor" && row.surfaceWrite.length > 0,
      );
      log.peak = Math.max(log.peak, writers.length);
      for (const other of writers) {
        if (
          other.taskId !== task.taskId &&
          surfacesMayOverlap(other.surfaceWrite, task.surfaceWrite)
        ) {
          log.overlaps.push(`${other.surfaceWrite.join(",")} with ${task.surfaceWrite.join(",")}`);
        }
      }
      return started;
    },
  };
}

async function run(
  store: Store,
  setup: {
    readonly allow?: readonly string[];
    readonly shutdown?: Shutdown;
    // Stands between the fake agents and the host's tools: sees each call and may answer it itself.
    readonly wrap?: (call: DelegationToolHandler) => DelegationToolHandler;
  } = {},
): Promise<WriterLog> {
  const log: WriterLog = { peak: 0, overlaps: [] };
  const workspaces = createWorkspaces({
    root: join(sb.root, "wt"),
    commands: {
      allow: setup.allow ?? ["node --version"],
      timeoutMs: 60_000,
      outputMaxBytes: 4_096,
    },
    git: { env },
    env,
  });
  const tools = createDelegationTools({ store, clock, options: { limits: LIMITS }, workspaces });
  const agents = new FakeAgentRuntime({
    clock,
    delegationTools: setup.wrap === undefined ? tools.call : setup.wrap(tools.call),
    // Each turn takes a few milliseconds, so turns that may run together do.
    delegationDelayMs: (cost) => Math.round((cost.durationMs / 60_000) * 4),
  });
  await runUntilIdle({
    store,
    agentRuntime: tracked(agents, store, log),
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: () => undefined,
    idleExitMs: 0,
    pollMs: 20,
    shutdown: setup.shutdown ?? createShutdown(),
    delegationTools: tools,
    delegation: { limits: LIMITS },
    workspaces,
  });
  return log;
}

function onlyWorkflow(store: Store) {
  const [workflow] = store.workflows.list();
  if (workflow === undefined) throw new Error("no workflow");
  return workflow;
}

// Each scenario runs a whole workflow with real git: several seconds, more under the load of the full suite.
describe.skipIf(!HAS_GIT)("a workflow that writes in parallel", () => {
  it("writes disjoint files at once, overlapping ones in sequence, and leaves an integration branch", async () => {
    const store = open();
    const mainBefore = git("rev-parse", "main");
    startWorkflow(
      store,
      "Write the part [fake:parts=1] [fake:steps=3] [fake:own-files] [fake:run=node --version]",
    );
    const log = await run(store);
    const workflow = onlyWorkflow(store);
    expect(workflow.state).toBe("completed");

    // step-1 and step-3 write different files and ran at once; step-1 and step-2 share a file and never ran together
    // (step-2 waited for step-1's approval and started from its branch).
    expect(log.peak).toBeGreaterThanOrEqual(2);
    expect(log.overlaps).toEqual([]);

    const integration = integrationBranchOf(workflow.workflowId);
    expect(git("branch", "--list", integration)).toContain(integration);
    expect(git("show", `${integration}:src/part-1/shared.ts`)).toBe("part-1/step-2 attempt 1");
    expect(git("show", `${integration}:src/part-1/step-3.ts`)).toBe("part-1/step-3 attempt 1");
    expect(git("show", `${integration}:src/index.ts`)).toBe("export const ready = true;");
    // Every merge is a merge commit; main never moved and nothing was pushed (the repository has no remote).
    expect(git("rev-parse", "main")).toBe(mainBefore);
    expect(
      git("log", "--merges", "--format=%s", integration).split("\n").length,
    ).toBeGreaterThanOrEqual(3);
    expect(git("remote")).toBe("");

    // After integration, every worktree went away and the merged step branches with them; the integration branch stays.
    const worktrees = store.worktrees.list({ workflowId: workflow.workflowId });
    expect(worktrees.filter((record) => record.kind === "executor")).toHaveLength(3);
    expect(worktrees.every((record) => record.state === "removed")).toBe(true);
    expect(
      worktrees
        .filter((record) => record.kind === "executor")
        .every((record) => record.mergedAt !== null),
    ).toBe(true);
    for (const record of worktrees) expect(existsSync(record.path), record.path).toBe(false);
    // The workflow's folder of worktrees went with its last worktree.
    expect(existsSync(dirname(worktrees[0]?.path ?? ""))).toBe(false);
    expect(git("branch", "--list", `haril/${workflow.workflowId}/step/*`)).toBe("");
    expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);

    // The auditors ran the allowed command in each step's worktree.
    const commands = store.events.list().filter((event) => event.type === "workspace.command");
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands.every((event) => (event.payload as { exitCode: unknown }).exitCode === 0)).toBe(
      true,
    );
    // Each command's process was recorded with its run, and marked gone once it ended.
    expect(store.runs.processes({ endedSince: 0 }).length).toBe(commands.length);
    expect(store.runs.processes({ unverified: true })).toEqual([]);
  }, 120_000);

  it("kills the command a turn runs when the runtime stops in an emergency", async () => {
    writeFileSync(join(repo, "sleep.mjs"), "setTimeout(() => {}, 60000);");
    git("add", ".");
    git("commit", "--quiet", "-m", "a slow test");
    const store = open();
    startWorkflow(store, "Write the part [fake:parts=1] [fake:steps=1] [fake:run=node sleep.mjs]");
    const shutdown = createShutdown();
    // Once the auditor's command is recorded as running, the runtime is stopped at once.
    const watcher = setInterval(() => {
      if (store.runs.processes().length > 0) {
        clearInterval(watcher);
        shutdown.request("emergency");
      }
    }, 50);
    const started = Date.now();
    try {
      await run(store, { allow: ["node sleep.mjs"], shutdown });
    } finally {
      clearInterval(watcher);
    }
    expect(shutdown.requested).toBe(true);
    expect(Date.now() - started).toBeLessThan(45_000);
    // The command was recorded with its run and verified gone: nothing is left for a sweep.
    expect(store.runs.processes({ endedSince: 0 })).toHaveLength(1);
    expect(store.runs.processes({ unverified: true })).toEqual([]);
  }, 120_000);

  it("refuses a delegator's report of done while one of its approved steps is not merged", async () => {
    const store = open();
    startWorkflow(store, "Write the part [fake:parts=1] [fake:steps=1]");
    const reports: DelegationToolResult[] = [];
    // The delegator's merges never reach the host: its approved step stays out of the integration branch. Every other
    // call goes through as it came (a planning turn's calls answer at once).
    const wrap =
      (call: DelegationToolHandler): DelegationToolHandler =>
      (context, tool, input) => {
        if (tool === "haril_merge") return { ok: false, reason: "dropped by the test" };
        const reply = call(context, tool, input);
        if (tool === "haril_report" && (input as { status?: unknown }).status === "done") {
          void Promise.resolve(reply).then((answer) => reports.push(answer));
        }
        return reply;
      };
    await run(store, { wrap });
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toMatchObject({
      ok: false,
      reason: expect.stringContaining("merge your approved steps before reporting done"),
    });
    expect(git("rev-parse", "main")).toBe(store.workflows.list()[0]?.baseSha);
  }, 120_000);

  it("refuses a delegator's write outside the conflicting files, and any write while no merge waits", async () => {
    const store = open();
    startWorkflow(
      store,
      "Write a common file [fake:parts=2] [fake:steps=1] [fake:common=src/common.ts] [fake:run=node --version]",
    );
    const replies: { when: string; reply: DelegationToolResult }[] = [];
    let probedIdle = false;
    const wrap =
      (call: DelegationToolHandler): DelegationToolHandler =>
      (context, tool, input) => {
        if (tool !== "haril_merge" && tool !== "write") return call(context, tool, input);
        return probe(call, context, tool, input);
      };
    const probe = async (
      call: DelegationToolHandler,
      context: Parameters<DelegationToolHandler>[0],
      tool: string,
      input: unknown,
    ): Promise<DelegationToolResult> => {
      // Before the delegator's first merge: no merge waits, so a write resolves nothing.
      if (tool === "haril_merge" && !probedIdle) {
        probedIdle = true;
        replies.push({
          when: "idle",
          reply: await call(context, "write", { path: "src/common.ts", content: "x" }),
        });
      }
      // While a merge waits for its conflicts: a file outside them is refused (the delegator's own writes only).
      const role = store.workflows
        .tasks(onlyWorkflow(store).workflowId)
        .find((task) => task.taskId === context.taskId)?.role;
      if (tool === "write" && role === "delegator") {
        replies.push({
          when: "conflict",
          reply: await call(context, "write", { path: "src/elsewhere.ts", content: "x" }),
        });
      }
      return await call(context, tool, input);
    };
    await run(store, { allow: ["node --version"], wrap });
    expect(replies.find((item) => item.when === "idle")?.reply).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no merge waits for its conflicts"),
    });
    expect(replies.find((item) => item.when === "conflict")?.reply).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not one of the conflicting files"),
    });
    // The conflict itself was still resolved and merged.
    expect(onlyWorkflow(store).state).toBe("completed");
  }, 120_000);

  it("lets a delegator resolve the conflict of two parts that wrote the same file", async () => {
    const store = open();
    startWorkflow(
      store,
      "Write a common file [fake:parts=2] [fake:steps=1] [fake:common=src/common.ts] [fake:run=node --version]",
    );
    const log = await run(store);
    const workflow = onlyWorkflow(store);
    expect(workflow.state).toBe("completed");
    // Both first steps write src/common.ts: they never ran at once, and both started from main.
    expect(log.overlaps).toEqual([]);
    const integration = integrationBranchOf(workflow.workflowId);
    const common = git("show", `${integration}:src/common.ts`);
    expect(common).toMatch(/^resolved by part-[12] for step-1$/);
    expect(git("show", `${integration}:src/part-1/shared.ts`)).toBe("part-1/step-1 attempt 1");
    expect(git("show", `${integration}:src/part-2/shared.ts`)).toBe("part-2/step-1 attempt 1");
    expect(git("log", "--format=%s", integration)).toContain("conflicts resolved by the delegator");
    const merged = store.events.list().filter((event) => event.type === "worktree.merged");
    expect(merged).toHaveLength(2);
  }, 120_000);
});
