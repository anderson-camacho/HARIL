import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { DataClassSchema } from "./enums.js";
import { TaskIdSchema } from "./primitives.js";
import { TaskSpecFields } from "./task-fields.js";

// PlanTask is a Task without what the Core or the execution assigns (schemas.md section 6),
// plus a local id and an optional creation-time data class.
export const PlanTaskSchema = Type.Object(
  {
    // [S] pattern from schemas.md section 6. The "not ULID-shaped" rule is not encoded.
    localId: Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" }),
    dependsOn: Type.Array(Type.String({ minLength: 1 })),
    ...TaskSpecFields,
    dataClass: Type.Optional(DataClassSchema),
  },
  { additionalProperties: false },
);
export type PlanTask = Static<typeof PlanTaskSchema>;

// Plan is the untrusted input of plan.submit / plan.propose (schemas.md section 6).
// The project comes from the channel and the ids/origin/depth are assigned by the Core, so
// none of them appear here.
export const PlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    tasks: Type.Array(PlanTaskSchema),
    supersedes: Type.Optional(Type.Array(TaskIdSchema)),
    rewire: Type.Optional(
      Type.Array(
        Type.Object(
          {
            taskId: TaskIdSchema,
            replace: TaskIdSchema,
            with: Type.Array(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export type Plan = Static<typeof PlanSchema>;

export type PlanSchemaValidation =
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly errors: string[] };

// Schema-level check of untrusted input. Graph rules (dependencies, cycles, limits) live in the core.
export function validatePlanSchema(value: unknown): PlanSchemaValidation {
  if (Value.Check(PlanSchema, value)) return { ok: true, plan: value };
  const errors = Value.Errors(PlanSchema, value).map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
  return { ok: false, errors };
}
