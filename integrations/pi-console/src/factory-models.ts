import type { BodyLine } from "./factory-board.js";
import {
  type FactoryGlyphs,
  FactoryGrid,
  type FactorySeg,
  type FactoryToken,
  factoryCell,
} from "./factory-kit.js";
import { quotaAccounts } from "./factory-rows.js";
import type { FactoryState, FactoryTarget } from "./factory-state.js";
import type {
  FactoryQuota,
  FactoryQuotaAccount,
  FactoryQuotaGroup,
  FactoryQuotaReading,
} from "./factory-types.js";
import { plainText, textWidth, truncate } from "./text.js";

// The Modelos tab: the accounts as cards (skeleton-loader), a monitor of bars (cpu-cores), each pool's use over time with
// the switch threshold in red (line-chart-live), and the prompt cache (cdn-cache). Every number comes from the read model;
// what it does not know, this says with its reason.

type Seg = FactorySeg<FactoryTarget>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SERIES_TOKENS: readonly FactoryToken[] = ["cyan", "purple", "orange", "blue", "green"];
const CACHE_CELLS = 24;

export function agoText(at: number | null, now: number): string {
  if (at === null) return "sin lectura";
  const minutes = Math.floor(Math.max(0, now - at) / MINUTE_MS);
  if (minutes < 1) return "hace un momento";
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 48 * 60) return `hace ${Math.floor(minutes / 60)} h`;
  return `hace ${Math.floor(minutes / (24 * 60))} días`;
}

function inText(at: number | null, now: number): string {
  if (at === null) return "reinicio sin dato";
  const left = at - now;
  if (left <= 0) return "ya reinició";
  if (left < HOUR_MS) return `reinicia en ${Math.ceil(left / MINUTE_MS)} min`;
  if (left < 2 * DAY_MS) {
    const hours = Math.floor(left / HOUR_MS);
    const minutes = Math.floor((left - hours * HOUR_MS) / MINUTE_MS);
    return `reinicia en ${hours} h${minutes === 0 ? "" : ` ${minutes} min`}`;
  }
  return `reinicia en ${Math.floor(left / DAY_MS)} días`;
}

// 12300 → "12.300": exact, and the same whatever the machine's locale.
function countText(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function barToken(pct: number, thresholds: FactoryQuota["thresholds"]): FactoryToken {
  if (pct >= thresholds.dangerPct) return "red";
  return pct >= thresholds.warnPct ? "yellow" : "green";
}

function stateToken(state: string): FactoryToken {
  if (state === "Disponible") return "green";
  if (state === "Sin dato") return "muted";
  return state.includes("No se usa") || state.includes("Enfriándose") ? "red" : "yellow";
}

function percentOf(pct: number): string {
  return `${Math.round(pct * 10) / 10} %`;
}

function readingSegs(
  label: string,
  reading: FactoryQuotaReading,
  width: number,
  thresholds: FactoryQuota["thresholds"],
  now: number,
  g: FactoryGlyphs,
): Seg[] {
  const head: Seg = { text: `  ${label.padEnd(7)}`, token: "muted" };
  if (reading.pct !== null) {
    const cells = Math.max(4, Math.min(24, width - 44));
    const filled = Math.round((Math.max(0, Math.min(100, reading.pct)) / 100) * cells);
    const token: FactoryToken = reading.stale ? "dim" : barToken(reading.pct, thresholds);
    return [
      head,
      { text: g.barOn.repeat(filled), token },
      { text: g.barOff.repeat(cells - filled), token: "dim" },
      { text: ` ${percentOf(reading.pct).padStart(7)}`, token: reading.stale ? "muted" : token },
      { text: `  ${inText(reading.resetsAt, now)}`, token: "muted" },
      ...(reading.stale
        ? [{ text: ` · antigua · ${reading.state ?? ""}`, token: "yellow" as const }]
        : []),
    ];
  }
  if (reading.source === "estimated") {
    return [
      head,
      { text: `~${countText(reading.estimatedTokens ?? 0)} tokens`, token: "text" },
      { text: " estimados del registro de uso", token: "muted" },
      ...(reading.state === null
        ? []
        : [{ text: ` · ${reading.state}`, token: "yellow" as const }]),
    ];
  }
  return [head, { text: reading.state ?? "Sin dato", token: "muted" }];
}

// The segments cut to exactly `width` columns, padded when they fall short.
function fitted(segs: readonly Seg[], width: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const seg of segs) {
    const left = width - used;
    if (left <= 0) break;
    const text = truncate(plainText(seg.text), left);
    out.push({ ...seg, text });
    used += textWidth(text);
  }
  if (used < width) out.push({ text: " ".repeat(width - used), token: "dim" });
  return out;
}

