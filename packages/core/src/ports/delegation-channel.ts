// The agent <-> host channel of a workflow turn (docs/modos-y-delegacion.md 3.4, 3.5, 3.7; ADR-0021). Two halves:
//   - DelegationTurnInput: what the host tells a turn before it starts, as structured data built from the store. A
//     real agent receives it rendered into its prompt as data sections (buildAgentSpec); a fake agent reads it as is.
//   - DelegationToolHandler: how a running turn calls haril_delegate, haril_assign, haril_report, haril_verdict,
//     haril_request_audit and haril_abort. The agent proposes, the host validates (the tool contracts, checkDelegation,
//     checkVerdict) and answers { ok: true, ... } or { ok: false, reason }, and with a reason the agent corrects its
//     call in the same turn. Nothing is created while the turn runs: the accepted call is applied when the turn ends,
//     in the same transaction that closes it, so a crash never leaves half of it. The fake agent runtime calls the
//     handler directly; phase F2b wires Pi's bridge tools to the same handler. Phase F8 adds the workspace tools of a
//     turn that writes in a git worktree (write, edit, haril_run, haril_merge, haril_merge_continue, haril_merge_abort):
//     the host does them inside the worktree and answers once they are done.
import type { DelegationToolReply, Difficulty } from "@haril/contracts";
import type { DelegationRole, WorkflowIntake } from "./delegation.js";

export interface DelegationVerdictView {
  readonly verdict: "approved" | "rejected";
  readonly reasons: readonly {
    readonly criterion: string;
    readonly ok: boolean;
    readonly evidence: string;
  }[];
}

// What one child of a thread ended with, as its parent's continuation reads it. Executors (children of a delegator):
// approved, escalated (both attempts rejected; the delegator may reformulate it once), failed, or blocked (it never ran
// because a step it depends on failed or was escalated). Delegators (children of the orchestrator): done, partial or
// failed as their report says; failed also when one ended without a report.
export interface DelegationChildOutcome {
  readonly localId: string;
  readonly role: "delegator" | "executor";
  readonly goal: string;
  readonly status: "approved" | "escalated" | "failed" | "blocked" | "done" | "partial";
  // A delegator's report summary, or an executor's latest result text. Written by an agent: data, not instructions.
  readonly summary: string | null;
  readonly issues: readonly string[];
  // The verdicts on an executor's attempts, oldest first.
  readonly verdicts: readonly DelegationVerdictView[];
  readonly retries: number;
  readonly escalations: number;
  // This thread already reassigned it once (a reformulation, or the reassignment of a blocked step).
  readonly reassigned: boolean;
  // What a parent needs to decide after a failure; absent or null when the child did not fail.
  readonly failure?: DelegationFailurePackage | null;
}

// A failed child, returned to its parent: the error, what was tried and what was done.
export interface DelegationFailurePackage {
  readonly code: string;
  readonly message: string;
  readonly tried: readonly {
    readonly model: string | null;
    readonly outcome: string;
  }[];
  readonly done: string | null;
}

// A person's message to an agent (haril factory message), as its next turn reads it. Written by a person, so it is an
// instruction to this agent; the prompt tells it to report the correction to its parent.
export interface DelegationMessageView {
  readonly id: string;
  readonly text: string;
  readonly urgent: boolean;
}

// What an agent left when another one took its task over (feature haril-factory, F7).
export interface DelegationHandoffView {
  readonly from: string;
  readonly reason: string;
  readonly objective: string;
  readonly done: string | null;
  readonly pending: readonly string[];
  readonly decisions: string | null;
  readonly filesTouched: readonly string[];
  readonly diffSummary: string | null;
  // Where the whole conversation of the agent that left is kept; null when the runtime has none.
  readonly transcript: string | null;
}

// One councillor's opinion, as the sintetizador reads it: it has no tools, so everything comes in its prompt.
export interface DelegationOpinionView {
  readonly localId: string;
  readonly model: string | null;
  readonly text: string;
}

// What the orchestrator said when it asked for the final audit (haril_request_audit): its summary and what it knows is
// still open. Written by an agent: data, not instructions.
export interface DelegationAuditRequest {
  readonly summary: string;
  readonly outstanding: readonly string[];
}

// What an auditor judges: one executor's result against its criteria, or the whole workflow at the end.
export interface DelegationSubject {
  readonly scope: "task" | "workflow";
  readonly label: string;
  readonly goal: string;
  // The executor's result text (task scope); null when it stored none.
  readonly result: string | null;
  // The delegators' outcomes (workflow scope).
  readonly reports: readonly DelegationChildOutcome[];
  // The orchestrator's audit request (workflow scope); null for a task audit or when none was recorded.
  readonly request: DelegationAuditRequest | null;
}

