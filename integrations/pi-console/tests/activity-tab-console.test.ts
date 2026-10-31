import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import type {
  ConsoleComponent,
  ConsoleContext,
  ConsoleTheme,
  ConsoleTui,
} from "../src/pi-types.js";
import { RAIL_BODY_WIDTH } from "../src/rail-metrics.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// The ACT tab of the right panel: the project's recent events, a filter by time range, and the buttons that change it.
// These tests drive the real console with a fake CLI, a fake Pi and the real right pane. Real input dialogs and the
// delivery of real mouse clicks by Pi's terminal are not exercised here.

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };

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

interface Harness {
  readonly fake: FakePi;
  readonly ctx: FakeContext;
  readonly input: ReturnType<typeof vi.fn>;
  sidebar(): string;
  rows(): string[];
  // The rows as drawn, with their colours.
  raw(): string[];
  shows(text: string): Promise<void>;
  clickRow(needle: string, offset?: number): unknown;
  // A click at a column of the rail (0 is its separator) on the row that holds `needle`, `offset` rows below it.
  clickAt(needle: string, column: number, offset?: number): unknown;
  // A click on the row of the chip with this label, `shift` columns from the middle of its label and `offset` rows below
  // its middle row (a chip is three rows tall).
  clickChip(label: string, offset?: number, shift?: number): unknown;
  // The rail column of the first character of a chip's label.
  chipColumn(label: string): number;
  // Turns the mouse wheel over the panel: a positive delta scrolls down.
  wheel(delta: number): void;
  readonly menus: { title: string; options: string[] }[];
  choose: (menu: { title: string; options: string[] }) => string | undefined;
  command(name: string, args: string): Promise<void>;
  // The `haril events` calls with --limit 50 (the ACT tab's): the dashboard's own call asks for 20.
  eventCalls(): string[][];
  notes(): string;
}

let cli: FakeCli;

beforeEach(() => {
  cli = installFakeCli();
});

afterEach(() => {
  cli.restore();
});

const waitFor = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: 15_000, interval: 25 });

const PROJECTS = JSON.stringify({
  projects: [{ slug: "demo", name: "Demo", rootPath: tmpdir() }],
});

// Three events of the project, written 3, 5 and 130 minutes ago (the seconds keep the minutes off the rounding edge).
function eventsList(count = 3): string {
  const now = Date.now();
  const minutes = [130, 5, 3];
  return JSON.stringify(
    Array.from({ length: count }, (_unused, index) => ({
      seq: 373 + index,
      time: new Date(now - (minutes[index % 3] as number) * 60_000 - 5_000).toISOString(),
      type: ["workflow.failed", "task.cancelled", "watchdog.closed"][index % 3],
      aggregateType: "task",
      aggregateId: "t1",
      projectId: "p",
      taskId: null,
      runId: null,
      payload: {},
    })),
  );
}

function installProject(
  answers: { events?: string; locale?: string; plugins?: unknown } = {},
): void {
  cli.answer("project list", { stdout: PROJECTS });
  cli.answer("events", { stdout: answers.events ?? eventsList() });
  if (answers.locale !== undefined) {
    cli.answer("config get ui.locale", {
      stdout: JSON.stringify({ path: "ui.locale", value: answers.locale }),
    });
  }
  if (answers.plugins !== undefined) {
    cli.answer("config get ui.plugins", {
      stdout: JSON.stringify({ path: "ui.plugins", value: answers.plugins }),
    });
  }
}

