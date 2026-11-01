import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_DELEGATION_LIMITS,
  DEFAULT_QUOTA_POLICY,
  type DelegationLimits,
  type DifficultyTable,
} from "@haril/core";
import type { AgentSpec, Clock, DelegationToolResult, Store } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFactoryModel } from "../src/commands/factory-model.js";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import type { GitActionResult, GitActionRunner } from "../src/runtime/human-requests.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import type { DelegationOptions } from "../src/runtime/workflow-view.js";
import { createWorkspaces } from "../src/runtime/worktrees.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// The user's scenario, "hazme una página", end to end with the real store, the real loop and a real git repository; only
// the agents are scripted and the push is not run. The orchestrator writes its plan; a consultor reads; a disenador and a
// frontend write; the tester fails once and goes back to its parent, which sends a fixer; the tester passes; the
// product-owner accepts; and git asks a person before it publishes. Nothing here touches the network.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

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
const ORCHESTRATOR = "cliproxy/A/claude-opus-5-5";
const HAIKU = "cliproxy/A/claude-haiku-5-5";
const SONNET = "cliproxy/A/claude-sonnet-5-5";
const SOL = "cliproxy/B/gpt-6.1-sol";
const CATALOG = [ORCHESTRATOR, HAIKU, SONNET, SOL];

function classes(order: readonly string[]): DifficultyTable["classes"] {
  return Object.fromEntries(
    ["trivial", "easy", "medium", "hard", "expert"].map((name) => [
      name,
      { minSuccessRate: 0, order: [...order] },
    ]),
  ) as unknown as DifficultyTable["classes"];
}

const OPTIONS: DelegationOptions = {
  limits: LIMITS,
  models: {
    catalog: CATALOG.map((ref) => ({
      ref,
      quotaKey: ref.split("/").slice(0, 2).join("/"),
      hasKey: true,
      coolingUntil: null,
    })),
    allow: {},
    pinned: {},
    quota: {},
    table: { classes: classes(CATALOG), models: {} },
    stats: {},
    policy: DEFAULT_QUOTA_POLICY,
    roles: {
      arquitecto: { archetype: "orchestrator", floor: "high", order: [ORCHESTRATOR] },
      consultor: { archetype: "executor", floor: "low", order: [HAIKU] },
      disenador: { archetype: "executor", floor: "mid", order: [ORCHESTRATOR, SONNET] },
      frontend: { archetype: "executor", floor: "mid", order: [SONNET, SOL] },
      tester: { archetype: "executor", floor: "mid", order: [SONNET] },
      fixer: { archetype: "executor", floor: "mid", order: [SOL, SONNET] },
      "product-owner": { archetype: "auditor", floor: "mid", order: [SONNET] },
      git: { archetype: "executor", floor: "low", order: [HAIKU] },
    },
  },
};

let sb: Sandbox;
let repo: string;
let env: NodeJS.ProcessEnv;
let store: Store;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=HARIL test", "-c", "user.email=test@haril.invalid", "-C", repo, ...args],
    { windowsHide: true, encoding: "utf8", env },
  ).trim();
}

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
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(
    join(repo, "smoke.test.mjs"),
    "import { test } from 'node:test';\ntest('ok', () => {});\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  store = openStore({
    dataDir: sb.dataDir,
    clock,
    ids: { next: () => randomUUID() },
    rules,
    isPidAlive: () => true,
  });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

function step(
  localId: string,
  role: string,
  write: readonly string[],
  dependsOn: readonly string[] = [],
) {
  return {
    localId,
    goal: `${role}: ${localId}`,
    instructions: `Do the ${role} work`,
    files: { write: [...write], read: [] },
    tests: write.length === 0 ? "" : "npm test",
    acceptanceCriteria: ["done"],
    difficulty: "medium",
    difficultyReason: "a page",
    dependsOn: [...dependsOn],
    budget: { maxTokens: 100_000 },
    role,
  };
}

const met = { approved: true, reasons: [{ criterion: "done", ok: true, evidence: "seen" }] };
const unmet = {
  approved: false,
  reasons: [{ criterion: "done", ok: false, evidence: "the page test fails" }],
};

const FIRST_PLAN = [
  step("leer", "consultor", []),
  step("diseno", "disenador", ["design/page.md"], ["leer"]),
  step("pagina", "frontend", ["src/page.html"], ["leer"]),
  step("probar", "tester", ["tests/page.test.mjs"], ["diseno", "pagina"]),
  step("aceptar", "product-owner", [], ["probar"]),
  step("publicar", "git", [], ["aceptar"]),
];

const SECOND_PLAN = [
  step("corregir", "fixer", ["src/fix.html"]),
  step("probar", "tester", ["tests/page.test.mjs"], ["corregir"]),
  step("aceptar", "product-owner", [], ["probar"]),
  step("publicar", "git", [], ["aceptar"]),
];

interface Seen {
  plan: string | null;
  reportedFailure: unknown;
  gitReply: DelegationToolResult | null;
  gitStatus: DelegationToolResult | null;
  mergeRefused: string[];
  answer: string | null;
}

