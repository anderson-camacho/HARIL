import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionHit, actionsRows } from "../src/actions-view.js";
import harilConsole from "../src/console.js";
import {
  areaName,
  DASHBOARD_AREAS,
  type DashboardArea,
  type DashboardFacts,
  openMenuLabel,
  railControls,
  renderHeaderLayout,
  renderNativeRailContent,
} from "../src/dashboard.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import { actionsDetails, loadDockDetails } from "../src/dock-details.js";
import type { UiLocale } from "../src/locale.js";
import { attachNativePanes, initialPaneSettings } from "../src/native-panes.js";
import { initialOrchestrationState } from "../src/orchestration-state.js";
import type { ConsoleContext, ConsoleTheme, ConsoleTui } from "../src/pi-types.js";
import { CARD_TEXT_X, RAIL_BODY_WIDTH, RAIL_WIDTH } from "../src/rail-metrics.js";
import { railRows } from "../src/rail-view.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

// The ACC tab of the right panel: the actions of the area chosen in MAIN, one bordered button for each. The view is
// built from the same controls the MAIN rail used to list under ACCIONES, so a click on a button must do what a click on
// that row did. These tests drive the real view, the real native pane and the real console with a fake Pi. The Pi TUI
// itself (real mouse delivery, repainting) is not exercised here.

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };
const waitFor = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: 15_000, interval: 25 });

interface Pane {
  render(width: number): string[];
  handleMouse?(event: {
    type: string;
    button: string;
    x: number;
    y: number;
    wheelDelta?: number;
  }): unknown;
}

function facts(locale: UiLocale = "es", registered = true): DashboardFacts {
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
    extensionStatuses: [],
    providerWarnings: [],
    mode: "ACTION",
    memory: "not loaded",
    data: registered ? emptyDashboardData("fake-project") : emptyDashboardData(),
    loading: false,
    orchestration: initialOrchestrationState(),
    asciiGlyphs: false,
  };
}

const inputOf = (area: DashboardArea, locale: UiLocale = "es", registered = true) => ({
  area,
  controls: railControls(facts(locale, registered), area),
  locale,
});

// The buttons of a view in order: the words on each and the id it runs.
function buttonsOf(details: ReturnType<typeof actionsDetails>) {
  return (details.cards ?? []).flatMap((card) => card.buttons ?? []);
}

