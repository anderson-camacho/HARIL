import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// A request to a person (feature haril-factory, F7): one record for every time an agent needs someone, built on the
// approvals table (kind "human", this record as its subject). Every field says something the person must read to answer,
// so a request missing any of them is refused and never reaches the person. Pure: no I/O.

export const HUMAN_REQUEST_KIND = "human";

const Text = Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" });

export const HumanRequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    // Requests of the same reason group in the console.
    reason: Type.Union([
      Type.Literal("git_publish"),
      Type.Literal("git_destructive"),
      Type.Literal("failure_cap"),
      Type.Literal("decision"),
    ]),
    who: Text,
    delegatedBy: Text,
    workflowId: Text,
    taskId: Text,
    task: Text,
    doing: Text,
    needs: Text,
    why: Text,
    ifRefused: Text,
    blocks: Type.Array(Text, { minItems: 1 }),
    // What runs if a person grants it; null when the answer itself is all that is needed.
    action: Type.Union([
      Type.Object(
        {
          program: Type.Union([Type.Literal("git"), Type.Literal("gh")]),
          args: Type.Array(Type.String(), { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    // The thread that hears the answer: the parent of who asked.
    notifyThreadId: Type.Union([Text, Type.Null()]),
  },
  { additionalProperties: false },
);
export type HumanRequest = Static<typeof HumanRequestSchema>;

export type HumanRequestValidation =
  | { readonly ok: true; readonly request: HumanRequest }
  | { readonly ok: false; readonly errors: readonly string[] };

export function validateHumanRequest(value: unknown): HumanRequestValidation {
  if (Value.Check(HumanRequestSchema, value)) return { ok: true, request: value };
  return {
    ok: false,
    errors: [...Value.Errors(HumanRequestSchema, value)].map(
      (error) => `${error.instancePath || "/"}: ${error.message}`,
    ),
  };
}

export function isHumanRequest(value: unknown): value is HumanRequest {
  return Value.Check(HumanRequestSchema, value);
}

// A person's answer: yes, no, or their own words, which never run the action.
export const WRITTEN_ANSWER_PREFIX = "write: ";
