import type { SettingField } from "./delegation-settings.js";
import type { BodyLine } from "./factory-board.js";
import {
  type FactoryGlyphs,
  FactoryGrid,
  type FactorySeg,
  type FactoryToken,
  factoryCell,
} from "./factory-kit.js";
import { settingRows } from "./factory-rows.js";
import {
  displayValue,
  effectText,
  GROUP_LABELS,
  type HealthState,
  isEditable,
  settingLabel,
  sliderRange,
} from "./factory-settings.js";
import type { FactoryState, FactoryTarget } from "./factory-state.js";
import { plainText, truncate } from "./text.js";

// The Sistema tab: how the pieces connect and whether each answers (architecture-map), what is installed
// (skeleton-loader), and the settings as switches and sliders (settings-toggles), generated from HARIL's own table. ✓
// Guardado appears only after `haril config set` said so.

type Seg = FactorySeg<FactoryTarget>;

const BOX_W = 17;
const BOX_GAP = 4;
const LABEL_W = 36;
const TRACK = 20;
const SWITCH = 5;
const FOOTER_ROWS = 4;

function healthToken(state: HealthState): FactoryToken {
  if (state === "ok") return "green";
  return state === "down" ? "red" : "yellow";
}

interface MapNode {
  readonly name: string;
  readonly sub: string;
  readonly state: HealthState;
  readonly detail: string;
  readonly token: FactoryToken;
}

function drawBox(grid: FactoryGrid, x: number, y: number, node: MapNode, g: FactoryGlyphs): void {
  grid.text(x, y, `${g.topLeft}${g.h.repeat(BOX_W - 2)}${g.topRight}`, node.token);
  grid.text(x, y + 3, `${g.bottomLeft}${g.h.repeat(BOX_W - 2)}${g.bottomRight}`, node.token);
  for (const row of [1, 2]) {
    grid.text(x, y + row, g.v, node.token);
    grid.text(x + BOX_W - 1, y + row, g.v, node.token);
  }
  grid.text(x + 2, y + 1, truncate(plainText(node.name), BOX_W - 6), "text");
  grid.text(
    x + BOX_W - 3,
    y + 1,
    node.state === "unknown" ? g.idle : g.dot,
    healthToken(node.state),
  );
  grid.text(x + 2, y + 2, truncate(plainText(node.sub), BOX_W - 4), "muted");
}

function mapBody(state: FactoryState, width: number, height: number, g: FactoryGlyphs): BodyLine[] {
  const { model } = state;
  if (model === null) return [];
  const { system } = model;
  const memory = state.system?.memory ?? {
    state: "unknown" as const,
    detail: "Todavía sin preguntar.",
  };
  const console: MapNode = {
    name: "Consola",
    sub: "Pi",
    state: "ok",
    detail: "Esta pantalla.",
    token: "blue",
  };
  const runtime: MapNode = {
    name: "Runtime",
    sub: "haril start",
    ...system.runtime,
    token: "green",
  };
  const gateway: MapNode = {
    name: "CLIProxy",
    sub: "pasarela",
    ...system.gateway,
    token: "orange",
  };
  const accounts: MapNode = {
    name: "Cuentas",
    sub: `${system.accounts} leídas`,
    state: system.accounts > 0 ? system.gateway.state : "unknown",
    detail: `${system.accounts} cuentas con lectura.`,
    token: "purple",
  };
  const sqlite: MapNode = { name: "SQLite", sub: "estado", ...system.store, token: "cyan" };
  const engram: MapNode = { name: "Engram", sub: "memoria", ...memory, token: "yellow" };
  const flow = [console, runtime, gateway, accounts];
  const nodes = [...flow, sqlite, engram];
  const details: BodyLine[] = nodes.map((node) => [
    { text: `  ${node.state === "unknown" ? g.idle : g.dot} `, token: healthToken(node.state) },
    factoryCell(node.name, 10, "text"),
    factoryCell(node.detail, Math.max(0, width - 14), "muted"),
  ]);
  const warnings: BodyLine[] = system.roleWarnings.map((row) => [
    factoryCell(
      `  Aviso: el rol ${row.role} solo llega a ${row.vendor} entre los modelos conectados.`,
      width,
      "yellow",
    ),
  ]);
  const needed = flow.length * BOX_W + (flow.length - 1) * BOX_GAP;
  if (needed > width || height < 9 + details.length) return [...details, ...warnings];
  const grid = new FactoryGrid(width, 9);
  flow.forEach((node, index) => {
    const x = index * (BOX_W + BOX_GAP);
    drawBox(grid, x, 0, node, g);
    if (index > 0) {
      const up = flow[index - 1] as MapNode;
      for (let gap = 0; gap < BOX_GAP; gap++) {
        grid.text(
          x - BOX_GAP + gap,
          1,
          g.h,
          up.state === "ok" && node.state === "ok" ? "blue" : "dim",
        );
      }
    }
  });
  // SQLite and Engram hang under the runtime.
  const runtimeX = BOX_W + BOX_GAP;
  const stem = runtimeX + Math.floor(BOX_W / 2);
  grid.text(stem, 4, g.v, "dim");
  drawBox(grid, runtimeX, 5, sqlite, g);
  drawBox(grid, runtimeX + BOX_W + BOX_GAP, 5, engram, g);
  for (let gap = 0; gap < BOX_GAP; gap++) grid.text(runtimeX + BOX_W + gap, 6, g.h, "dim");
  const lines: BodyLine[] = Array.from({ length: 9 }, (_, row) => grid.segs<FactoryTarget>(row));
  return [...lines, ...details, ...warnings];
}