describe("the ACC view", () => {
  it("is a header card with the chosen area and an Acciones card with one button for each control and the full menu", () => {
    const details = actionsDetails(inputOf("agents"));
    expect(details.id).toBe("actions");
    expect(details.title).toBe("Acciones");
    expect(details.status).toBe("Acciones del área elegida");
    const [header, actions] = details.cards ?? [];
    expect(header?.title).toBe("Acciones · AGENTS");
    expect(header?.rows.join(" ")).toBe("Área elegida en MAIN: AGENTS. Cámbiala allí.");
    expect(header?.tones?.every((tone) => tone === "muted")).toBe(true);
    expect(header?.buttons).toBeUndefined();
    expect(actions?.title).toBe("Acciones");
    expect(actions?.buttons?.map((button) => button.label)).toEqual([
      "Ver detalles completos",
      "Elegir modelo de Pi",
      "Tareas por agente observado",
      "Actualizar datos",
      "Abrir menú completo /haril",
    ]);
    // Every row of the header card fits the content width of a card.
    for (const row of header?.rows ?? []) expect(textWidth(row)).toBeLessThanOrEqual(33);
  });

  it("speaks English when the interface does", () => {
    const details = actionsDetails(inputOf("agents", "en"));
    expect(details.status).toBe("Actions of the chosen area");
    expect(details.cards?.[0]?.title).toBe("Actions · AGENTS");
    expect(details.cards?.[0]?.rows.join(" ")).toBe(
      "Area chosen in MAIN: AGENTS. Change it there.",
    );
    expect(details.cards?.[1]?.title).toBe("Actions");
    expect(buttonsOf(details).map((button) => button.label)).toEqual([
      "View complete details",
      "Choose Pi model",
      "Tasks by observed agent",
      "Refresh data",
      "Open full /haril menu",
    ]);
  });

  it("changes with the area, as the group in MAIN did, and with whether the folder is a registered project", () => {
    const labels = (area: DashboardArea, registered = true) =>
      buttonsOf(actionsDetails(inputOf(area, "es", registered))).map((button) => button.label);
    expect(labels("tools")).toEqual([
      "Ver detalles completos",
      "Modelo y nivel",
      "Ajustes de delegación",
      "Activar o desactivar herramientas de Pi",
      "Explorar metodologías de HARIL",
      "Explorar comandos de HARIL",
      "Registro de actividad reciente",
      "Actualizar datos",
      "Abrir menú completo /haril",
    ]);
    expect(labels("orchestration")).toContain("Elegir el flujo de trabajo a seguir");
    expect(labels("orchestration")).toContain("Revisar aprobaciones (0)");
    expect(labels("agents", false)[0]).toBe("Registrar esta carpeta");
    expect(labels("agents", false)).not.toContain("Tareas por agente observado");
    expect(labels("everywhere")).toEqual([
      "Ver detalles completos",
      "Registro de actividad reciente",
      "Mostrar estado de la memoria registrada",
      "Actualizar datos",
      "Abrir menú completo /haril",
    ]);
    // Always the same last button, whichever the area.
    for (const area of DASHBOARD_AREAS)
      expect(labels(area).at(-1)).toBe("Abrir menú completo /haril");
  });

  it("says so when the area has no actions, and still offers the complete menu", () => {
    for (const locale of ["es", "en"] as const) {
      const rows = actionsRows({ area: "automation", controls: [], locale });
      expect(rows.cards[1]?.rows).toEqual([
        locale === "es" ? "Esta área no tiene acciones." : "This area has no actions.",
      ]);
      expect(rows.cards[1]?.tones).toEqual(["muted"]);
      expect(rows.cards[1]?.buttons?.map((button) => button.label)).toEqual([
        openMenuLabel(locale),
      ]);
      expect(actionHit(rows.cards[1]?.buttons?.[0]?.action ?? "", [])).toEqual({ action: "menu" });
    }
  });

  it("is what loadDockDetails gives for ACC when it is handed the area, and an empty view when it is not", async () => {
    const input = inputOf("tools");
    expect(await loadDockDetails("actions", ".", { actions: input })).toEqual(
      actionsDetails(input),
    );
    const bare = await loadDockDetails("actions", ".", {});
    expect(bare).toMatchObject({ id: "actions", title: "Acciones", lines: [] });
  });

  it("keeps the flat form for the left dock: the title, the note and a pointer in front of each button", () => {
    const details = actionsDetails(inputOf("agents"));
    expect(details.lines[0]).toBe("Acciones · AGENTS");
    expect(details.lines).toContain("▸ Ver detalles completos");
    expect(details.lines).toContain("▸ Abrir menú completo /haril");
    expect(details.actions?.map((action) => action.label)).toEqual(
      buttonsOf(details).map((button) => button.label),
    );
  });
});

describe("what a button runs", () => {
  it("is the hit the old MAIN row carried, for every area, language and project, in the same order", () => {
    for (const registered of [true, false]) {
      for (const locale of ["es", "en"] as const) {
        for (const area of DASHBOARD_AREAS) {
          const f = facts(locale, registered);
          const label = `${locale}/${area}/${registered ? "project" : "no project"}`;
          // The rail as it was: the group under ACCIONES, each row with its hit.
          const old = renderNativeRailContent(f, area, 120, {}, { actions: true });
          const start = old.lines.findIndex((line) => /ACCIONES|ACTIONS/u.test(stripAnsi(line)));
          expect(start, label).toBeGreaterThan(0);
          const oldRows = old.lines
            .map((line, index) => ({
              label: stripAnsi(line).trim().replace(/^↗\s*/u, ""),
              hit: old.hits[index],
              index,
            }))
            .filter((row) => row.index > start && row.hit !== undefined);
          const details = actionsDetails(inputOf(area, locale, registered));
          const controls = railControls(f, area);
          const buttons = buttonsOf(details);
          expect(
            buttons.map((button) => button.label),
            label,
          ).toEqual(oldRows.map((row) => row.label));
          expect(
            buttons.map((button) => actionHit(button.action, controls)),
            label,
          ).toEqual(oldRows.map((row) => row.hit));
        }
      }
    }
  });

  it("is read back against the controls the area has now: a stale id runs nothing", () => {
    const agents = railControls(facts(), "agents");
    const tools = railControls(facts(), "tools");
    const tasks = buttonsOf(actionsDetails(inputOf("agents"))).find(
      (button) => button.label === "Tareas por agente observado",
    );
    expect(tasks?.action).toBe("actions:run:tasks");
    expect(actionHit("actions:run:tasks", agents)).toEqual({ action: "run", control: "tasks" });
    expect(actionHit("actions:run:tasks", tools)).toBeUndefined();
    expect(actionHit("actions:run:nonsense", agents)).toBeUndefined();
    expect(actionHit("tools:update", agents)).toBeUndefined();
    expect(actionHit("actions:menu", [])).toEqual({ action: "menu" });
  });
});

