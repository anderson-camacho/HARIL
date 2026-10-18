import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { TaskIdSchema } from "./primitives.js";

// Tool contracts of the three-layer delegation (docs/modos-y-delegacion.md 3.5, ADR-0021). Agents call these tools
// through the Pi bridge; the Core validates what they propose and the Runtime creates the tasks. The schemas check
// shape only: limits, depth, models and graph rules live in @haril/core (checkDelegation), so they stay configurable.
// Every tool answers the agent with { ok: true, ... } or { ok: false, reason }, and with a reason the agent corrects
// its call and tries again in the same turn, as with haril_propose_plan.

export const DELEGATION_TOOL_NAMES = [
  "haril_delegate",
  "haril_assign",
  "haril_report",
  "haril_verdict",
  "haril_request_audit",
  "haril_abort",
  "haril_run",
  "haril_merge",
] as const;
export type DelegationToolName = (typeof DELEGATION_TOOL_NAMES)[number];

export function isDelegationToolName(value: string): value is DelegationToolName {
  return (DELEGATION_TOOL_NAMES as readonly string[]).includes(value);
}

// The five difficulty classes of the rubric in the parent's prompt, from easiest to hardest (3.11).
export const DIFFICULTIES = ["trivial", "easy", "medium", "hard", "expert"] as const;
export const DifficultySchema = Type.Union([
  Type.Literal("trivial"),
  Type.Literal("easy"),
  Type.Literal("medium"),
  Type.Literal("hard"),
  Type.Literal("expert"),
]);
export type Difficulty = Static<typeof DifficultySchema>;

// The memo is a note to the agent's future self; it comes back in its continuation (3.5).
export const MEMO_MAX_LENGTH = 2000;

// Same pattern as a plan task's local id (plan.ts), so a delegated node can later become a plan task.
const LOCAL_ID_PATTERN = "^[A-Za-z0-9_-]{1,64}$";
const LocalIdSchema = Type.String({ pattern: LOCAL_ID_PATTERN });

// Closed stop vocabulary of 3.13: after_plan, after_node:<localId>, before_merge, on_audit_failure,
// on_budget_pct:<1..100> and at_end. Adding a stop is a vocabulary change and needs an ADR.
export const STOP_PATTERN =
  "^(after_plan|before_merge|on_audit_failure|at_end|after_node:[A-Za-z0-9_-]{1,64}|on_budget_pct:(100|[1-9][0-9]?))$";
const STOP_REGEX = new RegExp(STOP_PATTERN);
export const StopSchema = Type.String({ pattern: STOP_PATTERN });
export type Stop = Static<typeof StopSchema>;

export function isStop(value: unknown): value is Stop {
  return typeof value === "string" && STOP_REGEX.test(value);
}

// A checkpoint in a proposal adds a stop. The { remove } form exists only so the Core can refuse it with the typed
// reason checkpoint_removes_stop: an agent may add stops, only the human removes them (3.13, rule 5).
export const CheckpointRequestSchema = Type.Union([
  StopSchema,
  Type.Object({ remove: StopSchema }, { additionalProperties: false }),
]);
export type CheckpointRequest = Static<typeof CheckpointRequestSchema>;

const NonEmptyText = Type.String({ minLength: 1 });

// A surface glob is relative to the worktree: no absolute path (a leading "/" or "\", a drive letter, a UNC share), no
// ".." segment, and no leading or trailing whitespace (which would hide a parent segment or an absolute path from the
// other two rules: " ../x"). Its length and the number of globs in a list are bounded, so the overlap check of 3.10
// always runs on small input; globsMayOverlap also answers "overlap" on anything longer.
export const GLOB_MAX_LENGTH = 512;
export const SURFACE_MAX_ITEMS = 64;
export const GLOB_PATTERN =
  "^(?!\\s)(?![\\s\\S]*\\s$)(?![A-Za-z]:)(?![/\\\\])(?!(?:.*[/\\\\])?\\.\\.(?:[/\\\\]|$)).+$";
const GlobSchema = Type.String({ minLength: 1, maxLength: GLOB_MAX_LENGTH, pattern: GLOB_PATTERN });
const SurfaceSchema = Type.Array(GlobSchema, { maxItems: SURFACE_MAX_ITEMS });
// The parent's model preference; the Core validates it (3.11). Absent or null means "let the table choose".
const ModelPreferenceSchema = Type.Optional(
  Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
);
const ChildBudgetSchema = Type.Object(
  { maxTokens: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
// Fixed before the work starts, so the auditor judges against them and not against its taste (3.8, rule 1).
const AcceptanceCriteriaSchema = Type.Array(NonEmptyText, { minItems: 1 });

// haril_delegate: orchestrator (layer 1) -> delegators (layer 2). dependsOn expresses sequence; no dependency means
// the nodes may run in parallel. Up to maxQueuedTasksPerThread are registered; only maxActiveChildren run at once.
export const DelegationSchema = Type.Object(
  {
    localId: LocalIdSchema,
    goal: NonEmptyText,
    description: Type.String(),
    difficulty: DifficultySchema,
    difficultyReason: NonEmptyText,
    dependsOn: Type.Array(LocalIdSchema),
    priority: Type.Integer({ minimum: 0, maximum: 9 }),
    acceptanceCriteria: AcceptanceCriteriaSchema,
    model: ModelPreferenceSchema,
    budget: ChildBudgetSchema,
  },
  { additionalProperties: false },
);
export type Delegation = Static<typeof DelegationSchema>;

export const DelegateInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    memo: Type.String({ maxLength: MEMO_MAX_LENGTH }),
    delegations: Type.Array(DelegationSchema, { minItems: 1 }),
    checkpoints: Type.Optional(Type.Array(CheckpointRequestSchema)),
  },
  { additionalProperties: false },
);
export type DelegateInput = Static<typeof DelegateInputSchema>;

