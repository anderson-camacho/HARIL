import type { BodyLine } from "./factory-board.js";
import { type FactoryGlyphs, FactoryGrid, type FactoryToken, factoryCell } from "./factory-kit.js";
import { type ProgressRow, progressRows } from "./factory-rows.js";
import { AVANCE_SCOPES, type AvanceScope, type FactoryState } from "./factory-state.js";
import type { FactoryModel, FactoryWorkflow } from "./factory-types.js";
import { textWidth } from "./text.js";

// The Avance tab: a ring (donut-chart) with four gauges (gauge-cluster), the history of closed tasks
// (star-history-climb) and per-row bars (coverage-report). Every number comes from a fact: closed tasks, passed criteria,
// tokens used, agents created. With no fact the indicator says `Sin pruebas`, never 0, and `~` marks a total that can still
// grow. When the window is too small each drawing degrades to a bar, and the layout never breaks.

const NO_PROOF = "Sin pruebas";
const TAU = Math.PI * 2;
const RING_MIN_ROWS = 7;
const RING_MIN_WIDTH = 60;
const ARCS_MIN_WIDTH = 96;
const ARCS_MIN_ROWS = 8;
const HISTORY_MIN_ROWS = 5;

const SCOPE_LABEL: Readonly<Record<AvanceScope, string>> = {
  proyecto: "Proyecto",
  tarea: "Tarea",
  agente: "Agente",
  modelo: "Modelo",
};

// The reference's thresholds.
function ratioToken(ratio: number): FactoryToken {
  return ratio >= 0.9 ? "green" : ratio >= 0.7 ? "yellow" : ratio >= 0.5 ? "orange" : "red";
}

export function percentText(ratio: number | null, estimated: boolean): string {
  if (ratio === null) return NO_PROOF;
  return `${estimated ? "~" : ""}${Math.round(ratio * 100)}%`;
}

interface Gauge {
  readonly name: string;
  // True for a limit being used up, where more is worse (Agentes, Tokens); false where more is better.
  readonly load: boolean;
  readonly ratio: number | null;
  readonly estimated: boolean;
  readonly facts: string;
}

// The workflows the indicators add up: the selected one, or all of them for the first row.
function scopeOf(model: FactoryModel, row: ProgressRow | undefined): readonly FactoryWorkflow[] {
  return row?.workflow === undefined ? model.workflows : [row.workflow];
}

function gaugesOf(rows: readonly FactoryWorkflow[]): Gauge[] {
  const sum = (pick: (row: FactoryWorkflow) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  const live = rows.some((row) => row.state === "running" || row.state === "awaiting_human");
  const total = sum((row) => row.totalTasks);
  const closed = sum((row) => row.closedTasks);
  const cap = sum((row) => row.agentsCap);
  const agents = sum((row) => row.agentsCreated);
  const tokens = sum((row) => row.tokensUsed);
  const budget = rows.some((row) => row.tokensBudget === null)
    ? 0
    : sum((row) => row.tokensBudget ?? 0);
  const judged = rows.flatMap((row) => (row.criteria === null ? [] : [row.criteria]));
  const criteriaTotal = judged.reduce((sum2, row) => sum2 + row.total, 0);
  const criteriaPassed = judged.reduce((sum2, row) => sum2 + row.passed, 0);
  return [
    {
      name: "Tareas",
      load: false,
      ratio: total === 0 ? null : closed / total,
      estimated: live,
      facts: `${closed}/${total}`,
    },
    {
      name: "Agentes",
      load: true,
      ratio: cap === 0 ? null : Math.min(1, agents / cap),
      estimated: false,
      facts: `${agents}/${cap}`,
    },
    {
      name: "Tokens",
      load: true,
      ratio: budget === 0 ? null : Math.min(1, tokens / budget),
      estimated: false,
      facts: budget === 0 ? String(tokens) : `${tokens}/${budget}`,
    },
    {
      name: "Calidad",
      load: false,
      ratio: criteriaTotal === 0 ? null : criteriaPassed / criteriaTotal,
      estimated: false,
      facts: criteriaTotal === 0 ? "" : `${criteriaPassed}/${criteriaTotal}`,
    },
  ];
}

// The ring of donut-chart, scaled to its height: a cell is twice as tall as it is wide.
function ringGrid(
  ratio: number | null,
  label: string,
  rows: number,
  estimated: boolean,
  g: FactoryGlyphs,
): FactoryGrid {
  const width = rows * 2 + 2;
  const grid = new FactoryGrid(width, rows);
  const cx = width / 2;
  const cy = rows / 2;
  const outer = rows / 2 - 0.1;
  const inner = outer * 0.62;
  const shown = ratio ?? 0;
  const token = ratio === null ? "dim" : ratioToken(ratio);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x + 0.5 - cx) / 2;
      const dy = y + 0.5 - cy;
      const radius = Math.hypot(dx, dy);
      if (radius < inner || radius > outer) continue;
      let angle = Math.atan2(dx, -dy) / TAU;
      if (angle < 0) angle += 1;
      if (ratio !== null && angle <= shown) grid.set(x, y, g.barOn, token);
      else grid.set(x, y, g.barMid, "dim");
    }
  }
  const percent = percentText(ratio, estimated);
  const middle = Math.floor(rows / 2);
  const center = (text: string): number => Math.max(0, Math.round(cx - textWidth(text) / 2));
  const room = Math.floor(inner * 4);
  if (textWidth(percent) <= room)
    grid.text(center(percent), middle - (rows >= 9 ? 1 : 0), percent, "text");
  if (rows >= 9 && textWidth(label) <= room) grid.text(center(label), middle + 1, label, "muted");
  return grid;
}

