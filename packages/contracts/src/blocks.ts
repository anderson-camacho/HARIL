import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { TaskKindSchema } from "./enums.js";

// BlockManifest v1 (ADR-0014 D1): the 12 PROMPT sec4 fields with literal names, plus the two
// extensions provides and replaces. Unknown top-level keys are rejected (additionalProperties: false).
// Semver ranges, the permission vocabulary and the restricted config.schema subset are checked by the
// registry, not here; this schema only fixes shapes. Inputs and outputs are open per category.

export const BLOCK_CATEGORIES = [
  "tool",
  "behavior",
  "agent",
  "model",
  "provider",
  "memory",
  "methodology",
  "verification",
  "workflow",
  "interface",
] as const;

export const BlockCategorySchema = Type.Union(
  BLOCK_CATEGORIES.map((category) => Type.Literal(category)),
);
export type BlockCategory = Static<typeof BlockCategorySchema>;

// Three ASCII segments; the registry checks the reserved "haril." prefix and the category segment.
export const BlockIdSchema = Type.String({
  minLength: 5,
  maxLength: 96,
  pattern: "^[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,31}$",
});

// Semver as a string; a bare number such as 1.10 is rejected by the type itself.
export const BlockVersionSchema = Type.String({
  maxLength: 64,
  pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$",
});

const RangeSchema = Type.String({ minLength: 1, maxLength: 64 });

export const BlockDependencySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("block"), Type.Literal("port")]),
    id: Type.String({ minLength: 1, maxLength: 96 }),
    range: RangeSchema,
  },
  { additionalProperties: false },
);

export const BlockReplacesSchema = Type.Object(
  { id: BlockIdSchema, range: RangeSchema },
  { additionalProperties: false },
);

export const BlockConfigSchema = Type.Object(
  {
    schema: Type.Object({}, { additionalProperties: true }),
    defaults: Type.Object({}, { additionalProperties: true }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const BlockErrorPolicySchema = Type.Object(
  {
    failClosed: Type.Boolean(),
    retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const BlockCompatibilitySchema = Type.Object(
  {
    contracts: RangeSchema,
    core: RangeSchema,
    os: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }))),
    pi: Type.Optional(RangeSchema),
  },
  { additionalProperties: false },
);

export const BlockManifestSchema = Type.Object(
  {
    id: BlockIdSchema,
    version: BlockVersionSchema,
    category: BlockCategorySchema,
    capabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 })),
    dependencies: Type.Array(BlockDependencySchema),
    permissions: Type.Array(Type.Object({ kind: Type.String({ minLength: 1 }) })),
    config: BlockConfigSchema,
    inputs: Type.Array(Type.Unknown()),
    outputs: Type.Array(Type.Unknown()),
    events: Type.Array(Type.String({ minLength: 1, maxLength: 96 })),
    errorPolicy: BlockErrorPolicySchema,
    compatibility: BlockCompatibilitySchema,
    provides: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
    replaces: Type.Optional(Type.Array(BlockReplacesSchema)),
  },
  { additionalProperties: false },
);
export type BlockManifest = Static<typeof BlockManifestSchema>;

// Methodology payload (ADR-0014 D4, docs/BLOCK_SYSTEM.md 11): roles, closed gate vocabulary and sections.
const LocalIdSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" });

export const MethodologyRoleSchema = Type.Object(
  { id: LocalIdSchema, agent: BlockIdSchema },
  { additionalProperties: false },
);

const ActionSchema = Type.Union([
  Type.Literal("write"),
  Type.Literal("edit"),
  Type.Literal("shell"),
  Type.Literal("integrate"),
]);

// The five gate kinds of BLOCK_SYSTEM 11.2. A gate can only restrict; the registry checks role references.
export const MethodologyGateSchema = Type.Union([
  Type.Object(
    {
      id: LocalIdSchema,
      kind: Type.Literal("approval_before"),
      action: ActionSchema,
      roles: Type.Optional(Type.Array(LocalIdSchema)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: LocalIdSchema,
      kind: Type.Literal("require_predecessor"),
      role: LocalIdSchema,
      requiresRole: LocalIdSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: LocalIdSchema,
      kind: Type.Literal("require_acceptance"),
      role: LocalIdSchema,
      verificationRefs: Type.Array(BlockIdSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: LocalIdSchema,
      kind: Type.Literal("restrict_capabilities"),
      role: LocalIdSchema,
      deny: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
      readOnly: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      id: LocalIdSchema,
      kind: Type.Literal("limit"),
      role: LocalIdSchema,
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
]);
export type MethodologyGate = Static<typeof MethodologyGateSchema>;

export const MethodologySectionSchema = Type.Object(
  {
    id: LocalIdSchema,
    roles: Type.Array(LocalIdSchema),
    kinds: Type.Array(TaskKindSchema),
    mandatory: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const MethodologyPayloadSchema = Type.Object(
  {
    roles: Type.Array(MethodologyRoleSchema),
    gates: Type.Array(MethodologyGateSchema),
    sections: Type.Array(MethodologySectionSchema),
  },
  { additionalProperties: false },
);
export type MethodologyPayload = Static<typeof MethodologyPayloadSchema>;

export type SchemaValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: string[] };

function errorsOf(schema: TSchema, value: unknown): string[] {
  return Value.Errors(schema, value).map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
}

// Schema-level check of an untrusted manifest. Returns readable paths, never throws on bad input.
export function validateBlockManifest(value: unknown): SchemaValidation<BlockManifest> {
  if (Value.Check(BlockManifestSchema, value)) return { ok: true, value };
  return { ok: false, errors: errorsOf(BlockManifestSchema, value) };
}

// Schema-level check of config.payload for a methodology block.
export function validateMethodologyPayload(value: unknown): SchemaValidation<MethodologyPayload> {
  if (Value.Check(MethodologyPayloadSchema, value)) return { ok: true, value };
  return { ok: false, errors: errorsOf(MethodologyPayloadSchema, value) };
}
