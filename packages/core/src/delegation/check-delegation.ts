import type {
  AssignInput,
  CheckpointRequest,
  DelegateInput,
  DelegationToolName,
  Difficulty,
  WorkflowState,
} from "@haril/contracts";
import {
  ARCHETYPES,
  childArchetypeOf,
  type DelegationArchetype,
  mayUseTool,
} from "./archetypes.js";
import { type AutonomySettings, changeStops, checkpointChange } from "./checkpoints.js";
import { chooseModel, type ModelRejection, type ModelSelectionContext } from "./choose-model.js";
import { surfacesMayOverlap } from "./globs.js";
import type { DelegationLimits } from "./limits.js";

// Validation of a delegation proposal (docs/modos-y-delegacion.md 3.6). Agents propose through haril_delegate and
// haril_assign; this pure rule decides, and only an accepted proposal reaches the Runtime, which creates the tasks.
// Every limit comes from DelegationLimits. Problems carry a reason the agent can act on: it corrects its call and
// tries again in the same turn, as with haril_propose_plan.

export interface DelegationCaller {
  readonly threadId: string;
  readonly archetype: DelegationArchetype;
  // The caller's depth: 1 for the orchestrator, 2 for a delegator. Its children sit at depth + 1.
  readonly depth: number;
}

export interface ProposedChild {
  readonly localId: string;
  readonly dependsOn: readonly string[];
  readonly difficulty: Difficulty;
  readonly budgetTokens: number;
  readonly model: string | null;
  readonly writeSurface: readonly string[];
}

export interface DelegationProposal {
  readonly tool: DelegationToolName;
  readonly caller: DelegationCaller;
  readonly children: readonly ProposedChild[];
  readonly checkpoints: readonly CheckpointRequest[];
}

export interface DelegationState {
  readonly workflow: {
    readonly state: WorkflowState;
    readonly agentsCreated: number;
    // Sum of the token budgets already granted to tasks of this workflow.
    readonly tokensCommitted: number;
    readonly autonomy: AutonomySettings;
  };
  // The calling thread.
  readonly thread: {
    // Children it registered that have not settled yet.
    readonly queuedChildren: number;
    // Proposals of this thread that were applied.
    readonly proposals: number;
  };
  readonly models: ModelSelectionContext;
}

export type DelegationIssueCode =
  | "workflow_not_running"
  | "tool_not_allowed"
  | "too_deep"
  | "too_many_proposals"
  | "too_many_queued"
  | "workflow_agent_cap"
  | "workflow_token_cap"
  | "duplicate_task_id"
  | "unknown_dependency"
  | "cycle"
  | ModelRejection
  | "checkpoint_removes_stop";

export interface DelegationIssue {
  readonly code: DelegationIssueCode;
  readonly message: string;
  readonly localId?: string;
  // For cycle: the local ids along the cycle, the first repeated at the end.
  readonly path?: readonly string[];
}

// A dependency the Core adds so two siblings with overlapping write surfaces run in sequence (3.10). Not an error.
export interface Serialization {
  readonly localId: string;
  readonly after: string;
}

export type DelegationCheck =
  | {
      readonly ok: true;
      readonly childArchetype: DelegationArchetype;
      // Tasks the Runtime will create: the children, one auditor per executor and the caller's continuation.
      readonly agentsToCreate: number;
      readonly tokensToCommit: number;
      readonly serialize: readonly Serialization[];
      // The workflow's autonomy with the stops the proposal added.
      readonly autonomy: AutonomySettings;
    }
  | { readonly ok: false; readonly issues: readonly DelegationIssue[] };

export function proposalFromDelegate(
  caller: DelegationCaller,
  input: DelegateInput,
): DelegationProposal {
  return {
    tool: "haril_delegate",
    caller,
    children: input.delegations.map((delegation) => ({
      localId: delegation.localId,
      dependsOn: delegation.dependsOn,
      difficulty: delegation.difficulty,
      budgetTokens: delegation.budget.maxTokens,
      model: delegation.model ?? null,
      writeSurface: [],
    })),
    checkpoints: input.checkpoints ?? [],
  };
}