// A sibling task running around this one (R-D4): its goal and write surface, as data.
export interface DelegationSibling {
  readonly localId: string;
  readonly goal: string;
  readonly writeSurface: readonly string[];
  readonly state: "queued" | "running" | "done" | "failed";
}

export interface DelegationLiveCount {
  readonly live: number;
  readonly max: number;
}

// The capacity section (3.11): the limits that bound what this turn may propose, and the models its children may use.
export interface DelegationCapacity {
  // Children of this thread that may run at once; null for a role without children.
  readonly activeChildrenMax: number | null;
  readonly queuedChildrenMax: number;
  readonly proposalsLeft: number;
  readonly agentsLeft: number;
  readonly tokensLeft: number;
  readonly live: {
    readonly executors: DelegationLiveCount;
    readonly auditors: DelegationLiveCount;
    readonly delegators: DelegationLiveCount;
  };
  // Models a child of this thread may run on: the cost tier when known, and the quota rule's answer ("no_data" says
  // "sin dato").
  readonly models: readonly {
    readonly ref: string;
    readonly costTier: number | null;
    readonly quota: "ok" | "no_data" | "blocked";
  }[];
}

export type DelegationTurnKind = "first" | "continuation" | "relaunch" | "reformulation";

// A turn of a workflow that writes in git worktrees (phase F8, docs/modos-y-delegacion.md 3.10): which branch its tools
// work on and what it may do there. Every name in it comes from the host (branches, the allow list) or from git (the
// conflicting files of a merge), never from an agent's text.
export interface DelegationWorkspaceView {
  // executor: the step's own branch and worktree; audit: the executor's branch it judges, read-only; integration: the
  // workflow's integration branch (a delegator, the final auditor and the turns that only read).
  readonly kind: "executor" | "audit" | "integration";
  readonly branch: string;
  // The branch every worktree of the workflow starts from (P13), as the workflow fixed it.
  readonly baseBranch: string;
  // The globs an executor may write (its files.write); empty for every other turn.
  readonly writeSurface: readonly string[];
  // The commands haril_run accepts, as the allow list spells them.
  readonly commands: readonly string[];
  // A delegator: its approved steps whose branch holds work not merged into the integration branch yet, by local id.
  readonly unmerged: readonly string[];
  // A delegator: the merge left waiting for its conflicts, if any.
  readonly conflict: { readonly localId: string; readonly files: readonly string[] } | null;
}

export interface DelegationTurnInput {
  readonly workflowId: string;
  readonly workflowGoal: string;
  readonly intake?: WorkflowIntake | null;
  readonly role: DelegationRole;
  readonly layer: 1 | 2 | 3;
  readonly threadId: string;
  // A stable name of the node: "orchestrator", "part-1", "part-1/step-2", "audit of part-1/step-2", "final audit".
  readonly label: string;
  readonly localId: string | null;
  // This turn's place in its thread, from 1, and why it runs.
  readonly turn: number;
  readonly turnKind: DelegationTurnKind;
  readonly goal: string;
  readonly instructions: string;
  readonly difficulty: Difficulty | null;
  // The memo this thread wrote with its last proposal (3.7); it comes back in its continuation.
  readonly memo: string | null;
  readonly acceptanceCriteria: readonly string[];
  readonly tests: string | null;
  readonly files: { readonly write: readonly string[]; readonly read: readonly string[] };
  // A continuation: what each child of this thread ended with.
  readonly children: readonly DelegationChildOutcome[];
  // An executor's relaunch or reformulation: the verdicts that rejected earlier attempts of its thread, oldest first.
  readonly previousVerdicts: readonly DelegationVerdictView[];
  readonly subject: DelegationSubject | null;
  // An orchestrator turn after the final audit rejected the workflow: that verdict.
  readonly finalAudit: DelegationVerdictView | null;
  readonly siblings: readonly DelegationSibling[];
  readonly capacity: DelegationCapacity;
  // A turn of a workflow that writes (phase F8); absent or null for a read-only workflow.
  readonly workspace?: DelegationWorkspaceView | null;
  // The role profile its proposal named (delegation.roles); absent or null when it named none.
  readonly roleName?: string | null;
  readonly messages?: readonly DelegationMessageView[];
  readonly handoff?: DelegationHandoffView | null;
  readonly opinions?: readonly DelegationOpinionView[];
}

// The run a tool call comes from: only a workflow turn the runtime opened may call, and only for itself.
export interface DelegationToolContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
}

export type DelegationToolResult = DelegationToolReply<Readonly<Record<string, unknown>>>;

// The tool name and its input come from the agent: both are untrusted and checked by the handler. A deciding call is
// answered at once; a workspace tool (write, edit, haril_run, haril_merge and its continue and abort, phase F8) is
// answered when the host finished it, so its reply is a promise.
export type DelegationToolHandler = (
  context: DelegationToolContext,
  tool: string,
  input: unknown,
) => DelegationToolResult | Promise<DelegationToolResult>;