async function withConsole(
  run: (harness: Harness) => Promise<void>,
  options: {
    readonly input?: (
      title: string,
      placeholder?: string,
    ) => string | undefined | Promise<string | undefined>;
  } = {},
): Promise<void> {
  const fake = fakePi();
  const ctx = fakeContext(tmpdir());
  const input = vi.fn(async (title: string, placeholder?: string) =>
    options.input?.(title, placeholder),
  );
  const menus: { title: string; options: string[] }[] = [];
  const picker = {
    choose: (_menu: { title: string; options: string[] }): string | undefined => undefined,
  };
  let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
  Object.assign(ctx.ui, {
    input,
    select: async (title: string, choices: string[]) => {
      const menu = { title, options: choices };
      menus.push(menu);
      return picker.choose(menu);
    },
    setWidget(key: string, value: typeof anchor) {
      if (key === "haril-native-panes-anchor") anchor = value;
    },
  });
  harilConsole(fake.pi);
  await fake.fire("session_start", { reason: "startup" }, ctx as ConsoleContext);
  if (!anchor) throw new Error("Expected the console to install its UI");
  const layoutRoot = {
    render: () => ["Pi chat"],
    invalidate: () => undefined,
    [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
  };
  const tui = {
    layoutRoot,
    terminal: { columns: 160, rows: 60 },
    requestRender: () => undefined,
  };
  anchor(tui, THEME);
  const layout = (layoutRoot[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
  const pane = layout.entries.at(-1)?.component;
  if (!pane) throw new Error("Expected the right pane");
  const rows = () => pane.render(40).map(stripAnsi);
  // The middle row of a chip: its label between the chip's borders and padding.
  const chipRowIndex = (label: string): number => {
    const y = rows().findIndex(
      (row) => row.includes(`│ ${label} │`) || row.includes(`| ${label} |`),
    );
    if (y < 0) throw new Error(`Chip not found: ${label}\n${rows().join("\n")}`);
    return y;
  };
  const chipColumn = (label: string): number => {
    const row = rows()[chipRowIndex(label)] ?? "";
    const unicode = row.indexOf(`│ ${label} │`);
    return (unicode >= 0 ? unicode : row.indexOf(`| ${label} |`)) + 2;
  };
  try {
    await run({
      fake,
      ctx,
      input,
      sidebar: () => rows().join("\n"),
      rows,
      raw: () => pane.render(40),
      shows: (text) => waitFor(() => expect(rows().join("\n")).toContain(text)),
      clickRow(needle, offset = 0) {
        const y = rows().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}\n${rows().join("\n")}`);
        return pane.handleMouse?.({ type: "click", button: "left", x: 8, y: y + offset });
      },
      clickAt(needle, column, offset = 0) {
        const y = rows().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}\n${rows().join("\n")}`);
        return pane.handleMouse?.({ type: "click", button: "left", x: column, y: y + offset });
      },
      clickChip(label, offset = 0, shift = 0) {
        const y = chipRowIndex(label);
        const x = chipColumn(label) + Math.floor(label.length / 2) + shift;
        return pane.handleMouse?.({ type: "click", button: "left", x, y: y + offset });
      },
      chipColumn,
      wheel: (delta) => {
        pane.handleMouse?.({ type: "wheel", button: "none", x: 8, y: 8, wheelDelta: delta });
      },
      menus,
      get choose() {
        return picker.choose;
      },
      set choose(value) {
        picker.choose = value;
      },
      command: (name, args) =>
        fake.commands.get(name)?.handler(args, ctx as ConsoleContext) ?? Promise.resolve(),
      eventCalls: () =>
        cli
          .calls()
          .map((call) => call.args)
          .filter(
            (args) =>
              args[0] === "events" &&
              args.includes("--limit") &&
              args[args.indexOf("--limit") + 1] === "50",
          ),
      notes: () => ctx.notes.map(([message]) => message).join("\n"),
    });
  } finally {
    await fake.fire("session_shutdown", {}, ctx as ConsoleContext);
  }
}

// The project is found after the first frame: wait for MAIN to name it, then open the tab.
async function openActivity(h: Harness, how = "activity"): Promise<void> {
  await h.shows("Proyecto: demo");
  await h.command("haril-plugin", how);
}

describe("the ACT tab", () => {
  it("is the fourth tab and shows the filter, the buttons and the events as cards, newest first", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      const view = h.sidebar();
      expect(view).toContain("[4:ACT]");
      expect(view).toContain("Espacio: Actividad");
      expect(view).toContain("╭─ Filtro ");
      expect(view).toContain("│ Todo");
      expect(view).toContain("│ Actualizado ");
      expect(view).toContain("╭─ Acciones ");
      // The range buttons are four compact chips on one row, «Actualizar» the full-width button under them.
      expect(view).toContain("│ 1h │ │ 1d │ │ Rango │ │ Todo │");
      expect(view).toContain("▸ Actualizar");
      for (const label of ["Última hora", "Último día", "Rango…"]) {
        expect(view, label).not.toContain(`▸ ${label}`);
      }
      // The heading under the header box is just «Actividad».
      expect(h.rows().some((row) => row.replace(/^│/u, "").trim() === "Actividad")).toBe(true);
      expect(view).not.toContain("Actividad reciente");
      const events = h.rows().filter((row) => /#37\d /.test(row));
      expect(events.map((row) => row.replace(/[│ ]+$/u, "").replace(/^[ │]+/u, ""))).toEqual([
        "#375 watchdog.closed · hace 3 min",
        "#374 task.cancelled · hace 5 min",
        "#373 workflow.failed · hace 2 h",
      ]);
      // The whole rail stays inside its 40 columns.
      expect(new Set(h.rows().map(textWidth))).toEqual(new Set([40]));
      expect(h.eventCalls()).toEqual([["events", "--project", "demo", "--limit", "50", "--json"]]);
    });
  });

  it("opens with /haril-plugin 4 as well, and names ACT and ACC in the usage text", async () => {
    installProject();
    await withConsole(async (h) => {
      await h.shows("Proyecto: demo");
      await h.command("haril-plugin", "4");
      await h.shows("╭─ Actividad · 3 ");
      await h.command("haril-plugin", "9");
      expect(h.ctx.notes.at(-1)?.[0]).toBe(
        "Uso: /haril-plugin [main|memory|docs|activity|actions|1..5|details]",
      );
    });
  });

  it("keeps working for a haril.json written with the three slots of the previous release", async () => {
    installProject({
      plugins: [
        { id: "main", visible: true },
        { id: "memory", visible: true },
        { id: "docs", visible: true },
      ],
    });
    await withConsole(async (h) => {
      await h.shows("4:ACT");
      await openActivity(h, "4");
      await h.shows("╭─ Actividad · 3 ");
    });
  });

  it("reads the tab once when the plugin list answers while the tab is still loading", async () => {
    installProject();
    // The list of tabs answers (0.7 s) before the events do (1.2 s): reloading the list used to start a second read of
    // the tab that was already loading, so the tab asked the CLI twice.
    cli.answer("events", { stdout: eventsList(), delayMs: 1200 });
    cli.answer("config get ui.plugins", {
      stdout: JSON.stringify({
        path: "ui.plugins",
        value: ["main", "memory", "docs", "activity", "actions"].map((id) => ({
          id,
          visible: true,
        })),
      }),
      delayMs: 700,
    });
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(h.eventCalls()).toHaveLength(1);
    });
  });

  it("is not offered when the user hid it, and the plugin command says so", async () => {
    installProject({
      plugins: [
        { id: "main", visible: true },
        { id: "memory", visible: true },
        { id: "docs", visible: true },
        { id: "activity", visible: false },
      ],
    });
    await withConsole(async (h) => {
      await h.shows("Proyecto: demo");
      await waitFor(() => expect(h.sidebar()).not.toContain("4:ACT"));
      await h.command("haril-plugin", "activity");
      expect(h.notes()).toContain("Ese espacio está oculto");
      expect(h.eventCalls()).toEqual([]);
    });
  });

  it("says the empty range in the card, with the buttons still there", async () => {
    installProject({ events: "[]" });
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("Sin eventos en este rango.");
      expect(h.sidebar()).toContain("╭─ Actividad · 0 ");
      expect(h.sidebar()).toContain("│ 1h │ │ 1d │ │ Rango │ │ Todo │");
    });
  });

  it("notes that only the newest 50 are shown", async () => {
    installProject({ events: eventsList(50) });
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 50 ");
      // The list is longer than the panel: the note is its last row, reached with the wheel.
      expect(h.sidebar()).not.toContain("Mostrando los últimos 50.");
      h.wheel(100);
      expect(h.sidebar()).toContain("Mostrando los últimos 50.");
      expect(h.sidebar()).toContain("╰");
    });
  });

  it("shows why the events could not be read inside the card, and keeps the buttons", async () => {
    cli.answer("project list", { stdout: PROJECTS });
    cli.answer("events", {
      stderr: "haril: store not initialized (run haril project init first)\n",
      code: 2,
    });
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("Actividad · no disponible");
      expect(h.sidebar()).toContain("store not initialized");
      expect(h.sidebar()).toContain("▸ Actualizar");
    });
  });

  it("says the folder is no project, and runs no events command for it", async () => {
    cli.answer("project list", { stdout: JSON.stringify({ projects: [] }) });
    await withConsole(async (h) => {
      await h.shows("Proyecto:");
      await h.command("haril-plugin", "activity");
      await h.shows("Sin proyecto registrado");
      expect(h.eventCalls()).toEqual([]);
    });
  });

  it("speaks English when the interface does", async () => {
    installProject({ locale: "en" });
    await withConsole(async (h) => {
      await waitFor(() => expect(h.sidebar()).toContain("Project: demo"));
      await h.command("haril-plugin", "activity");
      await h.shows("╭─ Activity · 3 ");
      const view = h.sidebar();
      expect(view).toContain("╭─ Filter ");
      expect(view).toContain("╭─ Actions ");
      expect(view).toContain("│ 1h │ │ 1d │ │ Range │ │ All │");
      expect(view).toContain("▸ Refresh");
      expect(view).toContain("#375 watchdog.closed · 3 min ago");
    });
  });

  it("falls back to ASCII borders and pointers with HARIL_CONSOLE_ASCII, in the same width", async () => {
    const saved = process.env.HARIL_CONSOLE_ASCII;
    process.env.HARIL_CONSOLE_ASCII = "1";
    try {
      installProject();
      await withConsole(async (h) => {
        await openActivity(h);
        await h.shows("+- Actividad · 3 ");
        const view = h.sidebar();
        expect(view).toContain("+- Filtro ");
        expect(view).toContain("| 1h | | 1d | | Rango | | Todo |");
        expect(view).toContain("| > Actualizar");
        expect(view).not.toMatch(/[╭╮╰╯─│▸▼▶▣]/u);
        expect(new Set(h.rows().map(textWidth))).toEqual(new Set([RAIL_BODY_WIDTH + 1]));
      });
    } finally {
      if (saved === undefined) delete process.env.HARIL_CONSOLE_ASCII;
      else process.env.HARIL_CONSOLE_ASCII = saved;
    }
  });
});

