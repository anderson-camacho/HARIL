import { randomUUID } from "node:crypto";
import { validateHumanRequest } from "@haril/contracts";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
  DEFAULT_QUOTA_POLICY,
  type DifficultyTable,
} from "@haril/core";
import type {
  AgentSpec,
  Clock,
  DelegationToolResult,
  Store,
  WorkflowAutonomy,
} from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFactoryModel } from "../src/commands/factory-model.js";
import { agentMessages, appendAgentMessage } from "../src/runtime/agent-messages.js";
import { createDelegationTools } from "../src/runtime/delegation-tools.js";
import { raiseHumanRequest } from "../src/runtime/human-requests.js";
import { runUntilIdle } from "../src/runtime/run-loop.js";
import { createShutdown } from "../src/runtime/shutdown.js";
import { readWebPage, webUrlProblem } from "../src/runtime/web-read.js";
import type { DelegationOptions } from "../src/runtime/workflow-view.js";
import { makeSandbox, type Sandbox, workflowIntake } from "./helpers.js";

// The factory's rules with the real store and the real loop; only the agents are scripted.

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
const AUTONOMOUS: WorkflowAutonomy = { mode: "autonomous", stops: [] };
const MODELS = [
  "cliproxy/A/claude-opus-5-5",
  "cliproxy/B/gpt-6.1-sol",
  "cliproxy/C/gemini-4-argon",
  "cliproxy/D/deepseek-v4-pro",
];

function classes(order: readonly string[]): DifficultyTable["classes"] {
  return Object.fromEntries(
    ["trivial", "easy", "medium", "hard", "expert"].map((name) => [
      name,
      { minSuccessRate: 0, order: [...order] },
    ]),
  ) as unknown as DifficultyTable["classes"];
}

function options(
  models: readonly string[] = MODELS,
  roles: Record<
    string,
    { archetype: "executor" | "auditor"; floor: "low" | "mid" | "high"; order: readonly string[] }
  > = {},
  quota: Record<string, unknown> = {},
): DelegationOptions {
  return {
    limits: undefined as never,
    models: {
      catalog: models.map((ref) => ({
        ref,
        quotaKey: ref.split("/").slice(0, 2).join("/"),
        hasKey: true,
        coolingUntil: null,
      })),
      allow: {},
      pinned: {},
      quota: quota as never,
      table: { classes: classes(models), models: {} },
      stats: {},
      policy: DEFAULT_QUOTA_POLICY,
      roles,
    },
  };
}

function withoutUndefined(given: DelegationOptions): DelegationOptions {
  const { limits: _limits, ...rest } = given;
  return rest;
}

type Script = (
  spec: AgentSpec,
  call: (tool: string, input: unknown) => Promise<DelegationToolResult>,
) => Promise<string | "stall">;

let sb: Sandbox;
let store: Store;

beforeEach(() => {
  sb = makeSandbox();
  store = openStore({ dataDir: sb.dataDir, clock, ids: { next: () => randomUUID() }, rules });
  const { projectId } = store.projects.register({ slug: "demo", name: "Demo", rootPath: sb.root });
  store.commands.enqueue({
    type: "workflow.start",
    projectId,
    args: {
      intake: workflowIntake(sb.root),
      goal: "Decide",
      model: MODELS[0],
      agent: "fake:orchestrate",
      autonomy: AUTONOMOUS,
      budgetTokens: 200_000,
      timeoutMs: 60_000,
    },
    idempotencyKey: "wf",
    requestHash: "wf",
  });
});

afterEach(() => {
  store.close();
  sb.cleanup();
});

