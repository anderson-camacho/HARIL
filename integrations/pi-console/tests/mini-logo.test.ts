import { afterEach, describe, expect, it, vi } from "vitest";
import harilConsole from "../src/console.js";
import { setHarilPalette } from "../src/dashboard-theme.js";
import { MINI_LOGO_WIDTH, miniLogo, withPinnedLogo } from "../src/mini-logo.js";
import type {
  ConsoleComponent,
  ConsoleContext,
  ConsoleTheme,
  ConsoleTui,
} from "../src/pi-types.js";
import { stripAnsi, textWidth } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

const ESC = String.fromCharCode(27);
const BLOCKS = /[█▀▄]/;
const LOGO_ROW = /█▄█ █▀█ █▀█ ▀█▀ █/;

afterEach(() => {
  setHarilPalette("future");
  vi.unstubAllEnvs();
});

describe("miniLogo", () => {
  it("is at most 3 rows and 22 columns, in blocks", () => {
    const rows = miniLogo(40).map(stripAnsi);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(MINI_LOGO_WIDTH).toBeLessThanOrEqual(22);
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(22);
    expect(rows.join("")).toMatch(BLOCKS);
  });

  it("uses #5EC2FF in future, another colour elsewhere, and paints no background", () => {
    vi.stubEnv("NO_COLOR", undefined as unknown as string);
    vi.stubEnv("PI_TRUE_COLOR", "1");
    const future = miniLogo(40).join("\n");
    expect(future).toContain("38;2;94;194;255");
    expect(future).not.toContain(`${ESC}[48;`);
    setHarilPalette("amber");
    expect(miniLogo(40).join("\n")).not.toContain("38;2;94;194;255");
  });

  it("falls back to the word when it does not fit, and to nothing below that", () => {
    expect(miniLogo(MINI_LOGO_WIDTH - 1).map(stripAnsi)).toEqual(["HARIL"]);
    expect(miniLogo(4)).toEqual([]);
    expect(miniLogo(40, { ascii: true }).map(stripAnsi)).toEqual(["HARIL"]);
  });
});

describe("withPinnedLogo", () => {
  const content = ["a", "b"];

  it("pins the logo to the bottom rows when there is room", () => {
    const rows = withPinnedLogo(content, 12, 39).map(stripAnsi);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toBe("a");
    expect(rows.slice(2, 9).every((row) => row.trim() === "")).toBe(true);
    expect(rows.slice(9).join("")).toMatch(BLOCKS);
  });

  it("gives way to real content: it is dropped whole when it does not fit", () => {
    const logo = miniLogo(39).length;
    expect(withPinnedLogo(content, 2 + logo - 1, 39)).toEqual(content);
    expect(withPinnedLogo(content, 2, 39)).toEqual(content);
    expect(
      withPinnedLogo(content, 2 + logo, 39)
        .map(stripAnsi)
        .join(""),
    ).toMatch(BLOCKS);
  });
});

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const THEME: ConsoleTheme = { fg: (_tone, value) => value, bold: (value) => value };
type Factory = (tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent;

async function start(rows: number) {
  const fake = fakePi();
  const ctx = fakeContext();
  let anchor: Factory | undefined;
  let header: Factory | undefined;
  Object.assign(ctx.ui, {
    setWidget(key: string, value: Factory) {
      if (key === "haril-native-panes-anchor") anchor = value;
    },
    setHeader(value: Factory) {
      header = value;
    },
  });
  harilConsole(fake.pi);
  await fake.fire("session_start", { reason: "startup" }, ctx as ConsoleContext);
  const layoutRoot = {
    render: () => ["Pi chat"],
    invalidate: () => undefined,
    [LAYOUT_NODE]: () => ({ type: "vstack", gap: 0, align: "stretch", entries: [] }),
  };
  const tui = { layoutRoot, terminal: { columns: 160, rows }, requestRender: () => undefined };
  anchor?.(tui as unknown as ConsoleTui, THEME);
  const layout = (
    layoutRoot[LAYOUT_NODE] as () => { entries: { component: ConsoleComponent }[] }
  )();
  const pane = layout.entries.at(-1)?.component;
  const live = (): { entries: { component: ConsoleComponent }[] } =>
    (layoutRoot[LAYOUT_NODE] as () => { entries: { component: ConsoleComponent }[] })();
  return {
    // What the panel draws, and nothing while the layout no longer holds it (Alt+I).
    panel: (): string =>
      live().entries.some(({ component }) => component === pane)
        ? (pane?.render(40) ?? []).map(stripAnsi).join("\n")
        : "",
    chat: (): string[] =>
      (header?.(tui as unknown as ConsoleTui, THEME).render(120) ?? []).map(stripAnsi),
    toggle: () => fake.shortcuts.get("alt+i")?.(ctx as ConsoleContext),
    finish: () => fake.fire("session_shutdown", {}, ctx as ConsoleContext),
  };
}

describe("the small logo in the console", () => {
  it("is in the panel while open and at the chat's start while closed, never both", async () => {
    const h = await start(45);
    try {
      expect(h.panel()).toMatch(LOGO_ROW);
      expect(h.chat()).toEqual([]);

      h.toggle();
      const chat = h.chat();
      expect(chat.length).toBeLessThanOrEqual(3);
      expect(chat.join("\n")).toMatch(LOGO_ROW);
      expect(chat.every((row) => row.trim() !== "")).toBe(true);
      expect(h.panel()).not.toMatch(LOGO_ROW);

      h.toggle();
      expect(h.chat()).toEqual([]);
      expect(h.panel()).toMatch(LOGO_ROW);
    } finally {
      await h.finish();
    }
  });
});