// An arc of gauge-cluster, from 210 to -30 degrees, its value and its name under it.
function arcGrid(gauge: Gauge, width: number, rows: number, g: FactoryGlyphs): FactoryGrid {
  const grid = new FactoryGrid(width, rows);
  const radius = Math.min((width - 2) / 2, (rows - 2) * 2 - 1);
  const cx = width / 2;
  const cy = rows - 2;
  const shown = gauge.ratio ?? 0;
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx;
      const dy = (y + 0.5 - cy) * 2;
      const distance = Math.hypot(dx, dy);
      if (distance < radius * 0.62 || distance > radius) continue;
      let angle = Math.atan2(-dy, dx);
      if (angle < -Math.PI / 2) angle += TAU;
      const at = ((Math.PI * 7) / 6 - angle) / ((Math.PI * 4) / 3);
      if (at < 0 || at > 1) continue;
      const on = gauge.ratio !== null && at <= shown;
      grid.set(x, y, on ? g.barOn : g.barOff, on ? gaugeToken(gauge, at) : "line");
    }
  }
  const value = percentText(gauge.ratio, gauge.estimated);
  grid.text(
    Math.max(0, Math.round(cx - textWidth(value) / 2)),
    cy,
    value,
    gauge.ratio === null ? "dim" : "text",
  );
  grid.text(Math.max(0, Math.round(cx - textWidth(gauge.name) / 2)), cy + 1, gauge.name, "muted");
  return grid;
}

// The reference's zones for a limit being used up; the ratio's own color for the rest.
function gaugeToken(gauge: Gauge, at: number): FactoryToken {
  if (!gauge.load) return gauge.ratio === null ? "dim" : ratioToken(gauge.ratio);
  return at < 0.6 ? "green" : at < 0.8 ? "yellow" : at < 0.9 ? "orange" : "red";
}

function gaugeBars(gauges: readonly Gauge[], width: number, g: FactoryGlyphs): BodyLine[] {
  return gauges.map((gauge) => {
    const percent = percentText(gauge.ratio, gauge.estimated);
    const nameWidth = 8;
    const tail =
      gauge.ratio === null ? percent : gauge.facts === "" ? percent : `${percent} ${gauge.facts}`;
    const tailWidth = Math.min(Math.max(0, width - nameWidth), textWidth(tail) + 1);
    const cells = Math.max(0, width - nameWidth - tailWidth);
    const on = gauge.ratio === null ? 0 : Math.round(gauge.ratio * cells);
    const token = gaugeToken(gauge, gauge.ratio ?? 0);
    return [
      factoryCell(gauge.name, nameWidth, "muted"),
      { text: g.barOn.repeat(on), token },
      { text: g.barOff.repeat(cells - on), token: "dim" },
      factoryCell(` ${tail}`, tailWidth, gauge.ratio === null ? "dim" : "text"),
    ];
  });
}

