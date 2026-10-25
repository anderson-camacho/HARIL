// Experimental full-height HARIL dock inside Pi's *existing* TUI. Pi does not expose a public split-pane API:
// install only when its layoutRoot implements the @earendil-works/pi-tui layout-node contract. Never replace Pi's
// editor, scrollback or chat; reuse its original layout node as the centre of the three-column stack.
import { paddedCell, visualText } from "./dashboard-theme.js";
import type { DockDetails } from "./dock-details.js";
import type { ConsoleMouseEvent, ConsoleTui } from "./pi-types.js";
import { plainText } from "./text.js";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const HARIL_OWNER = Symbol.for("haril.native-panes.owner");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");
export const MIN_PANE_COLUMNS = 132;
export const MIN_PANE_ROWS = 24;

export const DOCK_LABELS = [
  { id: "explorer", label: "Explorador", glyph: "▤" },
  { id: "git", label: "Git", glyph: "⑂" },
  { id: "youtube", label: "YouTube", glyph: "▶" },
  { id: "memory", label: "Memoria", glyph: "◈" },
  { id: "themes", label: "Temas", glyph: "◐" },
] as const;

export type DockId = (typeof DOCK_LABELS)[number]["id"];
export interface DockSlot {
  readonly id: DockId;
  readonly visible: boolean;
}

const LABELS = new Map<string, (typeof DOCK_LABELS)[number]>(
  DOCK_LABELS.map((item) => [item.id, item]),
);

// Local decoding deliberately never executes anything from the user's config. This dock describes UI slots, not
// whether Pi packages have been installed or enabled.
export function readDockSlots(raw: unknown): DockSlot[] {
  const value =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && "value" in raw
      ? (raw as { readonly value: unknown }).value
      : undefined;
  if (
    !Array.isArray(value) ||
    value.length !== DOCK_LABELS.length ||
    new Set(value.map((entry) => entry?.id)).size !== DOCK_LABELS.length ||
    !value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        LABELS.has(entry.id) &&
        typeof entry.visible === "boolean",
    )
  ) {
    return DOCK_LABELS.map(({ id }) => ({ id, visible: true }));
  }
  return value.map(({ id, visible }: DockSlot) => ({ id, visible }));
}

export interface PaneSettings {
  slots: DockSlot[];
  selected: DockId;
  detail: DockDetails | undefined;
  leftVisible: boolean;
  rightVisible: boolean;
}

export function initialPaneSettings(): PaneSettings {
  return {
    slots: readDockSlots(undefined),
    selected: "explorer",
    detail: undefined,
    leftVisible: true,
    rightVisible: true,
  };
}

export function renderLeftDock(
  width: number,
  height: number,
  state: PaneSettings,
  project: string,
  detailOffset = 0,
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
  rows.push(line(" ◉ HARIL", "yellow"));
  rows.push(line(" Many minds. One flow.", "muted"));
  rows.push(line(` ${plainText(project)}`, "teal"));
  rows.push(line(" ─ PLUGINS ─", "cyan"));
  for (const slot of state.slots.filter((item) => item.visible)) {
    const entry = LABELS.get(slot.id);
    if (entry === undefined) continue;
    const active = slot.id === state.selected;
    rows.push(
      line(
        ` ${active ? "▸" : " "} ${entry.glyph} ${entry.label}`,
        active ? "yellow" : "text",
        active,
      ),
    );
  }
  rows.push(line("", "muted"));
  const selection = LABELS.get(state.selected)?.label ?? state.selected;
  rows.push(line(` ─ ${selection.toUpperCase()} ─`, "cyan"));
  rows.push(line(` ${state.detail?.status ?? "Cargando vista…"}`, "teal"));
  const detail = state.detail?.id === state.selected ? state.detail.lines : [];
  const budget = Math.max(0, height - rows.length - 10);
  for (const item of detail.slice(detailOffset, detailOffset + budget)) rows.push(line(` ${item}`));
  if (detailOffset + budget < detail.length) rows.push(line(" ↕ rueda para más", "muted"));
  rows.push(line("", "muted"));
  rows.push(line(" ─ ACCESOS ─", "cyan"));
  rows.push(line(" /haril-plugin", "teal"));
  rows.push(line(" /haril-plugins", "teal"));
  rows.push(line(" /haril-dock", "teal"));
  if (process.platform === "win32") rows.push(line(" Alt+Z  Plugins", "muted"));
  rows.push(line(" Alt+H  Áreas", "muted"));
  rows.push(line(" Alt+R  Panel der.", "muted"));
  rows.push(line("", "muted"));
  rows.push(line(" Espacios visuales", "muted"));
  rows.push(line(" ≠ extensiones Pi", "muted"));
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
    readonly right: (width: number) => readonly string[];
    readonly select: (id: DockId) => void;
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
  const left = {
    render(width: number) {
      return renderLeftDock(
        width,
        Math.max(1, tui.terminal.rows),
        state,
        options.project(),
        detailOffset,
      );
    },
    handleMouse(event: ConsoleMouseEvent) {
      if (event.type === "wheel") {
        const max = Math.max(0, (state.detail?.lines.length ?? 0) - 6);
        detailOffset = Math.max(0, Math.min(max, detailOffset + (event.wheelDelta ?? 0)));
        tui.requestRender();
        return { handled: true, render: true };
      }
      if (event.type !== "click" || event.button !== "left") return undefined;
      const selected = state.slots.filter((slot) => slot.visible)[event.y - 4];
      if (!selected) return undefined;
      detailOffset = 0;
      options.select(selected.id);
      return { handled: true, render: true };
    },
    invalidate() {},
  };
  let scrollTop = 0;
  const right = {
    render(width: number) {
      const height = Math.max(1, tui.terminal.rows);
      const content = options.right(width - 1);
      scrollTop = Math.min(scrollTop, Math.max(0, content.length - height));
      return renderRightDock(width, height, content.slice(scrollTop));
    },
    handleMouse(event: ConsoleMouseEvent) {
      if (event.type !== "wheel") return undefined;
      const max = Math.max(0, options.right(39).length - tui.terminal.rows);
      scrollTop = Math.max(0, Math.min(max, scrollTop + (event.wheelDelta ?? 0)));
      tui.requestRender();
      return { handled: true, render: true };
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
