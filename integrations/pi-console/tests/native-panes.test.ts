import { describe, expect, it, vi } from "vitest";
import type { RailHitAction } from "../src/dashboard.js";
import {
  attachNativePanes,
  initialPaneSettings,
  MIN_PANE_COLUMNS,
  MIN_PANE_ROWS,
  panesShown,
  readDockSlots,
  renderLeftDock,
  renderRightDock,
  statusInSidebar,
} from "../src/native-panes.js";
import { stripAnsi, textWidth } from "../src/text.js";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const GENTLE_SIDEBAR = Symbol.for("gentle-pi.experimental-sidebar.state");
interface LayoutRow {
  readonly basis: number;
  readonly component: {
    render(width: number): string[];
    handleMouse?(event: {
      type: string;
      button: string;
      x: number;
      y: number;
      wheelDelta?: number;
    }): unknown;
    [key: symbol]: unknown;
  };
}
interface NativeLayout {
  readonly type: string;
  readonly entries: LayoutRow[];
}

// What the pane asks of its host for the right rail's body: the rows and, per row, the action a click runs.
function rail(lines: string[] = [], hits: (RailHitAction | undefined)[] = []) {
  return { lines, hits };
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
    const options = { project: () => "my-project", right: () => rail([" STATUS"]), select };
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
    expect(dock).toContain("Espacio: Principal");
    expect(dock).toContain("[1:MAIN]");
    expect(dock).toContain("STATUS");
    expect(right.component.render(40)).toHaveLength(tui.terminal.rows);

    right.component.handleMouse?.({ type: "click", button: "left", y: 1, x: 3 });
    expect(select).toHaveBeenCalledWith("main");
    state.rightVisible = false;
    expect((root[LAYOUT_NODE] as () => unknown)()).toEqual(original());
    panel.close();
    expect(root[LAYOUT_NODE]).toBe(original);
    expect(original()).toEqual((root[LAYOUT_NODE] as () => unknown)());
  });

  it("backs out on narrow terminals, missing layout internals and competing Gentle Shell rail", () => {
    const state = initialPaneSettings();
    const options = { project: () => "x", right: () => rail(), select: () => undefined };
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
        { id: "docs", visible: true },
        { id: "memory", visible: false },
        { id: "explorer", visible: true },
        { id: "git", visible: true },
        { id: "main", visible: false },
      ],
    });
    // A stored "explorer" (the retired TREE slot) or "git" is not a registered view, so it never reaches the dock.
    // MAIN is first and visible whatever the stored list says.
    expect(slots.map((slot) => slot.id)).toEqual(["main", "docs", "memory"]);
    expect(slots[0]).toEqual({ id: "main", visible: true });
    const state = { ...initialPaneSettings(), slots, selected: "docs" as const };
    const lines = renderLeftDock(23, 25, state, "code").map(stripAnsi);
    expect(lines).toHaveLength(25);
    expect(lines.every((line) => textWidth(line) === 23)).toBe(true);
    const text = lines.join("\n");
    expect(text.indexOf("1:MAIN")).toBeLessThan(text.indexOf("2:DOCS"));
    expect(text).not.toContain("MEM");
    expect(
      readDockSlots({ value: [{ id: "explorer", visible: true }] }).map((slot) => slot.id),
    ).toEqual(["main", "memory", "docs"]);
    const oldSettings = readDockSlots({
      value: [
        { id: "memory", visible: false },
        { id: "explorer", visible: true },
        { id: "untrusted", visible: false },
      ],
    });
    expect(oldSettings[1]).toEqual({ id: "memory", visible: false });
    expect(oldSettings[2]).toEqual({ id: "docs", visible: true });
    expect(oldSettings.map((slot) => slot.id)).toEqual(["main", "memory", "docs"]);
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
      right: () => rail(),
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

  it("clicks a compact tab without consuming the main chat", () => {
    const { tui, root } = fakeTui();
    const state = initialPaneSettings();
    const select = vi.fn();
    const activate = vi.fn();
    const panel = attachNativePanes(tui, state, {
      project: () => "repo",
      right: () => rail(),
      select,
      activate,
    });
    const layout = (root[LAYOUT_NODE] as () => NativeLayout)();
    const right = layout.entries[1]?.component;
    const tabRows = right?.render(40).map(stripAnsi);
    expect(tabRows?.[1]).toContain("1:MAIN");
    expect(tabRows?.[1]).toContain("2:MEM");
    expect(tabRows?.[1]).toContain("3:DOCS");
    right?.handleMouse?.({ type: "click", button: "left", y: 1, x: 11 });
    expect(select).toHaveBeenCalledWith("memory");

    // A detail row of a view without actions is plain text: a click on it is left unhandled.
    state.selected = "memory";
    state.detail = {
      id: "memory",
      title: "Memoria",
      status: "Estado de memoria HARIL",
      lines: ["Provider: Engram", "Ready"],
    };
    const memoryRows = right?.render(40).map(stripAnsi) ?? [];
    const readyRow = memoryRows.findIndex((row) => row.includes("Ready"));
    expect(readyRow).toBeGreaterThan(1);
    expect(right?.handleMouse?.({ type: "click", button: "left", y: readyRow, x: 4 })).toBe(
      undefined,
    );
    expect(activate).not.toHaveBeenCalled();

    // The actions a detail declares are generic: any tab that provides them is clickable, not one in particular.
    for (const id of ["memory", "docs"] as const) {
      state.selected = id;
      state.detail = {
        id,
        title: id,
        status: "Estado",
        lines: ["Elige una opción:", "1. abrir carpeta"],
        actions: [{ line: 1, action: "open-folder" }],
      };
      const rows = right?.render(40).map(stripAnsi) ?? [];
      const optionRow = rows.findIndex((row) => row.includes("abrir carpeta"));
      expect(optionRow).toBeGreaterThan(1);
      expect(right?.handleMouse?.({ type: "click", button: "left", y: optionRow, x: 4 })).toEqual({
        handled: true,
        render: true,
      });
      expect(activate).toHaveBeenLastCalledWith(id, "open-folder");
    }
    // A view whose actions belong to another tab (a load that has not finished) is not activated.
    activate.mockClear();
    state.detail = {
      id: "memory",
      title: "Memoria",
      status: "Estado",
      lines: ["Elige una opción:", "1. abrir carpeta"],
      actions: [{ line: 1, action: "open-folder" }],
    };
    const stale = right?.render(40).map(stripAnsi) ?? [];
    expect(stale.some((row) => row.includes("abrir carpeta"))).toBe(false);
    right?.handleMouse?.({ type: "click", button: "left", y: 6, x: 4 });
    expect(activate).not.toHaveBeenCalled();
    panel.close();
  });

  it("hits a tab on exactly the columns it is drawn on", () => {
    const { tui, root } = fakeTui();
    const select = vi.fn();
    attachNativePanes(tui, initialPaneSettings(), {
      project: () => "repo",
      right: () => rail(),
      select,
    });
    const right = (root[LAYOUT_NODE] as () => NativeLayout)().entries[1]?.component;
    const row = stripAnsi(right?.render(40)[1] ?? "");
    const clickAt = (x: number) => {
      select.mockClear();
      right?.handleMouse?.({ type: "click", button: "left", y: 1, x });
      return select.mock.calls.map((call) => call[0]);
    };
    // Drawn as "│ [1:MAIN]  2:MEM   3:DOCS ...": the dock's "│", a space, then the tab text.
    // An unselected tab keeps one padding space on each side of its text.
    const main = row.indexOf("[1:MAIN]");
    const memory = row.indexOf("2:MEM") - 1;
    const memoryLast = memory + " 2:MEM ".length - 1;
    expect(main).toBe(2);
    expect(clickAt(main)).toEqual(["main"]);
    expect(clickAt(main + "[1:MAIN]".length - 1)).toEqual(["main"]);
    expect(clickAt(main - 1)).toEqual([]);
    expect(clickAt(memory)).toEqual(["memory"]);
    expect(clickAt(memoryLast)).toEqual(["memory"]);
    // The separator column between two tabs belongs to neither.
    expect(clickAt(memory - 1)).toEqual([]);
    expect(clickAt(memoryLast + 1)).toEqual([]);
  });

  it("ignores pointer movement without building the rail, but keeps the wheel scrolling", () => {
    const { tui, root } = fakeTui();
    const content = vi.fn(() => rail([" STATUS"]));
    attachNativePanes(tui, initialPaneSettings(), {
      project: () => "repo",
      right: content,
      select: () => undefined,
    });
    const right = (root[LAYOUT_NODE] as () => NativeLayout)().entries[1]?.component;
    for (const type of ["move", "press", "release", "drag"]) {
      expect(right?.handleMouse?.({ type, button: "none", y: 3, x: 6 })).toBeUndefined();
    }
    expect(right?.handleMouse?.({ type: "click", button: "right", y: 3, x: 6 })).toBeUndefined();
    expect(content).not.toHaveBeenCalled();
    expect(
      right?.handleMouse?.({ type: "wheel", button: "none", y: 3, x: 6, wheelDelta: 1 }),
    ).toEqual({ handled: true, render: true });
    expect(content).toHaveBeenCalledTimes(1);
  });
});