// haril_assign: delegator (layer 2) -> executors (layer 3). files.write is the surface that feeds the surface locks
// (3.10); an empty write list is a read-only executor. The Core creates each executor together with its auditor.
export const AssignmentSchema = Type.Object(
  {
    localId: LocalIdSchema,
    goal: NonEmptyText,
    instructions: NonEmptyText,
    files: Type.Object(
      { write: SurfaceSchema, read: SurfaceSchema },
      { additionalProperties: false },
    ),
    tests: Type.String(),
    acceptanceCriteria: AcceptanceCriteriaSchema,
    difficulty: DifficultySchema,
    difficultyReason: NonEmptyText,
    dependsOn: Type.Array(LocalIdSchema),
    model: ModelPreferenceSchema,
    budget: ChildBudgetSchema,
  },
  { additionalProperties: false },
);
export type Assignment = Static<typeof AssignmentSchema>;

export const AssignInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    memo: Type.String({ maxLength: MEMO_MAX_LENGTH }),
    assignments: Type.Array(AssignmentSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type AssignInput = Static<typeof AssignInputSchema>;

// haril_report: the delegator's continuation closes its node with a short structured summary that fits the parent's
// prompt; the full result stays readable with `haril task show` (3.7).
export const ReportInputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("done"), Type.Literal("partial"), Type.Literal("failed")]),
    summary: NonEmptyText,
    issues: Type.Array(NonEmptyText),
  },
  { additionalProperties: false },
);
export type ReportInput = Static<typeof ReportInputSchema>;

// haril_verdict: the auditor's structured verdict. Each reason cites the criterion it judges; the Core refuses a
// rejection without a failing reason (verdict_without_reason, 3.8 rule 5).
export const VerdictReasonSchema = Type.Object(
  { criterion: NonEmptyText, ok: Type.Boolean(), evidence: Type.String() },
  { additionalProperties: false },
);
export const VerdictInputSchema = Type.Object(
  { approved: Type.Boolean(), reasons: Type.Array(VerdictReasonSchema) },
  { additionalProperties: false },
);
export type VerdictInput = Static<typeof VerdictInputSchema>;

// haril_request_audit: the orchestrator has nothing pending; the Core creates the final, workflow-wide auditor.
export const RequestAuditInputSchema = Type.Object(
  { summary: NonEmptyText, outstanding: Type.Array(NonEmptyText) },
  { additionalProperties: false },
);
export type RequestAuditInput = Static<typeof RequestAuditInputSchema>;

// haril_abort: the orchestrator ends the workflow as failed.
export const AbortInputSchema = Type.Object(
  { reason: NonEmptyText },
  { additionalProperties: false },
);
export type AbortInput = Static<typeof AbortInputSchema>;

// haril_run: one command from delegation.commands.allow, run by the host (never by Pi) in the agent's worktree with a
// time limit, an output limit and a clean environment (3.10). The spec fixes no shape; this one is provisional.
export const RunInputSchema = Type.Object(
  { command: NonEmptyText, args: Type.Optional(Type.Array(Type.String())) },
  { additionalProperties: false },
);
export type RunInput = Static<typeof RunInputSchema>;

// haril_merge: the delegator integrates one executor's branch into the workflow's integration branch; the host runs
// `git merge --no-ff` and answers with the conflicting files, if any (3.10, phase F8).
export const MergeInputSchema = Type.Object(
  { taskId: TaskIdSchema },
  { additionalProperties: false },
);
export type MergeInput = Static<typeof MergeInputSchema>;

const TOOL_SCHEMAS = {
  haril_delegate: DelegateInputSchema,
  haril_assign: AssignInputSchema,
  haril_report: ReportInputSchema,
  haril_verdict: VerdictInputSchema,
  haril_request_audit: RequestAuditInputSchema,
  haril_abort: AbortInputSchema,
  haril_run: RunInputSchema,
  haril_merge: MergeInputSchema,
} as const;

export type DelegationToolInputs = {
  readonly [K in DelegationToolName]: Static<(typeof TOOL_SCHEMAS)[K]>;
};

export type DelegationToolInputValidation<T extends DelegationToolName> =
  | { readonly ok: true; readonly tool: T; readonly input: DelegationToolInputs[T] }
  | { readonly ok: false; readonly errors: string[] };

// What a tool answers the agent: success with its fields, or a reason the agent can act on.
export type DelegationToolReply<T extends object = Record<never, never>> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly reason: string };

// Schema-level check of a tool call's untrusted arguments, as validatePlanSchema does for plans. A name outside the
// vocabulary is refused here instead of throwing, because the name also comes from the agent.
export function validateDelegationToolInput<T extends DelegationToolName>(
  tool: T,
  value: unknown,
): DelegationToolInputValidation<T> {
  if (!isDelegationToolName(tool)) {
    return { ok: false, errors: [`/: unknown tool "${String(tool)}"`] };
  }
  const schema = TOOL_SCHEMAS[tool];
  if (Value.Check(schema, value)) {
    return { ok: true, tool, input: value as DelegationToolInputs[T] };
  }
  const errors = Value.Errors(schema, value).map(
    (error) => `${error.instancePath || "/"}: ${error.message}`,
  );
  return { ok: false, errors };
}