describe("the buttons of the ACT tab", () => {
  it.each([
    ["Última hora", "1h", ["--since", "1h"]],
    ["Último día", "1d", ["--since", "1d"]],
  ])(
    "«%s» (the %s chip) reads the events again, filtered, and the filter card says so",
    async (label, chip, flags) => {
      installProject();
      await withConsole(async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        h.clickChip(chip);
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
        expect(h.eventCalls()[1]).toEqual([
          "events",
          "--project",
          "demo",
          "--limit",
          "50",
          ...flags,
          "--json",
        ]);
        await waitFor(() =>
          expect(h.sidebar()).toContain(
            label === "Última hora" ? "│ Última hora (desde " : "│ Último día (desde ",
          ),
        );
      });
    },
  );

  it("«Todo» goes back to every event, and «Actualizar» reads the same range again", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.clickChip("1h");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
      await h.shows("▸ Actualizar");
      h.clickRow("▸ Actualizar");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(3));
      expect(h.eventCalls()[2]).toEqual(h.eventCalls()[1]);
      await h.shows("│ Todo │");
      h.clickChip("Todo");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(4));
      expect(h.eventCalls()[3]).toEqual(["events", "--project", "demo", "--limit", "50", "--json"]);
    });
  });

  it("run from any of the three rows of a button, and from no other row", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      // The text of the filter card: nothing to run.
      expect(h.clickRow("Actualizado ")).toBeUndefined();
      expect(h.eventCalls()).toHaveLength(1);
      // «Actualizar» is a whole-row button: its three rows run it, the card's bottom border does not.
      for (const [index, offset] of [-1, 0, 1].entries()) {
        await h.shows("▸ Actualizar");
        expect(h.clickRow("▸ Actualizar", offset), `offset ${offset}`).toEqual({
          handled: true,
          render: true,
        });
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2 + index));
        await waitFor(() => expect(h.sidebar()).toContain("▸ Actualizar"));
      }
      const before = h.eventCalls().length;
      expect(h.clickRow("▸ Actualizar", 2)).toBeUndefined();
      expect(h.eventCalls()).toHaveLength(before);
    });
  });

  it("run a chip from any of its three rows and any of its columns, and nothing from a gap or a border", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      const reads = () => h.eventCalls().length;
      // The day chip, `│ 1d │`: its border column, its label and its other border, on the three rows of the chip.
      const first = h.chipColumn("1d") - 2;
      for (const [index, [offset, column]] of [
        [-1, first],
        [0, first + 1],
        [1, first + 2],
        [-1, first + 3],
        [0, first + 4],
        [1, first + 5],
      ].entries()) {
        await h.shows("│ 1d │");
        expect(
          h.clickAt("│ 1d │", column as number, offset as number),
          `${offset},${column}`,
        ).toEqual({
          handled: true,
          render: true,
        });
        await waitFor(() => expect(reads()).toBe(2 + index));
        expect(h.eventCalls()[1 + index]).toContain("1d");
        await h.shows("│ 1d │");
        await waitFor(() => expect(h.sidebar()).not.toContain("Cargando"));
      }
      // The gap between two chips, the spare columns after the last one and the card's own border run nothing.
      const before = reads();
      const gap = first - 1;
      const lastChip = h.chipColumn("Todo") + "Todo".length + 2;
      for (const column of [gap, lastChip + 1, lastChip + 2, 1, 2, 3, 38, 39]) {
        for (const offset of [-1, 0, 1]) {
          expect(h.clickAt("│ 1d │", column, offset), `${offset},${column}`).toBeUndefined();
        }
      }
      expect(reads()).toBe(before);
      // The card's top border, one row above the chips, and the button's, one row below them, are not chips.
      expect(h.clickAt("│ 1d │", first + 1, -2)).toBeUndefined();
      expect(reads()).toBe(before);
    });
  });

  it("run the action of the chip under the click, one for each chip", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.clickChip("1h");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
      expect(h.eventCalls()[1]).toContain("1h");
      await h.shows("│ Todo │");
      h.clickChip("1d", 1, 1);
      await waitFor(() => expect(h.eventCalls()).toHaveLength(3));
      expect(h.eventCalls()[2]).toContain("1d");
      await h.shows("│ Todo │");
      h.clickChip("Todo", -1, -1);
      await waitFor(() => expect(h.eventCalls()).toHaveLength(4));
      expect(h.eventCalls()[3]).not.toContain("--since");
    });
  });

  it("highlight the chip of the range in force", async () => {
    const saved = { noColor: process.env.NO_COLOR, term: process.env.TERM };
    delete process.env.NO_COLOR;
    process.env.TERM = "xterm-256color";
    try {
      installProject();
      await withConsole(async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        const yellow = "38;2;231;207;117m";
        const middle = (label: string): string =>
          h.raw().find((row) => stripAnsi(row).includes(`│ ${label} │`)) ?? "";
        // «Todo» is in force at first: its border and label are yellow, the others' are not.
        expect(middle("Todo")).toContain(`${yellow}│ `);
        expect(middle("Todo")).toContain(`${yellow}Todo`);
        expect(middle("1h")).not.toContain(`${yellow}1h`);
        h.clickChip("1h");
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
        await h.shows("│ 1h │");
        await waitFor(() => expect(h.sidebar()).not.toContain("Cargando"));
        // The highlight followed the range: now it is the 1h chip's.
        expect(middle("1h")).toContain(`${yellow}1h`);
        expect(middle("Todo")).not.toContain(`${yellow}Todo`);
        expect(middle("1d")).not.toContain(`${yellow}1d`);
      });
    } finally {
      if (saved.noColor !== undefined) process.env.NO_COLOR = saved.noColor;
      if (saved.term === undefined) delete process.env.TERM;
      else process.env.TERM = saved.term;
    }
  });

  it("show «Cargando…» in place of the buttons while the events are read, then the new events", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      cli.answer("events", { stdout: eventsList(2), delayMs: 400 });
      h.clickChip("1h");
      await h.shows("… Cargando…");
      expect(h.sidebar()).not.toContain("│ Rango │");
      // The events it already had stay on screen meanwhile.
      expect(h.sidebar()).toContain("╭─ Actividad · 3 ");
      await h.shows("╭─ Actividad · 2 ");
      expect(h.sidebar()).toContain("│ Rango │");
      expect(h.sidebar()).not.toContain("Cargando");
    });
  });

  it("keep the range while the user looks at another tab and comes back", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.clickChip("1h");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
      await h.shows("│ Rango │");
      // MAIN has no command to run, so the way back is the only CLI call of the round trip.
      await h.command("haril-plugin", "main");
      await h.shows("[1:MAIN]");
      await h.command("haril-plugin", "activity");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(3));
      expect(h.eventCalls()[2]).toContain("1h");
      expect(h.sidebar()).toContain("Última hora (desde ");
    });
  });
});

