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
import type { AgentOutcome, Store, WorktreeRecord } from "@haril/core/ports";
import { addWorktree, worktreeIdentity } from "@haril/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkflowView } from "../src/runtime/workflow-view.js";
import { applyEdits, createWorkspaces, type TurnWorkspace } from "../src/runtime/worktrees.js";
import { COMMIT_MAIN_SCRIPT } from "./command-scripts.js";

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
    baseTip: gitIn(repo, "rev-parse", "main"),
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
function turnFakes(role: "executor" | "auditor" | "delegator" = "executor") {
  const events: { type: string; payload: unknown }[] = [];
  const heads: string[] = [];
  const verified: string[] = [];
  const store = {
    events: { append: (event: { type: string; payload: unknown }) => events.push(event) },
    worktrees: {
      setHead: (_epoch: number, _id: string, sha: string) => heads.push(sha),
      setVerified: (_epoch: number, _id: string, sha: string) => verified.push(sha),
    },
  } as unknown as Store;
  const view = {
    label: () => "part-1/s1",
    workflow: { workflowId: "wf", projectId: "p1" },
    task: () => (role === "auditor" ? { role: "executor", threadId: "th0" } : undefined),
  } as unknown as WorkflowView;
  const task = {
    role,
    taskId: "t1",
    threadId: "th1",
    parentTaskId: "t0",
    attempt: 1,
    goal: "Change the button",
  } as unknown as Task;
  return { store, view, task, events, heads, verified };
}

// What a command run in the worktree can do: commit a file onto whatever branch HEAD names there.
function commitByCommand(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `committed by a command ${Math.random()}\n`);
  gitIn(cwd, "add", file);
  gitIn(cwd, "commit", "--quiet", "-m", `sneaked ${file}`);
  return gitIn(cwd, "rev-parse", "HEAD");
}

const FAILED: AgentOutcome = { status: "failed", code: "agent.exit", message: "the agent failed" };

const SUCCEEDED: AgentOutcome = { status: "succeeded", summary: "done" };

const workspaces = (allow: readonly string[] = []) =>
  createWorkspaces({
    root: join(base, "worktrees"),
    commands: { allow, timeoutMs: 30_000, outputMaxBytes: 4_000 },
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
    // HEAD names the step's branch again, on the commit the turn started from; the other branch was not moved.
    expect(gitIn(tree, "symbolic-ref", "--short", "HEAD")).toBe("haril/wf/step/s1");
    expect(gitIn(tree, "rev-parse", "HEAD")).toBe(ws.startHead);
  });

  it("puts the branch back when a command committed during an attempt that failed", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    const mainBefore = gitIn(repo, "rev-parse", "main");
    commitByCommand(tree, "outside.txt");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, FAILED)).toEqual(FAILED);
    expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(ws.startHead);
    expect(gitIn(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(existsSync(join(tree, "outside.txt"))).toBe(false);
    expect(gitIn(tree, "status", "--porcelain")).toBe("");
    expect(fakes.events.map((event) => event.type)).toEqual(["worktree.restored"]);
    expect(fakes.heads).toEqual([]);
    expect(fakes.verified).toEqual([]);
  });

  it("puts the branch back when the turn was tampered with, after a command's commit", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    commitByCommand(tree, "outside.txt");
    rmSync(join(tree, ".git"));
    writeFileSync(join(tree, ".git"), `gitdir: ${join(repo, ".git")}\n`);
    const outcome = await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED);
    expect(outcome).toMatchObject({ status: "failed", code: "workspace.tampered" });
    expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(ws.startHead);
    expect(existsSync(join(tree, "outside.txt"))).toBe(false);
    expect(fakes.events.map((event) => event.type)).toEqual([
      "worktree.restored",
      "worktree.tampered",
    ]);
  });

  it("refuses a success whose branch no longer holds the step's verified commit", async () => {
    // A commit of an earlier verified turn, then a command that reset the branch below it.
    writeFileSync(join(tree, "src", "button.ts"), "export const color = 'green';\n");
    gitIn(tree, "commit", "--quiet", "-am", "an earlier verified turn");
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    gitIn(tree, "reset", "--quiet", "--hard", "main");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    const outcome = await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED);
    expect(outcome).toMatchObject({ status: "failed", code: "workspace.commit_failed" });
    expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(ws.startHead);
    expect(readFileSync(join(tree, "src", "button.ts"), "utf8")).toContain("'green'");
    expect(fakes.verified).toEqual([]);
  });

  it("records the commit it verified, where the step's next turn starts", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED)).toEqual(
      SUCCEEDED,
    );
    expect(fakes.verified).toEqual([gitIn(repo, "rev-parse", "haril/wf/step/s1")]);
  });
});

