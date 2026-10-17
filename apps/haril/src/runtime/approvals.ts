import type { RunEvent } from "@haril/core";
import type { Store } from "@haril/core/ports";
import { StoreError } from "@haril/state-sqlite";
import { planSubmitCommand } from "../plan-submit.js";

// The runtime's name as the decider of the plans it denies (LD-T4).
const RUNTIME_DECIDER = "runtime";

// LD-T4: a plan task that ends failed leaves no plan to approve. Every plan still requested by one of the task's runs is
// denied; the next turn applies the denial like any other decision. A plan the task only deduplicated against belongs to
// the run that proposed it first and stays. A person who decided first wins: their decision is kept.
export function denyPlansOfFailedTask(store: Store, taskId: string, cause: string): number {
  let denied = 0;
  for (const approval of store.approvals.list({ status: "requested", requestedByTask: taskId })) {
    try {
      store.approvals.decide({
        approvalId: approval.approvalId,
        outcome: "denied",
        decidedBy: RUNTIME_DECIDER,
        reason: `plan task ${taskId} failed: ${cause}`,
      });
      denied += 1;
    } catch (error) {
      if (!(error instanceof StoreError && error.code === "store.conflict")) throw error;
    }
  }
  return denied;
}

// Applies every decision on an approval that the runtime has not applied yet (LD-T3, ARCH 4.2 drain). A granted plan is
// queued as the plan.submit that `haril plan import` would queue, with the model of the task that proposed it for its
// tasks (LD-T7a), then the decision is marked applied. Two steps, not one transaction: a crash between them leaves the
// decision unapplied, and the next turn queues the same plan.submit again, which its idempotency key turns into a
// duplicate. Returns how many decisions were applied.
export function applyDecidedApprovals(
  store: Store,
  epoch: number,
  emit: (event: RunEvent) => void,
): number {
  let applied = 0;
  for (const approval of store.approvals.listUnapplied()) {
    const outcome = approval.status === "granted" ? "granted" : "denied";
    const alreadySubmitted =
      outcome === "granted" &&
      store.commands.enqueue(
        planSubmitCommand(approval.projectId, approval.subject, approval.model),
      ).duplicate;
    store.approvals.markApplied(approval.approvalId, epoch);
    emit({ type: "approval.applied", approvalId: approval.approvalId, outcome, alreadySubmitted });
    applied += 1;
  }
  return applied;
}
