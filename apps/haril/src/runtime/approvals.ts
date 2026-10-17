import type { RunEvent } from "@haril/core";
import type { Store } from "@haril/core/ports";
import { planSubmitCommand } from "../plan-submit.js";

// Applies every decision on an approval that the runtime has not applied yet (LD-T3, ARCH 4.2 drain). A granted plan is
// queued as the plan.submit that `haril plan import` would queue, then the decision is marked applied. Two steps, not one
// transaction: a crash between them leaves the decision unapplied, and the next turn queues the same plan.submit again,
// which its idempotency key turns into a duplicate. Returns how many decisions were applied.
export function applyDecidedApprovals(
  store: Store,
  epoch: number,
  emit: (event: RunEvent) => void,
): number {
  let applied = 0;
  for (const approval of store.approvals.listUnapplied()) {
    const outcome = approval.status === "granted" ? "granted" : "denied";
    if (outcome === "granted") {
      store.commands.enqueue(planSubmitCommand(approval.projectId, approval.subject));
    }
    store.approvals.markApplied(approval.approvalId, epoch);
    emit({ type: "approval.applied", approvalId: approval.approvalId, outcome });
    applied += 1;
  }
  return applied;
}
