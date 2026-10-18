import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortMerge,
  addWorktree,
  changedPaths,
  commitPaths,
  deleteBranch,
  detectBaseBranch,
  discardChanges,
  finishMerge,
  hasConflictMarkers,
  headCommit,
  inspectRepository,
  isAncestor,
  listWorktrees,
  mergeBranch,
  mergeCheck,
  mergeInProgress,
  removeWorktree,
  unmergedPaths,
} from "../src/index.js";

// Real git and real processes: under the load of the full suite one test can take several seconds, so this file gives
// its tests and hooks a minute instead of the suite's 15 s (a hang still fails it).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The git side of parallel writes (docs/modos-y-delegacion.md 3.10, spike S4 in ADR-0021), on temporary repositories:
// the base branch a workflow starts from, one worktree and branch per executor created from it (with long paths), the
// commit of an executor's work, the merge-tree pre-check, a merge with and without a conflict, its resolution and its
// abort, and the removal of a worktree a process still holds (prune and retry).

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-git-wt-"));
  const globalConfig = join(root, "empty.gitconfig");
  writeFileSync(globalConfig, "");
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(root),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=HARIL test",
      "-c",
      "user.email=test@haril.invalid",
      "-c",
      "core.longpaths=true",
      "-C",
      cwd,
      ...args,
    ],
    { windowsHide: true, encoding: "utf8", env },
  ).trim();
}

// A repository with one commit on `branch`: readme.txt and src/app.ts.
function repo(name: string, branch = "main"): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "--quiet", `--initial-branch=${branch}`);
  writeFileSync(join(dir, "readme.txt"), "one\n");
  writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "first");
  return dir;
}

describe.skipIf(!HAS_GIT)("repository and base branch", () => {
  it("accepts the top level of a repository with commits and refuses anything else", async () => {
    const project = repo("project");
    expect(await inspectRepository(project, { env })).toMatchObject({ ok: true });
    expect(await inspectRepository(join(project, "src"), { env })).toMatchObject({
      ok: false,
      reason: "not_top_level",
    });
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await inspectRepository(plain, { env })).toMatchObject({
      ok: false,
      reason: "not_a_repository",
    });
    const empty = join(root, "empty");
    mkdirSync(empty);
    git(empty, "init", "--quiet");
    expect(await inspectRepository(empty, { env })).toMatchObject({
      ok: false,
      reason: "no_commits",
    });
  });

  it("takes main, fixing its commit", async () => {
    const project = repo("project");
    git(project, "checkout", "--quiet", "-b", "feature");
    expect(await detectBaseBranch(project, null, { env })).toEqual({
      ok: true,
      branch: "main",
      sha: git(project, "rev-parse", "main"),
      source: "main",
    });
  });

  it("detects a default branch named differently: the remote's HEAD, then master", async () => {
    const upstream = repo("upstream", "trunk");
    const clone = join(root, "clone");
    execFileSync("git", ["clone", "--quiet", upstream, clone], { env, windowsHide: true });
    expect(await detectBaseBranch(clone, null, { env })).toMatchObject({
      ok: true,
      branch: "trunk",
      source: "origin_head",
    });
    const legacy = repo("legacy", "master");
    expect(await detectBaseBranch(legacy, null, { env })).toMatchObject({
      ok: true,
      branch: "master",
      source: "master",
    });
  });

  it("uses a requested branch only when it exists, and refuses a dangerous name", async () => {
    const project = repo("project");
    git(project, "branch", "release");
    expect(await detectBaseBranch(project, "release", { env })).toMatchObject({
      ok: true,
      branch: "release",
      source: "requested",
    });
    expect(await detectBaseBranch(project, "nope", { env })).toMatchObject({
      ok: false,
      reason: "no_base_branch",
    });
    expect(await detectBaseBranch(project, "--upload-pack=evil", { env })).toMatchObject({
      ok: false,
      reason: "invalid_branch",
    });
  });
});

