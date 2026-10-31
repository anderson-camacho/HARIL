import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DockDetails, loadDockDetails } from "../src/dock-details.js";
import type { DocsScan } from "../src/docs-folder.js";
import { CARD_CONTENT_WIDTH } from "../src/rail-metrics.js";
import { textWidth } from "../src/text.js";
import { type FakeCli, installFakeCli } from "./fake-cli.js";

describe("plugin views backed by read-only sources", () => {
  // The MEM tab is covered, state by state, in tools-view.test.ts; this is the plain fact that it reads the JSON of the
  // two commands and that a part that fails shows why without hiding the other.
  it("shows the HARIL memory diagnostics from `haril memory status --json`", async () => {
    const memory = await loadDockDetails("memory", ".", {
      tools: async () => ({ ok: false, stdout: "", stderr: "tools down" }),
      memory: async () => ({
        ok: true,
        stdout: JSON.stringify({
          initialized: true,
          runtime: "running",
          provider: "engram",
          persistent: true,
          health: "active",
          degraded: false,
          outbox: { depth: 0 },
        }),
        stderr: "",
      }),
    });
    expect(memory.lines).toContain("  Proveedor: engram · persistente");
    expect(memory.status).toBe("Memoria y herramientas");
    const english = await loadDockDetails("memory", ".", {
      locale: "en",
      tools: async () => ({ ok: false, stdout: "", stderr: "tools down" }),
      memory: async () => ({ ok: false, stdout: "", stderr: "memory store locked" }),
    });
    expect(english.status).toBe("Memory and tools");
    expect(english.lines).toContain("Memory process · not available");
    expect(english.lines).toContain("  memory store locked");
    expect(english.lines).toContain("  tools down");
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
      // MAIN has no rows to run; MEM and DOCS declare theirs.
      if (id === "main") expect(details.actions, id).toBeUndefined();
    }
  });
});

