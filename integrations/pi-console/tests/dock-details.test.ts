import { describe, expect, it } from "vitest";
import { loadDockDetails } from "../src/dock-details.js";

describe("plugin views backed by read-only sources", () => {
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
      { line: 1, action: "matrix" },
      { line: 2, action: "violet" },
      { line: 3, action: "rose" },
      { line: 4, action: "amber" },
      { line: 5, action: "obsidian" },
    ]);
  });
});
