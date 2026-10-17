import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitStatus } from "../src/index.js";

// readGitStatus (LD-T6b-1): the branch and the count of changed paths of a working tree, for the shell's Status box.
// It runs git with execFile and a time limit, and answers undefined for anything that is not a readable work tree.

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

let root: string;
// git for the fixtures and for the reads under test: an empty global config, no system config, and discovery stops
// at the temp directory, so neither the user's config nor a repository around the temp directory takes part.
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-git-status-"));
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
  rmSync(root, { recursive: true, force: true });
});

// The identity lives on the command line, so the test never reads or writes the user's git config.
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=HARIL test", "-c", "user.email=test@haril.invalid", "-C", cwd, ...args],
    { windowsHide: true, encoding: "utf8", env },
  );
}

// A repository at `dir` with one commit of readme.txt.
function committedRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  writeFileSync(join(dir, "readme.txt"), "one\n");
  git(dir, "add", "readme.txt");
  git(dir, "commit", "--quiet", "-m", "first");
}

describe.skipIf(!HAS_GIT)("readGitStatus", () => {
  it("names the branch and counts no changes in a clean work tree", async () => {
    committedRepo(join(root, "repo"));
    git(join(root, "repo"), "checkout", "--quiet", "-b", "feature-x");
    expect(await readGitStatus(join(root, "repo"), { env })).toEqual({
      branch: "feature-x",
      changes: 0,
    });
  });

  it("counts one change per modified or untracked path", async () => {
    const repo = join(root, "repo");
    committedRepo(repo);
    writeFileSync(join(repo, "readme.txt"), "two\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    const status = await readGitStatus(repo, { env });
    expect(status?.changes).toBe(2);
  });

  it("counts untracked paths even when the repository's config hides them", async () => {
    const repo = join(root, "repo");
    committedRepo(repo);
    git(repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(repo, "new.txt"), "new\n");
    expect((await readGitStatus(repo, { env }))?.changes).toBe(1);
  });

  it("names HEAD for a detached HEAD", async () => {
    const repo = join(root, "repo");
    committedRepo(repo);
    git(repo, "checkout", "--quiet", "--detach");
    expect(await readGitStatus(repo, { env })).toEqual({ branch: "HEAD", changes: 0 });
  });

  it("answers undefined for a repository without commits", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    expect(await readGitStatus(repo, { env })).toBeUndefined();
  });

  it("answers undefined for a directory that is not a repository", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await readGitStatus(plain, { env })).toBeUndefined();
  });

  it("answers undefined for a path that does not exist", async () => {
    expect(await readGitStatus(join(root, "missing"), { env })).toBeUndefined();
  });

  it("answers undefined when the git program cannot be run", async () => {
    committedRepo(join(root, "repo"));
    expect(
      await readGitStatus(join(root, "repo"), { env, program: join(root, "no-such-git-program") }),
    ).toBeUndefined();
  });

  it("reads the root it is given even when the process names another repository", async () => {
    const repo = join(root, "repo");
    const other = join(root, "other");
    committedRepo(repo);
    git(repo, "checkout", "--quiet", "-b", "mine");
    committedRepo(other);
    git(other, "checkout", "--quiet", "-b", "theirs");
    writeFileSync(join(other, "dirty.txt"), "x\n");
    // GIT_DIR and its kin, set by a parent git (a hook, an alias) or by the user, would point git at `other`.
    const inherited: NodeJS.ProcessEnv = {
      ...env,
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
    };
    const keys = Object.keys(inherited).filter((key) => key.startsWith("GIT_"));
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = inherited[key];
    try {
      expect(await readGitStatus(repo)).toEqual({ branch: "mine", changes: 0 });
      expect(await readGitStatus(repo, { env: inherited })).toEqual({ branch: "mine", changes: 0 });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
