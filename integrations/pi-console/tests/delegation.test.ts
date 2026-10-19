import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandHost, registerCommands } from "../src/commands.js";
import harilConsole from "../src/console.js";
import type { ConsoleTheme } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// DELEGATION (7.5, 3.13): /delegate opens the card; Enter starts `haril workflow start` with real agents, the model
// and the stops; Esc starts nothing; M picks another model and comes back to the card. /continue lifts a stop. In
// DELEGATION mode a typed message opens the card instead of reaching the model, and while a workflow runs or waits it
// is refused with a hint (P5).

const THEME: ConsoleTheme = { fg: (_color, text) => text, bold: (text) => text };

let cli: FakeCli;
let fake: FakePi;
let ctx: FakeContext;
let keys: string[][];
let shown: string[];
let opened: string[];
let selects: { title: string; options: string[] }[];
let pick: (options: string[]) => string | undefined;
let currentPlan: string | undefined;
let pending: CommandHost["pending"];
let switched: string[];

// Each ctx.ui.custom call draws the card once and then feeds it the next batch of keys.
function scriptOverlay(): void {
  const ui = ctx.ui as unknown as Record<string, unknown>;
  ui.custom = (
    factory: (
      tui: unknown,
      theme: ConsoleTheme,
      kb: unknown,
      done: (value: unknown) => void,
    ) => {
      render(width: number): string[];
      handleInput?(data: string): void;
    },
  ) =>
    new Promise((resolve) => {
      const component = factory(
        { terminal: { columns: 100, rows: 40 }, requestRender: () => undefined },
        THEME,
        {},
        resolve,
      );
      shown.push(component.render(100).map(stripAnsi).join("\n"));
      for (const key of keys.shift() ?? ["\u001b"]) component.handleInput?.(key);
    });
  ui.select = async (title: string, options: string[]) => {
    selects.push({ title, options });
    return (
      pick(options) ??
      (title.includes("exact plan source")
        ? options[2]
        : title.includes("methodology")
          ? options[3]
          : undefined)
    );
  };
  ui.input = async () => "Use the supplied methodology instructions exactly.";
}

function host(): CommandHost {
  return {
    cwd: tmpdir(),
    project: { slug: "fake-proj", name: "Fake", rootPath: tmpdir() },
    pending,
    area: undefined,
    started: undefined,
    harilModelRef: () => "fake-gw/fake-model",
    harilModels: () => ["fake-gw/fake-high-model", "fake-gw/fake-model"],
    showOutput: () => undefined,
    clearOutput: () => undefined,
    openArea: (area: string) => {
      opened.push(area);
    },
    rebind: async () => undefined,
    refresh: async () => undefined,
    reload: async () => undefined,
    openActions: async () => undefined,
    toggleOrchestrationDemo: () => false,
    openOrchestrationView: async () => undefined,
    mode: () => "delegation",
    switchMode: (mode: string) => {
      switched.push(mode);
    },
    lastPlan: () => currentPlan,
  } as unknown as CommandHost;
}

function startCalls(): string[][] {
  return cli
    .calls()
    .filter(
      (call) =>
        call.args[0] === "workflow" &&
        call.args[1] === "start" &&
        !call.args.includes("--preflight"),
    )
    .map((call) => call.args);
}

beforeEach(() => {
  cli = installFakeCli();
  cli.answer("workflow start --preflight", {
    stdout: JSON.stringify({
      mode: "implementation",
      status: "ready",
      capabilities: {
        writing: true,
        worktreeList: true,
        worktreeCreated: false,
        testCommand: "npm test",
        testsRun: false,
        baseBranch: "main",
        baseSha: "abc123",
      },
    }),
  });
  cli.answer("workflow start", {
    stdout:
      '{"commandId":"cmd-7","type":"workflow.start","status":"queued","mode":"implementation","capabilities":{"writing":true,"worktreeList":true,"worktreeCreated":false,"testCommand":"npm test","testsRun":false,"baseBranch":"main","baseSha":"abc123"}}',
  });
  cli.answer("status", { stdout: "{}" });
  cli.answer("workflow list", { stdout: "[]" });
  fake = fakePi();
  ctx = fakeContext(tmpdir());
  keys = [];
  shown = [];
  opened = [];
  selects = [];
  pick = () => undefined;
  currentPlan = "1. Change the requested behavior.\n2. Verify it with tests.";
  pending = [];
  switched = [];
  scriptOverlay();
});

afterEach(() => {
  cli.restore();
});

