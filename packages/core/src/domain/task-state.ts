import type { TaskState } from "@haril/contracts";

// Legal edges of ARCHITECTURE.md 7.2 (state diagram and transition table). The table is the only
// source of truth for the domain: a missing key here would be a compile error, not a silent gap.
// Pure: no I/O, no node:* imports, no typebox.
const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["completed", "ready", "failed", "blocked", "cancelled"],
  blocked: ["ready", "pending", "failed", "cancelled"],
  // failed is reopened only by a human order (`task.retry`), so it keeps one outgoing edge.
  failed: ["ready"],
  completed: [],
  cancelled: [],
};

export const TASK_STATES: readonly TaskState[] = [
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

export function canTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

// Outgoing edges of a state, in the order of the transition table (empty for terminal states).
export function legalTargets(from: TaskState): readonly TaskState[] {
  return LEGAL_TRANSITIONS[from];
}

// A terminal state has no outgoing edge. With ARCH 7.2, that is completed and cancelled;
// failed is not terminal because of the human retry edge.
export function isTerminal(state: TaskState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}