// The status block (status, mode, sections, actions, activity) is MAIN's own content. Under every other tab the rail
// shows that tab's view and nothing of the block, and the block is not even built.
describe("the status block belongs to the MAIN tab", () => {
  const MODE_HIT: RailHitAction = { action: "mode" };

  function pane(state = initialPaneSettings()) {
    const { tui, root } = fakeTui();
    const content = vi.fn(() => rail([" DASH ROW 0", " DASH ROW 1"], [MODE_HIT, undefined]));
    const railAction = vi.fn();
    const activate = vi.fn();
    attachNativePanes(tui, state, {
      project: () => "repo",
      right: content,
      select: () => undefined,
      railAction,
      activate,
    });
    // The right pane is the last column, whether or not the left dock is beside the chat.
    const right = (root[LAYOUT_NODE] as () => NativeLayout)().entries.at(-1)?.component;
    if (!right) throw new Error("Expected the right pane");
    const rows = () => right.render(40).map(stripAnsi);
    return { right, tui, state, content, railAction, activate, rows };
  }

  const memoryDetail = {
    id: "memory" as const,
    title: "Memoria",
    status: "Estado de memoria HARIL",
    lines: ["Provider: Engram", "Ready"],
  };

  it("draws the tabs, a separator and then the block under MAIN, with nothing to load in between", () => {
    const { rows, state } = pane();
    // A stale view of another tab, or none at all, must not leave "Cargando vista…" or old rows under MAIN.
    state.detail = memoryDetail;
    const lines = rows();
    expect(lines[0]).toContain("▼ Espacio: Principal · Alt+L");
    expect(lines[1]).toContain("[1:MAIN]");
    expect(lines[2]).toContain("────");
    expect(lines[3]).toContain("DASH ROW 0");
    expect(lines[4]).toContain("DASH ROW 1");
    const text = lines.join("\n");
    expect(text).not.toContain("Cargando vista");
    expect(text).not.toContain("Ready");
    state.detail = undefined;
    expect(rows().join("\n")).not.toContain("Cargando vista");
  });

  it.each(["memory", "docs"] as const)("under %s shows its view and none of the block", (id) => {
    const { rows, state, content } = pane();
    state.selected = id;
    state.detail = { ...memoryDetail, id };
    const text = rows().join("\n");
    expect(text).toContain("Estado de memoria HARIL");
    expect(text).toContain("Ready");
    expect(text).not.toContain("DASH ROW");
    expect(text).not.toContain("ACTIVIDAD");
    // A tab whose view is still loading says so; it is the only thing it says.
    state.detail = undefined;
    expect(rows().join("\n")).toContain("Cargando vista…");
    expect(rows().join("\n")).not.toContain("DASH ROW");
    // The block is not built for a rail that does not draw it.
    expect(content).not.toHaveBeenCalled();
  });

  it("never builds the block, nor looks a click up in it, while another tab is selected", () => {
    const { right, state, content, railAction, tui } = pane();
    state.selected = "memory";
    state.detail = memoryDetail;
    for (let y = 0; y < tui.terminal.rows; y++) {
      for (const x of [2, 8, 30]) {
        const result = right.handleMouse?.({ type: "click", button: "left", y, x });
        // The header toggles the block, a tab selects and a view row without actions is left alone: no rail hit.
        expect(railAction, `y=${y} x=${x}`).not.toHaveBeenCalled();
        if (y > 1) expect(result, `y=${y} x=${x}`).toBeUndefined();
      }
    }
    right.handleMouse?.({ type: "wheel", button: "none", y: 3, x: 6, wheelDelta: 1 });
    expect(content).not.toHaveBeenCalled();
  });

  it("looks a click up in the block exactly where the block is drawn, under MAIN", () => {
    const { right, rows, railAction, content } = pane();
    const y = rows().findIndex((row) => row.includes("DASH ROW 0"));
    expect(right.handleMouse?.({ type: "click", button: "left", y, x: 8 })).toEqual({
      handled: true,
      render: true,
    });
    expect(railAction).toHaveBeenCalledWith(MODE_HIT);
    // The row below has no action; the separator and the tabs above are not block rows.
    railAction.mockClear();
    const next = rows().findIndex((row) => row.includes("DASH ROW 1"));
    expect(right.handleMouse?.({ type: "click", button: "left", y: next, x: 8 })).toBeUndefined();
    expect(right.handleMouse?.({ type: "click", button: "left", y: y - 1, x: 8 })).toBeUndefined();
    expect(railAction).not.toHaveBeenCalled();
    expect(content).toHaveBeenCalled();
  });

  it("keeps a header and the tabs when the dock is collapsed, on any tab", () => {
    const { rows, state } = pane({ ...initialPaneSettings(), dockExpanded: false });
    const main = rows();
    expect(main[0]).toContain("▶ Espacio: Principal · Alt+L");
    expect(main[1]).toContain("DASH ROW 0");
    state.selected = "memory";
    state.detail = memoryDetail;
    const memory = rows();
    expect(memory[0]).toContain("▶ Espacio: Memoria · Alt+L");
    expect(memory.join("\n")).not.toContain("DASH ROW");
    // Not a blank rail: the header says where the user is and that the dock can be opened.
    expect(memory[0]?.trim().length).toBeGreaterThan(10);
  });

  it("shows the block beside the left dock only under MAIN", () => {
    const { rows, state } = pane({ ...initialPaneSettings(), leftVisible: true });
    expect(rows()[0]).toContain("▣ Espacio: Principal");
    expect(rows()[1]).toContain("DASH ROW 0");
    state.selected = "docs";
    const docs = rows();
    expect(docs[0]).toContain("▣ Espacio: Documentación");
    expect(docs.join("\n")).not.toContain("DASH ROW");
  });

  it("keeps the left dock for the other views, and for MAIN points at the right panel", () => {
    const state = initialPaneSettings();
    const main = renderLeftDock(23, 30, state, "code").map(stripAnsi);
    expect(main.every((line) => textWidth(line) === 23)).toBe(true);
    // The dock is 23 columns wide: the sentence takes the rows it needs, and nothing else is said under MAIN.
    const sentence = (rowsOf: string[]) =>
      rowsOf
        .map((row) => row.replace(/│$/, "").trim())
        .join(" ")
        .replace(/\s+/g, " ");
    expect(sentence(main)).toContain("Estado en el panel derecho.");
    expect(sentence(main)).not.toContain("Cargando vista");
    const english = renderLeftDock(23, 30, state, "code", 0, undefined, "en").map(stripAnsi);
    expect(sentence(english)).toContain("Status is in the right panel.");
    const memory = { ...state, selected: "memory" as const };
    expect(renderLeftDock(23, 30, memory, "code").map(stripAnsi).join("\n")).toContain(
      "Cargando vista…",
    );
    const loaded = {
      ...memory,
      detail: { ...memoryDetail },
    };
    const loadedText = renderLeftDock(23, 30, loaded, "code").map(stripAnsi).join("\n");
    expect(loadedText).toContain("Ready");
    expect(loadedText).not.toContain("Estado en el panel derecho.");
  });
});