describe("the ACC view in the rail", () => {
  it.each(
    DASHBOARD_AREAS.flatMap((area) =>
      [false, true].flatMap((ascii) =>
        (["es", "en"] as const).map((locale) => [area, ascii, locale] as const),
      ),
    ),
  )(
    "%s · ascii=%s · %s: every row is the rail's width, and a button runs from each of its rows",
    (area, ascii, locale) => {
      const details = actionsDetails(inputOf(area, locale));
      const drawn = railRows(details, ascii);
      expect(drawn.hits).toHaveLength(drawn.rows.length);
      for (const row of drawn.rows) expect(textWidth(stripAnsi(row))).toBe(RAIL_BODY_WIDTH);
      const text = drawn.rows.map(stripAnsi).join("\n");
      if (ascii) expect(text).not.toMatch(/[╭╮╰╯─│▸]/u);
      else expect(text).toContain(locale === "es" ? "╭─ Acciones" : "╭─ Actions");
      const buttons = buttonsOf(details);
      for (const button of buttons) {
        // A button is three rows, or four when its label needs a second one; every one of them carries the id.
        const rowsOfButton = drawn.hits.filter((hit) => hit === button.action);
        expect([button.label, rowsOfButton.length >= 3 && rowsOfButton.length <= 4]).toEqual([
          button.label,
          true,
        ]);
      }
      // The header card runs nothing.
      const note = drawn.rows.findIndex((row) => stripAnsi(row).includes(areaName(area)));
      expect(drawn.hits[note]).toBeUndefined();
      expect(drawn.hits.filter((hit) => hit !== undefined).length).toBeGreaterThanOrEqual(
        buttons.length * 3,
      );
    },
  );

  it("shows a long label whole on two rows instead of cutting it", () => {
    const rows = railRows(actionsDetails(inputOf("orchestration")), false).rows.map(stripAnsi);
    const text = rows.join("\n");
    expect(text).toContain("▸ Elegir el flujo de trabajo");
    expect(text).toMatch(/│ {3}a seguir {20,}│/u);
    expect(text).not.toContain("…");
    // Spanish and English labels alike: nothing of any area is cut.
    for (const area of DASHBOARD_AREAS) {
      for (const locale of ["es", "en"] as const) {
        const view = railRows(actionsDetails(inputOf(area, locale)), false).rows.map(stripAnsi);
        expect(view.join("\n"), `${area}/${locale}`).not.toContain("…");
      }
    }
  });
});

