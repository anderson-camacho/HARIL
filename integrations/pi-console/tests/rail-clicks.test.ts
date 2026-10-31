import { describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import {
  type DashboardArea,
  type DashboardFacts,
  type RailSection,
  renderNativeRailContent,
} from "../src/dashboard.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { attachNativePanes, initialPaneSettings, type PaneSettings } from "../src/native-panes.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type { ConsoleComponent, ConsoleTheme, ConsoleTui } from "../src/pi-types.js";
import { type RailActionTarget, runRailHit } from "../src/rail-actions.js";
import { stripAnsi } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// The right rail's body (AVISOS, EXTENSIONES, SESIÓN, the areas and "cambiar") must answer a mouse click. These tests
// drive the real pane with the real rail content: the row that is clicked is found by the text the user sees, and the
// action it must run is read from the independent `hit` metadata of that same row. The actions of the chosen area are
// the ACC tab's now (actions-tab.test.ts).

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

interface RightPane {
  render(width: number): string[];
  handleMouse?(event: {
    type: string;
    button: string;
    x: number;
    y: number;
    wheelDelta?: number;
  }): unknown;
}

function facts(warnings = 1): DashboardFacts {
  return {
    project: "fake-project",
    cwd: "fake-cwd",
    branch: "main",
    modelLevel: "fake-model · no reasoning",
    providers: [],
    runtime: "idle",
    runtimeAvailable: true,
    pending: 0,
    context: "unavailable",
    cost: "$0.000",
    activeTools: ["read"],
    tools: [{ name: "read", active: true }],
    commands: ["haril"],
    mcpServers: [],
    extensionStatuses: ["pi-extension ready"],
    providerWarnings: Array.from({ length: warnings }, (_unused, index) =>
      index === 0 ? "Provider offline" : `Provider ${index} offline`,
    ),
    mode: "ACTION",
    memory: "not loaded",
    data: emptyDashboardData("fake-project"),
    loading: false,
    orchestration: initialOrchestrationState(),
    asciiGlyphs: false,
  };
}

function setup(
  options: {
    readonly area?: DashboardArea;
    readonly expanded?: Partial<Record<RailSection, boolean>>;
    readonly state?: Partial<PaneSettings>;
    readonly rows?: number;
    // How many provider warnings the rail lists under AVISOS (three rows at most, then a «+ n avisos» row).
    readonly warnings?: number;
    readonly withoutRailAction?: boolean;
  } = {},
) {
  const original = vi.fn(() => ({ type: "vstack", entries: [], gap: 0, align: "stretch" }));
  const root = {
    render: vi.fn(() => ["Pi chat and editor"]),
    invalidate: vi.fn(),
    [LAYOUT_NODE]: original as unknown,
  };
  const tui = {
    terminal: { columns: 160, rows: options.rows ?? 45 },
    requestRender: vi.fn(),
    layoutRoot: root,
    chatContainer: { invalidate: vi.fn() },
  };
  const state = { ...initialPaneSettings(), ...options.state };
  const expanded = options.expanded ?? {};
  const railAction = vi.fn();
  const select = vi.fn();
  const content = (width: number) =>
    renderNativeRailContent(facts(options.warnings), options.area ?? "agents", width, expanded, {
      cards: true,
    });
  attachNativePanes(tui, state, {
    project: () => "repo",
    right: content,
    select,
    ...(options.withoutRailAction ? {} : { railAction }),
  });
  const layout = (root[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
  const right = layout.entries[1]?.component;
  if (!right) throw new Error("Expected the right pane");
  const rows = () => right.render(40).map(stripAnsi);
  // The y of the row the user sees with `needle`, and the hit metadata of that same row in the rail content.
  const find = (needle: string) => {
    const y = rows().findIndex((row) => row.includes(needle));
    const index = content(39).lines.findIndex((line) => stripAnsi(line).includes(needle));
    if (y < 0 || index < 0) throw new Error(`Row not found: ${needle}`);
    return { y, hit: content(39).hits[index] };
  };
  const click = (y: number, x = 8) => right.handleMouse?.({ type: "click", button: "left", x, y });
  return { right, tui, state, expanded, railAction, select, rows, find, click };
}

describe("a click on the right rail body", () => {
  it.each([
    ["AVISOS", { action: "toggle", section: "warnings" }],
    ["EXTENSIONES", { action: "toggle", section: "extensions" }],
    ["SESIÓN", { action: "toggle", section: "status" }],
    ["cambiar", { action: "mode" }],
    ["! Provider offline", { action: "details" }],
    ["• pi-extension ready", { action: "details" }],
    ["● AGENTS", { action: "area", area: "agents" }],
    ["○ ORCHESTRATION", { action: "area", area: "orchestration" }],
    ["○ AUTOMATION", { action: "area", area: "automation" }],
    ["○ TOOLS", { action: "area", area: "tools" }],
    ["○ EVERYWHERE", { action: "area", area: "everywhere" }],
    ["Abrir vista de orquestación", { action: "run", control: "orchestration-view" }],
  ] as const)("on the row %s runs the action that row declares", (needle, expected) => {
    const pane = setup({ expanded: { extensions: true } });
    const { y, hit } = pane.find(needle);
    // The hit metadata of the row is the contract; the literal is only a guard against an empty table.
    expect(hit).toEqual(expected);
    const result = pane.click(y);
    expect(pane.railAction).toHaveBeenCalledTimes(1);
    expect(pane.railAction).toHaveBeenCalledWith(hit);
    expect(result).toEqual({ handled: true, render: true });
    expect(pane.tui.requestRender).toHaveBeenCalled();
  });

  it("resolves the row through the scroll offset, not the screen row", () => {
    const pane = setup({
      rows: 24,
      warnings: 6,
      expanded: { extensions: true, status: true, warnings: true },
    });
    // The session section is below the fold of a 24-row terminal until the wheel brings it up.
    expect(pane.rows().some((row) => row.includes("SESIÓN"))).toBe(false);
    pane.right.handleMouse?.({ type: "wheel", button: "none", x: 8, y: 5, wheelDelta: 6 });
    const { y, hit } = pane.find("SESIÓN");
    expect(hit).toEqual({ action: "toggle", section: "status" });
    pane.click(y);
    expect(pane.railAction).toHaveBeenCalledWith(hit);
  });

  it("no longer lists the actions of the area: they are the ACC tab's, and MAIN keeps the rest", () => {
    for (const area of ["agents", "orchestration", "automation", "tools", "everywhere"] as const) {
      const pane = setup({ area, expanded: { extensions: true, status: true } });
      const text = pane.rows().join("\n");
      expect(text, area).not.toContain("ACCIONES");
      expect(text, area).not.toContain("Abrir menú completo");
      expect(text, area).not.toContain("Ver detalles completos");
      expect(text, area).not.toContain("Actualizar datos");
      for (const kept of [
        "ÁREAS",
        "Abrir vista de orquestación",
        "AVISOS",
        "EXTENSIONES",
        "SESIÓN",
      ]) {
        expect(text, `${area} · ${kept}`).toContain(kept);
      }
      expect(text, area).toContain("Alt+K menú del panel · Alt+H áreas");
      expect(text, area).toContain("Alt+I panel · Alt+C comandos");
    }
  });

  it("marks the current area and draws the areas under a heading that is not a click target", () => {
    const pane = setup({ area: "tools" });
    const rows = pane.rows();
    expect(rows.some((row) => row.includes("● TOOLS"))).toBe(true);
    expect(rows.some((row) => row.includes("○ AGENTS"))).toBe(true);
    const { y } = pane.find("ÁREAS");
    expect(pane.find("ÁREAS").hit).toBeUndefined();
    expect(pane.click(y)).toBeUndefined();
    expect(pane.railAction).not.toHaveBeenCalled();
  });

  it("shows the project and the model once, even with the session section open", () => {
    const text = renderNativeRailContent(facts(), "agents", 39, { status: true }, { cards: true })
      .lines.map(stripAnsi)
      .join("\n");
    expect(text.match(/Proyecto:/g)).toHaveLength(1);
    expect(text.match(/Modelo:/g)).toHaveLength(1);
    // The session section keeps what the top rows do not say.
    expect(text).toContain("Runtime: idle");
    expect(text).toContain("Memoria: not loaded");
    const english = renderNativeRailContent(
      { ...facts(), locale: "en" },
      "agents",
      39,
      { status: true },
      { cards: true },
    )
      .lines.map(stripAnsi)
      .join("\n");
    expect(english.match(/Project:/g)).toHaveLength(1);
    expect(english.match(/Model:/g)).toHaveLength(1);
    expect(english).toContain("Memory: not loaded");
    expect(english).not.toContain("Memoria");
    expect(english).not.toContain("Proyecto");
  });

  it("still reaches the rows when the Espacio block is collapsed", () => {
    const pane = setup({ state: { dockExpanded: false } });
    const { y, hit } = pane.find("cambiar");
    pane.click(y);
    expect(pane.railAction).toHaveBeenCalledWith(hit);
  });

  it("leaves a row without a hit alone and reports it unhandled", () => {
    const pane = setup();
    const rendersBefore = pane.tui.requestRender.mock.calls.length;
    const content = renderNativeRailContent(facts(), "agents", 39, {}, { cards: true });
    for (const needle of ["Proyecto: fake-project", "Modelo: fake-model", "Alt+K menú del panel"]) {
      const y = pane.rows().findIndex((row) => row.includes(needle));
      expect(y).toBeGreaterThan(0);
      const index = content.lines.findIndex((line) => stripAnsi(line).includes(needle));
      expect(content.hits[index]).toBeUndefined();
      expect(pane.click(y)).toBeUndefined();
    }
    expect(pane.railAction).not.toHaveBeenCalled();
    expect(pane.tui.requestRender.mock.calls).toHaveLength(rendersBefore);
  });

  it("does not swallow a click when nobody handles rail actions", () => {
    const pane = setup({ withoutRailAction: true });
    const { y } = pane.find("cambiar");
    expect(pane.click(y)).toBeUndefined();
  });

  it("keeps the header and the tab row working as before", () => {
    const pane = setup();
    // The header is a box: its first row is the border, then the space, then the tabs.
    const tabsRow = pane.rows()[2] ?? "";
    expect(tabsRow).toContain("[1:MAIN]");
    pane.click(2, tabsRow.indexOf("2:TOOLS"));
    expect(pane.select).toHaveBeenCalledWith("memory");
    expect(pane.railAction).not.toHaveBeenCalled();
    expect(pane.state.dockExpanded).toBe(true);
    // Five tabs wrap onto a second row of the box, whose last tab (ACC) is hit on its own columns.
    expect(pane.rows()[3]).toContain("5:ACC");
    pane.select.mockClear();
    pane.click(3, (pane.rows()[3] ?? "").indexOf("5:ACC"));
    expect(pane.select).toHaveBeenCalledWith("actions");
    // The border and the space row toggle the dock; the bottom border of the box does nothing.
    expect(pane.click(4)).toBeUndefined();
    expect(pane.state.dockExpanded).toBe(true);
    expect(pane.click(0)).toEqual({ handled: true, render: true });
    expect(pane.state.dockExpanded).toBe(false);
    expect(pane.click(1)).toEqual({ handled: true, render: true });
    expect(pane.state.dockExpanded).toBe(true);
  });
});

describe("the actions a rail hit runs", () => {
  function target(expanded: Partial<Record<RailSection, boolean>> = {}) {
    const calls: string[] = [];
    const host: RailActionTarget = {
      railExpanded: expanded,
      redraw: () => calls.push("redraw"),
      runControl: (control) => calls.push(`run:${control}`),
      chooseMode: () => calls.push("mode"),
      openMenu: () => calls.push("menu"),
      focus: () => calls.push("focus"),
      openArea: (area) => calls.push(`area:${area}`),
    };
    return { host, calls, expanded };
  }

  it("toggles a section against its default and redraws", () => {
    const { host, calls, expanded } = target();
    // AVISOS and ACCIONES start open, EXTENSIONES and SESIÓN start closed.
    runRailHit(host, { action: "toggle", section: "warnings" });
    runRailHit(host, { action: "toggle", section: "status" });
    expect(expanded).toEqual({ warnings: false, status: true });
    runRailHit(host, { action: "toggle", section: "warnings" });
    expect(expanded.warnings).toBe(true);
    expect(calls).toEqual(["redraw", "redraw", "redraw"]);
  });

  it("ignores a toggle without a section and a run without a control", () => {
    const { host, calls, expanded } = target();
    runRailHit(host, { action: "toggle" });
    runRailHit(host, { action: "run" });
    expect(expanded).toEqual({});
    expect(calls).toEqual([]);
  });

  it("routes the other hits to the console", () => {
    const { host, calls } = target();
    runRailHit(host, { action: "run", control: "tasks" });
    runRailHit(host, { action: "details" });
    runRailHit(host, { action: "mode" });
    runRailHit(host, { action: "menu" });
    runRailHit(host, { action: "focus" });
    runRailHit(host, { action: "area", area: "tools" });
    expect(calls).toEqual(["run:tasks", "run:details", "mode", "menu", "focus", "area:tools"]);
  });

  it("ignores an area hit that names no area", () => {
    const { host, calls } = target();
    runRailHit(host, { action: "area" });
    expect(calls).toEqual([]);
  });
});

describe("the console's rails", () => {
  const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };
  type Mount = (tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent;

  // Starts the console on a fake Pi with no HARIL CLI, and records what a rail click ends up asking Pi for.
  async function withConsole(
    run: (console: {
      readonly header: Mount;
      readonly anchor: Mount;
      readonly selects: string[];
      readonly customs: () => number;
    }) => void,
  ): Promise<void> {
    const envNode = process.env.HARIL_NODE;
    const envCli = process.env.HARIL_CLI;
    delete process.env.HARIL_NODE;
    delete process.env.HARIL_CLI;
    const fake = fakePi();
    const ctx = fakeContext();
    const selects: string[] = [];
    let customs = 0;
    let header: Mount | undefined;
    let anchor: Mount | undefined;
    Object.assign(ctx.ui, {
      select: async (title: string) => {
        selects.push(title);
        return undefined;
      },
      custom: async () => {
        customs++;
        return undefined;
      },
      setHeader(value: Mount) {
        header = value;
      },
      setWidget(key: string, value: Mount) {
        if (key === "haril-native-panes-anchor") anchor = value;
      },
    });
    try {
      harilConsole(fake.pi);
      await fake.fire("session_start", { reason: "startup" }, ctx);
      if (!header || !anchor) throw new Error("Expected the console to install its UI");
      run({ header, anchor, selects, customs: () => customs });
      await fake.fire("session_shutdown", {}, ctx);
    } finally {
      if (envNode === undefined) delete process.env.HARIL_NODE;
      else process.env.HARIL_NODE = envNode;
      if (envCli === undefined) delete process.env.HARIL_CLI;
      else process.env.HARIL_CLI = envCli;
    }
  }

  it("runs the rail's actions when the native right pane's sections, actions and mode are clicked", async () => {
    await withConsole(({ anchor, selects, customs }) => {
      const root = {
        render: () => ["Pi chat"],
        invalidate: () => undefined,
        [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
      };
      const tui = {
        layoutRoot: root,
        terminal: { columns: 160, rows: 45 },
        requestRender: vi.fn(),
      };
      anchor(tui, THEME);
      const layout = (root[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
      const right = layout.entries[1]?.component;
      if (!right) throw new Error("Expected the right pane");
      const rows = () => right.render(40).map(stripAnsi);
      const click = (needle: string) => {
        const y = rows().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}`);
        return right.handleMouse?.({ type: "click", button: "left", x: 8, y });
      };

      expect(rows().find((row) => row.includes("AVISOS"))).toContain("▼");
      expect(click("AVISOS")).toEqual({ handled: true, render: true });
      expect(rows().find((row) => row.includes("AVISOS"))).toContain("▶");
      click("AVISOS");
      expect(rows().find((row) => row.includes("AVISOS"))).toContain("▼");

      expect(rows().some((row) => row.includes("Runtime:"))).toBe(false);
      click("SESIÓN");
      expect(rows().some((row) => row.includes("Runtime:"))).toBe(true);

      click("cambiar");
      expect(selects).toHaveLength(1);
      expect(selects[0]).toMatch(/^Console mode/);

      // The actions are not on this tab: nothing opens a view from here.
      expect(rows().some((row) => row.includes("Ver detalles completos"))).toBe(false);
      expect(customs()).toBe(0);
    });
  });

  it("opens the area whose row is clicked in the native right pane, and moves the marker", async () => {
    await withConsole(({ anchor }) => {
      const root = {
        render: () => ["Pi chat"],
        invalidate: () => undefined,
        [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
      };
      const tui = {
        layoutRoot: root,
        terminal: { columns: 160, rows: 45 },
        requestRender: vi.fn(),
      };
      anchor(tui, THEME);
      const layout = (root[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
      const right = layout.entries[1]?.component;
      if (!right) throw new Error("Expected the right pane");
      const rows = () => right.render(40).map(stripAnsi);
      const click = (needle: string) => {
        const y = rows().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}`);
        return right.handleMouse?.({ type: "click", button: "left", x: 8, y });
      };
      expect(rows().some((row) => row.includes("● AGENTS"))).toBe(true);
      expect(click("○ TOOLS")).toEqual({ handled: true, render: true });
      expect(rows().some((row) => row.includes("● TOOLS"))).toBe(true);
      expect(rows().some((row) => row.includes("○ AGENTS"))).toBe(true);
      expect(rows().some((row) => row.includes("● AGENTS"))).toBe(false);
      // The actions of the area that was opened are the ACC tab's, not this tab's.
      expect(rows().some((row) => row.includes("ACCIONES"))).toBe(false);
    });
  });

  it("opens the orchestration view from its row, whichever area is open", async () => {
    await withConsole(({ anchor, customs }) => {
      const root = {
        render: () => ["Pi chat"],
        invalidate: () => undefined,
        [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
      };
      const tui = {
        layoutRoot: root,
        terminal: { columns: 160, rows: 45 },
        requestRender: vi.fn(),
      };
      anchor(tui, THEME);
      const layout = (root[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
      const right = layout.entries[1]?.component;
      if (!right) throw new Error("Expected the right pane");
      const y = right
        .render(40)
        .map(stripAnsi)
        .findIndex((row) => row.includes("Abrir vista de orquestación"));
      expect(y).toBeGreaterThan(0);
      right.handleMouse?.({ type: "click", button: "left", x: 8, y });
      expect(customs()).toBe(1);
    });
  });

  it("still runs the same actions from the classic header rail, which the native pane replaces", async () => {
    await withConsole(({ header, selects, customs }) => {
      const tui = { terminal: { columns: 160, rows: 45 }, requestRender: vi.fn() };
      const component = header(tui, THEME);
      const render = () => component.render(160).map(stripAnsi);
      const click = (needle: string) => {
        const y = render().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}`);
        const x = (render()[y] ?? "").lastIndexOf(needle);
        return component.handleMouse?.({
          type: "click",
          button: "left",
          x,
          y,
          width: 160,
          height: 45,
          shift: false,
          alt: false,
          ctrl: false,
        });
      };

      expect(render().find((row) => row.includes("AVISOS"))).toContain("▼");
      // The classic header keeps its own look: the cards and the header box belong to the native pane only.
      expect(render().join("\n")).not.toMatch(/[╭╮╰╯]/u);
      expect(click("AVISOS")).toEqual({ handled: true, render: true });
      expect(render().find((row) => row.includes("AVISOS"))).toContain("▶");
      click("cambiar");
      expect(selects[0]).toMatch(/^Console mode/);
      click("[D] Ver detalles completos");
      expect(customs()).toBe(1);
    });
  });
});
