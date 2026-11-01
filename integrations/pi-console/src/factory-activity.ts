import type { BodyLine } from "./factory-board.js";
import { COLUMN_TOKEN } from "./factory-board.js";
import { type FactoryGlyphs, factoryCell, factorySegsWidth } from "./factory-kit.js";
import { activityTasks, eventRows, humanRequests } from "./factory-rows.js";
import { ACTIVITY_VIEWS, type ActivityView, type FactoryState } from "./factory-state.js";
import type {
  FactoryEvent,
  FactoryHumanRequest,
  FactoryModel,
  FactoryTask,
} from "./factory-types.js";
import { textWidth } from "./text.js";

// The Actividades tab: an inbox (inbox-list) with sub-views, an unread dot, a search field and two-line rows, and an event
// log (api-request-inspector). What needs the person lives in Te necesitan, answered right here.

const ACTIVITY_LABEL: Readonly<Record<ActivityView, string>> = {
  activas: "Activas",
  en_cola: "En cola",
  fallidas: "Fallidas",
  hechas: "Hechas",
  te_necesitan: "Te necesitan",
};

export function clockText(ms: number): string {
  const date = new Date(ms);
  return [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function viewCount(model: FactoryModel, view: ActivityView, filter: string): number {
  return view === "te_necesitan"
    ? humanRequests(model, filter).length
    : activityTasks(model, view, filter).length;
}

function unreadCount(state: FactoryState, model: FactoryModel): number {
  const tasks = model.tasks.filter((task) => task.updatedAt > (state.seen[task.id] ?? 0)).length;
  const requests = model.humanRequests.filter((row) => (state.seen[row.id] ?? 0) < row.at).length;
  return tasks + requests;
}

// `[ Buscar / ]`, or what is being typed.
export function searchField(state: FactoryState): string {
  const text = state.filter[state.tab];
  if (state.filtering) return `[ ${text}_ ]`;
  return text === "" ? "[ Buscar / ]" : `[ ${text} ]`;
}

function headerLine(state: FactoryState, model: FactoryModel, width: number): BodyLine {
  const field = searchField(state);
  const unread = unreadCount(state, model);
  const left = `Actividades  ${unread} sin leer`;
  const gap = width - textWidth(left) - textWidth(field);
  if (gap < 1) return [factoryCell(field, width, "muted")];
  return [
    { text: "Actividades", token: "text" },
    { text: `  ${unread} sin leer`, token: unread > 0 ? "blue" : "muted" },
    { text: " ".repeat(gap), token: "dim" },
    { text: field, token: state.filtering ? "blue" : "muted" },
  ];
}

function viewBar(
  state: FactoryState,
  model: FactoryModel,
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const filter = state.filter.actividades;
  const labelOf = (view: ActivityView): string => {
    const count = viewCount(model, view, filter);
    const text = count === 0 ? ACTIVITY_LABEL[view] : `${ACTIVITY_LABEL[view]} ${count}`;
    return view === state.activityView ? `[${text}]` : text;
  };
  const full = ACTIVITY_VIEWS.map((view) => ({
    view,
    text: labelOf(view),
  }));
  const fullWidth = full.reduce((sum, item) => sum + textWidth(item.text) + 2, 0);
  const place = ACTIVITY_VIEWS.indexOf(state.activityView) + 1;
  const items =
    fullWidth <= width
      ? full
      : [{ view: state.activityView, text: `${labelOf(state.activityView)} ${place}/5` }];
  const line: BodyLine = items.flatMap((item) => [
    {
      text: item.text,
      token: item.view === state.activityView ? ("blue" as const) : ("muted" as const),
    },
    { text: "  ", token: "dim" as const },
  ]);
  const activeStart = items
    .slice(
      0,
      items.findIndex((item) => item.view === state.activityView),
    )
    .reduce((sum, item) => sum + textWidth(item.text) + 2, 0);
  const activeWidth = textWidth(items.find((item) => item.view === state.activityView)?.text ?? "");
  const rule: BodyLine = [
    { text: g.h.repeat(Math.min(width, activeStart)), token: "line" },
    {
      text: g.heavy.repeat(Math.max(0, Math.min(activeWidth, width - activeStart))),
      token: "blue",
    },
    { text: g.h.repeat(Math.max(0, width - activeStart - activeWidth)), token: "line" },
  ];
  return [line, rule];
}

function inboxRow(
  first: { readonly who: string; readonly title: string; readonly at: number },
  second: string,
  stripe: BodyLine[number]["token"],
  unread: boolean,
  selected: boolean,
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const time = clockText(first.at);
  const lead = 5;
  const whoWidth = Math.min(6, Math.max(3, textWidth(first.who) + 1));
  const titleWidth = Math.max(0, width - lead - whoWidth - time.length - 1);
  return [
    [
      { text: selected ? g.pointer : " ", token: "blue" },
      { text: unread ? g.dot : " ", token: "blue" },
      { text: " ", token: "dim" },
      { text: g.v, token: stripe },
      { text: " ", token: "dim" },
      factoryCell(first.who, whoWidth, unread ? "text" : "muted"),
      factoryCell(first.title, titleWidth, unread ? "text" : "muted"),
      { text: ` ${time}`, token: "muted" },
    ],
    [
      { text: " ".repeat(Math.min(width, lead)), token: "dim" },
      factoryCell(second, Math.max(0, width - lead), "dim"),
    ],
  ];
}

function taskRow(
  task: FactoryTask,
  state: FactoryState,
  selected: boolean,
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  return inboxRow(
    { who: task.agent, title: task.title, at: task.updatedAt },
    `${task.explanation.what}: ${task.explanation.why}`,
    COLUMN_TOKEN[task.column],
    task.updatedAt > (state.seen[task.id] ?? 0),
    selected,
    width,
    g,
  );
}

function requestRow(
  row: FactoryHumanRequest,
  state: FactoryState,
  selected: boolean,
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const who =
    row.kind === "approval"
      ? "plan"
      : row.kind === "stop"
        ? "flujo"
        : row.kind === "human"
          ? "pide"
          : "tarea";
  const asked = row.request;
  const sameKind =
    asked === null
      ? 0
      : (state.model?.humanRequests.filter((other) => other.request?.reason === asked.reason)
          .length ?? 0);
  return inboxRow(
    { who, title: row.title, at: row.at },
    asked === null
      ? row.explanation.systemAction
      : `${sameKind > 1 ? `${sameKind} de este tipo · ` : ""}${asked.why} · bloquea a ${asked.blocks.join(", ")}`,
    "yellow",
    (state.seen[row.id] ?? 0) < row.at,
    selected,
    width,
    g,
  );
}

function windowed(
  lines: readonly BodyLine[][],
  selected: number,
  height: number,
  perRow: number,
): BodyLine[] {
  const room = Math.max(1, Math.floor(height / perRow));
  const start = Math.max(0, Math.min(selected - room + 1, lines.length - room));
  return lines.slice(Math.max(0, start), Math.max(0, start) + room).flat();
}

function eventLine(
  event: FactoryEvent,
  selected: boolean,
  width: number,
  g: FactoryGlyphs,
): BodyLine {
  const typeWidth = width >= 60 ? 26 : 0;
  const agentWidth = 6;
  const clock = 6;
  const textRoom = Math.max(0, width - 2 - clock - typeWidth - agentWidth);
  const failed = /fail|reject|error/i.test(event.type);
  return [
    { text: selected ? `${g.pointer} ` : "  ", token: "blue" },
    factoryCell(clockText(event.at), clock, "muted"),
    ...(typeWidth > 0
      ? [factoryCell<never>(event.type, typeWidth, failed ? "red" : "blue") as BodyLine[number]]
      : []),
    factoryCell(event.agent ?? "-", agentWidth, "text"),
    factoryCell(event.text, textRoom, "muted"),
  ];
}

function eventLog(
  state: FactoryState,
  model: FactoryModel,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const rows = eventRows(model, state.filter.actividades);
  const selected = state.selection.actividades;
  const failures = rows.filter((row) => /fail|reject|error/i.test(row.type)).length;
  const top: BodyLine = [
    factoryCell(
      `Eventos  ${rows.length} · ${failures} fallos  ${searchField(state)}`,
      width,
      failures > 0 ? "orange" : "muted",
    ),
  ];
  const typeWidth = width >= 60 ? 26 : 0;
  const header: BodyLine = [
    factoryCell("  Hora", 8, "muted"),
    ...(typeWidth > 0 ? [factoryCell<never>("Tipo", typeWidth, "muted") as BodyLine[number]] : []),
    factoryCell("Quién", 6, "muted"),
    factoryCell("Texto", Math.max(0, width - 14 - typeWidth), "muted"),
  ];
  const rule: BodyLine = [{ text: g.h.repeat(width), token: "line" }];
  const room = Math.max(0, height - 3);
  if (rows.length === 0)
    return [top, header, rule, [factoryCell("  Sin eventos.", width, "muted")]];
  const lines = rows.map((row, index) => [eventLine(row, index === selected, width, g)]);
  return [top, header, rule, ...windowed(lines, selected, room, 1)];
}

export function activityBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  if (state.eventLog) return eventLog(state, model, width, height, g);
  const head = [headerLine(state, model, width), ...viewBar(state, model, width, g)];
  const filter = state.filter.actividades;
  const selected = state.selection.actividades;
  const groups =
    state.activityView === "te_necesitan"
      ? humanRequests(model, filter).map((row, index) =>
          requestRow(row, state, index === selected, width, g),
        )
      : activityTasks(model, state.activityView, filter).map((task, index) =>
          taskRow(task, state, index === selected, width, g),
        );
  if (groups.length === 0) {
    const empty =
      state.activityView === "te_necesitan"
        ? "  Nada espera una respuesta tuya."
        : `  Sin tareas en ${ACTIVITY_LABEL[state.activityView]}.`;
    return [...head, [factoryCell(empty, width, "muted")]];
  }
  return [...head, ...windowed(groups, selected, Math.max(2, height - head.length), 2)].filter(
    (line) => factorySegsWidth(line) <= width || width <= 5,
  );
}
