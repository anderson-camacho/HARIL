import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import harilConsole, { type ConsoleOptions } from "../src/console.js";
import type {
  ConsoleComponent,
  ConsoleContext,
  ConsoleTheme,
  ConsoleTui,
} from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";
import {
  engram,
  ensureJson,
  GO_GENTLE,
  gentle,
  install,
  memoryJson,
  PLAN_STDERR,
  statusJson,
  updateJson,
} from "./tools-fixtures.js";

// The MEM tab of the right panel, through the real console: what it shows from `haril tools status --json` and `haril
// memory status --json`, the rows that act on a click and from the Alt+K menu, and the check that runs when the
// console opens. The CLI is a fake one, the Pi a fake one, the right pane the real one. What is NOT exercised here is
// Pi's own terminal: the delivery of real mouse clicks, the toast drawing and the repaint of a real screen.

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };

interface RightPane {
  render(width: number): string[];
  handleMouse?(event: { type: string; button: string; x: number; y: number }): unknown;
}

interface Menu {
  readonly title: string;
  readonly options: readonly string[];
}

interface Harness {
  readonly fake: FakePi;
  readonly ctx: FakeContext;
  readonly menus: Menu[];
  readonly confirm: ReturnType<typeof vi.fn>;
  sidebar(): string;
  shows(text: string): Promise<void>;
  clickRow(needle: string): unknown;
  command(name: string, args: string): Promise<void>;
  // Chooses what the next Alt+K / /haril-panel menu returns, from the options it was given.
  choose: (menu: Menu) => string | undefined;
  // The `haril tools ...` calls the console made, as one string each.
  toolCalls(): string[];
  // The notices the user saw about the tools, leaving out the models line the fake CLI always causes.
  toolNotes(): [string, string | undefined][];
  notes(): string;
}

let root: string;
let cli: FakeCli;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-mem-tab-"));
  cli = installFakeCli();
});

afterEach(() => {
  cli.restore();
  delete process.env.HARIL_TOOLS_CHECK;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const waitFor = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: 15_000, interval: 25 });
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface HarnessOptions {
  readonly console?: ConsoleOptions;
  readonly confirm?: boolean;
  // Do not start the console's session: the caller fires session_start itself.
  readonly manualStart?: boolean;
}

