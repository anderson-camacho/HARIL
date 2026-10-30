import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import type {
  ConsoleComponent,
  ConsoleContext,
  ConsoleTheme,
  ConsoleTui,
} from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";
import { type FakeContext, type FakePi, fakeContext, fakePi } from "./fake-pi.js";

// The DOCS tab of the right panel: it shows the documentation folder the user connected, and its rows connect, change
// or disconnect it. Everything goes through the HARIL CLI (`haril config set docs.path`), never into the folder. These
// tests drive the real console with a fake CLI, a fake Pi and the real right pane. Real input prompts and the
// delivery of real mouse clicks by Pi's terminal are not exercised here.

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };
const PROMPT_ES = "Ruta de la carpeta de documentación";

interface RightPane {
  render(width: number): string[];
  handleMouse?(event: { type: string; button: string; x: number; y: number }): unknown;
}

interface Harness {
  readonly fake: FakePi;
  readonly ctx: FakeContext;
  readonly input: ReturnType<typeof vi.fn>;
  // The text of the right pane, as the user sees it.
  sidebar(): string;
  // Waits until the right pane shows `text`: the tab loads through the CLI, and so does the console at start.
  shows(text: string): Promise<void>;
  // Clicks the row of the right pane that shows `needle`.
  clickRow(needle: string): unknown;
  command(name: string, args: string): Promise<void>;
  // The `haril config set|get docs.path ...` calls the console made, with their arguments.
  setCalls(): string[][];
  getCalls(): string[][];
  // The notifications the user saw.
  notes(): string;
}

let root: string;
let cli: FakeCli;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-docs-tab-"));
  cli = installFakeCli();
});

afterEach(() => {
  cli.restore();
  // A fake CLI that is still ending holds the folder as its working directory for a moment.
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// A vault with one note, on disk, so the tab has something real to read. It has a space in its name on purpose.
function makeVault(): string {
  const vault = join(root, "Mi Boveda");
  mkdirSync(join(vault, ".obsidian"), { recursive: true });
  writeFileSync(join(vault, "Idea.md"), "# Una idea\n");
  writeFileSync(join(vault, ".obsidian", "app.md"), "# no\n");
  return vault;
}

const connected = (value: string | null) =>
  JSON.stringify({ path: "docs.path", value, source: value === null ? "unset" : "file" });
const stored = (value: string | null) => JSON.stringify({ path: "docs.path", value });

async function withConsole(
  run: (harness: Harness) => Promise<void>,
  options: { readonly input?: (title: string, placeholder?: string) => string | undefined } = {},
): Promise<void> {
  const fake = fakePi();
  // The console runs the CLI in the folder Pi opened in, so it has to exist (and not be one the test removes).
  const ctx = fakeContext(tmpdir());
  const input = vi.fn(async (title: string, placeholder?: string) =>
    options.input?.(title, placeholder),
  );
  let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
  Object.assign(ctx.ui, {
    input,
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
    terminal: { columns: 160, rows: 45 },
    requestRender: () => undefined,
  };
  anchor(tui, THEME);
  const layout = (layoutRoot[LAYOUT_NODE] as () => { entries: { component: RightPane }[] })();
  const pane = layout.entries.at(-1)?.component;
  if (!pane) throw new Error("Expected the right pane");
  const rows = () => pane.render(40).map(stripAnsi);
  const callsOf = (verb: string) =>
    cli
      .calls()
      .map((call) => call.args)
      .filter((args) => args[0] === "config" && args[1] === verb && args[2] === "docs.path");
  try {
    await run({
      fake,
      ctx,
      input,
      sidebar: () => rows().join("\n"),
      shows: (text) => vi.waitFor(() => expect(rows().join("\n")).toContain(text)),
      clickRow(needle) {
        const y = rows().findIndex((row) => row.includes(needle));
        if (y < 0) throw new Error(`Row not found: ${needle}\n${rows().join("\n")}`);
        return pane.handleMouse?.({ type: "click", button: "left", x: 8, y });
      },
      command: (name, args) =>
        fake.commands.get(name)?.handler(args, ctx as ConsoleContext) ?? Promise.resolve(),
      setCalls: () => callsOf("set"),
      getCalls: () => callsOf("get"),
      notes: () => ctx.notes.map(([message]) => message).join("\n"),
    });
  } finally {
    await fake.fire("session_shutdown", {}, ctx as ConsoleContext);
  }
}

const open = async (h: Harness): Promise<void> => h.command("haril-plugin", "docs");

describe("the DOCS tab with no folder connected", () => {
  it("invites to connect one, and /haril-docs is registered", async () => {
    cli.answer("config get docs.path", { stdout: connected(null) });
    await withConsole(async (h) => {
      await open(h);
      await h.shows("Sin carpeta conectada.");
      expect(h.sidebar()).toContain("▸ Definir carpeta…");
      expect(h.sidebar()).not.toContain("ACTIVIDAD");
      expect(h.fake.commands.has("haril-docs")).toBe(true);
    });
  });

  it("asks for the path on a click, runs `config set docs.path` with it trimmed, and shows the folder", async () => {
    const vault = makeVault();
    cli.answer("config get docs.path", { stdout: connected(null) });
    cli.answer("config set docs.path", { stdout: stored(vault) });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Definir carpeta…");
        h.clickRow("Definir carpeta…");
        await vi.waitFor(() => expect(h.setCalls()).toHaveLength(1));
        expect(h.input).toHaveBeenCalledWith(PROMPT_ES, "");
        expect(h.setCalls()[0]).toEqual(["config", "set", "docs.path", vault, "--json"]);
        await vi.waitFor(() =>
          expect(h.notes()).toContain(`Carpeta de documentación conectada: ${vault}`),
        );
        // The tab loads again and now shows the folder and its notes, and not what the editor keeps for itself.
        await h.shows("1 nota .md");
        expect(h.sidebar()).toContain("Idea.md");
        expect(h.sidebar()).not.toContain("app.md");
        expect(h.sidebar()).toContain("▸ Cambiar carpeta…");
        expect(h.sidebar()).toContain("▸ Desconectar");
      },
      {
        // The CLI persists what was set: from now on `get` answers with the vault.
        input: () => {
          cli.answer("config get docs.path", { stdout: connected(vault) });
          return `   ${vault}  `;
        },
      },
    );
  });

  it.each([
    ["is cancelled", undefined],
    ["is left empty", ""],
    ["is only blanks", "    "],
  ])("does nothing when the input %s", async (_name, answer) => {
    cli.answer("config get docs.path", { stdout: connected(null) });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Definir carpeta…");
        h.clickRow("Definir carpeta…");
        await vi.waitFor(() => expect(h.input).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(h.setCalls()).toEqual([]);
        expect(h.notes()).not.toMatch(/documentaci|docs\.path/i);
        expect(h.sidebar()).toContain("Sin carpeta conectada.");
      },
      { input: () => answer },
    );
  });

  it("shows the CLI's own message when the path is refused, and keeps the tab as it was", async () => {
    cli.answer("config get docs.path", { stdout: connected(null) });
    cli.answer("config set docs.path", {
      stderr: "haril: docs.path was not changed; Z:\\nada is not an existing directory\n",
      code: 2,
    });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Definir carpeta…");
        h.clickRow("Definir carpeta…");
        await vi.waitFor(() => expect(h.notes()).toContain("is not an existing directory"));
        const note = h.ctx.notes.find(([message]) => message.includes("not an existing"));
        expect(note?.[1]).toBe("error");
        expect(note?.[0]).toContain("Z:\\nada");
        expect(h.sidebar()).toContain("Sin carpeta conectada.");
      },
      { input: () => "Z:\\nada" },
    );
  });

  it("opens a single prompt even if the row is clicked twice", async () => {
    cli.answer("config get docs.path", { stdout: connected(null) });
    let release: ((value: string | undefined) => void) | undefined;
    await withConsole(async (h) => {
      Object.assign(h.ctx.ui, {
        input: vi.fn(
          () =>
            new Promise<string | undefined>((resolve) => {
              release = resolve;
            }),
        ),
      });
      await open(h);
      await h.shows("▸ Definir carpeta…");
      h.clickRow("Definir carpeta…");
      await vi.waitFor(() => expect(release).toBeDefined());
      h.clickRow("Definir carpeta…");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((h.ctx.ui.input as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      release?.(undefined);
    });
  });
});

