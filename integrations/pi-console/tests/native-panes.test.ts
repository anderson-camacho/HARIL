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
    expect(layout.entries).toHaveLength(3);
    expect(layout.entries.map((entry) => entry.basis)).toEqual([23, 0, 40]);
    const [left, centre, right] = layout.entries;
    if (!left || !centre || !right) throw new Error("Expected all three Pi panes");
    expect((centre.component[LAYOUT_NODE] as () => unknown)()).toEqual(
      original.mock.results.at(-1)?.value,
    );
    expect(centre.component.render(40)).toEqual(["Pi chat and editor"]);
    expect(left.component.render(23).map(stripAnsi).join("\n")).toContain("Explorador");
    expect(right.component.render(40)).toHaveLength(tui.terminal.rows);

    left.component.handleMouse?.({ type: "click", button: "left", y: 4, x: 3 });
    expect(select).toHaveBeenCalledWith("explorer");
    state.rightVisible = false;
    expect((root[LAYOUT_NODE] as () => NativeLayout)().entries).toHaveLength(2);
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
    expect(text.indexOf("YouTube")).toBeLessThan(text.indexOf("Explorador"));
    expect(text).not.toContain(" Git ");
    expect(readDockSlots({ value: [{ id: "explorer", visible: true }] })).toHaveLength(5);
    expect(renderRightDock(20, 4, [" ".repeat(19)]).map(stripAnsi)).toHaveLength(4);
  });
});
