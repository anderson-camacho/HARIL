import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandHost, registerCommands } from "../src/commands.js";
import { listPlans, PLANS_DIR, planTitle, readPlan, savePlan } from "../src/plans.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// Saved plans (plans.ts): Markdown files under docs/planes, written with the research rules, listed newest first for
// DELEGATION, and read back only when they are one of the listed files. /save-plan keeps the model's last reply, or
// the whole conversation with --chat, without a model or the CLI.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-plans-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the plan store", () => {
  it("titles a plan from its first heading or line, without Markdown marks or path parts", () => {
    expect(planTitle("\n# Fix the **login**\n1. Read")).toBe("Fix the login");
    expect(planTitle("1. Read the form\n2. Fix it")).toBe("Read the form");
    expect(planTitle("C:/temp/../x")).toBe("temp . x");
    expect(planTitle("   ")).toBe("plan");
    expect(planTitle("x".repeat(80))).toHaveLength(60);
  });

  it("saves under docs/planes, never over a file, and lists the plans newest first", () => {
    const day = new Date(2026, 9, 27, 9);
    const first = savePlan(root, { title: "Fix the login", content: "# Fix the login\n1. A" }, day);
    const second = savePlan(root, { title: "Fix the login", content: "# Login again\n1. B" }, day);
    expect(first.relative).toBe(join(PLANS_DIR, "2026-10-27-fix-the-login.md"));
    expect(second.relative).toBe(join(PLANS_DIR, "2026-10-27-fix-the-login-2.md"));
    utimesSync(first.path, day, new Date(2026, 9, 27, 8));
    writeFileSync(join(root, PLANS_DIR, "notes.txt"), "not a plan");
    expect(listPlans(root).map((plan) => [plan.relative, plan.title])).toEqual([
      [second.relative, "Login again"],
      [first.relative, "Fix the login"],
    ]);
    expect(readPlan(root, first.relative)).toBe("# Fix the login\n1. A");
  });

  it("refuses a path as a title, and reads back only a listed plan file", () => {
    expect(() => savePlan(root, { title: "../x", content: "plan" })).toThrow(/refused/);
    expect(listPlans(root)).toEqual([]);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "secret.md"), "nope");
    expect(readPlan(root, join(PLANS_DIR, "..", "secret.md"))).toBeUndefined();
    expect(readPlan(root, join("docs", "secret.md"))).toBeUndefined();
  });
});

describe("/save-plan", () => {
  let fake: FakePi;
  let ctx: FakeContext;
  let kept: string | undefined;

  function host(): CommandHost {
    return {
      cwd: root,
      project: undefined,
      pending: [],
      area: undefined,
      started: undefined,
      showOutput: () => undefined,
      clearOutput: () => undefined,
      refresh: async () => undefined,
      reload: async () => undefined,
      mode: () => "plan",
      lastPlan: () => kept,
      savePlan(title: unknown, content: unknown) {
        const saved = savePlan(root, { title, content });
        kept = String(content);
        return saved;
      },
    } as unknown as CommandHost;
  }

  beforeEach(() => {
    fake = fakePi();
    ctx = fakeContext(root);
    kept = undefined;
    registerCommands(fake.pi, () => host());
  });

  const conversation = [
    { type: "message", message: { role: "user", content: "Plan the login fix" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "# Login fix\n1. Read\n2. Fix" }],
      },
    },
  ];

  it("keeps the model's last reply as a plan, titled from it", async () => {
    ctx.branch = conversation;
    await fake.commands.get("save-plan")?.handler("", ctx);
    const [plan] = listPlans(root);
    expect(plan?.title).toBe("Login fix");
    expect(readFileSync(join(root, plan?.relative ?? ""), "utf8")).toBe(
      "# Login fix\n1. Read\n2. Fix",
    );
    expect(kept).toBe("# Login fix\n1. Read\n2. Fix");
    expect(ctx.notes.at(-1)?.[0]).toMatch(/^plan saved: .*mode delegation offers it/);
  });

  it("keeps the whole conversation with --chat, under the title given (also as /guardar-plan)", async () => {
    ctx.branch = conversation;
    await fake.commands.get("guardar-plan")?.handler("Contexto del login --chat", ctx);
    const [plan] = listPlans(root);
    expect(plan?.relative).toMatch(/contexto-del-login\.md$/);
    const text = readFileSync(join(root, plan?.relative ?? ""), "utf8");
    expect(text).toBe(
      "# Plan the login fix\n\n### User\n\nPlan the login fix\n\n### Assistant\n\n# Login fix\n1. Read\n2. Fix",
    );
  });

  it("says how to get a plan when there is nothing to save", async () => {
    ctx.branch = [];
    await fake.commands.get("save-plan")?.handler("", ctx);
    expect(listPlans(root)).toEqual([]);
    expect(ctx.notes.at(-1)).toEqual([
      "nothing to save yet: ask for the plan first (PLAN mode writes one), or /save-plan --chat keeps the conversation",
      "warning",
    ]);
  });
});
