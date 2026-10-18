import {
  type AbortInput,
  type AssignInput,
  type DelegateInput,
  isDelegationToolName,
  type ReportInput,
  type RequestAuditInput,
  type VerdictInput,
  validateDelegationToolInput,
} from "@haril/contracts";
import {
  canonicalJson,
  checkDelegation,
  checkVerdict,
  type DelegationCaller,
  type DelegationCheck,
  type DelegationState,
  isDelegationArchetype,
  mayUseTool,
  proposalFromAssign,
  proposalFromDelegate,
} from "@haril/core";
import type { Clock, DelegationToolHandler, DelegationToolResult, Store } from "@haril/core/ports";
import {
  type DelegationOptions,
  type WorkflowSettings,
  WorkflowView,
  workflowSettings,
} from "./workflow-view.js";

// The host side of the delegation tools (docs/modos-y-delegacion.md 3.4, 3.5, 3.6): one handler serves every agent
// runtime, the FakeAgentRuntime option now and Pi's bridge tools in phase F2b, as plan-proposals.ts does for
// haril_propose_plan. A call is accepted only from a workflow turn the run loop opened, for itself. The handler checks
// the tool against the turn's archetype, the input against the tool contracts, and a proposal against checkDelegation
// with the workflow's limits; it answers { ok: true, ... } or { ok: false, reason }, and with a reason the agent corrects
// its call in the same turn. A turn makes one call that decides it (a proposal, a report, a verdict, an audit request or
// an abort): the same call again is the same answer, any other is refused. Nothing is created here. The accepted call
// waits in the turn's window until the turn ends, and the run loop applies it in the transaction that closes the turn
// (workflow-turns.ts), so a crash in between leaves nothing behind and the rerun makes the call again.

export type TurnAction =
  | { readonly tool: "haril_delegate"; readonly input: DelegateInput }
  | { readonly tool: "haril_assign"; readonly input: AssignInput }
  | { readonly tool: "haril_report"; readonly input: ReportInput }
  | { readonly tool: "haril_verdict"; readonly input: VerdictInput }
  | { readonly tool: "haril_request_audit"; readonly input: RequestAuditInput }
  | { readonly tool: "haril_abort"; readonly input: AbortInput };

export interface TurnWindowReport {
  readonly action: TurnAction | null;
  // Every refusal the turn heard, in order, so a failed turn can say why.
  readonly refusals: readonly string[];
}

interface TurnAttempt {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workflowId: string;
}

export interface DelegationTools {
  readonly call: DelegationToolHandler;
  // Opens the window of one workflow turn; the returned function closes it and reports its decided call.
  open(attempt: TurnAttempt): () => TurnWindowReport;
}

interface Window {
  readonly attempt: TurnAttempt;
  action: TurnAction | null;
  readonly refusals: string[];
}

export interface DelegationToolsDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly options?: DelegationOptions;
}

// The state checkDelegation reads for a calling thread (3.6).
export function delegationState(
  view: WorkflowView,
  threadId: string,
  settings: WorkflowSettings,
  now: number,
): DelegationState {
  const { workflow } = view;
  return {
    workflow: {
      state: workflow.state,
      agentsCreated: workflow.agentsCreated,
      tokensCommitted: view.tokensCommitted(),
      autonomy: { mode: workflow.autonomy.mode, stops: workflow.autonomy.stops },
    },
    thread: {
      queuedChildren: view.childThreads(threadId).filter((child) => view.unsettled(child)).length,
      proposals: view.proposalCount(threadId),
    },
    models: settings.models(now),
  };
}

function issuesText(check: Extract<DelegationCheck, { ok: false }>): string {
  return check.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; ");
}

// The assignments of a delegator's call that name one of its existing steps: allowed once for an escalated step (the
// reformulation of 3.8) and for a blocked step (one that never ran because a step it depends on failed or escalated).
export function reassignmentProblem(
  view: WorkflowView,
  threadId: string,
  input: AssignInput,
  settings: WorkflowSettings,
): string | null {
  const steps = new Map(
    view
      .childThreads(threadId)
      .map((child) => [view.turns(child)[0]?.localId ?? "", child] as const),
  );
  for (const assignment of input.assignments) {
    const existing = steps.get(assignment.localId);
    if (existing === undefined) continue;
    if (view.reassigned(existing)) {
      return `step "${assignment.localId}" was already reassigned once; it cannot be reassigned again`;
    }
    const phase = view.rework(existing, settings.limits).phase;
    const blocked = view.latest(existing)?.state === "blocked";
    if (phase !== "awaiting_reformulation" && !blocked) {
      return `step "${assignment.localId}" already exists and is not escalated or blocked; give new work a new localId`;
    }
  }
  return null;
}

