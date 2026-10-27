// Experimental full-height HARIL dock inside Pi's *existing* TUI. Pi does not expose a public split-pane API:
// install only when its layoutRoot implements the @earendil-works/pi-tui layout-node contract. Never replace Pi's
// editor, scrollback or chat; reuse its original layout node as the centre of the three-column stack.
import { aiEyeTone, paddedCell, visualText } from "./dashboard-theme.js";
import type { DockDetails } from "./dock-details.js";
import { type DockId, type DockSlot, dockDefinition, readDockSlots } from "./dock-registry.js";
import type { UiLocale } from "./locale.js";
import type { ConsoleMouseEvent, ConsoleTui } from "./pi-types.js";
import { plainText } from "./text.js";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const HARIL_OWNER = Symbol.for("haril.native-panes.owner");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");
export const MIN_PANE_COLUMNS = 132;
export const MIN_PANE_ROWS = 24;

export type { DockId, DockSlot } from "./dock-registry.js";
export { DOCK_LABELS, readDockSlots } from "./dock-registry.js";

interface DockTabRow {
  readonly text: string;
  readonly cells: readonly { id: DockId; start: number; end: number }[];
}

// The left rail is a tab host. A plugin owns its view only when selected; the rest
// occupy small tabs, so a file tree cannot push the entire navigation off screen.
function dockTabs(state: PaneSettings, width: number): DockTabRow[] {
  const rows: DockTabRow[] = [];
  let label = "";
  let cells: { id: DockId; start: number; end: number }[] = [];
  for (const [index, slot] of state.slots.filter((entry) => entry.visible).entries()) {
    const name = `${index + 1}:${dockDefinition(slot.id)?.tab ?? slot.id}`;
    const token = slot.id === state.selected ? `[${name}]` : ` ${name} `;
    const part = `${label ? " " : ""}${token}`;
    if (label && label.length + part.length > width) {
      rows.push({ text: label, cells });
      label = "";
      cells = [];
    }
    const start = label.length + (label ? 1 : 0);
    label += `${label ? " " : ""}${token}`;
    cells.push({ id: slot.id, start, end: label.length });
  }
  if (label) rows.push({ text: label, cells });
  return rows;
}

export interface PaneSettings {
  slots: DockSlot[];
  selected: DockId;
  detail: DockDetails | undefined;
  leftVisible: boolean;
  rightVisible: boolean;
  dockExpanded?: boolean;
}

export function initialPaneSettings(): PaneSettings {
  return {
    slots: readDockSlots(undefined),
    selected: "explorer",
    detail: undefined,
    leftVisible: false,
    rightVisible: true,
    dockExpanded: true,
  };
}

export function renderLeftDock(
  width: number,
  height: number,
  state: PaneSettings,
  project: string,
  detailOffset = 0,
  effortLevel?: string,
  locale: UiLocale = "es",
): string[] {
  if (width < 3 || height < 1) return [];
  const inside = width - 1;
  const rows: string[] = [];
  const line = (
    value: string,
    tone: "yellow" | "cyan" | "teal" | "muted" | "text" = "text",
    selected = false,
  ) =>
    `${paddedCell(value, inside, tone, selected ? "selected" : "panel")}${visualText("│", "cyan", "base")}`;
  rows.push(
    `${paddedCell(" ", 1, "yellow", "panel")}${visualText("◉", aiEyeTone(effortLevel), "panel")}${paddedCell(" HARIL · Many minds.", inside - 2, "yellow", "panel")}${visualText("│", "cyan", "base")}`,
  );
  rows.push(line(` 📁 ${plainText(project)}`, "teal"));
  rows.push(line(" ────────────────────", "muted"));
  rows.push(line(locale === "es" ? " VISTAS · Alt+L" : " VIEWS · Alt+L", "cyan"));
  for (const tab of dockTabs(state, Math.max(1, inside - 1))) {
    rows.push(
      line(
        ` ${tab.text}`,
        tab.cells.some((cell) => cell.id === state.selected) ? "yellow" : "text",
      ),
    );
  }
  rows.push(line(" ────────────────────", "muted"));
  const module = dockDefinition(state.selected);
  const selection = (locale === "es" ? module?.label : module?.labelEn) ?? state.selected;
  rows.push(line(` ${selection.toUpperCase()}`, "cyan"));
  rows.push(
    line(
      ` ${state.detail?.status ?? (locale === "es" ? "Cargando vista…" : "Loading view…")}`,
      "teal",
    ),
  );
  const detail = state.detail?.id === state.selected ? state.detail.lines : [];
  const budget = Math.max(0, height - rows.length - 2);
  for (const item of detail.slice(detailOffset, detailOffset + budget)) rows.push(line(` ${item}`));
  rows.push(line(" ────────────────────", "muted"));
  rows.push(
    line(
      detailOffset + budget < detail.length
        ? locale === "es"
          ? " ↕ Rueda · más elementos"
          : " ↕ Wheel · scroll"
        : locale === "es"
          ? " Alt+C · comandos"
          : " Alt+C · commands",
      "muted",
    ),
  );
  return Array.from({ length: height }, (_value, index) => rows[index] ?? line("", "muted"));
}

