import type { TaskDetail } from "@haril/core/ports";
import type { TaskDetailView } from "../data.js";
import { pad, resultText, runtimeState, time, verificationLines } from "../format.js";
import { type PanelContext, type PanelView, storeMessage } from "./types.js";

// The panels about work: projects, tasks (with their detail), the agents running now and the live view.

const DEPS_WIDTH = 12;
const SHORT_ID_LENGTH = 8;
// The agents that write a plan instead of doing the work (LD-T4). A task row carries no kind, so the agent tells.
const PLAN_AGENTS: readonly string[] = ["planner", "fake:plan"];
const LIVE_LINE =
  "Newest tasks, oldest first. The view reloads when the runtime wakes the shell, on r and after an action.";

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
  const columns = `${showProject ? pad("PROJECT", 10) : ""}${pad("STATE", 12)}${pad("AGENT", 13)}${pad("MODEL", 12)}${pad("DEPS", DEPS_WIDTH)}GOAL`;
  return {
    header: [...withMessage(storeMessage(snapshot)), `  ${columns}`],
    items: tasks.map((task) => ({
      text: `${showProject ? pad(slugOf(task.projectId), 10) : ""}${pad(task.state, 12)}${pad(task.agentRef, 13)}${pad(task.model ?? "-", 12)}${pad(dependencyText(task), DEPS_WIDTH)}${task.goal}`,
      value: task.taskId,
    })),
    empty: tasks.length === 0 && storeMessage(snapshot) === undefined ? "No tasks yet." : undefined,
    keys: ["Enter open task"],
  };
}

// The first dependency in short form and how many more there are ("aaaaaaaa +1"); "-" when there are none.
// The detail lists them all.
function dependencyText(task: TaskDetail): string {
  const [first, ...rest] = task.dependsOn;
  if (first === undefined) return "-";
  return rest.length === 0 ? shortId(first) : `${shortId(first)} +${rest.length}`;
}

// The first eight characters of a task id: enough to tell tasks apart on one screen.
function shortId(taskId: string): string {
  return taskId.slice(0, SHORT_ID_LENGTH);
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
    `depends on: ${task.dependsOn.length === 0 ? "none" : task.dependsOn.map(shortId).join(", ")}`,
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

// What runs, without opening a detail (LD-T5): state, kind, agent, the attempt of the run (0 before the first
// claim), settled tokens and the first line of the outcome of the scope's newest tasks. The rows come with the
// snapshot, so the view changes only when the store is read again.
export function liveView(context: PanelContext): PanelView {
  const { snapshot } = context;
  const message = storeMessage(snapshot);
  const columns = `${pad("STATE", 10)}${pad("KIND", 5)}${pad("AGENT", 13)}${pad("TRY", 5)}${pad("TOKENS", 10)}GOAL · RESULT`;
  return {
    header: [...withMessage(message), LIVE_LINE, `  ${columns}`],
    items: snapshot.live.map(({ detail: task, tokens }) => {
      const kind = PLAN_AGENTS.includes(task.agentRef) ? "plan" : "work";
      const settled = tokens === null ? "-" : `${tokens.input}/${tokens.output}`;
      const outcome = outcomeLine(task);
      return {
        text: `${pad(task.state, 10)}${pad(kind, 5)}${pad(task.agentRef, 13)}${pad(`${task.attempt}/${task.maxAttempts}`, 5)}${pad(settled, 10)}${task.goal}${outcome === undefined ? "" : ` · ${outcome}`}`,
        value: task.taskId,
      };
    }),
    empty: snapshot.live.length === 0 && message === undefined ? "No tasks yet." : undefined,
    keys: ["Enter open task"],
  };
}

// The first line of the newest error while the task has not completed, else of its result; undefined with neither.
function outcomeLine(task: TaskDetail): string | undefined {
  const text =
    task.state !== "completed" && task.error !== null
      ? `${task.error.code}: ${task.error.message}`
      : task.result === null
        ? undefined
        : resultText(task.result);
  return text?.split(/\r?\n/, 1)[0];
}

function withMessage(message: string | undefined): string[] {
  return message === undefined ? [] : [message];
}