// DOCS shows the documentation folder the user connected (an Obsidian vault kept outside HARIL): the path, how many
// notes it holds and the latest ones, and the rows that connect, change or disconnect it. HARIL only reads the folder.
describe("the DOCS view", () => {
  // A card gives a row CARD_CONTENT_WIDTH columns; the plain lines of the left dock indent a row by two more.
  const FITS = CARD_CONTENT_WIDTH + 2;

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

  function expectRowsToFit(details: DockDetails): void {
    for (const line of details.lines) expect([line, textWidth(line) <= FITS]).toEqual([line, true]);
    for (const row of rows(details)) {
      expect([row, textWidth(row) <= CARD_CONTENT_WIDTH]).toEqual([row, true]);
    }
  }

  // The text rows of every card of the view, in order (the plain lines add each card's title and an indent).
  function rows(details: DockDetails): string[] {
    return details.cards?.flatMap((card) => [...card.rows]) ?? [];
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
    expect(docs.cards?.map((card) => card.title)).toEqual(["Carpeta", "Acciones"]);
    expect(rows(docs)[0]).toBe("Sin carpeta conectada.");
    const text = rows(docs).join(" ").replace(/\s+/g, " ");
    expect(text).toContain(
      "Conecta tu carpeta de documentación (por ejemplo la bóveda de Obsidian).",
    );
    expect(rowOf(docs, "docs:set")).toBe("▸ Definir carpeta…");
    expect(docs.actions).toEqual([
      { line: docs.lines.length - 1, action: "docs:set", label: "Definir carpeta…" },
    ]);
    expect(docs.cards?.[1]?.buttons).toEqual([{ label: "Definir carpeta…", action: "docs:set" }]);
    expectRowsToFit(docs);
    expect(scanned).toEqual([]);

    const english = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => undefined,
    });
    expect(english.status).toBe("Documentation · read-only");
    expect(english.cards?.map((card) => card.title)).toEqual(["Folder", "Actions"]);
    expect(rows(english)[0]).toBe("No folder connected.");
    expect(rows(english).join(" ")).toContain("Obsidian vault");
    expect(rowOf(english, "docs:set")).toBe("▸ Set folder…");
    expectRowsToFit(english);
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
    expect(docs.cards?.map((card) => card.title)).toEqual(["Carpeta", "Últimas notas", "Acciones"]);
    expect(rows(docs)[0]).toBe("D:\\Obsidian\\MiBoveda");
    expect(rows(docs)).toContain("3 notas .md");
    const entries = docs.cards?.[1]?.rows ?? [];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/^\d{1,2} \p{L}+\.? proyectos\/b\.md$/u);
    expect(entries[1]).toMatch(/^\d{1,2} \p{L}+\.? a\.md$/u);
    expect(rowOf(docs, "docs:set")).toBe("▸ Cambiar carpeta…");
    expect(rowOf(docs, "docs:clear")).toBe("▸ Desconectar");
    expect(docs.actions).toHaveLength(2);
    expectRowsToFit(docs);

    const english = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => "/home/ana/vault",
      scanDocs: async () =>
        scan({ noteCount: 1, latest: [{ rel: "a.md", mtimeMs: noon(2), title: "Alfa" }] }),
    });
    expect(english.status).toBe("Documentation · read-only");
    expect(rows(english)).toContain("1 .md note");
    expect(english.cards?.[1]?.title).toBe("Latest notes");
    expect(english.lines.find((line) => line.endsWith(" a.md"))).toMatch(/[A-Za-z]/);
    expect(rowOf(english, "docs:set")).toBe("▸ Change folder…");
    expect(rowOf(english, "docs:clear")).toBe("▸ Disconnect");
  });

  it("says so when the scan stopped at its cap, and when the folder holds no notes yet", async () => {
    const capped = await loadDockDetails("docs", ".", {
      docsPath: async () => "/v",
      scanDocs: async () => scan({ noteCount: 2000, truncated: true }),
    });
    expect(rows(capped)).toContain("2000+ notas .md");
    const cappedEnglish = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => "/v",
      scanDocs: async () => scan({ noteCount: 2000, truncated: true }),
    });
    expect(rows(cappedEnglish)).toContain("2000+ .md notes");
    const empty = await loadDockDetails("docs", ".", {
      docsPath: async () => "/v",
      scanDocs: async () => scan(),
    });
    expect(rows(empty)).toContain("0 notas .md");
    expect(rows(empty)).toContain("Sin notas .md todavía.");
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
              rel: "area/proyectos/clientes/acme/reuniones/2026/acta-de-reunion-larga.md",
              mtimeMs: noon(30),
            },
          ],
        }),
    });
    expect(rows(docs)[0]?.startsWith("…")).toBe(true);
    expect(rows(docs)[0]?.endsWith("Trabajo\\MiBoveda")).toBe(true);
    expect(rows(docs).find((row) => row.endsWith("acta-de-reunion-larga.md"))).toMatch(/^\d/);
    expectRowsToFit(docs);
  });

  it("says the folder was not found, with the rows to change or disconnect it", async () => {
    const missing = await loadDockDetails("docs", ".", {
      docsPath: async () => "E:\\Notas",
      scanDocs: async () => scan({ exists: false, isDirectory: false }),
    });
    expect(missing.status).toBe("Documentación · solo lectura");
    expect(rows(missing)[0]).toBe("Carpeta no encontrada: E:\\Notas");
    expect(missing.lines.join("\n")).not.toContain("Últimas notas");
    expect(rowOf(missing, "docs:set")).toBe("▸ Cambiar carpeta…");
    expect(rowOf(missing, "docs:clear")).toBe("▸ Desconectar");
    expectRowsToFit(missing);

    const file = await loadDockDetails("docs", ".", {
      locale: "en",
      docsPath: async () => "/home/ana/nota.md",
      scanDocs: async () => scan({ isDirectory: false }),
    });
    expect(rows(file)[0]).toBe("Not a folder: /home/ana/nota.md");

    const longPath = "C:\\Users\\ana\\Documentos\\Obsidian\\Bovedas\\Trabajo\\MiBoveda";
    const long = await loadDockDetails("docs", ".", {
      docsPath: async () => longPath,
      scanDocs: async () => scan({ exists: false, isDirectory: false }),
    });
    expect(rows(long)[0]).toBe("Carpeta no encontrada:");
    expect(rows(long)[1]?.endsWith("Trabajo\\MiBoveda")).toBe(true);
    expectRowsToFit(long);
  });

  it("shows why the folder could not be read instead of a wrong state", async () => {
    const failed = await loadDockDetails("docs", ".", {
      docsPath: async () => {
        throw new Error("/docs/path: must be an absolute path");
      },
    });
    expect(failed.status).toBe("No se pudo leer");
    expect(failed.cards?.map((card) => card.title)).toEqual(["Motivo"]);
    expect(rows(failed).join(" ")).toBe("/docs/path: must be an absolute path");
    expect(failed.lines).toEqual(["Motivo", "  /docs/path: must be an absolute", "  path"]);
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
      expect(rows(docs)).toContain("4 notas .md");
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
      expect(rows(docs)[0]).toBe("Sin carpeta conectada.");
    });

    it("shows the CLI's own message when haril.json has problems", async () => {
      cli.answer("config get docs.path", {
        stderr:
          "haril: C:\\h\\haril.json has problems; fix them first (haril doctor lists them):\n",
        code: 2,
      });
      const docs = await loadDockDetails("docs", ".");
      expect(docs.status).toBe("No se pudo leer");
      expect(rows(docs).join(" ")).toContain("haril.json has problems");
    });
  });
});

