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
import { addWorktree } from "@haril/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  };
}

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