function script(seen: Seen) {
  let testerRuns = 0;
  return async (
    spec: AgentSpec,
    call: (tool: string, input: unknown) => Promise<DelegationToolResult>,
  ): Promise<string> => {
    const input = spec.delegation;
    if (input === undefined) throw new Error("not a workflow turn");
    if (input.role === "orchestrator") {
      if (input.turnKind === "first") {
        const memo =
          "Plan: una parte web; primero leer, luego diseño y página, pruebas, aceptación y publicar.";
        seen.plan = memo;
        await call("haril_delegate", {
          schemaVersion: 1,
          memo,
          delegations: [
            {
              localId: "web",
              goal: "Hacer la página",
              description: "La página pedida",
              difficulty: "medium",
              difficultyReason: "una página",
              dependsOn: [],
              priority: 5,
              acceptanceCriteria: ["La página existe y pasa sus pruebas"],
              budget: { maxTokens: 200_000 },
              role: "arquitecto",
            },
          ],
        });
      } else {
        await call("haril_request_audit", { summary: "Hecho", outstanding: [] });
      }
      return "ok";
    }
    if (input.role === "delegator") {
      const failed = input.children.find((child) => child.localId === "probar");
      if (input.turnKind === "first") {
        await call("haril_assign", { schemaVersion: 1, memo: "", assignments: FIRST_PLAN });
        return "ok";
      }
      if (failed?.status === "escalated") {
        seen.reportedFailure = failed;
        await call("haril_assign", { schemaVersion: 1, memo: "", assignments: SECOND_PLAN });
        return "ok";
      }
      if ((input.messages ?? []).length > 0) seen.answer = input.messages?.[0]?.text ?? null;
      for (const child of input.children) {
        if (child.status !== "approved") continue;
        const merged = await call("haril_merge", { localId: child.localId });
        if (!merged.ok) seen.mergeRefused.push(`${child.localId}: ${merged.reason}`);
      }
      await call("haril_report", { status: "done", summary: "La página está", issues: [] });
      return "ok";
    }
    if (input.role === "auditor") {
      if (input.subject?.scope === "workflow") {
        await call("haril_verdict", met);
        return "ok";
      }
      const writes =
        input.subject?.label.includes("leer") !== true && spec.allowedTools.includes("haril_run");
      if (writes) await call("haril_run", { command: "npm", args: ["test"] });
      const tester = input.subject?.label.endsWith("probar") === true;
      if (tester && testerRuns++ === 0) {
        await call("haril_verdict", unmet);
        return "rejected";
      }
      await call("haril_verdict", met);
      return "ok";
    }
    // Executors.
    const role = input.roleName;
    if (role === "git") {
      seen.gitStatus = await call("haril_git", {
        command: "git",
        args: ["status", "--short"],
        why: "ver el estado",
      });
      seen.gitReply = await call("haril_git", {
        command: "git",
        args: ["push", "origin", "web"],
        why: "publicar la página aceptada",
      });
      return "Pedí permiso para publicar.";
    }
    if (role === "disenador" || role === "frontend" || role === "fixer" || role === "tester") {
      for (const path of input.files.write) {
        const content =
          role === "tester"
            ? `import { test } from 'node:test';\ntest('page ${input.turn}', () => {});\n`
            : `${role} attempt ${input.turn}\n`;
        const wrote = await call("write", { path, content });
        if (!wrote.ok) throw new Error(wrote.reason);
      }
    }
    return `${role} terminó`;
  };
}

async function run(seen: Seen, gitAction: GitActionRunner): Promise<void> {
  const workspaces = createWorkspaces({
    root: join(sb.root, "wt"),
    commands: { allow: ["npm test"], timeoutMs: 60_000, outputMaxBytes: 4_096 },
    git: { env },
    env,
  });
  const tools = createDelegationTools({ store, clock, options: OPTIONS, workspaces });
  await runUntilIdle({
    store,
    agentRuntime: new FakeAgentRuntime({
      clock,
      delegationTools: tools.call,
      turnScript: script(seen),
    }),
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: () => undefined,
    idleExitMs: 0,
    pollMs: 10,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation: OPTIONS,
    workspaces,
    gitAction,
  });
}