export function proposalFromAssign(
  caller: DelegationCaller,
  input: AssignInput,
): DelegationProposal {
  return {
    tool: "haril_assign",
    caller,
    children: input.assignments.map((assignment) => ({
      localId: assignment.localId,
      dependsOn: assignment.dependsOn,
      difficulty: assignment.difficulty,
      budgetTokens: assignment.budget.maxTokens,
      model: assignment.model ?? null,
      writeSurface: assignment.files.write,
    })),
    checkpoints: [],
  };
}

export function checkDelegation(
  proposal: DelegationProposal,
  state: DelegationState,
  limits: DelegationLimits,
): DelegationCheck {
  const gate = gateIssue(proposal, state, limits);
  if (gate !== null) return { ok: false, issues: [gate] };
  const childArchetype = childArchetypeOf(proposal.tool) as DelegationArchetype;
  const { children } = proposal;
  const issues: DelegationIssue[] = [];

  if (state.thread.proposals + 1 > limits.maxProposalsPerThread) {
    issues.push({
      code: "too_many_proposals",
      message: `this thread already made ${state.thread.proposals} proposals; the limit is ${limits.maxProposalsPerThread}`,
    });
  }
  if (state.thread.queuedChildren + children.length > limits.maxQueuedTasksPerThread) {
    issues.push({
      code: "too_many_queued",
      message: `this thread has ${state.thread.queuedChildren} unsettled children; ${children.length} more would pass the limit of ${limits.maxQueuedTasksPerThread}`,
    });
  }
  // Executors come with their auditor; every proposal also creates the caller's continuation (3.5, 3.7).
  const perChild = childArchetype === "executor" ? 2 : 1;
  const agentsToCreate = children.length * perChild + 1;
  if (state.workflow.agentsCreated + agentsToCreate > limits.maxAgentsPerWorkflow) {
    issues.push({
      code: "workflow_agent_cap",
      message: `the workflow created ${state.workflow.agentsCreated} agents; this proposal adds ${agentsToCreate} and the limit is ${limits.maxAgentsPerWorkflow}`,
    });
  }
  const tokensToCommit = children.reduce((sum, item) => sum + item.budgetTokens, 0);
  if (state.workflow.tokensCommitted + tokensToCommit > limits.maxWorkflowTokens) {
    issues.push({
      code: "workflow_token_cap",
      message: `the children's budgets add ${tokensToCommit} tokens to ${state.workflow.tokensCommitted} already granted; the workflow limit is ${limits.maxWorkflowTokens}`,
    });
  }

  const graphIssues = graphIssuesOf(children);
  issues.push(...graphIssues);
  issues.push(...modelIssues(children, childArchetype, state.models));

  const change = checkpointChange(proposal.checkpoints);
  const stops = changeStops(state.workflow.autonomy, change, "agent");
  if (!stops.ok) issues.push({ code: stops.code, message: stops.reason });

  if (issues.length > 0 || !stops.ok) return { ok: false, issues };
  return {
    ok: true,
    childArchetype,
    agentsToCreate,
    tokensToCommit,
    serialize: graphIssues.length === 0 ? serializations(children) : [],
    autonomy: stops.settings,
  };
}

// Problems that make every other check meaningless; reported alone.
function gateIssue(
  proposal: DelegationProposal,
  state: DelegationState,
  limits: DelegationLimits,
): DelegationIssue | null {
  if (state.workflow.state !== "running") {
    return {
      code: "workflow_not_running",
      message: `the workflow is ${state.workflow.state}; it accepts no proposal`,
    };
  }
  const { archetype, depth } = proposal.caller;
  const child = childArchetypeOf(proposal.tool);
  if (
    child === null ||
    !mayUseTool(archetype, proposal.tool, { writes: false }) ||
    !ARCHETYPES[archetype].children.includes(child)
  ) {
    return {
      code: "tool_not_allowed",
      message: `${proposal.tool} does not create children for the ${archetype}; it may not use it to delegate`,
    };
  }
  if (depth + 1 > limits.maxDepth) {
    return {
      code: "too_deep",
      message: `children of a depth-${depth} caller would sit at depth ${depth + 1}; the maximum is ${limits.maxDepth}`,
    };
  }
  return null;
}

