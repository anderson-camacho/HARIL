import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveThemeChoice } from "../src/config-file.js";

// Writing ui.theme (TUI-D14): every other key is kept, a missing file is created, a broken file is left alone.

let root: string;
let configDir: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-theme-config-"));
  configDir = join(root, "config");
  file = join(configDir, "haril.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("saveThemeChoice", () => {
  it("sets ui.theme and keeps the providers and every other key", () => {
    mkdirSync(configDir, { recursive: true });
    const providers = [{ id: "lan", baseUrl: "http://127.0.0.1:8000/v1", keyEnv: "HARIL_LAN_KEY" }];
    writeFileSync(
      file,
      JSON.stringify({ providers, ui: { density: "compact", theme: "haril-dark" }, extra: [1, 2] }),
    );
    saveThemeChoice(file, "haril-light");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      providers,
      ui: { density: "compact", theme: "haril-light" },
      extra: [1, 2],
    });
  });

  it("creates the file, and its directory, with only ui.theme when it does not exist", () => {
    saveThemeChoice(file, "haril-light");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ui: { theme: "haril-light" } });
  });

  it("leaves no temporary file beside the config after a write", () => {
    saveThemeChoice(file, "haril-dark");
    expect(readdirSync(configDir)).toEqual(["haril.json"]);
  });

  it("refuses a file that is not valid JSON and does not touch it", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, "{ broken");
    expect(() => saveThemeChoice(file, "haril-light")).toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ broken");
  });

  it("refuses a ui value that is not an object", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ ui: "dark" }));
    expect(() => saveThemeChoice(file, "haril-light")).toThrow(/ui must be an object/);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ui: "dark" });
  });
});