function groupLines(
  group: FactoryQuotaGroup,
  inner: number,
  thresholds: FactoryQuota["thresholds"],
  now: number,
  g: FactoryGlyphs,
): Seg[][] {
  const models = group.models.length === 0 ? "" : group.models.join(", ");
  return [
    [
      { text: ` ${group.name ?? "Cuenta"}`, token: "purple" },
      { text: `  ${group.state}`, token: stateToken(group.state) },
    ],
    ...(models === "" ? [] : [[{ text: `   ${models}`, token: "muted" as const }]]),
    readingSegs("5 horas", group.window5h, inner, thresholds, now, g),
    readingSegs("semana", group.weekly, inner, thresholds, now, g),
  ];
}

function cardLines(
  account: FactoryQuotaAccount,
  selected: boolean,
  width: number,
  thresholds: FactoryQuota["thresholds"],
  now: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const inner = Math.max(0, width - 2);
  const border: FactoryToken = selected ? "blue" : "dim";
  const title = [account.label, account.kind, account.plan]
    .filter((part) => part !== null)
    .join(" · ");
  const age = agoText(account.readAt, now);
  const fill = Math.max(0, inner - 3 - textWidth(plainText(title)) - textWidth(age) - 2);
  const holders = account.holders.length === 0 ? "ningún agente" : account.holders.join(", ");
  const rows: Seg[][] = [
    ...account.groups.flatMap((group) => groupLines(group, inner, thresholds, now, g)),
    [
      { text: ` Éxitos ${account.successes}`, token: "green" },
      { text: " · ", token: "dim" },
      { text: `Fallos ${account.failures}`, token: account.failures > 0 ? "red" : "muted" },
      { text: " · ", token: "dim" },
      { text: `Agentes: ${holders}`, token: "muted" },
    ],
  ];
  return [
    fitted(
      [
        { text: `${selected ? g.pointer : g.topLeft}${g.h} `, token: border },
        { text: title, token: "blue" },
        { text: ` ${g.h.repeat(fill)} `, token: border },
        { text: age, token: "muted" },
        { text: g.topRight, token: border },
      ],
      width,
    ),
    ...rows.map(
      (row): BodyLine => [
        { text: g.v, token: border },
        ...fitted(row, inner),
        { text: g.v, token: border },
      ],
    ),
    [{ text: `${g.bottomLeft}${g.h.repeat(inner)}${g.bottomRight}`, token: border }],
  ];
}

function unreadLines(quota: FactoryQuota, width: number): BodyLine[] {
  return quota.unread.map((row) => [
    factoryCell(`  ${row.provider}: ${row.state}`, width, "yellow"),
  ]);
}

function emptyLines(quota: FactoryQuota, width: number): BodyLine[] {
  return [
    [factoryCell("  Sin cuentas leídas todavía. Pulsa r para leerlas.", width, "muted")],
    ...unreadLines(quota, width),
  ];
}

// The rows from the selected card on, so its top is always on screen.
function cardsBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const accounts = quotaAccounts(state);
  if (accounts.length === 0) return emptyLines(model.quota, width);
  const selected = state.selection.modelos;
  const blocks = accounts.map((account, index) =>
    cardLines(account, index === selected, width, model.quota.thresholds, model.generatedAt, g),
  );
  const lines = [...blocks.slice(selected).flat(), ...unreadLines(model.quota, width)];
  const earlier = blocks.slice(0, selected).flat();
  const spare = Math.max(0, height - lines.length);
  return [...earlier.slice(Math.max(0, earlier.length - spare)), ...lines];
}

