import { describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import {
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
// output of renderNativeRailContent and drive the console's entry points with a fake Pi.

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
  const content = renderNativeRailContent(facts(locale), area, MENU_WIDTH, expanded);
  return { content, menu: buildRailMenu(content, locale) };
}

describe("buildRailMenu", () => {
  it("offers one entry per distinct action, in rail order, with readable labels", () => {
    const { content, menu } = menuOf("agents", { extensions: true });
    expect(menu.map((entry) => entry.label)).toEqual([
      "Abrir detalles del área",
      "Cambiar modo",
      "Cerrar sección avisos (1)",
      "Ver detalles completos",
      "Cerrar sección extensiones (1)",
      "Abrir sección sesión",
      "Cerrar sección acciones · AGENTS (4)",
      "Elegir modelo de Pi",
      "Tareas por agente observado",
      "Actualizar datos",
      "Abrir menú completo /haril",
    ]);
    expect(menu.map((entry) => entry.hit)).toEqual([
      { action: "focus" },
      { action: "mode" },
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
    const { menu } = menuOf("agents", { warnings: false, extensions: false, actions: false });
    expect(menu.map((entry) => entry.label)).toEqual([
      "Abrir detalles del área",
      "Cambiar modo",
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
      "Close section warnings (1)",
      "View complete details",
      "Open section extensions (1)",
      "Open section session",
      "Close section actions · AGENTS (4)",
      "Choose Pi model",
      "Tasks by observed agent",
      "Refresh data",
      "Open full /haril menu",
    ]);
  });

  it("has nothing to offer from an empty rail", () => {
    expect(buildRailMenu({ lines: [], hits: [] })).toEqual([]);
  });
});

describe("the native rail's rows", () => {
  const rows = (area: "agents" | "orchestration") =>
    renderNativeRailContent(facts(), area, 39, {}).lines.map(stripAnsi);

  it("do not look like keys: the actions carry no [D]-style prefix, since the rail takes no key presses", () => {
    for (const area of ["agents", "orchestration"] as const) {
      const text = rows(area);
      expect(text.filter((row) => /[[A-Z]]/.test(row))).toEqual([]);
      expect(text.some((row) => row.includes("Ver detalles completos"))).toBe(true);
      expect(text.some((row) => row.includes("Actualizar datos"))).toBe(true);
    }
  });

  it("name Alt+K in the footer hint, whole, next to the other hints", () => {
    const text = rows("agents");
    const hints = text.slice(-2).map((row) => row.trim());
    expect(hints).toEqual(["Alt+K menú del panel · Alt+H áreas", "Alt+I panel · Alt+C comandos"]);
    for (const row of text.slice(-2)) expect(textWidth(row)).toBe(39);
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

// Starts the console on a fake Pi with no HARIL CLI and the native right pane mounted, so a test sees the pane change.
async function withConsole(run: (harness: Harness) => Promise<void>): Promise<void> {
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
    const root = {
      render: () => ["Pi chat"],
      invalidate: () => undefined,
      [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
    };
    const tui = { layoutRoot: root, terminal: { columns: 160, rows: 45 }, requestRender: vi.fn() };
    anchor(tui, THEME);
    const layout = (root[LAYOUT_NODE] as () => { entries: { component: ConsoleComponent }[] })();
    right = layout.entries[1]?.component;
    if (!right) throw new Error("Expected the right pane");
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
        true,
      );
    });
  });

  it("toggles a section exactly like a click on its header", async () => {
    await withConsole(async (harness) => {
      expect(harness.row("AVISOS")).toContain("▼");
      harness.answer = choose(/^Cerrar sección avisos/);
      await open(harness);
      await vi.waitFor(() => expect(harness.row("AVISOS")).toContain("▶"));
      // The menu now offers the opposite move.
      harness.answer = choose(/^Abrir sección avisos/);
      await open(harness);
      await vi.waitFor(() => expect(harness.row("AVISOS")).toContain("▼"));
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
