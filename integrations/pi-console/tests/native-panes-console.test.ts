import { describe, expect, it } from "vitest";
import harilConsole from "../src/console.js";
import type { ConsoleComponent, ConsoleTheme, ConsoleTui } from "../src/pi-types.js";
import { stripAnsi } from "../src/text.js";
import { fakeContext, fakePi } from "./fake-pi.js";

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
      expect(fake.commands.has("haril-explore")).toBe(true);
      expect(fake.shortcuts.has("alt+c")).toBe(true);
      expect(fake.shortcuts.has("alt+l")).toBe(true);
      expect(fake.shortcuts.has("alt+i")).toBe(true);
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
      const middle = newLayout.entries[1];
      const rightPane = newLayout.entries[2];
      const leftPane = newLayout.entries[0];
      if (!leftPane || !middle || !rightPane) throw new Error("Expected three Pi panes");
      expect(middle.component.render(60)).toEqual(["Pi chat"]);

      const newHeader = header?.(tui, THEME).render(96).map(stripAnsi).join("\n");
      expect(newHeader).toContain("HARIL");
      expect(newHeader).not.toContain("██████");
      expect(newHeader?.split("\n")).toHaveLength(1);
      const right = rightPane.component.render(40).map(stripAnsi).join("\n");
      expect(right).toContain("ACTIVIDAD");

      await fake.commands.get("haril-plugin")?.handler("youtube", ctx);
      const left = leftPane.component.render(23).map(stripAnsi).join("\n");
      expect(left).toContain("YOUTUBE");
      expect(left).toContain("Extensión /yt");

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