function meterSegs(
  label: string,
  reading: FactoryQuotaReading,
  width: number,
  thresholds: FactoryQuota["thresholds"],
): Seg[] {
  const tail =
    reading.pct !== null
      ? percentOf(reading.pct)
      : reading.source === "estimated"
        ? `~${countText(reading.estimatedTokens ?? 0)}`
        : "s/d";
  const room = Math.max(0, width - label.length - 2);
  const ratio = reading.pct === null ? 0 : Math.max(0, Math.min(1, reading.pct / 100));
  const bars = Math.min(Math.max(0, room - tail.length), Math.round(ratio * room));
  return [
    { text: label, token: "cyan" },
    { text: "[", token: "text" },
    {
      text: "|".repeat(bars),
      token: reading.stale || reading.pct === null ? "dim" : barToken(reading.pct, thresholds),
    },
    { text: " ".repeat(Math.max(0, room - bars - tail.length)), token: "dim" },
    { text: tail.slice(0, Math.max(0, room - bars)), token: "muted" },
    { text: "]", token: "text" },
  ];
}

const MONITOR_LABEL = 22;

function monitorBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const accounts = quotaAccounts(state);
  if (accounts.length === 0) return emptyLines(model.quota, width);
  const { thresholds } = model.quota;
  const lines: BodyLine[] = [];
  let selectedLine = 0;
  accounts.forEach((account, index) => {
    const selected = index === state.selection.modelos;
    if (selected) selectedLine = lines.length;
    for (const group of account.groups) {
      const name = group.name === null ? account.label : `${account.label} ${group.name}`;
      const room = Math.max(0, width - MONITOR_LABEL - 2);
      const meter = Math.floor(room / 2);
      lines.push([
        { text: selected ? `${g.pointer} ` : "  ", token: "blue" },
        factoryCell(name, MONITOR_LABEL, selected ? "blue" : "text"),
        ...(room >= 12
          ? [
              ...meterSegs("5h", group.window5h, meter, thresholds),
              ...meterSegs("7d", group.weekly, room - meter, thresholds),
            ]
          : meterSegs("5h", group.window5h, room, thresholds)),
      ]);
    }
  });
  const start = Math.max(0, Math.min(selectedLine, lines.length - height));
  return lines.slice(start, start + Math.max(1, height));
}

const BRAILLE_BASE = 0x2800;
// A cell's dots by column and row, as Unicode numbers them.
const BRAILLE_BITS: readonly (readonly number[])[] = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

function historyBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const account = quotaAccounts(state)[state.selection.modelos];
  const series = model.quota.history.filter(
    (row) => account !== undefined && row.key.startsWith(`${account.id}#`),
  );
  const title = account === undefined ? "Sin cuenta elegida" : `${account.label}: uso de 5 horas`;
  if (series.length === 0 || series.every((row) => row.points.length === 0)) {
    return [
      [factoryCell(`  ${title}`, width, "text")],
      [
        factoryCell(
          "  Sin lecturas guardadas de esta cuenta: no hay línea que dibujar.",
          width,
          "muted",
        ),
      ],
    ];
  }
  const axis = 5;
  const cols = Math.max(0, width - axis - 1);
  const rows = Math.max(2, height - 3);
  const now = model.generatedAt;
  const times = series.flatMap((row) => row.points.map((point) => point.at));
  const first = Math.min(...times);
  const span = Math.max(1, now - first);
  const grid = new FactoryGrid(width, rows + 1);
  const rowOf = (pct: number): number =>
    Math.round((1 - Math.max(0, Math.min(100, pct)) / 100) * (rows - 1));
  for (let row = 0; row < rows; row++) grid.text(axis - 1, row, g.v, "muted");
  for (const pct of [100, 50, 0]) {
    const row = rowOf(pct);
    grid.text(0, row, String(pct).padStart(3), "muted");
    grid.text(axis - 1, row, g.tick, "muted");
  }
  grid.text(axis - 1, rows, g.bottomLeft, "muted");
  for (let col = 0; col < cols; col++) grid.text(axis + col, rows, g.h, "muted");
  const { switchAt5h } = model.quota.thresholds;
  const limitRow = rowOf(switchAt5h);
  for (let col = 0; col < cols; col++) grid.text(axis + col, limitRow, g.dash, "red");
  series.forEach((row, seriesIndex) => {
    const token = SERIES_TOKENS[seriesIndex % SERIES_TOKENS.length] as FactoryToken;
    const cells = new Map<string, number>();
    const dot = (x: number, y: number): void => {
      const col = Math.floor(x / 2);
      const line = Math.floor(y / 4);
      const key = `${col}:${line}`;
      const bit = BRAILLE_BITS[x % 2]?.[y % 4] ?? 0;
      cells.set(key, (cells.get(key) ?? 0) | bit);
    };
    const xOf = (at: number): number => Math.round(((at - first) / span) * (cols * 2 - 1));
    const yOf = (pct: number): number =>
      Math.round((1 - Math.max(0, Math.min(100, pct)) / 100) * (rows * 4 - 1));
    row.points.forEach((point, index) => {
      const next = row.points[index + 1];
      const x0 = xOf(point.at);
      const y0 = yOf(point.pct);
      if (next === undefined) {
        dot(x0, y0);
        return;
      }
      const x1 = xOf(next.at);
      const y1 = yOf(next.pct);
      const steps = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let step = 0; step <= steps; step++) {
        dot(
          Math.round(x0 + ((x1 - x0) * step) / steps),
          Math.round(y0 + ((y1 - y0) * step) / steps),
        );
      }
    });
    for (const [key, bits] of cells) {
      const [col, line] = key.split(":").map(Number) as [number, number];
      const char = g.braille ? String.fromCodePoint(BRAILLE_BASE + bits) : "*";
      grid.set(axis + col, line, char, token);
    }
  });
  const legend: Seg[] = [{ text: `  ${title}  `, token: "text" }];
  series.forEach((row, index) => {
    const token = SERIES_TOKENS[index % SERIES_TOKENS.length] as FactoryToken;
    legend.push({ text: `${g.dot} ${row.label}  `, token });
  });
  legend.push({ text: `${g.dash}${g.dash} umbral ${switchAt5h} %`, token: "red" });
  const scale: BodyLine = [
    factoryCell(`${" ".repeat(axis)}${agoText(first, now)}`, Math.max(0, width - 6), "muted"),
    factoryCell("ahora", 6, "muted", true),
  ];
  const chart: BodyLine[] = [];
  for (let row = 0; row <= rows; row++) chart.push(grid.segs<FactoryTarget>(row));
  return [legend, ...chart, scale];
}

