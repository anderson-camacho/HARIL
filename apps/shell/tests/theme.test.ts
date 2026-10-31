import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_NAME,
  NATIVE_THEME_NAMES,
  resolveTheme,
  SHELL_THEME_TOKENS,
  themeFromText,
} from "../src/theme.js";

// Theme loader (TUI-D2): our own reader of the Pi theme JSON format, without importing pi-coding-agent.
// Lookup: <runtime root>/config/themes/<name>.json first, then the themes embedded in the bundle.

let root: string;
let themesDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-theme-test-"));
  themesDir = join(root, "config", "themes");
  mkdirSync(themesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function userTheme(name: string, document: unknown): void {
  writeFileSync(join(themesDir, `${name}.json`), JSON.stringify(document), "utf8");
}

// "x" painted in a truecolor foreground. The escape character is built at run time so the pattern stays readable.
const ESC = String.fromCharCode(27);
const TRUECOLOR_X = new RegExp(`^${ESC}\\[38;2;\\d+;\\d+;\\d+mx${ESC}\\[39m$`);

const VALID = {
  name: "custom",
  appearance: "dark",
  vars: { brand: "#112233", soft: "brand" },
  colors: {
    accent: "brand",
    text: "#ffffff",
    muted: "#808080",
    warning: "#ffff00",
  },
};

describe("resolveTheme", () => {
  it("loads the default native Future theme when nothing is configured", () => {
    expect(DEFAULT_THEME_NAME).toBe("haril-future");
    const { theme, warning } = resolveTheme({ name: DEFAULT_THEME_NAME, runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(theme.source).toBe("native");
    expect(warning).toBeUndefined();
  });

  it("embeds six themes, each with every shell token in a color of its own", () => {
    expect(NATIVE_THEME_NAMES).toEqual([
      "haril-future",
      "haril-matrix",
      "haril-dark",
      "haril-light",
      "haril-crimson",
      "haril-blossom",
    ]);
    for (const name of NATIVE_THEME_NAMES) {
      const { theme, warning } = resolveTheme({ name, runtimeRoot: root });
      expect(warning).toBeUndefined();
      expect(theme.name).toBe(name);
      const painted = SHELL_THEME_TOKENS.map((token) => theme.fg(token, "x"));
      for (const text of painted) expect(text).toMatch(TRUECOLOR_X);
      // border, ok and danger are colors of their own in the native themes, not fallbacks.
      expect(new Set(painted).size).toBe(SHELL_THEME_TOKENS.length);
    }
  });

  it("loads a user theme without border, ok and danger: they take muted, accent and warning (LD-T6b-1)", () => {
    userTheme("older", VALID);
    const { theme, warning } = resolveTheme({ name: "older", runtimeRoot: root });
    expect(warning).toBeUndefined();
    expect(theme.source).toBe("user");
    expect(theme.fg("border", "b")).toBe(theme.fg("muted", "b"));
    expect(theme.fg("ok", "o")).toBe(theme.fg("accent", "o"));
    expect(theme.fg("danger", "d")).toBe(theme.fg("warning", "d"));
  });

  it("uses the border, ok and danger colors a user theme gives", () => {
    userTheme("full", {
      ...VALID,
      colors: { ...VALID.colors, border: "#010203", ok: "#00ff00", danger: "#ff0000" },
    });
    const { theme, warning } = resolveTheme({ name: "full", runtimeRoot: root });
    expect(warning).toBeUndefined();
    expect(theme.fg("border", "b")).toBe("\x1b[38;2;1;2;3mb\x1b[39m");
    expect(theme.fg("ok", "o")).toBe("\x1b[38;2;0;255;0mo\x1b[39m");
    expect(theme.fg("danger", "d")).toBe("\x1b[38;2;255;0;0md\x1b[39m");
  });

  it("loads the embedded light theme by name", () => {
    const { theme, warning } = resolveTheme({ name: "haril-light", runtimeRoot: root });
    expect(theme.name).toBe("haril-light");
    expect(theme.source).toBe("native");
    expect(warning).toBeUndefined();
  });

  it("resolves variable references before emitting truecolor", () => {
    userTheme("custom", VALID);
    const { theme, warning } = resolveTheme({ name: "custom", runtimeRoot: root });
    expect(warning).toBeUndefined();
    expect(theme.source).toBe("user");
    // #112233 is 17, 34, 51; the reference "brand" stands for it.
    expect(theme.fg("accent", "x")).toBe("\x1b[38;2;17;34;51mx\x1b[39m");
    expect(theme.fg("text", "y")).toBe("\x1b[38;2;255;255;255my\x1b[39m");
  });

  it("the user theme directory wins over a native theme of the same name", () => {
    userTheme("haril-light", { ...VALID, name: "haril-light" });
    const { theme } = resolveTheme({ name: "haril-light", runtimeRoot: root });
    expect(theme.source).toBe("user");
  });

  it("falls back to the default with a warning when the user file is not valid JSON", () => {
    writeFileSync(join(themesDir, "broken.json"), "{ not json", "utf8");
    const { theme, warning } = resolveTheme({ name: "broken", runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(warning).toMatch(/broken\.json/);
  });

  it("falls back with a warning that names a missing required color", () => {
    userTheme("partial", {
      name: "partial",
      colors: { accent: "#010101", text: "#020202", muted: "#030303" },
    });
    const { theme, warning } = resolveTheme({ name: "partial", runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(warning).toMatch(/warning/);
  });

  it("falls back with a warning when the theme name is unknown", () => {
    const { theme, warning } = resolveTheme({ name: "does-not-exist", runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(warning).toMatch(/does-not-exist/);
  });

  it("rejects a theme name that would leave the themes directory", () => {
    const { theme, warning } = resolveTheme({ name: "../haril", runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(warning).toMatch(/\.\./);
  });

  it("rejects color forms outside the supported subset with a clear warning", () => {
    userTheme("oklch", {
      name: "oklch",
      colors: {
        accent: "oklch(70% 0.12 220)",
        text: "#ffffff",
        muted: "#808080",
        warning: "#ffff00",
      },
    });
    const { theme, warning } = resolveTheme({ name: "oklch", runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(warning).toMatch(/accent.*hex|accent.*supported/);
  });

  it("accepts a 256-color index and the terminal default (empty string)", () => {
    const theme = themeFromText(
      "inline",
      JSON.stringify({
        name: "inline",
        colors: { accent: 39, text: "", muted: "#abc", warning: "#ffff00" },
      }),
    );
    expect(theme.fg("accent", "a")).toBe("\x1b[38;5;39ma\x1b[39m");
    expect(theme.fg("text", "t")).toBe("t");
    expect(theme.fg("muted", "m")).toBe("\x1b[38;2;170;187;204mm\x1b[39m");
  });

  it("rejects a variable cycle instead of looping", () => {
    userTheme("cycle", {
      name: "cycle",
      vars: { a: "b", b: "a" },
      colors: { accent: "a", text: "#ffffff", muted: "#808080", warning: "#ffff00" },
    });
    const { theme, warning } = resolveTheme({ name: "cycle", runtimeRoot: root });
    expect(theme.name).toBe("haril-future");
    expect(warning).toMatch(/cycle|reference/);
  });
});
