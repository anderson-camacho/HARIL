// The delegation module of the Store (docs/modos-y-delegacion.md 4.2, 4.3; ADR-0021): workflows, the turns of their
// threads, the applied proposals and the auditor verdicts. The Core decides (checkDelegation, chooseModel, the rework
// machine, the stop rule); the store only records what was decided, in one transaction per decision, and refuses what
// would break its own invariants (a workflow that ended, a turn whose role, layer and kind disagree, a
// dependency outside the workflow). Every runtime write is fenced by its epoch.
import type {
  BlockReason,
  Difficulty,
  Stop,
  TaskKind,
  TaskState,
  WorkflowState,
} from "@haril/contracts";
import type { JsonObject } from "./store.js";

export type DelegationRole = "orchestrator" | "delegator" | "executor" | "auditor";
export type DependencyKind = "completed" | "settled";

export interface WorkflowAutonomy {
  readonly mode: "autonomous" | "stops";
  readonly stops: readonly Stop[];
}

export interface WorkflowRecord {
  readonly workflowId: string;
  readonly projectId: string;
  // The orchestrator's first turn.
  readonly rootTaskId: string | null;
  readonly goal: string;
  readonly state: WorkflowState;
  readonly autonomy: WorkflowAutonomy;
  // The limits snapshot taken when the workflow started (P11).
  readonly limits: JsonObject;
  readonly orchestratorModel: string;
  readonly agentsCreated: number;
  readonly stopReason: string | null;
  readonly baseBranch: string | null;
  readonly baseSha: string | null;
  // A simulated workflow (haril workflow demo).
  readonly simulated: boolean;
  // The order (usage log, 4.5) behind a workflow started from the CLI; null otherwise.
  readonly orderId: string | null;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

export interface WorkflowTaskRecord {
  readonly taskId: string;
  readonly workflowId: string;
  readonly threadId: string;
  // A task of the parent thread (null for the orchestrator).
  readonly parentTaskId: string | null;
  readonly role: DelegationRole;
  readonly layer: 1 | 2 | 3;
  readonly kind: TaskKind;
  readonly localId: string | null;
  readonly delegationId: string | null;
  readonly goal: string;
  readonly description: string;
  readonly state: TaskState;
  readonly blockReason: BlockReason | null;
  readonly agentRef: string;
  readonly model: string | null;
  readonly modelPinned: boolean;
  readonly difficulty: Difficulty | null;
  readonly difficultyReason: string | null;
  readonly priority: number;
  readonly createdSeq: number;
  readonly attempt: number;
  readonly budgetTokens: number;
  readonly timeoutMs: number;
  readonly surfaceWrite: readonly string[];
  readonly surfaceRead: readonly string[];
  readonly result: JsonObject | null;
  readonly nextCheckAt: number | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly dependsOn: readonly { readonly taskId: string; readonly kind: DependencyKind }[];
}

export interface DelegationRecord {
  readonly delegationId: string;
  readonly workflowId: string;
  readonly threadId: string;
  readonly parentTaskId: string | null;
  readonly proposedByRunId: string | null;
  readonly tool: "haril_delegate" | "haril_assign" | "haril_request_audit";
  readonly payloadHash: string;
  readonly memo: string | null;
  // The proposal as the agent sent it (its tool input), so its criteria, tests and files outlive a restart; null for a
  // proposal recorded before schema 10.
  readonly payload: JsonObject | null;
  readonly createdAt: number;
}

export interface AuditReason {
  readonly criterion: string;
  readonly ok: boolean;
  readonly evidence: string;
}

// What the rework machine did with a verdict (3.8).
export type ReworkActionRecord = "accept" | "retry" | "escalate" | "fail" | "ignore";

export interface AuditRecord {
  readonly auditId: string;
  readonly workflowId: string;
  // The executor turn it judged; null for the final, workflow-wide audit.
  readonly subjectTaskId: string | null;
  readonly auditorTaskId: string;
  readonly scope: "task" | "workflow";
  readonly verdict: "approved" | "rejected";
  readonly reasons: readonly AuditReason[];
  readonly reworkAction: ReworkActionRecord | null;
  readonly createdAt: number;
}

// One turn to create. A reference (parentTaskId, dependsOn, inherit) is either a task id of the workflow or the key of
// an earlier turn of the same call.
export interface NewTurn {
  readonly key: string;
  // An existing thread of the workflow (a continuation, a retry, a reformulation), or null for a new thread.
  readonly threadId: string | null;
  readonly role: DelegationRole;
  readonly layer: 1 | 2 | 3;
  readonly kind: TaskKind;
  readonly parentTaskId: string | null;
  readonly localId: string | null;
  readonly goal: string;
  readonly description: string;
  readonly agentRef: string;
  readonly model: string | null;
  readonly modelPinned: boolean;
  readonly difficulty: Difficulty | null;
  readonly difficultyReason: string | null;
  readonly priority: number;
  readonly budgetTokens: number;
  readonly timeoutMs: number;
  readonly surfaceWrite: readonly string[];
  readonly surfaceRead: readonly string[];
  readonly dependsOn: readonly { readonly on: string; readonly kind: DependencyKind }[];
}

export interface ApplyTurnsInput {
  readonly workflowId: string;
  readonly turns: readonly NewTurn[];
  // A thread's dependents wait for its latest turn: every pending task that depends on `from` (except the listed ones)
  // depends on `to` instead, with the same kind. A relaunch thus keeps a dependent of a failed (closed) turn waiting
  // instead of blocking it; the earlier turn's own auditor is excepted and settles with it.
  readonly inherit?: readonly {
    readonly from: string;
    readonly to: string;
    readonly except?: readonly string[];
  }[];
  // The applied proposal behind these turns (delegation.apply). Recorded once per workflow, thread and payload hash:
  // a replay after a restart creates nothing and returns created: false (3.8 rule 6).
  readonly delegation?: {
    readonly threadId: string;
    readonly parentTaskId: string | null;
    readonly proposedByRunId: string | null;
    readonly tool: DelegationRecord["tool"];
    readonly payloadHash: string;
    readonly memo: string | null;
    readonly payload?: JsonObject;
  };
  // Stops the proposal added (3.13: an agent only adds; checkDelegation already refused a removal).
  readonly addStops?: readonly Stop[];
}

export interface ApplyTurnsResult {
  readonly created: boolean;
  readonly delegationId: string | null;
  // Task and thread ids by turn key; empty for a replay (read them with tasks()).
  readonly taskIds: Readonly<Record<string, string>>;
  readonly threadIds: Readonly<Record<string, string>>;
}

export interface RecordAuditInput {
  readonly workflowId: string;
  readonly subjectTaskId: string | null;
  readonly auditorTaskId: string;
  readonly scope: "task" | "workflow";
  readonly verdict: "approved" | "rejected";
  readonly reasons: readonly AuditReason[];
  readonly reworkAction: ReworkActionRecord | null;
}

export interface SetWorkflowStateInput {
  readonly workflowId: string;
  // running -> awaiting_human | completed | failed | stopped; awaiting_human -> failed | stopped. Only the human's
  // workflow.continue command takes awaiting_human back to running.
  readonly state: Exclude<WorkflowState, "running">;
  // The stop reached, the failure reason (no_capacity, stalled, aborted...) or the stop request.
  readonly reason?: string;
}

export interface WorkflowFilter {
  readonly projectId?: string;
  readonly state?: WorkflowState;
}

export interface WorkflowsPort {
  get(workflowId: string): WorkflowRecord | undefined;
  // Newest first.
  list(filter?: WorkflowFilter): readonly WorkflowRecord[];
  // Every turn of the workflow in creation order, with its dependencies.
  tasks(workflowId: string): readonly WorkflowTaskRecord[];
  delegations(workflowId: string): readonly DelegationRecord[];
  audits(workflowId: string): readonly AuditRecord[];
  // Refused for a workflow that ended (completed, failed, stopped). A workflow that waits for the human still takes
  // turns: an attempt that ends meanwhile records what follows it, and the turns run once the human continues it.
  applyTurns(epoch: number, input: ApplyTurnsInput): ApplyTurnsResult;
  // A second verdict for the same auditor turn is store.conflict.
  recordAudit(epoch: number, input: RecordAuditInput): AuditRecord;
  setState(epoch: number, input: SetWorkflowStateInput): WorkflowRecord;
  // The watchdog's next evaluation of a turn (3.16), kept across restarts; null clears it.
  scheduleCheck(epoch: number, taskId: string, at: number | null): void;
  // The turns that could still run (pending, ready, running) in workflows that ended (completed, failed, stopped):
  // nothing will consume their result, so the watchdog cancels them as residual (3.16). A blocked turn can never run
  // and keeps its state as history. Oldest first.
  strandedTurns(): readonly StrandedTurn[];
}

export interface StrandedTurn {
  readonly taskId: string;
  readonly workflowId: string;
  readonly state: TaskState;
}
