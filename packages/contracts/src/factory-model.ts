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

// One window of one group. `pct` comes only from the provider; an estimate is tokens from the usage log, never a percentage.
// `state` says why there is no fresh percentage: "El proveedor no permite ver este dato", "Sin lectura: <motivo>" or
// "No aplica"; null when the reading stands.
const QuotaReadingSchema = Type.Object(
  {
    pct: Nullable(Count),
    resetsAt: Nullable(Type.Number()),
    source: Type.Union([Type.Literal("api"), Type.Literal("estimated"), Type.Literal("none")]),
    readAt: Nullable(Type.Number()),
    stale: Type.Boolean(),
    state: Nullable(Type.String()),
    estimatedTokens: Nullable(Count),
  },
  { additionalProperties: false },
);

const FactoryQuotaSchema = Type.Object(
  {
    accounts: Type.Array(
      Type.Object(
        {
          // Opaque: never an e-mail or a file name.
          id: Type.String(),
          provider: Type.String(),
          // The account's model prefix, else its kind and opaque reference.
          label: Type.String(),
          kind: Nullable(Type.String()),
          plan: Nullable(Type.String()),
          // What the quota rule says about it, in words.
          state: Type.String(),
          groups: Type.Array(
            Type.Object(
              {
                // Null for an account the provider reports as one pool.
                name: Nullable(Type.String()),
                models: Type.Array(Type.String()),
                state: Type.String(),
                window5h: QuotaReadingSchema,
                weekly: QuotaReadingSchema,
              },
              { additionalProperties: false },
            ),
          ),
          successes: Count,
          failures: Count,
          // The agents on this account now.
          holders: Type.Array(Type.String()),
          // Null while no row of the usage log reported cached tokens.
          cachedTokens: Nullable(Count),
          inputTokens: Count,
          readAt: Nullable(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
    // Providers with nothing to show but why: no account is known of them.
    unread: Type.Array(
      Type.Object(
        { provider: Type.String(), state: Type.String() },
        { additionalProperties: false },
      ),
    ),
    thresholds: Type.Object(
      { switchAt5h: Count, stopAtWeekly: Count, warnPct: Count, dangerPct: Count },
      { additionalProperties: false },
    ),
    // The 5-hour use of each account's pools over time, oldest first; `key` is the account's id, and its pool's name.
    history: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          label: Type.String(),
          points: Type.Array(
            Type.Object({ at: Type.Number(), pct: Count }, { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
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
          // The agents whose work it waits for; empty when it waits for no agent.
          waitingFor: Type.Array(Type.String()),
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
    // A running turn that moved to another model or agent, oldest first.
    handoffs: Type.Array(
      Type.Object(
        {
          at: Type.Number(),
          workflowId: Type.String(),
          agent: Nullable(Type.String()),
          kind: Type.Union([Type.Literal("model"), Type.Literal("agent")]),
          from: Type.String(),
          to: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    quota: FactoryQuotaSchema,
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
