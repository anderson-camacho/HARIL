import { describe, expect, it } from "vitest";
import { HARIL_CONFIG_TOP_LEVEL_KEYS } from "../src/delegation-config.js";
import { docsSectionErrors, isAbsoluteDocsPath } from "../src/docs-config.js";

// The `docs` section of haril.json: one key, `path`, the folder with the user's documentation (an Obsidian vault kept
// outside HARIL). HARIL only reads it. The check is about the shape of the text; whether the folder exists is looked at
// when the path is set and when it is shown, never when the configuration is loaded (a vault on a drive that is not
// connected must not make haril.json unreadable).

describe("the docs section", () => {
  it("is one of the top-level keys of haril.json", () => {
    expect(HARIL_CONFIG_TOP_LEVEL_KEYS).toContain("docs");
  });

  it("accepts absolute paths of any platform, whether or not they exist here", () => {
    for (const path of [
      "D:\\Vaults\\Notas",
      "d:/vaults/notas",
      "C:\\",
      "\\\\servidor\\recurso\\notas",
      "//servidor/recurso/notas",
      "/home/ana/vault",
      "/",
    ]) {
      expect([path, docsSectionErrors({ path })]).toEqual([path, []]);
    }
  });

  it("accepts an empty section, which is the same as no folder", () => {
    expect(docsSectionErrors({})).toEqual([]);
  });

  it("refuses a relative path, naming the field", () => {
    for (const path of ["notas", "./notas", "../vault", "~/vault", "D:vault", "docs\\notas"]) {
      expect([path, docsSectionErrors({ path })]).toEqual([
        path,
        ["/docs/path: must be an absolute path (for example D:\\Vault or /home/ana/vault)"],
      ]);
    }
  });

  it("refuses an empty, non-string or NUL-carrying value", () => {
    for (const path of ["", "   ", 7, null, true, ["D:\\x"], "D:\\a\0b"]) {
      expect(docsSectionErrors({ path })).toEqual([
        "/docs/path: must be a non-empty text without control characters, an absolute path",
      ]);
    }
  });

  it("refuses a path with surrounding blanks, which would never match the folder", () => {
    expect(docsSectionErrors({ path: " D:\\Vault" })).toEqual([
      "/docs/path: must not start or end with a blank",
    ]);
  });

  it("refuses unknown keys and a section that is not an object", () => {
    expect(docsSectionErrors({ path: "/v", folder: "/x" })).toEqual(["/docs/folder: unknown key"]);
    for (const section of ["/v", 3, null, ["/v"]]) {
      expect(docsSectionErrors(section)).toEqual(["/docs: must be an object"]);
    }
  });

  it("recognises absolute paths without touching the file system", () => {
    expect(isAbsoluteDocsPath("D:\\x")).toBe(true);
    expect(isAbsoluteDocsPath("/x")).toBe(true);
    expect(isAbsoluteDocsPath("x/y")).toBe(false);
    expect(isAbsoluteDocsPath("")).toBe(false);
  });
});
