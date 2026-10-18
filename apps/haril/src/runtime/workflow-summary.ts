import type { RunEvent } from "@haril/core";

// What one `haril run` or `haril start` did with workflows (phase F2b), from its events: the turns it closed and how each
// workflow it moved ended. A workflow's turns are its own tasks: an auditor that rejects or a delegator that reports
// partial ends failed as part of the workflow, never as a failed task of the run, so they are counted here, apart. A
// workflow that failed fails the run like a failed task does; one that waits for the human does not.

export interface WorkflowTally {
  readonly turns: number;
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  // Paused at a stop for the human (awaiting_human).
  readonly waiting: readonly string[];
}

export function summarizeWorkflows(events: readonly RunEvent[]): WorkflowTally {
  let turns = 0;
  // The last state a workflow reached in this run is how it ended here.
  const last = new Map<string, string>();
  for (const event of events) {
    if (event.type === "workflow.turn") turns += 1;
    if (event.type === "workflow.state") last.set(event.workflowId, event.state);
  }
  const inState = (state: string) =>
    [...last].filter(([, reached]) => reached === state).map(([workflowId]) => workflowId);
  return {
    turns,
    completed: inState("completed"),
    // A workflow the human stops (phase F3) is not a failure, so "stopped" is left out.
    failed: inState("failed"),
    waiting: inState("awaiting_human"),
  };
}

// 1 when a workflow failed in this run, 0 otherwise: combined with the tasks' exit code.
export function workflowExitCode(tally: WorkflowTally): 0 | 1 {
  return tally.failed.length > 0 ? 1 : 0;
}

// The workflows part of the run's "done:" line, or "" when the run touched no workflow.
export function workflowSummaryText(tally: WorkflowTally): string {
  const touched = tally.turns + tally.completed.length + tally.failed.length + tally.waiting.length;
  if (touched === 0) return "";
  const waiting = tally.waiting.length === 0 ? "" : `, ${tally.waiting.length} waiting`;
  return `; workflows: ${tally.turns} ${tally.turns === 1 ? "turn" : "turns"}, ${tally.completed.length} completed, ${tally.failed.length} failed${waiting}`;
}
