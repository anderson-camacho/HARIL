import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_AREAS,
  type DashboardArea,
  type DashboardFacts,
  type NativeRailContent,
  type RailSection,
  railWarnings,
  renderHeaderLayout,
  renderNativeRailContent,
} from "../src/dashboard.js";
import { emptyDashboardData } from "../src/dashboard-data.js";
import type { UiLocale } from "../src/locale.js";
import { attachNativePanes, initialPaneSettings, type PaneSettings } from "../src/native-panes.js";
import { initialOrchestrationState, type OrchestrationState } from "../src/orchestration-state.js";
import { buildRailMenu, type RailActionTarget, runRailHit } from "../src/rail-actions.js";
import {
  CARD_CONTENT_WIDTH,
  CARD_WIDTH,
  RAIL_BODY_WIDTH,
  RAIL_WIDTH,
} from "../src/rail-metrics.js";
import { stripAnsi, textWidth } from "../src/text.js";

// The MAIN tab of the native right rail as cards: a status card, ÁREAS, AVISOS, EXTENSIONES and SESIÓN, each a rounded
// box with its title in the top border. These tests render the real rail content (and the real pane around it) and
// check what the user sees (the rows, their widths, the glyph set) and what a click on each row asks for (the hits).
// The classic header and the keyboard menu are not cards; the last block pins their text.

function facts(over: Partial<DashboardFacts> = {}): DashboardFacts {
  return {
    locale: "es",
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
    ...over,
  };
}

type Expanded = Partial<Record<RailSection, boolean>>;

function cards(
  over: Partial<DashboardFacts> = {},
  expanded: Expanded = {},
  area: DashboardArea = "agents",
  width = RAIL_BODY_WIDTH,
): NativeRailContent {
  return renderNativeRailContent(facts(over), area, width, expanded, { cards: true });
}

const text = (content: NativeRailContent): string[] => content.lines.map(stripAnsi);

// The rows of a card as the helpers draw them, written out here so the tests do not borrow the code under test.
const margin = (row: string): string => ` ${row} `;
const top = (title: string, lead?: string): string => {
  const head = lead === undefined ? title : `${lead} ${title}`;
  return margin(`╭─ ${head} ${"─".repeat(CARD_WIDTH - 5 - textWidth(head))}╮`);
};
const body = (value: string): string => margin(`│ ${value.padEnd(CARD_CONTENT_WIDTH)} │`);
const bottom = margin(`╰${"─".repeat(CARD_WIDTH - 2)}╯`);
const blank = " ".repeat(RAIL_BODY_WIDTH);