describe("/delegate", () => {
  beforeEach(() => {
    registerCommands(fake.pi, () => host());
  });

  it("shows the card and starts the workflow the human confirms, with real agents", async () => {
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("Change the button color; stop at the end", ctx);
    expect(shown[0]).toContain("DELEGATE");
    expect(shown[0]).toContain("Implementation");
    expect(shown[0]).toContain("npm test");
    expect(cli.calls().some((call) => call.args.includes("--preflight"))).toBe(true);
    expect(shown[0]).toContain("fake-gw/fake-model");
    expect(shown[0]).toMatch(/\[x\] at_end/);
    expect(startCalls()).toEqual([
      [
        "workflow",
        "start",
        "--goal",
        "Change the button color; stop at the end",
        "--model",
        "fake-gw/fake-model",
        "--agent",
        "orchestrator",
        "--stop-at",
        "at_end",
        "--project",
        "fake-proj",
        "--intake-stdin",
        "--json",
      ],
    ]);
    expect(
      ctx.notes.some(([message]) =>
        /workflow queued \(command cmd-7\) with real agents/.test(message),
      ),
    ).toBe(true);
    expect(opened).toEqual(["orchestration"]);
  });

  it("starts nothing when the card is cancelled", async () => {
    keys = [["\u001b"]];
    await fake.commands.get("delegate")?.handler("Refactor the parser", ctx);
    expect(startCalls()).toEqual([]);
    expect(ctx.notes.at(-1)).toEqual(["Delegation cancelled: no workflow was started", "info"]);
  });

  it("offers plan creation instead of starting a workflow for a vague goal", async () => {
    pick = (options) => options.find((option) => option.startsWith("Create a plan"));
    await fake.commands.get("delegate")?.handler("Improve it", ctx);
    expect(startCalls()).toEqual([]);
    expect(switched).toEqual(["plan"]);
    expect(ctx.notes.some(([message]) => message.includes("Write an explicit plan"))).toBe(true);
  });

  it("preserves explicit read-only consultation without queueing", async () => {
    pick = (options) => options.find((option) => option.startsWith("Continue read-only"));
    await fake.commands.get("delegate")?.handler("Investigate", ctx);
    expect(switched).toEqual(["consult"]);
    expect(startCalls()).toEqual([]);
  });

  it("selects an exact prior workflow plan rather than using the goal as a plan", async () => {
    const text = "1. Inspect the parser.\n2. Add regression tests.\n";
    const sha256 = createHash("sha256").update(text).digest("hex");
    cli.answer("workflow list", {
      stdout: JSON.stringify([
        {
          workflowId: "wf-old",
          projectId: "project-1",
          state: "completed",
          stopReason: null,
          goal: "Old goal",
          intake: { plan: { sourceId: "file:original", revision: "v3", sha256 } },
        },
      ]),
    });
    cli.answer("workflow show", {
      stdout: JSON.stringify({
        workflowId: "wf-old",
        projectId: "project-1",
        intake: {
          plan: { sourceId: "file:original", revision: "v3", sha256, text },
        },
      }),
    });
    pick = (options) =>
      options.find(
        (option) => option.startsWith("Select an existing") || option === "Workflow wf-old",
      );
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("Improve it", ctx);
    expect(startCalls()).toHaveLength(1);
    expect(startCalls()[0]).not.toContain(text);
    expect(cli.calls().some((call) => call.args.includes("--intake-json"))).toBe(true);
  });

  it("selects a stored approval plan with tasks", async () => {
    cli.answer("approvals --all", {
      stdout: JSON.stringify([
        { approvalId: "approval-1", projectSlug: "fake-proj", tasks: 2, status: "granted" },
      ]),
    });
    cli.answer("approvals show", {
      stdout: JSON.stringify({
        approvalId: "approval-1",
        projectSlug: "fake-proj",
        plan: { tasks: [{ goal: "Write tests" }] },
      }),
    });
    pick = (options) =>
      options.find(
        (option) => option.startsWith("Select an existing") || option === "Approval approval-1",
      );
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("Improve it", ctx);
    expect(startCalls()).toHaveLength(1);
    expect(cli.calls().some((call) => call.args.includes("approval-1"))).toBe(true);
  });

  it("picks another model with M and comes back to the card", async () => {
    keys = [["m"], ["\u001b[B", " ", "\r"]];
    pick = (options) => options.find((option) => option === "fake-gw/fake-high-model");
    await fake.commands.get("delegate")?.handler("Write the tests, don't stop", ctx);
    expect(selects.some((entry) => /high model/.test(entry.title))).toBe(true);
    const [args] = startCalls();
    expect(args?.[args.indexOf("--model") + 1]).toBe("fake-gw/fake-high-model");
    expect(args?.[args.indexOf("--stop-at") + 1]).toBe("at_end");
  });

  it("without a goal, takes the last message of the conversation", async () => {
    ctx.branch = [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Audit the CLI help" }] },
      },
      { type: "message", message: { role: "assistant", content: "ok" } },
    ];
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("", ctx);
    expect(startCalls()[0]?.[3]).toBe("Audit the CLI help");
  });

  it("says why the workflow did not start when the CLI refuses", async () => {
    cli.answer("workflow start", { stderr: 'haril: no project with slug "fake-proj"\n', code: 2 });
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("Goal", ctx);
    expect(ctx.notes.at(-1)).toEqual(['haril: no project with slug "fake-proj"', "error"]);
    expect(opened).toEqual([]);
  });

  it("does not show confirmation or queue when implementation preflight fails", async () => {
    cli.answer("workflow start --preflight", {
      stderr: "haril: implementation requires Git worktrees\n",
      code: 2,
    });
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("Goal", ctx);
    expect(startCalls()).toEqual([]);
    expect(shown).toEqual([]);
    expect(ctx.notes.at(-1)).toEqual(["haril: implementation requires Git worktrees", "error"]);
  });

  it("does not announce implementation when the queued response lacks its mode", async () => {
    cli.answer("workflow start", { stdout: '{"commandId":"cmd-7","status":"queued"}' });
    keys = [["\r"]];
    await fake.commands.get("delegate")?.handler("Goal", ctx);
    expect(startCalls()).toHaveLength(1);
    expect(ctx.notes.at(-1)?.[0]).toMatch(/response.*verified/i);
    expect(opened).toEqual([]);
  });
});

