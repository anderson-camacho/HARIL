import { activityBody, searchField } from "./factory-activity.js";
import { agentsBody } from "./factory-agents.js";
import { type BodyLine, boardBody } from "./factory-board.js";
import { detailBody } from "./factory-detail.js";
import {
  type FactoryGlyphs,
  type FactoryRow,
  type FactorySeg,
  factoryBoxRow,
  factoryCompose,
  factoryFrameBottom,
  factoryFrameTop,
  factorySegsWidth,
} from "./factory-kit.js";
import { modelosBody, modelosDetail } from "./factory-models.js";
import { progressBody } from "./factory-progress.js";
import {
  approvalTarget,
  continueTarget,
  FACTORY_TABS,
  type FactoryState,
  type FactoryTab,
  type FactoryTarget,
} from "./factory-state.js";

// The factory's screen, pure: a state, a width and a height in, the lines and their hit-boxes out. A tab bar on top, the
// tab's framed body, and a footer with the keys that work right now. Avance, Actividades, Tablero and Agentes draw what
// haril factory watch printed; the other three have no data source yet and say so. This screen never draws sample data.

export const FACTORY_TAB_LABELS: Readonly<Record<FactoryTab, string>> = {
  avance: "Avance",
  actividades: "Actividades",
  tablero: "Tablero",
  agentes: "Agentes",
  conexiones: "Conexiones",
  modelos: "Modelos",
  sistema: "Sistema",
};

const TAB_PURPOSE: Readonly<Record<FactoryTab, string>> = {
  avance: "Aquí se verá el avance del trabajo en curso.",
  actividades: "Aquí se verá lo que hace cada agente.",
  tablero: "Aquí se verán las tareas por estado.",
  agentes: "Aquí se verán los agentes y sus roles.",
  conexiones: "Aquí se verá quién habla con quién y a quién espera cada agente.",
  modelos: "Aquí se verán las cuentas, sus grupos de modelos y su cuota.",
  sistema: "Aquí se verá la configuración de la fábrica.",
};

const NO_DATA = "Sin datos conectados todavía";
const FEED_ENDED = "La lectura de datos se detuvo: `haril factory watch` no responde.";
const SEPARATOR = " · ";
// Below this height a frame would leave no room for its text.
const MIN_FRAMED_ROWS = 5;

interface FactoryHit {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly target: FactoryTarget;
}

interface RenderedFactory {
  readonly lines: string[];
  readonly hits: FactoryHit[];
}

type Seg = FactorySeg<FactoryTarget>;

function tabSeg(tab: FactoryTab, active: FactoryTab, text: string): Seg {
  return {
    text: tab === active ? `[${text}]` : text,
    token: tab === active ? "blue" : "muted",
    target: { kind: "tab", tab },
  };
}

function joined(items: readonly Seg[], separator: string): Seg[] {
  return items.flatMap((item, index) =>
    index === 0 ? [item] : [{ text: separator, token: "dim" }, item],
  );
}

// The widest bar that fits: number and label; label; or, when narrow, only the active tab's label among the numbers, so
// every tab can still be clicked. Under that width the line is cut.
function tabBar(active: FactoryTab, width: number): Seg[] {
  const numberOf = (tab: FactoryTab): number => FACTORY_TABS.indexOf(tab) + 1;
  const numbered = FACTORY_TABS.map((tab) =>
    tabSeg(tab, active, `${numberOf(tab)} ${FACTORY_TAB_LABELS[tab]}`),
  );
  const labelled = FACTORY_TABS.map((tab) => tabSeg(tab, active, FACTORY_TAB_LABELS[tab]));
  const compact = FACTORY_TABS.map((tab) =>
    tabSeg(
      tab,
      active,
      tab === active ? `${numberOf(tab)} ${FACTORY_TAB_LABELS[tab]}` : `${numberOf(tab)}`,
    ),
  );
  const fits = [joined(numbered, "  "), joined(labelled, "  ")].find(
    (segs) => factorySegsWidth(segs) + 1 <= width,
  );
  return [{ text: " ", token: "muted" }, ...(fits ?? joined(compact, " "))];
}

