import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentOutcome, Store } from "@haril/core/ports";
import { addWorktree, worktreeIdentity } from "@haril/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkflowView } from "../src/runtime/workflow-view.js";
import { applyEdits, createWorkspaces, type TurnWorkspace } from "../src/runtime/worktrees.js";

// Real git and real processes: under the load of the full suite one test can take several seconds, so this file gives
// its tests and hooks a minute instead of the suite's 15 s (a hang still fails it).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The host side of an executor's write and edit (docs/modos-y-delegacion.md 3.10.5 and section 8; phase F8): the
// Core's lexical PathGuard, then the filesystem check, on a real worktree. Inside the declared surface a file is written;
// outside it, under .git, a secret or through a junction, nothing is.

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

let base: string;
let repo: string;
let tree: string;
let outside: string;
let env: NodeJS.ProcessEnv;
let identity: { gitDir: string; pointer: string };

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "haril-ws-"));
  repo = join(base, "project");
  tree = join(base, "wt");
  outside = join(base, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  const globalConfig = join(base, "empty.gitconfig");
  writeFileSync(globalConfig, "");
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(base),
  };
  if (!HAS_GIT) return;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@haril.invalid", "-C", repo, ...args],
      {
        env,
        windowsHide: true,
      },
    );
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(
    join(repo, "src", "button.ts"),
    "export const color = 'red';\nexport const size = 1;\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  await addWorktree(repo, { path: tree, branch: "haril/wf/step/s1", base: "main" }, { env });
  const found = await worktreeIdentity(repo, tree, { env });
  if (found === undefined) throw new Error("the test worktree has no identity");
  identity = found;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function workspace(): TurnWorkspace {
  return {
    kind: "executor",
    worktreeId: "w1",
    root: tree,
    branch: "haril/wf/step/s1",
    baseBranch: "main",
    repo,
    workflowId: "wf",
    writeSurface: ["src/button.ts", "tests/**"],
    gitDir: identity.gitDir,
    pointer: identity.pointer,
    startHead: gitIn(tree, "rev-parse", "HEAD"),
  };
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@haril.invalid", "-C", cwd, ...args],
    { env, windowsHide: true, encoding: "utf8" },
  ).trim();
}

// What finish needs from the store, the view and the task, recorded for the assertions.
function turnFakes() {
  const events: { type: string; payload: unknown }[] = [];
  const heads: string[] = [];
  const store = {
    events: { append: (event: { type: string; payload: unknown }) => events.push(event) },
    worktrees: { setHead: (_epoch: number, _id: string, sha: string) => heads.push(sha) },
  } as unknown as Store;
  const view = {
    label: () => "part-1/s1",
    workflow: { workflowId: "wf", projectId: "p1" },
  } as unknown as WorkflowView;
  const task = {
    taskId: "t1",
    threadId: "th1",
    attempt: 1,
    goal: "Change the button",
  } as unknown as Task;
  return { store, view, task, events, heads };
}

const SUCCEEDED: AgentOutcome = { status: "succeeded", summary: "done" };

const workspaces = () =>
  createWorkspaces({
    root: join(base, "worktrees"),
    commands: { allow: [], timeoutMs: 1_000, outputMaxBytes: 1_000 },
    git: { env },
  });