describe("/continue", () => {
  beforeEach(() => {
    registerCommands(fake.pi, () => host());
  });

  it("lifts the stop of the only waiting workflow, removing the stops named", async () => {
    cli.answer("workflow list", {
      stdout: JSON.stringify([
        { workflowId: "wf_done", state: "completed", stopReason: null, goal: "old" },
        {
          workflowId: "wf_wait",
          state: "awaiting_human",
          stopReason: "after_plan",
          goal: "Change it",
        },
      ]),
    });
    await fake.commands.get("continue")?.handler("at_end", ctx);
    const call = cli.calls().find((item) => item.args[1] === "continue");
    expect(call?.args).toEqual([
      "workflow",
      "continue",
      "wf_wait",
      "--remove-stop",
      "at_end",
      "--project",
      "fake-proj",
    ]);
    expect(
      ctx.notes.some(([message]) =>
        message.startsWith("workflow wf_wait continues · removed: at_end"),
      ),
    ).toBe(true);
  });

  it("asks which one when several wait, and says when none does", async () => {
    cli.answer("workflow list", {
      stdout: JSON.stringify([
        { workflowId: "wf_a", state: "awaiting_human", stopReason: "after_plan", goal: "A" },
        { workflowId: "wf_b", state: "awaiting_human", stopReason: "at_end", goal: "B" },
      ]),
    });
    pick = (options) => options[1];
    await fake.commands.get("continue")?.handler("", ctx);
    expect(selects[0]?.options).toHaveLength(2);
    expect(cli.calls().find((item) => item.args[1] === "continue")?.args[2]).toBe("wf_b");
    cli.answer("workflow list", { stdout: "[]" });
    await fake.commands.get("continue")?.handler("", ctx);
    expect(ctx.notes.at(-1)).toEqual(["No workflow waits for you", "info"]);
  });
});

describe("typing in DELEGATION mode", () => {
  beforeEach(async () => {
    harilConsole(fake.pi);
    await fake.fire("session_start", { reason: "startup" }, ctx);
    await fake.commands.get("mode")?.handler("delegation", ctx);
  });

  async function settle(done: () => boolean): Promise<void> {
    for (let index = 0; index < 100 && !done(); index++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("asks for an exact plan instead of starting on a vague message", async () => {
    const [result] = await fake.fire(
      "input",
      { text: "Translate the README", source: "interactive" },
      ctx,
    );
    expect(result).toEqual({ action: "handled" });
    await settle(() => ctx.notes.some(([message]) => message.includes("registered project")));
    expect(shown).toEqual([]);
    expect(startCalls()).toEqual([]);
    expect(ctx.notes.some(([message]) => message.includes("registered project"))).toBe(true);
  });

  it("refuses the text with a hint while a workflow runs or waits (P5)", async () => {
    cli.answer("workflow list", {
      stdout: JSON.stringify([
        { workflowId: "wf_run", state: "running", stopReason: null, goal: "Busy" },
      ]),
    });
    const [result] = await fake.fire("input", { text: "also do this", source: "interactive" }, ctx);
    expect(result).toEqual({ action: "handled" });
    await settle(() => ctx.notes.some(([message]) => message.includes("wf_run")));
    expect(ctx.notes.find(([message]) => message.includes("wf_run"))?.[0]).toMatch(
      /is running: typed text is not sent/,
    );
    expect(shown).toEqual([]);
  });

  it("leaves the text alone in the other modes", async () => {
    await fake.commands.get("mode")?.handler("action", ctx);
    const [result] = await fake.fire("input", { text: "hello", source: "interactive" }, ctx);
    expect(result).toBeUndefined();
  });
});