export function renderRightDock(
  width: number,
  height: number,
  content: readonly string[],
): string[] {
  if (width < 3 || height < 1) return [];
  return Array.from({ length: height }, (_value, index) => {
    const separator = visualText("│", "cyan", "base");
    const row = content[index] ?? paddedCell("", width - 1, "text", "panel");
    return `${separator}${row}`;
  });
}

interface RightRailStructure {
  readonly lines: readonly string[];
  readonly tabRows: readonly DockTabRow[];
  readonly tabStart: number;
  readonly detailStart: number;
  readonly detailCount: number;
}

// In single-rail mode, the right rail hosts the active space (tabs, status and details)
// directly under the "Espacio" section, freeing the left side entirely for the Pi chat.
function renderRightRailContent(
  width: number,
  state: PaneSettings,
  dashboardLines: readonly string[],
  locale: UiLocale = "es",
): RightRailStructure {
  const inside = Math.max(1, width - 1);
  const rows: string[] = [];
  const module = dockDefinition(state.selected);
  const selection = (locale === "es" ? module?.label : module?.labelEn) ?? state.selected;

  if (state.leftVisible) {
    rows.push(paddedCell(` ▣ Espacio: ${selection}`, inside, "yellow", "panel"));
    for (const line of dashboardLines) rows.push(line);
    return { lines: rows, tabRows: [], tabStart: -1, detailStart: -1, detailCount: 0 };
  }

  const expanded = state.dockExpanded ?? true;
  const icon = expanded ? "▼" : "▶";
  rows.push(paddedCell(` ${icon} Espacio: ${selection} · Alt+L`, inside, "yellow", "panel"));

  if (!expanded) {
    for (const line of dashboardLines) rows.push(line);
    return { lines: rows, tabRows: [], tabStart: -1, detailStart: -1, detailCount: 0 };
  }

  const tabRows = dockTabs(state, Math.max(1, inside - 1));
  const tabStart = rows.length;
  for (const tab of tabRows) {
    rows.push(
      paddedCell(
        ` ${tab.text}`,
        inside,
        tab.cells.some((cell) => cell.id === state.selected) ? "yellow" : "text",
        "panel",
      ),
    );
  }

  rows.push(
    paddedCell(
      ` ${state.detail?.status ?? (locale === "es" ? "Cargando vista…" : "Loading view…")}`,
      inside,
      "teal",
      "panel",
    ),
  );

  const detail = state.detail?.id === state.selected ? state.detail.lines : [];
  const detailStart = rows.length;
  for (const item of detail) {
    rows.push(paddedCell(` ${item}`, inside, "text", "panel"));
  }
  const detailCount = detail.length;

  rows.push(paddedCell(" ────────────────────────────────────────", inside, "muted", "panel"));
  for (const line of dashboardLines) rows.push(line);

  return { lines: rows, tabRows, tabStart, detailStart, detailCount };
}