describe.skipIf(!HAS_GIT)("worktrees, commits and merges", () => {
  it("creates a worktree and its branch from the base commit, with files whose path passes 260 characters", async () => {
    const project = repo("project");
    // A file deep enough that its path inside the worktree passes Windows' 260 characters (S4: core.longpaths).
    const deepFile = join("src", "x".repeat(100), "y".repeat(100), "deep.txt");
    mkdirSync(join(project, dirname(deepFile)), { recursive: true });
    writeFileSync(join(project, deepFile), "deep\n");
    execFileSync(
      "git",
      [
        "-c",
        "core.longpaths=true",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@haril.invalid",
        "-C",
        project,
        "add",
        ".",
      ],
      { env, windowsHide: true },
    );
    execFileSync(
      "git",
      [
        "-c",
        "core.longpaths=true",
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@haril.invalid",
        "-C",
        project,
        "commit",
        "--quiet",
        "-m",
        "deep",
      ],
      { env, windowsHide: true },
    );
    const base = git(project, "rev-parse", "main");
    // main moves on after the workflow fixed its base: the worktree still starts from the fixed commit.
    writeFileSync(join(project, "readme.txt"), "two\n");
    git(project, "commit", "--quiet", "-am", "later");
    const tree = join(root, "worktrees", "w".repeat(40), "step");
    expect(join(tree, deepFile).length).toBeGreaterThan(260);
    expect(
      await addWorktree(project, { path: tree, branch: "haril/wf/task/t1", base }, { env }),
    ).toEqual({ ok: true, reused: false });
    expect(readFileSync(join(tree, "readme.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(tree, deepFile), "utf8")).toBe("deep\n");
    expect(await headCommit(tree, { env })).toBe(base);
    // Asking again reuses it.
    expect(
      await addWorktree(project, { path: tree, branch: "haril/wf/task/t1", base }, { env }),
    ).toEqual({ ok: true, reused: true });
    const listed = await listWorktrees(project, { env });
    expect(listed?.some((entry) => entry.branch === "haril/wf/task/t1")).toBe(true);
  });

  it("refuses a worktree folder whose own path is too long for git on Windows", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const tree = join(root, "x".repeat(120), "y".repeat(120));
    expect(
      await addWorktree(project, { path: tree, branch: "haril/wf/task/long", base }, { env }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("too long") });
  });

  it("commits only the paths it is given and discards the rest", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const tree = join(root, "wt1");
    await addWorktree(project, { path: tree, branch: "haril/wf/task/t1", base }, { env });
    writeFileSync(join(tree, "src", "app.ts"), "export const app = 2;\n");
    writeFileSync(join(tree, "src", "new.ts"), "export const fresh = true;\n");
    writeFileSync(join(tree, "stray.log"), "noise\n");
    expect((await changedPaths(tree, { env }))?.sort()).toEqual([
      "src/app.ts",
      "src/new.ts",
      "stray.log",
    ]);
    const commit = await commitPaths(tree, ["src/app.ts", "src/new.ts"], "haril: step 1", { env });
    expect(commit).toMatchObject({ ok: true });
    expect(await discardChanges(tree, { env })).toBe(true);
    expect(existsSync(join(tree, "stray.log"))).toBe(false);
    expect(await changedPaths(tree, { env })).toEqual([]);
    expect(git(tree, "show", "--name-only", "--format=", "HEAD").split(/\r?\n/).sort()).toEqual([
      "src/app.ts",
      "src/new.ts",
    ]);
    // Nothing to commit is no commit.
    expect(await commitPaths(tree, [], "haril: nothing", { env })).toEqual({ ok: true, sha: null });
  });

  it("pre-checks with merge-tree and merges without a conflict, never touching main", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const a = join(root, "a");
    const b = join(root, "b");
    const integration = join(root, "integration");
    await addWorktree(project, { path: a, branch: "haril/wf/task/a", base }, { env });
    await addWorktree(project, { path: b, branch: "haril/wf/task/b", base }, { env });
    await addWorktree(
      project,
      { path: integration, branch: "haril/wf/integration", base },
      { env },
    );
    writeFileSync(join(a, "a.txt"), "a\n");
    writeFileSync(join(b, "b.txt"), "b\n");
    await commitPaths(a, ["a.txt"], "a", { env });
    await commitPaths(b, ["b.txt"], "b", { env });
    expect(await mergeCheck(project, "haril/wf/integration", "haril/wf/task/a", { env })).toEqual({
      ok: true,
      clean: true,
    });
    const first = await mergeBranch(integration, "haril/wf/task/a", "merge a", { env });
    expect(first).toMatchObject({ ok: true, merged: true });
    const second = await mergeBranch(integration, "haril/wf/task/b", "merge b", { env });
    expect(second).toMatchObject({ ok: true, merged: true });
    expect(readFileSync(join(integration, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(integration, "b.txt"), "utf8")).toBe("b\n");
    expect(await isAncestor(project, "haril/wf/task/a", "haril/wf/integration", { env })).toBe(
      true,
    );
    expect(git(project, "rev-parse", "main")).toBe(base);
    // --no-ff: each merge is a merge commit with two parents.
    expect(git(integration, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  });

  it("reports a conflict as data, takes the resolution, and can abort instead", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const a = join(root, "a");
    const b = join(root, "b");
    const integration = join(root, "integration");
    await addWorktree(project, { path: a, branch: "haril/wf/task/a", base }, { env });
    await addWorktree(project, { path: b, branch: "haril/wf/task/b", base }, { env });
    await addWorktree(
      project,
      { path: integration, branch: "haril/wf/integration", base },
      { env },
    );
    writeFileSync(join(a, "src", "app.ts"), "export const app = 'a';\n");
    writeFileSync(join(b, "src", "app.ts"), "export const app = 'b';\n");
    await commitPaths(a, ["src/app.ts"], "a", { env });
    await commitPaths(b, ["src/app.ts"], "b", { env });
    await mergeBranch(integration, "haril/wf/task/a", "merge a", { env });
    expect(await mergeCheck(project, "haril/wf/integration", "haril/wf/task/b", { env })).toEqual({
      ok: true,
      clean: false,
      conflicts: ["src/app.ts"],
    });
    const conflicted = await mergeBranch(integration, "haril/wf/task/b", "merge b", { env });
    expect(conflicted).toEqual({ ok: true, merged: false, conflicts: ["src/app.ts"] });
    expect(await mergeInProgress(integration, { env })).toBe(true);
    expect(await unmergedPaths(integration, { env })).toEqual(["src/app.ts"]);
    expect(hasConflictMarkers(readFileSync(join(integration, "src", "app.ts"), "utf8"))).toBe(true);

    // An abort leaves the integration branch as it was.
    const before = git(integration, "rev-parse", "HEAD");
    expect(await abortMerge(integration, { env })).toBe(true);
    expect(await mergeInProgress(integration, { env })).toBe(false);
    expect(git(integration, "rev-parse", "HEAD")).toBe(before);

    // The same merge again, resolved by hand, then committed.
    await mergeBranch(integration, "haril/wf/task/b", "merge b", { env });
    writeFileSync(join(integration, "src", "app.ts"), "export const app = 'a and b';\n");
    const done = await finishMerge(integration, ["src/app.ts"], "merge b, resolved", { env });
    expect(done).toMatchObject({ ok: true });
    expect(await mergeInProgress(integration, { env })).toBe(false);
    expect(await isAncestor(project, "haril/wf/task/b", "haril/wf/integration", { env })).toBe(
      true,
    );
  });

  it("refuses to finish a merge whose files still hold conflict markers", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const a = join(root, "a");
    const integration = join(root, "integration");
    await addWorktree(project, { path: a, branch: "haril/wf/task/a", base }, { env });
    await addWorktree(
      project,
      { path: integration, branch: "haril/wf/integration", base },
      { env },
    );
    writeFileSync(join(a, "src", "app.ts"), "export const app = 'a';\n");
    writeFileSync(join(integration, "src", "app.ts"), "export const app = 'i';\n");
    await commitPaths(a, ["src/app.ts"], "a", { env });
    await commitPaths(integration, ["src/app.ts"], "i", { env });
    await mergeBranch(integration, "haril/wf/task/a", "merge a", { env });
    expect(await finishMerge(integration, ["src/app.ts"], "merge a", { env })).toMatchObject({
      ok: false,
      unresolved: ["src/app.ts"],
    });
    expect(await mergeInProgress(integration, { env })).toBe(true);
  });

  it("removes a worktree a process still holds, by pruning and retrying, and deletes its branch", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const tree = join(root, "held");
    await addWorktree(project, { path: tree, branch: "haril/wf/task/held", base }, { env });
    // A process whose working folder is inside the worktree: Windows refuses to delete the folder while it runs.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1200)"], {
      cwd: join(tree, "src"),
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const removed = await removeWorktree(project, tree, { env, retries: 20, retryDelayMs: 150 });
    holder.kill();
    expect(removed).toEqual({ ok: true });
    expect(existsSync(tree)).toBe(false);
    const listed = await listWorktrees(project, { env });
    expect(listed?.some((entry) => entry.branch === "haril/wf/task/held")).toBe(false);
    expect(await deleteBranch(project, "haril/wf/task/held", { env })).toBe(true);
    expect(git(project, "branch", "--list", "haril/wf/task/held")).toBe("");
  });

  it("recreates a worktree whose folder was deleted behind git's back", async () => {
    const project = repo("project");
    const base = git(project, "rev-parse", "main");
    const tree = join(root, "gone");
    await addWorktree(project, { path: tree, branch: "haril/wf/task/gone", base }, { env });
    rmSync(tree, { recursive: true, force: true });
    expect(
      await addWorktree(project, { path: tree, branch: "haril/wf/task/gone", base }, { env }),
    ).toEqual({ ok: true, reused: false });
    expect(existsSync(join(tree, "readme.txt"))).toBe(true);
  });
});
