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

// The folders and names that configure agents, builds or CI, whatever they hold.
const NEVER_DOCS_FOLDERS = new Set([".git", ".github", ".claude"]);
const NEVER_DOCS_FILES = new Set(["agents.md", "claude.md"]);

// A closed list: docs/ and versions/ at the root, and a README or CHANGELOG anywhere else. An extension alone proves
// nothing: requirements.txt and CMakeLists.txt are text files.
function isDocsPath(path: string): boolean {
  const normal = path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  if (normal.startsWith("/") || normal.includes(":")) return false;
  const parts = normal.split("/");
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  if (name === "" || NEVER_DOCS_FILES.has(name)) return false;
  if (parts.some((part) => part === ".." || NEVER_DOCS_FOLDERS.has(part.toLowerCase())))
    return false;
  if (parts.length > 1 && (parts[0] === "docs" || parts[0] === "versions")) return true;
  return /^(readme|changelog)(\.(md|mdx|rst|txt))?$/.test(name);
}

// Why this role may not write this path; null when its write surface alone decides.
export function roleWriteProblem(role: string | null | undefined, path: string): string | null {
  const access = roleAccessOf(role);
  if (access === null || access === "worktree") return null;
  if (access === "docs") {
    return isDocsPath(path)
      ? null
      : `the documentador writes under docs/ and versions/ and README or CHANGELOG files only: ${path} is not one`;
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
