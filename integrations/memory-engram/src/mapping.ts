// How a ScopeRef and a MemoryKind map to Engram's fields (ADR-0008 D6.1, D6.9; MEMORY.md 5.1, 5.3; ARCH 8.2).
// project: the projectKey is the ProjectId and the reserved _knowledge key is just another key [S] (MH-03); the
// workspaceId (the StoreId) is prefixed, because the contract suite keeps two workspaces apart inside one provider
// (MP-09) and Engram's project is only a label inside one SQLite file (06 sec3.7). scope: the visibility, as Engram
// keeps it (06 sec3.6). type: the kind, with convention as Engram's policy (MEMORY.md 5.3). session_id: HARIL's.
// That Engram keeps such a project name byte-exact is NOT VERIFIED (06:1, MC-T6).
import type { MemoryKind, MemoryReadKind, Visibility } from "@haril/contracts";

const ENGRAM_TYPE: Readonly<Record<MemoryKind, string>> = {
  decision: "decision",
  convention: "policy",
  preference: "preference",
  discovery: "discovery",
  pattern: "pattern",
  architecture: "architecture",
  bugfix: "bugfix",
  run_summary: "run_summary",
};

const KINDS = Object.keys(ENGRAM_TYPE) as MemoryKind[];

// The separator of the workspace and the project key; a workspaceId never contains it (a StoreId is a ULID), and the
// adapter refuses one that does, so two scopes never share an Engram project.
export const PROJECT_SEPARATOR = ":";

export interface ProjectOwner {
  readonly workspaceId: string;
  readonly projectKey: string;
}

export function engramProject(owner: ProjectOwner): string {
  return `${owner.workspaceId}${PROJECT_SEPARATOR}${owner.projectKey}`;
}

// The owner of an Engram project HARIL named; undefined for one it did not.
export function ownerOf(project: string): ProjectOwner | undefined {
  const at = project.indexOf(PROJECT_SEPARATOR);
  if (at <= 0 || at === project.length - 1) return undefined;
  return { workspaceId: project.slice(0, at), projectKey: project.slice(at + 1) };
}

export function engramTypeOf(kind: MemoryKind): string {
  return ENGRAM_TYPE[kind];
}

// The kind of an Engram type: open when reading (memory.md 3.3), so a type HARIL does not write is "unknown".
export function kindOfType(type: string): MemoryReadKind {
  const written = KINDS.find((kind) => ENGRAM_TYPE[kind] === type);
  if (written !== undefined) return written;
  return KINDS.find((kind) => kind === type) ?? "unknown";
}

// The kinds a read may return: the scope's kind and the query's kinds narrow them; undefined is every kind and an
// empty list is none (the two narrow to nothing).
export function kindsOf(
  scopeKind: string | undefined,
  kinds: readonly MemoryKind[] | undefined,
): readonly MemoryKind[] | undefined {
  return scopeKind === undefined ? kinds : (kinds ?? KINDS).filter((kind) => kind === scopeKind);
}

// The Engram types of those kinds, one request each; undefined is one request without a type.
export function typesOf(kinds: readonly MemoryKind[] | undefined): readonly string[] | undefined {
  return kinds === undefined ? undefined : [...new Set(kinds.map(engramTypeOf))];
}

// Engram's normalizeScope keeps personal and global; anything else is project (06 sec3.6).
export function visibilityOf(scope: string): Visibility {
  return scope === "personal" || scope === "global" ? scope : "project";
}