describe("where the status of the console is shown", () => {
  const base = {
    attached: true,
    columns: 160,
    rows: 45,
    rightVisible: true,
    selected: "main" as const,
  };

  it("is the sidebar only when it is drawn, on the right, with MAIN selected", () => {
    expect(statusInSidebar(base)).toBe(true);
    expect(statusInSidebar({ ...base, columns: MIN_PANE_COLUMNS })).toBe(true);
    expect(statusInSidebar({ ...base, rows: MIN_PANE_ROWS })).toBe(true);
  });

  it.each([
    ["the panes are not attached", { attached: false }],
    ["the terminal is a column short", { columns: MIN_PANE_COLUMNS - 1 }],
    ["the terminal is a row short", { rows: MIN_PANE_ROWS - 1 }],
    ["the right sidebar is hidden", { rightVisible: false }],
    ["MEM is selected", { selected: "memory" as const }],
    ["DOCS is selected", { selected: "docs" as const }],
  ])("is the bottom bar when %s", (_name, change) => {
    expect(statusInSidebar({ ...base, ...change })).toBe(false);
  });

  it("is a sidebar layout whenever the panes fit and any of them is visible, whichever tab", () => {
    const shown = {
      attached: true,
      columns: 160,
      rows: 45,
      leftVisible: false,
      rightVisible: true,
    };
    expect(panesShown(shown)).toBe(true);
    expect(panesShown({ ...shown, leftVisible: true, rightVisible: false })).toBe(true);
    expect(panesShown({ ...shown, rightVisible: false })).toBe(false);
    expect(panesShown({ ...shown, attached: false })).toBe(false);
    expect(panesShown({ ...shown, columns: MIN_PANE_COLUMNS - 1 })).toBe(false);
    expect(panesShown({ ...shown, rows: MIN_PANE_ROWS - 1 })).toBe(false);
  });
});