describe("the native pane on the ACC tab", () => {
  function mountPane(
    area: () => { area: DashboardArea; locale: UiLocale },
    options: { readonly ascii?: boolean; readonly rows?: number } = {},
  ) {
    const root = {
      render: vi.fn(() => ["Pi chat"]),
      invalidate: vi.fn(),
      [LAYOUT_NODE]: (() => ({ type: "vstack", entries: [], gap: 0, align: "stretch" })) as unknown,
    };
    const tui = {
      terminal: { columns: 160, rows: options.rows ?? 60 },
      requestRender: vi.fn(),
      layoutRoot: root,
      chatContainer: { invalidate: vi.fn() },
    };
    const state = { ...initialPaneSettings(), selected: "actions" as const };
    const activate = vi.fn();
    const select = vi.fn();
    const live = vi.fn((id: string) => {
      const chosen = area();
      return id === "actions"
        ? actionsDetails({
            area: chosen.area,
            controls: railControls(facts(chosen.locale), chosen.area),
            locale: chosen.locale,
          })
        : undefined;
    });
    attachNativePanes(tui, state, {
      project: () => "repo",
      ascii: () => options.ascii ?? false,
      locale: () => area().locale,
      right: () => ({ lines: [], hits: [] }),
      select,
      activate,
      live,
    });
    const layout = (root[LAYOUT_NODE] as () => { entries: { component: Pane }[] })();
    const pane = layout.entries.at(-1)?.component;
    if (!pane) throw new Error("Expected the right pane");
    const rows = () => pane.render(RAIL_WIDTH).map(stripAnsi);
    const click = (y: number, x = 8) => pane.handleMouse?.({ type: "click", button: "left", x, y });
    return { pane, rows, click, state, activate, select, live };
  }

  it("draws the tab with its header box, the status line and the two cards, every row 40 columns", () => {
    const { rows, state } = mountPane(() => ({ area: "agents", locale: "es" }));
    const view = rows();
    expect(view).toHaveLength(60);
    for (const row of view) expect(textWidth(row)).toBe(RAIL_WIDTH);
    expect(view[1]).toContain("▼ Espacio: Acciones · Alt+L");
    expect(view[2]).toContain("1:MAIN");
    expect(view[3]).toContain("[5:ACC]");
    expect(view[5]).toContain("Acciones del área elegida");
    expect(view.join("\n")).toContain("╭─ Acciones · AGENTS ");
    expect(view.join("\n")).toContain("╭─ Acciones ──");
    expect(state.detail?.id).toBe("actions");
  });

  it("follows the area on every frame, and keeps the same view object while nothing changes", () => {
    let chosen: { area: DashboardArea; locale: UiLocale } = { area: "agents", locale: "es" };
    const { rows, state, pane } = mountPane(() => chosen);
    expect(rows().join("\n")).toContain("Acciones · AGENTS");
    const first = state.detail;
    rows();
    expect(state.detail).toBe(first);
    chosen = { area: "tools", locale: "es" };
    const view = rows().join("\n");
    expect(view).toContain("Acciones · TOOLS");
    expect(view).toContain("Modelo y nivel");
    expect(view).not.toContain("Tareas por agente observado");
    expect(state.detail).not.toBe(first);
    // The language follows too.
    chosen = { area: "tools", locale: "en" };
    expect(rows().join("\n")).toContain("Actions · TOOLS");
    // A click is looked up in the view as it is now, not in the one drawn before.
    chosen = { area: "everywhere", locale: "es" };
    const target = rows().findIndex((row) => row.includes("▸ Mostrar estado de la"));
    expect(target).toBeGreaterThan(0);
    expect(pane.handleMouse?.({ type: "click", button: "left", x: 8, y: target })).toEqual({
      handled: true,
      render: true,
    });
  });

  it("runs a button from each of its rows and from no other row", () => {
    const { rows, click, activate } = mountPane(() => ({ area: "agents", locale: "es" }));
    const expected: [string, string][] = [
      ["Ver detalles completos", "actions:run:details"],
      ["Elegir modelo de Pi", "actions:run:model"],
      ["Tareas por agente observado", "actions:run:tasks"],
      ["Actualizar datos", "actions:run:refresh"],
      ["Abrir menú completo /haril", "actions:menu"],
    ];
    for (const [label, id] of expected) {
      const y = rows().findIndex((row) => row.includes(`▸ ${label}`));
      expect(y, label).toBeGreaterThan(0);
      for (const offset of [-1, 0, 1]) {
        activate.mockClear();
        expect([label, offset, click(y + offset)]).toEqual([
          label,
          offset,
          { handled: true, render: true },
        ]);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledWith("actions", id);
      }
    }
    // The header card, its note and the Acciones card's top border run nothing.
    activate.mockClear();
    const top = rows().findIndex((row) => row.includes("╭─ Acciones ──"));
    for (let y = 6; y <= top; y++) {
      for (const x of [2, 8, 30]) expect([y, x, click(y, x)]).toEqual([y, x, undefined]);
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it("hits the ACC tab on the second row of the header box, on its own columns only", () => {
    const { rows, click, select } = mountPane(() => ({ area: "agents", locale: "es" }));
    // The tab is drawn as "[5:ACC]" under the first row's text, right after the box's border and padding.
    expect(rows()[3]?.indexOf("[5:ACC]")).toBe(CARD_TEXT_X);
    for (const x of [CARD_TEXT_X, CARD_TEXT_X + 3, CARD_TEXT_X + 6]) {
      select.mockClear();
      expect(click(3, x)).toEqual({ handled: true, render: true });
      expect(select).toHaveBeenCalledWith("actions");
    }
    select.mockClear();
    expect(click(3, CARD_TEXT_X + 7)).toBeUndefined();
    expect(click(3, CARD_TEXT_X - 1)).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("works in ASCII with the same hits", () => {
    const { rows, click, activate } = mountPane(() => ({ area: "agents", locale: "en" }), {
      ascii: true,
    });
    const view = rows();
    for (const row of view) expect(textWidth(row)).toBe(RAIL_WIDTH);
    expect(view.join("\n")).not.toMatch(/[╭╮╰╯─│▸▼▶▣]/u);
    const y = view.findIndex((row) => row.includes("> Choose Pi model"));
    expect(y).toBeGreaterThan(0);
    click(y + 1);
    expect(activate).toHaveBeenCalledWith("actions", "actions:run:model");
  });

  it("scrolls with the wheel when the buttons are taller than the terminal, and a click maps to the row drawn", () => {
    const { rows, click, activate, pane } = mountPane(
      () => ({ area: "orchestration", locale: "es" }),
      { rows: 30 },
    );
    expect(rows().join("\n")).not.toContain("▸ Actualizar datos");
    pane.handleMouse?.({ type: "wheel", button: "none", x: 8, y: 8, wheelDelta: 100 } as never);
    const y = rows().findIndex((row) => row.includes("▸ Actualizar datos"));
    expect(y).toBeGreaterThan(0);
    click(y);
    expect(activate).toHaveBeenCalledWith("actions", "actions:run:refresh");
  });
});

describe("the header and the keyboard menu keep their actions", () => {
  it("the classic header still lists the group, with the [K] prefixes, and its rows keep their hits", () => {
    const layout = renderHeaderLayout("0.0.0", 160, facts(), "agents", THEME, 45);
    const text = layout.lines.map(stripAnsi).join("\n");
    expect(text).toContain("ACCIONES · AGENTS");
    for (const label of [
      "[D] Ver detalles completos",
      "[M] Elegir modelo de Pi",
      "[T] Tareas por agente observado",
      "[R] Actualizar datos",
      "↗ Abrir menú completo /haril",
    ]) {
      expect(text, label).toContain(label);
    }
    const hits = (layout.railHits ?? []).map((hit) => [hit.action, hit.control ?? null]);
    expect(hits).toContainEqual(["run", "details"]);
    expect(hits).toContainEqual(["run", "model"]);
    expect(hits).toContainEqual(["run", "tasks"]);
    expect(hits).toContainEqual(["run", "refresh"]);
    expect(hits).toContainEqual(["menu", null]);
  });
});

// The console: a real HARIL console on a fake Pi with no HARIL CLI, and the native right pane mounted.
interface Harness {
  readonly ctx: ConsoleContext;
  readonly fake: ReturnType<typeof fakePi>;
  readonly selects: { title: string; options: string[] }[];
  readonly customs: () => number;
  rows(): string[];
  text(): string;
  clickRow(needle: string, offset?: number): unknown;
  command(name: string, args: string): Promise<void>;
  pickArea(area: DashboardArea): Promise<void>;
  answer: (menu: { title: string; options: string[] }) => string | undefined;
}

let savedEnv: { node: string | undefined; cli: string | undefined; ascii: string | undefined };

beforeEach(() => {
  savedEnv = {
    node: process.env.HARIL_NODE,
    cli: process.env.HARIL_CLI,
    ascii: process.env.HARIL_CONSOLE_ASCII,
  };
  delete process.env.HARIL_NODE;
  delete process.env.HARIL_CLI;
  delete process.env.HARIL_CONSOLE_ASCII;
});

afterEach(() => {
  for (const [key, value] of [
    ["HARIL_NODE", savedEnv.node],
    ["HARIL_CLI", savedEnv.cli],
    ["HARIL_CONSOLE_ASCII", savedEnv.ascii],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function withConsole(run: (harness: Harness) => Promise<void>): Promise<void> {
  const fake = fakePi();
  const ctx = fakeContext();
  const selects: { title: string; options: string[] }[] = [];
  let customs = 0;
  let nextArea: DashboardArea | undefined;
  let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => unknown) | undefined;
  const harness: Harness = {
    ctx,
    fake,
    selects,
    customs: () => customs,
    rows: () => [],
    text: () => "",
    clickRow: () => undefined,
    command: (name, args) => fake.commands.get(name)?.handler(args, ctx) ?? Promise.resolve(),
    async pickArea(area) {
      nextArea = area;
      fake.shortcuts.get("alt+h")?.(ctx);
      await waitFor(() => expect(nextArea).toBeUndefined());
    },
    answer: () => undefined,
  };
  Object.assign(ctx.ui, {
    select: async (title: string, options: string[]) => {
      const menu = { title, options };
      selects.push(menu);
      return harness.answer(menu);
    },
    custom: async () => {
      customs++;
      const area = nextArea;
      nextArea = undefined;
      return area === undefined ? undefined : { type: "open", area };
    },
    setWidget(key: string, value: typeof anchor) {
      if (key === "haril-native-panes-anchor") anchor = value;
    },
  });
  harilConsole(fake.pi);
  await fake.fire("session_start", { reason: "startup" }, ctx);
  if (!anchor) throw new Error("Expected the console to install its UI");
  const layoutRoot = {
    render: () => ["Pi chat"],
    invalidate: () => undefined,
    [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
  };
  const tui = { layoutRoot, terminal: { columns: 160, rows: 60 }, requestRender: vi.fn() };
  anchor(tui, THEME);
  const layout = (layoutRoot[LAYOUT_NODE] as () => { entries: { component: Pane }[] })();
  const pane = layout.entries.at(-1)?.component;
  if (!pane) throw new Error("Expected the right pane");
  const rows = () => pane.render(RAIL_WIDTH).map(stripAnsi);
  Object.assign(harness, {
    rows,
    text: () => rows().join("\n"),
    clickRow(needle: string, offset = 0) {
      const y = rows().findIndex((row) => row.includes(needle));
      if (y < 0) throw new Error(`Row not found: ${needle}\n${rows().join("\n")}`);
      return pane.handleMouse?.({ type: "click", button: "left", x: 8, y: y + offset });
    },
  });
  try {
    await run(harness);
  } finally {
    await fake.fire("session_shutdown", {}, ctx);
  }
}

describe("the ACC tab in the console", () => {
  // The console opens on AGENTS (session start), and no HARIL CLI is here, so the folder is not a registered project.
  it("opens with /haril-plugin actions, as the fifth tab, with the controls of the area MAIN has chosen", async () => {
    await withConsole(async (h) => {
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("[5:ACC]"));
      const view = h.text();
      expect(view).toContain("Espacio: Acciones");
      expect(view).toContain("╭─ Acciones · AGENTS ");
      expect(view).toContain("Área elegida en MAIN: AGENTS.");
      for (const label of [
        "Registrar esta carpeta",
        "Ver detalles completos",
        "Elegir modelo de Pi",
        "Actualizar datos",
        "Abrir menú completo /haril",
      ]) {
        expect(view, label).toContain(`▸ ${label}`);
      }
      expect(new Set(h.rows().map(textWidth))).toEqual(new Set([RAIL_WIDTH]));
      // The same tab opens by number.
      await h.command("haril-plugin", "main");
      await waitFor(() => expect(h.text()).toContain("[1:MAIN]"));
      await h.command("haril-plugin", "5");
      await waitFor(() => expect(h.text()).toContain("[5:ACC]"));
    });
  });

  it("shows the area chosen in MAIN's list, and only there: MAIN lists no actions at all", async () => {
    await withConsole(async (h) => {
      expect(h.text()).toContain("ÁREAS");
      expect(h.text()).toContain("● AGENTS");
      expect(h.text()).not.toContain("ACCIONES");
      expect(h.text()).not.toContain("Ver detalles completos");
      h.clickRow("○ TOOLS");
      await waitFor(() => expect(h.text()).toContain("● TOOLS"));
      expect(h.text()).not.toContain("ACCIONES");
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("╭─ Acciones · TOOLS "));
      expect(h.text()).toContain("▸ Modelo y nivel");
      expect(h.text()).not.toContain("Elegir modelo de Pi");
      // Back to MAIN, another area, and the tab follows it when it is opened again.
      await h.command("haril-plugin", "main");
      await waitFor(() => expect(h.text()).toContain("[1:MAIN]"));
      h.clickRow("○ ORCHESTRATION");
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("╭─ Acciones · ORCHESTRATION "));
      expect(h.text()).toContain("▸ Elegir el flujo de trabajo");
    });
  });

  it("follows an area chosen while the tab is on screen (Alt+H), without opening it again", async () => {
    await withConsole(async (h) => {
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("╭─ Acciones · AGENTS "));
      await h.pickArea("everywhere");
      await waitFor(() => expect(h.text()).toContain("╭─ Acciones · EVERYWHERE "));
      expect(h.text()).toContain("▸ Mostrar estado de la");
      expect(h.text()).not.toContain("Elegir modelo de Pi");
    });
  });

  it("runs the control from any row of its button, as the old MAIN row did: the details view opens", async () => {
    await withConsole(async (h) => {
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("▸ Ver detalles completos"));
      const before = h.customs();
      for (const [index, offset] of [-1, 0, 1].entries()) {
        expect(h.clickRow("▸ Ver detalles completos", offset)).toEqual({
          handled: true,
          render: true,
        });
        await waitFor(() => expect(h.customs()).toBe(before + index + 1));
      }
      // The note of the header card, and the top border of the Acciones card, run nothing.
      const settled = h.customs();
      expect(h.clickRow("Cámbiala allí.")).toBeUndefined();
      expect(h.clickRow("╭─ Acciones ──")).toBeUndefined();
      expect(h.customs()).toBe(settled);
    });
  });

  it("opens the complete /haril menu from its button, as the old row did", async () => {
    await withConsole(async (h) => {
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("▸ Abrir menú completo /haril"));
      h.clickRow("▸ Abrir menú completo /haril", 1);
      await waitFor(() =>
        expect(h.selects.map((menu) => menu.title)).toContain("Controles de la consola HARIL"),
      );
    });
  });

  it("leaves the keyboard menu as it was: Alt+K lists the same entries on MAIN and on ACC, without ACC-prefixed copies", async () => {
    await withConsole(async (h) => {
      // The console reads its data after the first frame (the folder is no project: that is the warning it ends up
      // with); the two menus are compared once it has.
      await waitFor(() => expect(h.text()).toContain("AVISOS · 1"));
      h.fake.shortcuts.get("alt+k")?.(h.ctx);
      await waitFor(() => expect(h.selects).toHaveLength(1));
      const onMain = h.selects[0];
      expect(onMain?.title).toBe("Panel derecho");
      expect(onMain?.options).toEqual(
        expect.arrayContaining([
          "Cambiar modo",
          "Abrir vista de orquestación",
          "Registrar esta carpeta",
          "Ver detalles completos",
          "Elegir modelo de Pi",
          "Actualizar datos",
          "Abrir menú completo /haril",
        ]),
      );
      // The section of the actions is the classic header's: the native panes draw no such section, so the menu does not
      // offer to open or close it (the actions themselves are listed above).
      expect(onMain?.options.some((option) => /sección acciones/.test(option))).toBe(false);
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("[5:ACC]"));
      h.fake.shortcuts.get("alt+k")?.(h.ctx);
      await waitFor(() => expect(h.selects).toHaveLength(2));
      expect(h.selects[1]?.options).toEqual(onMain?.options);
      expect(h.selects[1]?.options.some((option) => option.startsWith("ACC ·"))).toBe(false);
    });
  });

  it("runs an entry of the keyboard menu while ACC is on screen, as it does from MAIN", async () => {
    await withConsole(async (h) => {
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("[5:ACC]"));
      h.answer = (menu) =>
        menu.title === "Panel derecho"
          ? menu.options.find((option) => option === "Ver detalles completos")
          : undefined;
      const before = h.customs();
      h.fake.shortcuts.get("alt+k")?.(h.ctx);
      await waitFor(() => expect(h.customs()).toBe(before + 1));
    });
  });

  it("draws ASCII borders and pointers with HARIL_CONSOLE_ASCII, in the same width", async () => {
    process.env.HARIL_CONSOLE_ASCII = "1";
    await withConsole(async (h) => {
      await h.command("haril-plugin", "actions");
      await waitFor(() => expect(h.text()).toContain("+- Acciones · AGENTS "));
      expect(h.text()).toContain("| > Ver detalles completos");
      expect(h.text()).not.toMatch(/[╭╮╰╯─│▸▼▶▣]/u);
      expect(new Set(h.rows().map(textWidth))).toEqual(new Set([RAIL_WIDTH]));
    });
  });

  it("wraps its five tabs onto two rows of the header box, and the fifth one is hit on its own columns", async () => {
    await withConsole(async (h) => {
      const view = h.rows();
      expect(view[2]).toContain("[1:MAIN]  2:MEM   3:DOCS   4:ACT");
      expect(view[3]).toContain(" 5:ACC");
      expect(view[4]).toContain("╰");
      h.clickRow("5:ACC");
      await waitFor(() => expect(h.text()).toContain("[5:ACC]"));
      await waitFor(() => expect(h.text()).toContain("╭─ Acciones · AGENTS "));
    });
  });
});