describe("the DOCS tab with a folder connected", () => {
  it("proposes the current path when the folder is changed", async () => {
    const vault = makeVault();
    const other = join(root, "Otra");
    cli.answer("config get docs.path", { stdout: connected(vault) });
    cli.answer("config set docs.path", { stdout: stored(other) });
    await withConsole(
      async (h) => {
        await open(h);
        await h.shows("▸ Cambiar carpeta…");
        h.clickRow("Cambiar carpeta…");
        await vi.waitFor(() => expect(h.setCalls()).toHaveLength(1));
        expect(h.input).toHaveBeenCalledWith(PROMPT_ES, vault);
        expect(h.setCalls()[0]).toEqual(["config", "set", "docs.path", other, "--json"]);
      },
      { input: () => other },
    );
  });

  it("disconnects with --reset on a click, without asking, and loads the tab again", async () => {
    const vault = makeVault();
    cli.answer("config get docs.path", { stdout: connected(vault) });
    cli.answer("config set docs.path", { stdout: stored(null) });
    await withConsole(async (h) => {
      await open(h);
      await h.shows("▸ Desconectar");
      cli.answer("config get docs.path", { stdout: connected(null) });
      h.clickRow("Desconectar");
      await vi.waitFor(() => expect(h.setCalls()).toHaveLength(1));
      expect(h.setCalls()[0]).toEqual(["config", "set", "docs.path", "--reset", "--json"]);
      expect(h.input).not.toHaveBeenCalled();
      await h.shows("Sin carpeta conectada.");
      expect(h.notes()).toContain("Carpeta de documentación desconectada.");
    });
  });

  it("says the folder was not found when it is gone, and still offers to change or disconnect it", async () => {
    cli.answer("config get docs.path", { stdout: connected(join(root, "desconectada")) });
    await withConsole(async (h) => {
      await open(h);
      await h.shows("Carpeta no encontrada");
      expect(h.sidebar()).toContain("▸ Cambiar carpeta…");
      expect(h.sidebar()).toContain("▸ Desconectar");
    });
  });

  it("draws a long path in the panel's own width, keeping its end", async () => {
    const path = `C:\\Users\\ana\\Documentos\\Obsidian\\Bovedas\\Trabajo\\${"x".repeat(10)}\\MiBoveda`;
    cli.answer("config get docs.path", { stdout: connected(path) });
    await withConsole(async (h) => {
      await open(h);
      await h.shows("Carpeta no encontrada:");
      // 37 columns of the path's end, behind an ellipsis: the pane gives a row 38, and does not cut one of them.
      const tail = `…${path.slice(-37)}`;
      expect(h.sidebar()).toContain(`│ ${tail}`);
    });
  });

  it("shows what haril.json says when it cannot be read, with no folder row to run", async () => {
    cli.answer("config get docs.path", {
      stderr: "haril: C:\\h\\haril.json has problems; fix them first (haril doctor lists them):\n",
      code: 2,
    });
    await withConsole(async (h) => {
      await open(h);
      await h.shows("No se pudo leer");
      // The message wraps to the width of the panel; its words are all there.
      expect(h.sidebar()).toContain("haril.json has problems;");
      expect(h.sidebar()).toContain("fix them first");
      expect(h.sidebar()).not.toContain("▸");
    });
  });
});

