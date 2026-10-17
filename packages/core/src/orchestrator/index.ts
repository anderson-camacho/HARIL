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
  | {
      readonly type: "task.completed";
      readonly taskId: string;
      readonly goal: string;
      readonly simulated: boolean;
    }
  | {
      readonly type: "task.recovered";
      readonly taskId: string;
      readonly goal: string;
      readonly infraRestarts: number;
      readonly maxInfraRestarts: number;
    }
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
    }
  | {
      // A ready task of a real agent whose prerequisites are missing: not claimed, reported with the fix.
      readonly type: "task.skipped";
      readonly taskId: string;
      readonly goal: string;
      readonly what: string;
      readonly fix: string;
    }
  | {
      // The runtime stops: "command" when runtime.stop was applied, "signal" for Ctrl+C or SIGTERM (ARCH 4.2).
      readonly type: "runtime.stopping";
      readonly reason: "command" | "signal";
    }
  | {
      // A run cancelled by a stop returned its task to ready; no attempt was charged (ARCH 4.2, step 3).
      readonly type: "task.returned";
      readonly taskId: string;
      readonly goal: string;
    }
  | {
      // A decision on an approval was applied by the runtime (LD-T3). A granted plan is queued in the same turn.
      // alreadySubmitted: the granted plan's plan.submit was a duplicate (the same plan was imported or granted
      // before, or a crash left it queued), so nothing new was queued. Always false for a denial.
      readonly type: "approval.applied";
      readonly approvalId: string;
      readonly outcome: "granted" | "denied";
      readonly alreadySubmitted: boolean;
    };

export interface RunSummary {
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly blocked: readonly string[];
  // Tasks left ready because their real agent is not set up (M2-T6); the run then exits 1.
  readonly skipped: readonly string[];
  readonly commandsApplied: number;
  readonly commandsRejected: number;
}

export function summarizeRun(events: readonly RunEvent[]): RunSummary {
  const completed: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  const skipped: string[] = [];
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
      case "task.skipped":
        skipped.push(event.taskId);
        break;
      default:
        break;
    }
  }
  return { completed, failed, blocked, skipped, commandsApplied, commandsRejected };
}

// M1-D2 / start: 0 when no task failed, was blocked or was skipped during the run, 1 otherwise.
export function runExitCode(summary: RunSummary): 0 | 1 {
  return summary.failed.length + summary.blocked.length + summary.skipped.length === 0 ? 0 : 1;
}
