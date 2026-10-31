import { describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import {
  DASHBOARD_AREAS,
  type DashboardFacts,
  type RailSection,
  renderNativeRailContent,
} from "../src/dashboard.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import type { UiLocale } from "../src/locale.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type {
  ConsoleComponent,
  ConsoleContext,
  ConsoleTheme,
  ConsoleTui,
} from "../src/pi-types.js";
import { buildRailMenu } from "../src/rail-actions.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// The right rail cannot take keyboard focus (Pi hands extension shortcuts to the editor only), so Alt+K and
// /haril-panel open a menu that offers what a click on the rail offers. These tests build that menu from the real
// output of renderNativeRailContent and drive the console's entry points with a fake Pi. The menu is built with the
// actions of the chosen area (the group the MAIN rail leaves to the ACC tab), so it lists what it always listed.

// Wide enough for every label to come out whole: the pane's own 39 columns would cut the long ones with an ellipsis.
const MENU_WIDTH = 120;

function facts(locale: UiLocale = "es"): DashboardFacts {
  return {
    locale,
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
    providerWarnings: ["Provider offline"],
    mode: "ACTION",
    memory: "not loaded",
    data: emptyDashboardData("fake-project"),
    loading: false,
    orchestration: initialOrchestrationState(),
    asciiGlyphs: false,
  };
}

function menuOf(
  area: "agents" | "orchestration",
  expanded: Partial<Record<RailSection, boolean>> = {},
  locale: UiLocale = "es",
) {
  const content = renderNativeRailContent(facts(locale), area, MENU_WIDTH, expanded, {
    actions: true,
  });
  return { content, menu: buildRailMenu(content, locale) };
}

describe("buildRailMenu", () => {
  it("offers one entry per distinct action, in rail order, with readable labels", () => {
    const { content, menu } = menuOf("agents", { extensions: true });
    expect(menu.map((entry) => entry.label)).toEqual([
      "Abrir detalles del área",
      "Cambiar modo",
      "Abrir área AGENTS",
      "Abrir área ORCHESTRATION",
      "Abrir área AUTOMATION",
      "Abrir área TOOLS",
      "Abrir área EVERYWHERE",
      "Abrir vista de orquestación",
      "Cerrar sección avisos (1)",
      "Ver detalles completos",
      "Cerrar sección extensiones (1)",
      "Cerrar sección sesión",
      "Cerrar sección acciones · AGENTS (4)",
      "Elegir modelo de Pi",
      "Tareas por agente observado",
      "Actualizar datos",
      "Abrir menú completo /haril",
    ]);
    expect(menu.map((entry) => entry.hit)).toEqual([
      { action: "focus" },
      { action: "mode" },
      { action: "area", area: "agents" },
      { action: "area", area: "orchestration" },
      { action: "area", area: "automation" },
      { action: "area", area: "tools" },
      { action: "area", area: "everywhere" },
      { action: "run", control: "orchestration-view" },
      { action: "toggle", section: "warnings" },
      { action: "run", control: "details" },
      { action: "toggle", section: "extensions" },
      { action: "toggle", section: "status" },
      { action: "toggle", section: "actions" },
      { action: "run", control: "model" },
      { action: "run", control: "tasks" },
      { action: "run", control: "refresh" },
      { action: "menu" },
    ]);
    // Every entry asks for something a click on the rail can ask for.
    for (const entry of menu) expect(content.hits).toContainEqual(entry.hit);
  });

  it("says in words whether a section opens or closes, and drops the rows a closed section hides", () => {
    const { menu } = menuOf("agents", {
      warnings: false,
      extensions: false,
      status: false,
      actions: false,
    });
    expect(menu.map((entry) => entry.label)).toEqual([
      "Abrir detalles del área",
      "Cambiar modo",
      "Abrir área AGENTS",
      "Abrir área ORCHESTRATION",
      "Abrir área AUTOMATION",
      "Abrir área TOOLS",
      "Abrir área EVERYWHERE",
      "Abrir vista de orquestación",
      "Abrir sección avisos (1)",
      "Abrir sección extensiones (1)",
      "Abrir sección sesión",
      "Abrir sección acciones · AGENTS (4)",
    ]);
  });

  it("skips the rows that carry no action", () => {
    const { content, menu } = menuOf("agents", { status: true });
    const labels = menu.map((entry) => entry.label).join("\n");
    for (const noise of [
      "Proyecto",
      "Modelo:",
      "Runtime",
      "Memoria",
      "ACTIVIDAD",
      "Alt+",
      "Sin eventos",
    ])
      expect(labels).not.toContain(noise);
    // The rows are there in the rail, only without a hit.
    const text = content.lines.map(stripAnsi).join("\n");
    expect(text).toContain("Runtime: idle");
    expect(text).toContain("Alt+K");
  });

  it("keeps the whole label of the long actions and leaves no glyph, key prefix or escape in any label", () => {
    const { menu } = menuOf("orchestration", { status: true, extensions: true });
    const labels = menu.map((entry) => entry.label);
    expect(labels).toContain("Elegir el flujo de trabajo a seguir");
    expect(labels).toContain("Activar demostración (datos de ejemplo)");
    expect(labels).toContain("Cerrar sección orquestación");
    expect(labels).toContain("Abrir vista de orquestación");
    for (const label of labels) {
      expect(label).not.toMatch(/[▼▶↗•◉…]/u);
      expect(label).not.toMatch(/^\[[A-Z]\]/);
      expect(label).not.toContain("\u001b");
      expect(label).toBe(label.trim());
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("speaks English when the console does", () => {
    const { menu } = menuOf("agents", {}, "en");
    expect(menu.map((entry) => entry.label)).toEqual([
      "Open the area details",
      "Change mode",
      "Open area AGENTS",
      "Open area ORCHESTRATION",
      "Open area AUTOMATION",
      "Open area TOOLS",
      "Open area EVERYWHERE",
      "Open orchestration view",
      "Close section warnings (1)",
      "View complete details",
      "Open section extensions (1)",
      "Close section session",
      "Close section actions · AGENTS (4)",
      "Choose Pi model",
      "Tasks by observed agent",
      "Refresh data",
      "Open full /haril menu",
    ]);
  });

  it("offers the five areas and the orchestration view whichever area is open, once each", () => {
    for (const area of ["agents", "orchestration"] as const) {
      const { menu } = menuOf(area, { actions: true });
      const areas = menu.filter((entry) => entry.hit.action === "area");
      expect(
        areas.map((entry) => entry.hit.area),
        area,
      ).toEqual(DASHBOARD_AREAS);
      expect(
        menu.filter((entry) => entry.hit.control === "orchestration-view").map((e) => e.label),
        area,
      ).toEqual(["Abrir vista de orquestación"]);
    }
  });

  it("marks the current area in the rail and names every area, whole, in the menu", () => {
    const rows = renderNativeRailContent(facts(), "tools", MENU_WIDTH, {}).lines.map(stripAnsi);
    expect(rows.some((row) => row.includes("● TOOLS"))).toBe(true);
    for (const other of ["AGENTS", "ORCHESTRATION", "AUTOMATION", "EVERYWHERE"]) {
      expect(
        rows.some((row) => row.includes(`○ ${other}`)),
        other,
      ).toBe(true);
    }
    expect(rows.some((row) => row.includes("ÁREAS"))).toBe(true);
  });

  it("has nothing to offer from an empty rail", () => {
    expect(buildRailMenu({ lines: [], hits: [] })).toEqual([]);
  });
});

describe("the native rail's rows", () => {
  const rows = (area: "agents" | "orchestration", actions = false) =>
    renderNativeRailContent(facts(), area, 39, {}, { actions }).lines.map(stripAnsi);

  it("do not look like keys: the actions carry no [D]-style prefix, since the rail takes no key presses", () => {
    for (const area of ["agents", "orchestration"] as const) {
      const text = rows(area, true);
      expect(text.filter((row) => /[[A-Z]]/.test(row))).toEqual([]);
      expect(text.some((row) => row.includes("Ver detalles completos"))).toBe(true);
      expect(text.some((row) => row.includes("Actualizar datos"))).toBe(true);
    }
  });

  it("leave the actions group to the ACC tab: the rail is the rail with the group minus exactly that group", () => {
    for (const area of ["agents", "orchestration"] as const) {
      for (const expanded of [{}, { actions: false }, { status: true, extensions: true }]) {
        const without = renderNativeRailContent(facts(), area, 39, expanded);
        const withGroup = renderNativeRailContent(facts(), area, 39, expanded, { actions: true });
        const text = without.lines.map(stripAnsi).join("\n");
        expect(text, area).not.toContain("ACCIONES");
        expect(text, area).not.toContain("Abrir menú completo");
        const from = withGroup.lines.findIndex((line) => stripAnsi(line).includes("ACCIONES"));
        expect(from, area).toBeGreaterThan(0);
        // The group is the section row and, when open, the controls and the row of the full menu; the blank row and the
        // two hint rows follow it in both.
        const tail = 3;
        const length = withGroup.lines.length - without.lines.length;
        expect(length, area).toBeGreaterThanOrEqual(1);
        expect(without.lines, area).toEqual([
          ...withGroup.lines.slice(0, from),
          ...withGroup.lines.slice(from + length),
        ]);
        expect(without.hits, area).toEqual([
          ...withGroup.hits.slice(0, from),
          ...withGroup.hits.slice(from + length),
        ]);
        expect(without.lines.slice(-tail).map((line) => stripAnsi(line).trim())).toEqual([
          "",
          "Alt+K menú del panel · Alt+H áreas",
          "Alt+I panel · Alt+C comandos",
        ]);
      }
    }
  });

  it("keep listing the area's actions in the menu whichever area is open, with the labels and hits they always had", () => {
    for (const area of ["agents", "orchestration", "automation", "tools", "everywhere"] as const) {
      const content = renderNativeRailContent(facts(), area, MENU_WIDTH, {}, { actions: true });
      const menu = buildRailMenu(content, "es");
      const runs = menu.filter((entry) => entry.hit.action === "run");
      expect(runs.length, area).toBeGreaterThan(1);
      expect(
        menu.some(
          (entry) => entry.hit.action === "menu" && entry.label === "Abrir menú completo /haril",
        ),
        area,
      ).toBe(true);
      // Every entry is a row of the rail with that very hit.
      for (const entry of menu) expect(content.hits, area).toContainEqual(entry.hit);
    }
  });

  it("name Alt+K in the footer hint, whole, next to the other hints", () => {
    const text = rows("agents");
    const hints = text.slice(-2).map((row) => row.trim());
    expect(hints).toEqual(["Alt+K menú del panel · Alt+H áreas", "Alt+I panel · Alt+C comandos"]);
    for (const row of text.slice(-2)) expect(textWidth(row)).toBe(39);
  });

  it("no longer list the recent events: they live in the ACT tab, and MAIN keeps only the two hint rows", () => {
    const withEvents: DashboardFacts = {
      ...facts(),
      data: {
        ...emptyDashboardData("fake-project"),
        events: [
          {
            seq: 373,
            time: "2026-10-30T20:00:00.000Z",
            type: "workflow.failed",
            aggregateType: "workflow",
            aggregateId: "w1",
            taskId: null,
          },
          {
            seq: 374,
            time: "2026-10-30T20:01:00.000Z",
            type: "task.cancelled",
            aggregateType: "task",
            aggregateId: "t1",
            taskId: "t1",
          },
        ],
      },
    };
    for (const area of ["agents", "orchestration"] as const) {
      const content = renderNativeRailContent(withEvents, area, 39, {});
      const text = content.lines.map(stripAnsi).join(" | ");
      expect(text, area).not.toContain("ACTIVIDAD RECIENTE");
      expect(text, area).not.toContain("Sin eventos registrados");
      expect(text, area).not.toContain("workflow.failed");
      expect(text, area).not.toContain("#374");
      // The two hint rows are the last two, after one blank row, and carry no action.
      const rows = content.lines.map(stripAnsi);
      expect(
        rows.slice(-2).map((row) => row.trim()),
        area,
      ).toEqual(["Alt+K menú del panel · Alt+H áreas", "Alt+I panel · Alt+C comandos"]);
      expect(rows.at(-3)?.trim(), area).toBe("");
      expect(content.hits.slice(-3), area).toEqual([undefined, undefined, undefined]);
      expect(content.hits).toHaveLength(content.lines.length);
    }
  });
});

const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type Mount = (tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent;

interface Menu {
  readonly title: string;
  readonly options: readonly string[];
}

interface Harness {
  readonly ctx: ConsoleContext;
  readonly menus: Menu[];
  readonly customs: () => number;
  // What the select returns, set per test from the options it was given.
  answer: (menu: Menu) => string | undefined;
  // The text of the first row of the native right pane that holds `needle`.
  row(needle: string): string | undefined;
  pressShortcut(): void;
  openWithShortcut(): Promise<void>;
  openWithCommand(): Promise<void>;
}

interface ConsoleOptions {
  // False leaves the native panes unmounted: only the classic header could be on screen.
  readonly panes?: boolean;
  // The terminal's width: the panes are drawn from 132 columns.
  readonly columns?: number;
}

// Starts the console on a fake Pi with no HARIL CLI and the native right pane mounted, so a test sees the pane change.
async function withConsole(
  run: (harness: Harness) => Promise<void>,
  options: ConsoleOptions = {},
): Promise<void> {
  const envNode = process.env.HARIL_NODE;
  const envCli = process.env.HARIL_CLI;
  delete process.env.HARIL_NODE;
  delete process.env.HARIL_CLI;
  const fake = fakePi();
  const ctx = fakeContext();
  const menus: Menu[] = [];
  let customs = 0;
  let anchor: Mount | undefined;
  let right: ConsoleComponent | undefined;
  const harness: Harness = {
    ctx,
    menus,
    customs: () => customs,
    answer: () => undefined,
    row: (needle) =>
      right
        ?.render(40)
        .map(stripAnsi)
        .find((line) => line.includes(needle)),
    pressShortcut: () => fake.shortcuts.get("alt+k")?.(ctx),
    async openWithShortcut() {
      const before = menus.length;
      harness.pressShortcut();
      await vi.waitFor(() => expect(menus.length).toBeGreaterThan(before));
    },
    async openWithCommand() {
      await fake.commands.get("haril-panel")?.handler("", ctx);
    },
  };
  Object.assign(ctx.ui, {
    select: async (title: string, options: string[]) => {
      const menu = { title, options };
      menus.push(menu);
      return harness.answer(menu);
    },
    custom: async () => {
      customs++;
      return undefined;
    },
    setWidget(key: string, value: Mount) {
      if (key === "haril-native-panes-anchor") anchor = value;
    },
  });
  try {
    harilConsole(fake.pi);
    await fake.fire("session_start", { reason: "startup" }, ctx);
    if (!anchor) throw new Error("Expected the console to mount its native panes");
    if (options.panes !== false) {
      const root = {
        render: () => ["Pi chat"],
        invalidate: () => undefined,
        [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
      };
      const tui = {
        layoutRoot: root,
        terminal: { columns: options.columns ?? 160, rows: 45 },
        requestRender: vi.fn(),
      };
      anchor(tui, THEME);
      const layout = (root[LAYOUT_NODE] as () => { entries: { component: ConsoleComponent }[] })();
      // Below 132 columns the layout is left as Pi made it: there is no pane to read.
      right = layout.entries[1]?.component;
      if (!right && (options.columns ?? 160) >= 132) throw new Error("Expected the right pane");
    }
    await run(harness);
    await fake.fire("session_shutdown", {}, ctx);
    expect(fake.shortcuts.has("alt+k")).toBe(true);
    expect(fake.commands.has("haril-panel")).toBe(true);
  } finally {
    if (envNode === undefined) delete process.env.HARIL_NODE;
    else process.env.HARIL_NODE = envNode;
    if (envCli === undefined) delete process.env.HARIL_CLI;
    else process.env.HARIL_CLI = envCli;
  }
}

const choose = (prefix: RegExp | string) => (menu: Menu) =>
  menu.options.find((option) =>
    typeof prefix === "string" ? option === prefix : prefix.test(option),
  );

describe.each([
  ["Alt+K", (harness: Harness) => harness.openWithShortcut()],
  ["/haril-panel", (harness: Harness) => harness.openWithCommand()],
] as const)("%s opens the keyboard menu of the right panel", (_name, open) => {
  it("titles it «Panel derecho» and offers the rail's actions", async () => {
    await withConsole(async (harness) => {
      await open(harness);
      expect(harness.menus).toHaveLength(1);
      const [menu] = harness.menus;
      expect(menu?.title).toBe("Panel derecho");
      expect(menu?.options).toEqual(
        expect.arrayContaining([
          "Cambiar modo",
          "Ver detalles completos",
          "Elegir modelo de Pi",
          "Abrir menú completo /haril",
        ]),
      );
      expect(menu?.options.some((option) => /^Cerrar sección avisos \(\d+\)$/.test(option))).toBe(
        false,
      );
    });
  });

  it("toggles a section exactly like a click on its header", async () => {
    await withConsole(async (harness) => {
      // SESIÓN is the section MAIN always draws (AVISOS only appears with a warning), open by default.
      expect(harness.row("SESIÓN")).toContain("▼");
      harness.answer = choose(/^Cerrar sección sesión/);
      await open(harness);
      await vi.waitFor(() => expect(harness.row("SESIÓN")).toContain("▶"));
      // The menu now offers the opposite move.
      harness.answer = choose(/^Abrir sección sesión/);
      await open(harness);
      await vi.waitFor(() => expect(harness.row("SESIÓN")).toContain("▼"));
    });
  });

  it("opens the mode selector when «Cambiar modo» is chosen", async () => {
    await withConsole(async (harness) => {
      harness.answer = (menu) => (menu.title === "Panel derecho" ? "Cambiar modo" : undefined);
      await open(harness);
      await vi.waitFor(() => expect(harness.menus).toHaveLength(2));
      expect(harness.menus[1]?.title).toMatch(/^Console mode/);
    });
  });

  it("opens the dashboard action when an action is chosen", async () => {
    await withConsole(async (harness) => {
      harness.answer = choose("Ver detalles completos");
      await open(harness);
      await vi.waitFor(() => expect(harness.customs()).toBe(1));
    });
  });

  it("does nothing when the menu is cancelled", async () => {
    await withConsole(async (harness) => {
      harness.answer = () => undefined;
      await open(harness);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.menus).toHaveLength(1);
      expect(harness.customs()).toBe(0);
      expect(harness.row("AVISOS")).toContain("▼");
    });
  });
});

describe("the «acciones» section in the keyboard menu", () => {
  // Only the classic header draws that section (the native panes leave the actions to the ACC tab), so a menu entry
  // that opens or closes it would do nothing the user could see. Everything else in the menu is the same in both.
  const ACTIONS = /sección acciones/;

  it("is not offered while the native panes are on screen", async () => {
    await withConsole(async (harness) => {
      await harness.openWithShortcut();
      const [menu] = harness.menus;
      expect(menu?.options.filter((option) => ACTIONS.test(option))).toEqual([]);
      // The actions themselves are still in the menu, and so is every section that is drawn.
      expect(menu?.options).toEqual(
        expect.arrayContaining([
          "Elegir modelo de Pi",
          "Abrir menú completo /haril",
          "Cerrar sección sesión",
        ]),
      );
    });
  });

  it("is offered when the classic header is the one on screen", async () => {
    await withConsole(
      async (harness) => {
        await harness.openWithShortcut();
        const labels = harness.menus[0]?.options ?? [];
        expect(labels.filter((option) => ACTIONS.test(option))).toEqual([
          expect.stringMatching(/^Cerrar sección acciones · [A-Z]+ \(\d+\)$/),
        ]);
      },
      { panes: false },
    );
  });

  it("is offered on a terminal too narrow for the panes, where the header is drawn again", async () => {
    await withConsole(
      async (harness) => {
        await harness.openWithShortcut();
        const labels = harness.menus[0]?.options ?? [];
        expect(labels.some((option) => ACTIONS.test(option))).toBe(true);
      },
      { columns: 120 },
    );
  });

  it("keeps every other entry, label and order, in the panes and in the header", async () => {
    const menus: string[][] = [];
    for (const options of [{ panes: false }, {}]) {
      await withConsole(async (harness) => {
        await harness.openWithShortcut();
        menus.push([...(harness.menus[0]?.options ?? [])]);
      }, options);
    }
    const [classic = [], native = []] = menus;
    // With the panes drawn, the menu offers no section the panel does not draw.
    const hidden = (option: string) =>
      ACTIONS.test(option) || /sección (extensiones|avisos)/.test(option);
    expect(classic.filter((option) => !hidden(option))).toEqual(native);
    expect(classic.length).toBeGreaterThan(native.length);
  });
});

describe("the keyboard menu outside an interactive session", () => {
  it("stays closed without a TUI", async () => {
    await withConsole(async (harness) => {
      Object.assign(harness.ctx, { hasUI: false });
      await harness.openWithCommand();
      harness.pressShortcut();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(harness.menus).toHaveLength(0);
    });
  });
});
