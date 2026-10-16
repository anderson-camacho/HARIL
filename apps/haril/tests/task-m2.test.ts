import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { harness, makeSandbox, parseJson, projectRoot, type Sandbox } from "./helpers.js";

// M2-T6: `task add` takes a model and a token ceiling, and `task show` reports one task (M2-D5, M2-D6).
let sb: Sandbox;

beforeEach(() => {
  sb = makeSandbox();
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(() => {
  sb.cleanup();
});

function hostWith(env: Record<string, string | undefined>) {
  return { ...sb.host, env: { ...sb.host.env, ...env } };
}

// `task add` only queues; `start` applies the queue. Without a gateway key an analyst task is skipped and stays
// ready, so the task exists for `task show` and nothing reaches a real agent.
async function applyQueue(): Promise<void> {
  await run(["start", "--project", "demo"], harness().io, sb.host);
}

async function lastTaskId(): Promise<string> {
  await applyQueue();
  const status = harness();
  run(["status", "--json"], status.io, sb.host);
  const report = parseJson<{ taskList: { taskId: string }[] }>(status.out);
  const task = report.taskList.at(-1);
  if (task === undefined) throw new Error("no task");
  return task.taskId;
}

describe("haril task add with a real agent", () => {
  it("refuses an analyst task without a model (exit 2) and names the two ways to set one", () => {
    const h = harness();
    const code = run(
      ["task", "add", "Summarize", "--agent", "analyst"],
      h.io,
      hostWith({ HARIL_DEFAULT_MODEL: undefined }),
    );
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("--model");
    expect(h.err.join("\n")).toContain("HARIL_DEFAULT_MODEL");
  });

  it("takes the model from HARIL_DEFAULT_MODEL when --model is absent", async () => {
    const add = harness();
    expect(
      run(
        ["task", "add", "Summarize", "--agent", "analyst"],
        add.io,
        hostWith({ HARIL_DEFAULT_MODEL: "env-model" }),
      ),
    ).toBe(0);
    const show = harness();
    expect(run(["task", "show", await lastTaskId(), "--json"], show.io, sb.host)).toBe(0);
    const task = parseJson<{ agent: string; model: string; maxTokens: number }>(show.out);
    expect(task.agent).toBe("analyst");
    expect(task.model).toBe("env-model");
    expect(task.maxTokens).toBe(20000);
  });

  it("stores --model and --max-tokens on the task", async () => {
    const add = harness();
    expect(
      run(
        ["task", "add", "Summarize", "--agent", "analyst", "--model", "m1", "--max-tokens", "5000"],
        add.io,
        sb.host,
      ),
    ).toBe(0);
    const show = harness();
    run(["task", "show", await lastTaskId(), "--json"], show.io, sb.host);
    const task = parseJson<{ model: string; maxTokens: number; state: string }>(show.out);
    expect(task.model).toBe("m1");
    expect(task.maxTokens).toBe(5000);
    expect(task.state).toBe("ready");
  });

  it("rejects a --max-tokens that is not a whole number of at least 1", () => {
    const h = harness();
    expect(
      run(
        ["task", "add", "Summarize", "--agent", "analyst", "--model", "m1", "--max-tokens", "0"],
        h.io,
        sb.host,
      ),
    ).toBe(2);
    expect(h.err.join("\n")).toContain("--max-tokens");
  });
});

describe("haril task show", () => {
  it("prints the task in text form and exits 2 for an unknown id", async () => {
    run(["task", "add", "Plain"], harness().io, sb.host);
    const show = harness();
    expect(run(["task", "show", await lastTaskId()], show.io, sb.host)).toBe(0);
    expect(show.out.join("\n")).toContain("Plain");
    expect(show.out.join("\n")).toContain("state completed");
    expect(show.out.join("\n")).toMatch(/^result: (?!none$).+/m);

    const missing = harness();
    expect(run(["task", "show", "does-not-exist"], missing.io, sb.host)).toBe(2);
    expect(missing.err.join("\n")).toContain("no task");
  });
});

describe("haril metrics with no ledger", () => {
  it("still reports tokens as null and the per agent and model breakdown as empty", () => {
    const m = harness();
    expect(run(["metrics", "--json"], m.io, sb.host)).toBe(0);
    const view = parseJson<{ tokens: unknown; tokensByAgentModel: unknown[] }>(m.out);
    expect(view.tokens).toBeNull();
    expect(view.tokensByAgentModel).toEqual([]);
  });
});
