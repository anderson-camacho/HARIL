import type { PendingApproval } from "../data.js";
import { pad } from "../format.js";
import { type PanelContext, type PanelView, storeMessage } from "./types.js";

// The plan review (LD-T5): the plans waiting for a decision and the tasks of one of them. The approvals are global,
// like the banner count, so a project filter never hides one. The app runs y and n through haril approve and deny.

const SHORT_ID_LENGTH = 8;
const HELP_LINE = "Plans waiting for approval. Enter opens one; y approves it, n denies it.";

export function plansView(context: PanelContext): PanelView {
  const { snapshot } = context;
  const message = storeMessage(snapshot);
  const columns = `${pad("ID", 10)}${pad("PROJECT", 10)}${pad("TASKS", 14)}AGE`;
  return {
    header: [...(message === undefined ? [] : [message]), HELP_LINE, `  ${columns}`],
    items: snapshot.approvals.map((approval) => ({
      text: `${pad(approval.approvalId.slice(0, SHORT_ID_LENGTH), 10)}${pad(slugOf(context, approval), 10)}${pad(taskCount(approval), 14)}${age(snapshot.loadedAt - approval.requestedAt)}`,
      value: approval.approvalId,
    })),
    empty:
      snapshot.approvals.length === 0 && message === undefined
        ? "No plans waiting for approval."
        : undefined,
    keys: ["Enter open plan", "y approve", "n deny"],
  };
}

// The plan as the user decides on it: each task with its local id, goal, agent and dependencies.
export function planDetailLines(approval: PendingApproval, context: PanelContext): string[] {
  const requested = age(context.snapshot.loadedAt - approval.requestedAt);
  return [
    `plan ${approval.approvalId}`,
    `project ${slugOf(context, approval)}, ${taskCount(approval)}, requested ${requested} ago by ${approval.requestedBy}`,
    ...(approval.error === undefined ? [] : [`the plan could not be read: ${approval.error}`]),
    "",
    ...approval.tasks.flatMap((task, index) => [
      `${index + 1}. ${task.localId}: ${task.goal}`,
      `   agent ${task.agent}, depends on: ${task.dependsOn.length === 0 ? "none" : task.dependsOn.join(", ")}`,
    ]),
  ];
}

// A subject that is not a plan shows as such: it can only be denied (the app refuses y for it).
function taskCount(approval: PendingApproval): string {
  return approval.error === undefined ? `${approval.tasks.length} tasks` : "invalid plan";
}

function slugOf(context: PanelContext, approval: PendingApproval): string {
  return (
    context.snapshot.projects.find((project) => project.projectId === approval.projectId)?.slug ??
    "?"
  );
}

// A short age: seconds, minutes, hours or days.
function age(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