// Each closed task's moment, cumulated into as many points as columns there are.
function closedSeries(
  model: FactoryModel,
  workflows: readonly FactoryWorkflow[],
  points: number,
): number[] {
  const ids = new Set(workflows.map((row) => row.id));
  const times = model.tasks
    .filter((task) => ids.has(task.workflowId) && task.closedAt !== null)
    .map((task) => task.closedAt as number)
    .sort((a, b) => a - b);
  const start = Math.min(...workflows.map((row) => row.startedAt), times[0] ?? model.generatedAt);
  const end = Math.max(model.generatedAt, times[times.length - 1] ?? start);
  const span = Math.max(1, end - start);
  return Array.from({ length: points }, (_, index) => {
    const moment = start + (span * (index + 1)) / points;
    return times.filter((time) => time <= moment).length;
  });
}

function sparkLine(series: readonly number[], g: FactoryGlyphs): string {
  const top = Math.max(1, ...series);
  const glyphs = Array.from(g.spark);
  return series
    .map((value) => glyphs[Math.min(glyphs.length - 1, Math.floor((value / top) * glyphs.length))])
    .join("");
}

function historyLines(
  model: FactoryModel,
  workflows: readonly FactoryWorkflow[],
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const closedTotal = model.tasks.filter(
    (task) => task.closedAt !== null && workflows.some((row) => row.id === task.workflowId),
  ).length;
  const title: BodyLine = [
    { text: `${g.star} `, token: "yellow" },
    factoryCell(`Tareas cerradas  ${closedTotal}`, Math.max(0, width - 2), "text"),
  ];
  if (height <= 0) return [];
  if (closedTotal === 0 || workflows.length === 0) {
    const none: BodyLine = [
      factoryCell(`  ${NO_PROOF}: aún no cierra ninguna tarea.`, width, "muted"),
    ];
    return [title, none].slice(0, height);
  }
  if (height < HISTORY_MIN_ROWS) {
    const series = closedSeries(model, workflows, Math.max(1, width));
    const spark: BodyLine = [{ text: sparkLine(series, g), token: "yellow" }];
    return [title, spark].slice(0, height);
  }
  const axis = String(closedTotal).length + 1;
  const plotWidth = Math.max(1, width - axis - 1);
  const plotRows = height - 2;
  const series = closedSeries(model, workflows, plotWidth);
  const grid = new FactoryGrid(width, plotRows);
  const yOf = (value: number): number =>
    plotRows - 1 - Math.round((value / Math.max(1, closedTotal)) * (plotRows - 1));
  grid.text(0, 0, String(closedTotal).padStart(axis - 1), "muted");
  grid.text(0, plotRows - 1, "0".padStart(axis - 1), "muted");
  for (let y = 0; y < plotRows; y++) grid.set(axis, y, g.v, "line");
  series.forEach((value, index) => {
    const x = axis + 1 + index;
    const y = yOf(value);
    for (let below = y + 1; below < plotRows; below++) grid.set(x, below, g.fill, "orange");
    grid.set(x, y, g.point, "yellow");
  });
  const footer: BodyLine = [
    { text: " ".repeat(Math.max(0, axis)), token: "dim" },
    factoryCell("inicio", Math.max(0, width - axis - 5), "muted"),
    factoryCell("ahora", Math.min(5, width), "muted", true),
  ];
  return [
    title,
    ...Array.from({ length: plotRows }, (_, y) => grid.segs<never>(y) as BodyLine),
    footer,
  ];
}

function scopeBar(state: FactoryState, width: number): BodyLine {
  const items = AVANCE_SCOPES.map((scope) =>
    scope === state.avanceScope ? `[${SCOPE_LABEL[scope]}]` : SCOPE_LABEL[scope],
  );
  const total = items.reduce((sum, item) => sum + textWidth(item) + 2, 0);
  if (total > width) return [factoryCell(`[${SCOPE_LABEL[state.avanceScope]}]`, width, "blue")];
  return AVANCE_SCOPES.flatMap((scope, index) => [
    {
      text: items[index] as string,
      token: scope === state.avanceScope ? ("blue" as const) : ("muted" as const),
    },
    { text: "  ", token: "dim" as const },
  ]);
}

