import { describe, expect, it } from "vitest";
import { classifyGitCommand, roleWriteProblem } from "../../src/index.js";

const level = (program: "git" | "gh", ...args: string[]) => classifyGitCommand(program, args).level;
const on = (branch: string, ...args: string[]) => classifyGitCommand("git", args, branch).level;

describe("the documentador's surface is closed", () => {
  it("allows docs/, README*, CHANGELOG* and versions/**", () => {
    for (const path of [
      "docs/guia.md",
      "docs/sub/diagrama.svg",
      "README.md",
      "README",
      "packages/core/README.md",
      "CHANGELOG.md",
      "packages/core/CHANGELOG.md",
      "versions/v0/CHANGELOG.md",
      "versions/v0/0.1.0/notes.txt",
    ]) {
      expect(roleWriteProblem("documentador", path), path).toBeNull();
    }
  });

  it("refuses text files that configure agents, builds or CI", () => {
    for (const path of [
      "AGENTS.md",
      "CLAUDE.md",
      "packages/core/AGENTS.md",
      ".claude/settings.md",
      ".claude/agents/x.md",
      ".github/workflows/ci.md",
      ".github/README.md",
      "requirements.txt",
      "CMakeLists.txt",
      "notes.txt",
      "src/page.mdx",
      "README.ps1",
      "docs/../CLAUDE.md",
      "docs/.github/x.md",
      "./.claude/x.md",
      "README.md:evil",
      "/etc/README.md",
      "C:/x/README.md",
    ]) {
      expect(roleWriteProblem("documentador", path), path).toMatch(/documentador/);
    }
  });
});

describe("a push names one remote and one explicit target", () => {
  it.each([
    [["push"]],
    [["push", "origin"]],
    [["push", "origin", "HEAD"]],
    [["push", "--all"]],
    [["push", "--all", "origin"]],
    [["push", "--mirror", "origin"]],
    [["push", "--tags", "origin"]],
    [["push", "--prune", "origin", "feat/x"]],
    [["push", "origin", "refs/heads/*:refs/heads/*"]],
    [["push", "origin", ":"]],
    [["push", "origin", ""]],
    [["push", "origin", "+:"]],
    [["push", "origin", "feat/*"]],
    [["push", "origin", "feat/x", "feat/y"]],
    [["push", "https://example.com/x.git", "feat/x"]],
    [["push", "../other", "feat/x"]],
    [["push", "--repo=https://example.com/x.git", "feat/x"]],
    [["push", "--receive-pack=evil", "origin", "feat/x"]],
    [["push", "--exec=evil", "origin", "feat/x"]],
    [["push", "--recei=evil", "origin", "feat/x"]],
    [["push", "-o", "x", "origin", "feat/x"]],
    [["push", "--dry-run", "origin", "feat/x"]],
  ])("refuses %j", (args) => {
    expect(classifyGitCommand("git", args).level).toBe("forbidden");
  });

  it.each([
    [["push", "origin", "main"]],
    [["push", "origin", "MAIN"]],
    [["push", "origin", "heads/main"]],
    [["push", "origin", "refs/heads/master"]],
    [["push", "origin", "+feat/x:main"]],
    [["push", "-u", "origin", "main"]],
    [["push", "-fu", "origin", "main"]],
    [["push", "-df", "origin", "main"]],
    [["push", "origin", ":main"]],
    [["push", "origin", "--delete", "main"]],
  ])("forbids a move of a protected branch: %j", (args) => {
    expect(classifyGitCommand("git", args).level).toBe("forbidden");
  });

  it("publishes exactly one remote and one ref, with the upstream flag at most", () => {
    expect(level("git", "push", "origin", "feat/x")).toBe("publish");
    expect(level("git", "push", "-u", "origin", "feat/x")).toBe("publish");
    expect(level("git", "push", "--set-upstream", "origin", "feat/x")).toBe("publish");
    expect(level("git", "push", "origin", "HEAD:feat/x")).toBe("publish");
    expect(level("git", "push", "origin", "HEAD:refs/heads/feat/x")).toBe("publish");
    expect(level("git", "push", "origin", "main:feat/x")).toBe("publish");
  });

  it("reads a combined short flag and a deleting refspec as destructive", () => {
    expect(level("git", "push", "-fu", "origin", "feat/x")).toBe("destructive");
    expect(level("git", "push", "-uf", "origin", "feat/x")).toBe("destructive");
    expect(level("git", "push", "-df", "origin", "feat/x")).toBe("destructive");
    expect(level("git", "push", "-d", "origin", "feat/x")).toBe("destructive");
    expect(level("git", "push", "--force-with-lease", "origin", "feat/x")).toBe("destructive");
    expect(level("git", "push", "--force-with-lease=feat/x:abc", "origin", "feat/x")).toBe(
      "destructive",
    );
    expect(level("git", "push", "origin", "+feat/x")).toBe("destructive");
    expect(level("git", "push", "origin", ":feat/x")).toBe("destructive");
  });
});

