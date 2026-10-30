// Experimental full-height HARIL dock inside Pi's *existing* TUI. Pi does not expose a public split-pane API:
// install only when its layoutRoot implements the @earendil-works/pi-tui layout-node contract. Never replace Pi's
// editor, scrollback or chat; reuse its original layout node as the centre of the three-column stack.
import type { NativeRailContent, RailHitAction } from "./dashboard.js";
import { aiEyeTone, paddedCell, visualText } from "./dashboard-theme.js";
import type { DockDetails } from "./dock-details.js";
import {
  type DockId,
  type DockSlot,
  dockDefinition,
  MAIN_DOCK_ID,
  readDockSlots,
} from "./dock-registry.js";
import type { UiLocale } from "./locale.js";
import type { ConsoleMouseEvent, ConsoleTui } from "./pi-types.js";
import { plainText, wrap } from "./text.js";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const HARIL_OWNER = Symbol.for("haril.native-panes.owner");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");
export const MIN_PANE_COLUMNS = 132;
export const MIN_PANE_ROWS = 24;

export type { DockId, DockSlot } from "./dock-registry.js";
export { DOCK_LABELS, MAIN_DOCK_ID, readDockSlots } from "./dock-registry.js";

// Whether the native panes are drawn at all: attached to Pi's layout, on a terminal big enough for them. The layout
// patch itself and everything that must agree with it (the header that steps aside, the bar that follows the status)
// decide with this one rule.
function panesFit(input: {
  readonly attached: boolean;
  readonly columns: number;
  readonly rows: number;
}): boolean {
  return input.attached && input.columns >= MIN_PANE_COLUMNS && input.rows >= MIN_PANE_ROWS;
}

// True when at least one of the two sidebars is on screen, whichever tab it shows.
export function panesShown(input: {
  readonly attached: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly leftVisible: boolean;
  readonly rightVisible: boolean;
}): boolean {
  return panesFit(input) && (input.leftVisible || input.rightVisible);
}

// True when the status of the console (the block with the folder, the mode, the warnings and the actions) is on
// screen in the right sidebar: the panes are drawn, the right one is visible and MAIN is the selected tab. When it
// is not, the status lives in the bottom bar.
export function statusInSidebar(input: {
  readonly attached: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly rightVisible: boolean;
  readonly selected: DockId;
}): boolean {
  return panesFit(input) && input.rightVisible && input.selected === MAIN_DOCK_ID;
}

interface DockTabRow {
  readonly text: string;
  readonly cells: readonly { id: DockId; start: number; end: number }[];
}

// The left rail is a tab host. A plugin owns its view only when selected; the rest
// occupy small tabs, so a long view cannot push the entire navigation off screen.
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
    selected: MAIN_DOCK_ID,
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
  // MAIN's content is the status block, which lives in the right panel: this dock only points at it (in as many
  // rows as the width asks for).
  const pointsRight = state.selected === MAIN_DOCK_ID;
  if (pointsRight) {
    const pointer =
      locale === "es" ? "Estado en el panel derecho." : "Status is in the right panel.";
    for (const part of wrap(pointer, Math.max(1, inside - 2))) rows.push(line(` ${part}`, "teal"));
  } else {
    rows.push(
      line(
        ` ${state.detail?.status ?? (locale === "es" ? "Cargando vista…" : "Loading view…")}`,
        "teal",
      ),
    );
  }
  const detail = !pointsRight && state.detail?.id === state.selected ? state.detail.lines : [];
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
  // First row of the status block (the dashboard lines), so a clicked row maps to the hit of its dashboard line; -1
  // when the block is not drawn, so no click is ever looked up in a block that is not there.
  readonly dashboardStart: number;
}

// The rail with nothing to show for the status block: what a tab other than MAIN passes in.
const NO_BLOCK: NativeRailContent = { lines: [], hits: [] };