export function createDelegationTools(deps: DelegationToolsDeps): DelegationTools {
  const { store, clock } = deps;
  const windows = new Map<string, Window>();

  const refuse = (window: Window | undefined, reason: string): DelegationToolResult => {
    window?.refusals.push(reason);
    return { ok: false, reason };
  };

  const check = (window: Window, tool: string, raw: unknown): DelegationToolResult => {
    const view = WorkflowView.load(store, window.attempt.workflowId);
    const task = view?.task(window.attempt.taskId);
    if (view === undefined || task === undefined || !isDelegationArchetype(task.role)) {
      return refuse(window, `run ${window.attempt.runId} is not a turn of a workflow`);
    }
    if (!isDelegationToolName(tool)) return refuse(window, `unknown tool "${tool}"`);
    if (!mayUseTool(task.role, tool, { writes: false })) {
      return refuse(window, `${tool} is not a tool of the ${task.role}`);
    }
    if (tool === "haril_run" || tool === "haril_merge") {
      return refuse(
        window,
        `${tool} runs nothing until writing arrives (phase F8): no command is allowed yet`,
      );
    }
    const valid = validateDelegationToolInput(tool, raw);
    if (!valid.ok) return refuse(window, `${tool} input: ${valid.errors.join("; ")}`);
    const action = { tool, input: valid.input } as TurnAction;
    if (window.action !== null) {
      if (
        window.action.tool === tool &&
        canonicalJson(window.action.input) === canonicalJson(raw)
      ) {
        return { ok: true, replay: true };
      }
      return refuse(
        window,
        `this turn already called ${window.action.tool}; end the turn (its result reaches your parent or your continuation)`,
      );
    }
    if (view.workflow.state !== "running") {
      return refuse(window, `the workflow is ${view.workflow.state}; it takes no call`);
    }
    const settings = workflowSettings(view.workflow, deps.options);
    const now = clock.now();
    const caller: DelegationCaller = {
      threadId: task.threadId,
      archetype: task.role,
      depth: task.layer,
    };
    let reply: DelegationToolResult;
    switch (action.tool) {
      case "haril_delegate": {
        const result = checkDelegation(
          proposalFromDelegate(caller, action.input),
          delegationState(view, task.threadId, settings, now),
          settings.limits,
        );
        if (!result.ok) return refuse(window, issuesText(result));
        reply = {
          ok: true,
          delegations: action.input.delegations.length,
          agentsToCreate: result.agentsToCreate,
          note: "applied when your turn ends; you run again with the delegators' reports",
        };
        break;
      }
      case "haril_assign": {
        const result = checkDelegation(
          proposalFromAssign(caller, action.input),
          delegationState(view, task.threadId, settings, now),
          settings.limits,
        );
        if (!result.ok) return refuse(window, issuesText(result));
        const problem = reassignmentProblem(view, task.threadId, action.input, settings);
        if (problem !== null) return refuse(window, problem);
        reply = {
          ok: true,
          assignments: action.input.assignments.length,
          agentsToCreate: result.agentsToCreate,
          note: "applied when your turn ends; you run again with the executors' outcomes",
        };
        break;
      }
      case "haril_verdict": {
        const verdict = checkVerdict(action.input);
        if (!verdict.ok) return refuse(window, `${verdict.code}: ${verdict.reason}`);
        reply = { ok: true, approved: action.input.approved };
        break;
      }
      case "haril_request_audit": {
        const pending = view
          .childThreads(task.threadId)
          .filter((child) => view.unsettled(child)).length;
        if (pending > 0) {
          return refuse(
            window,
            `${pending} delegators are still working; request the audit once nothing is pending`,
          );
        }
        if (view.workflow.agentsCreated + 1 > settings.limits.maxAgentsPerWorkflow) {
          return refuse(
            window,
            `workflow_agent_cap: the workflow created ${view.workflow.agentsCreated} agents; the final auditor would pass the limit of ${settings.limits.maxAgentsPerWorkflow}`,
          );
        }
        reply = { ok: true, note: "the final auditor starts when your turn ends" };
        break;
      }
      default:
        reply = { ok: true };
    }
    window.action = action;
    return reply;
  };

  return {
    call: (context, tool, input) => {
      const window = windows.get(context.runId);
      if (
        window === undefined ||
        window.attempt.taskId !== context.taskId ||
        window.attempt.projectId !== context.projectId
      ) {
        return refuse(
          undefined,
          `run ${context.runId} is not a running workflow turn; only a workflow turn may call the delegation tools`,
        );
      }
      return check(window, tool, input);
    },
    open: (attempt) => {
      const window: Window = { attempt, action: null, refusals: [] };
      windows.set(attempt.runId, window);
      return () => {
        windows.delete(attempt.runId);
        return { action: window.action, refusals: [...window.refusals] };
      };
    },
  };
}
