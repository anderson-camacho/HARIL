import { describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import type {
  ConsoleComponent,
  ConsoleContext,
  ConsoleMouseEvent,
  ConsoleTheme,
  ConsoleTui,
} from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { installFakeCli } from "./fake-cli.js";
import { type FakePi, fakeContext, fakePi } from "./fake-pi.js";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };

describe("native dock integration with the HARIL Pi extension", () => {
  it("mounts as a zero-row widget, replaces giant header, keeps Pi's chat and restores on exit", async () => {
    const envNode = process.env.HARIL_NODE;
    const envCli = process.env.HARIL_CLI;
    delete process.env.HARIL_NODE;
    delete process.env.HARIL_CLI;
    try {
      const fake = fakePi();
      const ctx = fakeContext();
      let header: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
      let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
      Object.assign(ctx.ui, {
        setHeader(value: typeof header) {
          header = value;
        },
        setWidget(key: string, value: typeof anchor) {
          if (key === "haril-native-panes-anchor") anchor = value;
        },
      });
      harilConsole(fake.pi);
      await fake.fire("session_start", { reason: "startup" }, ctx);
      expect(anchor).toBeDefined();
      expect(fake.commands.has("haril-plugins")).toBe(true);
      expect(fake.commands.has("haril-extensions")).toBe(true);
      expect(fake.commands.has("haril-dock")).toBe(true);
      expect(fake.commands.has("haril-plugin")).toBe(true);
      expect(fake.commands.has("haril-commands")).toBe(true);
      expect(fake.commands.has("haril-theme")).toBe(true);
      expect(fake.shortcuts.has("alt+c")).toBe(true);
      expect(fake.shortcuts.has("alt+l")).toBe(true);
      expect(fake.shortcuts.has("alt+i")).toBe(true);
      expect(fake.shortcuts.has("alt+k")).toBe(true);
      expect(fake.commands.has("haril-panel")).toBe(true);
      expect(fake.shortcuts.has("alt+z")).toBe(false);
      expect(fake.shortcuts.has("alt+r")).toBe(false);

      const original = () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] });
      const root = {
        render: () => ["Pi chat"],
        invalidate: () => undefined,
        [LAYOUT_NODE]: original,
      };
      const tui = {
        layoutRoot: root,
        terminal: { columns: 160, rows: 45 },
        requestRender: () => undefined,
      };
      expect(anchor?.(tui, THEME).render(160)).toEqual([]);
      const newLayout = (
        root[LAYOUT_NODE] as () => {
          type: string;
          entries: { component: { render(width: number): string[] } }[];
        }
      )();
      expect(newLayout.type).toBe("hstack");
      expect(newLayout.entries).toHaveLength(2);
      const middle = newLayout.entries[0];
      const rightPane = newLayout.entries[1];
      if (!middle || !rightPane) throw new Error("Expected Pi panes");
      expect(middle.component.render(60)).toEqual(["Pi chat"]);

      const newHeader = header?.(tui, THEME).render(96).map(stripAnsi).join("\n");
      expect(newHeader).toContain("HARIL");
      expect(newHeader).not.toContain("██████");
      expect(newHeader?.split("\n")).toHaveLength(1);
      // The console opens on MAIN: the tabs and, under them, the status block.
      const right = rightPane.component.render(40).map(stripAnsi).join("\n");
      expect(right).toContain("ÁREAS");
      expect(right).toContain("Alt+K menú del panel");
      // The recent events are the ACT tab's, not MAIN's.
      expect(right).not.toContain("ACTIVIDAD");
      expect(right).toContain("Espacio: Principal");
      expect(right).toContain("[1:MAIN]");
      expect(right).not.toContain("GIT");

      // DOCS shows its own view and none of the status block; MAIN brings the block back.
      await fake.commands.get("haril-plugin")?.handler("docs", ctx);
      const docs = rightPane.component.render(40).map(stripAnsi).join("\n");
      expect(docs).toContain("Espacio: Documentación");
      expect(docs).toContain("Sin carpeta conectada.");
      expect(docs).toContain("Definir carpeta…");
      expect(docs).not.toContain("ÁREAS");
      expect(docs).not.toContain("Estoy en");
      await fake.commands.get("haril-plugin")?.handler("main", ctx);
      const main = rightPane.component.render(40).map(stripAnsi).join("\n");
      expect(main).toContain("ÁREAS");
      expect(main).toContain("Estoy en");

      // The views that were removed are no longer a target of the command, and it says what is.
      ctx.notes.length = 0;
      await fake.commands.get("haril-plugin")?.handler("youtube", ctx);
      expect(ctx.notes.at(-1)?.[0]).toBe(
        "Uso: /haril-plugin [main|tools|docs|activity|actions|1..5|details]",
      );
      expect(rightPane.component.render(40).map(stripAnsi).join("\n")).toContain("ÁREAS");

      await fake.fire("session_shutdown", {}, ctx);
      expect(root[LAYOUT_NODE]).toBe(original);
    } finally {
      if (envNode === undefined) delete process.env.HARIL_NODE;
      else process.env.HARIL_NODE = envNode;
      if (envCli === undefined) delete process.env.HARIL_CLI;
      else process.env.HARIL_CLI = envCli;
    }
  });
});