interface Hint {
  readonly key: string;
  readonly action: string;
  // The lower, the sooner it gives way when the footer does not fit. Esc never does.
  readonly keep: number;
  readonly target?: FactoryTarget;
}

function dataTab(state: FactoryState): boolean {
  return (
    state.model !== null &&
    (state.tab === "avance" ||
      state.tab === "actividades" ||
      state.tab === "tablero" ||
      state.tab === "agentes" ||
      state.tab === "modelos")
  );
}

// The keys of the tab open now, and only those that would do something.
function tabHints(state: FactoryState): Hint[] {
  const out: Hint[] = [];
  if (!dataTab(state)) return out;
  if (!state.detail) {
    out.push({ key: "/", action: "buscar", keep: 1 });
    if (state.tab === "tablero") {
      if (state.rowCounts.tablero > 0) out.push({ key: "h/l", action: "columna", keep: 1 });
      if (!state.readOnly) out.push({ key: "n", action: "nueva", keep: 1 });
    }
    if (state.tab === "actividades") {
      if (!state.eventLog) out.push({ key: "[/]", action: "vista", keep: 1 });
      out.push({ key: "e", action: state.eventLog ? "bandeja" : "eventos", keep: 1 });
    }
    if (state.tab === "avance") out.push({ key: "[/]", action: "vista", keep: 1 });
    if (state.tab === "modelos") {
      out.push({ key: "[/]", action: "vista", keep: 1 }, { key: "r", action: "releer", keep: 3 });
    }
    if (state.tab === "agentes")
      out.push({ key: "t", action: state.agentsTree ? "lista" : "árbol", keep: 1 });
  }
  if (!state.readOnly) {
    if (approvalTarget(state) !== null) {
      out.push({ key: "a", action: "aprobar", keep: 3 }, { key: "d", action: "negar", keep: 3 });
    }
    if (continueTarget(state) !== null) out.push({ key: "c", action: "continuar", keep: 3 });
  }
  return out;
}

function hintsOf(state: FactoryState, g: FactoryGlyphs): Hint[] {
  if (state.confirm !== null) {
    return [
      { key: "s", action: "confirmar", keep: 4 },
      { key: "n", action: "cancelar", keep: 4 },
    ];
  }
  if (state.filtering) {
    return [
      { key: "Enter", action: "aplicar", keep: 4 },
      { key: "Esc", action: "limpiar", keep: 4 },
    ];
  }
  const hasRows = state.rowCounts[state.tab] > 0 && !state.detail;
  const canGoBack =
    state.detail ||
    (dataTab(state) && state.filter[state.tab] !== "") ||
    (state.tab === "actividades" && state.eventLog);
  return [
    { key: g.leftRight, action: "pestaña", keep: 2 },
    { key: "1-7", action: "ir", keep: 0 },
    ...(hasRows
      ? [
          { key: g.upDown, action: "mover", keep: 2 },
          { key: "Enter", action: "detalle", keep: 1 },
        ]
      : []),
    ...tabHints(state),
    canGoBack
      ? { key: "Esc", action: "volver", keep: 4, target: { kind: "back" } as const }
      : { key: "Esc", action: "cerrar", keep: 4, target: { kind: "close" } as const },
  ];
}

function hintSegs(hints: readonly Hint[]): Seg[] {
  const out: Seg[] = [{ text: " ", token: "muted" }];
  hints.forEach((hint, index) => {
    if (index > 0) out.push({ text: SEPARATOR, token: "dim" });
    const target = hint.target === undefined ? {} : { target: hint.target };
    out.push({ text: hint.key, token: "blue", ...target });
    out.push({ text: ` ${hint.action}`, token: "muted", ...target });
  });
  return out;
}

function footer(state: FactoryState, width: number, g: FactoryGlyphs): Seg[] {
  let hints = hintsOf(state, g);
  while (factorySegsWidth(hintSegs(hints)) > width && hints.length > 1) {
    const lowest = Math.min(...hints.map((hint) => hint.keep));
    const remaining = hints.filter((hint) => hint.keep !== lowest);
    if (remaining.length === 0) break;
    hints = remaining;
  }
  return hintSegs(hints);
}

