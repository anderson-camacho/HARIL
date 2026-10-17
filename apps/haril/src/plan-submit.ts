import { canonicalJson } from "@haril/core";
import { requestHash, sha256 } from "./commands/common.js";

// The plan.submit of a plan (LD-T3). `haril plan import` and an approved plan queue the same command, so the idempotency
// key and the request hash of a plan do not depend on how it arrived: the same plan is the same request.
export function planSubmitKey(projectId: string, plan: unknown): string {
  return sha256(`${projectId}${canonicalJson(plan)}`);
}

export function planSubmitCommand(projectId: string, plan: unknown) {
  const args = { plan };
  return {
    type: "plan.submit",
    projectId,
    args,
    idempotencyKey: planSubmitKey(projectId, plan),
    requestHash: requestHash({ type: "plan.submit", projectId, args }),
  };
}
