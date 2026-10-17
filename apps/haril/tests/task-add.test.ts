import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// `haril task add` (M1-T4): validates input and queues a task.create command (applied later by `start`).
let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  h = harness();
});

afterEach(() => {
  sb.cleanup();
});

function initProject(name: string, slug: string): void {
  const init = harness();
  const code = run(
    ["project", "init", projectRoot(sb, name), "--name", slug, "--slug", slug, "--yes"],
    init.io,
    sb.host,
  );
  if (code !== 0) throw new Error(init.err.join("\n"));
}

// Reads the queued commands through `status --json`, the read path of the CLI.
function queuedCommands(project?: string) {
  const status = harness();
  const args = project === undefined ? [] : ["--project", project];
  run(["status", "--json", ...args], status.io, sb.host);
  return parseJson<{
    queuedCommands: {
      commandId: string;
      type: string;
      projectId: string;
      args: Record<string, unknown>;
    }[];
  }>(status.out).queuedCommands;
}

describe("haril task add", () => {
  it("exits 2 when no project exists yet", () => {
    expect(run(["task", "add", "Write README"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("project init");
  });

  it("queues a task.create command with the default agent and prints the command id", () => {
    initProject("demo", "demo");
    expect(run(["task", "add", "Write README"], h.io, sb.host)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("queued");
    expect(text).toContain("applied by `haril start`");

    const [command] = queuedCommands();
    expect(command).toMatchObject({
      type: "task.create",
      args: {
        goal: "Write README",
        dependsOn: [],
        agent: "fake:succeed",
        maxAttempts: 1,
        timeoutMs: 120000,
      },
    });
    expect(text).toContain(command?.commandId ?? "missing");
  });

  it("passes dependencies, agent, attempts and timeout into the queued command", () => {
    initProject("demo", "demo");
    const code = run(
      [
        "task",
        "add",
        "Draft section",
        "--depends-on",
        "T1",
        "--depends-on",
        "T2",
        "--agent",
        "fake:fail",
        "--max-attempts",
        "3",
        "--timeout-ms",
        "5000",
      ],
      h.io,
      sb.host,
    );
    expect(code).toBe(0);
    const [command] = queuedCommands();
    expect(command?.args).toMatchObject({
      dependsOn: ["T1", "T2"],
      agent: "fake:fail",
      maxAttempts: 3,
      timeoutMs: 5000,
    });
  });

  it("is idempotent by idempotency key: the same request is a duplicate, not a second command", () => {
    initProject("demo", "demo");
    const args = ["task", "add", "Write README", "--idempotency-key", "k-1", "--json"];
    expect(run(args, h.io, sb.host)).toBe(0);
    const first = parseJson<{ commandId: string; duplicate: boolean }>(h.out);
    const again = harness();
    expect(run(args, again.io, sb.host)).toBe(0);
    const second = parseJson<{ commandId: string; duplicate: boolean }>(again.out);

    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({ commandId: first.commandId, duplicate: true });
    expect(queuedCommands()).toHaveLength(1);
  });

  it("refuses a reused idempotency key for a different request (exit 2)", () => {
    initProject("demo", "demo");
    run(["task", "add", "Write README", "--idempotency-key", "k-2"], h.io, sb.host);
    expect(run(["task", "add", "Other", "--idempotency-key", "k-2"], h.io, sb.host)).toBe(2);
    expect(queuedCommands()).toHaveLength(1);
  });

  it.each([
    [["task", "add", "   "], "title"],
    [["task", "add", "Ok", "--max-attempts", "0"], "--max-attempts"],
    [["task", "add", "Ok", "--timeout-ms", "soon"], "--timeout-ms"],
    [["task", "add"], "usage"],
  ])("rejects invalid input %j with exit 2", (args, message) => {
    initProject("demo", "demo");
    expect(run(args, h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain(message);
    expect(queuedCommands()).toHaveLength(0);
  });

  it("needs --project when more than one project exists", () => {
    initProject("alpha", "alpha");
    initProject("beta", "beta");
    expect(run(["task", "add", "Write README"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("--project");
  });

  it("queues to the named project only, so the other project sees nothing", () => {
    initProject("alpha", "alpha");
    initProject("beta", "beta");
    expect(run(["task", "add", "Only alpha", "--project", "alpha"], h.io, sb.host)).toBe(0);

    const alpha = queuedCommands("alpha");
    const beta = queuedCommands("beta");
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(0);
    expect(alpha[0]?.projectId).not.toBe(beta[0]?.projectId);
  });

  it("exits 2 for an unknown project slug", () => {
    initProject("alpha", "alpha");
    expect(run(["task", "add", "Ghost", "--project", "ghost"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("ghost");
  });
});

// LD-T4: `--kind plan` asks a planner agent for a plan. A plan task writes nothing; its plan waits for an approval.
describe("haril task add --kind", () => {
  it("queues a plan task for fake:plan with kind plan, and a work task by default", () => {
    initProject("demo", "demo");
    expect(
      run(
        ["task", "add", "Plan the docs", "--kind", "plan", "--agent", "fake:plan"],
        h.io,
        sb.host,
      ),
    ).toBe(0);
    expect(run(["task", "add", "Write README"], harness().io, sb.host)).toBe(0);
    const [plan, work] = queuedCommands();
    expect(plan?.args).toMatchObject({ goal: "Plan the docs", kind: "plan", agent: "fake:plan" });
    expect(work?.args).toMatchObject({ goal: "Write README", kind: "work" });
  });

  it.each([
    [
      ["--kind", "plan"],
      'a plan task needs a planner agent (planner or fake:plan); got "fake:succeed"',
    ],
    [["--kind", "plan", "--agent", "fake:fail"], "a plan task needs a planner agent"],
    [["--agent", "fake:plan"], 'agent "fake:plan" runs only plan tasks'],
    [
      ["--kind", "work", "--agent", "planner", "--model", "m1"],
      'agent "planner" runs only plan tasks',
    ],
    [["--kind", "verify"], 'task kind must be "work" or "plan"'],
    [["--kind", " "], "--kind needs work or plan"],
  ])("rejects %j with exit 2 and the reason", (flags, message) => {
    initProject("demo", "demo");
    expect(run(["task", "add", "Plan the docs", ...flags], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain(message);
    expect(queuedCommands()).toHaveLength(0);
  });

  it("asks the real planner for a model, as it does for the analyst", () => {
    initProject("demo", "demo");
    const args = ["task", "add", "Plan the docs", "--kind", "plan", "--agent", "planner"];
    expect(run(args, h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("agent planner needs a model");
    expect(run([...args, "--model", "m1"], harness().io, sb.host)).toBe(0);
    expect(queuedCommands()[0]?.args).toMatchObject({
      kind: "plan",
      agent: "planner",
      model: "m1",
    });
  });

  it("lists --kind in the usage and in the help", () => {
    initProject("demo", "demo");
    expect(run(["task", "add"], h.io, sb.host)).toBe(2);
    expect(h.err.join("\n")).toContain("[--kind work|plan]");
    const help = harness();
    expect(run(["help"], help.io, sb.host)).toBe(0);
    expect(help.out.join("\n")).toContain("--kind work|plan");
  });
});

// MC-T2 fix: the real demo found `task add --help` refused as an unknown option, and the main help without the
// acceptance and attempt flags.
describe("haril task add --help", () => {
  it("prints the usage of task add with every flag and exits 0, for --help and -h", () => {
    initProject("demo", "demo");
    for (const flag of ["--help", "-h"]) {
      const shown = harness();
      expect(run(["task", "add", flag], shown.io, sb.host)).toBe(0);
      const text = shown.out.join("\n");
      expect(text).toContain('usage: haril task add "<title>"');
      for (const option of [
        "--accept-file",
        "--accept-contains",
        "--accept-output",
        "--max-attempts",
        "--timeout-ms",
      ]) {
        expect(text).toContain(option);
      }
      expect(shown.err).toEqual([]);
    }
    expect(queuedCommands()).toEqual([]);
  });

  it("is listed with the acceptance and attempt flags in the main help", () => {
    const shown = harness();
    expect(run(["help"], shown.io, sb.host)).toBe(0);
    const text = shown.out.join("\n");
    for (const option of [
      "--accept-file <path>",
      "--accept-contains <path>=<text>",
      "--accept-output <text>",
      "--max-attempts <n>",
      "--timeout-ms <n>",
      "haril task add --help",
    ]) {
      expect(text).toContain(option);
    }
  });
});
