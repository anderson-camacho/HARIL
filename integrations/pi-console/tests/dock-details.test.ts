import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDockDetails } from "../src/dock-details.js";
import type { DocsScan } from "../src/docs-folder.js";
import { textWidth } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";

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

  it("does not read git, the Pi commands or the palettes any more", async () => {
    // The GIT, YT and THEME views are gone: the details of the remaining views never offer them.
    for (const id of ["main", "memory", "docs"] as const) {
      const details = await loadDockDetails(id, ".", {
        memory: async () => ({ ok: true, stdout: "ok", stderr: "" }),
        docsPath: async () => undefined,
      });
      const text = [details.status, ...details.lines].join("\n");
      expect(text, id).not.toMatch(/Paleta|palette|YouTube|\/yt|CAMBIOS|HISTORIAL/);
      if (id !== "docs") expect(details.actions, id).toBeUndefined();
    }
  });
});

// DOCS shows the documentation folder the user connected (an Obsidian vault kept outside HARIL): the path, how many
// notes it holds and the latest ones, and the rows that connect, change or disconnect it. HARIL only reads the folder.
describe("the DOCS view", () => {
  // The right panel is 40 columns wide: every row must fit in what is left after its border and margin.
  const FITS = 38;

  function scan(overrides: Partial<DocsScan> = {}): DocsScan {
    return {
      exists: true,
      isDirectory: true,
      noteCount: 0,
      truncated: false,
      latest: [],
      ...overrides,
    };
  }

  const noon = (day: number): number => new Date(2026, 9, day, 12).getTime();

  function expectRowsToFit(lines: readonly string[]): void {
    for (const line of lines) expect([line, textWidth(line) <= FITS]).toEqual([line, true]);
  }

  // The row the action sits on, as the pane finds it for a click.
  function rowOf(
    details: { lines: readonly string[]; actions?: readonly { line: number; action: string }[] },
    action: string,
  ): string | undefined {
    const found = details.actions?.find((item) => item.action === action);
    return found === undefined ? undefined : details.lines[found.line];
  }

  it("invites to connect a folder when none is set, and offers the way to do it", async () => {
    const scanned: string[] = [];
    const docs = await loadDockDetails("docs", ".", {
      docsPath: async () => undefined,
      scanDocs: async (path) => {
        scanned.push(path);
        return scan();
      },
    });
    expect(docs.id).toBe("docs");
    expect(docs.status).toBe("Documentación · solo lectura");
    expect(docs.lines[0]).toBe("Sin carpeta conectada.");
    const text = docs.lines.join(" ").replace(/\s+/g, " ");
    expect(text).toContain(
      "Conecta tu carpeta de documentación (por ejemplo la bóveda de Obsidian).",
    );
    expect(rowOf(docs, "docs:set")).toBe("▸ Definir carpeta…");
    expect(docs.actions).toEqual([{ line: docs.lines.length - 1, action: "docs:set" }]);
    expectRowsToFit(docs.lines);
    expect(scanned).toEqual([]);

    const english = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => undefined,
    });
    expect(english.status).toBe("Documentation · read-only");
    expect(english.lines[0]).toBe("No folder connected.");
    expect(english.lines.join(" ")).toContain("Obsidian vault");
    expect(rowOf(english, "docs:set")).toBe("▸ Set folder…");
    expectRowsToFit(english.lines);
  });

  it("shows the connected folder, the number of notes and the latest ones", async () => {
    const asked: string[] = [];
    const docs = await loadDockDetails("docs", "/proyecto", {
      docsPath: async () => "D:\\Obsidian\\MiBoveda",
      scanDocs: async (path) => {
        asked.push(path);
        return scan({
          noteCount: 3,
          latest: [
            { rel: "proyectos/b.md", mtimeMs: noon(30), title: "Beta" },
            { rel: "a.md", mtimeMs: noon(2), title: "Alfa" },
          ],
        });
      },
    });
    expect(asked).toEqual(["D:\\Obsidian\\MiBoveda"]);
    expect(docs.status).toBe("Documentación · solo lectura");
    expect(docs.lines[0]).toBe("D:\\Obsidian\\MiBoveda");
    expect(docs.lines).toContain("3 notas .md");
    expect(docs.lines).toContain("Últimas notas:");
    const entries = docs.lines.filter((line) => /\.md$/.test(line) && !line.startsWith("3 "));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/^\d{1,2} \p{L}+\.? proyectos\/b\.md$/u);
    expect(entries[1]).toMatch(/^\d{1,2} \p{L}+\.? a\.md$/u);
    expect(rowOf(docs, "docs:set")).toBe("▸ Cambiar carpeta…");
    expect(rowOf(docs, "docs:clear")).toBe("▸ Desconectar");
    expect(docs.actions).toHaveLength(2);
    expectRowsToFit(docs.lines);

    const english = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => "/home/ana/vault",
      scanDocs: async () =>
        scan({ noteCount: 1, latest: [{ rel: "a.md", mtimeMs: noon(2), title: "Alfa" }] }),
    });
    expect(english.status).toBe("Documentation · read-only");
    expect(english.lines).toContain("1 .md note");
    expect(english.lines).toContain("Latest notes:");
    expect(english.lines.find((line) => line.endsWith(" a.md"))).toMatch(/[A-Za-z]/);
    expect(rowOf(english, "docs:set")).toBe("▸ Change folder…");
    expect(rowOf(english, "docs:clear")).toBe("▸ Disconnect");
  });

  it("says so when the scan stopped at its cap, and when the folder holds no notes yet", async () => {
    const capped = await loadDockDetails("docs", ".", {
      docsPath: async () => "/v",
      scanDocs: async () => scan({ noteCount: 2000, truncated: true }),
    });
    expect(capped.lines).toContain("2000+ notas .md");
    const cappedEnglish = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => "/v",
      scanDocs: async () => scan({ noteCount: 2000, truncated: true }),
    });
    expect(cappedEnglish.lines).toContain("2000+ .md notes");
    const empty = await loadDockDetails("docs", ".", {
      docsPath: async () => "/v",
      scanDocs: async () => scan(),
    });
    expect(empty.lines).toContain("0 notas .md");
    expect(empty.lines).toContain("Sin notas .md todavía.");
    expect(empty.actions?.map((item) => item.action)).toEqual(["docs:set", "docs:clear"]);
  });

  it("keeps the end of a path that does not fit, so the folder name is never cut", async () => {
    const path = "C:\\Users\\ana\\Documentos\\Obsidian\\Bovedas\\Trabajo\\MiBoveda";
    const docs = await loadDockDetails("docs", ".", {
      docsPath: async () => path,
      scanDocs: async () =>
        scan({
          noteCount: 1,
          latest: [
            {
              rel: "area/proyectos/clientes/acme/reuniones/2026/acta-de-la-reunion-larga.md",
              mtimeMs: noon(30),
            },
          ],
        }),
    });
    expect(docs.lines[0]?.startsWith("…")).toBe(true);
    expect(docs.lines[0]?.endsWith("Trabajo\\MiBoveda")).toBe(true);
    expect(docs.lines.find((line) => line.endsWith("acta-de-la-reunion-larga.md"))).toMatch(/^\d/);
    expectRowsToFit(docs.lines);
  });

  it("says the folder was not found, with the rows to change or disconnect it", async () => {
    const missing = await loadDockDetails("docs", ".", {
      docsPath: async () => "E:\\Vaults\\Notas",
      scanDocs: async () => scan({ exists: false, isDirectory: false }),
    });
    expect(missing.status).toBe("Documentación · solo lectura");
    expect(missing.lines[0]).toBe("Carpeta no encontrada: E:\\Vaults\\Notas");
    expect(missing.lines.join("\n")).not.toContain("Últimas notas");
    expect(rowOf(missing, "docs:set")).toBe("▸ Cambiar carpeta…");
    expect(rowOf(missing, "docs:clear")).toBe("▸ Desconectar");
    expectRowsToFit(missing.lines);

    const file = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => "/home/ana/nota.md",
      scanDocs: async () => scan({ isDirectory: false }),
    });
    expect(file.lines[0]).toBe("Not a folder: /home/ana/nota.md");

    const longPath = "C:\\Users\\ana\\Documentos\\Obsidian\\Bovedas\\Trabajo\\MiBoveda";
    const long = await loadDockDetails("docs", ".", {
      docsPath: async () => longPath,
      scanDocs: async () => scan({ exists: false, isDirectory: false }),
    });
    expect(long.lines[0]).toBe("Carpeta no encontrada:");
    expect(long.lines[1]?.endsWith("Trabajo\\MiBoveda")).toBe(true);
    expectRowsToFit(long.lines);
  });

  it("shows why the folder could not be read instead of a wrong state", async () => {
    const failed = await loadDockDetails("docs", ".", {
      docsPath: async () => {
        throw new Error("/docs/path: must be an absolute path");
      },
    });
    expect(failed.status).toBe("No se pudo leer");
    expect(failed.lines).toEqual(["/docs/path: must be an absolute path"]);
    expect(failed.actions).toBeUndefined();
  });

  describe("reading the path from the HARIL CLI", () => {
    let cli: FakeCli;
    beforeEach(() => {
      cli = installFakeCli();
    });
    afterEach(() => {
      cli.restore();
    });

    it("asks for docs.path as JSON and scans what it answers", async () => {
      cli.answer("config get docs.path", {
        stdout: JSON.stringify({ path: "docs.path", value: "/home/ana/vault", source: "file" }),
      });
      const asked: string[] = [];
      const docs = await loadDockDetails("docs", ".", {
        scanDocs: async (path) => {
          asked.push(path);
          return scan({ noteCount: 4 });
        },
      });
      expect(asked).toEqual(["/home/ana/vault"]);
      expect(docs.lines).toContain("4 notas .md");
      expect(cli.calls().map((call) => call.args)).toContainEqual([
        "config",
        "get",
        "docs.path",
        "--json",
      ]);
    });

    it("treats a null value as no folder connected", async () => {
      cli.answer("config get docs.path", {
        stdout: JSON.stringify({ path: "docs.path", value: null, source: "unset" }),
      });
      const docs = await loadDockDetails("docs", ".");
      expect(docs.lines[0]).toBe("Sin carpeta conectada.");
    });

    it("shows the CLI's own message when haril.json has problems", async () => {
      cli.answer("config get docs.path", {
        stderr:
          "haril: C:\\h\\haril.json has problems; fix them first (haril doctor lists them):\n",
        code: 2,
      });
      const docs = await loadDockDetails("docs", ".");
      expect(docs.status).toBe("No se pudo leer");
      expect(docs.lines.join(" ")).toContain("haril.json has problems");
    });
  });
});
