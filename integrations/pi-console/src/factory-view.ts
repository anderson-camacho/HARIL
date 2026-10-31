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
import {
  FACTORY_TABS,
  type FactoryState,
  type FactoryTab,
  type FactoryTarget,
} from "./factory-state.js";

// The factory's screen, pure: a state, a width and a height in, the lines and their hit-boxes out. A tab bar on top, the
// tab's framed body, and a footer with the keys that work right now. No tab has a data source yet, so each says so and
// shows nothing else: this screen never draws sample data.

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
  conexiones: "Aquí se verán las cuentas conectadas y su cuota.",
  modelos: "Aquí se verán los modelos de cada rol.",
  sistema: "Aquí se verá la configuración de la fábrica.",
};

const NO_DATA = "Sin datos conectados todavía";
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

function hintsOf(state: FactoryState, g: FactoryGlyphs): Hint[] {
  const hasRows = state.rowCounts[state.tab] > 0 && !state.detail;
  return [
    { key: g.leftRight, action: "pestaña", keep: 3 },
    { key: "1-7", action: "ir", keep: 0 },
    ...(hasRows
      ? [
          { key: g.upDown, action: "mover", keep: 2 },
          { key: "Enter", action: "detalle", keep: 1 },
        ]
      : []),
    state.detail
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
    hints = hints.filter((hint) => hint.keep !== lowest);
  }
  return hintSegs(hints);
}

function bodyMessages(tab: FactoryTab): Seg[][] {
  return [
    [{ text: `  ${NO_DATA}`, token: "yellow" }],
    [{ text: `  ${TAB_PURPOSE[tab]}`, token: "muted" }],
  ];
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
  const messages = bodyMessages(state.tab);
  if (height < MIN_FRAMED_ROWS) {
    for (let row = 0; row < bodyRows; row++) push(factoryCompose(messages[row] ?? [], width));
  } else {
    const label = FACTORY_TAB_LABELS[state.tab];
    const position = `${FACTORY_TABS.indexOf(state.tab) + 1}/${FACTORY_TABS.length}`;
    lines.push(factoryFrameTop(width, state.detail ? `${label} · detalle` : label, position, g));
    const inner = bodyRows - 2;
    // A blank row above the text when there is room for it.
    const shown = inner >= messages.length + 1 ? [[], ...messages] : messages;
    for (let row = 0; row < inner; row++) push(factoryBoxRow(shown[row] ?? [], width, g));
    lines.push(factoryFrameBottom(width, g));
  }
  if (height >= 2) push(factoryCompose(footer(state, width, g), width));
  return { lines, hits };
}
