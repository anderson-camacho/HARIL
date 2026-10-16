// Orchestrator helpers (M1-T5): pure tallies over the events of one `haril start`.

export type RunEvent =
  | {
      readonly type: "command.applied";
      readonly commandId: string;
      readonly commandType: string;
      readonly taskIds: readonly string[];
    }
  | {
      readonly type: "command.rejected";
      readonly commandId: string;
      readonly commandType: string;
      readonly reason: string;
    }
  | {
      readonly type: "task.claimed";
      readonly taskId: string;
      readonly goal: string;
      readonly attempt: number;
      readonly maxAttempts: number;
    }
  | { readonly type: "task.completed"; readonly taskId: string; readonly goal: string }
  | {
      readonly type: "task.retrying";
      readonly taskId: string;
      readonly goal: string;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly code: string;
    }
  | {
      readonly type: "task.failed";
      readonly taskId: string;
      readonly goal: string;
      readonly code: string;
    }
  | {
      readonly type: "task.blocked";
      readonly taskId: string;
      readonly goal: string;
      readonly reason: "dep_failed";
    };

export interface RunSummary {
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly blocked: readonly string[];
  readonly commandsApplied: number;
  readonly commandsRejected: number;
}

export function summarizeRun(events: readonly RunEvent[]): RunSummary {
  const completed: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  let commandsApplied = 0;
  let commandsRejected = 0;
  for (const event of events) {
    switch (event.type) {
      case "command.applied":
        commandsApplied++;
        break;
      case "command.rejected":
        commandsRejected++;
        break;
      case "task.completed":
        completed.push(event.taskId);
        break;
      case "task.failed":
        failed.push(event.taskId);
        break;
      case "task.blocked":
        blocked.push(event.taskId);
        break;
      default:
        break;
    }
  }
  return { completed, failed, blocked, commandsApplied, commandsRejected };
}

// M1-D2 / start: 0 when no task failed or was blocked during the run, 1 otherwise.
export function runExitCode(summary: RunSummary): 0 | 1 {
  return summary.failed.length + summary.blocked.length === 0 ? 0 : 1;
}
