import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDockDetails } from "../src/dock-details.js";

describe("plugin views backed by read-only sources", () => {
  it("lists directories first without reading file content or writing files", async () => {
    const result = await loadDockDetails("explorer", "test-dir", {
      directory: async () => [
        { name: "main.ts", isDirectory: () => false },
        { name: "src", isDirectory: () => true },
        { name: "README.md", isDirectory: () => false },
      ],
    });
    expect(result.status).toContain("3 entradas");
    expect(result.lines[1]).toContain("src");
    expect(result.lines).toContain("· ◇ main.ts");
  });

  it("puts ordinary items before hidden folders so the dock does not start with a wall of dotfiles", async () => {
    const result = await loadDockDetails("explorer", ".", {
      directory: async () => [
        { name: ".cache", isDirectory: () => true },
        { name: "README.md", isDirectory: () => false },
        { name: "projects", isDirectory: () => true },
        { name: ".config", isDirectory: () => true },
        { name: "Documents", isDirectory: () => true },
      ],
    });
    expect(result.lines.slice(1)).toEqual([
      "▸ ▣ Documents",
      "▸ ▣ projects",
      "· ◇ README.md",
      "▸ ▣ .cache",
      "▸ ▣ .config",
    ]);
  });

  it("expands only requested tree branches and never descends into unrelated directories", async () => {
    const scanned: string[] = [];
    const srcPath = join("repo", "src");
    const directory = async (folder: string) => {
      scanned.push(folder);
      return folder === srcPath
        ? [{ name: "main.ts", isDirectory: () => false }]
        : [
            { name: "src", isDirectory: () => true },
            { name: "private", isDirectory: () => true },
          ];
    };
    const closed = await loadDockDetails("explorer", "repo", { directory });
    expect(scanned).toEqual(["repo"]);
    expect(closed.treeNodes).toHaveLength(2);
    const expanded = await loadDockDetails("explorer", "repo", {
      directory,
      expandedPaths: new Set([srcPath]),
    });
    expect(scanned).toEqual(["repo", "repo", srcPath]);
    expect(expanded.lines).toContain("▾ ▣ src");
    expect(expanded.lines).toContain("  · ◇ main.ts");
    const english = await loadDockDetails("explorer", "repo", { directory, locale: "en" });
    expect(english.status).toContain("click to expand");
  });

  it("shows real Git and HARIL memory diagnostics", async () => {
    const git = await loadDockDetails("git", ".", {
      git: async () => "## main\n M app.ts\n?? new-file.ts\n",
      gitHistory: async () => "* 123abcd latest commit\n* abcd999 initial\n",
      gitChanges: async () => "src/app.ts | 2 ++\n",
    });
    expect(git.lines).toEqual([
      "## main",
      " M app.ts",
      "?? new-file.ts",
      "── CAMBIOS ──",
      "src/app.ts | 2 ++",
      "── HISTORIAL ──",
      "* 123abcd latest commit",
      "* abcd999 initial",
    ]);
    const memory = await loadDockDetails("memory", ".", {
      memory: async () => ({ ok: true, stdout: "Memory provider: Engram\nReady", stderr: "" }),
    });
    expect(memory.lines).toContain("Ready");
  });

  it("never presents missing YouTube extensions as installed and exposes selectable HARIL palettes", async () => {
    const absent = await loadDockDetails("youtube", ".", { piCommands: [] });
    expect(absent.status).toContain("no detectada");
    expect(absent.lines.join(" ")).toContain("no instala");
    const present = await loadDockDetails("youtube", ".", { piCommands: ["yt"] });
    expect(present.status).toContain("detectada");
    const themes = await loadDockDetails("themes", ".", { theme: "rose" });
    expect(themes.lines).toContain("Pi: /settings → Theme");
    expect(themes.status).toContain("rose");
    expect(themes.actions).toEqual([
      { line: 1, action: "violet" },
      { line: 2, action: "rose" },
      { line: 3, action: "amber" },
      { line: 4, action: "obsidian" },
    ]);
  });
});
