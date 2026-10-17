import type { PlanTask } from "@haril/contracts";
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

// The plan as the user decides on it: each task with every field the runtime applies to the task it creates (LD-T6c).
// The goal and the description are the agent's prompt; the agent, the dependencies, the files it may write and read,
// the kind, the limits, the budget, the capabilities, the context and the checks decide what it may do and when it is
// done. The header names the model every task will run with, the proposing task's or none (LD-T7a). The app wraps
// each line and sends it through the render boundary like any other text.
export function planDetailLines(approval: PendingApproval, context: PanelContext): string[] {
  const requested = age(context.snapshot.loadedAt - approval.requestedAt);
  return [
    `plan ${approval.approvalId}`,
    `project ${slugOf(context, approval)}, ${taskCount(approval)}, model ${approval.model ?? "none"}, requested ${requested} ago by ${approval.requestedBy}`,
    ...(approval.error === undefined ? [] : [`the plan could not be read: ${approval.error}`]),
    "",
    ...approval.tasks.flatMap((task, index) => planTaskLines(task, index)),
  ];
}

function planTaskLines(task: PlanTask, index: number): string[] {
  const { budget, surface } = task;
  return [
    `${index + 1}. ${task.localId}: ${task.goal}`,
    `   agent ${task.agent}, depends on: ${listed(task.dependsOn)}`,
    ...descriptionLines(task.description),
    `   writes: ${listed(surface.write)}; reads: ${listed(surface.read)}`,
    `   kind ${task.kind}, priority ${task.priority}, attempts ${task.maxAttempts}, timeout ${task.timeoutMs} ms`,
    `   budget: ${budget.maxTokens} tokens, ${budget.maxWallMs} ms wall time, ${budget.maxCostMicros} cost micros`,
    `   requires: ${listed(task.requires)}; context: ${listed(task.context)}`,
    `   acceptance: ${task.acceptance.length === 0 ? "none" : task.acceptance.map(checkText).join(", ")}`,
  ];
}

// The description line by line, the lines after the first indented under it; "none" when it is blank, as the agent
// then gets the goal alone.
function descriptionLines(description: string): string[] {
  if (description.trim() === "") return ["   description: none"];
  const [first, ...rest] = description.split(/\r?\n/);
  return [`   description: ${first ?? ""}`, ...rest.map((line) => `     ${line}`)];
}

// A host check as it reads: its kind with its path and its text quoted, or a block verifier as block/check.
function checkText(check: PlanTask["acceptance"][number]): string {
  if (!("kind" in check)) {
    const params = check.params === undefined ? "" : ` ${JSON.stringify(check.params)}`;
    return `${check.blockId}/${check.checkId}${params}`;
  }
  switch (check.kind) {
    case "file_exists":
      return `file_exists ${check.path}`;
    case "file_contains":
      return `file_contains ${check.path} ${JSON.stringify(check.text)}`;
    case "output_contains":
      return `output_contains ${JSON.stringify(check.text)}`;
  }
}

function listed(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
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