describe("the MAIN rail as cards", () => {
  it("draws the status, the areas, the warnings, the extensions and the session as five cards", () => {
    const content = cards();
    expect(text(content)).toEqual([
      top("HARIL · AGENTS", "◉"),
      body("Estoy en: fake-cwd"),
      body("Modo: ACTION  ·  cambiar ↗"),
      body("Proyecto: fake-project"),
      body("Modelo: fake-model · no reasoning"),
      bottom,
      top("ÁREAS"),
      body("● AGENTS"),
      body("○ ORCHESTRATION"),
      body("○ AUTOMATION"),
      body("○ TOOLS"),
      body("○ EVERYWHERE"),
      body("Abrir vista de orquestación"),
      bottom,
      top("▼ AVISOS · 1"),
      body("! Provider offline"),
      bottom,
      top("▶ EXTENSIONES · 1"),
      bottom,
      top("▶ SESIÓN"),
      bottom,
      blank,
      margin("Alt+K menú del panel · Alt+H áreas".padEnd(CARD_WIDTH)),
      margin("Alt+I panel · Alt+C comandos".padEnd(CARD_WIDTH)),
    ]);
    // A literal, to guard against the helpers above drifting along with the code.
    expect(text(content)[0]).toBe(" ╭─ ◉ HARIL · AGENTS ────────────────╮ ");
    expect(text(content)[7]).toBe(" │ ● AGENTS                          │ ");
  });

  it("gives a click only to the rows that have an action: the border rows carry none but a toggle's", () => {
    const content = cards();
    expect(content.hits).toEqual([
      undefined, // ╭─ ◉ HARIL · AGENTS
      { action: "focus" }, // Estoy en
      { action: "mode" }, // Modo · cambiar
      undefined, // Proyecto
      undefined, // Modelo
      undefined, // ╰
      undefined, // ╭─ ÁREAS
      ...DASHBOARD_AREAS.map((area) => ({ action: "area", area })),
      { action: "run", control: "orchestration-view" },
      undefined, // ╰
      { action: "toggle", section: "warnings" }, // the title row of a card that opens and closes
      { action: "details" },
      undefined, // ╰
      { action: "toggle", section: "extensions" },
      undefined, // ╰ of a closed card
      { action: "toggle", section: "status" },
      undefined, // ╰ of a closed card
      undefined, // blank
      undefined, // hint
      undefined, // hint
    ]);
    expect(content.hits).toHaveLength(content.lines.length);
  });

  it("marks the open area and moves the mark with the area", () => {
    for (const area of DASHBOARD_AREAS) {
      const rows = text(cards({}, {}, area));
      expect(rows.filter((row) => row.includes("●"))).toHaveLength(1);
      expect(rows.some((row) => row.includes(`● ${area.toUpperCase()}`))).toBe(true);
      expect(rows.filter((row) => row.includes("○"))).toHaveLength(DASHBOARD_AREAS.length - 1);
      expect(rows[0]).toContain(`HARIL · ${area.toUpperCase()}`);
    }
  });

  it("opens a closed card with its rows, and closes an open one down to its two border rows", () => {
    const open = text(cards({}, { extensions: true, status: true, warnings: false }));
    expect(open).toContain(body("• pi-extension ready"));
    expect(open).toContain(body("Runtime: idle"));
    expect(open).toContain(body("Memoria: not loaded"));
    expect(open).toContain(top("▶ AVISOS · 1"));
    expect(open).not.toContain(body("! Provider offline"));
    const closed = text(cards({}, { warnings: false }));
    const at = closed.indexOf(top("▶ AVISOS · 1"));
    expect(at).toBeGreaterThan(0);
    // A closed card is its top border (the title row, the one that is clicked) and its bottom border, nothing between.
    expect(closed[at + 1]).toBe(bottom);
    expect(closed[at + 2]).toBe(top("▶ EXTENSIONES · 1"));
  });

  it("puts the toggle on the title row of the cards that open and close, whichever state they are in", () => {
    for (const expanded of [{}, { warnings: false, extensions: true, status: true }]) {
      const content = cards({}, expanded);
      const rows = text(content);
      for (const [title, section] of [
        ["AVISOS", "warnings"],
        ["EXTENSIONES", "extensions"],
        ["SESIÓN", "status"],
      ] as const) {
        const index = rows.findIndex((row) => row.includes(title));
        expect(rows[index], title).toMatch(/^ ╭─ [▼▶] /u);
        expect(content.hits[index], title).toEqual({ action: "toggle", section });
        // Not the row under it, and not the card's bottom border.
        expect(content.hits[index + 1], title).not.toEqual({ action: "toggle", section });
      }
    }
  });

  it("lists the orchestration card between the extensions and the session only for that area", () => {
    const running = {
      ...initialOrchestrationState(),
      snapshot: {
        workflow: { state: "running" },
        totals: { agentsCreated: 3, agentsCap: 6, queued: 1 },
        capacity: { executors: { live: 1, max: 4 } },
      },
    } as unknown as OrchestrationState;
    const other = text(cards({ orchestration: running }, {}, "tools")).join("\n");
    expect(other).not.toContain("ORQUESTACIÓN");
    const content = cards({ orchestration: running }, {}, "orchestration");
    const rows = text(content);
    const at = rows.indexOf(top("▼ ORQUESTACIÓN"));
    expect(at).toBeGreaterThan(rows.indexOf(top("▶ EXTENSIONES · 1")));
    expect(rows[at + 1]).toBe(body("Estado: running"));
    expect(rows[at + 2]).toBe(body("Agentes: 3/6 · cola: 1"));
    expect(content.hits[at]).toEqual({ action: "toggle", section: "orchestration" });
    expect(rows.indexOf(top("▶ SESIÓN"))).toBeGreaterThan(at);
    const none = text(cards({}, {}, "orchestration"));
    expect(none).toContain(body("Sin workflow seleccionado"));
  });

  it("speaks English when the console does", () => {
    const rows = text(cards({ locale: "en" }, { extensions: true }));
    expect(rows).toContain(body("I am in: fake-cwd"));
    expect(rows).toContain(body("Mode: ACTION  ·  change ↗"));
    expect(rows).toContain(body("Project: fake-project"));
    expect(rows).toContain(body("Model: fake-model · no reasoning"));
    expect(rows).toContain(top("AREAS"));
    expect(rows).toContain(top("▼ WARNINGS · 1"));
    expect(rows).toContain(top("▶ SESSION"));
    expect(rows).toContain(body("Open orchestration view"));
    expect(rows).toContain(margin("Alt+K panel menu · Alt+H areas".padEnd(CARD_WIDTH)));
    const joined = rows.join("\n");
    for (const spanish of ["Estoy en", "Modo:", "Proyecto", "Modelo", "ÁREAS", "AVISOS", "SESIÓN"])
      expect(joined).not.toContain(spanish);
  });

  it("draws a closed card of any width the rail is given, not only 39", () => {
    for (const width of [30, 39, 44]) {
      for (const row of text(cards({}, {}, "agents", width)))
        expect([width, row, textWidth(row)]).toEqual([width, row, width]);
    }
  });
});

