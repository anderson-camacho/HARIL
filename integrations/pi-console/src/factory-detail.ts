import { clockText } from "./factory-activity.js";
import { contextText, elapsedText } from "./factory-agents.js";
import { type BodyLine, COLUMN_LABEL, roleLabel } from "./factory-board.js";
import { type FactoryToken, factoryCell } from "./factory-kit.js";
import { percentText } from "./factory-progress.js";
import {
  activityTasks,
  agentRows,
  boardTasks,
  connectionAgents,
  eventRows,
  humanRequests,
  progressRows,
} from "./factory-rows.js";
import type { FactoryState } from "./factory-state.js";
import type { FactoryTask } from "./factory-types.js";
import type { WaitExplanation } from "./orchestration-types.js";
import { plainText, wrap } from "./text.js";

// What Enter opens: one row in full, its explanation in plain words, whatever the tab.

const LABEL_WIDTH = 12;

function field(
  label: string,
  value: string,
  width: number,
  token: FactoryToken = "text",
): BodyLine[] {
  const room = Math.max(1, width - LABEL_WIDTH - 2);
  return wrap(plainText(value), room).map((line, index) => [
    factoryCell(index === 0 ? `  ${label}` : "", LABEL_WIDTH + 2, "muted"),
    factoryCell(line, room, token),
  ]);
}

function explanationLines(explanation: WaitExplanation, width: number): BodyLine[] {
  return [
    ...field("Qué pasa", explanation.what, width, explanation.needsHuman ? "yellow" : "text"),
    ...field("Por qué", explanation.why, width),
    ...field(
      "Qué hace",
      explanation.systemAction,
      width,
      explanation.needsHuman ? "yellow" : "text",
    ),
    ...field("Te necesita", explanation.needsHuman ? "sí" : "no", width),
    ...(explanation.until === null ? [] : field("Hasta", clockText(explanation.until), width)),
  ];
}

function taskDetail(task: FactoryTask, width: number): BodyLine[] {
  const limit = task.maxAttempts === null ? "" : ` de ${task.maxAttempts}`;
  return [
    ...field("Tarea", task.title, width),
    ...field("Columna", COLUMN_LABEL[task.column], width),
    ...field("Agente", `${task.agent} · ${roleLabel(task.role)}`, width),
    ...field("Delegó", task.delegatedBy ?? "tú", width),
    ...(task.returnedTo === null ? [] : field("Devuelta a", task.returnedTo, width, "red")),
    ...field("Modelo", task.model ?? "sin modelo", width),
    ...field("Intentos", `${task.attempts}${limit}`, width),
    ...field("Contexto", contextText(task.context), width),
    ...field("Tokens", String(task.tokens), width),
    ...(task.criteria === null
      ? []
      : field("Criterios", `${task.criteria.passed} de ${task.criteria.total} cumplidos`, width)),
    [],
    ...explanationLines(task.explanation, width),
  ];
}

export function detailBody(state: FactoryState, width: number): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const index = state.selection[state.tab];
  switch (state.tab) {
    case "tablero": {
      const task = boardTasks(state)[index];
      return task === undefined ? [] : taskDetail(task, width);
    }
    case "actividades": {
      const filter = state.filter.actividades;
      if (state.eventLog) {
        const event = eventRows(model, filter)[index];
        return event === undefined
          ? []
          : [
              ...field("Hora", clockText(event.at), width),
              ...field("Tipo", event.type, width),
              ...field("Agente", event.agent ?? "sin agente", width),
              ...field("Flujo", event.workflowId ?? "sin flujo", width),
              ...field("Texto", event.text, width),
            ];
      }
      if (state.activityView === "te_necesitan") {
        const request = humanRequests(model, filter)[index];
        return request === undefined
          ? []
          : [
              ...field("Pide", request.title, width),
              ...field("Proyecto", request.projectSlug, width),
              [],
              ...explanationLines(request.explanation, width),
            ];
      }
      const task = activityTasks(model, state.activityView, filter)[index];
      return task === undefined ? [] : taskDetail(task, width);
    }
    case "conexiones":
    case "agentes": {
      const agent = (state.tab === "agentes" ? agentRows(state) : connectionAgents(state))[index];
      if (agent === undefined) return [];
      const task = model.tasks.find((row) => row.id === agent.taskId);
      return [
        ...field("Agente", `${agent.code} · ${roleLabel(agent.role)}`, width),
        ...field("Estado", agent.status, width),
        ...field("Tiempo", elapsedText(agent.elapsedMs), width),
        ...(task === undefined ? [] : [[], ...taskDetail(task, width)]),
      ];
    }
    case "avance": {
      const row = progressRows(state)[index];
      if (row === undefined) return [];
      return [
        ...field("Nombre", row.label, width),
        ...field("Avance", percentText(row.ratio, row.estimated), width),
        ...field("Hechos", row.detail, width),
        ...(row.workflow === undefined
          ? []
          : [[], ...explanationLines(row.workflow.explanation, width)]),
      ];
    }
    default:
      return [];
  }
}