function card(
  title: string,
  count: string,
  rows: readonly string[],
  width: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const inner = Math.max(0, width - 2);
  const fill = Math.max(0, inner - 3 - title.length - count.length - 2);
  const body = rows.length === 0 ? ["Ninguno."] : rows;
  return [
    [
      { text: `${g.topLeft}${g.h} `, token: "dim" },
      { text: title, token: "blue" },
      { text: ` ${g.h.repeat(fill)} `, token: "dim" },
      { text: count, token: "muted" },
      { text: g.topRight, token: "dim" },
    ],
    ...body.map(
      (row): BodyLine => [
        { text: g.v, token: "dim" },
        factoryCell(` ${row}`, inner, "muted"),
        { text: g.v, token: "dim" },
      ],
    ),
    [{ text: `${g.bottomLeft}${g.h.repeat(inner)}${g.bottomRight}`, token: "dim" }],
  ];
}

const STATE_TEXT: Readonly<Record<string, string>> = {
  ok: "al día",
  outdated: "desactualizado",
  missing: "falta",
  unknown: "sin comprobar",
  connected: "conectado",
  disabled: "desactivado",
  not_checked: "sin comprobar",
  invalid: "con error",
};

function inventoryBody(state: FactoryState, width: number, g: FactoryGlyphs): BodyLine[] {
  const data = state.system;
  if (data === null) return [[factoryCell("  Leyendo el inventario…", width, "muted")]];
  const stateOf = (row: { name: string; state: string }) =>
    `${row.name}: ${STATE_TEXT[row.state] ?? row.state}`;
  return [
    ...card(
      "Skills",
      String(data.skills.length),
      [data.skills.join(", ")].filter((row) => row !== ""),
      width,
      g,
    ),
    ...card("MCP", String(data.mcp.length), data.mcp.map(stateOf), width, g),
    ...card("Integraciones", String(data.tools.length), data.tools.map(stateOf), width, g),
    ...card("Plantillas", "0", ["HARIL todavía no tiene plantillas."], width, g),
  ];
}

function switchSegs(on: boolean, g: FactoryGlyphs): Seg[] {
  const cells = SWITCH - 2 - 1;
  return [
    { text: "(", token: on ? "yellow" : "dim" },
    { text: on ? g.heavy.repeat(cells) : "", token: "green" },
    { text: g.knob, token: "text" },
    { text: on ? "" : g.h.repeat(cells), token: "dim" },
    { text: ")", token: on ? "yellow" : "dim" },
    { text: on ? " Sí" : " No", token: on ? "green" : "muted" },
  ];
}

function sliderSegs(field: SettingField, value: number, g: FactoryGlyphs): Seg[] {
  const range = sliderRange(field);
  if (range === undefined) return [];
  const ratio = Math.max(0, Math.min(1, (value - range.min) / Math.max(1, range.max - range.min)));
  const at = Math.round(ratio * (TRACK - 1));
  return [
    { text: g.heavy.repeat(at), token: "blue" },
    { text: g.knob, token: "text" },
    { text: g.h.repeat(TRACK - 1 - at), token: "dim" },
    { text: ` ${displayValue(field, value)}`, token: "text" },
  ];
}

