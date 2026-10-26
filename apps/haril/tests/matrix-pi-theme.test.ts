import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMatrixPiTheme, MATRIX_PI_THEME } from "../src/commands/matrix-pi-theme.js";

describe("HARIL-managed Pi Matrix theme", () => {
  it("creates and repairs the theme without touching user settings or extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "haril-matrix-pi-"));
    try {
      const settings = join(root, "settings.json");
      const original = JSON.stringify({ theme: "dark", packages: ["npm:pi-context-view"] });
      writeFileSync(settings, original, "utf8");

      const path = ensureMatrixPiTheme(root);
      const actual = JSON.parse(readFileSync(path, "utf8"));
      expect(actual.name).toBe("haril-matrix");
      expect(actual.appearance).toBe("dark");
      expect(actual.colors.accent).toBe("phosphor");
      expect(actual.colors.toolTitle).toBe("light");
      expect(readFileSync(settings, "utf8")).toBe(original);

      // An interrupted old installation should self-heal on the next launch.
      writeFileSync(path, "{ broken", "utf8");
      expect(ensureMatrixPiTheme(root)).toBe(path);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(MATRIX_PI_THEME);
      expect(readFileSync(settings, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
