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
    expect(result.status).toContain("3 elementos");
    expect(result.lines[1]).toContain("src");
    expect(result.lines).toContain("· main.ts");
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
      "▸ Documents",
      "▸ projects",
      "· README.md",
      "▸ .cache",
      "▸ .config",
    ]);
  });

  it("shows real Git and HARIL memory diagnostics", async () => {
    const git = await loadDockDetails("git", ".", {
      git: async () => "## main\n M app.ts\n?? new-file.ts\n",
    });
    expect(git.lines).toEqual(["## main", " M app.ts", "?? new-file.ts"]);
    const memory = await loadDockDetails("memory", ".", {
      memory: async () => ({ ok: true, stdout: "Memory provider: Engram\nReady", stderr: "" }),
    });
    expect(memory.lines).toContain("Ready");
  });

  it("never presents missing YouTube extensions as installed or silently enables themes", async () => {
    const absent = await loadDockDetails("youtube", ".", { piCommands: [] });
    expect(absent.status).toContain("no detectada");
    expect(absent.lines.join(" ")).toContain("no instala");
    const present = await loadDockDetails("youtube", ".", { piCommands: ["yt"] });
    expect(present.status).toContain("detectada");
    const themes = await loadDockDetails("themes", ".");
    expect(themes.lines).toContain("/settings → Theme");
    expect(themes.lines.join(" ")).toContain("no cambia");
  });
});
