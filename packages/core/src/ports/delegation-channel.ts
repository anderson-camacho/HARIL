// The agent <-> host channel of a workflow turn (docs/modos-y-delegacion.md 3.4, 3.5, 3.7; ADR-0021). Two halves:
//   - DelegationTurnInput: what the host tells a turn before it starts, as structured data built from the store. A
//     real agent receives it rendered into its prompt as data sections (buildAgentSpec); a fake agent reads it as is.
//   - DelegationToolHandler: how a running turn calls haril_delegate, haril_assign, haril_report, haril_verdict,
//     haril_request_audit and haril_abort. The agent proposes, the host validates (the tool contracts, checkDelegation,
//     checkVerdict) and answers { ok: true, ... } or { ok: false, reason }, and with a reason the agent corrects its
//     call in the same turn. Nothing is created while the turn runs: the accepted call is applied when the turn ends,
//     in the same transaction that closes it, so a crash never leaves half of it. The fake agent runtime calls the
//     handler directly; phase F2b wires Pi's bridge tools to the same handler.
import type { DelegationToolReply, Difficulty } from "@haril/contracts";
import type { DelegationRole } from "./delegation.js";

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

export interface DelegationTurnInput {
  readonly workflowId: string;
  readonly workflowGoal: string;
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
}

// The run a tool call comes from: only a workflow turn the runtime opened may call, and only for itself.
export interface DelegationToolContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly runId: string;
}

export type DelegationToolResult = DelegationToolReply<Readonly<Record<string, unknown>>>;

// The tool name and its input come from the agent: both are untrusted and checked by the handler.
export type DelegationToolHandler = (
  context: DelegationToolContext,
  tool: string,
  input: unknown,
) => DelegationToolResult;
