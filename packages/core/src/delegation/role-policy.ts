import { isRoleName, type RoleName } from "@haril/contracts";
import { type AgentTool, archetypeTools, type DelegationArchetype } from "./archetypes.js";

// What each of the 17 roles may touch (feature haril-factory, F7). A role never widens its archetype: it narrows the tool
// list of an executor turn, and that narrowed list is what the bridge registers, what the handshake (checkHandshake)
// expects and what the host accepts, so a role that may not write is refused in code, whatever its prompt says. Planners
// and auditors keep their archetype's tools: they decide their turn with those calls, and none of them writes source.
// Pure: no I/O.

export type RoleAccess =
  // Reads only.
  | "read_only"
  // Reads, and the web.
  | "read_web"
  // Answers from what its prompt carries.
  | "no_tools"
  // Writes inside its own worktree and write surface, and runs the allowed commands.
  | "worktree"
  // Writes documentation only.
  | "docs"
  // The only role with the git tool.
  | "git";

const ROLE_ACCESS: Readonly<Record<RoleName, RoleAccess>> = Object.freeze({
  arquitecto: "read_only",
  sintetizador: "no_tools",
  auditor: "read_only",
  seguridad: "read_only",
  consejero: "read_only",
  "product-owner": "read_only",
  backend: "worktree",
  frontend: "worktree",
  disenador: "worktree",
  tester: "worktree",
  fixer: "worktree",
  investigador: "read_web",
  consultor: "read_only",
  sanitizador: "worktree",
  documentador: "docs",
  git: "git",
  vigilante: "read_only",
});

// null: no role, or a name no profile defines (checkDelegation refuses the second in a new proposal).
export function roleAccessOf(role: string | null | undefined): RoleAccess | null {
  return typeof role === "string" && isRoleName(role) ? ROLE_ACCESS[role] : null;
}

function narrowed(access: RoleAccess, writes: boolean, base: readonly AgentTool[]) {
  switch (access) {
    case "worktree":
      return base;
    case "read_only":
      return ["read"] satisfies AgentTool[];
    case "read_web":
      return ["read", "haril_web"] satisfies AgentTool[];
    case "no_tools":
      return [] satisfies AgentTool[];
    case "docs":
      return (writes ? ["read", "write", "edit"] : ["read"]) satisfies AgentTool[];
    case "git":
      return (writes ? ["read", "haril_git"] : ["read"]) satisfies AgentTool[];
  }
}

// The single source of what a turn is offered, on top of archetypeTools.
export function roleTools(
  archetype: DelegationArchetype,
  role: string | null | undefined,
  options: { readonly writes: boolean },
): readonly AgentTool[] {
  const base = archetypeTools(archetype, options);
  const access = roleAccessOf(role);
  if (access === null || archetype !== "executor") return base;
  return narrowed(access, options.writes, base);
}

export function mayRoleUseTool(
  archetype: DelegationArchetype,
  role: string | null | undefined,
  tool: AgentTool,
  options: { readonly writes: boolean },
): boolean {
  return roleTools(archetype, role, options).includes(tool);
}

export function roleMayWrite(role: string | null | undefined): boolean {
  const access = roleAccessOf(role);
  return access === null || access === "worktree" || access === "docs";
}

function isDocsPath(path: string): boolean {
  const normal = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normal.split("/").includes("..")) return false;
  const name = normal.split("/").pop() ?? "";
  return normal.startsWith("docs/") || /\.(md|mdx|rst|txt)$/i.test(name);
}

// Why this role may not write this path; null when its write surface alone decides.
export function roleWriteProblem(role: string | null | undefined, path: string): string | null {
  const access = roleAccessOf(role);
  if (access === null || access === "worktree") return null;
  if (access === "docs") {
    return isDocsPath(path)
      ? null
      : `the documentador writes documentation only (docs/ and text files): ${path} is not one`;
  }
  return `the ${String(role)} role is read-only: it may not write ${path}`;
}

// What a role does when its context passes its threshold (context.perLayer): a role whose work lives in its worktree
// continues best as a new agent that reads it; the rest lose nothing by compacting.
export function contextActionOf(role: string | null | undefined): "compact" | "new_agent" {
  return roleAccessOf(role) === "worktree" ? "new_agent" : "compact";
}

export function isSecurityRole(role: string | null | undefined): boolean {
  return role === "seguridad";
}

// The levels of a git action. A person answers every publish and destructive one; a forbidden one never runs.
export const GIT_LEVELS = ["free", "local", "publish", "destructive"] as const;
export type GitLevel = (typeof GIT_LEVELS)[number];