// In single-rail mode, the right rail hosts the active space (tabs and, under them, its view) directly under the
// "Espacio" section, freeing the left side entirely for the Pi chat. The status block (status, mode, sections, actions
// and recent activity) is MAIN's own view: it is drawn only when MAIN is the selected tab.
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
  const showBlock = state.selected === MAIN_DOCK_ID;
  const appendBlock = (): number => {
    if (!showBlock) return -1;
    const first = rows.length;
    for (const line of dashboardLines) rows.push(line);
    return first;
  };

  if (state.leftVisible) {
    rows.push(paddedCell(` ▣ Espacio: ${selection}`, inside, "yellow", "panel"));
    const dashboardStart = appendBlock();
    return {
      lines: rows,
      tabRows: [],
      tabStart: -1,
      detailStart: -1,
      detailCount: 0,
      dashboardStart,
    };
  }

  const expanded = state.dockExpanded ?? true;
  const icon = expanded ? "▼" : "▶";
  rows.push(paddedCell(` ${icon} Espacio: ${selection} · Alt+L`, inside, "yellow", "panel"));

  if (!expanded) {
    const dashboardStart = appendBlock();
    return {
      lines: rows,
      tabRows: [],
      tabStart: -1,
      detailStart: -1,
      detailCount: 0,
      dashboardStart,
    };
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

  if (showBlock) {
    // MAIN has no view of its own to load: the tabs, a separator and the block.
    rows.push(paddedCell(" ────────────────────────────────────────", inside, "muted", "panel"));
    const dashboardStart = appendBlock();
    return { lines: rows, tabRows, tabStart, detailStart: -1, detailCount: 0, dashboardStart };
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

  return {
    lines: rows,
    tabRows,
    tabStart,
    detailStart,
    detailCount: detail.length,
    dashboardStart: -1,
  };
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
    // The rail body: its rows and, aligned with them, the action a click on each row runs.
    readonly right: (width: number) => NativeRailContent;
    readonly select: (id: DockId) => void;
    // Runs the action a view declares for a clicked detail row (DockDetails.actions).
    readonly activate?: (id: DockId, action: string) => void;
    // Runs the action of a clicked rail row (section toggle, dashboard action, mode, menu...).
    readonly railAction?: (hit: RailHitAction) => void;
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
      return undefined;
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
      // The block is built (it reads the tools, the commands and the model) only for the tab that draws it.
      const dashboard = state.selected === MAIN_DOCK_ID ? options.right(width - 1) : NO_BLOCK;
      const structure = renderRightRailContent(
        width,
        state,
        dashboard.lines,
        options.locale?.() ?? "es",
      );
      scrollTop = Math.min(scrollTop, Math.max(0, structure.lines.length - height));
      return renderRightDock(width, height, structure.lines.slice(scrollTop));
    },
    handleMouse(event: ConsoleMouseEvent) {
      // Pointer moves, presses and other buttons arrive constantly: leave before the rail (tool, command, MCP and
      // model facts) is built, since only a left click and the wheel have anything to do.
      const click = event.type === "click" && event.button === "left";
      if (!click && event.type !== "wheel") return undefined;
      const dashboard = state.selected === MAIN_DOCK_ID ? options.right(39) : NO_BLOCK;
      const structure = renderRightRailContent(
        40,
        state,
        dashboard.lines,
        options.locale?.() ?? "es",
      );
      if (event.type === "wheel") {
        const height = Math.max(1, tui.terminal.rows);
        const max = Math.max(0, structure.lines.length - height);
        scrollTop = Math.max(0, Math.min(max, scrollTop + (event.wheelDelta ?? 0)));
        tui.requestRender();
        return { handled: true, render: true };
      }
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
              // The row is drawn "│", a space, then the tab text: a tab starts two columns after its offset.
              const clicked = tab.cells.find(
                (cell) => event.x >= cell.start + 2 && event.x < cell.end + 2,
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
            // The actions a view declares are its own, whichever tab it is: any detail row may be clickable.
            const detailLine = clickedRow - structure.detailStart;
            const action = state.detail?.actions?.find((item) => item.line === detailLine);
            if (action !== undefined && state.detail?.id === state.selected) {
              options.activate?.(state.selected, action.action);
              return { handled: true, render: true };
            }
          }
        }
        // The rail body (sections, dashboard actions, mode): the same actions the classic header runs on a click.
        // Only a block that is drawn has hits to look up.
        const hit =
          structure.dashboardStart >= 0 && clickedRow >= structure.dashboardStart
            ? dashboard.hits[clickedRow - structure.dashboardStart]
            : undefined;
        if (hit !== undefined && options.railAction !== undefined) {
          options.railAction(hit);
          tui.requestRender();
          return { handled: true, render: true };
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