describe.skipIf(!HAS_GIT)(
  "the commits a command makes in an auditor's or a delegator's turn",
  () => {
    it("an auditor's turn leaves the step's branch on its verified commit", async () => {
      const ws = { ...workspace(), kind: "audit" as const, writeSurface: [] };
      const host = workspaces();
      const fakes = turnFakes("auditor");
      commitByCommand(tree, "src/button.ts");
      expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED)).toEqual(
        SUCCEEDED,
      );
      expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(ws.startHead);
      expect(readFileSync(join(tree, "src", "button.ts"), "utf8")).toContain("'red'");
      expect(fakes.events.map((event) => event.type)).toEqual(["worktree.restored"]);
    });

    it("a delegator's turn keeps the merges HARIL made and drops a command's commits", async () => {
      // The step worktree stands in for the integration worktree here.
      const ws = { ...workspace(), kind: "integration" as const, writeSurface: [] };
      const host = workspaces();
      const fakes = turnFakes("delegator");
      // A merge HARIL made in the turn (a commit stands for it), then a command's commit on top.
      const merge = commitByCommand(tree, "merged.txt");
      host.recordMerge(ws, merge);
      expect(host.verifiedHead(ws)).toBe(merge);
      commitByCommand(tree, "sneaked.txt");
      expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED)).toEqual(
        SUCCEEDED,
      );
      expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(merge);
      expect(existsSync(join(tree, "merged.txt"))).toBe(true);
      expect(existsSync(join(tree, "sneaked.txt"))).toBe(false);
      expect(fakes.events.map((event) => event.type)).toEqual(["worktree.restored"]);
    });
  },
);

describe.skipIf(!HAS_GIT)("a base branch that moved during a turn", () => {
  it("fails the turn when a command moved main through a repointed .git file, and never moves main back", async () => {
    const ws = workspace();
    const host = workspaces(["node commit-main.mjs"]);
    const fakes = turnFakes();
    const before = gitIn(repo, "rev-parse", "main");
    writeFileSync(join(tree, "commit-main.mjs"), COMMIT_MAIN_SCRIPT);
    const ran = await host.run(ws, "node", ["commit-main.mjs"]);
    expect(ran).toMatchObject({ ok: true, exitCode: 0 });
    const after = gitIn(repo, "rev-parse", "main");
    expect(after).not.toBe(before);
    // The command put the .git file back: only the base branch shows what it did.
    expect(readFileSync(join(tree, ".git"), "utf8")).toBe(identity.pointer);
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    const outcome = await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED);
    expect(outcome).toMatchObject({ status: "failed", code: "workspace.base_moved" });
    const message = (outcome as { message: string }).message;
    expect(message).toContain(`git log ${before}..${after}`);
    expect(message).toContain(`git branch -f main ${before}`);
    expect(message).toContain(`git reset --keep ${before}`);
    // Nothing was committed on the step's branch, and main stays where the command left it.
    expect(gitIn(repo, "rev-parse", "haril/wf/step/s1")).toBe(ws.startHead);
    expect(gitIn(repo, "rev-parse", "main")).toBe(after);
    expect(fakes.verified).toEqual([]);
    expect(fakes.events.map((event) => event.type)).toEqual(["base.moved"]);
    expect(fakes.events[0]?.payload).toMatchObject({
      baseBranch: "main",
      fromSha: before,
      toSha: after,
      commands: 1,
      stopped: true,
    });
  });

  it("only records the move when the turn ran no command: the user committed on main", async () => {
    const ws = workspace();
    const host = workspaces();
    const fakes = turnFakes();
    const before = gitIn(repo, "rev-parse", "main");
    gitIn(repo, "commit", "--quiet", "--allow-empty", "-m", "the user's own commit");
    const after = gitIn(repo, "rev-parse", "main");
    expect(
      await host.write(ws, ws.writeSurface, "src/button.ts", "export const color = 'blue';\n"),
    ).toMatchObject({ ok: true });
    expect(await host.finish(fakes.store, 1, fakes.view, fakes.task, ws, SUCCEEDED)).toEqual(
      SUCCEEDED,
    );
    expect(gitIn(repo, "show", "haril/wf/step/s1:src/button.ts")).toBe(
      "export const color = 'blue';",
    );
    expect(fakes.events.map((event) => event.type)).toEqual(["base.moved"]);
    expect(fakes.events[0]?.payload).toMatchObject({
      fromSha: before,
      toSha: after,
      commands: 0,
      stopped: false,
    });
  });
});