function cacheBody(state: FactoryState, width: number, g: FactoryGlyphs): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const accounts = quotaAccounts(state);
  if (accounts.length === 0) return emptyLines(model.quota, width);
  const lines: BodyLine[] = [
    [factoryCell("  Caché de prompts, por cuenta (últimos 7 días)", width, "text")],
    [],
  ];
  accounts.forEach((account, index) => {
    const selected = index === state.selection.modelos;
    const head: Seg[] = [
      { text: selected ? `${g.pointer} ` : "  ", token: "blue" },
      factoryCell(account.label, 14, selected ? "blue" : "text"),
    ];
    if (account.cachedTokens === null) {
      lines.push([
        ...head,
        { text: "Esta cuenta no informa tokens en caché: sin dato.", token: "muted" },
      ]);
      return;
    }
    const ratio =
      account.inputTokens === 0 ? 0 : Math.min(1, account.cachedTokens / account.inputTokens);
    const filled = Math.round(ratio * CACHE_CELLS);
    lines.push([
      ...head,
      { text: g.barOn.repeat(filled), token: "green" },
      { text: g.barOff.repeat(CACHE_CELLS - filled), token: "dim" },
      { text: ` ${percentOf(ratio * 100).padStart(7)}`, token: "text" },
      {
        text: `  ${countText(account.cachedTokens)} de ${countText(account.inputTokens)} tokens de entrada`,
        token: "muted",
      },
    ]);
  });
  return lines;
}

export function modelosBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  switch (state.modelosView) {
    case "cuentas":
      return cardsBody(state, width, height, g);
    case "monitor":
      return monitorBody(state, width, height, g);
    case "historial":
      return historyBody(state, width, height, g);
    case "cache":
      return cacheBody(state, width, g);
  }
}

// The selected account in full: Enter on any of the views.
export function modelosDetail(state: FactoryState, width: number, g: FactoryGlyphs): BodyLine[] {
  const { model } = state;
  const account = quotaAccounts(state)[state.selection.modelos];
  if (model === null || account === undefined) return [];
  return [
    [factoryCell(`  ${account.state}`, width, stateToken(account.state))],
    [factoryCell(`  Proveedor ${account.provider} · referencia ${account.id}`, width, "muted")],
    [],
    ...cardLines(account, false, width, model.quota.thresholds, model.generatedAt, g),
  ];
}
