import { ROLE_NAMES } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import {
  checkDelegation,
  classifyGitCommand,
  contextActionOf,
  DEFAULT_DELEGATION_LIMITS,
  type DelegationCaller,
  isSecurityRole,
  mayRoleUseTool,
  roleAccessOf,
  roleTools,
  roleWriteProblem,
} from "../../src/index.js";

const WRITES = { writes: true };
const READ_ONLY_WORKFLOW = { writes: false };

describe("what a role may use, narrowed from its archetype", () => {
  it("keeps every read-only role to read, even in a workflow that writes", () => {
    for (const role of [
      "consultor",
      "seguridad",
      "auditor",
      "consejero",
      "product-owner",
      "vigilante",
    ]) {
      expect(roleTools("executor", role, WRITES)).toEqual(["read"]);
    }
  });

  it("gives the investigador read and the web, nothing else", () => {
    expect(roleTools("executor", "investigador", WRITES)).toEqual(["read", "haril_web"]);
    expect(roleTools("executor", "investigador", READ_ONLY_WORKFLOW)).toEqual([
      "read",
      "haril_web",
    ]);
  });

  it("gives the sintetizador no tools at all", () => {
    expect(roleTools("executor", "sintetizador", WRITES)).toEqual([]);
  });

  it("is the only way to the git tool, and only with a worktree", () => {
    expect(roleTools("executor", "git", WRITES)).toEqual(["read", "haril_git"]);
    expect(roleTools("executor", "git", READ_ONLY_WORKFLOW)).toEqual(["read"]);
    for (const role of ROLE_NAMES.filter((name) => name !== "git")) {
      expect(roleTools("executor", role, WRITES)).not.toContain("haril_git");
    }
  });

  it("lets a documentador write but not run commands", () => {
    expect(roleTools("executor", "documentador", WRITES)).toEqual(["read", "write", "edit"]);
  });

  it("leaves the writers their archetype's tools", () => {
    for (const role of ["disenador", "frontend", "backend", "fixer", "tester", "sanitizador"]) {
      expect(roleTools("executor", role, WRITES)).toEqual(["read", "write", "edit", "haril_run"]);
      expect(roleTools("executor", role, READ_ONLY_WORKFLOW)).toEqual(["read"]);
    }
  });

  it("does not change a turn with no role or with a role nobody defined", () => {
    expect(roleTools("executor", null, WRITES)).toEqual(["read", "write", "edit", "haril_run"]);
    expect(roleTools("executor", "alguien", WRITES)).toEqual([
      "read",
      "write",
      "edit",
      "haril_run",
    ]);
  });

  it("does not narrow a planner or an auditor turn: they decide with their own calls", () => {
    expect(roleTools("delegator", "backend", READ_ONLY_WORKFLOW)).toContain("haril_assign");
    expect(roleTools("auditor", "seguridad", READ_ONLY_WORKFLOW)).toContain("haril_verdict");
  });

  it("answers a tool check with the same list", () => {
    expect(mayRoleUseTool("executor", "consultor", "write", WRITES)).toBe(false);
    expect(mayRoleUseTool("executor", "backend", "write", WRITES)).toBe(true);
  });

  it("names an access for all seventeen roles", () => {
    for (const role of ROLE_NAMES) expect(roleAccessOf(role)).not.toBeNull();
    expect(ROLE_NAMES).toHaveLength(17);
  });
});

describe("where a role may write", () => {
  it("keeps the documentador to documentation", () => {
    expect(roleWriteProblem("documentador", "docs/guia.md")).toBeNull();
    expect(roleWriteProblem("documentador", "README.md")).toBeNull();
    expect(roleWriteProblem("documentador", "packages/core/README.md")).toBeNull();
    expect(roleWriteProblem("documentador", "src/index.ts")).toMatch(/documentador/);
    expect(roleWriteProblem("documentador", "docs/../src/index.ts")).toMatch(/documentador/);
  });

  it("refuses every write for a read-only role", () => {
    expect(roleWriteProblem("consultor", "a.ts")).toMatch(/consultor/);
    expect(roleWriteProblem("sintetizador", "a.ts")).toMatch(/sintetizador/);
  });

  it("leaves a writer to its own write surface", () => {
    expect(roleWriteProblem("backend", "src/api.ts")).toBeNull();
    expect(roleWriteProblem(null, "src/api.ts")).toBeNull();
  });
});