describe.skipIf(!HAS_GIT)("a step's next turn after a crash", () => {
  it("starts from the step's verified commit, never from a HEAD a command moved", async () => {
    const host = workspaces();
    const base = gitIn(repo, "rev-parse", "main");
    const events: { type: string }[] = [];
    const records = new Map<string, Record<string, unknown>>();
    const store = {
      projects: { list: () => [{ projectId: "p1", rootPath: repo }] },
      events: { append: (event: { type: string }) => events.push(event) },
      worktrees: {
        list: () => [...records.values()],
        record: (_epoch: number, input: Record<string, unknown>) => {
          const id = `w-${String(input.kind)}-${String(input.threadId)}`;
          const known = records.get(id);
          if (known !== undefined) return known;
          const created: Record<string, unknown> = {
            ...input,
            worktreeId: id,
            headSha: null,
            verifiedSha: null,
            mergedAt: null,
            state: "active",
          };
          records.set(id, created);
          return created;
        },
        setVerified: (_epoch: number, id: string, sha: string) => {
          const known = records.get(id);
          if (known !== undefined) known.verifiedSha = sha;
        },
      },
    } as unknown as Store;
    const executor = {
      role: "executor",
      taskId: "t-e",
      threadId: "th-e",
      parentTaskId: "t-d",
      dependsOn: [],
      surfaceWrite: ["src/button.ts"],
      attempt: 1,
      goal: "Change the button",
    } as unknown as Task;
    const auditor = {
      role: "auditor",
      taskId: "t-a",
      threadId: "th-a",
      parentTaskId: "t-d",
      auditedTaskId: "t-e",
    } as unknown as Task;
    const view = {
      workflow: { workflowId: "wf3", projectId: "p1", baseBranch: "main", baseSha: base },
      turns: () => [{ localId: "s1" }],
      parentThreadId: () => null,
      label: () => "s1",
      task: (taskId: string) => (taskId === "t-e" ? executor : undefined),
    } as unknown as WorkflowView;
    const first = await host.prepare(store, 1, view, executor);
    if (first === null) throw new Error("no step worktree");
    expect(first.startHead).toBe(base);
    expect([...records.values()][0]?.verifiedSha).toBe(base);
    // An attempt whose runtime crashed: a command committed outside the surface, and the turn's end never ran.
    commitByCommand(first.root, "outside.txt");
    const again = await host.prepare(store, 1, view, executor);
    expect(again?.startHead).toBe(base);
    expect(gitIn(repo, "rev-parse", first.branch)).toBe(base);
    expect(existsSync(join(first.root, "outside.txt"))).toBe(false);
    // The same for the step's auditor: it audits the verified commit, not what a command added.
    commitByCommand(first.root, "audit.txt");
    const audit = await host.prepare(store, 1, view, auditor);
    expect(audit?.startHead).toBe(base);
    expect(gitIn(repo, "rev-parse", first.branch)).toBe(base);
    expect(existsSync(join(first.root, "audit.txt"))).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["worktree.restored", "worktree.restored"]);
    expect(gitIn(repo, "rev-parse", "main")).toBe(base);
  });
});

describe.skipIf(!HAS_GIT)("a delegator resolving a merge's conflicting files", () => {
  it("writes exactly the conflicting files, whatever characters their names hold", async () => {
    const ws = { ...workspace(), kind: "integration" as const, writeSurface: [] };
    const host = workspaces();
    const conflicts = { conflicts: ["app/[id]/page.tsx", "café.md", "docs/{a,b}!.md"] };
    for (const path of conflicts.conflicts) {
      expect(await host.write(ws, conflicts, path, "resolved\n"), path).toMatchObject({
        ok: true,
        path,
      });
      expect(readFileSync(join(tree, ...path.split("/")), "utf8")).toBe("resolved\n");
    }
    // A path a glob would have matched is not one of the files.
    expect(await host.write(ws, conflicts, "app/i/page.tsx", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not one of the conflicting files"),
    });
  });

  it("edits a tracked file whose name looks secret, never an untracked one or anything under .git", async () => {
    writeFileSync(join(tree, ".env.example"), "KEY=\n");
    gitIn(tree, "add", ".env.example");
    gitIn(tree, "commit", "--quiet", "-m", "example settings");
    const ws = { ...workspace(), kind: "integration" as const, writeSurface: [] };
    const host = workspaces();
    const conflicts = { conflicts: [".env.example", ".env.local", ".git/config", ".haril/x"] };
    expect(await host.write(ws, conflicts, ".env.example", "KEY=resolved\n")).toMatchObject({
      ok: true,
    });
    expect(await host.write(ws, conflicts, ".env.local", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("secret path"),
    });
    expect(await host.write(ws, conflicts, ".git/config", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("denied path"),
    });
    expect(await host.write(ws, conflicts, ".haril/x", "x")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("denied path"),
    });
  });
});