export type GitClassification =
  | { readonly level: GitLevel }
  | { readonly level: "forbidden"; readonly why: string };

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const FREE_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "blame",
  "describe",
  "fetch",
  "shortlog",
]);
const LOCAL_GIT = new Set([
  "add",
  "commit",
  "switch",
  "mv",
  "rm",
  "restore",
  "stash",
  "cherry-pick",
  "revert",
  "pull",
]);
const DESTRUCTIVE_GIT = new Set(["clean", "rebase", "filter-branch", "update-ref", "gc", "prune"]);
const FREE_GH: readonly (readonly [string, string])[] = [
  ["pr", "view"],
  ["pr", "list"],
  ["pr", "status"],
  ["pr", "checks"],
  ["pr", "diff"],
  ["run", "list"],
  ["run", "view"],
  ["release", "list"],
  ["release", "view"],
];
const PUBLISH_GH: readonly (readonly [string, string])[] = [
  ["pr", "create"],
  ["pr", "edit"],
  ["pr", "comment"],
  ["release", "create"],
];
const DESTRUCTIVE_GH: readonly (readonly [string, string])[] = [
  ["pr", "close"],
  ["release", "delete"],
  ["repo", "delete"],
];

function forbidden(why: string): GitClassification {
  return { level: "forbidden", why };
}

function pushesProtected(args: readonly string[]): boolean {
  const positional = args.filter((arg) => !arg.startsWith("-"));
  return positional.slice(1).some((refspec) => {
    const target = (refspec.split(":").pop() ?? "")
      .replace(/^\+/, "")
      .replace(/^refs\/heads\//, "");
    return PROTECTED_BRANCHES.has(target);
  });
}

function classifyPush(args: readonly string[]): GitClassification {
  if (pushesProtected(args)) return forbidden("nothing is pushed to main or master by an agent");
  const removes = args.some((arg) => arg === "--delete" || arg === "-d");
  const forces = args.some(
    (arg) =>
      arg === "--force" ||
      arg === "-f" ||
      arg.startsWith("--force-with-lease") ||
      arg === "--mirror" ||
      arg === "--prune" ||
      /^\+/.test(arg),
  );
  return { level: removes || forces ? "destructive" : "publish" };
}

function classifyBranch(args: readonly string[]): GitClassification {
  if (args.some((arg) => arg === "-D" || arg === "-d" || arg === "--delete")) {
    return { level: "destructive" };
  }
  const positional = args.filter((arg) => !arg.startsWith("-"));
  return { level: positional.length === 0 ? "free" : "local" };
}

function classifyTag(args: readonly string[]): GitClassification {
  if (args.some((arg) => arg === "-d" || arg === "--delete")) return { level: "destructive" };
  const positional = args.filter((arg) => !arg.startsWith("-"));
  return { level: positional.length === 0 && !args.includes("-a") ? "free" : "local" };
}

function classifyGit(args: readonly string[], currentBranch: string | null): GitClassification {
  const [sub, ...rest] = args;
  if (sub === undefined || sub.startsWith("-")) {
    return forbidden("a git action starts with its subcommand; an option before it is refused");
  }
  if (FREE_GIT.has(sub)) return { level: "free" };
  if (sub === "push") return classifyPush(rest);
  if (sub === "branch") return classifyBranch(rest);
  if (sub === "tag") return classifyTag(rest);
  if (sub === "reset") return { level: rest.includes("--hard") ? "destructive" : "local" };
  if (sub === "checkout") {
    return { level: rest.includes("--") || rest.includes("-f") ? "destructive" : "local" };
  }
  if (sub === "merge") {
    if (currentBranch !== null && PROTECTED_BRANCHES.has(currentBranch)) {
      return forbidden(`nothing is merged into ${currentBranch} by an agent`);
    }
    return { level: "local" };
  }
  if (LOCAL_GIT.has(sub)) return { level: "local" };
  if (DESTRUCTIVE_GIT.has(sub)) return { level: "destructive" };
  return forbidden(`git ${sub} is not on the git role's list`);
}

function matchesGh(args: readonly string[], list: readonly (readonly [string, string])[]): boolean {
  return list.some(([group, action]) => args[0] === group && args[1] === action);
}

function classifyGh(args: readonly string[]): GitClassification {
  if (args[0] === "pr" && args[1] === "merge") {
    return forbidden("a pull request is merged by a person, never by an agent");
  }
  if (matchesGh(args, FREE_GH)) return { level: "free" };
  if (matchesGh(args, PUBLISH_GH)) return { level: "publish" };
  if (matchesGh(args, DESTRUCTIVE_GH)) return { level: "destructive" };
  return forbidden(`gh ${args.slice(0, 2).join(" ")} is not on the git role's list`);
}

// `currentBranch`: where the worktree stands now, when known. A closed list: what it does not name is refused.
export function classifyGitCommand(
  program: "git" | "gh",
  args: readonly string[],
  currentBranch: string | null = null,
): GitClassification {
  return program === "git" ? classifyGit(args, currentBranch) : classifyGh(args);
}
