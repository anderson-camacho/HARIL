import { describe, expect, it, vi } from "vitest";
import { type DockDetails, type DockSource, loadDockDetails } from "../src/dock-details.js";
import { attachNativePanes, initialPaneSettings, type PaneSettings } from "../src/native-panes.js";
import { CARD_TEXT_X, RAIL_WIDTH } from "../src/rail-metrics.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { engram, gentle, install, memoryJson, statusJson } from "./tools-fixtures.js";

// The right panel as cards: the header box, and the MEM and DOCS views drawn through the real native pane. A row of
// the rail is exactly RAIL_WIDTH columns wide in every view, language and glyph set, and a button answers a click on
// each of its three rows.

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const ROWS = 45;
const ANSWER = (stdout: string) => async () => ({ ok: true, stdout, stderr: "" });
const FAILED = (stderr: string) => async () => ({ ok: false, stdout: "", stderr });

interface Pane {
  render(width: number): string[];
  handleMouse?(event: { type: string; button: string; x: number; y: number }): unknown;
}

function mount(state: PaneSettings, ascii: boolean, locale: "es" | "en" = "es") {
  const root = {
    render: vi.fn(() => ["Pi chat"]),
    invalidate: vi.fn(),
    [LAYOUT_NODE]: (() => ({ type: "vstack", entries: [], gap: 0, align: "stretch" })) as unknown,
  };
  const tui = {
    terminal: { columns: 160, rows: ROWS },
    requestRender: vi.fn(),
    layoutRoot: root,
    chatContainer: { invalidate: vi.fn() },
  };
  const select = vi.fn();
  const activate = vi.fn();
  const railAction = vi.fn();
  attachNativePanes(tui, state, {
    project: () => "repo",
    ascii: () => ascii,
    locale: () => locale,
    right: () => ({ lines: [], hits: [] }),
    select,
    activate,
    railAction,
  });
  const layout = (root[LAYOUT_NODE] as () => { entries: { component: Pane }[] })();
  const pane = layout.entries.at(-1)?.component;
  if (!pane) throw new Error("Expected the right pane");
  const rows = () => pane.render(RAIL_WIDTH).map(stripAnsi);
  return { pane, rows, select, activate, state };
}

function paneFor(
  selected: "main" | "memory" | "docs",
  detail: DockDetails | undefined,
  ascii = false,
  locale: "es" | "en" = "es",
) {
  return mount({ ...initialPaneSettings(), selected, detail }, ascii, locale);
}

const mem = (extra: DockSource = {}) =>
  loadDockDetails("memory", ".", {
    tools: ANSWER(statusJson([engram(), gentle()])),
    memory: ANSWER(memoryJson()),
    ...extra,
  });

// Everything at once, as in tools-view.test.ts: a missing Engram with other copies, a failing tools command, a null
// provider; the long titles and wrapped sentences are what could push a border out of its column.
const others = [1, 2, 3, 4].map((n) =>
  install(`C:\\otra-carpeta-larga-${n}\\bin\\engram.exe`, `3.${n}.0`, ["go-bin", "path"], false),
);
const dense = (locale: "es" | "en" = "es") =>
  mem({
    locale,
    tools: ANSWER(
      statusJson([
        engram({ state: "missing", active: null, installs: others, newerUpstream: true }),
        gentle({
          state: "outdated",
          installs: others,
          notes: [`could not check: ${"x".repeat(90)}`],
        }),
      ]),
    ),
    memory: ANSWER(
      memoryJson({
        provider: "null",
        persistent: false,
        degraded: true,
        lastError: { code: "e".repeat(50), at: 1 },
      }),
    ),
    checkError: "z".repeat(120),
  });
const unreachable = (locale: "es" | "en" = "es") =>
  mem({ locale, tools: FAILED("haril: tools exploded"), memory: FAILED("haril: store locked") });
const docs = (extra: DockSource = {}) =>
  loadDockDetails("docs", ".", { docsPath: async () => undefined, ...extra });
const withFolder = (path: string, locale: "es" | "en" = "es") =>
  docs({
    locale,
    docsPath: async () => path,
    scanDocs: async () => ({
      exists: true,
      isDirectory: true,
      noteCount: 2,
      truncated: false,
      latest: [
        { rel: "area/proyectos/clientes/acme/reuniones/2026/acta.md", mtimeMs: 1_800_000_000_000 },
        { rel: "日本語のノート.md", mtimeMs: 1_790_000_000_000 },
      ],
    }),
  });

const UNICODE_BOX = /[╭╮╰╯─│▸▼▶▣]/u;