describe.skipIf(!HAS_GIT)("the sweep of an ended workflow's worktrees", () => {
  // A store that knows one completed workflow and the worktree records given, and remembers what was marked removed.
  function sweepStore(records: Partial<WorktreeRecord>[]) {
    const removed: string[] = [];
    const store = {
      worktrees: {
        list: () => records,
        markRemoved: (_epoch: number, id: string) => removed.push(id),
      },
      workflows: { get: () => ({ workflowId: "wf", state: "completed", projectId: "p1" }) },
      projects: { list: () => [{ projectId: "p1", rootPath: repo }] },
    } as unknown as Store;
    return { store, removed };
  }

  it("keeps a branch that holds commits, whatever the store says, and deletes an empty one", async () => {
    const base = gitIn(repo, "rev-parse", "main");
    const integration = join(dirname(tree), "wt-integration");
    await addWorktree(repo, { path: integration, branch: "haril/wf/integration", base }, { env });
    writeFileSync(join(integration, "merged.txt"), "merged work\n");
    gitIn(integration, "add", "merged.txt");
    gitIn(integration, "commit", "--quiet", "-m", "a merge the store never heard of");
    const empty = join(dirname(tree), "wt-empty");
    await addWorktree(repo, { path: empty, branch: "haril/wf/step/empty", base }, { env });
    const { store, removed } = sweepStore([
      // A crash between markMerged and setHead: the store says the integration branch holds nothing.
      {
        worktreeId: "w-int",
        workflowId: "wf",
        kind: "integration",
        path: integration,
        branch: "haril/wf/integration",
        baseSha: base,
        headSha: null,
        mergedAt: null,
        state: "active",
      },
      {
        worktreeId: "w-empty",
        workflowId: "wf",
        kind: "executor",
        path: empty,
        branch: "haril/wf/step/empty",
        baseSha: base,
        headSha: null,
        mergedAt: null,
        state: "active",
      },
    ]);
    expect(await workspaces().sweep(store, 1)).toBe(2);
    expect(removed.sort()).toEqual(["w-empty", "w-int"]);
    expect(gitIn(repo, "branch", "--list", "haril/wf/integration")).toContain(
      "haril/wf/integration",
    );
    expect(gitIn(repo, "branch", "--list", "haril/wf/step/empty")).toBe("");
  });
});

describe.skipIf(!HAS_GIT)("a delegator's turn after a crash", () => {
  it("starts clean: a merge a crashed runtime left half done is given up, and nothing uncommitted stays", async () => {
    const host = workspaces();
    const base = gitIn(repo, "rev-parse", "main");
    const store = {
      projects: { list: () => [{ projectId: "p1", rootPath: repo }] },
      worktrees: {
        record: (_epoch: number, input: object) => ({ ...input, worktreeId: "w-int" }),
        list: () => [],
      },
    } as unknown as Store;
    const view = {
      workflow: { workflowId: "wf2", projectId: "p1", baseBranch: "main", baseSha: base },
      task: () => undefined,
    } as unknown as WorkflowView;
    const delegator = {
      role: "delegator",
      taskId: "t-d",
      threadId: "th-d",
      parentTaskId: "t-o",
    } as unknown as Task;
    const first = await host.prepare(store, 1, view, delegator);
    if (first === null) throw new Error("no integration worktree");
    // A step's commit and an integration commit that change the same line.
    writeFileSync(join(tree, "src", "button.ts"), "export const color = 'step';\n");
    gitIn(tree, "commit", "--quiet", "-am", "step");
    writeFileSync(join(first.root, "src", "button.ts"), "export const color = 'integration';\n");
    gitIn(first.root, "commit", "--quiet", "-am", "integration");
    // The merge the crashed runtime started, left with its conflict, and a stray file.
    expect(() => gitIn(first.root, "merge", "--no-ff", "haril/wf/step/s1")).toThrow();
    writeFileSync(join(first.root, "stray.txt"), "left behind\n");
    expect(gitIn(first.root, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toBe("");

    const again = await host.prepare(store, 1, view, delegator);
    expect(again?.root).toBe(first.root);
    expect(() => gitIn(first.root, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(gitIn(first.root, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(first.root, "src", "button.ts"), "utf8")).toContain("'integration'");
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