describe("options are allowed by name, per subcommand", () => {
  it.each([
    [["fetch", "--upload-pack=touch x", "../other"]],
    [["fetch", "--upload-pack", "touch x", "origin"]],
    [["fetch", "--upl=touch x", "origin"]],
    [["fetch", "../other"]],
    [["fetch", "ext::sh -c touch% x"]],
    [["fetch", "origin", "main:main"]],
    [["fetch", "origin", "+refs/heads/*:refs/heads/*"]],
    [["log", "--output=x.txt"]],
    [["log", "--outp=x.txt"]],
    [["log", "--output", "x.txt"]],
    [["diff", "--output=x.txt"]],
    [["diff", "--no-index", "a", "b"]],
    [["diff", "/etc/passwd", "x"]],
    [["diff", "C:\\Windows\\win.ini", "x"]],
    [["diff", "../outside", "x"]],
    [["show", "--output=x.txt"]],
    [["show", "--ext-diff"]],
    [["log", "--ext-diff", "-p"]],
    [["log", "--textconv", "-p"]],
    [["diff", "-O", "orderfile"]],
    [["diff", "-Oorderfile"]],
    [["blame", "--contents", "x", "y"]],
    [["ls-files", "--exclude-from=/etc/passwd"]],
    [["rev-parse", "--parseopt"]],
    [["status", "--help"]],
    [["log", "--help"]],
    [["pull", "--upload-pack=x", "origin"]],
    [["pull", "origin", "main:main"]],
    [["commit", "-F", "/etc/passwd"]],
    [["commit", "--no-verify", "-m", "x"]],
    [["commit", "--no-ver", "-m", "x"]],
    [["add", "--force", "x"]],
    [["rebase", "--exec", "touch x", "feat/y"]],
    [["rebase", "-x", "touch x", "feat/y"]],
    [["rebase", "--ex=touch x", "feat/y"]],
    [["filter-branch", "--tree-filter", "touch x"]],
    [["update-ref", "--stdin"]],
  ])("refuses %j", (args) => {
    expect(classifyGitCommand("git", args).level).toBe("forbidden");
  });

  it("keeps the ordinary reads free", () => {
    for (const args of [
      ["status", "--short", "--branch"],
      ["log", "--oneline", "-5"],
      ["log", "-n", "5", "--format=%H", "--since=2.days"],
      ["log", "--graph", "--all", "feat/x", "--", "src/a.ts"],
      ["diff", "--stat", "main..feat/x"],
      ["diff", "--cached", "--name-only"],
      ["diff", "-U3", "HEAD~1"],
      ["show", "--stat", "HEAD"],
      ["show", "HEAD:src/a.ts"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["ls-files", "--others", "--exclude-standard"],
      ["blame", "-L", "1,5", "src/a.ts"],
      ["describe", "--tags", "--always"],
      ["fetch", "origin"],
      ["fetch", "--prune", "origin", "feat/x"],
      ["fetch", "--all"],
      ["shortlog", "-sn"],
      ["branch", "--show-current"],
      ["branch", "-avv"],
      ["tag", "--list"],
    ]) {
      expect(classifyGitCommand("git", args).level, args.join(" ")).toBe("free");
    }
  });

  it("keeps gh's reads to their own options", () => {
    expect(level("gh", "pr", "view", "12", "--json", "title")).toBe("free");
    expect(level("gh", "run", "view", "12", "--log-failed")).toBe("free");
    expect(level("gh", "pr", "view", "12", "--web")).toBe("forbidden");
    expect(level("gh", "pr", "list", "--repo", "other/repo")).toBe("forbidden");
  });
});

describe("what discards work is destructive", () => {
  it.each([
    [["checkout", "."]],
    [["checkout", "--", "src/a.ts"]],
    [["checkout", "HEAD~1", "--", "src/a.ts"]],
    [["checkout", "-f", "feat/x"]],
    [["checkout", "feat/x"]],
    [["checkout", "-B", "feat/x"]],
    [["restore", "."]],
    [["restore", "src/a.ts"]],
    [["restore", "--worktree", "--staged", "src/a.ts"]],
    [["restore", "--source=HEAD~1", "src/a.ts"]],
    [["switch", "-f", "feat/x"]],
    [["switch", "--force", "feat/x"]],
    [["switch", "--discard-changes", "feat/x"]],
    [["switch", "-C", "feat/x"]],
    [["rm", "-rf", "."]],
    [["rm", "-fr", "src"]],
    [["rm", "-f", "src/a.ts"]],
    [["rm", "-r", "."]],
    [["stash", "drop"]],
    [["stash", "clear"]],
    [["stash", "pop"]],
    [["reset", "--hard"]],
    [["reset", "--keep", "HEAD~1"]],
    [["reset", "--merge"]],
    [["clean", "-fd"]],
    [["clean", "-n"]],
    [["branch", "-f", "feat/x", "HEAD"]],
    [["branch", "-D", "feat/x"]],
    [["branch", "-M", "feat/x", "feat/y"]],
    [["tag", "-f", "v1"]],
    [["tag", "-d", "v1"]],
    [["mv", "-f", "a", "b"]],
  ])("%j", (args) => {
    expect(classifyGitCommand("git", args).level).toBe("destructive");
  });

  it("leaves what keeps the work local", () => {
    for (const args of [
      ["restore", "--staged", "src/a.ts"],
      ["rm", "--cached", "src/a.ts"],
      ["rm", "src/a.ts"],
      ["switch", "feat/x"],
      ["switch", "-c", "feat/x"],
      ["checkout", "-b", "feat/x"],
      ["stash"],
      ["stash", "push", "-m", "x"],
      ["stash", "list"],
      ["reset", "HEAD~1"],
      ["reset", "--soft", "HEAD~1"],
      ["mv", "a", "b"],
      ["branch", "feat/x"],
      ["branch", "-m", "feat/x", "feat/y"],
      ["tag", "v1"],
      ["add", "-A"],
      ["add", "."],
      ["commit", "-am", "feat: x"],
      ["merge", "--no-ff", "feat/y"],
      ["revert", "--no-edit", "HEAD"],
      ["pull", "--ff-only", "origin", "feat/x"],
    ]) {
      expect(classifyGitCommand("git", args).level, args.join(" ")).toBe("local");
    }
  });
});

describe("no ref move touches a protected branch", () => {
  it.each([
    [["branch", "-f", "main", "HEAD"]],
    [["branch", "-fM", "feat/x", "main"]],
    [["branch", "-m", "main", "old"]],
    [["branch", "-D", "master"]],
    [["branch", "main"]],
    [["branch", "--force", "refs/heads/main", "HEAD"]],
    [["switch", "-c", "main"]],
    [["switch", "-C", "main"]],
    [["checkout", "-b", "main"]],
    [["checkout", "-B", "main"]],
    [["update-ref", "refs/heads/main", "HEAD"]],
    [["update-ref", "-d", "refs/heads/master"]],
  ])("forbids %j", (args) => {
    expect(classifyGitCommand("git", args).level).toBe("forbidden");
  });

  it("forbids moving the branch it stands on when that is protected", () => {
    for (const args of [
      ["commit", "-m", "x"],
      ["merge", "feat/y"],
      ["reset", "--hard", "HEAD~1"],
      ["reset", "HEAD~1"],
      ["revert", "HEAD"],
      ["cherry-pick", "abc"],
      ["pull", "origin", "feat/x"],
      ["rebase", "feat/y"],
    ]) {
      expect(on("main", ...args), args.join(" ")).toBe("forbidden");
      expect(on("master", ...args), args.join(" ")).toBe("forbidden");
    }
    expect(on("main", "log", "--oneline")).toBe("free");
  });

  it("may read a protected branch and merge from it", () => {
    expect(level("git", "merge", "main")).toBe("local");
    expect(level("git", "branch", "--contains", "main")).toBe("free");
    expect(level("git", "log", "main")).toBe("free");
  });
});