async function play(
  script: Script,
  delegation: DelegationOptions = options(),
  turnEndAfterMs?: number,
) {
  const settled = withoutUndefined(delegation);
  const tools = createDelegationTools({ store, clock, options: settled });
  const agents = new FakeAgentRuntime({
    clock,
    delegationTools: tools.call,
    turnScript: script,
    ...(turnEndAfterMs === undefined ? {} : { turnEndAfterMs }),
  });
  await runUntilIdle({
    store,
    agentRuntime: agents,
    clock,
    pid: process.pid,
    nodeVersion: process.version,
    onEvent: () => undefined,
    idleExitMs: 0,
    pollMs: 5,
    shutdown: createShutdown(),
    delegationTools: tools,
    delegation: settled,
  });
}

function part(localId: string) {
  return {
    localId,
    goal: `Part ${localId}`,
    description: "",
    difficulty: "easy",
    difficultyReason: "small",
    dependsOn: [],
    priority: 5,
    acceptanceCriteria: ["done"],
    budget: { maxTokens: 100_000 },
    role: "arquitecto",
  };
}

function step(localId: string, role: string | null, dependsOn: readonly string[] = []) {
  return {
    localId,
    goal: `Step ${localId}`,
    instructions: `Do ${localId}`,
    files: { write: [], read: [] },
    tests: "",
    acceptanceCriteria: ["done"],
    difficulty: "easy",
    difficultyReason: "small",
    dependsOn: [...dependsOn],
    budget: { maxTokens: 100_000 },
    ...(role === null ? {} : { role }),
  };
}

const approve = { approved: true, reasons: [{ criterion: "done", ok: true, evidence: "seen" }] };

function planner(assign: (spec: AgentSpec) => unknown): Script {
  return async (spec, call) => {
    const input = spec.delegation;
    if (input === undefined) throw new Error("no input");
    if (input.role === "orchestrator") {
      if (input.turnKind === "first") {
        await call("haril_delegate", {
          schemaVersion: 1,
          memo: "plan",
          delegations: [part("web")],
        });
      } else {
        await call("haril_request_audit", { summary: "done", outstanding: [] });
      }
      return "ok";
    }
    if (input.role === "delegator") {
      if (input.turnKind === "first") await call("haril_assign", assign(spec));
      else await call("haril_report", { status: "done", summary: "done", issues: [] });
      return "ok";
    }
    if (input.role === "auditor") {
      await call("haril_verdict", approve);
      return "ok";
    }
    return `answer of ${input.label} on ${spec.model}`;
  };
}

describe("a role's tools", () => {
  it("refuses a write by a consultor, and offers it nothing but read", async () => {
    const seen: { tools: readonly string[]; reply: DelegationToolResult }[] = [];
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("ask", "consultor")],
    }));
    await play(async (spec, call) => {
      if (spec.delegation?.role === "executor") {
        const reply = await call("write", { path: "a.ts", content: "x" });
        seen.push({ tools: spec.allowedTools, reply });
        return "read only";
      }
      return base(spec, call);
    });
    expect(seen[0]?.tools).toEqual(["read"]);
    expect(seen[0]?.reply).toMatchObject({ ok: false });
    expect(seen[0]?.reply).toMatchObject({ reason: expect.stringContaining("consultor") });
  });

  it("gives the sintetizador no tools, and its council's opinions in the prompt", async () => {
    const seen: { tools: readonly string[]; prompt: string }[] = [];
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [
        step("c1", "consejero"),
        step("c2", "consejero"),
        step("c3", "consejero"),
        step("sum", "sintetizador", ["c1", "c2", "c3"]),
      ],
    }));
    await play(async (spec, call) => {
      if (spec.delegation?.roleName === "sintetizador" && spec.delegation.role === "executor") {
        seen.push({ tools: spec.allowedTools, prompt: spec.prompt });
      }
      return base(spec, call);
    });
    expect(seen[0]?.tools).toEqual([]);
    expect(seen[0]?.prompt).toContain("[opinion of c1");
    expect(seen[0]?.prompt).toContain("answer of web/c3");
  });
});

