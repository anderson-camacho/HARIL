import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// Acceptance checks (criterion 8, M3-D7). The host evaluates them after the agent settles; the agent never
// evaluates its own checks. `command` checks are deliberately absent: they need an approval (N0) that M3 lacks.

export const AcceptanceCheckSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("file_exists"), path: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("file_contains"),
      path: Type.String({ minLength: 1 }),
      text: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("output_contains"), text: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);
export type AcceptanceCheck = Static<typeof AcceptanceCheckSchema>;

// M1 stored `acceptance` as VerifierRef `{ blockId, checkId, params? }` (schemas.md section 4). No host evaluates
// those yet, so they stay accepted for stored plans and the host skips them without counting them as checks.
// TODO(schemas.md section 4): drop this shape when block verifiers are implemented.
export const VerifierRefSchema = Type.Object(
  {
    blockId: Type.String({ minLength: 1 }),
    checkId: Type.String({ minLength: 1 }),
    // TODO(schemas.md section 4): params type not defined; open record assumed.
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export const AcceptanceSchema = Type.Array(Type.Union([AcceptanceCheckSchema, VerifierRefSchema]));
export type Acceptance = Static<typeof AcceptanceSchema>;

export type AcceptanceValidation =
  | { readonly ok: true; readonly acceptance: Acceptance }
  | { readonly ok: false; readonly errors: string[] };

// Schema-level check of an acceptance list from untrusted input (task.create arguments, plans).
export function validateAcceptance(value: unknown): AcceptanceValidation {
  if (Value.Check(AcceptanceSchema, value)) return { ok: true, acceptance: value };
  const errors = Value.Errors(AcceptanceSchema, value).map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
  return { ok: false, errors };
}