function bodyMessages(state: FactoryState): BodyLine[] {
  if (state.feedEnded && state.model === null) {
    return [
      [{ text: `  ${NO_DATA}`, token: "yellow" }],
      [{ text: `  ${FEED_ENDED}`, token: "muted" }],
    ];
  }
  return [
    [{ text: `  ${NO_DATA}`, token: "yellow" }],
    [{ text: `  ${TAB_PURPOSE[state.tab]}`, token: "muted" }],
  ];
}

// While the first line of the feed is on its way: bars in the shape of a card, which stand for no value at all.
function skeletonLines(width: number, g: FactoryGlyphs): BodyLine[] {
  const bar = (size: number): BodyLine => [
    { text: `  ${g.barOn.repeat(Math.max(0, Math.min(size, width - 2)))}`, token: "line" },
  ];
  return [[], bar(18), bar(36), bar(28)];
}

// The tab's own lines at `width` by `height`.
function tabBody(state: FactoryState, width: number, height: number, g: FactoryGlyphs): BodyLine[] {
  if (!dataTab(state)) {
    const loading = state.tab === "modelos" && state.model === null && !state.feedEnded;
    const messages = [...bodyMessages(state), ...(loading ? skeletonLines(width, g) : [])];
    // A blank row above the text when there is room for it.
    return height >= messages.length + 1 ? [[], ...messages] : messages;
  }
  if (state.detail) {
    return state.tab === "modelos" ? modelosDetail(state, width, g) : detailBody(state, width);
  }
  switch (state.tab) {
    case "modelos":
      return modelosBody(state, width, height, g);
    case "tablero":
      return boardBody(state, width, height, g);
    case "actividades":
      return activityBody(state, width, height, g);
    case "agentes":
      return agentsBody(state, width, height, g);
    default:
      return progressBody(state, width, height, g);
  }
}

// The question waiting for s or n, or the answer to the last action.
function statusLine(state: FactoryState): BodyLine | undefined {
  if (state.confirm !== null) {
    return [{ text: ` ¿${state.confirm.label}? s/n`, token: "yellow" }];
  }
  return state.notice === null ? undefined : [{ text: ` ${state.notice}`, token: "orange" }];
}

function frameRight(state: FactoryState): string {
  const position = `${FACTORY_TABS.indexOf(state.tab) + 1}/${FACTORY_TABS.length}`;
  if (!dataTab(state) || state.tab === "actividades") return position;
  return state.filtering || state.filter[state.tab] !== "" ? searchField(state) : position;
}

export function renderFactoryScreen(
  state: FactoryState,
  width: number,
  rows: number,
  g: FactoryGlyphs,
): RenderedFactory {
  const lines: string[] = [];
  const hits: FactoryHit[] = [];
  const push = (row: FactoryRow<FactoryTarget>): void => {
    for (const hit of row.hits) hits.push({ row: lines.length, ...hit });
    lines.push(row.text);
  };
  const height = Math.max(0, rows);
  if (height >= 1) push(factoryCompose(tabBar(state.tab, width), width));
  const bodyRows = Math.max(0, height - 2);
  const status = statusLine(state);
  if (height < MIN_FRAMED_ROWS) {
    const body = tabBody(state, width, bodyRows, g);
    const shown = status === undefined ? body : [status, ...body];
    for (let row = 0; row < bodyRows; row++) push(factoryCompose(shown[row] ?? [], width));
  } else {
    const label = FACTORY_TAB_LABELS[state.tab];
    lines.push(
      factoryFrameTop(width, state.detail ? `${label} · detalle` : label, frameRight(state), g),
    );
    const inner = bodyRows - 2;
    const room = status === undefined ? inner : Math.max(0, inner - 1);
    const body = tabBody(state, Math.max(0, width - 2), room, g);
    for (let row = 0; row < room; row++) push(factoryBoxRow(body[row] ?? [], width, g));
    if (status !== undefined && inner > 0) push(factoryBoxRow(status, width, g));
    lines.push(factoryFrameBottom(width, g));
  }
  if (height >= 2) push(factoryCompose(footer(state, width, g), width));
  return { lines, hits };
}