async function withConsole(
  run: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  const fake = fakePi();
  const ctx = fakeContext(tmpdir());
  const menus: Menu[] = [];
  const confirm = vi.fn(async () => options.confirm ?? true);
  let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
  const harness: Harness = {
    fake,
    ctx,
    menus,
    confirm,
    choose: () => undefined,
    sidebar: () => "",
    shows: async () => undefined,
    clickRow: () => undefined,
    command: async () => undefined,
    toolCalls: () => [],
    toolNotes: () => [],
    notes: () => "",
  };
  Object.assign(ctx.ui, {
    confirm,
    select: async (title: string, choices: string[]) => {
      const menu = { title, options: choices };
      menus.push(menu);
      return harness.choose(menu);
    },
    setWidget(key: string, value: typeof anchor) {
      if (key === "haril-native-panes-anchor") anchor = value;
    },
  });
  harilConsole(fake.pi, options.console);
  await fake.fire("session_start", { reason: "startup" }, ctx as ConsoleContext);
  if (!anchor) throw new Error("Expected the console to install its UI");
  const layoutRoot = {
    render: () => ["Pi chat"],
    invalidate: () => undefined,
    [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
  };
  const tui = {
    layoutRoot,
    terminal: { columns: 160, rows: 45 },
    requestRender: () => undefined,
  };
  anchor(tui, THEME);
  const layout = (layoutRoot[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
  const pane = layout.entries.at(-1)?.component;
  if (!pane) throw new Error("Expected the right pane");
  const rows = () => pane.render(40).map(stripAnsi);
  Object.assign(harness, {
    sidebar: () => rows().join("\n"),
    shows: (text: string) => waitFor(() => expect(rows().join("\n")).toContain(text)),
    clickRow(needle: string) {
      const y = rows().findIndex((row) => row.includes(needle));
      if (y < 0) throw new Error(`Row not found: ${needle}\n${rows().join("\n")}`);
      return pane.handleMouse?.({ type: "click", button: "left", x: 8, y });
    },
    command: (name: string, args: string) =>
      fake.commands.get(name)?.handler(args, ctx as ConsoleContext) ?? Promise.resolve(),
    toolCalls: () =>
      cli
        .calls()
        .map((call) => call.args)
        .filter((args) => args[0] === "tools")
        .map((args) => args.join(" ")),
    toolNotes: () => ctx.notes.filter(([message]) => !message.startsWith("HARIL models")),
    notes: () =>
      ctx.notes
        .filter(([message]) => !message.startsWith("HARIL models"))
        .map(([message]) => message)
        .join("\n"),
  });
  try {
    await run(harness);
  } finally {
    await fake.fire("session_shutdown", {}, ctx as ConsoleContext);
  }
}

const open = (h: Harness): Promise<void> => h.command("haril-plugin", "memory");

// Quick: the console starts the check right away in these tests, and the fake CLI answers at once.
const NOW_CHECK: ConsoleOptions = { tools: { checkDelayMs: 0 } };

function answerEverythingOk(): void {
  cli.answer("tools status", { stdout: statusJson([engram(), gentle()]) });
  cli.answer("memory status", { stdout: memoryJson() });
}

describe("the MEM tab through the console", () => {
  it("shows Engram, the memory process and gentle-ai from the two commands, and the rows that act", async () => {
    answerEverythingOk();
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("Engram · ok");
        const view = h.sidebar();
        expect(view).toContain("Proceso de memoria");
        expect(view).toContain("Proveedor: engram · persistente");
        expect(view).toContain("gentle-ai · ok");
        expect(view).toContain("▸ Comprobar e instalar Engram");
        expect(view).toContain("▸ Reinstalar Engram (forzar)");
        expect(view).toContain("▸ Comprobar versiones ahora");
        expect(view).toContain("▸ Actualizar gentle-ai…");
        expect(view).toContain("Memoria y herramientas");
        const calls = cli.calls().map((call) => call.args.join(" "));
        expect(calls).toContain("tools status --json");
        expect(calls).toContain("memory status --json");
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("shows a null provider and a missing Engram plainly, the user's other copy as not used by HARIL", async () => {
    const other = install("C:\\Users\\ana\\go\\bin\\engram.exe", "3.3.2", ["go-bin"], false);
    cli.answer("tools status", {
      stdout: statusJson([
        engram({ state: "missing", active: null, installs: [other], latest: null }),
        gentle(),
      ]),
    });
    cli.answer("memory status", {
      stdout: memoryJson({ provider: "null", persistent: false, runtime: "not_running" }),
    });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("Engram · falta");
        const view = h.sidebar();
        expect(view).toContain("Otras copias, que HARIL no usa:");
        expect(view).toContain("3.3.2 · go/bin");
        expect(view).toContain("Proceso de memoria · NO GUARDA");
        expect(view).toContain("Para activar Engram:");
        // The sentence wraps inside its card: read it without the borders.
        expect(view.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ")).toContain(
          "y reinicia el runtime.",
        );
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("keeps the memory part when the tools command fails, and says why", async () => {
    cli.answer("tools status", { stderr: "haril: tools exploded\n", code: 1 });
    cli.answer("memory status", { stdout: memoryJson() });
    await withConsole(
      async (h) => {
        await open(h);
        // The title is too long for the card's border: its first part stays there and the rest is the first row.
        await h.shows("Engram y gentle-ai");
        expect(h.sidebar()).toContain("no disponible");
        expect(h.sidebar()).toContain("haril: tools exploded");
        expect(h.sidebar()).toContain("Proveedor: engram · persistente");
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });
});

describe("the rows of the MEM tab", () => {
  it("checks and installs Engram on a click, shows it is busy, tells the outcome and shows the new state", async () => {
    cli.answer("tools status", {
      stdout: statusJson([
        engram({ state: "missing", active: null, installs: [], latest: null }),
        gentle(),
      ]),
    });
    cli.answer("memory status", { stdout: memoryJson() });
    cli.answer("tools ensure", {
      stdout: ensureJson({ action: "installed", to: "3.6.0" }),
      delayMs: 400,
    });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("Engram · falta");
        h.clickRow("▸ Comprobar e instalar Engram");
        await h.shows("… Comprobando e instalando Engram");
        // While it runs there are no rows to click twice.
        expect(h.sidebar()).not.toContain("▸ Reinstalar Engram");
        // The state the install leaves behind is what the tab shows when it loads again.
        cli.answer("tools status", { stdout: statusJson([engram(), gentle()]) });
        await waitFor(() =>
          expect(h.notes()).toContain(
            "Engram 3.6.0 instalado. Reinicia el runtime para que lo use.",
          ),
        );
        await h.shows("Engram · ok");
        expect(h.sidebar()).toContain("▸ Comprobar e instalar Engram");
        expect(h.toolCalls()).toContain("tools ensure --json");
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("forces a reinstall with --force", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "updated", to: "3.6.0" }) });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Reinstalar Engram (forzar)");
        h.clickRow("▸ Reinstalar Engram");
        await waitFor(() => expect(h.toolCalls()).toContain("tools ensure --force --json"));
        await waitFor(() => expect(h.notes()).toContain("Engram 3.6.0 configurado."));
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("looks the latest versions up on a click, says what it found and loads the tab again", async () => {
    const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
    cli.answer("tools status", {
      stdout: statusJson([
        engram(),
        gentle({
          state: "unknown",
          active: old,
          installs: [old],
          latest: null,
          latestCheckedAt: null,
        }),
      ]),
    });
    cli.answer("memory status", { stdout: memoryJson() });
    cli.answer("tools status --refresh", {
      stdout: statusJson([
        engram(),
        gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
      ]),
    });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("gentle-ai · desconocido");
        // The refresh is what makes the next `tools status` know the latest version.
        h.clickRow("▸ Comprobar versiones ahora");
        await waitFor(() => expect(h.toolCalls()).toContain("tools status --refresh --json"));
        cli.answer("tools status", {
          stdout: statusJson([
            engram(),
            gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
          ]),
        });
        await waitFor(() =>
          expect(h.notes()).toContain(
            "gentle-ai 4.0.0 → 4.3.1 disponible: Alt+L → MEM → Actualizar.",
          ),
        );
        await h.shows("gentle-ai · desactualizado");
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("shows the plan of the gentle-ai update, and runs it with --yes only after a yes", async () => {
    answerEverythingOk();
    cli.answer("tools update gentle-ai --json", { stderr: PLAN_STDERR, code: 2 });
    cli.answer("tools update gentle-ai --yes --json", {
      stdout: updateJson({ action: "updated", from: "4.0.0", to: "4.3.1", path: GO_GENTLE }),
    });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Actualizar gentle-ai…");
        h.clickRow("▸ Actualizar gentle-ai");
        await waitFor(() => expect(h.notes()).toContain("gentle-ai 4.0.0 → 4.3.1 actualizado."));
        expect(h.confirm).toHaveBeenCalledTimes(1);
        const [title, message] = h.confirm.mock.calls[0] as unknown as [string, string];
        expect(title).toBe("Actualizar gentle-ai");
        expect(message).toContain("@v4.3.1");
        expect(h.toolCalls().filter((call) => call.startsWith("tools update"))).toEqual([
          "tools update gentle-ai --json",
          "tools update gentle-ai --yes --json",
        ]);
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("does nothing when the gentle-ai update is declined", async () => {
    answerEverythingOk();
    cli.answer("tools update gentle-ai --json", { stderr: PLAN_STDERR, code: 2 });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Actualizar gentle-ai…");
        h.clickRow("▸ Actualizar gentle-ai");
        await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(h.sidebar()).toContain("▸ Actualizar gentle-ai…"));
        await pause(80);
        expect(h.toolCalls().filter((call) => call.startsWith("tools update"))).toEqual([
          "tools update gentle-ai --json",
        ]);
        expect(h.notes()).toBe("");
      },
      { confirm: false, console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("opens one operation at a time even if a row is clicked twice", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }), delayMs: 300 });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Comprobar e instalar Engram");
        h.clickRow("▸ Comprobar e instalar Engram");
        await h.shows("… Comprobando e instalando Engram");
        // The rows are gone while it runs: a second click on that spot finds no action.
        h.clickRow("… Comprobando e instalando Engram");
        await waitFor(() => expect(h.notes()).toContain("Engram al día (3.6.0)."));
        expect(h.toolCalls().filter((call) => call.startsWith("tools ensure"))).toHaveLength(1);
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });
});

describe("the MEM rows from the Alt+K menu", () => {
  const presses: [string, (h: Harness) => void][] = [
    [
      "Alt+K",
      (h) => {
        h.fake.shortcuts.get("alt+k")?.(h.ctx as ConsoleContext);
      },
    ],
    [
      "/haril-panel",
      (h) => {
        void h.command("haril-panel", "");
      },
    ],
  ];
  it.each(presses)(
    "%s lists the rows of the tab on screen and runs the one chosen",
    async (_name, press) => {
      answerEverythingOk();
      cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }) });
      await withConsole(
        async (h) => {
          await open(h);
          await h.shows("▸ Comprobar e instalar Engram");
          h.choose = (menu) =>
            menu.options.find((option) => option.includes("Comprobar e instalar"));
          press(h);
          await waitFor(() => expect(h.menus).toHaveLength(1));
          const [menu] = h.menus;
          expect(menu?.title).toBe("Panel derecho");
          expect(menu?.options.slice(0, 4)).toEqual([
            "MEM · Comprobar e instalar Engram",
            "MEM · Reinstalar Engram (forzar)",
            "MEM · Comprobar versiones ahora",
            "MEM · Actualizar gentle-ai…",
          ]);
          // The rail's own entries are still there, after the rows of the view.
          expect(menu?.options).toContain("Cambiar modo");
          await waitFor(() => expect(h.toolCalls()).toContain("tools ensure --json"));
          await waitFor(() => expect(h.notes()).toContain("Engram al día (3.6.0)."));
        },
        { console: { tools: { checkDelayMs: 60_000 } } },
      );
    },
  );

  it("offers no rows of a view while the tab on screen has none (MAIN)", async () => {
    await withConsole(
      async (h) => {
        h.choose = () => undefined;
        h.fake.shortcuts.get("alt+k")?.(h.ctx as ConsoleContext);
        await waitFor(() => expect(h.menus).toHaveLength(1));
        expect(h.menus[0]?.options.some((option) => option.startsWith("MEM ·"))).toBe(false);
        expect(h.menus[0]?.options.some((option) => option.startsWith("DOCS ·"))).toBe(false);
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });

  it("does not offer the rows while an operation runs", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }), delayMs: 600 });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Comprobar e instalar Engram");
        h.clickRow("▸ Comprobar e instalar Engram");
        await h.shows("… Comprobando e instalando Engram");
        h.fake.shortcuts.get("alt+k")?.(h.ctx as ConsoleContext);
        await waitFor(() => expect(h.menus).toHaveLength(1));
        expect(h.menus[0]?.options.some((option) => option.startsWith("MEM ·"))).toBe(false);
        await waitFor(() => expect(h.notes()).toContain("Engram al día (3.6.0)."));
      },
      { console: { tools: { checkDelayMs: 60_000 } } },
    );
  });
});