describe("a discussion", () => {
  it("refuses a proposal with two councillors", async () => {
    let reason = "";
    const base = planner(() => ({ schemaVersion: 1, memo: "", assignments: [step("x", null)] }));
    await play(async (spec, call) => {
      if (spec.delegation?.role === "delegator" && spec.delegation.turnKind === "first") {
        const refused = await call("haril_assign", {
          schemaVersion: 1,
          memo: "",
          assignments: [step("c1", "consejero"), step("c2", "consejero")],
        });
        reason = refused.ok ? "" : refused.reason;
      }
      return base(spec, call);
    });
    expect(reason).toContain("council_size");
    expect(reason).toContain("at least 3");
  });

  it("stops with an explanation when fewer than three give an opinion", async () => {
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [
        step("c1", "consejero"),
        step("c2", "consejero"),
        step("c3", "consejero"),
        step("sum", "sintetizador", ["c1", "c2", "c3"]),
      ],
    }));
    const ran: string[] = [];
    await play(async (spec, call) => {
      const input = spec.delegation;
      if (input?.roleName === "consejero" && input.role === "executor") {
        ran.push(spec.model ?? "");
        return input.label.endsWith("c3") ? "   " : "my opinion";
      }
      if (input?.roleName === "sintetizador" && input.role === "executor") {
        throw new Error("the sintetizador must not run");
      }
      return base(spec, call);
    });
    const [workflow] = store.workflows.list();
    expect(workflow?.state).toBe("awaiting_human");
    expect(workflow?.stopReason).toBe("council_below_minimum:2/3");
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(model.workflows[0]?.explanation.why).toContain("al menos 3");
    // The empty councillor was retried on another model before giving up.
    const c3 = store.workflows
      .tasks(workflow?.workflowId ?? "")
      .filter((row) => row.localId === "c3");
    expect(c3.length).toBeGreaterThan(1);
    expect(new Set(c3.map((row) => row.model)).size).toBeGreaterThan(1);
  });

  it("gives each councillor its own model, and marks one that repeats", async () => {
    const list = MODELS.slice(0, 2);
    const delegation = options(list, {
      consejero: { archetype: "auditor", floor: "low", order: list },
    });
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("c1", "consejero"), step("c2", "consejero"), step("c3", "consejero")],
    }));
    await play(base, delegation);
    const [workflow] = store.workflows.list();
    const models = store.workflows
      .tasks(workflow?.workflowId ?? "")
      .filter((row) => row.role === "executor")
      .map((row) => row.model);
    expect(new Set(models).size).toBe(2);
    const model = buildFactoryModel(store, { now: Date.now() });
    const notes = model.tasks.flatMap((task) => task.notes);
    expect(notes.join(" ")).toContain("Modelo repetido");
  });
});

describe("seguridad", () => {
  it("reviews on two vendors when two are connected", async () => {
    const delegation = options(MODELS, {
      seguridad: { archetype: "auditor", floor: "low", order: MODELS.slice(0, 2) },
    });
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("sec", "seguridad")],
    }));
    await play(base, delegation);
    const [workflow] = store.workflows.list();
    const turns = store.workflows.tasks(workflow?.workflowId ?? "");
    const executor = turns.find((row) => row.localId === "sec");
    const auditor = turns.find((row) => row.auditedTaskId === executor?.taskId);
    expect(executor?.model).not.toBe(auditor?.model);
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(model.tasks.flatMap((task) => task.notes).join(" ")).not.toContain("un solo proveedor");
  });

  it("says it ran with one when only one is connected", async () => {
    const one = ["cliproxy/A/claude-opus-5-5", "cliproxy/E/claude-opus-5-5-b"];
    const delegation = options(one, {
      seguridad: { archetype: "auditor", floor: "low", order: one },
    });
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("sec", "seguridad")],
    }));
    await play(base, delegation);
    const model = buildFactoryModel(store, { now: Date.now() });
    expect(model.tasks.flatMap((task) => task.notes).join(" ")).toContain("un solo proveedor");
  });
});