describe("/haril-docs", () => {
  it("without an argument opens the same input, and sets what is typed", async () => {
    const vault = makeVault();
    cli.answer("config get docs.path", { stdout: connected(null) });
    cli.answer("config set docs.path", { stdout: stored(vault) });
    await withConsole(
      async (h) => {
        await h.command("haril-docs", "");
        expect(h.input).toHaveBeenCalledWith(PROMPT_ES, "");
        expect(h.setCalls()).toEqual([["config", "set", "docs.path", vault, "--json"]]);
      },
      { input: () => vault },
    );
  });

  it("without an argument and with the input cancelled changes nothing", async () => {
    cli.answer("config get docs.path", { stdout: connected(null) });
    await withConsole(
      async (h) => {
        await h.command("haril-docs", "");
        expect(h.input).toHaveBeenCalled();
        expect(h.setCalls()).toEqual([]);
        expect(h.notes()).not.toMatch(/documentaci|docs\.path/i);
      },
      { input: () => undefined },
    );
  });

  it("with a path sets it without asking, keeping the spaces inside it", async () => {
    const vault = makeVault();
    expect(vault).toContain(" ");
    cli.answer("config set docs.path", { stdout: stored(vault) });
    await withConsole(async (h) => {
      await h.command("haril-docs", `  ${vault}  `);
      expect(h.input).not.toHaveBeenCalled();
      expect(h.setCalls()).toEqual([["config", "set", "docs.path", vault, "--json"]]);
      expect(h.notes()).toContain(vault);
    });
  });

  it("with `clear` disconnects the folder", async () => {
    cli.answer("config set docs.path", { stdout: stored(null) });
    await withConsole(async (h) => {
      await h.command("haril-docs", "clear");
      expect(h.setCalls()).toEqual([["config", "set", "docs.path", "--reset", "--json"]]);
      expect(h.input).not.toHaveBeenCalled();
      expect(h.notes()).toContain("Carpeta de documentación desconectada.");
    });
  });

  it("shows the CLI's message as an error when the path is refused", async () => {
    cli.answer("config set docs.path", {
      stderr:
        "haril: docs.path was not changed; C:\\h\\haril.json would have these problems:\n  /docs/path: must be an absolute path\n",
      code: 2,
    });
    await withConsole(async (h) => {
      await h.command("haril-docs", "vault");
      const note = h.ctx.notes.at(-1);
      expect(note?.[1]).toBe("error");
      expect(note?.[0]).toContain("docs.path was not changed");
      expect(note?.[0]).toContain("/docs/path: must be an absolute path");
    });
  });

  it("keeps the tab the user is on: setting a path from MAIN does not switch to DOCS", async () => {
    const vault = makeVault();
    cli.answer("config get docs.path", { stdout: connected(vault) });
    cli.answer("config set docs.path", { stdout: stored(vault) });
    await withConsole(async (h) => {
      await h.command("haril-docs", vault);
      expect(h.notes()).toContain(vault);
      expect(h.sidebar()).toContain("ACTIVIDAD");
      expect(h.sidebar()).toContain("[1:MAIN]");
    });
  });

  it("reloads the tab when it is the one on screen", async () => {
    const vault = makeVault();
    cli.answer("config get docs.path", { stdout: connected(null) });
    cli.answer("config set docs.path", { stdout: stored(vault) });
    await withConsole(async (h) => {
      await open(h);
      await h.shows("Sin carpeta conectada.");
      cli.answer("config get docs.path", { stdout: connected(vault) });
      await h.command("haril-docs", vault);
      await h.shows("1 nota .md");
    });
  });
});
