import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanDocsFolder, tailFit } from "../src/docs-folder.js";

// The DOCS tab reads the documentation folder (an Obsidian vault kept outside HARIL) and only reads it: how many .md
// notes it holds and the latest ones. The scan is bounded (files and depth), skips the folders an editor keeps for
// itself and never follows a link out of the tree.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-docs-folder-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A file with the modification time `minutes` minutes after a fixed instant, so the order is not a matter of luck.
function put(relative: string, text: string, minutes = 0): string {
  const path = join(root, ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const when = new Date(Date.UTC(2026, 9, 1, 12, minutes));
  utimesSync(path, when, when);
  return path;
}

describe("scanDocsFolder", () => {
  it("says a missing path does not exist, and a file is not a directory", async () => {
    expect(await scanDocsFolder(join(root, "nada"))).toEqual({
      exists: false,
      isDirectory: false,
      noteCount: 0,
      truncated: false,
      latest: [],
    });
    const file = put("nota.md", "# Nota\n");
    expect(await scanDocsFolder(file)).toEqual({
      exists: true,
      isDirectory: false,
      noteCount: 0,
      truncated: false,
      latest: [],
    });
  });

  it("is an empty directory with no notes", async () => {
    expect(await scanDocsFolder(root)).toEqual({
      exists: true,
      isDirectory: true,
      noteCount: 0,
      truncated: false,
      latest: [],
    });
  });

  it("counts .md notes in nested folders and lists the latest first, with forward slashes", async () => {
    put("a.md", "# Alfa\n", 1);
    put("proyectos/b.md", "# Beta\n", 3);
    put("proyectos/2026/c.MD", "# Gamma\n", 2);
    const scan = await scanDocsFolder(root);
    expect(scan.exists).toBe(true);
    expect(scan.isDirectory).toBe(true);
    expect(scan.noteCount).toBe(3);
    expect(scan.truncated).toBe(false);
    expect(scan.latest.map((note) => note.rel)).toEqual([
      "proyectos/b.md",
      "proyectos/2026/c.MD",
      "a.md",
    ]);
    expect(scan.latest[0]?.mtimeMs).toBe(Date.UTC(2026, 9, 1, 12, 3));
  });

  it("orders notes with the same time by name, so the list never shuffles", async () => {
    put("b.md", "# B\n", 5);
    put("a.md", "# A\n", 5);
    put("c.md", "# C\n", 5);
    expect((await scanDocsFolder(root)).latest.map((note) => note.rel)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  it("ignores what is not a note and the folders an editor keeps for itself", async () => {
    put("nota.md", "# Nota\n", 1);
    put("lista.txt", "no", 9);
    put("imagen.png", "no", 9);
    put(".obsidian/workspace.md", "# no\n", 9);
    put(".git/notas.md", "# no\n", 9);
    put(".trash/borrada.md", "# no\n", 9);
    put("node_modules/paquete/leeme.md", "# no\n", 9);
    put("$RECYCLE.BIN/viejo.md", "# no\n", 9);
    put("System Volume Information/x.md", "# no\n", 9);
    put(".oculta.md", "# no\n", 9);
    put("sub/.privada/dentro.md", "# no\n", 9);
    const scan = await scanDocsFolder(root);
    expect(scan.noteCount).toBe(1);
    expect(scan.latest.map((note) => note.rel)).toEqual(["nota.md"]);
  });

  it("returns at most `limit` notes but counts them all", async () => {
    for (let index = 0; index < 12; index++)
      put(`n${String(index).padStart(2, "0")}.md`, "", index);
    const scan = await scanDocsFolder(root);
    expect(scan.noteCount).toBe(12);
    expect(scan.latest).toHaveLength(10);
    expect(scan.latest[0]?.rel).toBe("n11.md");
    expect(scan.latest[9]?.rel).toBe("n02.md");
    expect((await scanDocsFolder(root, { limit: 3 })).latest.map((note) => note.rel)).toEqual([
      "n11.md",
      "n10.md",
      "n09.md",
    ]);
  });

  it("stops at maxFiles and says so, but not when the folder holds exactly that many", async () => {
    for (let index = 0; index < 6; index++) put(`n${index}.md`, "", index);
    const capped = await scanDocsFolder(root, { maxFiles: 4 });
    expect(capped.noteCount).toBe(4);
    expect(capped.truncated).toBe(true);
    const exact = await scanDocsFolder(root, { maxFiles: 6 });
    expect(exact.noteCount).toBe(6);
    expect(exact.truncated).toBe(false);
  });

  it("does not go deeper than maxDepth and says so", async () => {
    put("uno/dos/ok.md", "# Ok\n", 1);
    put("uno/dos/tres/fuera.md", "# Fuera\n", 2);
    const shallow = await scanDocsFolder(root, { maxDepth: 2 });
    expect(shallow.noteCount).toBe(1);
    expect(shallow.latest.map((note) => note.rel)).toEqual(["uno/dos/ok.md"]);
    expect(shallow.truncated).toBe(true);
    const deep = await scanDocsFolder(root, { maxDepth: 3 });
    expect(deep.noteCount).toBe(2);
    expect(deep.truncated).toBe(false);
    // Six levels of folders are read by default.
    put("a/b/c/d/e/f/seis.md", "# Seis\n", 3);
    put("a/b/c/d/e/f/g/siete.md", "# Siete\n", 4);
    const normal = await scanDocsFolder(root);
    expect(normal.latest.map((note) => note.rel)).toContain("a/b/c/d/e/f/seis.md");
    expect(normal.latest.map((note) => note.rel)).not.toContain("a/b/c/d/e/f/g/siete.md");
    expect(normal.truncated).toBe(true);
  });

  it("does not follow a link out of the tree", async () => {
    const outside = mkdtempSync(join(tmpdir(), "haril-docs-outside-"));
    try {
      writeFileSync(join(outside, "ajena.md"), "# Ajena\n");
      put("propia.md", "# Propia\n", 1);
      try {
        // A junction needs no privilege on Windows; elsewhere it is an ordinary directory link.
        symlinkSync(
          outside,
          join(root, "enlace"),
          process.platform === "win32" ? "junction" : "dir",
        );
        symlinkSync(join(outside, "ajena.md"), join(root, "ajena-enlazada.md"), "file");
      } catch {
        // The platform does not allow links here: the rest of the test still holds.
      }
      const scan = await scanDocsFolder(root);
      expect(scan.latest.map((note) => note.rel)).toEqual(["propia.md"]);
      expect(scan.noteCount).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("takes the title from the first heading, else the file name", async () => {
    put("con-titulo.md", "texto antes\n\n# El título real  \n\n## Otro\n", 4);
    put("sin-titulo.md", "solo texto, ningún encabezado\n## No es de primer nivel\n", 3);
    put("carpeta/Mi nota.md", "", 2);
    put("front.md", "---\n# comentario del yaml\ntags: [a]\n---\n# Después del front matter\n", 1);
    const titles = Object.fromEntries(
      (await scanDocsFolder(root)).latest.map((note) => [note.rel, note.title]),
    );
    expect(titles).toEqual({
      "con-titulo.md": "El título real",
      "sin-titulo.md": "sin-titulo",
      "carpeta/Mi nota.md": "Mi nota",
      "front.md": "Después del front matter",
    });
  });

  it("reads only the start of a long note when it looks for the title", async () => {
    put("larga.md", `${"relleno de la nota\n".repeat(400)}# Titulo tardio\n`, 1);
    expect((await scanDocsFolder(root)).latest[0]?.title).toBe("larga");
  });

  it("shows a title without control characters", async () => {
    put("raro.md", "# Hola \u001b[31mrojo\u001b[0m mundo\n", 1);
    expect((await scanDocsFolder(root)).latest[0]?.title).toBe("Hola rojo mundo");
  });
});

describe("tailFit", () => {
  it("keeps a text that fits and keeps the end of one that does not, so the folder name survives", () => {
    expect(tailFit("D:\\Obsidian\\MiBoveda", 36)).toBe("D:\\Obsidian\\MiBoveda");
    const long = "C:\\Users\\ana\\Documentos\\Obsidian\\Bovedas\\Trabajo\\MiBoveda";
    const fitted = tailFit(long, 30);
    expect(fitted.startsWith("…")).toBe(true);
    expect(fitted.endsWith("Trabajo\\MiBoveda")).toBe(true);
    expect(Array.from(fitted).length).toBeLessThanOrEqual(30);
    expect(tailFit("abc", 0)).toBe("");
  });
});