describe.skipIf(!HAS_GIT)('"hazme una página"', () => {
  it("goes from the plan to a person's answer before publishing", async () => {
    const projectId = store.projects.register({
      slug: "demo",
      name: "Demo",
      rootPath: repo,
    }).projectId;
    store.commands.enqueue({
      type: "workflow.start",
      projectId,
      args: {
        intake: workflowIntake(repo),
        goal: "Hazme una página",
        model: ORCHESTRATOR,
        agent: "fake:orchestrate",
        autonomy: { mode: "autonomous", stops: [] },
        limits: LIMITS,
        budgetTokens: 200_000,
        timeoutMs: 60_000,
        baseBranch: "main",
        baseSha: git("rev-parse", "main"),
      },
      idempotencyKey: "hazme",
      requestHash: "hazme",
    });
    const seen: Seen = {
      plan: null,
      reportedFailure: null,
      gitReply: null,
      gitStatus: null,
      mergeRefused: [],
      answer: null,
    };
    const pushes: string[][] = [];
    const ran: GitActionResult = { exitCode: 0, output: " * [new branch] web -> web" };
    const gitAction: GitActionRunner = async (action) => {
      pushes.push([action.program, ...action.args]);
      return ran;
    };

    await run(seen, gitAction);

    // The orchestrator wrote its plan and never executed.
    expect(seen.plan).toContain("Plan:");
    const [workflow] = store.workflows.list();
    const workflowId = workflow?.workflowId ?? "";
    expect(store.workflows.delegations(workflowId)[0]?.memo).toContain("Plan:");

    // The tester failed once and came back with what the parent needs to choose.
    expect(seen.reportedFailure).toMatchObject({
      localId: "probar",
      status: "escalated",
      retries: 0,
      failure: { code: "audit.rejected" },
    });
    // git ran what only reads, and asked for the rest: nothing was pushed.
    expect(seen.gitStatus).toMatchObject({ ok: true });
    expect(seen.gitReply).toMatchObject({ ok: true, pending: true });
    expect(pushes).toEqual([]);
    expect(workflow?.state).toBe("awaiting_human");
    expect(workflow?.stopReason).toBe("human_request");

    let model = buildFactoryModel(store, { now: Date.now() });
    const byAgent = new Map(model.tasks.map((task) => [task.agent, task]));
    const taskOf = (role: string) => {
      const found = model.tasks.find((task) => task.role === role);
      if (found === undefined) throw new Error(`no task with role ${role}`);
      return found;
    };
    expect(taskOf("consultor").column).toBe("hechas");
    expect(taskOf("disenador").column).toBe("hechas");
    expect(taskOf("frontend").column).toBe("hechas");
    expect(taskOf("fixer").column).toBe("hechas");
    expect(taskOf("tester").column).toBe("hechas");
    expect(taskOf("product-owner").column).toBe("hechas");
    const publish = taskOf("git");
    expect(publish.column).toBe("detenidas");
    expect(publish.explanation).toMatchObject({ code: "human_request", needsHuman: true });
    expect(publish.explanation.what).toContain("git push origin web");

    // Who delegated whom, with the part in the middle.
    expect(byAgent.size).toBe(model.tasks.length);
    const parentOf = (role: string) =>
      model.edges.find((edge) => edge.child === taskOf(role).agent)?.parent;
    const part = model.tasks.find((task) => task.title === "Hacer la página")?.agent;
    for (const role of [
      "consultor",
      "disenador",
      "frontend",
      "tester",
      "fixer",
      "product-owner",
      "git",
    ]) {
      expect(parentOf(role)).toBe(part);
    }
    expect(model.edges.find((edge) => edge.child === part)?.parent).toBe(
      model.tasks.find((task) => task.delegatedBy === null)?.agent,
    );

    // Each role ran on its own list.
    expect(taskOf("consultor").model).toBe(HAIKU);
    expect(taskOf("frontend").model).toBe(SONNET);
    expect(taskOf("fixer").model).toBe(SOL);
    expect(taskOf("git").model).toBe(HAIKU);
    const reasons = store.events
      .list({ aggregateId: taskOf("consultor").id })
      .filter((event) => event.type === "model.selected")
      .map((event) => (event.payload as { reason?: string; role?: string }).role);
    expect(reasons).toContain("consultor");

    // The uniform request, as the person reads it.
    const [request] = model.humanRequests;
    expect(request).toMatchObject({
      kind: "human",
      request: {
        reason: "git_publish",
        who: "web/publicar",
        delegatedBy: "web",
        needs: "Permiso para ejecutar git push origin web",
        why: "publicar la página aceptada",
        blocks: ["web"],
        action: "git push origin web",
      },
    });
    expect(request?.request?.ifRefused).toContain("No se publica");

    // Every stopped card says why, and a person answers.
    for (const task of model.tasks.filter((row) => row.column === "detenidas")) {
      expect(task.explanation.why.length).toBeGreaterThan(0);
    }
    store.approvals.decide({
      approvalId: request?.id ?? "",
      outcome: "granted",
      decidedBy: "ander",
    });

    await run(seen, gitAction);

    expect(pushes).toEqual([["git", "push", "origin", "web"]]);
    expect(seen.mergeRefused).toEqual([]);
    expect(seen.answer).toContain("La persona aprobó");
    const [ended] = store.workflows.list();
    expect(ended?.stopReason === "human_request").toBe(false);
    expect(ended?.state).toBe("completed");
    model = buildFactoryModel(store, { now: Date.now() });
    expect(model.humanRequests).toEqual([]);
    expect(model.tasks.every((task) => task.column === "hechas")).toBe(true);
    expect(model.gitActions.map((row) => [row.level, row.command, row.exitCode])).toEqual([
      ["free", "git status --short", 0],
      ["publish", "git push origin web", 0],
    ]);
    // main is untouched: nothing was merged to it.
    expect(git("log", "--oneline", "main")).toContain("first");
    expect(git("log", "--oneline", "main").split("\n")).toHaveLength(1);
  });
});