describe("the level of a git action", () => {
  const level = (program: "git" | "gh", ...args: string[]) =>
    classifyGitCommand(program, args).level;

  it("reads as free", () => {
    expect(level("git", "status")).toBe("free");
    expect(level("git", "log", "--oneline", "-5")).toBe("free");
    expect(level("git", "diff", "--stat")).toBe("free");
    expect(level("git", "branch", "--list")).toBe("free");
    expect(level("gh", "pr", "view", "12")).toBe("free");
  });

  it("changes only the worktree as local", () => {
    expect(level("git", "add", "src/a.ts")).toBe("local");
    expect(level("git", "commit", "-m", "feat: x")).toBe("local");
    expect(level("git", "switch", "-c", "feat/x")).toBe("local");
    expect(level("git", "tag", "-a", "v1.0.0", "-m", "x")).toBe("local");
    expect(level("git", "merge", "feat/y")).toBe("local");
  });

  it("publishes", () => {
    expect(level("git", "push", "origin", "feat/x")).toBe("publish");
    expect(level("git", "push", "origin", "v1.0.0")).toBe("publish");
    expect(level("gh", "pr", "create", "--base", "main", "--head", "feat/x")).toBe("publish");
    expect(level("gh", "release", "create", "v1.0.0")).toBe("publish");
  });

  it("calls the rest destructive", () => {
    expect(level("git", "push", "--force", "origin", "feat/x")).toBe("destructive");
    expect(level("git", "push", "origin", "--delete", "feat/x")).toBe("destructive");
    expect(level("git", "reset", "--hard", "HEAD~1")).toBe("destructive");
    expect(level("git", "clean", "-fd")).toBe("destructive");
    expect(level("git", "branch", "-D", "feat/x")).toBe("destructive");
    expect(level("gh", "pr", "close", "12")).toBe("destructive");
  });

  it("never merges to main, whatever the wording", () => {
    expect(level("gh", "pr", "merge", "12")).toBe("forbidden");
    expect(level("git", "push", "origin", "main")).toBe("forbidden");
    expect(level("git", "push", "origin", "HEAD:main")).toBe("forbidden");
    expect(level("git", "push", "origin", "feat/x:refs/heads/master")).toBe("forbidden");
    expect(level("git", "push", "--force", "origin", "main")).toBe("forbidden");
    expect(level("git", "merge", "main")).toBe("local");
    expect(classifyGitCommand("git", ["merge", "feat/y"], "main").level).toBe("forbidden");
    expect(classifyGitCommand("git", ["merge", "feat/y"], "master").level).toBe("forbidden");
    expect(classifyGitCommand("git", ["merge", "feat/y"], "feat/z").level).toBe("local");
  });

  it("refuses what it does not know and any option before the subcommand", () => {
    expect(level("git", "config", "core.hooksPath", "x")).toBe("forbidden");
    expect(level("git", "-c", "core.sshCommand=x", "push")).toBe("forbidden");
    expect(level("git")).toBe("forbidden");
    expect(level("gh", "api", "repos/x")).toBe("forbidden");
  });
});

describe("what a role does when its context fills", () => {
  it("starts a new agent for a role whose state is in its worktree, and compacts the rest", () => {
    expect(contextActionOf("backend")).toBe("new_agent");
    expect(contextActionOf("tester")).toBe("new_agent");
    expect(contextActionOf("consultor")).toBe("compact");
    expect(contextActionOf(null)).toBe("compact");
  });
});

describe("the security role", () => {
  it("is known", () => {
    expect(isSecurityRole("seguridad")).toBe(true);
    expect(isSecurityRole("auditor")).toBe(false);
  });
});

describe("a proposal with roles", () => {
  const caller: DelegationCaller = { threadId: "t", archetype: "delegator", depth: 2 };
  const state = {
    workflow: {
      state: "running" as const,
      agentsCreated: 1,
      tokensCommitted: 0,
      autonomy: { mode: "autonomous" as const, stops: [] },
    },
    thread: { queuedChildren: 0, proposals: 0 },
    models: {
      catalog: [],
      allow: {},
      pinned: {},
      quota: {},
      table: { classes: {} as never, models: {} },
      stats: {},
      policy: { switchAtPercent5h: 80, stopAtPercentWeekly: 90 } as never,
      now: 0,
      largeTaskTokens: 50_000,
    },
  };
  const child = (localId: string, role: string | null, write: readonly string[] = []) => ({
    localId,
    dependsOn: [],
    difficulty: "easy" as const,
    budgetTokens: 10_000,
    model: null,
    ...(role === null ? {} : { role }),
    writeSurface: write,
  });
  const check = (...children: ReturnType<typeof child>[]) =>
    checkDelegation(
      { tool: "haril_assign", caller, children, checkpoints: [] },
      state,
      DEFAULT_DELEGATION_LIMITS,
    );

  it("refuses a role that does not exist, with the names it could use", () => {
    const result = check(child("a", "programador"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("unknown_role");
    expect(result.issues[0]?.message).toContain("consultor");
  });

  it("refuses a write surface for a role that cannot write", () => {
    const result = check(child("a", "consultor", ["src/**"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("role_cannot_write");
  });

  it("accepts a writer's surface and a step with no role", () => {
    expect(check(child("a", "backend", ["src/**"])).ok).toBe(true);
    expect(check(child("a", null, ["src/**"])).ok).toBe(true);
  });
});
