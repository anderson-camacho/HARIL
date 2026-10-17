import type { AgentRuntime } from "@haril/core/ports";
import { FakeAgentRuntime, FakeClock } from "@haril/core/testing";
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
  await run(["run", "--project", "demo"], harness().io, sb.host);
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

  // LD-T7c: the text an agent wrote reaches the terminal as the shell shows it: control sequences, a right-to-left
  // override and tag characters become "?", line breaks stay. JSON keeps the text as stored.
  it("shows a hostile result as ? in text, keeps its line breaks, and keeps it intact in JSON", async () => {
    const reply = "Done\x1b]52;c;ZmFrZS1jbGlw\x07 here\u{202E}txt\u{E0041}\nline two\x1b[2J";
    const title = "Hostile\x1b[2J\u{202E} title";
    run(["task", "add", title, "--agent", `fake:say:${reply}`], harness().io, sb.host);
    const id = await lastTaskId();

    const show = harness();
    expect(run(["task", "show", id], show.io, sb.host)).toBe(0);
    const status = harness();
    expect(run(["status"], status.io, sb.host)).toBe(0);
    const text = show.out.join("\n");
    expect(text).toContain(`task ${id}: Hostile?[2J? title`);
    expect(text).toContain("result: Done?]52;c;ZmFrZS1jbGlw? here?txt?\nline two?[2J");
    expect(status.out.join("\n")).toContain(`${id}  completed  Hostile?[2J? title`);
    for (const hidden of ["\x1b", "\x07", "\u{202E}", "\u{E0041}"]) {
      expect(text).not.toContain(hidden);
      expect(status.out.join("\n")).not.toContain(hidden);
    }
    const json = harness();
    run(["task", "show", id, "--json"], json.io, sb.host);
    expect(parseJson<{ result: { summary: string } }>(json.out).result.summary).toBe(reply);
  });

  // LD-T7c: a completed task said attempts 0/1 while its run said attempt 1/1.
  it("reports the attempt of a task completed on its first attempt", async () => {
    run(["task", "add", "Once"], harness().io, sb.host);
    const id = await lastTaskId();
    const text = harness();
    run(["task", "show", id], text.io, sb.host);
    expect(text.out).toContain("attempts 1/1, max tokens 20000");
    const json = harness();
    run(["task", "show", id, "--json"], json.io, sb.host);
    expect(parseJson(json.out)).toMatchObject({
      state: "completed",
      attempts: { used: 1, max: 1 },
    });
  });

  it("reports both attempts of a task that failed once and completed on its retry", async () => {
    run(["task", "add", "Flaky", "--max-attempts", "3"], harness().io, sb.host);
    const fake = new FakeAgentRuntime({ clock: new FakeClock() });
    let starts = 0;
    const flaky: AgentRuntime = {
      // The first attempt fails as fake:fail does; the retry runs the task's own agent.
      start: (spec) => fake.start(starts++ === 0 ? { ...spec, agentRef: "fake:fail" } : spec),
    };
    const runOut = harness();
    await run(["run", "--project", "demo"], runOut.io, { ...sb.host, agentRuntime: flaky });
    expect(runOut.out.join("\n")).toContain("(attempt 2/3)");

    const status = harness();
    run(["status", "--json"], status.io, sb.host);
    const id = parseJson<{ taskList: { taskId: string }[] }>(status.out).taskList.at(-1)?.taskId;
    const json = harness();
    run(["task", "show", id ?? "", "--json"], json.io, sb.host);
    expect(parseJson(json.out)).toMatchObject({
      state: "completed",
      attempts: { used: 2, max: 3 },
    });
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
