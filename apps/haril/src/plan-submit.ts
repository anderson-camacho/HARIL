import { canonicalJson } from "@haril/core";
import { requestHash, sha256 } from "./commands/common.js";

// The plan.submit of a plan (LD-T3). `haril plan import` and an approved plan queue the same command, so the idempotency
// key and the request hash of a plan do not depend on how it arrived: the same plan is the same request.
export function planSubmitKey(projectId: string, plan: unknown): string {
  return sha256(`${projectId}${canonicalJson(plan)}`);
}

// An approved plan carries the model of the task that proposed it as defaultModel (LD-T7a), which the store gives to
// every task of the plan. The key and the hash stay those of the plan alone, so an imported plan and the same plan
// approved remain one request: whichever is queued first creates the tasks, and the other is a duplicate, never a
// conflict.
export function planSubmitCommand(projectId: string, plan: unknown, defaultModel: string | null) {
  return {
    type: "plan.submit",
    projectId,
    args: { plan, ...(defaultModel === null ? {} : { defaultModel }) },
    idempotencyKey: planSubmitKey(projectId, plan),
    requestHash: requestHash({ type: "plan.submit", projectId, args: { plan } }),
  };
}