describe("the check when the console opens", () => {
  it("runs `haril tools ensure --json` in the background and tells what happened, once", async () => {
    answerEverythingOk();
    const old = install(GO_GENTLE, "4.0.0", ["go-bin"]);
    cli.answer("tools ensure", {
      stdout: ensureJson({ action: "installed", to: "3.6.0" }, [
        engram(),
        gentle({ state: "outdated", active: old, installs: [old], latest: "4.3.1" }),
      ]),
      delayMs: 300,
    });
    await withConsole(
      async (h) => {
        // session_start has already returned: the check is not waited for.
        await waitFor(() => expect(h.toolNotes()).toHaveLength(1));
        expect(h.toolNotes()[0]).toEqual([
          "Engram 3.6.0 instalado. Reinicia el runtime para que lo use.\ngentle-ai 4.0.0 → 4.3.1 disponible: Alt+L → MEM → Actualizar.",
          "info",
        ]);
        await pause(120);
        expect(h.toolNotes()).toHaveLength(1);
        expect(h.toolCalls().filter((call) => call === "tools ensure --json")).toHaveLength(1);
      },
      { console: NOW_CHECK },
    );
  });

  it("does not hold session_start back", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }), delayMs: 2_000 });
    const fake = fakePi();
    const ctx = fakeContext(tmpdir());
    harilConsole(fake.pi, NOW_CHECK);
    const before = Date.now();
    await fake.fire("session_start", { reason: "startup" }, ctx as ConsoleContext);
    expect(Date.now() - before).toBeLessThan(1_000);
    await fake.fire("session_shutdown", {}, ctx as ConsoleContext);
  });

  it("says nothing when everything is current", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }) });
    await withConsole(
      async (h) => {
        await waitFor(() => expect(h.toolCalls()).toContain("tools ensure --json"));
        await pause(250);
        expect(h.toolNotes()).toEqual([]);
      },
      { console: NOW_CHECK },
    );
  });

  it("swallows a CLI that fails: no notice, the tab says the check failed", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stderr: "boom\n", code: 1 });
    await withConsole(
      async (h) => {
        await open(h);
        await waitFor(() => expect(h.toolCalls()).toContain("tools ensure --json"));
        await h.shows("Comprobación al arrancar");
        expect(h.sidebar()).toContain("falló: boom");
        expect(h.toolNotes()).toEqual([]);
      },
      { console: NOW_CHECK },
    );
  });

  it.each(["off", "0", "false"])("is skipped with HARIL_TOOLS_CHECK=%s", async (value) => {
    process.env.HARIL_TOOLS_CHECK = value;
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "installed", to: "3.6.0" }) });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("Engram · ok");
        await pause(250);
        expect(h.toolCalls().filter((call) => call.startsWith("tools ensure"))).toEqual([]);
        expect(h.toolNotes()).toEqual([]);
      },
      { console: NOW_CHECK },
    );
  });

  it("loads the MEM tab again when it ends while that tab is on screen", async () => {
    cli.answer("tools status", {
      stdout: statusJson([
        engram({ state: "missing", active: null, installs: [], latest: null }),
        gentle(),
      ]),
    });
    cli.answer("memory status", { stdout: memoryJson() });
    cli.answer("tools ensure", {
      stdout: ensureJson({ action: "installed", to: "3.6.0" }),
      delayMs: 500,
    });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("Engram · falta");
        await h.shows("… Comprobando Engram y gentle-ai");
        cli.answer("tools status", { stdout: statusJson([engram(), gentle()]) });
        await h.shows("Engram · ok");
        expect(h.sidebar()).toContain("▸ Comprobar e instalar Engram");
      },
      { console: NOW_CHECK },
    );
  });

  it("does not start when the session closes before its moment, and starts for the next session", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }) });
    const fake = fakePi();
    const first = fakeContext(tmpdir());
    harilConsole(fake.pi, { tools: { checkDelayMs: 200 } });
    await fake.fire("session_start", { reason: "startup" }, first as ConsoleContext);
    await fake.fire("session_shutdown", {}, first as ConsoleContext);
    await pause(400);
    expect(
      cli.calls().filter((call) => call.args[0] === "tools" && call.args[1] === "ensure"),
    ).toEqual([]);
    const second = fakeContext(tmpdir());
    await fake.fire("session_start", { reason: "new" }, second as ConsoleContext);
    await waitFor(() =>
      expect(
        cli.calls().filter((call) => call.args[0] === "tools" && call.args[1] === "ensure"),
      ).toHaveLength(1),
    );
    await fake.fire("session_shutdown", {}, second as ConsoleContext);
  });

  it("runs once per console process, however many sessions start", async () => {
    answerEverythingOk();
    cli.answer("tools ensure", { stdout: ensureJson({ action: "none" }) });
    const fake = fakePi();
    harilConsole(fake.pi, NOW_CHECK);
    const first = fakeContext(tmpdir());
    await fake.fire("session_start", { reason: "startup" }, first as ConsoleContext);
    await waitFor(() => expect(cli.calls().some((call) => call.args[1] === "ensure")).toBe(true));
    await pause(150);
    const second = fakeContext(tmpdir());
    await fake.fire("session_start", { reason: "new" }, second as ConsoleContext);
    await pause(250);
    expect(
      cli.calls().filter((call) => call.args[0] === "tools" && call.args[1] === "ensure"),
    ).toHaveLength(1);
    await fake.fire("session_shutdown", {}, second as ConsoleContext);
  });

  it("runs through the injected `run`, with no CLI at all", async () => {
    // No fake CLI answers here, and this Pi was not opened by haril: only the seam is called.
    cli.restore();
    const calls: string[] = [];
    const fake = fakePi();
    const ctx = fakeContext(tmpdir());
    harilConsole(fake.pi, {
      tools: {
        checkDelayMs: 0,
        run: async (args) => {
          calls.push(args.join(" "));
          return {
            ok: true,
            code: 0,
            stdout: ensureJson({ action: "installed", to: "3.6.0" }),
            stderr: "",
          };
        },
      },
    });
    await fake.fire("session_start", { reason: "startup" }, ctx as ConsoleContext);
    await waitFor(() => expect(ctx.notes).toHaveLength(1));
    expect(calls).toContain("tools ensure --json");
    await fake.fire("session_shutdown", {}, ctx as ConsoleContext);
    cli = installFakeCli();
  });
});