// The ACT view: the project's recent events through `haril events`, in the range the console holds. The cards and every
// state of them are covered in activity-view.test.ts; this is the plain fact that the view reads through the CLI and
// that nothing that goes wrong reaches the console as an exception.
describe("the ACT view", () => {
  const NOW = Date.UTC(2026, 9, 30, 20, 15, 0);
  const events = JSON.stringify([
    { seq: 373, type: "workflow.failed", time: new Date(NOW - 9 * 60_000).toISOString() },
    { seq: 375, type: "watchdog.closed", time: new Date(NOW - 3 * 60_000).toISOString() },
  ]);

  it("asks `haril events` for the project and the range, and shows the newest event first", async () => {
    const calls: (readonly string[])[] = [];
    const details = await loadDockDetails("activity", ".", {
      projectSlug: "demo",
      activityRange: { kind: "hour" },
      now: () => NOW,
      events: async (args) => {
        calls.push(args);
        return { ok: true, stdout: events, stderr: "" };
      },
    });
    expect(calls).toEqual([
      ["events", "--project", "demo", "--limit", "50", "--since", "1h", "--json"],
    ]);
    expect(details.id).toBe("activity");
    expect(details.title).toBe("Actividad");
    expect(details.status).toBe("Actividad reciente");
    expect(details.lines).toContain("Actividad · 2");
    expect(details.lines).toContain("  #375 watchdog.closed · hace 3 min");
    expect(details.lines).toContain("  #373 workflow.failed · hace 9 min");
    expect(details.lines.indexOf("  #375 watchdog.closed · hace 3 min")).toBeLessThan(
      details.lines.indexOf("  #373 workflow.failed · hace 9 min"),
    );
    // The buttons come first and carry the words the keyboard menu reads.
    expect(details.actions?.map((action) => action.label)).toEqual([
      "Última hora",
      "Último día",
      "Rango…",
      "Todo",
      "Actualizar",
    ]);
    expect(details.cards?.map((card) => card.title)).toEqual([
      "Filtro",
      "Acciones",
      "Actividad · 2",
    ]);
  });

  it("defaults to every event, in the interface language", async () => {
    const calls: (readonly string[])[] = [];
    const details = await loadDockDetails("activity", ".", {
      locale: "en",
      projectSlug: "demo",
      now: () => NOW,
      events: async (args) => {
        calls.push(args);
        return { ok: true, stdout: events, stderr: "" };
      },
    });
    expect(calls).toEqual([["events", "--project", "demo", "--limit", "50", "--json"]]);
    expect(details.status).toBe("Recent activity");
    expect(details.lines).toContain("  #375 watchdog.closed · 3 min ago");
    expect(details.actions?.map((action) => action.label)).toContain("Last hour");
  });

  it("runs nothing for a folder that is no project", async () => {
    let called = false;
    const details = await loadDockDetails("activity", ".", {
      events: async () => {
        called = true;
        return { ok: true, stdout: "[]", stderr: "" };
      },
    });
    expect(called).toBe(false);
    expect(details.lines.join("\n")).toContain("Sin proyecto registrado");
  });

  it("shows a command that fails or cannot run inside the card, and never throws", async () => {
    const failed = await loadDockDetails("activity", ".", {
      projectSlug: "demo",
      events: async () => ({ ok: false, stdout: "", stderr: "haril: store not initialized" }),
    });
    expect(failed.lines).toContain("Actividad · no disponible");
    expect(failed.lines.join("\n")).toContain("store not initialized");
    const rejected = await loadDockDetails("activity", ".", {
      projectSlug: "demo",
      events: async () => {
        throw new Error("spawn EPERM");
      },
    });
    expect(rejected.lines.join("\n")).toContain("spawn EPERM");
    expect(rejected.actions).toBeDefined();
  });

  it("reads through the HARIL CLI of the console when no source is given", async () => {
    const cli = installFakeCli();
    try {
      cli.answer("events", { stdout: events });
      const details = await loadDockDetails("activity", process.cwd(), { projectSlug: "demo" });
      expect(cli.calls().map((call) => call.args)).toEqual([
        ["events", "--project", "demo", "--limit", "50", "--json"],
      ]);
      expect(details.lines).toContain("Actividad · 2");
    } finally {
      cli.restore();
    }
  });
});
