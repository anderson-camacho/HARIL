// Limits of a delegation workflow (docs/modos-y-delegacion.md 3.6 and section 5). Every rule reads them from this
// object, never from a literal, so haril.json can change them (delegation.limits, phase F7: its defaults are these
// values, which a test checks, except the writers: haril.json lets as many write as execute unless it sets them, phase
// F8); a workflow keeps a snapshot taken when it starts.
// Reading L1: the 5 executors and 5 auditors are simultaneous and global per workflow, independent of each other;
// the 5 delegators per orchestrator and 4 executors per delegator are live at once per thread, the rest queue.

export interface DelegationLimits {
  // Children of one thread running at once, by the archetype of the parent thread.
  readonly maxActiveChildren: { readonly orchestrator: number; readonly delegator: number };
  // Children one thread may hold registered and not yet settled (the backlog).
  readonly maxQueuedTasksPerThread: number;
  // Proposals (haril_delegate or haril_assign calls that were applied) per thread.
  readonly maxProposalsPerThread: number;
  // Agents running at once in the workflow, by role; writers are tasks with a non-empty write surface.
  readonly maxConcurrent: {
    readonly executors: number;
    readonly auditors: number;
    readonly delegators: number;
    readonly writers: number;
  };
  // Agents (tasks) created over the whole workflow, continuations and auditors included.
  readonly maxAgentsPerWorkflow: number;
  // Layers below the human: orchestrator 1, delegator 2, executor and auditor 3. Not a key of section 5's JSON;
  // kept here so the depth rule reads a limit like every other rule.
  readonly maxDepth: number;
  readonly maxAuditRetries: number;
  readonly maxEscalationsPerTask: number;
  readonly maxWorkflowTokens: number;
  readonly maxWorkflowWallMs: number;
  // A task with at least this budget counts as large for the quota rule (3.11).
  readonly largeTaskTokens: number;
  readonly attemptTimeoutMs: number;
  // The least an auditor's turn may hold. An auditor gets a third of its executor's budget, but every model call
  // carries the whole context again, so a small third ends the audit before its verdict.
  readonly minAuditorTokens: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = Object.freeze({
  maxActiveChildren: Object.freeze({ orchestrator: 5, delegator: 4 }),
  maxQueuedTasksPerThread: 100,
  maxProposalsPerThread: 3,
  maxConcurrent: Object.freeze({ executors: 5, auditors: 5, delegators: 5, writers: 1 }),
  maxAgentsPerWorkflow: 100,
  maxDepth: 3,
  maxAuditRetries: 1,
  maxEscalationsPerTask: 1,
  maxWorkflowTokens: 20_000_000,
  maxWorkflowWallMs: 7_200_000,
  largeTaskTokens: 50_000,
  attemptTimeoutMs: 3_600_000,
  minAuditorTokens: 60_000,
});

// The token budget of the auditor of an executor with `executorTokens`: a third of it, never below minAuditorTokens.
export function auditorBudgetTokens(
  executorTokens: number,
  limits: Pick<DelegationLimits, "minAuditorTokens">,
): number {
  return Math.max(Math.ceil(executorTokens / 3), limits.minAuditorTokens);
}
