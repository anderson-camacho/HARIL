import type { WaitExplanation, WorkflowState } from "./orchestration-types.js";

// FactoryModel v1: what each line of `haril factory watch` prints. A local copy of packages/contracts/src/factory-model.ts
// because the console imports nothing from other workspaces (check-layers R6); tests/factory-feed.test.ts fails to compile
// when the two differ. `null` always means "not available": the view says so and never invents a value.

export type FactoryColumn = "por_hacer" | "en_curso" | "detenidas" | "errores" | "hechas";

interface CriteriaCount {
  readonly passed: number;
  readonly total: number;
}

interface ContextFill {
  readonly used: number;
  readonly threshold: number;
}

export interface FactoryWorkflow {
  readonly id: string;
  readonly projectSlug: string;
  readonly goal: string;
  readonly state: WorkflowState;
  readonly stopReason: string | null;
  readonly explanation: WaitExplanation;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly tokensUsed: number;
  readonly tokensBudget: number | null;
  readonly agentsCreated: number;
  readonly agentsCap: number;
  readonly closedTasks: number;
  readonly totalTasks: number;
  readonly criteria: CriteriaCount | null;
}

export interface FactoryTask {
  readonly id: string;
  readonly workflowId: string;
  readonly title: string;
  readonly state: string;
  readonly column: FactoryColumn;
  readonly role: string;
  readonly agent: string;
  readonly delegatedBy: string | null;
  readonly returnedTo: string | null;
  readonly model: string | null;
  readonly attempts: number;
  readonly maxAttempts: number | null;
  readonly context: ContextFill | null;
  readonly tokens: number;
  readonly criteria: CriteriaCount | null;
  readonly explanation: WaitExplanation;
  readonly closedAt: number | null;
  readonly updatedAt: number;
}

export interface FactoryAgent {
  readonly workflowId: string;
  readonly code: string;
  readonly role: string;
  readonly status: string;
  readonly taskId: string;
  readonly task: string;
  readonly model: string | null;
  readonly tokens: number;
  readonly elapsedMs: number | null;
  readonly context: ContextFill | null;
  readonly parent: string | null;
  readonly depth: number;
}

export interface FactoryEvent {
  readonly at: number;
  readonly type: string;
  readonly text: string;
  readonly workflowId: string | null;
  readonly agent: string | null;
}

export interface FactoryHumanRequest {
  readonly kind: "approval" | "stop" | "task";
  readonly id: string;
  readonly workflowId: string | null;
  readonly projectSlug: string;
  readonly title: string;
  readonly explanation: WaitExplanation;
  readonly at: number;
}

export interface FactoryModel {
  readonly schemaVersion: 1;
  readonly generatedAt: number;
  readonly project: string | null;
  readonly workflows: readonly FactoryWorkflow[];
  readonly tasks: readonly FactoryTask[];
  readonly agents: readonly FactoryAgent[];
  readonly edges: readonly {
    readonly workflowId: string;
    readonly parent: string;
    readonly child: string;
  }[];
  readonly events: readonly FactoryEvent[];
  readonly humanRequests: readonly FactoryHumanRequest[];
}
