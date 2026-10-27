import { describe, expect, it, vi } from "vitest";
import {
  attachNativePanes,
  initialPaneSettings,
  MIN_PANE_COLUMNS,
  MIN_PANE_ROWS,
  readDockSlots,
  renderLeftDock,
  renderRightDock,
} from "../src/native-panes.js";
import { stripAnsi, textWidth } from "../src/text.js";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");
interface LayoutRow {
  readonly basis: number;
  readonly component: {
    render(width: number): string[];
    handleMouse?(event: { type: string; button: string; x: number; y: number }): unknown;
    [key: symbol]: unknown;
  };
}
interface NativeLayout {
  readonly type: string;
  readonly entries: LayoutRow[];
}

function fakeTui() {
  const original = vi.fn(() => ({ type: "vstack", entries: [], gap: 0, align: "stretch" }));
  const root = {
    render: vi.fn(() => ["Pi chat and editor"]),
    invalidate: vi.fn(),
    [LAYOUT_NODE]: original as unknown,
  };
  const tui = {
    terminal: { columns: 160, rows: 45 },
    requestRender: vi.fn(),
    layoutRoot: root,
    chatContainer: { invalidate: vi.fn() },
  };
  return { tui, root, original };
}

describe("Pi's native split-pane adapter", () => {
  it("uses Pi's original centre layout, with full-height dock columns and no duplicate patch", () => {
    const { tui, root, original } = fakeTui();
    const state = initialPaneSettings();
    const select = vi.fn();
    const options = { project: () => "my-project", right: () => [" STATUS"], select };
    const panel = attachNativePanes(tui, state, options);
    expect(panel.attached).toBe(true);
    expect(attachNativePanes(tui, state, options).attached).toBe(false);
    const layout = (root[LAYOUT_NODE] as () => NativeLayout)();
    expect(layout.type).toBe("hstack");
    expect(layout.entries).toHaveLength(2);
    expect(layout.entries.map((entry) => entry.basis)).toEqual([0, 40]);
    const [centre, right] = layout.entries;
    if (!centre || !right) throw new Error("Expected Pi panes");
    expect((centre.component[LAYOUT_NODE] as () => unknown)()).toEqual(
      original.mock.results.at(-1)?.value,
    );
    expect(centre.component.render(40)).toEqual(["Pi chat and editor"]);
    const dock = right.component.render(40).map(stripAnsi).join("\n");
    expect(dock).toContain("Espacio: Explorador");
    expect(dock).toContain("[1:TREE]");
    expect(dock).toContain("STATUS");
    expect(right.component.render(40)).toHaveLength(tui.terminal.rows);

    right.component.handleMouse?.({ type: "click", button: "left", y: 1, x: 3 });
    expect(select).toHaveBeenCalledWith("explorer");
    state.rightVisible = false;
    expect((root[LAYOUT_NODE] as () => unknown)()).toEqual(original());
    panel.close();
    expect(root[LAYOUT_NODE]).toBe(original);
    expect(original()).toEqual((root[LAYOUT_NODE] as () => unknown)());
  });

  it("backs out on narrow terminals, missing layout internals and competing Gentle Shell rail", () => {
    const state = initialPaneSettings();
    const options = { project: () => "x", right: () => [], select: () => undefined };
    const { tui, root, original } = fakeTui();
    const panel = attachNativePanes(tui, state, options);
    tui.terminal.columns = MIN_PANE_COLUMNS - 1;
    expect((root[LAYOUT_NODE] as () => unknown)()).toEqual(original());
    tui.terminal.columns = 160;
    tui.terminal.rows = MIN_PANE_ROWS - 1;
    expect((root[LAYOUT_NODE] as () => unknown)()).toEqual(original());
    state.leftVisible = false;
    state.rightVisible = false;
    tui.terminal.rows = 45;
    expect((root[LAYOUT_NODE] as () => unknown)()).toEqual(original());
    panel.close();

    const noRoot = { terminal: tui.terminal, requestRender: vi.fn() };
    expect(attachNativePanes(noRoot, state, options).attached).toBe(false);
    (root as Record<symbol, unknown>)[GENTLE_SIDEBAR] = { active: true };
    expect(attachNativePanes(tui, state, options).attached).toBe(false);
  });

  it("renders persisted ordering, hides slots and fills rows at exact column widths", () => {
    const slots = readDockSlots({
      value: [
        { id: "youtube", visible: true },
        { id: "git", visible: false },
        { id: "explorer", visible: true },
        { id: "memory", visible: true },
        { id: "themes", visible: true },
      ],
    });
    const state = { ...initialPaneSettings(), slots, selected: "youtube" as const };
    const lines = renderLeftDock(23, 25, state, "code").map(stripAnsi);
    expect(lines).toHaveLength(25);
    expect(lines.every((line) => textWidth(line) === 23)).toBe(true);
    const text = lines.join("\n");
    expect(text.indexOf("1:YT")).toBeLessThan(text.indexOf("2:TREE"));
    expect(text).not.toContain(" Git ");
    expect(readDockSlots({ value: [{ id: "explorer", visible: true }] })).toHaveLength(5);
    const oldSettings = readDockSlots({
      value: [
        { id: "git", visible: false },
        { id: "explorer", visible: true },
        { id: "untrusted", visible: false },
      ],
    });
    expect(oldSettings[0]).toEqual({ id: "git", visible: false });
    expect(oldSettings[1]).toEqual({ id: "explorer", visible: true });
    expect(oldSettings).toHaveLength(5);
    expect(renderRightDock(20, 4, [" ".repeat(19)]).map(stripAnsi)).toHaveLength(4);
    const english = renderLeftDock(23, 25, state, "code", 0, "high", "en")
      .map(stripAnsi)
      .join("\n");
    expect(english).toContain("VIEWS · Alt+L");
    expect(english).toContain("Alt+C · commands");
  });

  it("keeps the dock fixed through resize and does not consume Pi layout when terminal is narrow", () => {
    const { tui, root, original } = fakeTui();
    const state = { ...initialPaneSettings(), leftVisible: true };
    const pane = attachNativePanes(tui, state, {
      project: () => "repo",
      right: () => [],
      select: () => undefined,
    });
    for (const columns of [135, 156, 180, 132]) {
      tui.terminal.columns = columns;
      const layout = (root[LAYOUT_NODE] as () => NativeLayout)();
      expect(layout.type).toBe("hstack");
      expect(layout.entries[0]?.component.render(23)).toHaveLength(tui.terminal.rows);
      expect(layout.entries[0]?.basis).toBe(23);
    }
    tui.terminal.columns = 131;
    expect((root[LAYOUT_NODE] as () => NativeLayout)().type).toBe("vstack");
    pane.close();
    expect(root[LAYOUT_NODE]).toBe(original);
  });

  it("clicks a compact tab without consuming the main chat or opening an Explorer modal", () => {
    const { tui, root } = fakeTui();
    const state = initialPaneSettings();
    const select = vi.fn();
    const toggleExplorer = vi.fn();
    const activate = vi.fn();
    const panel = attachNativePanes(tui, state, {
      project: () => "repo",
      right: () => [],
      select,
      toggleExplorer,
      activate,
    });
    const layout = (root[LAYOUT_NODE] as () => NativeLayout)();
    const right = layout.entries[1]?.component;
    const tabRows = right?.render(40).map(stripAnsi);
    expect(tabRows?.[1]).toContain("1:TREE");
    right?.handleMouse?.({ type: "click", button: "left", y: 1, x: 11 });
    expect(select).toHaveBeenCalledWith("git");

    state.detail = {
      id: "explorer",
      title: "Explorador",
      status: "Árbol",
      lines: ["repo", "▸ ▣ src"],
      treeNodes: [{ path: "/repo/src", directory: true, depth: 0 }],
    };
    const treeRows = right?.render(40).map(stripAnsi) ?? [];
    const folderRow = treeRows.findIndex((row) => row.includes("src"));
    expect(folderRow).toBeGreaterThan(1);
    right?.handleMouse?.({ type: "click", button: "left", y: folderRow, x: 4 });
    expect(toggleExplorer).toHaveBeenCalledWith("/repo/src");
    state.selected = "themes";
    state.detail = {
      id: "themes",
      title: "Temas",
      status: "Paleta",
      lines: ["Selecciona:", "1. violet"],
      actions: [{ line: 1, action: "violet" }],
    };
    right?.render(40);
    const themeRows = right?.render(40).map(stripAnsi) ?? [];
    const violetRow = themeRows.findIndex((row) => row.includes("violet"));
    right?.handleMouse?.({ type: "click", button: "left", y: violetRow, x: 4 });
    expect(activate).toHaveBeenCalledWith("themes", "violet");
    panel.close();
  });
});
