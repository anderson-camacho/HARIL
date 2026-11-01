import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { DifficultySchema } from "./delegation.js";

// WorkflowSnapshot v1 (docs/ADR-0021): what `haril workflow show <id> --json` returns and what the orchestration view
// draws. This is the canonical definition; integrations/pi-console keeps a local copy because it imports no other
// workspace (check-layers R6), so a change here must be mirrored there. null always means "not available": the view
// says so and never invents a value.

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Count = Type.Number({ minimum: 0 });
const Percent = Nullable(Type.Number());

export const WorkflowStateSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("awaiting_human"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
]);
export type WorkflowState = Static<typeof WorkflowStateSchema>;

export const WorkflowNodeStateSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("waiting"),
  Type.Literal("queued"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("awaiting_human"),
  Type.Literal("closed"),
]);

export const WorkflowNodeRoleSchema = Type.Union([
  Type.Literal("orchestrator"),
  Type.Literal("delegator"),
  Type.Literal("executor"),
  Type.Literal("auditor"),
]);

export const ModelSourceSchema = Type.Union([
  Type.Literal("pinned"),
  Type.Literal("parent"),
  Type.Literal("table"),
]);

// Why something is where it is, in words for the person (core's explainWait). Built from stored facts only.
export const WaitExplanationSchema = Type.Object(
  {
    code: Type.String(),
    what: Type.String(),
    why: Type.String(),
    systemAction: Type.String(),
    needsHuman: Type.Boolean(),
    // When the wait ends by itself, if that is known.
    until: Nullable(Type.Number()),
  },
  { additionalProperties: false },
);
export type WaitExplanation = Static<typeof WaitExplanationSchema>;

const WorkflowNodeSchema = Type.Object(
  {
    id: Type.String(),
    parentId: Nullable(Type.String()),
    auditedId: Type.Optional(Nullable(Type.String())),
    threadId: Type.String(),
    depth: Count,
    layer: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    role: WorkflowNodeRoleSchema,
    label: Type.String(),
    goal: Type.String(),
    state: WorkflowNodeStateSchema,
    model: Type.String(),
    modelSource: ModelSourceSchema,
    thinkingLevel: Nullable(Type.String()),
    tokens: Count,
    elapsedMs: Nullable(Count),
    lastProgress: Nullable(
      Type.Object({ at: Type.Number(), text: Type.String() }, { additionalProperties: false }),
    ),
    nextCheckAt: Nullable(Type.Number()),
    context: Nullable(
      Type.Object({ used: Count, threshold: Count }, { additionalProperties: false }),
    ),
    quota: Nullable(
      Type.Object({ window5hPct: Percent, weeklyPct: Percent }, { additionalProperties: false }),
    ),
    difficulty: Nullable(
      Type.Object(
        { estimated: DifficultySchema, reason: Type.String() },
        { additionalProperties: false },
      ),
    ),
    files: Type.Object(
      { write: Type.Array(Type.String()), read: Type.Array(Type.String()) },
      { additionalProperties: false },
    ),
    memo: Nullable(Type.String()),
    audit: Nullable(
      Type.Object(
        {
          verdict: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
          summary: Type.String(),
          retries: Count,
        },
        { additionalProperties: false },
      ),
    ),
    waitingReason: Nullable(Type.String()),
    explanation: Type.Optional(WaitExplanationSchema),
    turn: Nullable(Type.Object({ index: Count, of: Count }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);
export type WorkflowNode = Static<typeof WorkflowNodeSchema>;

const LiveMax = Type.Object({ live: Count, max: Count }, { additionalProperties: false });

// A workflow that writes in git worktrees (phase F8, docs/modos-y-delegacion.md 3.10): the base branch and the commit it
// started from, and the integration branch the delegators merged into, which is the result the user reviews. Absent or
// null for a read-only workflow.
export const WorkflowGitSchema = Type.Object(
  {
    baseBranch: Type.String(),
    baseSha: Type.String(),
    integrationBranch: Type.String(),
    // The integration branch's last merge; null while nothing is merged.
    integrationHead: Nullable(Type.String()),
    // Steps merged into the integration branch.
    merged: Count,
    // Step branches that hold work not merged (kept for the user when the workflow ended).
    unmerged: Type.Array(Type.String()),
    // Worktrees that still exist.
    worktrees: Count,
  },
  { additionalProperties: false },
);
export type WorkflowGit = Static<typeof WorkflowGitSchema>;

export const WorkflowSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    demo: Type.Boolean(),
    workflow: Type.Object(
      {
        id: Type.String(),
        goal: Type.String(),
        state: WorkflowStateSchema,
        startedAt: Type.Number(),
        elapsedMs: Count,
        autonomy: Type.Object(
          {
            mode: Type.Union([Type.Literal("autonomous"), Type.Literal("stops")]),
            stops: Type.Array(Type.String()),
          },
          { additionalProperties: false },
        ),
        orchestratorModel: Type.String(),
        // The stop or the failure it is in; additive, a reader that does not know them still reads v1.
        stopReason: Type.Optional(Nullable(Type.String())),
        explanation: Type.Optional(WaitExplanationSchema),
      },
      { additionalProperties: false },
    ),
    git: Type.Optional(Nullable(WorkflowGitSchema)),
    totals: Type.Object(
      {
        tokensUsed: Count,
        tokensBudget: Nullable(Count),
        agentsCreated: Count,
        agentsCap: Count,
        queued: Count,
        retries: Count,
        escalations: Count,
      },
      { additionalProperties: false },
    ),
    capacity: Type.Object(
      { executors: LiveMax, auditors: LiveMax, delegators: LiveMax },
      { additionalProperties: false },
    ),
    nodes: Type.Array(WorkflowNodeSchema),
    quota: Type.Array(
      Type.Object(
        {
          provider: Type.String(),
          credential: Type.String(),
          window5hPct: Percent,
          weeklyPct: Percent,
          resetAt: Nullable(Type.Number()),
          note: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    events: Type.Array(
      Type.Object(
        { at: Type.Number(), type: Type.String(), text: Type.String() },
        { additionalProperties: false },
      ),
    ),
    usage: Type.Array(
      Type.Object(
        {
          at: Type.Number(),
          kind: Type.Union([Type.Literal("chat"), Type.Literal("agent_run")]),
          role: Type.String(),
          model: Type.String(),
          tokensIn: Nullable(Count),
          tokensOut: Nullable(Count),
          durationMs: Nullable(Count),
          difficulty: Nullable(Type.String()),
          outcome: Nullable(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type WorkflowSnapshot = Static<typeof WorkflowSnapshotSchema>;

export type WorkflowSnapshotValidation =
  | { readonly ok: true; readonly snapshot: WorkflowSnapshot }
  | { readonly ok: false; readonly errors: string[] };

// Schema-level check of a snapshot read from the CLI's JSON output (or written by a test or demo).
export function validateWorkflowSnapshot(value: unknown): WorkflowSnapshotValidation {
  if (Value.Check(WorkflowSnapshotSchema, value)) return { ok: true, snapshot: value };
  const errors = Value.Errors(WorkflowSnapshotSchema, value).map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
  return { ok: false, errors };
}
