import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureManagedPiTheme,
  FUTURE_PI_THEME,
  managedPiThemeName,
} from "../src/commands/future-pi-theme.js";
import { MATRIX_PI_THEME } from "../src/commands/matrix-pi-theme.js";

function resolved(token: keyof typeof FUTURE_PI_THEME.colors): string {
  const value: string = FUTURE_PI_THEME.colors[token];
  const vars: Readonly<Record<string, string>> = FUTURE_PI_THEME.vars;
  return vars[value] ?? value;
}

describe("HARIL-managed Pi Future theme", () => {
  it("draws every line orange on the blue palette", () => {
    expect(FUTURE_PI_THEME.name).toBe("haril-future");
    expect(resolved("borderAccent")).toBe("#ff9f45");
    for (const token of [
      "border",
      "borderMuted",
      "mdHr",
      "mdCodeBlockBorder",
      "mdQuoteBorder",
    ] as const) {
      expect(resolved(token)).toBe("#b86e2e");
    }
    expect(resolved("accent")).toBe("#5ec2ff");
    expect(resolved("success")).toBe("#7df8d5");
    expect(resolved("text")).toBe("#c4e9ff");
    expect(resolved("userMessageBg")).toBe("#07172c");
    expect(resolved("customMessageBg")).toBe("#0c2240");
    expect(resolved("selectedBg")).toBe("#16365c");
    expect(resolved("warning")).not.toBe(resolved("borderAccent"));
  });

  it("defines the same tokens as the Matrix theme, so Pi needs nothing else", () => {
    expect(Object.keys(FUTURE_PI_THEME.colors).sort()).toEqual(
      Object.keys(MATRIX_PI_THEME.colors).sort(),
    );
  });

  it("is the same document the shell embeds", () => {
    const shell = readFileSync(
      join(import.meta.dirname, "../../shell/themes/haril-future.json"),
      "utf8",
    );
    expect(JSON.parse(shell)).toEqual(FUTURE_PI_THEME);
  });

  it("uses Future only without an explicit choice, or when Future was chosen", () => {
    expect(managedPiThemeName(undefined)).toBe("haril-future");
    expect(managedPiThemeName("future")).toBe("haril-future");
    expect(managedPiThemeName("haril-future")).toBe("haril-future");
    for (const chosen of ["matrix", "violet", "rose", "amber", "obsidian", "haril-blossom"]) {
      expect(managedPiThemeName(chosen)).toBe("haril-matrix");
    }
  });

  it("creates and repairs the chosen theme without touching user settings", () => {
    const root = mkdtempSync(join(tmpdir(), "haril-future-pi-"));
    try {
      const settings = join(root, "settings.json");
      const original = JSON.stringify({ theme: "dark", packages: ["npm:pi-context-view"] });
      writeFileSync(settings, original, "utf8");

      const future = ensureManagedPiTheme(root, undefined);
      expect(future.name).toBe("haril-future");
      expect(JSON.parse(readFileSync(future.path, "utf8"))).toEqual(FUTURE_PI_THEME);

      writeFileSync(future.path, "{ broken", "utf8");
      expect(ensureManagedPiTheme(root, "future").path).toBe(future.path);
      expect(JSON.parse(readFileSync(future.path, "utf8"))).toEqual(FUTURE_PI_THEME);

      const matrix = ensureManagedPiTheme(root, "matrix");
      expect(matrix.name).toBe("haril-matrix");
      expect(JSON.parse(readFileSync(matrix.path, "utf8"))).toEqual(MATRIX_PI_THEME);

      expect(readFileSync(settings, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
