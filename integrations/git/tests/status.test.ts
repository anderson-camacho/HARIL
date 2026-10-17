import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGitStatus } from "../src/index.js";

// readGitStatus (LD-T6b-1): the branch and the count of changed paths of a working tree, for the shell's Status box.
// It runs git with execFile and a time limit, and answers undefined for anything that is not a readable work tree.

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-git-status-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The identity lives on the command line, so the test never reads or writes the user's git config.
function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=HARIL test", "-c", "user.email=test@haril.invalid", "-C", root, ...args],
    { windowsHide: true, stdio: "ignore" },
  );
}

describe.skipIf(!HAS_GIT)("readGitStatus", () => {
  it("names the branch and counts no changes in a clean work tree", async () => {
    git("init", "--quiet");
    writeFileSync(join(root, "readme.txt"), "one\n");
    git("add", "readme.txt");
    git("commit", "--quiet", "-m", "first");
    git("checkout", "--quiet", "-b", "feature-x");
    expect(await readGitStatus(root)).toEqual({ branch: "feature-x", changes: 0 });
  });

  it("counts one change per modified or untracked path", async () => {
    git("init", "--quiet");
    writeFileSync(join(root, "readme.txt"), "one\n");
    git("add", "readme.txt");
    git("commit", "--quiet", "-m", "first");
    writeFileSync(join(root, "readme.txt"), "two\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    const status = await readGitStatus(root);
    expect(status?.changes).toBe(2);
  });

  it("answers undefined for a path that does not exist", async () => {
    expect(await readGitStatus(join(root, "missing"))).toBeUndefined();
  });

  it("answers undefined when the git program cannot be run", async () => {
    git("init", "--quiet");
    expect(
      await readGitStatus(root, { program: join(root, "no-such-git-program") }),
    ).toBeUndefined();
  });
});