describe("a failed task", () => {
  it("comes back to its parent with the error, what was tried and what was done", async () => {
    const seen: unknown[] = [];
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("t", "tester")],
    }));
    await play(async (spec, call) => {
      const input = spec.delegation;
      if (input?.role === "auditor" && input.subject?.scope === "task") {
        await call("haril_verdict", {
          approved: false,
          reasons: [{ criterion: "done", ok: false, evidence: "a test fails" }],
        });
        return "rejected";
      }
      if (input?.role === "delegator" && input.turnKind !== "first") {
        seen.push(input.children[0]);
        expect(spec.prompt).toContain("error: audit.rejected");
        expect(spec.prompt).toContain("tried:");
      }
      return base(spec, call);
    });
    // A tester goes back at once: no second run of the same test.
    expect(seen[0]).toMatchObject({
      status: "escalated",
      retries: 0,
      failure: { code: "audit.rejected", message: "done" },
    });
  });
});

describe("a person's message", () => {
  it("reaches the agent at the end of its turn, and tells it to report the correction", async () => {
    const prompts: string[] = [];
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("s", "backend")],
    }));
    let sent = false;
    await play(async (spec, call) => {
      const input = spec.delegation;
      if (input?.role === "executor") {
        prompts.push(spec.prompt);
        if (!sent) {
          sent = true;
          const [workflow] = store.workflows.list();
          appendAgentMessage(store, {
            id: "m1",
            workflowId: workflow?.workflowId ?? "",
            projectId: workflow?.projectId ?? "",
            threadId: input.threadId,
            taskId: spec.taskId,
            text: "Usa el otro archivo",
            urgent: false,
            from: "persona",
          });
        }
      }
      return base(spec, call);
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("Usa el otro archivo");
    expect(prompts[1]).toContain("Usa el otro archivo");
    expect(prompts[1]).toContain("tell your parent");
    const [workflow] = store.workflows.list();
    expect(agentMessages(store, workflow?.workflowId ?? "")[0]?.state).toBe("applied");
    // A message is not a provider's failure: it spends no retry.
    const first = store.workflows
      .tasks(workflow?.workflowId ?? "")
      .find((row) => row.localId === "s");
    expect(store.workflows.providerRetries(first?.taskId ?? "")).toBe(0);
  });

  it("stops the attempt at once when urgent, and resumes it with the message", async () => {
    const prompts: string[] = [];
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("s", "backend")],
    }));
    let stalled = false;
    await play(async (spec, call) => {
      const input = spec.delegation;
      if (input?.role === "executor") {
        prompts.push(spec.prompt);
        if (!stalled) {
          stalled = true;
          const [workflow] = store.workflows.list();
          appendAgentMessage(store, {
            id: "m2",
            workflowId: workflow?.workflowId ?? "",
            projectId: workflow?.projectId ?? "",
            threadId: input.threadId,
            taskId: spec.taskId,
            text: "Para ya",
            urgent: true,
            from: "persona",
          });
          return "stall";
        }
      }
      return base(spec, call);
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Para ya");
    expect(prompts[1]).toContain("(urgent)");
  });
});

