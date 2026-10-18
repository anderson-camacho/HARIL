import type { DelegationToolName, TaskKind } from "@haril/contracts";

// Agent archetypes of the three-layer delegation (docs/modos-y-delegacion.md 3.4). They reuse the closed task kinds
// (adding a kind needs an ADR): the orchestrator and the delegator run plan tasks, the executor runs work and the
// auditor runs verify. The auditor sits in layer 3 next to the executor it reviews.

export const DELEGATION_ARCHETYPES = ["orchestrator", "delegator", "executor", "auditor"] as const;
export type DelegationArchetype = (typeof DELEGATION_ARCHETYPES)[number];

// The tools the bridge may register for an agent: Pi's read/write/edit plus the delegation tools.
export type AgentTool = "read" | "write" | "edit" | DelegationToolName;

export interface ArchetypeSpec {
  readonly layer: 1 | 2 | 3;
  readonly taskKind: TaskKind;
  // Tools before agents may write (phases F1 to F7).
  readonly tools: readonly AgentTool[];
  // Tools added when writing is enabled (phase F8: worktrees, surface locks and integration).
  readonly writeTools: readonly AgentTool[];
  // The archetypes it may propose. The Core adds one auditor per executor on its own (3.5), and the final auditor on
  // haril_request_audit, so no archetype proposes an auditor.
  readonly children: readonly DelegationArchetype[];
}

export const ARCHETYPES: Readonly<Record<DelegationArchetype, ArchetypeSpec>> = Object.freeze({
  orchestrator: Object.freeze({
    layer: 1,
    taskKind: "plan",
    tools: Object.freeze(["read", "haril_delegate", "haril_request_audit", "haril_abort"] as const),
    writeTools: Object.freeze([] as const),
    children: Object.freeze(["delegator"] as const),
  }),
  // R-D6: the delegator may check for itself with a read-only haril_run; the automatic auditor still always runs.
  delegator: Object.freeze({
    layer: 2,
    taskKind: "plan",
    tools: Object.freeze(["read", "haril_assign", "haril_report", "haril_run"] as const),
    writeTools: Object.freeze(["haril_merge"] as const),
    children: Object.freeze(["executor"] as const),
  }),
  executor: Object.freeze({
    layer: 3,
    taskKind: "work",
    tools: Object.freeze(["read"] as const),
    writeTools: Object.freeze(["write", "edit", "haril_run"] as const),
    children: Object.freeze([] as const),
  }),
  auditor: Object.freeze({
    layer: 3,
    taskKind: "verify",
    tools: Object.freeze(["read", "haril_run", "haril_verdict"] as const),
    writeTools: Object.freeze([] as const),
    children: Object.freeze([] as const),
  }),
});

// The child archetype each proposing tool creates.
const PROPOSED_CHILD: Partial<Record<DelegationToolName, DelegationArchetype>> = {
  haril_delegate: "delegator",
  haril_assign: "executor",
};

export interface ToolOptions {
  // True once agents may write (F8); until then the write tools are never registered.
  readonly writes: boolean;
}

export function isDelegationArchetype(value: string): value is DelegationArchetype {
  return (DELEGATION_ARCHETYPES as readonly string[]).includes(value);
}

export function archetypeTools(
  archetype: DelegationArchetype,
  options: ToolOptions,
): readonly AgentTool[] {
  const spec = ARCHETYPES[archetype];
  return options.writes ? [...spec.tools, ...spec.writeTools] : spec.tools;
}

export function mayUseTool(
  archetype: DelegationArchetype,
  tool: AgentTool,
  options: ToolOptions,
): boolean {
  return archetypeTools(archetype, options).includes(tool);
}

export function childArchetypeOf(tool: DelegationToolName): DelegationArchetype | null {
  return PROPOSED_CHILD[tool] ?? null;
}

export type ArchetypeTaskKindResult =
  | { readonly ok: true; readonly kind: TaskKind }
  | { readonly ok: false; readonly reason: string };

// checkTaskKind generalized (3.4): the task kind must be the one the archetype runs.
export function checkArchetypeTaskKind(
  archetype: DelegationArchetype,
  kind: unknown,
): ArchetypeTaskKindResult {
  const expected = ARCHETYPES[archetype].taskKind;
  if (kind === expected) return { ok: true, kind: expected };
  return {
    ok: false,
    reason: `the ${archetype} archetype runs tasks of kind "${expected}"; got ${JSON.stringify(kind ?? null)}`,
  };
}