describe("«Rango…» in the console", () => {
  const HINT = "Escribe el rango en el cuadro de abajo (Esc cancela).";
  const TITLE = "Actividad · rango (ej. 3h, 2d, 29/10 08:00 .. 29/10 12:00)";

  it("asks one question with the input dialog and filters by «desde .. hasta»", async () => {
    installProject();
    const answers = ["2026-10-30T08:00:00Z .. 2026-10-30T12:00:00Z"];
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        h.clickChip("Rango");
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
        expect(h.input.mock.calls).toEqual([[TITLE, "3h, 2d, 29/10 08:00 .. 29/10 12:00"]]);
        expect(h.eventCalls()[1]).toEqual([
          "events",
          "--project",
          "demo",
          "--limit",
          "50",
          "--from",
          "2026-10-30T08:00:00.000Z",
          "--to",
          "2026-10-30T12:00:00.000Z",
          "--json",
        ]);
        await waitFor(() => expect(h.sidebar()).toContain("│ Rango: "));
      },
      { input: () => answers.shift() },
    );
  });

  it("takes a duration, and «desde ..» as until now", async () => {
    installProject();
    const answers = ["3h"];
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        h.clickChip("Rango");
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
        const args = h.eventCalls()[1] ?? [];
        expect(args.slice(0, 5)).toEqual(["events", "--project", "demo", "--limit", "50"]);
        expect(args[5]).toBe("--from");
        expect(args).not.toContain("--to");
        const from = Date.parse(args[6] ?? "");
        expect(Math.abs(Date.now() - 3 * 3_600_000 - from)).toBeLessThan(10_000);
        await waitFor(() => expect(h.sidebar()).toContain("→ ahora"));
      },
      { input: () => answers.shift() },
    );
  });

  it("says in a notice what it cannot read, and leaves the tab as it was", async () => {
    installProject();
    const answers = ["ayer"];
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        const before = h.sidebar();
        h.clickChip("Rango");
        await waitFor(() => expect(h.notes()).toContain("«Desde» no es válido"));
        expect(h.ctx.notes.at(-1)?.[1]).toBe("warning");
        expect(h.eventCalls()).toHaveLength(1);
        await waitFor(() => expect(h.sidebar()).toBe(before));
      },
      { input: () => answers.shift() },
    );
  });

  it("changes nothing when the dialog is cancelled", async () => {
    installProject();
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        const before = h.sidebar();
        const notes = h.ctx.notes.length;
        h.clickChip("Rango");
        await waitFor(() => expect(h.input).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(h.sidebar()).toBe(before));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.eventCalls()).toHaveLength(1);
        // Only the notice that says where to type: no warning and no error.
        expect(h.ctx.notes.slice(notes)).toEqual([[HINT, "info"]]);
      },
      { input: () => undefined },
    );
  });

  it("shows the chip waiting and says where to type while the dialog is open, then goes back", async () => {
    installProject();
    let answer: ((value: string | undefined) => void) | undefined;
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        const notes = h.ctx.notes.length;
        h.clickChip("Rango");
        await h.shows("│ Espera │");
        expect(h.sidebar()).not.toContain("│ Rango │");
        expect(h.sidebar()).not.toContain("Cargando");
        expect(h.ctx.notes.slice(notes)).toEqual([[HINT, "info"]]);
        // A second press finds the box open: it says where it is again and opens no other.
        h.clickChip("Espera");
        await waitFor(() => expect(h.ctx.notes.slice(notes)).toHaveLength(2));
        expect(h.ctx.notes.at(-1)).toEqual([HINT, "info"]);
        expect(h.input).toHaveBeenCalledTimes(1);
        answer?.(undefined);
        await h.shows("│ Rango │");
        expect(h.sidebar()).not.toContain("Espera");
        expect(h.eventCalls()).toHaveLength(1);
      },
      { input: () => new Promise<string | undefined>((resolve) => (answer = resolve)) },
    );
  });

  it("shows an error notice, never silence, when the dialog cannot open", async () => {
    installProject();
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        h.clickChip("Rango");
        await waitFor(() =>
          expect(h.notes()).toContain("No se pudo abrir el cuadro del rango: no editor"),
        );
        expect(h.ctx.notes.at(-1)?.[1]).toBe("error");
        await h.shows("│ Rango │");
        expect(h.eventCalls()).toHaveLength(1);
      },
      {
        input: () => {
          throw new Error("no editor");
        },
      },
    );
  });
});

