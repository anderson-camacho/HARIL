import {
  type FactoryGlyphs,
  type FactorySeg,
  type FactoryToken,
  factoryCell,
  factorySegsWidth,
} from "./factory-kit.js";
import { boardTasks, selectedRowId, workflowLive } from "./factory-rows.js";
import { FACTORY_COLUMNS, type FactoryState, type FactoryTarget } from "./factory-state.js";
import type { FactoryColumn, FactoryTask, FactoryWorkflow } from "./factory-types.js";
import { plainText, textWidth, wrap } from "./text.js";

// The Tablero tab: the five-column board (kanban-board) with the selected card's plan under it (cluster-rollout). Below
// BOARD_MIN_WIDTH the columns do not fit side by side, so one is shown at a time. Below ROLLOUT_MIN_ROWS the plan gives way
// to its progress bar alone.

type Seg = FactorySeg<FactoryTarget>;
export type BodyLine = readonly Seg[];

const BOARD_MIN_WIDTH = 70;

import { mindMapBody } from "./factory-mindmap.js";

const ROLLOUT_MIN_ROWS = 18;
// A framed card takes this many rows, and a bare one this many.
const CARD_ROWS = 5;
const BARE_CARD_ROWS = 3;
const FRAMED_MIN_ROWS = 14;

export const COLUMN_LABEL: Readonly<Record<FactoryColumn, string>> = {
  por_hacer: "Por hacer",
  en_curso: "En curso",
  detenidas: "Detenidas",
  errores: "Errores",
  hechas: "Hechas",
};

export const COLUMN_TOKEN: Readonly<Record<FactoryColumn, FactoryToken>> = {
  por_hacer: "muted",
  en_curso: "blue",
  detenidas: "yellow",
  errores: "red",
  hechas: "green",
};

const ROLE_LABEL: Readonly<Record<string, string>> = {
  orchestrator: "orquestador",
  delegator: "delegado",
  executor: "ejecutor",
  auditor: "auditor",
};