interface LayoutRoot {
  render(width: number): string[];
  invalidate?(): void;
  [key: symbol]: unknown;
}

interface PaneTui extends ConsoleTui {
  readonly layoutRoot?: LayoutRoot;
  readonly chatContainer?: { invalidate?(): void };
}

type LayoutFn = (this: LayoutRoot) => unknown;

export interface NativePanes {
  readonly attached: boolean;
  close(): void;
  refresh(): void;
}

// All external layout data is checked at the boundary. On older Pi or Gentle Shell's existing rail we leave the
// layout entirely untouched; no monkeypatch is ever installed into an unknown layout root.
export function attachNativePanes(
  tui: ConsoleTui,
  state: PaneSettings,
  options: {
    readonly project: () => string;
    readonly effortLevel?: () => string | undefined;
    readonly locale?: () => UiLocale;
    readonly right: (width: number) => readonly string[];
    readonly select: (id: DockId) => void;
    readonly toggleExplorer?: (path: string) => void;
    readonly activate?: (id: DockId, action: string) => void;
  },
): NativePanes {
  const host = tui as PaneTui;
  const root = host.layoutRoot;
  const inactive = (): NativePanes => ({ attached: false, close() {}, refresh() {} });
  if (!root || typeof root[LAYOUT_NODE] !== "function") return inactive();
  if (root[HARIL_OWNER] !== undefined || root[GENTLE_SIDEBAR] !== undefined) return inactive();
  const original = root[LAYOUT_NODE] as LayoutFn;
  let alive = true;
  let detailOffset = 0;
  let displayedDetail = state.detail;
  let displayedSlot = state.selected;
  const left = {
    render(width: number) {
      if (state.detail !== displayedDetail || state.selected !== displayedSlot) {
        detailOffset = 0;
        displayedDetail = state.detail;
        displayedSlot = state.selected;
      }
      return renderLeftDock(
        width,
        Math.max(1, tui.terminal.rows),
        state,
        options.project(),
        detailOffset,
        options.effortLevel?.(),
        options.locale?.(),
      );
    },
    handleMouse(event: ConsoleMouseEvent) {
      if (event.type === "wheel") {
        const headerRows = 7 + dockTabs(state, Math.max(1, 22)).length;
        const max = Math.max(
          0,
          (state.detail?.lines.length ?? 0) - (tui.terminal.rows - headerRows - 2),
        );
        detailOffset = Math.max(0, Math.min(max, detailOffset + (event.wheelDelta ?? 0)));
        tui.requestRender();
        return { handled: true, render: true };
      }
      if (event.type !== "click" || event.button !== "left") return undefined;
      const tabs = dockTabs(state, Math.max(1, 22));
      const tab = tabs[event.y - 4];
      if (tab) {
        const clicked = tab.cells.find(
          (cell) => event.x >= cell.start + 1 && event.x < cell.end + 1,
        );
        if (!clicked) return undefined;
        detailOffset = 0;
        options.select(clicked.id);
        return { handled: true, render: true };
      }
      const detailLine = event.y - (7 + tabs.length) + detailOffset;
      const action = state.detail?.actions?.find((item) => item.line === detailLine);
      if (action !== undefined && state.detail?.id === state.selected) {
        options.activate?.(state.selected, action.action);
        return { handled: true, render: true };
      }
      const row = detailLine - 1;
      const node = state.selected === "explorer" ? state.detail?.treeNodes?.[row] : undefined;
      if (!node?.directory) return undefined;
      options.toggleExplorer?.(node.path);
      return { handled: true, render: true };
    },
    invalidate() {},
  };
  let scrollTop = 0;
  let rightDisplayedDetail = state.detail;
  let rightDisplayedSlot = state.selected;
  const right = {
    render(width: number) {
      if (state.detail !== rightDisplayedDetail || state.selected !== rightDisplayedSlot) {
        rightDisplayedDetail = state.detail;
        rightDisplayedSlot = state.selected;
        scrollTop = 0;
      }
      const height = Math.max(1, tui.terminal.rows);
      const dashboard = options.right(width - 1);
      const structure = renderRightRailContent(width, state, dashboard, options.locale?.() ?? "es");
      scrollTop = Math.min(scrollTop, Math.max(0, structure.lines.length - height));
      return renderRightDock(width, height, structure.lines.slice(scrollTop));
    },
    handleMouse(event: ConsoleMouseEvent) {
      const dashboard = options.right(39);
      const structure = renderRightRailContent(40, state, dashboard, options.locale?.() ?? "es");
      if (event.type === "wheel") {
        const height = Math.max(1, tui.terminal.rows);
        const max = Math.max(0, structure.lines.length - height);
        scrollTop = Math.max(0, Math.min(max, scrollTop + (event.wheelDelta ?? 0)));
        tui.requestRender();
        return { handled: true, render: true };
      }
      if (event.type !== "click" || event.button !== "left") return undefined;
      const clickedRow = event.y + scrollTop;
      if (!state.leftVisible) {
        if (clickedRow === 0) {
          state.dockExpanded = !(state.dockExpanded ?? true);
          tui.requestRender();
          return { handled: true, render: true };
        }
        if (state.dockExpanded ?? true) {
          if (
            structure.tabStart >= 0 &&
            clickedRow >= structure.tabStart &&
            clickedRow < structure.tabStart + structure.tabRows.length
          ) {
            const tab = structure.tabRows[clickedRow - structure.tabStart];
            if (tab) {
              const clicked = tab.cells.find(
                (cell) => event.x >= cell.start + 1 && event.x < cell.end + 1,
              );
              if (clicked) {
                scrollTop = 0;
                options.select(clicked.id);
                return { handled: true, render: true };
              }
            }
          }
          if (
            structure.detailStart >= 0 &&
            clickedRow >= structure.detailStart &&
            clickedRow < structure.detailStart + structure.detailCount
          ) {
            const detailLine = clickedRow - structure.detailStart;
            if (state.selected === "themes") {
              const action = state.detail?.actions?.find((item) => item.line === detailLine);
              if (action !== undefined && state.detail?.id === state.selected) {
                options.activate?.(state.selected, action.action);
                return { handled: true, render: true };
              }
            }
            if (state.selected === "explorer") {
              const row = detailLine - 1;
              const node = state.detail?.treeNodes?.[row];
              if (node?.directory) {
                options.toggleExplorer?.(node.path);
                return { handled: true, render: true };
              }
            }
          }
        }
      }
      return undefined;
    },
    invalidate() {},
  };
  const wrapped: LayoutFn = () => {
    const raw = original.call(root);
    const columns = tui.terminal.columns;
    const rows = tui.terminal.rows;
    if (
      !alive ||
      columns < MIN_PANE_COLUMNS ||
      rows < MIN_PANE_ROWS ||
      (!state.leftVisible && !state.rightVisible)
    )
      return raw;
    const main = {
      render(width: number) {
        return root.render(width);
      },
      invalidate() {
        root.invalidate?.();
      },
      [LAYOUT_NODE]: () => raw,
    };
    return {
      type: "hstack",
      gap: 0,
      align: "stretch",
      entries: [
        ...(state.leftVisible ? [{ component: left, basis: 23, grow: 0, shrink: 0 }] : []),
        { component: main, basis: 0, grow: 1, shrink: 1, minSize: 54 },
        ...(state.rightVisible ? [{ component: right, basis: 40, grow: 0, shrink: 0 }] : []),
      ],
    };
  };
  root[HARIL_OWNER] = wrapped;
  root[LAYOUT_NODE] = wrapped;
  function refresh(): void {
    host.layoutRoot?.invalidate?.();
    host.chatContainer?.invalidate?.();
    tui.requestRender();
  }
  refresh();
  return {
    attached: true,
    refresh,
    close() {
      if (!alive) return;
      alive = false;
      if (root[LAYOUT_NODE] === wrapped) root[LAYOUT_NODE] = original;
      if (root[HARIL_OWNER] === wrapped) delete root[HARIL_OWNER];
      refresh();
    },
  };
}
