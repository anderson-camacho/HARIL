import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarilActions } from "../src/actions.js";
import { AddTaskForm, addTaskArgs } from "../src/add-task.js";

// The shell's actions (TUI-D13) and their pure parts: the CLI runner and the add-task form. The fake haril is a
// fixture script that records its argv beside itself and prints or fails as the CLI would.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-actions-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface FakeBehaviour {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code: number;
  readonly sleepMs?: number;
}

function fakeHaril(dir: string, behaviour: FakeBehaviour): string {
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "haril.mjs");
  const lines = [
    'import { writeFileSync } from "node:fs";',
    behaviour.sleepMs === undefined
      ? ""
      : `await new Promise((resolve) => setTimeout(resolve, ${behaviour.sleepMs}));`,
    'writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));',
    behaviour.stdout === undefined
      ? ""
      : `process.stdout.write(${JSON.stringify(`${behaviour.stdout}\n`)});`,
    behaviour.stderr === undefined
      ? ""
      : `process.stderr.write(${JSON.stringify(`${behaviour.stderr}\n`)});`,
    `process.exitCode = ${behaviour.code};`,
  ];
  writeFileSync(entry, lines.join("\n"), "utf8");
  return entry;
}

describe("createHarilActions (TUI-D13)", () => {
  it("runs the CLI with the argv as an array, so a title is never read by a shell", async () => {
    const dir = join(root, "fake");
    const entry = fakeHaril(dir, {
      stdout: "command c-1: queued (applied by `haril start`)",
      code: 0,
    });
    const title = "Ship $HOME & 'quotes' ; rm -rf";
    const outcome = await createHarilActions({ harilEntry: entry }).run([
      "task",
      "add",
      title,
      "--project",
      "demo",
    ]);
    expect(outcome).toEqual({
      ok: true,
      message: "command c-1: queued (applied by `haril start`)",
    });
    expect(JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"))).toEqual([
      "task",
      "add",
      title,
      "--project",
      "demo",
    ]);
  });

  it("reports the first line of stderr when the CLI refuses, with ok false", async () => {
    const entry = fakeHaril(join(root, "refuse"), {
      stderr: "haril: agent analyst needs a model\nmore detail",
      code: 2,
    });
    const outcome = await createHarilActions({ harilEntry: entry }).run(["task", "add", "x"]);
    expect(outcome).toEqual({ ok: false, message: "haril: agent analyst needs a model" });
  });

  it("gives up after the timeout and says so", async () => {
    const entry = fakeHaril(join(root, "slow"), { code: 0, sleepMs: 60_000 });
    const outcome = await createHarilActions({ harilEntry: entry, timeoutMs: 200 }).run(["task"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/timed out/);
  });

  it("refuses to run when the shell was started without its haril entry", async () => {
    const outcome = await createHarilActions({ harilEntry: undefined }).run(["task", "add", "x"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/haril shell/);
  });
});

describe("addTaskArgs (TUI-D13 argv)", () => {
  const target = { slug: "demo", dataDir: "/data/haril" };

  it("builds the CLI argv with the model for analyst and the data dir the shell was given", () => {
    expect(
      addTaskArgs({ title: "  Write docs  ", agent: "analyst", model: "qwen-test" }, target),
    ).toEqual({
      ok: true,
      args: [
        "task",
        "add",
        "Write docs",
        "--project",
        "demo",
        "--agent",
        "analyst",
        "--model",
        "qwen-test",
        "--data-dir",
        "/data/haril",
      ],
    });
  });

  it("never passes a model to the simulated agent and omits the data dir when none is known", () => {
    expect(
      addTaskArgs(
        { title: "Simulated", agent: "fake:succeed", model: "qwen-test" },
        { slug: "demo", dataDir: undefined },
      ),
    ).toEqual({
      ok: true,
      args: ["task", "add", "Simulated", "--project", "demo", "--agent", "fake:succeed"],
    });
  });

  it("refuses an empty title and an analyst task without a model, before any process runs", () => {
    expect(addTaskArgs({ title: "   ", agent: "fake:succeed", model: "" }, target)).toEqual({
      ok: false,
      message: "title is required",
    });
    const noModel = addTaskArgs({ title: "Needs model", agent: "analyst", model: " " }, target);
    expect(noModel.ok).toBe(false);
    expect(!noModel.ok && noModel.message).toMatch(/model/);
  });
});

describe("AddTaskForm", () => {
  it("starts on analyst with the default model when one is known, else on fake:succeed", () => {
    const withModel = new AddTaskForm({ projectSlug: "demo", defaultModel: "qwen-test" });
    expect(withModel.values()).toEqual({ title: "", agent: "analyst", model: "qwen-test" });
    const without = new AddTaskForm({ projectSlug: "demo", defaultModel: undefined });
    expect(without.values()).toEqual({ title: "", agent: "fake:succeed", model: "" });
  });

  it("types into the title, moves between fields and changes the agent", () => {
    const form = new AddTaskForm({ projectSlug: "demo", defaultModel: "qwen-test" });
    for (const key of "Hi") form.handleInput(key);
    expect(form.values().title).toBe("Hi");
    form.next();
    expect(form.field).toBe("agent");
    form.handleInput("\x1b[B");
    expect(form.values().agent).toBe("fake:succeed");
    form.previous();
    expect(form.field).toBe("title");
    expect(form.lines().join("\n")).toContain("Hi");
  });
});
