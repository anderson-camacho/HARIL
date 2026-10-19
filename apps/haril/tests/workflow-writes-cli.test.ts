import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateWorkflowSnapshot, type WorkflowSnapshot } from "@haril/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { storeAccess } from "../src/host.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  type Sandbox,
  withWorkflowIntake,
} from "./helpers.js";

// Real git and real processes: under the load of the full suite one test can take several seconds, so this file gives
// its tests and hooks a minute instead of the suite's 15 s (a hang still fails it).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// `haril workflow start` on a git project (phase F8, docs/modos-y-delegacion.md 3.10): the workflow fixes its base
// branch and commit and writes in worktrees; `haril run` runs it with the fake workflow agents, and `haril workflow show`
// names the integration branch the delegators merged into. --read-only, a folder that is not a repository's top level,
// and a project without git is refused unless consultation was explicitly requested.

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
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
}

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(withWorkflowIntake(sb, repo, args), h.io, sb.host);
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

  it("keeps the writers haril.json sets, and else lets as many write as the executors", async () => {
    initRepo();
    const configPath = join(sb.root, "haril.json");
    sb = { ...sb, host: { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: configPath } } };
    await init();
    const writersOf = async (): Promise<number> => {
      expect(await invoke(["status", "--json"])).toBe(0);
      const status = parseJson<{ queuedCommands?: { args?: Record<string, unknown> }[] }>(h.out);
      const last = status.queuedCommands?.[status.queuedCommands.length - 1]?.args ?? {};
      return (last.limits as { maxConcurrent: { writers: number } }).maxConcurrent.writers;
    };
    writeFileSync(
      configPath,
      JSON.stringify({ delegation: { limits: { maxConcurrent: { executors: 4, writers: 2 } } } }),
    );
    expect(await invoke(["workflow", "start", "One", "--model", "fake/m", "--autonomous"])).toBe(0);
    expect(await writersOf()).toBe(2);
    writeFileSync(
      configPath,
      JSON.stringify({ delegation: { limits: { maxConcurrent: { executors: 3 } } } }),
    );
    expect(await invoke(["workflow", "start", "Two", "--model", "fake/m", "--autonomous"])).toBe(0);
    expect(await writersOf()).toBe(3);
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

  it("refuses an implementation without Git instead of silently queueing consultation", async () => {
    await init();
    expect(await invoke(["workflow", "start", "Look", "--model", "fake/m", "--autonomous"])).toBe(
      2,
    );
    expect(h.err.join("\n")).toMatch(/implementation.*git|git.*implementation/i);
    expect(await invoke(["workflow", "list", "--json"])).toBe(0);
    expect(parseJson<unknown[]>(h.out)).toEqual([]);
  });

  it("allows explicit read-only consultation without Git and reports its mode in JSON", async () => {
    await init();
    expect(
      await invoke(["workflow", "start", "Look", "--model", "fake/m", "--read-only", "--json"]),
    ).toBe(0);
    expect(parseJson<{ mode: string; capabilities: { writing: boolean } }>(h.out)).toMatchObject({
      mode: "read-only",
      capabilities: { writing: false },
    });
    expect((await queuedStart()).baseSha).toBeUndefined();
  });

  it("refuses implementation when the allowlist has no usable test command", async () => {
    initRepo();
    const configPath = join(sb.root, "haril.json");
    writeFileSync(
      configPath,
      JSON.stringify({ delegation: { commands: { allow: ["node --version"] } } }),
    );
    sb = { ...sb, host: { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: configPath } } };
    await init();
    expect(await invoke(["workflow", "start", "Write", "--model", "fake/m"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/test command.*allow|allow.*test command/i);
    expect(await invoke(["workflow", "list", "--json"])).toBe(0);
    expect(parseJson<unknown[]>(h.out)).toEqual([]);
  });

  it("does not treat an allowed package command as a test without a test script", async () => {
    initRepo();
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ scripts: { build: "node --version" } }),
    );
    await init();
    expect(await invoke(["workflow", "start", "Write", "--model", "fake/m"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/test command/);
  });

  it("reports checked preflight capabilities without queueing a command", async () => {
    initRepo();
    await init();
    expect(
      await invoke(["workflow", "start", "Write", "--model", "fake/m", "--preflight", "--json"]),
    ).toBe(0);
    expect(
      parseJson<{
        mode: string;
        capabilities: {
          writing: boolean;
          worktreeList: boolean;
          testCommand: string;
          testsRun: boolean;
        };
      }>(h.out),
    ).toMatchObject({
      mode: "implementation",
      capabilities: { writing: true, worktreeList: true, testCommand: "npm test", testsRun: false },
    });
    expect(await invoke(["workflow", "list", "--json"])).toBe(0);
    expect(parseJson<unknown[]>(h.out)).toEqual([]);
  });

  it("runs the writing workflow with the fake agents and shows its integration branch", async () => {
    initRepo();
    await init();
    expect(
      await invoke([
        "workflow",
        "start",
        "Write the part [fake:parts=1] [fake:steps=2] [fake:run=npm test]",
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

  it("runs the auditors' commands with haril.json's allow list", async () => {
    initRepo();
    // The auditor must run the project test command through the configured allow list.
    const configPath = join(sb.root, "haril.json");
    writeFileSync(
      configPath,
      JSON.stringify({ delegation: { commands: { allow: ["node --version", "npm test"] } } }),
    );
    sb = { ...sb, host: { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: configPath } } };
    await init();
    expect(
      await invoke([
        "workflow",
        "start",
        "Write the part [fake:parts=1] [fake:steps=1] [fake:run=npm test]",
        "--model",
        "fake/m",
        "--autonomous",
      ]),
    ).toBe(0);
    expect(await invoke(["run"])).toBe(0);
    const store = storeAccess(sb.host).open(sb.dataDir);
    try {
      const commands = store.events
        .list()
        .filter((event) => event.type === "workspace.command")
        .map((event) => event.payload as { command?: unknown; exitCode?: unknown });
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((payload) => payload.command === "npm" && payload.exitCode === 0)).toBe(
        true,
      );
      expect(store.workflows.list()[0]?.state).toBe("completed");
    } finally {
      store.close();
    }
  }, 120_000);

  it("takes the base branch from --base, else haril.json's git.baseBranch, else detects it", async () => {
    initRepo();
    git("branch", "release");
    const configPath = join(sb.root, "haril.json");
    writeFileSync(configPath, JSON.stringify({ delegation: { git: { baseBranch: "release" } } }));
    sb = { ...sb, host: { ...sb.host, env: { ...sb.host.env, HARIL_CONFIG: configPath } } };
    await init();
    const sha = git("rev-parse", "release");
    expect(await invoke(["workflow", "start", "One", "--model", "fake/m", "--autonomous"])).toBe(0);
    expect(h.out.join("\n")).toContain(
      `writes     in git worktrees from release ${sha.slice(0, 7)}`,
    );
    expect(
      await invoke([
        "workflow",
        "start",
        "Two",
        "--model",
        "fake/m",
        "--autonomous",
        "--base",
        "main",
      ]),
    ).toBe(0);
    expect(h.out.join("\n")).toContain("writes     in git worktrees from main");
    // A configured branch the repository lacks stops the start: HARIL never picks another base on its own.
    writeFileSync(configPath, JSON.stringify({ delegation: { git: { baseBranch: "stable" } } }));
    expect(await invoke(["workflow", "start", "Three", "--model", "fake/m", "--autonomous"])).toBe(
      2,
    );
    expect(h.err.join("\n")).toContain(
      'delegation.git.baseBranch "stable": no local branch "stable"',
    );
    // --read-only does not need a base.
    expect(
      await invoke([
        "workflow",
        "start",
        "Four",
        "--model",
        "fake/m",
        "--autonomous",
        "--read-only",
      ]),
    ).toBe(0);
  });
});