describe("a warning in the rail", () => {
  const warn = (providerWarnings: string[], expanded: Expanded = {}) =>
    cards({ providerWarnings }, expanded);
  const rowsOf = (providerWarnings: string[]) => {
    const content = warn(providerWarnings);
    const rows = text(content);
    const start = rows.findIndex((row) => row.includes("AVISOS")) + 1;
    return { rows: rows.slice(start, rows.indexOf(bottom, start)), content, start };
  };

  it("wraps instead of being cut, the next rows indented under the words", () => {
    const { rows } = rowsOf(["HARIL provider cliproxy: unreachable"]);
    expect(rows).toEqual([body("! HARIL provider cliproxy:"), body("  unreachable")]);
  });

  it("wraps a long word anywhere, and shares the hit of the warning among all its rows", () => {
    const sixty = `Provider cliproxy offline: ${"e".repeat(33)}`;
    expect(sixty).toHaveLength(60);
    const { rows, content, start } = rowsOf([sixty]);
    expect(rows).toEqual([
      body("! Provider cliproxy offline:"),
      body(`  ${"e".repeat(31)}`),
      body("  ee"),
    ]);
    for (let index = 0; index < rows.length; index++)
      expect(content.hits[start + index]).toEqual({ action: "details" });
  });

  it("takes three rows at most, and the third ends with an ellipsis", () => {
    const { rows, content, start } = rowsOf([`Provider ${"z".repeat(150)}`]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatch(/…\s*│ $/u);
    expect(rows[2]?.includes("…")).toBe(true);
    for (let index = 0; index < rows.length; index++)
      expect(content.hits[start + index]).toEqual({ action: "details" });
    // The rows after the warning are the card's bottom border, not more of the warning.
    expect(text(content)[start + 3]).toBe(bottom);
  });

  it("lists three warnings and then counts the rest, with the number the title shows", () => {
    const five = ["one", "two", "three", "four", "five"].map((word) => `Provider ${word} offline`);
    const { rows, content } = rowsOf(five);
    expect(rows).toEqual([
      body("! Provider one offline"),
      body("! Provider two offline"),
      body("! Provider three offline"),
      body("+ 2 avisos · clic para ver todos"),
    ]);
    expect(text(content)).toContain(top("▼ AVISOS · 5", undefined));
    const english = text(cards({ locale: "en", providerWarnings: five }));
    expect(english).toContain(body("+ 2 more · click to see all"));
  });

  it("is counted once in the title however many times it was reported, as the bottom bar counts it", () => {
    const duplicated = facts({
      providerWarnings: ["Provider offline", "Provider offline"],
      data: { ...emptyDashboardData("fake-project"), errors: ["Provider offline", "Status: down"] },
      logFailures: 2,
    });
    const listed = railWarnings(duplicated);
    expect(listed).toHaveLength(3);
    const rows = text(renderNativeRailContent(duplicated, "agents", 39, {}, { cards: true }));
    expect(rows).toContain(top(`▼ AVISOS · ${listed.length}`));
    for (const none of [0, 1, 2, 3, 4, 7]) {
      const fresh = facts({
        providerWarnings: Array.from({ length: none }, (_unused, index) => `Warning ${index}`),
      });
      const title = text(renderNativeRailContent(fresh, "agents", 39, {}, { cards: true })).find(
        (row) => row.includes("AVISOS"),
      );
      expect(title).toContain(`AVISOS · ${railWarnings(fresh).length}`);
    }
  });

  it("keeps the tones it had: the warning red, the title yellow only while there is something to say", () => {
    const saved = { noColor: process.env.NO_COLOR, term: process.env.TERM };
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    try {
      const line = (content: NativeRailContent, needle: string) =>
        content.lines.find((candidate) => stripAnsi(candidate).includes(needle)) ?? "";
      const warned = cards();
      const idle = cards({ providerWarnings: [] });
      // Truecolor foregrounds of the matrix palette.
      const YELLOW = "38;2;231;207;117m";
      const CYAN = "38;2;38;238;104m";
      const ERROR = "38;2;255;101;118m";
      const TEAL = "38;2;119;255;165m";
      const TEXT = "38;2;198;244;210m";
      expect(line(warned, "AVISOS")).toContain(`${YELLOW}▼ AVISOS · 1`);
      expect(line(idle, "AVISOS")).toContain(`${CYAN}▼ AVISOS · 0`);
      expect(line(warned, "! Provider offline")).toContain(`${ERROR}! Provider offline`);
      // The selected area is yellow, the others plain; the heading of the status card keeps the yellow it had.
      expect(line(warned, "● AGENTS")).toContain(`${YELLOW}● AGENTS`);
      expect(line(warned, "○ TOOLS")).toContain(`${TEXT}○ TOOLS`);
      expect(line(warned, "HARIL · AGENTS")).toContain(`${YELLOW}HARIL · AGENTS`);
      expect(line(warned, "ÁREAS")).toContain(`${CYAN}ÁREAS`);
      expect(line(warned, "Abrir vista")).toContain(`${TEAL}Abrir vista de orquestación`);
      // The eye follows the context and the workers, as it did: teal at rest, red when the context is nearly full.
      expect(line(warned, "HARIL · AGENTS")).toContain(`${TEAL}◉`);
      expect(line(cards({ context: "90%" }), "HARIL · AGENTS")).toContain(`${ERROR}◉`);
      expect(line(cards({ runtime: "running" }), "HARIL · AGENTS")).toContain(`${YELLOW}◉`);
      // The borders are teal, with the panel's background under them.
      expect(line(warned, "ÁREAS")).toContain(`${TEAL}╭─ `);
    } finally {
      if (saved.noColor !== undefined) process.env.NO_COLOR = saved.noColor;
      if (saved.term === undefined) delete process.env.TERM;
      else process.env.TERM = saved.term;
    }
  });
});

describe("the values of the status card", () => {
  it("cut the folder, the project and the model with an ellipsis and keep their labels", () => {
    const rows = text(
      cards({
        cwd: "C:\\Users\\anderson\\Documentos\\proyectos\\muy-largo\\haril",
        project: "un-proyecto-con-un-nombre-realmente-largo",
        modelLevel: "claude-sonnet-5-5-con-un-identificador-largo · high",
      }),
    );
    const find = (label: string) => rows.find((row) => row.includes(label)) ?? "";
    for (const [label, row] of [
      ["Estoy en: ", find("Estoy en: ")],
      ["Proyecto: ", find("Proyecto: ")],
      ["Modelo: ", find("Modelo: ")],
    ] as const) {
      expect(row, label).toContain(`${label}`);
      expect(row, label).toMatch(/…\s*│ $/u);
      expect(textWidth(row), label).toBe(RAIL_BODY_WIDTH);
    }
  });
});

describe("every row of the MAIN cards is as wide as the rail", () => {
  const warningSets: Record<string, string[]> = {
    none: [],
    one: ["Provider offline"],
    three: ["Provider one offline", "HARIL provider cliproxy: unreachable", "Provider three"],
    sixty: [`Provider cliproxy offline: ${"e".repeat(33)}`],
    many: Array.from({ length: 6 }, (_unused, index) => `Provider number ${index} is offline`),
    huge: [`Activity log: ${"x".repeat(200)} failed record(s)`],
  };
  const projects: Record<string, Partial<DashboardFacts>> = {
    registered: { project: "mi-proyecto" },
    unregistered: {
      project: "carpeta-sin-registrar-con-nombre-largo-de-verdad",
      data: { ...emptyDashboardData(undefined) },
    },
  };
  const states: Record<string, Expanded> = {
    default: {},
    open: { warnings: true, extensions: true, status: true, orchestration: true },
    closed: { warnings: false, extensions: false, status: false, orchestration: false },
  };

  for (const ascii of [false, true]) {
    for (const locale of ["es", "en"] as const) {
      it(`${ascii ? "ASCII" : "Unicode"} · ${locale}`, () => {
        for (const [warningName, providerWarnings] of Object.entries(warningSets)) {
          for (const [projectName, project] of Object.entries(projects)) {
            for (const [stateName, expanded] of Object.entries(states)) {
              for (const area of ["agents", "orchestration", "tools"] as const) {
                const label = [warningName, projectName, stateName, area].join(" · ");
                const content = renderNativeRailContent(
                  facts({
                    ...project,
                    locale,
                    providerWarnings,
                    asciiGlyphs: ascii,
                    extensionStatuses: ["pi-extension ready", `status ${"y".repeat(70)}`],
                    cwd: "C:\\Users\\anderson\\Documentos\\proyectos\\muy-largo\\haril",
                    memory: `engram · ${"m".repeat(60)}`,
                  }),
                  area,
                  RAIL_BODY_WIDTH,
                  expanded,
                  { cards: true },
                );
                expect(content.hits, label).toHaveLength(content.lines.length);
                for (const row of text(content))
                  expect([label, row, textWidth(row)]).toEqual([label, row, RAIL_BODY_WIDTH]);
                if (ascii) {
                  const drawn = text(content).join("\n");
                  expect(drawn, label).not.toMatch(/[╭╮╰╯─│▸▼▶▣●○◉↗•]/u);
                  expect(drawn, label).toContain("+-");
                }
              }
            }
          }
        }
      });
    }
  }

  it("draws the glyphs of the ASCII set: + - | corners, * and o for the areas, v and > for the cards", () => {
    const rows = text(cards({ asciiGlyphs: true }, { extensions: true }));
    expect(rows[0]).toBe(` +- @ HARIL · AGENTS ${"-".repeat(16)}+ `);
    expect(rows[1]).toBe(` | ${"Estoy en: fake-cwd".padEnd(CARD_CONTENT_WIDTH)} | `);
    expect(rows).toContain(` | ${"Modo: ACTION  ·  cambiar ->".padEnd(CARD_CONTENT_WIDTH)} | `);
    expect(rows).toContain(` | ${"* AGENTS".padEnd(CARD_CONTENT_WIDTH)} | `);
    expect(rows).toContain(` | ${"o TOOLS".padEnd(CARD_CONTENT_WIDTH)} | `);
    expect(rows.some((row) => row.startsWith(" +- v AVISOS · 1 "))).toBe(true);
    expect(rows.some((row) => row.startsWith(" +- > SESIÓN "))).toBe(true);
    expect(rows).toContain(` | ${"- pi-extension ready".padEnd(CARD_CONTENT_WIDTH)} | `);
  });
});

describe("the MAIN cards in the real pane", () => {
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
  const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

  function mount(
    options: {
      over?: Partial<DashboardFacts>;
      expanded?: Expanded;
      area?: DashboardArea;
      state?: Partial<PaneSettings>;
      rows?: number;
    } = {},
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
    const state = { ...initialPaneSettings(), ...options.state };
    const expanded: Expanded = options.expanded ?? {};
    let area: DashboardArea | undefined = options.area ?? "agents";
    const calls: string[] = [];
    const target: RailActionTarget = {
      railExpanded: expanded,
      redraw: () => calls.push("redraw"),
      runControl: (control) => calls.push(`run:${control}`),
      chooseMode: () => calls.push("mode"),
      openMenu: () => calls.push("menu"),
      focus: () => calls.push("focus"),
      openArea: (next) => {
        area = next;
        calls.push(`area:${next}`);
      },
    };
    const f = facts(options.over);
    attachNativePanes(tui, state, {
      project: () => "repo",
      ascii: () => f.asciiGlyphs,
      locale: () => f.locale ?? "es",
      right: (width) => renderNativeRailContent(f, area, width, expanded, { cards: true }),
      select: vi.fn(),
      railAction: (hit) => runRailHit(target, hit),
    });
    const layout = (root[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
    const pane = layout.entries.at(-1)?.component;
    if (!pane) throw new Error("Expected the right pane");
    const rows = () => pane.render(RAIL_WIDTH).map(stripAnsi);
    const y = (needle: string): number => {
      const found = rows().findIndex((row) => row.includes(needle));
      if (found < 0) throw new Error(`Row not found: ${needle}`);
      return found;
    };
    const click = (row: number, x = 8) =>
      pane.handleMouse?.({ type: "click", button: "left", x, y: row });
    return { pane, rows, y, click, calls, expanded, state, tui };
  }

  it("is RAIL_WIDTH columns on every row, the header box over the cards included", () => {
    for (const ascii of [false, true]) {
      const { rows } = mount({ over: { asciiGlyphs: ascii } });
      const drawn = rows();
      expect(drawn).toHaveLength(60);
      for (const row of drawn) expect([row, textWidth(row)]).toEqual([row, RAIL_WIDTH]);
      expect(drawn.join("\n")).toContain(ascii ? "+- @ HARIL" : "╭─ ◉ HARIL");
    }
  });

  it("closes and opens AVISOS, EXTENSIONES and SESIÓN from the click on their title row", () => {
    const { rows, y, click, expanded, calls } = mount();
    expect(rows()[y("AVISOS")]).toContain("▼ AVISOS · 1");
    expect(rows().some((row) => row.includes("! Provider offline"))).toBe(true);
    expect(click(y("AVISOS"))).toEqual({ handled: true, render: true });
    expect(expanded.warnings).toBe(false);
    expect(rows()[y("AVISOS")]).toContain("▶ AVISOS · 1");
    expect(rows().some((row) => row.includes("! Provider offline"))).toBe(false);
    click(y("AVISOS"));
    expect(rows()[y("AVISOS")]).toContain("▼ AVISOS · 1");
    expect(rows().some((row) => row.includes("! Provider offline"))).toBe(true);

    expect(rows().some((row) => row.includes("pi-extension ready"))).toBe(false);
    click(y("EXTENSIONES"));
    expect(rows().some((row) => row.includes("• pi-extension ready"))).toBe(true);
    click(y("EXTENSIONES"));
    expect(rows().some((row) => row.includes("pi-extension ready"))).toBe(false);

    expect(rows().some((row) => row.includes("Runtime:"))).toBe(false);
    click(y("SESIÓN"));
    expect(rows().some((row) => row.includes("Runtime: idle"))).toBe(true);
    click(y("SESIÓN"));
    expect(rows().some((row) => row.includes("Runtime:"))).toBe(false);
    expect(calls.filter((call) => call !== "redraw")).toEqual([]);
  });

  it("does nothing on the border under a title, the bottom of a closed card or the text of a card", () => {
    const { rows, y, click, expanded, tui } = mount();
    const before = tui.requestRender.mock.calls.length;
    const title = y("AVISOS");
    for (const row of [title + 2, y("EXTENSIONES") + 1, y("SESIÓN") + 1, y("Proyecto:")]) {
      expect([row, rows()[row], click(row)]).toEqual([row, rows()[row], undefined]);
    }
    // The bottom border of the status card and the top of the areas card carry no action either.
    expect(click(y("Modelo:") + 1)).toBeUndefined();
    expect(click(y("ÁREAS"))).toBeUndefined();
    expect(expanded).toEqual({});
    expect(tui.requestRender.mock.calls).toHaveLength(before);
  });

  it("chooses the area from the click on its row, and the mode from the click on «cambiar»", () => {
    const { rows, y, click, calls } = mount();
    expect(click(y("○ TOOLS"))).toEqual({ handled: true, render: true });
    expect(calls).toEqual(["area:tools"]);
    expect(rows().some((row) => row.includes("● TOOLS"))).toBe(true);
    expect(rows().some((row) => row.includes("○ AGENTS"))).toBe(true);
    expect(rows().find((row) => row.includes("HARIL · "))).toContain("HARIL · TOOLS");
    expect(click(y("cambiar"))).toEqual({ handled: true, render: true });
    expect(click(y("Estoy en"))).toEqual({ handled: true, render: true });
    expect(click(y("Abrir vista de orquestación"))).toEqual({ handled: true, render: true });
    expect(calls).toEqual(["area:tools", "mode", "focus", "run:orchestration-view"]);
  });

  it("clicks on the row that is drawn, with the five tabs on two rows and the pane scrolled", () => {
    const { pane, rows, y, click, calls } = mount({
      rows: 24,
      over: { providerWarnings: ["one", "two", "three", "four"] },
      expanded: { extensions: true, status: true },
    });
    // Two rows of tabs: the cards start below the header box and the blank row, not where a single row of tabs would.
    expect(rows()[3]).toContain("5:ACC");
    expect(rows()[6]).toContain("╭─ ◉ HARIL");
    expect(y("Estoy en")).toBe(7);
    click(y("cambiar"));
    expect(calls).toEqual(["mode"]);
    pane.handleMouse?.({ type: "wheel", button: "none", x: 8, y: 5, wheelDelta: 9 });
    expect(rows().some((row) => row.includes("╭─ ◉ HARIL"))).toBe(false);
    // Each click is looked up after the one before changed the rows (a closed card is shorter than an open one).
    const expected: [string, string[]][] = [
      ["○ EVERYWHERE", ["area:everywhere"]],
      ["! three", ["run:details"]],
      ["EXTENSIONES", ["redraw"]],
      ["SESIÓN", ["redraw"]],
      ["AVISOS", ["redraw"]],
    ];
    for (const [needle, effect] of expected) {
      calls.length = 0;
      click(y(needle));
      expect([needle, calls]).toEqual([needle, effect]);
    }
  });
});

describe("the classic header and the keyboard menu keep their text", () => {
  const theme = { fg: (_tone: string, value: string) => value, bold: (value: string) => value };
  const classicFacts = (locale: UiLocale): DashboardFacts =>
    facts({
      locale,
      extensionStatuses: ["pi-extension ready", "second status"],
      providerWarnings: ["Provider offline", "HARIL provider cliproxy: unreachable"],
    });

  it("draws the header's right rail as flat rows with the key prefix and no card", () => {
    const header = renderHeaderLayout(
      "0.23.15",
      160,
      classicFacts("es"),
      "tools",
      theme,
      45,
      true,
      {},
    );
    // The rail is the right part of each row, after the separator at column 110 and before the closing frame.
    const rail = header.lines.map(stripAnsi).map((line) => line.slice(111, 159).trimEnd());
    expect(rail.slice(2, 22)).toEqual([
      "◉ HARIL · TOOLS · panel",
      " Estoy en: fake-cwd",
      " Modo: ACTION  ·  cambiar ↗",
      " Proyecto: fake-project",
      " Modelo: fake-model · no reasoning",
      " ▼ AVISOS · 2",
      " ! Provider offline",
      " ! HARIL provider cliproxy: unreachable",
      " ▶ EXTENSIONES · 2",
      " ▶ SESIÓN",
      " ▼ ACCIONES · TOOLS · 8",
      " [D] Ver detalles completos",
      " [M] Modelo y nivel",
      " [S] Ajustes de delegación",
      " [T] Activar o desactivar herramientas de Pi",
      " [B] Explorar metodologías de HARIL",
      " [C] Explorar comandos de HARIL",
      " [L] Registro de actividad reciente",
      " [R] Actualizar datos",
      " ↗ Abrir menú completo /haril",
    ]);
    expect(header.lines.map(stripAnsi).join("\n")).not.toMatch(/[╭╮╰╯]/u);
    expect(header.railHits?.map((hit) => [hit.row, hit.action, hit.section, hit.control])).toEqual([
      [2, "focus", undefined, undefined],
      [3, "focus", undefined, undefined],
      [4, "mode", undefined, undefined],
      [7, "toggle", "warnings", undefined],
      [8, "details", undefined, undefined],
      [9, "details", undefined, undefined],
      [10, "toggle", "extensions", undefined],
      [11, "toggle", "status", undefined],
      [12, "toggle", "actions", undefined],
      [13, "run", undefined, "details"],
      [14, "run", undefined, "model-level"],
      [15, "run", undefined, "delegation"],
      [16, "run", undefined, "toggle-tools"],
      [17, "run", undefined, "methodologies"],
      [18, "run", undefined, "commands"],
      [19, "run", undefined, "usage-log"],
      [20, "run", undefined, "refresh"],
      [21, "menu", undefined, undefined],
    ]);
  });

  it("keeps the flat form the menu is built from when cards are not asked for", () => {
    const flat = renderNativeRailContent(classicFacts("es"), "agents", 39, {});
    const rows = text(flat);
    expect(rows[0]).toBe("◉ HARIL · AGENTS · panel".padEnd(RAIL_BODY_WIDTH));
    expect(rows).toContain(" ▼ AVISOS · 2".padEnd(RAIL_BODY_WIDTH));
    expect(rows).toContain(" ! HARIL provider cliproxy: unreachable".padEnd(RAIL_BODY_WIDTH));
    expect(rows.join("\n")).not.toMatch(/[╭╮╰╯]/u);
    const withActions = renderNativeRailContent(
      classicFacts("es"),
      "agents",
      120,
      {},
      {
        actions: true,
      },
    );
    expect(buildRailMenu(withActions, "es").map((entry) => entry.label)).toEqual([
      "Abrir detalles del área",
      "Cambiar modo",
      "Abrir área AGENTS",
      "Abrir área ORCHESTRATION",
      "Abrir área AUTOMATION",
      "Abrir área TOOLS",
      "Abrir área EVERYWHERE",
      "Abrir vista de orquestación",
      "Cerrar sección avisos (2)",
      "Ver detalles completos",
      "Abrir sección extensiones (2)",
      "Abrir sección sesión",
      "Cerrar sección acciones · AGENTS (4)",
      "Elegir modelo de Pi",
      "Tareas por agente observado",
      "Actualizar datos",
      "Abrir menú completo /haril",
    ]);
  });
});
