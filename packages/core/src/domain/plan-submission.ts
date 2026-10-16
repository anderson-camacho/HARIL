import { validatePlanSchema } from "@haril/contracts";
import type { PlanCheck } from "../ports/index.js";
import { topologicalOrder, validatePlanGraph } from "./plan-graph.js";

// Re-validation of an untrusted plan at plan.submit (schema, then graph rules, then order). Pure.
// The Store calls it through the rules it is given, so the adapter never imports Core values.
export function checkPlanSubmission(value: unknown): PlanCheck {
  const schema = validatePlanSchema(value);
  if (!schema.ok) return { ok: false, reason: `invalid plan: ${schema.errors.join("; ")}` };

  const issues = validatePlanGraph(schema.plan);
  if (issues.length > 0) {
    return { ok: false, reason: issues.map((issue) => issue.message).join("; ") };
  }

  const order = topologicalOrder(schema.plan);
  if (order === null) return { ok: false, reason: "plan has no valid dependency order" };
  return { ok: true, plan: schema.plan, order };
}
