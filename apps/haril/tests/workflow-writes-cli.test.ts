import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateWorkflowSnapshot, type WorkflowSnapshot } from "@haril/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type Harness, harness, makeSandbox, parseJson, type Sandbox } from "./helpers.js";

// `haril workflow start` on a git project (phase F8, docs/modos-y-delegacion.md 3.10): the workflow fixes its base
// branch and commit and writes in worktrees; `haril run` runs it with the fake workflow agents, and `haril workflow show`
// names the integration branch the delegators merged into. --read-only, a folder that is not a repository's top level,
// and a project without git stay read-only.

const HAS_GIT = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;

let sb: Sandbox;
let h: Harness;
let repo: string;
let gitEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  sb = makeSandbox();
  repo = join(sb.root, "project");
  mkdirSync(join(repo, "src"), { recursive: true });
  const globalConfig = join(sb.root, "empty.gitconfig");
  writeFileSync(globalConfig, "");
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dirname(sb.root),
  };
});

afterEach(() => {
  sb.cleanup();
});

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=HARIL test", "-c", "user.email=test@haril.invalid", "-C", repo, ...args],
    { windowsHide: true, encoding: "utf8", env: gitEnv },
  ).trim();
}

function initRepo(): void {
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "src", "index.ts"), "export const ready = true;\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
}

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

async function init(): Promise<void> {
  expect(await invoke(["project", "init", repo, "--name", "Demo", "--slug", "demo", "--yes"])).toBe(
    0,
  );
}

async function queuedStart(): Promise<Record<string, unknown>> {
  expect(await invoke(["status", "--json"])).toBe(0);
  const status = parseJson<{ queuedCommands?: { args?: Record<string, unknown> }[] }>(h.out);
  return status.queuedCommands?.[0]?.args ?? {};
}

describe.skipIf(!HAS_GIT)("haril workflow start on a git project", () => {
  it("fixes main and its commit, lets writers run at once, and says the result goes to an integration branch", async () => {
    initRepo();
    await init();
    // .haril (written by project init) is not committed: the base is main's commit.
    const sha = git("rev-parse", "main");
    expect(
      await invoke(["workflow", "start", "Change it", "--model", "fake/m", "--autonomous"]),
    ).toBe(0);
    expect(h.out.join("\n")).toContain(`writes     in git worktrees from main ${sha.slice(0, 7)}`);
    const args = await queuedStart();
    expect(args).toMatchObject({ baseBranch: "main", baseSha: sha });
    expect((args.limits as { maxConcurrent: { writers: number } }).maxConcurrent.writers).toBe(5);
  });

  it("stays read-only with --read-only, and refuses a --base that does not exist", async () => {
    initRepo();
    await init();
    expect(
      await invoke([
        "workflow",
        "start",
        "Look",
        "--model",
        "fake/m",
        "--autonomous",
        "--read-only",
      ]),
    ).toBe(0);
    expect(h.out.join("\n")).toContain("read-only  the agents write nothing (--read-only)");
    const args = await queuedStart();
    expect(args.baseBranch).toBeUndefined();
    expect(
      await invoke(["workflow", "start", "Look", "--model", "fake/m", "--base", "release"]),
    ).toBe(2);
    expect(h.err.join("\n")).toContain('--base release: no local branch "release"');
  });

  it("stays read-only on a project that is not a git repository", async () => {
    await init();
    expect(await invoke(["workflow", "start", "Look", "--model", "fake/m", "--autonomous"])).toBe(
      0,
    );
    expect(h.out.join("\n")).toMatch(/read-only {2}the agents write nothing/);
    expect((await queuedStart()).baseSha).toBeUndefined();
  });

  it("runs the writing workflow with the fake agents and shows its integration branch", async () => {
    initRepo();
    await init();
    expect(
      await invoke([
        "workflow",
        "start",
        "Write the part [fake:parts=1] [fake:steps=2]",
        "--model",
        "fake/m",
        "--autonomous",
      ]),
    ).toBe(0);
    expect(await invoke(["run"])).toBe(0);
    expect(await invoke(["workflow", "list", "--json"])).toBe(0);
    const [workflow] = parseJson<{ workflowId: string; state: string }[]>(h.out);
    expect(workflow?.state).toBe("completed");
    const workflowId = workflow?.workflowId as string;
    expect(await invoke(["workflow", "show", workflowId, "--json"])).toBe(0);
    const snapshot = parseJson<WorkflowSnapshot>(h.out);
    expect(validateWorkflowSnapshot(snapshot)).toMatchObject({ ok: true });
    expect(snapshot.git).toMatchObject({
      baseBranch: "main",
      integrationBranch: `haril/${workflowId}/integration`,
      merged: 2,
      unmerged: [],
      worktrees: 0,
    });
    expect(await invoke(["workflow", "show", workflowId])).toBe(0);
    expect(h.out.join("\n")).toContain(`branch     haril/${workflowId}/integration (from main`);
    expect(git("show", `haril/${workflowId}/integration:src/part-1/shared.ts`)).toBe(
      "part-1/step-2 attempt 1",
    );
  }, 120_000);
});
