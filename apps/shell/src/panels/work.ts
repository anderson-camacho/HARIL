import type { TaskDetail } from "@haril/core/ports";
import type { TaskDetailView } from "../data.js";
import { pad, resultText, runtimeState, time, verificationLines } from "../format.js";
import { type PanelContext, type PanelView, storeMessage } from "./types.js";

// The panels about work: projects, tasks (with their detail), and the agents running now.

export function projectsView(context: PanelContext): PanelView {
  const { snapshot, scope } = context;
  const current = (selected: boolean): string => (selected ? "  [current]" : "");
  return {
    header: withMessage(storeMessage(snapshot)),
    items: [
      { text: `all projects${current(scope === undefined)}`, value: "" },
      ...snapshot.projects.map((project) => ({
        text: `${project.slug}  ${project.name}  ${project.rootPath}${current(project.projectId === scope)}`,
        value: project.projectId,
      })),
    ],
    keys: ["Enter select project"],
  };
}

export function tasksView(context: PanelContext): PanelView {
  const { snapshot, scope } = context;
  const slugOf = (projectId: string): string =>
    snapshot.projects.find((project) => project.projectId === projectId)?.slug ?? "?";
  const tasks = snapshot.tasks.filter((task) => scope === undefined || task.projectId === scope);
  const showProject = scope === undefined;
  const columns = `${showProject ? pad("PROJECT", 10) : ""}${pad("STATE", 12)}${pad("AGENT", 13)}${pad("MODEL", 12)}${pad("DEPS", 10)}GOAL`;
  return {
    header: [...withMessage(storeMessage(snapshot)), `  ${columns}`],
    items: tasks.map((task) => ({
      text: `${showProject ? pad(slugOf(task.projectId), 10) : ""}${pad(task.state, 12)}${pad(task.agentRef, 13)}${pad(task.model ?? "-", 12)}${pad(dependencyText(task), 10)}${task.goal}`,
      value: task.taskId,
    })),
    empty: tasks.length === 0 && storeMessage(snapshot) === undefined ? "No tasks yet." : undefined,
    keys: ["Enter open task"],
  };
}

// Dependency ids are not readable through the store facets; the panel shows what the state implies.
function dependencyText(task: TaskDetail): string {
  if (task.state === "pending") return "waiting";
  if (task.blockReason !== null) return `blocked: ${task.blockReason}`;
  return "-";
}

// Lines of the task detail, the same facts as `haril task show`.
export function taskDetailLines(view: TaskDetailView): string[] {
  const task = view.detail;
  const tokens =
    view.tokens === null
      ? "tokens: none settled"
      : `tokens: input ${view.tokens.input}, output ${view.tokens.output}, unreconciled ${view.tokens.unreconciled}`;
  return [
    `task ${task.taskId}: ${task.goal}`,
    `state ${task.state}, agent ${task.agentRef}, model ${task.model ?? "none"}`,
    `attempts ${task.attemptsUsed}/${task.maxAttempts}, max tokens ${task.maxTokens}`,
    `result: ${resultText(task.result)}`,
    ...(task.error === null ? [] : [`error: ${task.error.code}: ${task.error.message}`]),
    ...verificationLines(task.result, task.error),
    `permission denials: ${view.permissionDenials}`,
    tokens,
  ];
}

export function agentsView(context: PanelContext): PanelView {
  const { snapshot, scope } = context;
  const lease = snapshot.runtime;
  const running = snapshot.tasks.filter(
    (task) => task.state === "running" && (scope === undefined || task.projectId === scope),
  );
  const runsRunning = snapshot.metrics
    .filter((entry) => scope === undefined || entry.projectId === scope)
    .reduce((sum, entry) => sum + (entry.snapshot.runsByStatus.running ?? 0), 0);
  const leaseLines =
    lease.status === "none"
      ? ["runtime none: no runtime has started yet"]
      : [
          `runtime ${lease.status}: pid ${lease.pid}, instance ${lease.instanceId}`,
          `started ${time(lease.startedAt)}, heartbeat ${time(lease.heartbeatAt)}, expires ${time(lease.expiresAt)}`,
          `node ${lease.nodeVersion}, sqlite ${lease.sqliteVersion}`,
        ];
  return {
    header: [
      ...withMessage(storeMessage(snapshot)),
      ...leaseLines,
      `runtime state: ${runtimeState(lease, snapshot.loadedAt)}`,
      `runs running: ${runsRunning}`,
    ],
    items: running.map((task) => ({
      text: `${pad(task.agentRef, 13)}${task.goal}`,
      value: task.taskId,
    })),
    empty:
      running.length === 0 && storeMessage(snapshot) === undefined
        ? "No runs in progress."
        : undefined,
    keys: ["Enter open task"],
  };
}

function withMessage(message: string | undefined): string[] {
  return message === undefined ? [] : [message];
}