describe("every row of the right rail is exactly RAIL_WIDTH columns wide", () => {
  const views: [
    string,
    "main" | "memory" | "docs",
    (locale: "es" | "en") => Promise<DockDetails | undefined>,
  ][] = [
    ["the header box over MAIN", "main", async () => undefined],
    ["MEM with everything in order", "memory", (locale) => mem({ locale })],
    ["MEM with every problem at once", "memory", (locale) => dense(locale)],
    ["MEM while something runs", "memory", (locale) => mem({ locale, busy: "update" })],
    ["MEM when both commands fail", "memory", (locale) => unreachable(locale)],
    ["DOCS with no folder", "docs", (locale) => docs({ locale })],
    [
      "DOCS with a folder and its notes",
      "docs",
      (locale) =>
        withFolder("C:\\Users\\ana\\Documentos\\Obsidian\\Bovedas\\Trabajo\\MiBoveda", locale),
    ],
    [
      "DOCS with a missing folder",
      "docs",
      (locale) =>
        docs({
          locale,
          docsPath: async () => "/x/y",
          scanDocs: async () => ({
            exists: false,
            isDirectory: false,
            noteCount: 0,
            truncated: false,
            latest: [],
          }),
        }),
    ],
  ];

  for (const ascii of [false, true]) {
    for (const locale of ["es", "en"] as const) {
      it.each(views)(
        `${ascii ? "ASCII" : "Unicode"} · ${locale} · %s`,
        async (_name, selected, load) => {
          const detail = await load(locale);
          const { rows } = paneFor(selected, detail, ascii, locale);
          const drawn = rows();
          expect(drawn).toHaveLength(ROWS);
          for (const row of drawn) expect([row, textWidth(row)]).toEqual([row, RAIL_WIDTH]);
          if (ascii) {
            // The rail's own separator, the borders, the pointers and the header's markers all fall back.
            expect(drawn.join("\n")).not.toMatch(UNICODE_BOX);
            expect(drawn.join("\n")).toContain("+-");
          } else {
            expect(drawn.join("\n")).toContain("╭");
          }
        },
      );
    }
  }

  it("also when the dock is collapsed or sits beside the chat", () => {
    for (const change of [{ dockExpanded: false }, { leftVisible: true }]) {
      for (const ascii of [false, true]) {
        const { rows } = mount({ ...initialPaneSettings(), ...change }, ascii);
        for (const row of rows()) expect([row, textWidth(row)]).toEqual([row, RAIL_WIDTH]);
      }
    }
  });
});

describe("the header box", () => {
  it("holds the space and the tabs, and closes the header with its own border", () => {
    const { rows } = paneFor("main", undefined);
    expect(rows().slice(0, 5)).toEqual([
      `│ ╭${"─".repeat(35)}╮ `,
      `│ │ ${"▼ Espacio: Principal · Alt+L".padEnd(33)} │ `,
      `│ │ ${"[1:MAIN]  2:MEM   3:DOCS   4:ACT".padEnd(33)} │ `,
      `│ ╰${"─".repeat(35)}╯ `,
      `│${" ".repeat(39)}`,
    ]);
  });

  it("uses > and + - | in ASCII mode, and still says where the user is", () => {
    const { rows } = paneFor("memory", undefined, true);
    expect(rows().slice(0, 4)).toEqual([
      `| +${"-".repeat(35)}+ `,
      `| | ${"v Espacio: Memoria · Alt+L".padEnd(33)} | `,
      `| | ${" 1:MAIN  [2:MEM]  3:DOCS   4:ACT".padEnd(33)} | `,
      `| +${"-".repeat(35)}+ `,
    ]);
  });

  it("is a one-row box when the dock is collapsed, and any of its rows opens the dock again", () => {
    const { pane, rows, state } = mount({ ...initialPaneSettings(), dockExpanded: false }, false);
    expect(rows().slice(0, 3)).toEqual([
      `│ ╭${"─".repeat(35)}╮ `,
      `│ │ ${"▶ Espacio: Principal · Alt+L".padEnd(33)} │ `,
      `│ ╰${"─".repeat(35)}╯ `,
    ]);
    for (const y of [0, 1, 2]) {
      state.dockExpanded = false;
      expect(pane.handleMouse?.({ type: "click", button: "left", y, x: CARD_TEXT_X })).toEqual({
        handled: true,
        render: true,
      });
      expect(state.dockExpanded).toBe(true);
    }
  });

  it("toggles on its first two rows, selects on the tabs, and leaves its bottom border alone", () => {
    const { pane, select, state } = paneFor("main", undefined);
    const click = (y: number, x = CARD_TEXT_X) =>
      pane.handleMouse?.({ type: "click", button: "left", y, x });
    expect(click(2, CARD_TEXT_X + 10)).toEqual({ handled: true, render: true });
    expect(select).toHaveBeenCalledWith("memory");
    expect(state.dockExpanded).toBe(true);
    expect(click(3)).toBeUndefined();
    expect(click(1)).toEqual({ handled: true, render: true });
    expect(state.dockExpanded).toBe(false);
  });
});