// The bottom bar follows where the status is: one line when the sidebar holds it, the full bar with the folder line
// and the warnings count when it does not. The clickable areas line sits right under whichever bar is drawn.
describe("the bottom bar beside the native dock", () => {
  type FooterComponent = {
    render(width: number): string[];
    handleMouse?(event: ConsoleMouseEvent): unknown;
  };
  type Footer = (
    tui: ConsoleTui,
    theme: ConsoleTheme,
    data: {
      getGitBranch(): string | null;
      getExtensionStatuses(): Map<string, string>;
      onBranchChange(listener: () => void): () => void;
    },
  ) => FooterComponent;

  interface Harness {
    readonly fake: FakePi;
    readonly ctx: ConsoleContext;
    readonly tui: { terminal: { columns: number; rows: number }; requestRender: () => void };
    readonly requestRender: ReturnType<typeof vi.fn>;
    lines(): string[];
    // The text of the native right pane, as the user sees it.
    sidebar(): string;
    click(x: number, y: number): unknown;
    plugin(word: string): Promise<void>;
  }

  // `keepCli`: leave HARIL_NODE and HARIL_CLI alone, for a test that installs a fake CLI of its own.
  async function withDock(
    run: (harness: Harness) => Promise<void>,
    options: { readonly keepCli?: boolean } = {},
  ): Promise<void> {
    const envNode = process.env.HARIL_NODE;
    const envCli = process.env.HARIL_CLI;
    if (options.keepCli !== true) {
      delete process.env.HARIL_NODE;
      delete process.env.HARIL_CLI;
    }
    const fake = fakePi();
    const ctx = fakeContext();
    let anchor: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined;
    let footer: Footer | undefined;
    Object.assign(ctx.ui, {
      setFooter(value: Footer) {
        footer = value;
      },
      setWidget(key: string, value: typeof anchor) {
        if (key === "haril-native-panes-anchor") anchor = value;
      },
    });
    try {
      harilConsole(fake.pi);
      await fake.fire("session_start", { reason: "startup" }, ctx);
      if (!anchor || !footer) throw new Error("Expected the console to install its UI");
      const root = {
        render: () => ["Pi chat"],
        invalidate: () => undefined,
        [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
      };
      const requestRender = vi.fn();
      const tui = {
        layoutRoot: root,
        terminal: { columns: 160, rows: 45 },
        requestRender,
      };
      anchor(tui, THEME);
      const layout = (
        root[LAYOUT_NODE] as () => { entries: { component: { render(width: number): string[] } }[] }
      )();
      const sidebar = layout.entries.at(-1)?.component;
      if (!sidebar) throw new Error("Expected the right pane");
      const component = footer(tui, THEME, {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        onBranchChange: () => () => undefined,
      });
      await run({
        fake,
        ctx,
        tui,
        requestRender,
        lines: () => component.render(tui.terminal.columns).map(stripAnsi),
        sidebar: () => sidebar.render(40).map(stripAnsi).join("\n"),
        click: (x, y) =>
          component.handleMouse?.({
            type: "click",
            button: "left",
            x,
            y,
            width: tui.terminal.columns,
            height: tui.terminal.rows,
            shift: false,
            alt: false,
            ctrl: false,
          }),
        plugin: (word) =>
          fake.commands.get("haril-plugin")?.handler(word, ctx) ?? Promise.resolve(),
      });
      await fake.fire("session_shutdown", {}, ctx);
    } finally {
      if (options.keepCli !== true) {
        if (envNode === undefined) delete process.env.HARIL_NODE;
        else process.env.HARIL_NODE = envNode;
        if (envCli === undefined) delete process.env.HARIL_CLI;
        else process.env.HARIL_CLI = envCli;
      }
    }
  }

  it("is the bar and the areas line, with no folder line, while MAIN shows the status in the sidebar", async () => {
    await withDock(async ({ lines }) => {
      const drawn = lines();
      expect(drawn).toHaveLength(2);
      expect(drawn[0]).toContain("◆ HARIL");
      expect(drawn[0]).toContain("■ STOP ALL");
      expect(drawn.join("\n")).not.toContain("fake-cwd");
      expect(drawn[1]).toContain("[1 AGENTS]");
    });
  });

  it("is the full bar, with the folder line, as soon as another tab is selected, and compact again on MAIN", async () => {
    await withDock(async ({ lines, plugin, requestRender }) => {
      expect(lines()).toHaveLength(2);
      const before = requestRender.mock.calls.length;
      await plugin("memory");
      // The footer is drawn again on the request that selecting a tab makes.
      expect(requestRender.mock.calls.length).toBeGreaterThan(before);
      const full = lines();
      expect(full).toHaveLength(3);
      expect(full[1]).toContain("fake-cwd");
      expect(full[1]).toContain("(main)");
      expect(full[2]).toContain("[1 AGENTS]");
      await plugin("docs");
      expect(lines()).toHaveLength(3);
      await plugin("main");
      expect(lines()).toHaveLength(2);
    });
  });

  it("follows Alt+I: the full bar when the sidebar is closed, compact when it opens again", async () => {
    await withDock(async ({ fake, ctx, lines, requestRender }) => {
      const alt = fake.shortcuts.get("alt+i");
      expect(lines()).toHaveLength(2);
      const before = requestRender.mock.calls.length;
      alt?.(ctx);
      expect(requestRender.mock.calls.length).toBeGreaterThan(before);
      expect(lines()).toHaveLength(3);
      expect(lines()[1]).toContain("fake-cwd");
      alt?.(ctx);
      expect(lines()).toHaveLength(2);
    });
  });

  it("is the full bar when the terminal is too small to draw the sidebar, on MAIN too", async () => {
    await withDock(async ({ tui, lines }) => {
      tui.terminal.columns = 120;
      expect(lines()).toHaveLength(3);
      tui.terminal.columns = 160;
      tui.terminal.rows = 20;
      expect(lines()).toHaveLength(3);
      tui.terminal.rows = 45;
      expect(lines()).toHaveLength(2);
    });
  });

  it("counts in the full bar the warnings that the sidebar lists under AVISOS, and nowhere in the compact one", async () => {
    const cli = installFakeCli();
    // A chat log that cannot record is one of the warnings the sidebar lists.
    cli.answer("usage record", { stderr: "haril: store not initialized", code: 2 });
    try {
      await withDock(
        async ({ fake, ctx, lines, sidebar }) => {
          await fake.fire("input", { text: "hello", source: "interactive" }, ctx);
          // The warning and its "! " are 34 columns, one more than a row of a card holds: it goes on in the next row.
          await vi.waitFor(() =>
            expect(sidebar()).toMatch(/! Activity log: 1 failed[^\n]*\n[^\n]*\s{2}record\(s\)/u),
          );
          const listed = Number(/AVISOS · (\d+)/.exec(sidebar())?.[1]);
          expect(listed).toBeGreaterThan(0);
          // Compact: the sidebar holds the warnings, so the bar does not count them.
          expect(lines().join("\n")).not.toContain("warning");
          // Alt+I closes the sidebar in the same tick, so the count compared is of the same state.
          fake.shortcuts.get("alt+i")?.(ctx);
          expect(lines()[0]).toContain(`${listed} ${listed === 1 ? "warning" : "warnings"}`);
          fake.shortcuts.get("alt+i")?.(ctx);
          expect(lines().join("\n")).not.toContain("warning");
        },
        { keepCli: true },
      );
    } finally {
      cli.restore();
    }
  });

  it("puts the clickable areas right under whichever bar is drawn", async () => {
    await withDock(async ({ lines, click, plugin }) => {
      const areaX = (row: string, label: string) => row.indexOf(label) + 1;
      // Compact: the areas line is row 1, so a click on row 2 (where the old fixed offset put it) opens nothing.
      let areas = lines()[1] ?? "";
      expect(click(areaX(areas, "[2 ORCHESTRATION]"), 2)).toBeUndefined();
      expect(click(areaX(areas, "[2 ORCHESTRATION]"), 1)).toEqual({ handled: true, render: true });
      expect(lines()[1]).toContain("▶[2 ORCHESTRATION]");

      // Full: the bar takes two lines, the areas line is row 2, and row 1 (the folder line) opens nothing.
      await plugin("memory");
      areas = lines()[2] ?? "";
      expect(click(areaX(areas, "[3 AUTOMATION]"), 1)).toBeUndefined();
      expect(click(areaX(areas, "[3 AUTOMATION]"), 2)).toEqual({ handled: true, render: true });
      expect(lines()[2]).toContain("▶[3 AUTOMATION]");
    });
  });
});
