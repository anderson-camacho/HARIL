import { Type } from "typebox";
import { TaskKindSchema } from "./enums.js";

// Shared task-spec fields used by Task (schemas.md section 5) and PlanTask (section 6).
// Nested shapes the docs do not define in this slice are opaque strings or arrays of strings;
// each is marked TODO so it can be tightened when its owning section is implemented.

// TODO(schemas.md section 4 "Capacidades"): Capability is a closed vocabulary not encoded yet.
const CapabilitySchema = Type.String({ minLength: 1 });
// TODO(AGENTS.md 5.3): AgentBlockRef shape not defined in this slice.
const AgentBlockRefSchema = Type.String({ minLength: 1 });
// TODO(schemas.md section 4, ContextRef / SC-10): shape not defined in this slice.
const ContextRefSchema = Type.String({ minLength: 1 });
// TODO(schemas.md section 4, ArtifactRef): shape not defined in this slice.
export const ArtifactRefSchema = Type.String({ minLength: 1 });
const GlobSchema = Type.String({ minLength: 1 });
// TODO(ARCH 5.3): the currency and unit of maxCostMicros are not defined.
const MicrosSchema = Type.Integer({ minimum: 0 });

// VerifierRef is `{ blockId, checkId, params? }` (schemas.md section 4); the type of params is a guess.
const VerifierRefSchema = Type.Object(
  {
    blockId: Type.String({ minLength: 1 }),
    checkId: Type.String({ minLength: 1 }),
    // TODO(schemas.md section 4): params type not defined; open record assumed.
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

const SurfaceSchema = Type.Object(
  { write: Type.Array(GlobSchema), read: Type.Array(GlobSchema) },
  { additionalProperties: false },
);

const BudgetSchema = Type.Object(
  {
    maxCostMicros: MicrosSchema,
    maxTokens: Type.Integer({ minimum: 0 }),
    maxWallMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TaskSpecFields = {
  goal: Type.String({ minLength: 1 }),
  description: Type.String(),
  priority: Type.Integer(),
  kind: TaskKindSchema,
  agent: AgentBlockRefSchema,
  requires: Type.Array(CapabilitySchema),
  context: Type.Array(ContextRefSchema),
  surface: SurfaceSchema,
  budget: BudgetSchema,
  timeoutMs: Type.Integer({ exclusiveMinimum: 0 }),
  maxAttempts: Type.Integer({ minimum: 1 }),
  acceptance: Type.Array(VerifierRefSchema),
};
