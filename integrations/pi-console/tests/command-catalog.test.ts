import { describe, expect, it } from "vitest";
import {
  type CatalogEntry,
  catalogEntries,
  createCommandPicker,
  filterCatalog,
} from "../src/command-catalog.js";
import { stripAnsi } from "../src/text.js";

const REGISTERED = [
  { name: "haril", source: "extension" },
  { name: "haril-status", source: "extension" },
  { name: "haril-commands", source: "extension" },
  { name: "yt", description: "Play a video", source: "extension" },
  { name: "yt", source: "extension" },
  { name: "review", description: "Prompt template", source: "prompt" },
  { name: "skill:plan", description: "Plan things", source: "skill" },
  { name: "../../danger", source: "extension" },
];
const SHORTCUTS = [{ key: "alt+x", description: "Stop all" }];

function entries(): CatalogEntry[] {
  return catalogEntries(
    REGISTERED,
    [
      { name: "haril", description: "Abrir el menú" },
      { name: "deny", description: "Denegar" },
    ],
    SHORTCUTS,
  );
}

describe("the complete command catalog", () => {
  it("lists what Pi reports, Pi's own commands and the shortcuts, and nothing invented", () => {
    const list = entries();
    const names = list.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining(["haril", "haril-status", "yt", "review", "skill:plan", "alt+x"]),
    );
    expect(names).toContain("hotkeys");
    expect(names).not.toContain("deny");
    expect(names).not.toContain("../../danger");
    expect(names.filter((name) => name === "yt")).toHaveLength(1);
    expect(list.find((entry) => entry.name === "haril")?.description).toBe("Abrir el menú");
    expect(list.find((entry) => entry.name === "yt")?.group).toBe("Extensión");
    expect(list.find((entry) => entry.name === "review")?.group).toBe("Prompt");
    expect(list.find((entry) => entry.name === "hotkeys")?.group).toBe("Pi");
    expect(list.find((entry) => entry.name === "alt+x")?.kind).toBe("shortcut");
  });

  it("finds the status command in Spanish and in English", () => {
    for (const word of ["estado", "avisos", "extensiones", "contexto", "status"]) {
      expect(filterCatalog(entries(), word).map((entry) => entry.name)).toContain("haril-status");
    }
  });

  it("filters by every word, in any order", () => {
    expect(filterCatalog(entries(), "VIDEO play").map((entry) => entry.name)).toEqual(["yt"]);
    expect(filterCatalog(entries(), "zzz")).toEqual([]);
    expect(filterCatalog(entries(), "")).toHaveLength(entries().length);
  });
});

describe("the searchable picker", () => {
  const text = (lines: readonly string[]) => stripAnsi(lines.join("\n"));

  it("filters as the user types and chooses with Enter", () => {
    let chosen: CatalogEntry | undefined;
    const picker = createCommandPicker(entries(), (entry) => {
      chosen = entry;
    });
    expect(text(picker.render(90))).toContain("/haril-status");
    for (const key of "video") picker.handleInput(key);
    const filtered = text(picker.render(90));
    expect(filtered).toContain("/yt");
    expect(filtered).not.toContain("/haril-status");
    picker.handleInput("\r");
    expect(chosen?.name).toBe("yt");
  });

  it("deletes with backspace, moves with the arrows and closes with Escape", () => {
    let chosen: CatalogEntry | undefined | "open" = "open";
    const picker = createCommandPicker(entries(), (entry) => {
      chosen = entry;
    });
    picker.handleInput("z");
    expect(text(picker.render(90))).toContain("Sin resultados");
    picker.handleInput("\u007f");
    expect(text(picker.render(90))).toContain("/haril-status");
    picker.handleInput("\u001b[B");
    picker.handleInput("\u001b");
    expect(chosen).toBeUndefined();
  });
});
