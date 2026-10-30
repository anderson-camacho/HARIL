import { describe, expect, it } from "vitest";
import { loadDockDetails } from "../src/dock-details.js";

describe("plugin views backed by read-only sources", () => {
  it("shows the HARIL memory diagnostics", async () => {
    const memory = await loadDockDetails("memory", ".", {
      memory: async () => ({ ok: true, stdout: "Memory provider: Engram\nReady", stderr: "" }),
    });
    expect(memory.lines).toContain("Ready");
    expect(memory.status).toBe("Estado de memoria HARIL");
    const english = await loadDockDetails("memory", ".", {
      locale: "en",
      memory: async () => ({ ok: false, stdout: "", stderr: "memory store locked" }),
    });
    expect(english.status).toBe("Memory unavailable");
    expect(english.lines).toEqual(["memory store locked"]);
  });

  it("has nothing to load for MAIN: its content is the status block, drawn from live facts", async () => {
    const main = await loadDockDetails("main", ".");
    expect(main).toEqual({ id: "main", title: "Principal", status: "", lines: [] });
    expect(main.actions).toBeUndefined();
  });

  it("shows a placeholder for DOCS until a documentation folder is connected", async () => {
    const docs = await loadDockDetails("docs", ".");
    expect(docs.id).toBe("docs");
    expect(docs.lines).toEqual(["Carpeta de documentación sin conectar."]);
    expect(docs.actions).toBeUndefined();
    const english = await loadDockDetails("docs", ".", { locale: "en" });
    expect(english.lines).toEqual(["Documentation folder not connected."]);
  });

  it("does not read git, the Pi commands or the palettes any more", async () => {
    // The GIT, YT and THEME views are gone: the details of the remaining views never offer them.
    for (const id of ["main", "memory", "docs"] as const) {
      const details = await loadDockDetails(id, ".", {
        memory: async () => ({ ok: true, stdout: "ok", stderr: "" }),
      });
      const text = [details.status, ...details.lines].join("\n");
      expect(text, id).not.toMatch(/Paleta|palette|YouTube|\/yt|CAMBIOS|HISTORIAL/);
      expect(details.actions, id).toBeUndefined();
    }
  });
});
