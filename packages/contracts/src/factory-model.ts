import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { WaitExplanationSchema, WorkflowStateSchema } from "./workflow-snapshot.js";

// FactoryModel v1: what `haril factory show --json` returns and what each line of `haril factory watch` prints, for the
// console's factory view. Across workflows, unlike WorkflowSnapshot. A task here is one agent's work (a thread with its
// latest turn), so a retry moves a card instead of adding one. integrations/pi-console keeps a local copy because it
// imports no other workspace (check-layers R6); its twin test keeps the two equal. null always means "not available".

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Count = Type.Number({ minimum: 0 });
const Criteria = Nullable(
  Type.Object({ passed: Count, total: Count }, { additionalProperties: false }),
);
const Context = Nullable(
  Type.Object({ used: Count, threshold: Count }, { additionalProperties: false }),
);

export const FactoryColumnSchema = Type.Union([
  Type.Literal("por_hacer"),
  Type.Literal("en_curso"),
  Type.Literal("detenidas"),
  Type.Literal("errores"),
  Type.Literal("hechas"),
]);
export type FactoryColumn = Static<typeof FactoryColumnSchema>;

export const FactoryModelSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    generatedAt: Type.Number(),
    // The project it was asked for; null means every project.
    project: Nullable(Type.String()),
    workflows: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          projectSlug: Type.String(),
          goal: Type.String(),
          state: WorkflowStateSchema,
          stopReason: Nullable(Type.String()),
          explanation: WaitExplanationSchema,
          startedAt: Type.Number(),
          elapsedMs: Count,
          tokensUsed: Count,
          tokensBudget: Nullable(Count),
          agentsCreated: Count,
          agentsCap: Count,
          closedTasks: Count,
          totalTasks: Count,
          // Acceptance criteria of its latest audits; null while nothing was audited.
          criteria: Criteria,
        },
        { additionalProperties: false },
      ),
    ),
    tasks: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          workflowId: Type.String(),
          title: Type.String(),
          state: Type.String(),
          column: FactoryColumnSchema,
          role: Type.String(),
          agent: Type.String(),
          // The agent that delegated it; null for the root, which the person asked for.
          delegatedBy: Nullable(Type.String()),
          // Who has it now that it failed (an agent's code, or "tú"); null unless it is in errores.
          returnedTo: Nullable(Type.String()),
          model: Nullable(Type.String()),
          attempts: Count,
          maxAttempts: Nullable(Count),
          context: Context,
          tokens: Count,
          criteria: Criteria,
          explanation: WaitExplanationSchema,
          closedAt: Nullable(Type.Number()),
          updatedAt: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ),
    agents: Type.Array(
      Type.Object(
        {
          workflowId: Type.String(),
          code: Type.String(),
          role: Type.String(),
          status: Type.String(),
          taskId: Type.String(),
          task: Type.String(),
          model: Nullable(Type.String()),
          tokens: Count,
          elapsedMs: Nullable(Count),
          context: Context,
          parent: Nullable(Type.String()),
          depth: Count,
        },
        { additionalProperties: false },
      ),
    ),
    edges: Type.Array(
      Type.Object(
        { workflowId: Type.String(), parent: Type.String(), child: Type.String() },
        { additionalProperties: false },
      ),
    ),
    events: Type.Array(
      Type.Object(
        {
          at: Type.Number(),
          type: Type.String(),
          text: Type.String(),
          workflowId: Nullable(Type.String()),
          agent: Nullable(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    humanRequests: Type.Array(
      Type.Object(
        {
          // An approval to grant or deny, a workflow stop to lift, or a task blocked on a person.
          kind: Type.Union([Type.Literal("approval"), Type.Literal("stop"), Type.Literal("task")]),
          id: Type.String(),
          workflowId: Nullable(Type.String()),
          projectSlug: Type.String(),
          title: Type.String(),
          explanation: WaitExplanationSchema,
          at: Type.Number(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type FactoryModel = Static<typeof FactoryModelSchema>;

export function isFactoryModel(value: unknown): value is FactoryModel {
  return Value.Check(FactoryModelSchema, value);
}
