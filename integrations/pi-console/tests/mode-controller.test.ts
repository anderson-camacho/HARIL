import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installModes, type ModeController } from "../src/mode-controller.js";
import { PLANS_DIR } from "../src/plans.js";
import { RESEARCH_DIR } from "../src/research.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// The modes wired into Pi (7.3, defense in depth), with a fake ConsolePi: CONSULT narrows the active tools, its
// tool_call guard blocks every write, shell and foreign tool even when one is turned back on, the user's `!` commands
// are refused, the model is told the mode, leaving restores the tools, haril_save_research is the one write, and the
// trace lands in the chat after the run.

let fake: FakePi;
let ctx: FakeContext;
let modes: ModeController;
let root: string;
let now: number;
let redraws: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-modes-"));
  fake = fakePi({ extraTools: ["mcp__docs__search", "other_ext_tool"] });
  ctx = fakeContext(root);
  now = 1_000;
  redraws = 0;
  modes = installModes(fake.pi, {
    researchRoot: () => root,
    now: () => now,
    redraw: () => {
      redraws++;
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function toolCall(toolName: string, input: Record<string, unknown> = {}, id = toolName) {
  const [verdict] = await fake.fire("tool_call", { toolCallId: id, toolName, input }, ctx);
  return verdict as { block?: boolean; reason?: string } | undefined;
}

describe("CONSULT mode in Pi", () => {
  it("narrows the active tools and says so", () => {
    expect(modes.switchTo("consult", ctx)).toBe("consult");
    expect(fake.active).toEqual(["read", "grep", "find", "ls", "haril_save_research"]);
    expect(ctx.notes.at(-1)?.[0]).toMatch(/^MODE: CONSULT/);
    expect(redraws).toBeGreaterThan(0);
  });

  it("blocks every write, shell and foreign tool, even after one is turned back on", async () => {
    modes.switchTo("consult", ctx);
    fake.pi.setActiveTools([...fake.active, "write", "bash", "mcp__docs__search"]);
    for (const tool of [
      "write",
      "edit",
      "bash",
      "powershell",
      "mcp__docs__search",
      "other_ext_tool",
    ]) {
      const verdict = await toolCall(tool, { path: "x" });
      expect(verdict?.block, tool).toBe(true);
      expect(verdict?.reason).toMatch(/CONSULT mode is read-only/);
    }
    for (const tool of ["read", "grep", "find", "ls"])
      expect(await toolCall(tool), tool).toBeUndefined();
  });

  it("refuses the user's own shell commands", async () => {
    modes.switchTo("consult", ctx);
    const [result] = await fake.fire("user_bash", { command: "rm -rf build" }, ctx);
    expect(result).toMatchObject({ result: { exitCode: 1 } });
    expect(JSON.stringify(result)).toMatch(/read-only/);
    modes.switchTo("action", ctx);
    expect((await fake.fire("user_bash", { command: "ls" }, ctx))[0]).toBeUndefined();
  });

  it("tells the model the mode for each run, and nothing in ACTION", async () => {
    expect(
      (
        await fake.fire("before_agent_start", { systemPrompt: "BASE", messageType: "user" }, ctx)
      )[0],
    ).toBeUndefined();
    modes.switchTo("consult", ctx);
    const [result] = await fake.fire(
      "before_agent_start",
      { systemPrompt: "BASE", messageType: "user" },
      ctx,
    );
    expect((result as { systemPrompt: string }).systemPrompt).toMatch(
      /^BASE\n\n\[HARIL CONSULT mode\]/,
    );
  });

  it("gives back the tools that were active before, and keeps the mode in the session", () => {
    fake.active = ["read", "bash", "edit", "write", "mcp__docs__search"];
    modes.switchTo("consult", ctx);
    modes.switchTo("plan", ctx);
    modes.switchTo("action", ctx);
    expect(fake.active).toEqual(["read", "bash", "edit", "write", "mcp__docs__search"]);
    expect(
      fake.entries.filter((entry) => entry.customType === "haril-mode").map((entry) => entry.data),
    ).toEqual([
      { mode: "consult", toolsBefore: ["read", "bash", "edit", "write", "mcp__docs__search"] },
      { mode: "plan", toolsBefore: ["read", "bash", "edit", "write", "mcp__docs__search"] },
      { mode: "action", toolsBefore: undefined },
    ]);
  });

  it("cycles with the shortcut's handler", () => {
    expect(modes.cycle(ctx)).toBe("consult");
    expect(modes.cycle(ctx)).toBe("plan");
    expect(modes.cycle(ctx)).toBe("delegation");
    expect(fake.active).toEqual(["read", "grep", "find", "ls", "haril_save_plan"]);
    expect(modes.cycle(ctx)).toBe("action");
    expect(fake.active).toEqual(["read", "bash", "edit", "write", "haril_save_plan"]);
  });

  it("comes back in CONSULT on resume, from the session's last mode entry", () => {
    ctx.branch = [
      { type: "custom", customType: "haril-mode", data: { mode: "plan", toolsBefore: ["read"] } },
      {
        type: "custom",
        customType: "haril-mode",
        data: { mode: "consult", toolsBefore: ["read", "bash"] },
      },
    ];
    fake.active = ["read", "bash", "edit", "write"];
    modes.restore(ctx);
    expect(modes.mode()).toBe("consult");
    expect(fake.active).toEqual(["read", "grep", "find", "ls", "haril_save_research"]);
    modes.switchTo("action", ctx);
    expect(fake.active).toEqual(["read", "bash"]);
  });

  it("starts a new session without a saved mode in ACTION with the tools from before", () => {
    modes.switchTo("consult", ctx);
    ctx.branch = [];
    modes.restore(ctx);
    expect(modes.mode()).toBe("action");
    expect(fake.active).toEqual(["read", "bash", "edit", "write", "haril_save_plan"]);
  });
});

describe("haril_save_research", () => {
  it("is registered inactive, and refused outside CONSULT and PLAN", async () => {
    const tool = fake.tools.get("haril_save_research");
    expect(tool?.defaultActive).toBe(false);
    expect(fake.active).not.toContain("haril_save_research");
    await expect(
      tool?.execute("1", { title: "t", content: "x" }, undefined, undefined, ctx),
    ).rejects.toThrow(/only in CONSULT and PLAN/);
    expect(existsSync(join(root, RESEARCH_DIR))).toBe(false);
  });

  it("saves in CONSULT and the trace names the file", async () => {
    modes.switchTo("consult", ctx);
    await fake.fire("before_agent_start", { systemPrompt: "", messageType: "user" }, ctx);
    await reply([
      {
        id: "c1",
        name: "haril_save_research",
        arguments: { title: "Runtime claims", content: "# x" },
      },
    ]);
    await toolCall("haril_save_research", { title: "Runtime claims", content: "# x" }, "c1");
    const result = await fake.tools
      .get("haril_save_research")
      ?.execute("c1", { title: "Runtime claims", content: "# x" }, undefined, undefined, ctx);
    expect(result?.content[0]?.text).toMatch(
      /^saved docs[\\/]investigacion[\\/]\d{4}-\d{2}-\d{2}-runtime-claims\.md/,
    );
    expect(readdirSync(join(root, RESEARCH_DIR))).toHaveLength(1);
    await toolResult("c1", "haril_save_research", false, result?.content[0]?.text ?? "");
    await fake.fire("agent_end", { messages: [] }, ctx);
    const trace = fake.entries.find((entry) => entry.customType === "haril-trace");
    expect(JSON.stringify(trace?.data)).toMatch(/Research saved: docs.+runtime-claims\.md/);
  });
});

// A reply that asks for tool calls, as Pi reports it at message_end.
async function reply(
  calls: { id: string; name: string; arguments: Record<string, unknown> }[],
  usage: Record<string, number> = { input: 0, output: 0 },
): Promise<void> {
  await fake.fire(
    "message_end",
    {
      message: {
        role: "assistant",
        content: calls.map((call) => ({ type: "toolCall", ...call })),
        usage,
      },
    },
    ctx,
  );
}

async function toolResult(
  id: string,
  toolName: string,
  isError: boolean,
  text: string,
): Promise<void> {
  await fake.fire(
    "message_end",
    {
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName,
        isError,
        content: [{ type: "text", text }],
      },
    },
    ctx,
  );
}

describe("the CONSULT trace in the chat", () => {
  it("records each call, the blocked ones, the tokens and the time, then draws it", async () => {
    modes.switchTo("consult", ctx);
    await fake.fire("before_agent_start", { systemPrompt: "", messageType: "user" }, ctx);
    await reply(
      [
        { id: "r1", name: "read", arguments: { path: "src/console.ts" } },
        { id: "w1", name: "write", arguments: { path: "src/x.ts", content: "body" } },
      ],
      { input: 900, output: 120 },
    );
    await toolCall("read", { path: "src/console.ts" }, "r1");
    await toolResult("r1", "read", false, "a\nb");
    const verdict = await toolCall("write", { path: "src/x.ts", content: "body" }, "w1");
    await toolResult("w1", "write", true, verdict?.reason ?? "");
    now = 4_500;
    await fake.fire("agent_end", { messages: [] }, ctx);
    const entry = fake.entries.find((item) => item.customType === "haril-trace");
    const lines = (entry?.data as { lines: string[] } | undefined)?.lines ?? [];
    expect(lines[0]).toBe("◆ CONSULT trace · 2 tool calls · 1 blocked · 3.5 s");
    expect(lines.join("\n")).toContain("src/console.ts  →  ok · 2 lines");
    expect(lines.join("\n")).toContain("src/x.ts  →  blocked · CONSULT mode is read-only");
    expect(lines.join("\n")).not.toContain("body");
    expect(lines.join("\n")).toContain("Tokens: 900 in · 120 out");
    const renderer = fake.renderers.get("haril-trace");
    const drawn = renderer?.(
      { customType: "haril-trace", data: entry?.data },
      { expanded: false },
      { fg: (_color, text) => text, bold: (text) => text },
    );
    expect(drawn?.render(200)[0]).toBe(lines[0]);
  });

  it("traces as blocked a call Pi refused before any guard, because the tool is not active", async () => {
    modes.switchTo("consult", ctx);
    await fake.fire("before_agent_start", { systemPrompt: "", messageType: "user" }, ctx);
    await reply([{ id: "w2", name: "write", arguments: { path: "hacked.txt", content: "x" } }]);
    await toolResult("w2", "write", true, "Tool write not found");
    await fake.fire("agent_end", { messages: [] }, ctx);
    const entry = fake.entries.find((item) => item.customType === "haril-trace");
    const lines = (entry?.data as { lines: string[] } | undefined)?.lines ?? [];
    expect(lines.join("\n")).toContain("hacked.txt  →  blocked · CONSULT mode is read-only");
  });

  it("leaves no trace in ACTION", async () => {
    await fake.fire("before_agent_start", { systemPrompt: "", messageType: "user" }, ctx);
    await toolCall("write", { path: "x" });
    await fake.fire("agent_end", { messages: [] }, ctx);
    expect(fake.entries.some((entry) => entry.customType === "haril-trace")).toBe(false);
  });
});

describe("PLAN mode", () => {
  it("keeps the plan the model wrote, for /goal", async () => {
    modes.switchTo("plan", ctx);
    await fake.fire(
      "agent_end",
      {
        messages: [
          { role: "user", content: "plan it" },
          { role: "assistant", content: [{ type: "text", text: "Plan:\n1. Read\n2. Change" }] },
        ],
      },
      ctx,
    );
    expect(modes.lastPlan()).toBe("Plan:\n1. Read\n2. Change");
    expect(fake.entries.find((entry) => entry.customType === "haril-plan")?.data).toMatchObject({
      text: "Plan:\n1. Read\n2. Change",
    });
    expect(ctx.notes.at(-1)?.[0]).toMatch(/\/save-plan saves it for DELEGATION/);
  });
});

describe("haril_save_plan", () => {
  const plan = "# Fix the login\n\n1. Read the form\n2. Fix the check\n3. Run the tests";

  it("is active in ACTION, allowed in PLAN and DELEGATION, and refused in CONSULT", async () => {
    expect(fake.tools.get("haril_save_plan")?.defaultActive).toBe(true);
    expect(fake.active).toContain("haril_save_plan");
    for (const mode of ["plan", "delegation", "action"] as const) {
      modes.switchTo(mode, ctx);
      expect(await toolCall("haril_save_plan"), mode).toBeUndefined();
    }
    modes.switchTo("consult", ctx);
    expect((await toolCall("haril_save_plan"))?.block).toBe(true);
    await expect(
      fake.tools
        .get("haril_save_plan")
        ?.execute("1", { title: "t", content: plan }, undefined, undefined, ctx),
    ).rejects.toThrow(/does not work in CONSULT/);
    expect(existsSync(join(root, PLANS_DIR))).toBe(false);
  });

  it("saves the plan in docs/planes and keeps it as the session's plan", async () => {
    modes.switchTo("plan", ctx);
    now = new Date(2026, 9, 27, 12).getTime();
    const result = (await fake.tools
      .get("haril_save_plan")
      ?.execute("1", { title: "Fix the login", content: plan }, undefined, undefined, ctx)) as {
      details: { path: string };
    };
    expect(result.details.path).toBe(join(PLANS_DIR, "2026-10-27-fix-the-login.md"));
    expect(readdirSync(join(root, PLANS_DIR))).toEqual(["2026-10-27-fix-the-login.md"]);
    expect(modes.lastPlan()).toBe(plan);
    expect(fake.entries.find((entry) => entry.customType === "haril-plan")?.data).toMatchObject({
      text: plan,
    });
  });

  it("names the saved plans when DELEGATION starts, or how to save one", () => {
    modes.switchTo("delegation", ctx);
    expect(ctx.notes.at(-1)?.[0]).toMatch(/No saved plan yet/);
    modes.switchTo("action", ctx);
    modes.savePlan("Fix the login", plan);
    modes.switchTo("delegation", ctx);
    expect(ctx.notes.at(-1)?.[0]).toMatch(/^1 saved plan \(Fix the login\): type the goal/);
  });
});