function projectBody(
  state: FactoryState,
  model: FactoryModel,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const rows = progressRows(state);
  const selected = rows[state.selection.avance];
  const scope = scopeOf(model, selected);
  const gauges = gaugesOf(scope);
  const tareas = gauges[0] as Gauge;
  const title: BodyLine = [
    factoryCell(
      `${g.pointer} ${selected?.label ?? ""} · ${state.selection.avance + 1}/${rows.length}`,
      width,
      "text",
    ),
  ];
  const room = height - 1;
  const out: BodyLine[] = [title];
  let used = 0;
  if (width >= RING_MIN_WIDTH && room >= RING_MIN_ROWS) {
    const ringRows = Math.min(room >= 22 ? 13 : room >= 14 ? 9 : RING_MIN_ROWS, room);
    const ring = ringGrid(tareas.ratio, "cerradas", ringRows, tareas.estimated, g);
    const side = width - ring.width - 2;
    const arcs = width >= ARCS_MIN_WIDTH && ringRows >= ARCS_MIN_ROWS;
    const arcWidth = Math.floor(side / gauges.length);
    const arcGrids = arcs
      ? gauges.map((gauge) => arcGrid(gauge, arcWidth, Math.min(ringRows, 8), g))
      : [];
    const bars = arcs ? [] : gaugeBars(gauges, side, g);
    for (let y = 0; y < ringRows; y++) {
      const right: BodyLine = arcs
        ? arcGrids.flatMap((grid) => grid.segs<never>(y) as BodyLine)
        : (bars[y] ?? []);
      out.push([...(ring.segs<never>(y) as BodyLine), { text: "  ", token: "dim" }, ...right]);
    }
    used = ringRows;
  } else {
    const bars = gaugeBars(gauges, width, g).slice(0, room);
    out.push(...bars);
    used = bars.length;
  }
  const left = room - used;
  if (left >= 2) out.push(...historyLines(model, scope, width, left, g));
  return out;
}

function coverageBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const rows = progressRows(state);
  if (rows.length === 0) return [[factoryCell(`  ${NO_PROOF}.`, width, "muted")]];
  const selected = state.selection.avance;
  const barWidth = width >= 90 ? 26 : width >= 60 ? 14 : 0;
  const percentWidth = 12;
  const subWidth = width >= 60 ? 7 : 0;
  const labelWidth = Math.max(
    4,
    width - 2 - barWidth - percentWidth - subWidth - (barWidth > 0 ? 1 : 0),
  );
  const header: BodyLine = [
    factoryCell("  Nombre", 2 + labelWidth, "text"),
    ...(subWidth > 0 ? [factoryCell<never>("Hecho", subWidth, "text")] : []),
    factoryCell("Avance", percentWidth, "text"),
    ...(barWidth > 0 ? [factoryCell<never>("Barra", barWidth, "text")] : []),
  ];
  const room = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(selected - room + 1, rows.length - room));
  const lines = rows.slice(start, start + room).map((row, offset): BodyLine => {
    const token: FactoryToken = row.ratio === null ? "dim" : ratioToken(row.ratio);
    const on = row.ratio === null ? 0 : Math.round(row.ratio * barWidth);
    return [
      { text: start + offset === selected ? `${g.pointer} ` : "  ", token: "blue" },
      factoryCell(row.label, labelWidth, "text"),
      ...(subWidth > 0 ? [factoryCell<never>(row.sub, subWidth, "muted")] : []),
      factoryCell(percentText(row.ratio, row.estimated), percentWidth, token),
      ...(barWidth > 0 && row.ratio !== null
        ? [
            { text: ` ${g.barOn.repeat(on)}`, token },
            { text: g.barOff.repeat(barWidth - on), token: "line" as const },
          ]
        : []),
    ];
  });
  const judged = rows.filter((row) => row.ratio !== null);
  const summary =
    judged.length === 0
      ? `Total: ${NO_PROOF}`
      : `Total: ${judged.length} de ${rows.length} con pruebas · media ${Math.round(
          (judged.reduce((sum, row) => sum + (row.ratio ?? 0), 0) / judged.length) * 100,
        )}%`;
  return [
    header,
    [{ text: g.h.repeat(width), token: "line" }],
    ...lines,
    [factoryCell(summary, width, "muted")],
  ];
}

export function progressBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const bar = scopeBar(state, width);
  const room = Math.max(0, height - 1);
  const body =
    state.avanceScope === "proyecto"
      ? projectBody(state, model, width, room, g)
      : coverageBody(state, width, room, g);
  return [bar, ...body];
}
