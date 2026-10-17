import { canonicalJson, checkPlanSubmission } from "@haril/core";
import type { PlanProposalContext, PlanProposer, Store } from "@haril/core/ports";
import { StoreError } from "@haril/state-sqlite";

// The host side of haril_propose_plan (LD-T4, ARCH 9.4). One handler serves every agent runtime: the FakeAgentRuntime
// option in the hermetic lane, and the bridge tool of the Pi lane. A plan is recorded only for a run whose plan attempt
// the run loop has opened, as a requested approval of the run's project (requestedBy is the run id) with the model of the
// run's task (LD-T7a). The loop learns of every recorded proposal, so it can tell subscribers and check that a plan
// attempt proposed.

interface RecordedProposal {
  readonly approvalId: string;
  readonly taskId: string;
  readonly created: boolean;
}

// What one plan attempt did with its window: whether a plan was accepted, and the last reason the host refused one.
export interface PlanAttemptReport {
  readonly proposed: boolean;
  readonly lastRefusal?: string;
}

// One plan attempt as the run loop claimed it: its run and the model of its task, read from the store (absent or null
// when the task names none). The agent runtime never supplies the model: its calls only name the run.
interface PlanAttempt extends PlanProposalContext {
  readonly model?: string | null;
}

export interface PlanProposals {
  readonly propose: PlanProposer;
  // Opens the proposal window of one plan attempt; each proposal it records is reported to onRecorded. The returned
  // function closes the window, after which the run's calls are refused, and reports what the attempt proposed.
  open(
    attempt: PlanAttempt,
    onRecorded: (proposal: RecordedProposal) => void,
  ): () => PlanAttemptReport;
}

interface OpenAttempt {
  readonly attempt: PlanAttempt;
  readonly onRecorded: (proposal: RecordedProposal) => void;
  // The one plan of the attempt: its approval and the canonical JSON of its checked plan.
  accepted: { readonly approvalId: string; readonly canonical: string } | undefined;
  lastRefusal: string | undefined;
}

export function createPlanProposals(store: Pick<Store, "approvals">): PlanProposals {
  const open = new Map<string, OpenAttempt>();

  const refuse = (window: OpenAttempt, reason: string) => {
    window.lastRefusal = reason;
    return { ok: false as const, reason };
  };

  // An attempt has one plan (LD-T4): the same plan again is the same approval, without asking the store, so a decision
  // taken meanwhile never leads to a second approval; any other plan is refused.
  const proposeAgain = (window: OpenAttempt, plan: unknown) => {
    const accepted = window.accepted;
    if (accepted === undefined) return undefined;
    const checked = checkPlanSubmission(plan);
    if (!checked.ok || canonicalJson(checked.plan) !== accepted.canonical) {
      return refuse(window, `a plan was already proposed in this attempt (${accepted.approvalId})`);
    }
    window.onRecorded({
      approvalId: accepted.approvalId,
      taskId: window.attempt.taskId,
      created: false,
    });
    return { ok: true as const, approvalId: accepted.approvalId, created: false };
  };

  return {
    propose: (context, plan) => {
      const window = open.get(context.runId);
      if (
        window === undefined ||
        window.attempt.taskId !== context.taskId ||
        window.attempt.projectId !== context.projectId
      ) {
        return {
          ok: false,
          reason: `run ${context.runId} is not a running plan task; only a plan attempt may propose a plan`,
        };
      }
      const again = proposeAgain(window, plan);
      if (again !== undefined) return again;
      let proposed: ReturnType<Store["approvals"]["proposePlan"]>;
      try {
        proposed = store.approvals.proposePlan({
          projectId: window.attempt.projectId,
          plan,
          requestedBy: window.attempt.runId,
          model: window.attempt.model ?? null,
        });
      } catch (error) {
        // A project gone from the store, for instance: the agent hears the reason, the runtime keeps going.
        if (error instanceof StoreError) return refuse(window, error.message);
        throw error;
      }
      // plan.invalid carries the plan.submit reason, so the agent can fix the plan and propose again.
      if (!proposed.ok) return refuse(window, proposed.error.message);
      const { approval, created } = proposed.value;
      window.accepted = {
        approvalId: approval.approvalId,
        canonical: canonicalJson(approval.subject),
      };
      window.onRecorded({
        approvalId: approval.approvalId,
        taskId: window.attempt.taskId,
        created,
      });
      return { ok: true, approvalId: approval.approvalId, created };
    },
    open: (attempt, onRecorded) => {
      const window: OpenAttempt = {
        attempt,
        onRecorded,
        accepted: undefined,
        lastRefusal: undefined,
      };
      open.set(attempt.runId, window);
      return () => {
        open.delete(attempt.runId);
        return {
          proposed: window.accepted !== undefined,
          ...(window.lastRefusal === undefined ? {} : { lastRefusal: window.lastRefusal }),
        };
      };
    },
  };
}
