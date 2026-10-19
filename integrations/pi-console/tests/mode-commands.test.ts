import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandHost, registerCommands } from "../src/commands.js";
import { openDashboardActionMenu, runDashboardAction } from "../src/dashboard-actions.js";
import type { ConsoleMode } from "../src/modes.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// /mode and the CONSULT refusals (7.1, 7.3 point 4): CONSULT refuses every HARIL command that changes state (/init,
// /goal, /approve, /deny, /delegate, /continue) before the CLI runs, keeps the read-only ones, and the console actions
// that change state are refused and hidden from the /haril menu. PLAN hands its plan to /goal.

let fake: FakePi;
let ctx: FakeContext;
let cli: FakeCli;
let mode: ConsoleMode;
let switched: ConsoleMode[];
let plan: string | undefined;
let selects: { title: string; options: string[] }[];
let answer: (options: string[]) => string | undefined;

function host(): CommandHost {
  return {
    // A folder that exists: the CLI runs in it.
    cwd: tmpdir(),
    project: { slug: "fake-proj", name: "Fake", rootPath: tmpdir() },
    pending: [],
    area: undefined,
    started: undefined,
    harilModelRef: () => "fake-gw/fake-model",
    harilModels: () => ["fake-gw/fake-model", "fake-gw/fake-high-model"],
    showOutput: () => undefined,
    clearOutput: () => undefined,
    openArea: () => undefined,
    rebind: async () => undefined,
    refresh: async () => undefined,
    reload: async () => undefined,
    openActions: async () => undefined,
    toggleOrchestrationDemo: () => false,
    openOrchestrationView: async () => undefined,
    pickWorkflow: async () => false,
    mode: () => mode,
    switchMode(next) {
      switched.push(next);
      mode = next;
    },
    lastPlan: () => plan,
  } as CommandHost;
}

function command(name: string) {
  const found = fake.commands.get(name);
  if (found === undefined) throw new Error(`/${name} is not registered`);
  return found;
}

beforeEach(() => {
  cli = installFakeCli();
  fake = fakePi();
  ctx = fakeContext();
  mode = "action";
  switched = [];
  plan = undefined;
  selects = [];
  answer = () => undefined;
  (ctx.ui as { select: unknown }).select = async (title: string, options: string[]) => {
    selects.push({ title, options });
    return answer(options);
  };
  registerCommands(fake.pi, () => host());
});

afterEach(() => {
  cli.restore();
});

describe("/mode", () => {
  it("switches by name and alias, and refuses an unknown one", async () => {
    await command("mode").handler("consult", ctx);
    await command("mode").handler("Plan", ctx);
    await command("mode").handler("acción", ctx);
    expect(switched).toEqual(["consult", "plan", "action"]);
    await command("mode").handler("write", ctx);
    expect(ctx.notes.at(-1)).toEqual([
      "usage: /mode action | consult | plan | delegation",
      "warning",
    ]);
  });

  it("without a name, offers the four modes with what each does", async () => {
    answer = (options) => options.find((option) => option.includes("DELEGATION"));
    await command("mode").handler("", ctx);
    expect(selects[0]?.options).toHaveLength(4);
    expect(selects[0]?.options[0]).toMatch(/^● ACTION · /);
    expect(switched).toEqual(["delegation"]);
  });

  it("runs in CONSULT too: it is how the user leaves it", async () => {
    mode = "consult";
    await command("mode").handler("action", ctx);
    expect(switched).toEqual(["action"]);
  });
});

describe("CONSULT refuses the commands that change state", () => {
  it("before the CLI runs", async () => {
    mode = "consult";
    for (const [name, args] of [
      ["init", ""],
      ["goal", "change the button"],
      ["approve", "abc"],
      ["deny", "abc"],
    ] as const) {
      await command(name).handler(args, ctx);
      expect(ctx.notes.at(-1)?.[0], name).toMatch(
        new RegExp(`CONSULT mode is read-only: /${name}`),
      );
    }
    expect(cli.calls()).toEqual([]);
  });

  it("keeps the read-only commands", async () => {
    mode = "consult";
    cli.answer("status", { stdout: "project fake-proj: 0 tasks" });
    await command("tasks").handler("", ctx);
    expect(cli.calls().map((call) => call.args[0])).toContain("status");
    expect(ctx.notes.some(([message]) => message.includes("read-only"))).toBe(false);
  });
});

describe("PLAN mode and /goal", () => {
  it("sends the plan written in this session when /goal gets no text", async () => {
    mode = "plan";
    plan = "Plan:\n1. Read the runtime\n2. Change the claim order";
    cli.answer("task add", { stdout: "task t1 queued" });
    await command("goal").handler("", ctx);
    const call = cli.calls().find((item) => item.args[0] === "task" && item.args[1] === "add");
    expect(call?.args[2]).toBe(plan);
    expect(call?.args).toEqual(expect.arrayContaining(["--kind", "plan", "--agent", "planner"]));
  });

  it("asks for text when no plan was written yet", async () => {
    mode = "plan";
    await command("goal").handler("", ctx);
    expect(ctx.notes.at(-1)?.[0]).toMatch(/no plan written in this session yet/);
  });
});

describe("CONSULT and the console actions", () => {
  function actionHost() {
    return { ...host(), mode: () => mode } as unknown as Parameters<typeof runDashboardAction>[3];
  }

  it("refuses the actions that change state, and turns no tool back on", async () => {
    mode = "consult";
    for (const action of [
      "toggle-tools",
      "goal",
      "register-project",
      "run-queue",
      "start-runtime",
      "approvals",
    ] as const) {
      await runDashboardAction(action, ctx, fake.pi, actionHost());
      expect(ctx.notes.at(-1)?.[0], action).toMatch(/CONSULT mode is read-only/);
    }
    expect(fake.setActiveCalls).toEqual([]);
    expect(cli.calls()).toEqual([]);
  });

  it("hides them from the /haril menu", async () => {
    mode = "consult";
    const menuHost = {
      ...actionHost(),
      locale: "en",
      orchestrationDemo: () => false,
      runtimeAvailable: () => true,
      runtime: () => "idle",
    } as unknown as Parameters<typeof openDashboardActionMenu>[2];
    await openDashboardActionMenu(ctx, fake.pi, menuHost);
    const options = selects[0]?.options ?? [];
    expect(options).toContain("Inspect tasks");
    for (const hidden of [
      "Toggle Pi tools",
      "Queue a goal",
      "Review approvals",
      "Run project queue",
      "Start runtime",
    ]) {
      expect(options, hidden).not.toContain(hidden);
    }
  });
});
