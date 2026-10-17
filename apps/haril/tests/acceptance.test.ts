import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

// Criterion 8 (M3-D7): the host evaluates acceptance checks after the agent settles.
let sb: Sandbox;
let h: Harness;
let root: string;

beforeEach(() => {
  sb = makeSandbox();
  h = harness();
  root = projectRoot(sb, "demo");
  writeFileSync(join(root, "notes.md"), "# Notes\nexport const ok = true;\n");
  const init = harness();
  const code = run(
    ["project", "init", root, "--name", "demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
  if (code !== 0) throw new Error(init.err.join("\n"));
});

afterEach(() => {
  sb.cleanup();
});

async function cli(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

function taskIdOf(goal: string): string {
  const status = harness();
  run(["status", "--json", "--project", "demo"], status.io, sb.host);
  const found = parseJson<{ taskList: { taskId: string; goal: string }[] }>(
    status.out,
  ).taskList.find((task) => task.goal === goal);
  if (found === undefined) throw new Error(`no task "${goal}"`);
  return found.taskId;
}

function showJson(goal: string): {
  state: string;
  error: { code: string } | null;
  verification: {
    verified: boolean;
    checks: { kind: string; ok: boolean; detail: string }[];
  } | null;
} {
  const shown = harness();
  run(["task", "show", taskIdOf(goal), "--json"], shown.io, sb.host);
  return parseJson(shown.out);
}

describe("haril task add acceptance flags", () => {
  it("queues the checks in the task.create arguments", async () => {
    expect(
      await cli([
        "task",
        "add",
        "Checked",
        "--project",
        "demo",
        "--accept-file",
        "notes.md",
        "--accept-contains",
        "notes.md=export const ok",
        "--accept-output",
        "hello",
        "--json",
      ]),
    ).toBe(0);
    const status = harness();
    run(["status", "--json", "--project", "demo"], status.io, sb.host);
    const queued = parseJson<{ queuedCommands: { args: { acceptance: unknown[] } }[] }>(
      status.out,
    ).queuedCommands;
    expect(queued[0]?.args.acceptance).toEqual([
      { kind: "file_exists", path: "notes.md" },
      { kind: "file_contains", path: "notes.md", text: "export const ok" },
      { kind: "output_contains", text: "hello" },
    ]);
  });

  it("rejects --accept-contains without <path>=<text>", async () => {
    expect(
      await cli(["task", "add", "Bad", "--project", "demo", "--accept-contains", "notes.md"]),
    ).toBe(2);
    expect(h.err.join("\n")).toContain("--accept-contains");
  });
});

describe("host verification at run time", () => {
  it("completes a task whose checks pass and shows it as verified", async () => {
    await cli([
      "task",
      "add",
      "Verified",
      "--agent",
      "fake:say:hello from the fake",
      "--project",
      "demo",
      "--accept-file",
      "notes.md",
      "--accept-contains",
      "notes.md=export const ok",
      "--accept-output",
      "hello",
    ]);
    expect(await cli(["start", "--project", "demo"])).toBe(0);
    const events = harness();
    run(["events", "--project", "demo", "--json"], events.io, sb.host);
    expect(events.out.join("\n")).toContain('"type":"verify.passed"');

    const view = showJson("Verified");
    expect(view.state).toBe("completed");
    expect(view.verification?.verified).toBe(true);
    expect(view.verification?.checks.map((check) => check.ok)).toEqual([true, true, true]);

    expect(await cli(["task", "show", taskIdOf("Verified")])).toBe(0);
    expect(h.out.join("\n")).toMatch(/^verification: verified$/m);
  });

  it("fails the attempt when a check fails, retries within max-attempts and keeps the evidence", async () => {
    await cli([
      "task",
      "add",
      "Unmet",
      "--agent",
      "fake:say:hello",
      "--project",
      "demo",
      "--accept-output",
      "goodbye",
      "--max-attempts",
      "2",
    ]);
    expect(await cli(["start", "--project", "demo"])).toBe(1);
    const view = showJson("Unmet");
    expect(view.state).toBe("failed");
    expect(view.error?.code).toBe("verification_failed");
    expect(view.verification?.verified).toBe(false);
    expect(view.verification?.checks[0]?.detail).toBe("output does not contain text");

    const metrics = harness();
    run(["metrics", "--json", "--project", "demo"], metrics.io, sb.host);
    expect(parseJson<{ retries: number }>(metrics.out).retries).toBe(1);
  });

  it("counts a task without checks as completed but unverified", async () => {
    await cli(["task", "add", "Unchecked", "--agent", "fake:succeed", "--project", "demo"]);
    expect(await cli(["start", "--project", "demo"])).toBe(0);
    const view = showJson("Unchecked");
    expect(view.state).toBe("completed");
    expect(view.verification).toEqual({ verified: false, checks: [] });

    const metrics = harness();
    run(["metrics", "--json", "--project", "demo"], metrics.io, sb.host);
    const counted = parseJson<{ verifiedCompletions: number; unverifiedCompletions: number }>(
      metrics.out,
    );
    expect(counted.unverifiedCompletions).toBe(1);
    expect(counted.verifiedCompletions).toBe(0);
  });

  it("denies a check that leaves the project root through the PathGuard", async () => {
    await cli([
      "task",
      "add",
      "Escape",
      "--agent",
      "fake:succeed",
      "--project",
      "demo",
      "--accept-file",
      "../outside.txt",
    ]);
    expect(await cli(["start", "--project", "demo"])).toBe(1);
    const view = showJson("Escape");
    expect(view.verification?.checks[0]?.detail).toBe("outside_root");
    expect(view.state).toBe("failed");
  });

  it("fails a check that reads through a junction inside the project (links are refused)", async () => {
    const outsideDir = join(sb.root, "outside-dir");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.txt"), "secret outside", "utf8");
    symlinkSync(outsideDir, join(root, "jout"), "junction");
    await cli([
      "task",
      "add",
      "Through link",
      "--agent",
      "fake:succeed",
      "--project",
      "demo",
      "--accept-file",
      "jout/secret.txt",
    ]);
    expect(await cli(["start", "--project", "demo"])).toBe(1);
    const view = showJson("Through link");
    expect(view.verification?.checks[0]?.detail).toBe("link");
    expect(view.state).toBe("failed");
  });
});
