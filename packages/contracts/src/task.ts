import { type Static, Type } from "typebox";
import { BlockReasonSchema, RetryReasonSchema, TaskPhaseSchema, TaskStateSchema } from "./enums.js";
import { ProjectIdSchema, TaskIdSchema } from "./primitives.js";
import { ArtifactRefSchema, TaskSpecFields } from "./task-fields.js";

// Task v1 (schemas.md section 5): the 18 required fields (schemaVersion + 17 properties) and 3 of
// the 5 optional ones (phase, blockReason, retryReason). route and result are deferred below.
// TODO(schemas.md section 5): optional `route` (RouteDecision) and `result` (TaskResult, ORCHESTRATION.md 6.2)
// are not in this slice; additionalProperties:false rejects them until their shapes exist.
// Cross-field invariants (phase only when running, blockReason only when blocked, ...) are
// enforced by the core, not by this schema (schemas.md section 5, "Invariantes de forma").
export const TaskSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: TaskIdSchema,
    projectId: ProjectIdSchema,
    ...TaskSpecFields,
    dependsOn: Type.Array(TaskIdSchema),
    state: TaskStateSchema,
    phase: Type.Optional(TaskPhaseSchema),
    blockReason: Type.Optional(BlockReasonSchema),
    retryReason: Type.Optional(RetryReasonSchema),
    evidence: Type.Array(ArtifactRefSchema),
  },
  { additionalProperties: false },
);
export type Task = Static<typeof TaskSchema>;
