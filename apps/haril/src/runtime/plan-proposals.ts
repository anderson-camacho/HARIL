import type { PlanProposalContext, PlanProposer, Store } from "@haril/core/ports";
import { StoreError } from "@haril/state-sqlite";

// The host side of haril_propose_plan (LD-T4, ARCH 9.4). One handler serves every agent runtime: the FakeAgentRuntime
// option in the hermetic lane, and the bridge tool of the Pi lane. A plan is recorded only for a run whose plan attempt
// the run loop has opened, as a requested approval of the run's project (requestedBy is the run id). The loop learns of
// every recorded proposal, so it can tell subscribers and check that a plan attempt proposed.

interface RecordedProposal {
  readonly approvalId: string;
  readonly taskId: string;
  readonly created: boolean;
}

export interface PlanProposals {
  readonly propose: PlanProposer;
  // Opens the proposal window of one plan attempt; each proposal it records is reported to onRecorded. The returned
  // function closes the window, after which the run's calls are refused, and says whether the run recorded a proposal.
  open(
    attempt: PlanProposalContext,
    onRecorded: (proposal: RecordedProposal) => void,
  ): () => boolean;
}

interface OpenAttempt {
  readonly attempt: PlanProposalContext;
  readonly onRecorded: (proposal: RecordedProposal) => void;
  proposed: boolean;
}

export function createPlanProposals(store: Pick<Store, "approvals">): PlanProposals {
  const open = new Map<string, OpenAttempt>();
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
      let proposed: ReturnType<Store["approvals"]["proposePlan"]>;
      try {
        proposed = store.approvals.proposePlan({
          projectId: window.attempt.projectId,
          plan,
          requestedBy: window.attempt.runId,
        });
      } catch (error) {
        // A project gone from the store, for instance: the agent hears the reason, the runtime keeps going.
        if (error instanceof StoreError) return { ok: false, reason: error.message };
        throw error;
      }
      // plan.invalid carries the plan.submit reason, so the agent can fix the plan and propose again.
      if (!proposed.ok) return { ok: false, reason: proposed.error.message };
      const { approvalId } = proposed.value.approval;
      const { created } = proposed.value;
      window.proposed = true;
      window.onRecorded({ approvalId, taskId: window.attempt.taskId, created });
      return { ok: true, approvalId, created };
    },
    open: (attempt, onRecorded) => {
      const window: OpenAttempt = { attempt, onRecorded, proposed: false };
      open.set(attempt.runId, window);
      return () => {
        open.delete(attempt.runId);
        return window.proposed;
      };
    },
  };
}