// Duplicates, unknown dependencies and cycles among the proposal's local ids (the plan-graph rules, on this shape).
function graphIssuesOf(children: readonly ProposedChild[]): DelegationIssue[] {
  const issues: DelegationIssue[] = [];
  const known = new Set<string>();
  const reported = new Set<string>();
  for (const item of children) {
    if (!known.has(item.localId)) known.add(item.localId);
    else if (!reported.has(item.localId)) {
      reported.add(item.localId);
      issues.push({
        code: "duplicate_task_id",
        localId: item.localId,
        message: `local id "${item.localId}" is used by more than one child`,
      });
    }
  }
  for (const item of children) {
    for (const dependency of item.dependsOn) {
      if (!known.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          localId: item.localId,
          message: `child "${item.localId}" depends on unknown child "${dependency}"`,
        });
      }
    }
  }

  const deps = new Map<string, string[]>();
  for (const item of children) {
    deps.set(item.localId, [...(deps.get(item.localId) ?? []), ...item.dependsOn]);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    visiting.add(id);
    stack.push(id);
    for (const dependency of deps.get(id) ?? []) {
      if (!known.has(dependency) || done.has(dependency)) continue;
      if (visiting.has(dependency)) {
        const path = [...stack.slice(stack.indexOf(dependency)), dependency];
        issues.push({ code: "cycle", path, message: `dependency cycle: ${path.join(" -> ")}` });
      } else {
        visit(dependency);
      }
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
  };
  for (const id of known) if (!done.has(id)) visit(id);
  return issues;
}

// A child's proposed model, unless the user pinned the layer: then the pin wins and the proposal does not matter.
function modelIssues(
  children: readonly ProposedChild[],
  archetype: DelegationArchetype,
  models: ModelSelectionContext,
): DelegationIssue[] {
  if (models.pinned[archetype] !== undefined) return [];
  const issues: DelegationIssue[] = [];
  for (const item of children) {
    if (item.model === null) continue;
    const choice = chooseModel(
      {
        archetype,
        difficulty: item.difficulty,
        budgetTokens: item.budgetTokens,
        phase: "propose",
        proposed: item.model,
      },
      models,
    );
    if (choice.kind === "reject") {
      issues.push({
        code: choice.code,
        localId: item.localId,
        message: `child "${item.localId}" proposes model "${item.model}", which cannot run as a ${archetype} (${choice.cause}); choose another model or leave it null for the table`,
      });
    }
  }
  return issues;
}

// Dependencies first, ties by proposal order (Kahn with a stable pick). Called only on a valid graph.
function stableOrder(children: readonly ProposedChild[]): ProposedChild[] {
  const done = new Set<string>();
  const order: ProposedChild[] = [];
  const pending = [...children];
  while (pending.length > 0) {
    const index = pending.findIndex((item) => item.dependsOn.every((dep) => done.has(dep)));
    const [next] = pending.splice(index, 1);
    if (next === undefined) break;
    done.add(next.localId);
    order.push(next);
  }
  return order;
}

// For each pair of siblings whose write surfaces may overlap and that are not already ordered, the later one (in an
// order that follows the existing dependencies) waits for the earlier one. Following that order keeps the graph
// acyclic.
function serializations(children: readonly ProposedChild[]): Serialization[] {
  const order = stableOrder(children);
  // Ancestors of each processed child, including the dependencies added here, so no redundant edge is added.
  const reach = new Map<string, Set<string>>();
  const added: Serialization[] = [];
  const inherit = (ancestors: Set<string>, id: string): void => {
    ancestors.add(id);
    for (const ancestor of reach.get(id) ?? []) ancestors.add(ancestor);
  };
  order.forEach((later, laterIndex) => {
    const ancestors = new Set<string>();
    for (const dep of later.dependsOn) inherit(ancestors, dep);
    for (const earlier of order.slice(0, laterIndex)) {
      if (ancestors.has(earlier.localId)) continue;
      if (!surfacesMayOverlap(earlier.writeSurface, later.writeSurface)) continue;
      added.push({ localId: later.localId, after: earlier.localId });
      inherit(ancestors, earlier.localId);
    }
    reach.set(later.localId, ancestors);
  });
  return added;
}
