import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  explorerFolderChoices,
  insideExplorerRoot,
  resolveExplorerFolder,
} from "../src/explorer-navigation.js";

describe("safe explorer folder navigation", () => {
  it("rejects siblings that merely share a path prefix", () => {
    expect(insideExplorerRoot(join("folder", "project"), join("folder", "project-backup"))).toBe(
      false,
    );
    expect(insideExplorerRoot(join("folder", "project"), join("folder", "project", "src"))).toBe(
      true,
    );
  });

  it("navigates directories without reading files or escaping the selected project", async () => {
    const base = await mkdtemp(join(tmpdir(), "haril-explorer-test-"));
    const root = join(base, "project");
    const sibling = join(base, "elsewhere");
    try {
      await mkdir(root);
      await mkdir(sibling);
      await mkdir(join(root, "src"));
      await mkdir(join(root, ".cache"));
      await writeFile(join(root, "README.md"), "not opened by the explorer");
      const choices = await explorerFolderChoices(root);
      expect(choices.map(({ name }) => name)).toEqual(["src", ".cache"]);
      const src = await resolveExplorerFolder(root, root, "src");
      expect(src).toBe(await realpath(join(root, "src")));
      expect(await resolveExplorerFolder(root, src, "..")).toBe(await realpath(root));
      await expect(resolveExplorerFolder(root, root, "../elsewhere")).rejects.toThrow(
        "No se puede salir",
      );
      await expect(resolveExplorerFolder(root, root, "README.md")).rejects.toThrow(
        "no es una carpeta",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
