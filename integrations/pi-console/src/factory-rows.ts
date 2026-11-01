import type { SettingField } from "./delegation-settings.js";
import { settingLabel } from "./factory-settings.js";
import type { ActivityView, FactoryState, FactoryTab } from "./factory-state.js";
import type {
  FactoryAgent,
  FactoryColumn,
  FactoryEvent,
  FactoryHumanRequest,
  FactoryModel,
  FactoryQuotaAccount,
  FactoryTask,
  FactoryWorkflow,
} from "./factory-types.js";

// What each tab lists, once: the board, the inbox, the agents and the progress rows, in the order they are drawn, after
// the tab's filter. The controller moves over these rows and the views draw them, so the two cannot disagree.

const COLUMN_ORDER: Readonly<Record<FactoryColumn, number>> = {
  por_hacer: 0,
  en_curso: 1,
  detenidas: 2,
  errores: 3,
  hechas: 4,
};

// A row of the Avance tab. `ratio` is null when no fact backs a number: the view says so and never draws a 0.
export interface ProgressRow {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly ratio: number | null;
  // True while the total can still grow: the number is shown with `~`.
  readonly estimated: boolean;
  readonly detail: string;
  readonly workflow?: FactoryWorkflow;
  readonly workflowId?: string;
}

function matches(filter: string, ...fields: readonly (string | null)[]): boolean {
  const wanted = filter.trim().toLowerCase();
  return wanted === "" || fields.some((field) => field?.toLowerCase().includes(wanted) === true);
}

function taskMatches(filter: string, task: FactoryTask): boolean {
  return matches(filter, task.title, task.agent, task.model, task.role, task.explanation.what);
}

export function boardTasks(state: FactoryState): FactoryTask[] {
  const { model } = state;
  if (model === null) return [];
  return model.tasks
    .filter((task) => taskMatches(state.filter.tablero, task))
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        COLUMN_ORDER[a.task.column] - COLUMN_ORDER[b.task.column] ||
        (a.task.column === "hechas" ? b.task.updatedAt - a.task.updatedAt : a.index - b.index),
    )
    .map(({ task }) => task);
}

const VIEW_COLUMNS: Readonly<Record<Exclude<ActivityView, "te_necesitan">, FactoryColumn[]>> = {
  activas: ["en_curso"],
  // What waits without being a question for the person is queued work too.
  en_cola: ["por_hacer", "detenidas"],
  fallidas: ["errores"],
  hechas: ["hechas"],
};