describe("the buttons of the MEM tab", () => {
  it("run their action from each of their three rows, and only from those", async () => {
    const detail = await mem();
    const { pane, rows, activate } = paneFor("memory", detail);
    const labels: [string, string][] = [
      ["Comprobar e instalar Engram", "tools:ensure"],
      ["Reinstalar Engram (forzar)", "tools:force"],
      ["Comprobar versiones ahora", "tools:refresh"],
      ["Actualizar gentle-ai…", "tools:update"],
    ];
    for (const [label, action] of labels) {
      const y = rows().findIndex((row) => row.includes(`▸ ${label}`));
      expect(y, label).toBeGreaterThan(0);
      for (const offset of [-1, 0, 1]) {
        activate.mockClear();
        const result = pane.handleMouse?.({ type: "click", button: "left", y: y + offset, x: 8 });
        expect([label, offset, result]).toEqual([label, offset, { handled: true, render: true }]);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledWith("memory", action);
      }
    }
    // Rows of the other cards run nothing: every row above the Acciones card.
    activate.mockClear();
    const actionsTop = rows().findIndex((row) => row.includes("╭─ Acciones"));
    for (let y = 0; y <= actionsTop; y++) {
      for (const x of [2, 8, 30]) {
        const result = pane.handleMouse?.({ type: "click", button: "left", y, x });
        if (y > 2) expect([y, x, result]).toEqual([y, x, undefined]);
      }
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it("show no button while something runs, only what runs", async () => {
    const detail = await mem({ busy: "ensure" });
    const { pane, rows, activate } = paneFor("memory", detail);
    const view = rows().join("\n");
    expect(view).toContain("… Comprobando e instalando Engram");
    expect(view).not.toContain("▸");
    for (let y = 0; y < ROWS; y++) {
      pane.handleMouse?.({ type: "click", button: "left", y, x: 8 });
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it("are ASCII buttons in ASCII mode, with the same hits", async () => {
    const detail = await mem({ locale: "en" });
    const { pane, rows, activate } = paneFor("memory", detail, true);
    const y = rows().findIndex((row) => row.includes("> Force reinstall Engram"));
    expect(y).toBeGreaterThan(0);
    expect(rows()[y - 1]).toContain("+--");
    pane.handleMouse?.({ type: "click", button: "left", y: y + 1, x: 8 });
    expect(activate).toHaveBeenCalledWith("memory", "tools:force");
  });
});

describe("a long title in a card", () => {
  it("keeps the name in the border and the state in the first row", async () => {
    const detail = await unreachable();
    const { rows } = paneFor("memory", detail);
    const view = rows().join("\n");
    expect(view).toContain("╭─ Engram y gentle-ai ─");
    expect(view).toContain("│ no disponible");
    expect(view).toContain("╭─ Proceso de memoria ─");
  });
});

describe("a view taller than the pane", () => {
  it("drops the rows that do not fit, keeps the header, and the wheel brings the rest into view", async () => {
    const detail = await dense();
    const { pane, rows } = paneFor("memory", detail);
    // Fewer rows than the card stack needs: the header and the first cards show, the Acciones card does not.
    const first = rows();
    expect(first).toHaveLength(ROWS);
    expect(first[1]).toContain("▼ Espacio: Memoria");
    const scrolled = (): string[] => {
      pane.handleMouse?.({ type: "wheel", button: "none", y: 3, x: 6, wheelDelta: 100 } as never);
      return rows();
    };
    const bottom = scrolled();
    expect(bottom).toHaveLength(ROWS);
    expect(bottom.join("\n")).toContain("╰");
    for (const row of bottom) expect(textWidth(row)).toBe(RAIL_WIDTH);
    // A click on the scrolled content maps to the row that is drawn there.
    const label = bottom.findIndex((row) => row.includes("▸ Reinstalar Engram (forzar)"));
    if (label >= 0) {
      expect(pane.handleMouse?.({ type: "click", button: "left", y: label, x: 8 })).toEqual({
        handled: true,
        render: true,
      });
    }
  });
});