function settingLine(
  field: SettingField,
  state: FactoryState,
  selected: boolean,
  width: number,
  g: FactoryGlyphs,
): BodyLine {
  const draft = state.settingDraft?.path === field.path ? state.settingDraft.value : undefined;
  const value = draft ?? field.value;
  const label = factoryCell<FactoryTarget>(
    settingLabel(field),
    Math.min(LABEL_W, Math.max(0, width - 12)),
    selected ? "blue" : "text",
  );
  const head: Seg[] = [{ text: selected ? `${g.focus} ` : "  ", token: "blue" }, label];
  if (state.settingEdit?.path === field.path) {
    return [...head, { text: ` ${state.settingEdit.text}_`, token: "yellow" }];
  }
  const control: Seg[] =
    field.kind.type === "boolean" && typeof value === "boolean"
      ? switchSegs(value, g)
      : sliderRange(field) !== undefined && typeof value === "number"
        ? sliderSegs(field, value, g)
        : [{ text: displayValue(field, value), token: "muted" }];
  const mark: Seg[] =
    draft !== undefined
      ? [{ text: "  sin guardar: Enter guarda", token: "yellow" }]
      : state.savedPath === field.path
        ? [{ text: `  ${g.saved} Guardado`, token: "green" }]
        : [];
  return [...head, { text: " ", token: "dim" }, ...control, ...mark];
}

function settingsBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  const data = state.system;
  if (data === null) return [[factoryCell("  Leyendo la configuración…", width, "muted")]];
  if (data.settings === null) {
    return [
      [
        factoryCell(
          "  No se pudo leer la configuración: revisa `haril config get`.",
          width,
          "yellow",
        ),
      ],
    ];
  }
  const rows = settingRows(state);
  const selectedIndex = state.selection.sistema;
  const selected = rows[selectedIndex];
  const footer: BodyLine[] =
    selected === undefined || height < FOOTER_ROWS + 3
      ? []
      : [
          [{ text: g.h.repeat(width), token: "line" }],
          [factoryCell(`  ${selected.path}`, width, "muted")],
          [factoryCell(`  ${effectText(selected.effect)} ${rangeText(selected)}`, width, "text")],
          [
            factoryCell(
              state.settingsLocked
                ? "  Este modo es de solo lectura: cambia de modo con Alt+M para editar."
                : !isEditable(selected)
                  ? "  Esta regla es fija y no se puede cambiar."
                  : hintFor(selected),
              width,
              state.settingsLocked ? "yellow" : "muted",
            ),
          ],
        ];
  const room = Math.max(1, height - footer.length);
  // A group's title stands above its first row; what scrolls is the rows.
  const lines: { line: BodyLine; row: number }[] = [];
  rows.forEach((field, index) => {
    if (rows[index - 1]?.group !== field.group) {
      lines.push({
        row: index,
        line: [factoryCell(`  ${GROUP_LABELS[field.group] ?? field.group}`, width, "green")],
      });
    }
    lines.push({ row: index, line: settingLine(field, state, index === selectedIndex, width, g) });
  });
  const at = Math.max(
    0,
    lines.findIndex((item) => item.row === selectedIndex),
  );
  const start = Math.max(0, Math.min(at, lines.length - room));
  return [...lines.slice(start, start + room).map((item) => item.line), ...footer];
}

function rangeText(field: SettingField): string {
  const from = field.source === "file" ? "haril.json" : "valor por defecto";
  const range =
    field.kind.type === "integer"
      ? `Rango ${field.kind.min} a ${field.kind.max}. `
      : field.kind.type === "percent"
        ? "Rango 0 a 100. "
        : "";
  return `${range}Por defecto ${displayValue(field, field.default)}. Viene de ${from}.`;
}

function hintFor(field: SettingField): string {
  if (field.kind.type === "boolean") return "  Enter cambia y guarda.";
  if (sliderRange(field) !== undefined)
    return "  ←/→ ajustan, Enter guarda; Enter sin ajustar pide el valor exacto.";
  return "  Enter pide el valor; las listas van separadas por comas.";
}

export function sistemaBody(
  state: FactoryState,
  width: number,
  height: number,
  g: FactoryGlyphs,
): BodyLine[] {
  switch (state.sistemaView) {
    case "mapa":
      return mapBody(state, width, height, g);
    case "inventario":
      return inventoryBody(state, width, g);
    case "ajustes":
      return settingsBody(state, width, height, g);
  }
}