describe("a handoff", () => {
  const hot = {
    available: true,
    window5hUsedPct: 85,
    weeklyUsedPct: 10,
    window5hResetsAt: null,
    weeklyResetsAt: null,
  };

  it("continues the same task on the role's next model at the end of a model turn", async () => {
    const list = MODELS.slice(0, 2);
    let hotNow = false;
    const delegation = options(list, {
      backend: { archetype: "executor", floor: "low", order: list },
    });
    const models = delegation.models as Record<string, unknown>;
    const withQuota: DelegationOptions = {
      ...withoutUndefined(delegation),
      models: () =>
        ({
          ...models,
          quota: hotNow ? { "cliproxy/A": hot } : {},
        }) as never,
    };
    const prompts: { model: string | undefined; prompt: string }[] = [];
    const base = planner(() => ({
      schemaVersion: 1,
      memo: "",
      assignments: [step("s", "backend")],
    }));
    let first = true;
    await play(
      async (spec, call) => {
        if (spec.delegation?.role === "executor") {
          prompts.push({ model: spec.model, prompt: spec.prompt });
          if (first) {
            first = false;
            hotNow = true;
            return "stall";
          }
        }
        return base(spec, call);
      },
      withQuota,
      1_200,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.model).toBe(list[0]);
    expect(prompts[1]?.model).toBe(list[1]);
    expect(prompts[1]?.prompt).toContain("You take this task over from");
    const model = buildFactoryModel(store, { now: Date.now() });
    const handoff = model.handoffs.find((row) => row.kind === "agent");
    expect(handoff).toMatchObject({ from: list[0], to: list[1], reason: "quota" });
    const [workflow] = store.workflows.list();
    const task = store.workflows
      .tasks(workflow?.workflowId ?? "")
      .find((row) => row.localId === "s");
    expect(store.workflows.providerRetries(task?.taskId ?? "")).toBe(0);
  }, 20_000);
});

describe("a request to a person", () => {
  const complete = {
    schemaVersion: 1,
    reason: "decision",
    who: "web/s",
    delegatedBy: "web",
    workflowId: "w",
    taskId: "t",
    task: "Step",
    doing: "Publica",
    needs: "Permiso",
    why: "Porque sí",
    ifRefused: "Nada cambia",
    blocks: ["web"],
    action: null,
    notifyThreadId: null,
  };

  it("is refused with what is missing", () => {
    expect(validateHumanRequest(complete).ok).toBe(true);
    for (const field of ["who", "delegatedBy", "task", "doing", "needs", "why", "ifRefused"]) {
      const { [field as "who"]: _gone, ...rest } = complete;
      expect(validateHumanRequest(rest).ok).toBe(false);
      expect(validateHumanRequest({ ...complete, [field]: "  " }).ok).toBe(false);
    }
    expect(validateHumanRequest({ ...complete, blocks: [] }).ok).toBe(false);
  });

  it("does not reach the store when incomplete", () => {
    const [project] = store.projects.list();
    const raised = raiseHumanRequest(store, 0, {
      projectId: project?.projectId ?? "",
      requestedBy: "run",
      request: { ...complete, why: "" } as never,
    });
    expect(raised.ok).toBe(false);
    expect(store.approvals.list({ status: "requested" })).toHaveLength(0);
  });
});

describe("the investigador's web", () => {
  it("refuses what is not a public https page", () => {
    expect(webUrlProblem("http://example.com")).toContain("https");
    expect(webUrlProblem("https://localhost/x")).toContain("not a public");
    expect(webUrlProblem("https://10.0.0.1/x")).toContain("not a public");
    expect(webUrlProblem("https://192.168.1.1/x")).toContain("not a public");
    expect(webUrlProblem("https://[::1]/x")).toContain("not a public");
    expect(webUrlProblem("https://user:pw@example.com")).toContain("credentials");
    expect(webUrlProblem("https://example.com/x")).toBeNull();
  });

  it("checks a redirect again, and reads without the network here", async () => {
    const pages: Record<string, { status: number; location?: string; body?: string }> = {
      "https://example.com/a": { status: 302, location: "https://10.0.0.1/secret" },
      "https://example.com/b": { status: 200, body: "hola" },
    };
    const fetcher = async (url: string) => {
      const page = pages[url] ?? { status: 404 };
      return {
        status: page.status,
        headers: { get: () => page.location ?? null },
        body: (async function* () {
          yield new TextEncoder().encode(page.body ?? "");
        })(),
      };
    };
    const lookup = async () => ["93.184.216.34"];
    expect(await readWebPage("https://example.com/a", fetcher, { lookup })).toMatchObject({
      ok: false,
    });
    expect(await readWebPage("https://example.com/b", fetcher, { lookup })).toMatchObject({
      ok: true,
      text: "hola",
    });
  });
});
