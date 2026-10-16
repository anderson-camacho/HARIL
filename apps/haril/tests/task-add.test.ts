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