describe("the ACT tab in the keyboard menu", () => {
  it("lists its buttons first, as «ACT · …», and runs the one chosen", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.choose = (menu) => menu.options.find((option) => option === "ACT · Última hora");
      h.fake.shortcuts.get("alt+k")?.(h.ctx as ConsoleContext);
      await waitFor(() => expect(h.menus).toHaveLength(1));
      expect(h.menus[0]?.options.slice(0, 5)).toEqual([
        "ACT · Última hora",
        "ACT · Último día",
        "ACT · Rango…",
        "ACT · Todo",
        "ACT · Actualizar",
      ]);
      expect(h.menus[0]?.options.some((option) => /[│╭╮╰╯]/u.test(option))).toBe(false);
      await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
      expect(h.eventCalls()[1]).toEqual([
        "events",
        "--project",
        "demo",
        "--limit",
        "50",
        "--since",
        "1h",
        "--json",
      ]);
    });
  });
});

describe("MAIN without the recent activity", () => {
  it("no longer lists the events, and keeps the two hint rows", async () => {
    installProject();
    await withConsole(async (h) => {
      await h.shows("Proyecto: demo");
      // The dashboard has read the events by now; none of them is drawn.
      await waitFor(() => expect(cli.calls().some((call) => call.args[0] === "events")).toBe(true));
      const view = h.sidebar();
      expect(view).toContain("[1:MAIN]");
      expect(view).not.toContain("ACTIVIDAD RECIENTE");
      expect(view).not.toContain("watchdog.closed");
      expect(view).not.toContain("#375");
      expect(view).toContain("Alt+K menú del panel · Alt+H áreas");
      expect(view).toContain("Alt+I panel · Alt+C comandos");
    });
  });
});
