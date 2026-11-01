// WorkflowSnapshot v1 (docs/ADR-0021): the data the ORCHESTRATION view draws. `haril workflow show <id> --json` and
// each line of `haril workflow watch <id>` print it (orchestration-feed.ts reads them), and the demo data
// (orchestration-demo.ts) produces it too. This is a local copy because the console imports nothing from other
// workspaces (check-layers R6). `null` always means "not available": the view says so and never invents a value.

export type WorkflowState = "running" | "awaiting_human" | "completed" | "failed" | "stopped";

type NodeRole = "orchestrator" | "delegator" | "executor" | "auditor";

export type NodeState =
  | "running"
  | "waiting"
  | "queued"
  | "done"
  | "failed"
  | "cancelled"
  | "awaiting_human"
  | "closed";

type ModelSource = "pinned" | "parent" | "table";

type DifficultyLevel = "trivial" | "easy" | "medium" | "hard" | "expert";

type UsageKind = "chat" | "agent_run";

// Why something is where it is, in words for the person, as core's explainWait writes it.
export interface WaitExplanation {
  readonly code: string;
  readonly what: string;
  readonly why: string;
  readonly systemAction: string;
  readonly needsHuman: boolean;
  readonly until: number | null;
}

export interface WorkflowNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly auditedId?: string | null;
  readonly threadId: string;
  readonly depth: number;
  readonly layer: 1 | 2 | 3;
  readonly role: NodeRole;
  readonly label: string;
  readonly goal: string;
  readonly state: NodeState;
  readonly model: string;
  readonly modelSource: ModelSource;
  readonly thinkingLevel: string | null;
  readonly tokens: number;
  readonly elapsedMs: number | null;
  readonly lastProgress: { readonly at: number; readonly text: string } | null;
  readonly nextCheckAt: number | null;
  readonly context: { readonly used: number; readonly threshold: number } | null;
  readonly quota: { readonly window5hPct: number | null; readonly weeklyPct: number | null } | null;
  readonly difficulty: { readonly estimated: DifficultyLevel; readonly reason: string } | null;
  readonly files: { readonly write: readonly string[]; readonly read: readonly string[] };
  readonly memo: string | null;
  readonly audit: {
    readonly verdict: "approved" | "rejected";
    readonly summary: string;
    readonly retries: number;
  } | null;
  readonly waitingReason: string | null;
  readonly explanation?: WaitExplanation;
  readonly turn: { readonly index: number; readonly of: number } | null;
}

export interface QuotaRow {
  readonly provider: string;
  readonly credential: string;
  readonly window5hPct: number | null;
  readonly weeklyPct: number | null;
  readonly resetAt: number | null;
  readonly note: string;
}

export interface WorkflowEvent {
  readonly at: number;
  readonly type: string;
  readonly text: string;
}

export interface UsageRow {
  readonly at: number;
  readonly kind: UsageKind;
  readonly role: string;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly durationMs: number | null;
  readonly difficulty: string | null;
  readonly outcome: string | null;
}

export interface WorkflowSnapshot {
  readonly schemaVersion: 1;
  readonly demo: boolean;
  readonly workflow: {
    readonly id: string;
    readonly goal: string;
    readonly state: WorkflowState;
    readonly startedAt: number;
    readonly elapsedMs: number;
    readonly autonomy: { readonly mode: "autonomous" | "stops"; readonly stops: readonly string[] };
    readonly orchestratorModel: string;
    readonly stopReason?: string | null;
    readonly explanation?: WaitExplanation;
  };
  readonly totals: {
    readonly tokensUsed: number;
    readonly tokensBudget: number | null;
    readonly agentsCreated: number;
    readonly agentsCap: number;
    readonly queued: number;
    readonly retries: number;
    readonly escalations: number;
  };
  readonly capacity: {
    readonly executors: { readonly live: number; readonly max: number };
    readonly auditors: { readonly live: number; readonly max: number };
    readonly delegators: { readonly live: number; readonly max: number };
  };
  readonly nodes: readonly WorkflowNode[];
  readonly quota: readonly QuotaRow[];
  readonly events: readonly WorkflowEvent[];
  readonly usage: readonly UsageRow[];
}