export function activityTasks(
  model: FactoryModel,
  view: Exclude<ActivityView, "te_necesitan">,
  filter: string,
): FactoryTask[] {
  const columns = VIEW_COLUMNS[view];
  return model.tasks
    .filter((task) => columns.includes(task.column) && taskMatches(filter, task))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function humanRequests(model: FactoryModel, filter: string): FactoryHumanRequest[] {
  return model.humanRequests.filter((request) =>
    matches(filter, request.title, request.explanation.what),
  );
}

export function eventRows(model: FactoryModel, filter: string): FactoryEvent[] {
  return model.events
    .filter((event) => matches(filter, event.type, event.text, event.agent))
    .slice()
    .reverse();
}

export function agentRows(state: FactoryState): FactoryAgent[] {
  const { model } = state;
  if (model === null) return [];
  const rows = model.agents.filter((agent) =>
    matches(state.filter.agentes, agent.code, agent.role, agent.task, agent.model, agent.status),
  );
  // The tree keeps the model's depth-first order; the flat list sorts as htop does, the heaviest first.
  return state.agentsTree ? rows : [...rows].sort((a, b) => b.tokens - a.tokens);
}

export function connectionAgents(state: FactoryState): FactoryAgent[] {
  const { model } = state;
  if (model === null) return [];
  return model.agents.filter((agent) =>
    matches(state.filter.conexiones, agent.code, agent.role, agent.task, agent.status),
  );
}

// The settings the Sistema tab lists, in HARIL's order; its other views have no rows to move over.
export function settingRows(state: FactoryState): readonly SettingField[] {
  if (state.sistemaView !== "ajustes") return [];
  const fields = state.system?.settings?.fields ?? [];
  return fields.filter((field) =>
    matches(state.filter.sistema, settingLabel(field), field.path, field.group),
  );
}

export function quotaAccounts(state: FactoryState): FactoryQuotaAccount[] {
  const { model } = state;
  if (model === null) return [];
  return model.quota.accounts.filter((account) =>
    matches(state.filter.modelos, account.label, account.kind, account.provider, account.state),
  );
}

function criteriaRatio(criteria: { passed: number; total: number } | null): number | null {
  return criteria === null || criteria.total === 0 ? null : criteria.passed / criteria.total;
}

function criteriaText(criteria: { passed: number; total: number } | null): string {
  return criteria === null ? "" : `${criteria.passed}/${criteria.total}`;
}

// Closed tasks over all tasks: the only number that says how far a workflow is. A live workflow can still add tasks.
function workflowRatio(row: FactoryWorkflow): number | null {
  return row.totalTasks === 0 ? null : row.closedTasks / row.totalTasks;
}

export function workflowLive(row: FactoryWorkflow): boolean {
  return row.state === "running" || row.state === "awaiting_human";
}

export function progressRows(state: FactoryState): ProgressRow[] {
  const { model } = state;
  if (model === null) return [];
  const filter = state.filter.avance;
  const live = new Set(model.workflows.filter(workflowLive).map((row) => row.id));
  switch (state.avanceScope) {
    case "proyecto": {
      const total = model.workflows.reduce((sum, row) => sum + row.totalTasks, 0);
      const closed = model.workflows.reduce((sum, row) => sum + row.closedTasks, 0);
      const all: ProgressRow = {
        id: "all",
        label: model.project === null ? "Todos los proyectos" : `Proyecto ${model.project}`,
        sub: `${model.workflows.length} ${model.workflows.length === 1 ? "flujo" : "flujos"}`,
        ratio: total === 0 ? null : closed / total,
        estimated: live.size > 0,
        detail: `${closed} de ${total} tareas cerradas`,
      };
      const rows = model.workflows
        .filter((row) => matches(filter, row.goal, row.projectSlug, row.state))
        .map(
          (row): ProgressRow => ({
            id: row.id,
            label: row.goal,
            sub: row.state,
            ratio: workflowRatio(row),
            estimated: workflowLive(row),
            detail: `${row.closedTasks} de ${row.totalTasks} tareas cerradas`,
            workflow: row,
            workflowId: row.id,
          }),
        );
      return [all, ...rows];
    }
    case "tarea":
      return weakestFirst(
        model.tasks
          .filter((task) => taskMatches(filter, task))
          .map((task) => ({
            id: task.id,
            label: `${task.agent} ${task.title}`,
            sub: criteriaText(task.criteria),
            ratio: criteriaRatio(task.criteria),
            estimated: false,
            detail: task.explanation.what,
            workflowId: task.workflowId,
          })),
      );
    case "agente": {
      const byCode = new Map(model.tasks.map((task) => [`${task.workflowId}/${task.agent}`, task]));
      return weakestFirst(
        model.agents
          .filter((agent) => matches(filter, agent.code, agent.role, agent.model))
          .map((agent) => {
            const task = byCode.get(`${agent.workflowId}/${agent.code}`);
            return {
              id: `${agent.workflowId}/${agent.code}`,
              label: `${agent.code} ${agent.role}`,
              sub: criteriaText(task?.criteria ?? null),
              ratio: criteriaRatio(task?.criteria ?? null),
              estimated: false,
              detail: `${agent.tokens} tokens`,
              workflowId: agent.workflowId,
            };
          }),
      );
    }
    case "modelo": {
      const groups = new Map<string, FactoryTask[]>();
      for (const task of model.tasks) {
        const key = task.model ?? "sin modelo";
        groups.set(key, [...(groups.get(key) ?? []), task]);
      }
      return weakestFirst(
        [...groups.entries()]
          .filter(([name]) => matches(filter, name))
          .map(([name, tasks]) => {
            const closed = tasks.filter((task) => task.column === "hechas").length;
            const tokens = tasks.reduce((sum, task) => sum + task.tokens, 0);
            return {
              id: `model:${name}`,
              label: name,
              sub: `${closed}/${tasks.length}`,
              ratio: tasks.length === 0 ? null : closed / tasks.length,
              estimated: tasks.some((task) => live.has(task.workflowId)),
              detail: `${closed} de ${tasks.length} tareas cerradas · ${tokens} tokens`,
            };
          }),
      );
    }
  }
}

// As the coverage report re-sorts: the weakest on top, and the ones with no proof after them.
function weakestFirst(rows: readonly ProgressRow[]): ProgressRow[] {
  return [...rows].sort((a, b) => (a.ratio ?? 2) - (b.ratio ?? 2));
}

// The tab's rows by id and what the selected one is, for the controller.
export interface SelectedRow {
  readonly ids: readonly string[];
  readonly index: number;
  readonly id?: string;
  readonly updatedAt: number;
  readonly workflowId?: string;
  readonly approval?: FactoryHumanRequest;
  readonly tasks: readonly FactoryTask[];
}

export function selectedRowId(state: FactoryState, tab: FactoryTab): SelectedRow {
  const none = { index: state.selection[tab], updatedAt: 0, tasks: [] };
  const { model } = state;
  if (model === null) return { ...none, ids: [] };
  const index = state.selection[tab];
  const out = (
    ids: readonly string[],
    updatedAt: number,
    workflowId: string | null | undefined,
    extra: Partial<SelectedRow> = {},
  ): SelectedRow => {
    const id = ids[index];
    return {
      ...none,
      ids,
      ...(id === undefined ? {} : { id }),
      updatedAt,
      ...(workflowId === null || workflowId === undefined ? {} : { workflowId }),
      ...extra,
    };
  };
  switch (tab) {
    case "tablero": {
      const tasks = boardTasks(state);
      const task = tasks[index];
      return out(
        tasks.map((row) => row.id),
        task?.updatedAt ?? 0,
        task?.workflowId,
        { tasks },
      );
    }
    case "actividades": {
      const filter = state.filter.actividades;
      if (state.eventLog) {
        const events = eventRows(model, filter);
        const event = events[index];
        return out(
          events.map((row, at) => `${row.at}/${row.type}/${at}`),
          event?.at ?? 0,
          event?.workflowId,
        );
      }
      if (state.activityView === "te_necesitan") {
        const requests = humanRequests(model, filter);
        const request = requests[index];
        return out(
          requests.map((row) => row.id),
          request?.at ?? 0,
          request?.workflowId,
          request?.kind === "approval" ? { approval: request } : {},
        );
      }
      const tasks = activityTasks(model, state.activityView, filter);
      const task = tasks[index];
      return out(
        tasks.map((row) => row.id),
        task?.updatedAt ?? 0,
        task?.workflowId,
      );
    }
    case "agentes": {
      const agents = agentRows(state);
      const agent = agents[index];
      return out(
        agents.map((row) => `${row.workflowId}/${row.code}`),
        0,
        agent?.workflowId,
      );
    }
    case "avance": {
      const rows = progressRows(state);
      return out(
        rows.map((row) => row.id),
        0,
        rows[index]?.workflowId,
      );
    }
    case "sistema":
      return out(
        settingRows(state).map((row) => row.path),
        0,
        undefined,
      );
    case "conexiones": {
      const agents = connectionAgents(state);
      return out(
        agents.map((row) => `${row.workflowId}/${row.code}`),
        0,
        agents[index]?.workflowId,
      );
    }
    case "modelos": {
      const accounts = quotaAccounts(state);
      return out(
        accounts.map((row) => row.id),
        0,
        undefined,
      );
    }
    default:
      return { ...none, ids: [] };
  }
}
