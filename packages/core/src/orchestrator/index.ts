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
      // Set when the task's verification retries ran out (MC-T2 fix; executor.md DR-05), with how many were used.
      readonly reason?: "verification_exhausted";
      readonly verifyRetries?: number;
    }
  | {
      // dep_failed: a dependency failed; memory_unavailable: the task requires memory and the provider is down (MC-T4).
      readonly type: "task.blocked";
      readonly taskId: string;
      readonly goal: string;
      readonly reason: "dep_failed" | "memory_unavailable";
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
      // The runtime stops: "command" when runtime.stop was applied, "signal" for Ctrl+C or SIGTERM (ARCH 4.2),
      // "emergency" for haril stop --now (3.14): every attempt in flight is killed and the runtime stays halted.
      readonly type: "runtime.stopping";
      readonly reason: "command" | "signal" | "emergency";
    }
  | {
      // A task ended without a retry (3.14, 3.16): the human stopped it (user_stop) or the watchdog found that nobody
      // will consume its result (residual). A running one had its process killed.
      readonly type: "task.cancelled";
      readonly taskId: string;
      readonly goal: string;
      readonly reason: "user_stop" | "residual";
    }
  | {
      // An emergency stop left the runtime halted (3.14): it claims nothing until haril resume.
      readonly type: "runtime.halted";
    }
  | {
      // A verdict of the watchdog on one node of a workflow (3.16): asked by code, never a model. text starts with the
      // node's id (o1, d2, e3, a3, fa), as the console's watchdog line reads it.
      readonly type: "watchdog.checked";
      readonly workflowId: string;
      readonly taskId: string;
      readonly node: string;
      readonly verdict: "active" | "idle" | "residual" | "waiting_human" | "cooling_down";
      readonly action: "continue" | "close" | "cancel";
      readonly text: string;
    }
  | {
      // The startup sweep (3.14.5): agent processes a dead runtime left were killed, and recorded pids that now name
      // another process were kept.
      readonly type: "runtime.swept";
      readonly killed: number;
      readonly kept: number;
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
    }
  | {
      // A plan task proposed a plan (LD-T4): it waits as a requested approval. created is false when the same plan was
      // already waiting for a decision in the project, and that approval is the one named.
      readonly type: "approval.requested";
      readonly approvalId: string;
      readonly taskId: string;
      readonly created: boolean;
    }
  | {
      // A turn of a workflow closed (phase F2). taskState is its gate for its dependents: an auditor turn that rejects and
      // a delegator turn that reports partial or failed end failed, as part of the workflow, not as a failed task of the
      // run; outcome says what the turn did (delegated, assigned, completed, approved, rejected, reported_done...).
      readonly type: "workflow.turn";
      readonly taskId: string;
      readonly goal: string;
      readonly role: "orchestrator" | "delegator" | "executor" | "auditor";
      readonly taskState: "completed" | "failed";
      readonly outcome: string;
    }
  | {
      // A workflow paused for the human, completed or failed (phase F2).
      readonly type: "workflow.state";
      readonly workflowId: string;
      readonly state: "awaiting_human" | "completed" | "failed" | "stopped";
      readonly reason: string | null;
    };

export interface RunSummary {
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly blocked: readonly string[];
  // Tasks left ready because their real agent is not set up (M2-T6); the run then exits 1.
  readonly skipped: readonly string[];
  // Tasks a stop or the watchdog cancelled (3.14, 3.16); a cancelled task does not fail the run.
  readonly cancelled: readonly string[];
  readonly commandsApplied: number;
  readonly commandsRejected: number;
}

export function summarizeRun(events: readonly RunEvent[]): RunSummary {
  const completed: string[] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  const skipped: string[] = [];
  const cancelled: string[] = [];
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
      case "task.cancelled":
        cancelled.push(event.taskId);
        break;
      default:
        break;
    }
  }
  return { completed, failed, blocked, skipped, cancelled, commandsApplied, commandsRejected };
}

// M1-D2 / start: 0 when no task failed, was blocked or was skipped during the run, 1 otherwise.
export function runExitCode(summary: RunSummary): 0 | 1 {
  return summary.failed.length + summary.blocked.length + summary.skipped.length === 0 ? 0 : 1;
}
