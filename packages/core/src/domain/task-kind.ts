import type { TaskKindRuleResult } from "../ports/index.js";

// Agents that answer a plan task (LD-T4, AGENTS.md 3.1-3.2): the planner archetype, which reads and proposes a plan
// through haril_propose_plan, and fake:plan, its hermetic stand-in. They run plan tasks only, and a plan task runs only
// on one of them.
export const PLANNER_AGENT_REFS: readonly string[] = ["planner", "fake:plan"];

export function isPlannerAgent(agentRef: string): boolean {
  return PLANNER_AGENT_REFS.includes(agentRef);
}

// The kind of a new task against its agent. Absent means work. verify and summarize have no agent of their own yet, so
// only a plan creates them. Pure.
export function checkTaskKind(kind: unknown, agentRef: string): TaskKindRuleResult {
  const value = kind === undefined ? "work" : kind;
  if (value !== "work" && value !== "plan") {
    return { ok: false, reason: 'task kind must be "work" or "plan"' };
  }
  if (value === "plan" && !isPlannerAgent(agentRef)) {
    return {
      ok: false,
      reason: `a plan task needs a planner agent (${PLANNER_AGENT_REFS.join(" or ")}); got "${agentRef}"`,
    };
  }
  if (value === "work" && isPlannerAgent(agentRef)) {
    return { ok: false, reason: `agent "${agentRef}" runs only plan tasks (kind "plan")` };
  }
  return { ok: true, kind: value };
}
