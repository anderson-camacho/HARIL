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
  shows(text: string): Promise<void>;
  clickRow(needle: string, offset?: number): unknown;
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
  options: { readonly input?: (title: string, placeholder?: string) => string | undefined } = {},
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
  try {
    await run({
      fake,
      ctx,
      input,
      sidebar: () => rows().join("\n"),
      rows,
      shows: (text) => waitFor(() => expect(rows().join("\n")).toContain(text)),
      clickRow(needle, offset = 0) {
        const y = rows().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}\n${rows().join("\n")}`);
        return pane.handleMouse?.({ type: "click", button: "left", x: 8, y: y + offset });
      },
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
      for (const label of ["Última hora", "Último día", "Rango…", "Todo", "Actualizar"]) {
        expect(view, label).toContain(`▸ ${label}`);
      }
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

  it("opens with /haril-plugin 4 as well, and names ACT in the usage text", async () => {
    installProject();
    await withConsole(async (h) => {
      await h.shows("Proyecto: demo");
      await h.command("haril-plugin", "4");
      await h.shows("╭─ Actividad · 3 ");
      await h.command("haril-plugin", "9");
      expect(h.ctx.notes.at(-1)?.[0]).toBe(
        "Uso: /haril-plugin [main|memory|docs|activity|1..4|details]",
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
      expect(h.sidebar()).toContain("▸ Última hora");
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
      expect(view).toContain("▸ Last hour");
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
        expect(view).toContain("| > Última hora");
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
    ["Última hora", ["--since", "1h"]],
    ["Último día", ["--since", "1d"]],
  ])("«%s» reads the events again, filtered, and the filter card says so", async (label, flags) => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.clickRow(`▸ ${label}`);
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
  });

  it("«Todo» goes back to every event, and «Actualizar» reads the same range again", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.clickRow("▸ Última hora");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
      await h.shows("▸ Actualizar");
      h.clickRow("▸ Actualizar");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(3));
      expect(h.eventCalls()[2]).toEqual(h.eventCalls()[1]);
      await h.shows("▸ Todo");
      h.clickRow("▸ Todo");
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
      for (const [index, offset] of [-1, 0, 1].entries()) {
        await h.shows("▸ Último día");
        expect(h.clickRow("▸ Último día", offset), `offset ${offset}`).toEqual({
          handled: true,
          render: true,
        });
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2 + index));
        await waitFor(() => expect(h.sidebar()).toContain("▸ Último día"));
      }
      // The card's own bottom border, one row further, is not the button.
      const before = h.eventCalls().length;
      expect(h.clickRow("▸ Actualizar", 2)).toBeUndefined();
      expect(h.eventCalls()).toHaveLength(before);
    });
  });

  it("show «Cargando…» in place of the buttons while the events are read, then the new events", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      cli.answer("events", { stdout: eventsList(2), delayMs: 400 });
      h.clickRow("▸ Última hora");
      await h.shows("… Cargando…");
      expect(h.sidebar()).not.toContain("▸ Rango…");
      // The events it already had stay on screen meanwhile.
      expect(h.sidebar()).toContain("╭─ Actividad · 3 ");
      await h.shows("╭─ Actividad · 2 ");
      expect(h.sidebar()).toContain("▸ Rango…");
      expect(h.sidebar()).not.toContain("Cargando");
    });
  });

  it("keep the range while the user looks at another tab and comes back", async () => {
    installProject();
    await withConsole(async (h) => {
      await openActivity(h);
      await h.shows("╭─ Actividad · 3 ");
      h.clickRow("▸ Última hora");
      await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
      await h.shows("▸ Rango…");
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
  it("asks twice with the input dialog and filters by what it was given", async () => {
    installProject();
    const answers = ["2026-10-30T08:00:00Z", "2026-10-30T12:00:00Z"];
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        h.clickRow("▸ Rango…");
        await waitFor(() => expect(h.eventCalls()).toHaveLength(2));
        expect(h.input.mock.calls.map(([title]) => title)).toEqual([
          "Actividad · desde (3h, 2d o fecha ISO)",
          "Actividad · hasta (vacío = ahora)",
        ]);
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

  it("takes a duration and an empty end, as «hasta ahora»", async () => {
    installProject();
    const answers = ["3h", ""];
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        h.clickRow("▸ Rango…");
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
    const answers = ["ayer", ""];
    await withConsole(
      async (h) => {
        await openActivity(h);
        await h.shows("╭─ Actividad · 3 ");
        const before = h.sidebar();
        h.clickRow("▸ Rango…");
        await waitFor(() => expect(h.notes()).toContain("«Desde» no es válido"));
        expect(h.ctx.notes.at(-1)?.[1]).toBe("warning");
        expect(h.eventCalls()).toHaveLength(1);
        expect(h.sidebar()).toBe(before);
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
        // The console says some things of its own at start (the models, for one): what matters is that the dialog adds none.
        const before = h.notes();
        h.clickRow("▸ Rango…");
        await waitFor(() => expect(h.input).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.eventCalls()).toHaveLength(1);
        expect(h.notes()).toBe(before);
      },
      { input: () => undefined },
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