const ROLE_TOKEN: Readonly<Record<string, FactoryToken>> = {
  orchestrator: "purple",
  delegator: "cyan",
  executor: "blue",
  auditor: "orange",
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

function roleToken(role: string): FactoryToken {
  return ROLE_TOKEN[role] ?? "muted";
}

function delegatedText(task: FactoryTask): string {
  return `delegó: ${task.delegatedBy ?? "tú"}`;
}

function cardLines(
  task: FactoryTask,
  width: number,
  selected: boolean,
  g: FactoryGlyphs,
): BodyLine[] {
  const inner = Math.max(0, width - 2);
  const edge: FactoryToken = selected ? "blue" : "dim";
  const side = selected ? g.heavyV : g.v;
  const titleRoom = Math.max(0, inner - 2);
  const row = (segs: readonly Seg[]): BodyLine => {
    const used = factorySegsWidth(segs);
    return [
      { text: side, token: edge },
      ...segs,
      { text: " ".repeat(Math.max(0, inner - used)), token: "dim" },
      { text: side, token: edge },
    ];
  };
  const codeRoom = textWidth(plainText(task.agent)) + 1;
  const roleRoom = Math.max(0, inner - 3 - codeRoom);
  return [
    [
      {
        text: selected
          ? `${g.heavyTopLeft}${g.heavy.repeat(inner)}${g.heavyTopRight}`
          : `${g.topLeft}${g.h.repeat(inner)}${g.topRight}`,
        token: edge,
      },
    ],
    row([
      { text: selected ? g.pointer : " ", token: "blue" },
      { text: " ", token: "dim" },
      factoryCell(task.title, titleRoom, "text"),
    ]),
    row([
      { text: ` ${g.dot} `, token: roleToken(task.role) },
      factoryCell(roleLabel(task.role), roleRoom, "text"),
      factoryCell(task.agent, codeRoom, "muted", true),
    ]),
    row([{ text: "  ", token: "dim" }, factoryCell(delegatedText(task), titleRoom, "muted")]),
    [
      {
        text: selected
          ? `${g.heavyBottomLeft}${g.heavy.repeat(inner)}${g.heavyBottomRight}`
          : `${g.bottomLeft}${g.h.repeat(inner)}${g.bottomRight}`,
        token: edge,
      },
    ],
  ];
}

function bareCardLines(
  task: FactoryTask,
  width: number,
  selected: boolean,
  g: FactoryGlyphs,
): BodyLine[] {
  return [
    [
      { text: selected ? `${g.pointer} ` : "  ", token: "blue" },
      factoryCell(task.title, Math.max(0, width - 2), "text"),
    ],
    [
      { text: `${g.dot} `, token: roleToken(task.role) },
      factoryCell(`${roleLabel(task.role)} ${task.agent}`, Math.max(0, width - 2), "muted"),
    ],
    [
      { text: "  ", token: "dim" },
      factoryCell(delegatedText(task), Math.max(0, width - 2), "muted"),
    ],
  ];
}

// The rows of one column at `width` by `height`: a window around the selected card, and how many are left out.
function columnBody(
  tasks: readonly FactoryTask[],
  selectedId: string | undefined,
  width: number,
  height: number,
  framed: boolean,
  g: FactoryGlyphs,
): BodyLine[] {
  const rowsPerCard = framed ? CARD_ROWS : BARE_CARD_ROWS;
  const room = Math.max(1, Math.floor(height / rowsPerCard));
  const selected = tasks.findIndex((task) => task.id === selectedId);
  const first = Math.max(0, Math.min(selected >= 0 ? selected - room + 1 : 0, tasks.length - room));
  const start = Math.max(0, first);
  const shown = tasks.slice(start, start + room);
  const lines = shown.flatMap((task) =>
    framed
      ? cardLines(task, width, task.id === selectedId, g)
      : bareCardLines(task, width, task.id === selectedId, g),
  );
  const hidden = tasks.length - shown.length;
  if (hidden > 0 && lines.length < height) {
    lines.push([factoryCell(`+ ${hidden} más`, width, "dim")]);
  } else if (hidden > 0 && lines.length > 0) {
    lines[lines.length - 1] = [factoryCell(`+ ${hidden} más`, width, "dim")];
  }
  return lines.slice(0, height);
}

function columnHeader(
  column: FactoryColumn,
  count: number,
  width: number,
  selected: boolean,
  g: FactoryGlyphs,
): BodyLine[] {
  const label = `${COLUMN_LABEL[column]} ${count}`;
  return [
    [
      { text: selected ? g.pointer : " ", token: "blue" },
      { text: `${g.dot} `, token: COLUMN_TOKEN[column] },
      factoryCell(label, Math.max(0, width - 3), selected ? "text" : "muted"),
    ],
    [
      {
        text: (selected ? g.heavy : g.h).repeat(Math.max(0, width)),
        token: selected ? "blue" : "line",
      },
    ],
  ];
}

// Column cells on one line, each exactly its width.
function joinColumns(
  columns: readonly (readonly BodyLine[])[],
  widths: readonly number[],
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const out: BodyLine[] = [];
  for (let row = 0; row < height; row++) {
    const line: Seg[] = [];
    columns.forEach((lines, index) => {
      if (index > 0) line.push({ text: g.v, token: "line" });
      const width = widths[index] ?? 0;
      const cell = lines[row] ?? [];
      line.push(...cell, {
        text: " ".repeat(Math.max(0, width - factorySegsWidth(cell))),
        token: "dim",
      });
    });
    out.push(line);
  }
  return out;
}

function boardLines(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const tasks = boardTasks(state);
  const selected = tasks[state.selection.tablero];
  const byColumn = (column: FactoryColumn) => tasks.filter((task) => task.column === column);
  if (width < BOARD_MIN_WIDTH) {
    const column = selected?.column ?? "por_hacer";
    const rows = byColumn(column);
    const place = FACTORY_COLUMNS.indexOf(column) + 1;
    const others = FACTORY_COLUMNS.filter((item) => item !== column)
      .map((item) => `${COLUMN_LABEL[item].charAt(0)}${byColumn(item).length}`)
      .join(" ");
    const header: BodyLine = [
      { text: `${g.dot} `, token: COLUMN_TOKEN[column] },
      { text: `${COLUMN_LABEL[column]} ${rows.length}`, token: "text" },
      { text: `  ${place}/5  ${others}`, token: "muted" },
    ];
    const body = columnBody(
      rows,
      selected?.id,
      width,
      Math.max(0, height - 1),
      height - 1 >= FRAMED_MIN_ROWS,
      g,
    );
    return [header, ...body];
  }
  const size = Math.floor((width - (FACTORY_COLUMNS.length - 1)) / FACTORY_COLUMNS.length);
  const widths = FACTORY_COLUMNS.map((_, index) =>
    index === FACTORY_COLUMNS.length - 1
      ? width - (FACTORY_COLUMNS.length - 1) - size * (FACTORY_COLUMNS.length - 1)
      : size,
  );
  const bodyHeight = Math.max(0, height - 2);
  const framed = bodyHeight >= FRAMED_MIN_ROWS - 2;
  const columns = FACTORY_COLUMNS.map((column, index) => {
    const rows = byColumn(column);
    const cell = widths[index] ?? size;
    return [
      ...columnHeader(column, rows.length, cell, selected?.column === column, g),
      ...columnBody(rows, selected?.id, cell, bodyHeight, framed, g),
    ];
  });
  return joinColumns(columns, widths, height, g);
}

// `███░░░ 3/9 cerradas ~33%`; the `~` says the total can still grow.
function progressLine(row: FactoryWorkflow, width: number, g: FactoryGlyphs): BodyLine {
  const ratio = row.totalTasks === 0 ? null : row.closedTasks / row.totalTasks;
  const facts = `${row.closedTasks}/${row.totalTasks} cerradas`;
  const percent =
    ratio === null ? "Sin pruebas" : `${workflowLive(row) ? "~" : ""}${Math.round(ratio * 100)}%`;
  const tail = ` ${facts} ${percent}`;
  const cells = Math.max(0, width - textWidth(tail));
  const on = ratio === null ? 0 : Math.round(ratio * cells);
  return [
    { text: g.barOn.repeat(on), token: "green" },
    { text: g.barOff.repeat(cells - on), token: "dim" },
    { text: tail, token: "muted" },
  ];
}

function rolloutRow(
  task: FactoryTask,
  width: number,
  selected: boolean,
  g: FactoryGlyphs,
): BodyLine {
  const stateWidth = width >= 60 ? 22 : 12;
  const attemptsWidth = width >= 60 ? 9 : 0;
  const modelWidth = width >= 100 ? 22 : 0;
  const codeWidth = 7;
  const titleWidth = Math.max(4, width - 2 - codeWidth - stateWidth - attemptsWidth - modelWidth);
  const attempts = `${task.attempts}${task.maxAttempts === null ? "" : `/${task.maxAttempts}`}`;
  return [
    { text: selected ? `${g.pointer} ` : "  ", token: "blue" },
    factoryCell(task.agent, codeWidth, "text"),
    // A full column keeps one space before the next.
    factoryCell(task.title, titleWidth - 1, "text"),
    { text: " ", token: "dim" },
    factoryCell(task.explanation.what, stateWidth - 1, COLUMN_TOKEN[task.column]),
    { text: " ", token: "dim" },
    ...(attemptsWidth > 0 ? [factoryCell<FactoryTarget>(attempts, attemptsWidth, "muted")] : []),
    ...(modelWidth > 0
      ? [factoryCell<FactoryTarget>(task.model ?? "sin modelo", modelWidth, "muted")]
      : []),
  ];
}

function rolloutHeader(width: number): BodyLine {
  const stateWidth = width >= 60 ? 22 : 12;
  const attemptsWidth = width >= 60 ? 9 : 0;
  const modelWidth = width >= 100 ? 22 : 0;
  const titleWidth = Math.max(4, width - 9 - stateWidth - attemptsWidth - modelWidth);
  return [
    factoryCell("  AGENTE", 9, "muted"),
    factoryCell("TAREA", titleWidth, "muted"),
    factoryCell("ESTADO", stateWidth, "muted"),
    ...(attemptsWidth > 0 ? [factoryCell<FactoryTarget>("INTENTOS", attemptsWidth, "muted")] : []),
    ...(modelWidth > 0 ? [factoryCell<FactoryTarget>("MODELO", modelWidth, "muted")] : []),
  ];
}

// A row with something to explain carries its line under it.
function rolloutRows(
  tasks: readonly FactoryTask[],
  selectedId: string | undefined,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const groups = tasks.map((task) => {
    const lines: BodyLine[] = [rolloutRow(task, width, task.id === selectedId, g)];
    if (task.column === "detenidas" || task.column === "errores") {
      lines.push([
        { text: `  ${g.lastBranch} `, token: "dim" },
        factoryCell(task.explanation.why, Math.max(0, width - 5), COLUMN_TOKEN[task.column]),
      ]);
    }
    return { task, lines };
  });
  const selected = groups.findIndex((group) => group.task.id === selectedId);
  // Starts from the top, and moves down just enough to show the selected row.
  let start = 0;
  const heightOf = (from: number, to: number): number =>
    groups.slice(from, to + 1).reduce((sum, group) => sum + group.lines.length, 0);
  while (selected >= 0 && start < selected && heightOf(start, selected) > height) start += 1;
  return groups
    .slice(start)
    .flatMap((group) => group.lines)
    .slice(0, height);
}

function rolloutLines(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const { workflowId, id } = selectedRowId(state, "tablero");
  const plan = model.workflows.find((row) => row.id === workflowId) ?? model.workflows[0];
  if (plan === undefined) return [];
  const bar = progressLine(plan, width, g);
  const stop: BodyLine[] =
    plan.state === "awaiting_human"
      ? wrap(plainText(plan.explanation.systemAction), Math.max(1, width)).map((line) => [
          factoryCell(line, width, "yellow"),
        ])
      : [];
  if (height < 5 + stop.length) return [...stop, bar].slice(-Math.max(0, height));
  const head: BodyLine[] = [
    [{ text: g.h.repeat(width), token: "line" }],
    [factoryCell(`Plan: ${plan.goal} · ${plan.state}`, width, "text")],
    rolloutHeader(width),
  ];
  const room = Math.max(0, height - head.length - stop.length - 1);
  const tasks = model.tasks.filter((task) => task.workflowId === plan.id);
  return [...head, ...rolloutRows(tasks, id, width, room, g), ...stop, bar].slice(0, height);
}

export function boardBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null || model.tasks.length === 0) {
    return [[factoryCell("  Sin tareas todavía. Pulsa n para delegar una.", width, "muted")]];
  }
  const asked = model.humanRequests.length;
  if (asked > 0 && height >= 3) {
    const head: BodyLine = [{ text: ` Te necesitan ${asked}`, token: "yellow" }];
    return [head, ...boardRows(state, width, height - 1, g)];
  }
  return boardRows(state, width, height, g);
}

function boardRows(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  if (state.tableroView === "mapa") return mindMapBody(state, width, height, g);
  // Below the full plan only its bar is left, with what the person must do when it is stopped.
  const rollout = height >= ROLLOUT_MIN_ROWS ? Math.floor(height * 0.45) : Math.floor(height / 3);
  const lower = rolloutLines(state, width, rollout, g);
  const upper = boardLines(state, width, Math.max(0, height - lower.length), g);
  const filler: BodyLine[] = Array.from(
    { length: Math.max(0, height - lower.length - upper.length) },
    () => [],
  );
  return [...upper, ...filler, ...lower];
}