describe.skipIf(!HAS_GIT)("an executor's write and edit", () => {
  it("writes a file inside the surface, creating its folders", async () => {
    const ws = workspace();
    expect(await workspaces().write(ws, ws.writeSurface, "tests/button.test.ts", "test\n")).toEqual(
      {
        ok: true,
        path: "tests/button.test.ts",
        bytes: 5,
        created: true,
      },
    );
    expect(readFileSync(join(tree, "tests", "button.test.ts"), "utf8")).toBe("test\n");
  });

  it("refuses a path outside the surface, under .git, a secret, or through a junction, and writes nothing", async () => {
    const ws = workspace();
    const host = workspaces();
    expect(await host.write(ws, ws.writeSurface, "src/other.ts", "x")).toEqual({
      ok: false,
      reason:
        "src/other.ts cannot be written: outside your write surface (src/button.ts, tests/**)",
    });
    expect(existsSync(join(tree, "src", "other.ts"))).toBe(false);
    expect(await host.write(ws, ["**"], ".git/config", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("denied path"),
    });
    expect(await host.write(ws, ["**"], "src/.env", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("secret path"),
    });
    expect(await host.write(ws, ["**"], "../outside/x.ts", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("traversal"),
    });
    symlinkSync(outside, join(tree, "tests"), "junction");
    expect(await host.write(ws, ws.writeSurface, "tests/escape.ts", "x")).toEqual({
      ok: false,
      reason: "tests/escape.ts cannot be written: link",
    });
    expect(existsSync(join(outside, "escape.ts"))).toBe(false);
  });

  it("edits exact text once, and refuses text that is missing or ambiguous", async () => {
    const ws = workspace();
    const host = workspaces();
    expect(
      await host.edit(ws, ws.writeSurface, "src/button.ts", [
        { oldText: "'red'", newText: "'blue'" },
      ]),
    ).toEqual({ ok: true, path: "src/button.ts", edits: 1 });
    expect(readFileSync(join(tree, "src", "button.ts"), "utf8")).toContain("'blue'");
    expect(
      await host.edit(ws, ws.writeSurface, "src/button.ts", [{ oldText: "'green'", newText: "x" }]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("is not in the file") });
    expect(
      await host.edit(ws, ws.writeSurface, "src/button.ts", [
        { oldText: "export const", newText: "x" },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("more than once") });
    expect(
      await host.edit(ws, ws.writeSurface, "src/missing.ts", [{ oldText: "a", newText: "b" }]),
    ).toMatchObject({ ok: false });
  });
});

describe.skipIf(!HAS_GIT)("the end of an executor's turn", () => {
  it("commits the surface onto the step's branch through the worktree's own git folder", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    const mainBefore = gitIn(repo, "rev-parse", "main");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED)).toEqual(
      SUCCEEDED,
    );
    expect(gitIn(repo, "show", "haril/wf/step/s1:src/button.ts")).toBe(
      "export const color = 'blue';",
    );
    expect(gitIn(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(fakes.heads).toEqual([gitIn(repo, "rev-parse", "haril/wf/step/s1")]);
  });

  it("fails the turn when the .git pointer file was rewritten, restores it, and main never moves", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    const mainBefore = gitIn(repo, "rev-parse", "main");
    const stepBefore = gitIn(repo, "rev-parse", "haril/wf/step/s1");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    // What a command could do: point the worktree at the main repository, so a plain git commit would land on main.
    // (git marks the file hidden on Windows, where only a new file can take its place.)
    rmSync(join(tree, ".git"));
    writeFileSync(join(tree, ".git"), `gitdir: ${join(repo, ".git")}\n`);
    const outcome = await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED);
    expect(outcome).toMatchObject({ status: "failed", code: "workspace.tampered" });
    expect(gitIn(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(stepBefore);
    expect(readFileSync(join(tree, ".git"), "utf8")).toBe(identity.pointer);
    expect(fakes.events.map((event) => event.type)).toEqual(["worktree.tampered"]);
    // The change was discarded with the worktree's own git folder, not main's.
    expect(readFileSync(join(tree, "src", "button.ts"), "utf8")).toContain("'red'");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
  });

  it("commits only the surface even when a command staged a file outside it", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    // What a command could leave: a file outside the surface, already staged.
    writeFileSync(join(tree, "outside.txt"), "not part of the step\n");
    gitIn(tree, "add", "outside.txt");
    expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED)).toEqual(
      SUCCEEDED,
    );
    expect(gitIn(repo, "show", "--name-only", "--format=", "haril/wf/step/s1")).toBe(
      "src/button.ts",
    );
    expect(existsSync(join(tree, "outside.txt"))).toBe(false);
  });

  it("fails the turn and puts the branch back when a command committed outside the surface", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    const stepBefore = gitIn(repo, "rev-parse", "haril/wf/step/s1");
    const mainBefore = gitIn(repo, "rev-parse", "main");
    writeFileSync(join(tree, "outside.txt"), "committed by a command\n");
    gitIn(tree, "add", "outside.txt");
    gitIn(tree, "commit", "--quiet", "-m", "sneaked in");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    const outcome = await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED);
    expect(outcome).toMatchObject({ status: "failed", code: "workspace.outside_surface" });
    expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(stepBefore);
    expect(gitIn(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(fakes.heads).toEqual([]);
    expect(fakes.events.map((event) => event.type)).toEqual(["worktree.outside_surface"]);
    expect(gitIn(tree, "status", "--porcelain")).toBe("");
  });

  it("refuses to commit when the worktree's HEAD is not the step's branch", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    gitIn(tree, "checkout", "--quiet", "-b", "elsewhere");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    const outcome = await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED);
    expect(outcome).toMatchObject({ status: "failed", code: "workspace.commit_failed" });
    expect(gitIn(repo, "rev-parse", "elsewhere")).toBe(gitIn(repo, "rev-parse", "main"));
    expect(fakes.heads).toEqual([]);
  });
});

describe("applyEdits", () => {
  it("applies every replacement against the original text", () => {
    expect(
      applyEdits("a-b-c", [
        { oldText: "c", newText: "C" },
        { oldText: "a", newText: "A" },
      ]),
    ).toEqual({ ok: true, text: "A-b-C" });
  });

  it("refuses overlapping replacements", () => {
    expect(
      applyEdits("abcdef", [
        { oldText: "abc", newText: "x" },
        { oldText: "cde", newText: "y" },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("overlap") });
  });
});
