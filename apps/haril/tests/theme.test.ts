import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { theme } from "../src/commands/theme.js";
import type { HostInfo } from "../src/context.js";
import { harilConfigPath } from "../src/providers.js";
import { THEME_PROFILES } from "../src/themes/catalog.js";
import { terminalConfigPath } from "../src/themes/preferences.js";
import { harness, parseJson } from "./helpers.js";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOT_AVAILABLE = "Terminal integration is not available yet";

let root: string;
let host: HostInfo;
let path: string;

function hostWith(env: Record<string, string> = {}, interactive = false): HostInfo {
  return {
    nodeVersion: "v24.21.0",
    platform: process.platform,
    arch: "x64",
    homeDir: root,
    cwd: root,
    interactive,
    env: { HARIL_RUNTIME_DIR: root, ...env },
  };
}

function runTheme(args: readonly string[], on: HostInfo = host) {
  const h = harness();
  const code = theme(args, h.io, on);
  return { ...h, code };
}

function writeStored(text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-theme-"));
  host = hostWith();
  path = terminalConfigPath(host);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the catalog", () => {
  it("holds exactly the three profiles with their palettes and fonts", () => {
    const summary = THEME_PROFILES.map((profile) => ({
      id: profile.id,
      basedOn: profile.basedOn,
      palette: Object.fromEntries(profile.palette.map((color) => [color.name, color.hex])),
      primary: profile.fonts.primary,
      fallbacks: profile.fonts.fallbacks,
    }));
    expect(summary).toEqual([
      {
        id: "aliens-cyberpunk",
        basedOn: ["aliens", "craver"],
        palette: {
          background: "#100C21",
          pink: "#FF5AD9",
          cyan: "#42E3FA",
          violet: "#AD55DC",
          green: "#3EDCA2",
        },
        primary: "RobotoMono Nerd Font",
        fallbacks: [],
      },
      {
        id: "agnoster-matrix",
        basedOn: ["agnoster", "agnoster.minimal"],
        palette: {
          background: "#030D08",
          matrix: "#00FF66",
          bright: "#77FFA5",
          secondary: "#26EE68",
        },
        primary: "SpaceMono Nerd Font",
        fallbacks: [],
      },
      {
        id: "agnosterplus-future",
        basedOn: ["agnosterplus", "craver"],
        palette: {
          background: "#07172C",
          "electric-blue": "#5EC2FF",
          turquoise: "#7DF8D5",
          text: "#C4E9FF",
        },
        primary: "RobotoMono Nerd Font",
        fallbacks: ["Terminess Nerd Font"],
      },
    ]);
  });

  it("uses Symbols Nerd Font as the symbols font of every profile, never as a face", () => {
    for (const { fonts } of THEME_PROFILES) {
      expect(fonts.symbols).toBe("Symbols Nerd Font");
      expect(fonts.primary).not.toBe("Symbols Nerd Font");
      expect(fonts.fallbacks).not.toContain("Symbols Nerd Font");
    }
  });

  it("gives every profile a unique, valid and fixed Windows Terminal GUID", () => {
    const guids = THEME_PROFILES.map((profile) => profile.windowsTerminalGuid);
    expect(new Set(guids).size).toBe(3);
    for (const guid of guids) expect(guid).toMatch(GUID);
    // Pinned: later slices identify the installed Windows Terminal profiles by these values.
    expect(guids).toEqual([
      "7c1e4a52-9d3b-4f68-a1c7-2e8b5d60f341",
      "d24f86b3-5a17-4c09-8e3d-b19c7a42e615",
      "3a96c0e8-1f74-4b2d-96a5-c8d3e7014b92",
    ]);
  });
});

describe("where the preferences live", () => {
  it("sits beside haril.json, outside the versioned app folder", () => {
    expect(path).toBe(join(root, "config", "terminal.json"));
    expect(dirname(path)).toBe(dirname(harilConfigPath(host).path));
    expect(path.startsWith(join(root, "app"))).toBe(false);
  });

  it("follows HARIL_CONFIG when it names another file", () => {
    const named = join(root, "elsewhere", "custom.json");
    expect(terminalConfigPath(hostWith({ HARIL_CONFIG: named }))).toBe(
      join(root, "elsewhere", "terminal.json"),
    );
  });
});

describe("theme apply", () => {
  it("persists the selection and the flags, and a later status reads them back", () => {
    const applied = runTheme([
      "apply",
      "agnoster-matrix",
      "--prompt-engine",
      "starship",
      "--animations",
      "off",
      "--intensity",
      "high",
      "--shaders",
      "on",
      "--reduced-motion",
      "on",
      "--startup",
      "minimal",
    ]);
    expect(applied.code).toBe(0);
    const status = runTheme(["status", "--json"]);
    expect(status.code).toBe(0);
    expect(parseJson(status.out)).toMatchObject({
      schema: "haril.theme.status/1",
      preferences: {
        activeProfile: "agnoster-matrix",
        promptEngine: "starship",
        animations: false,
        intensity: "high",
        shaders: true,
        reducedMotion: true,
        startup: "minimal",
      },
      warnings: [],
    });
  });

  it("says plainly that the terminal was not changed", () => {
    const text = runTheme(["apply", "aliens-cyberpunk"]);
    expect(text.out.join("\n")).toContain(NOT_AVAILABLE);
    const json = runTheme(["apply", "aliens-cyberpunk", "--json"]);
    expect(parseJson(json.out)).toMatchObject({
      schema: "haril.theme.apply/1",
      activeProfile: "aliens-cyberpunk",
      terminalIntegration: "not_available",
    });
  });

  it("keeps the other preferences when a later apply does not name them", () => {
    runTheme(["apply", "aliens-cyberpunk", "--prompt-engine", "starship"]);
    runTheme(["apply", "agnoster-matrix", "--intensity", "low"]);
    expect(parseJson(runTheme(["status", "--json"]).out)).toMatchObject({
      preferences: {
        activeProfile: "agnoster-matrix",
        promptEngine: "starship",
        intensity: "low",
      },
    });
  });

  it("is idempotent: the same apply leaves the same bytes and reports no change", () => {
    runTheme(["apply", "agnoster-matrix", "--shaders", "on"]);
    const first = readFileSync(path, "utf8");
    const again = runTheme(["apply", "agnoster-matrix", "--shaders", "on", "--json"]);
    expect(again.code).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(parseJson(again.out)).toMatchObject({ changed: false });
  });

  it("refuses an unknown id with the usage code and writes nothing", () => {
    const refused = runTheme(["apply", "nope"]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toContain('unknown profile "nope"');
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an invalid flag value, or a missing id, and writes nothing", () => {
    for (const args of [
      ["apply", "agnoster-matrix", "--prompt-engine", "both"],
      ["apply", "agnoster-matrix", "--animations", "maybe"],
      ["apply", "agnoster-matrix", "--intensity", "extreme"],
      ["apply", "agnoster-matrix", "--startup", "loud"],
      ["apply"],
    ]) {
      expect(runTheme(args).code).toBe(2);
      expect(existsSync(path)).toBe(false);
    }
  });

  it("stores one prompt engine, so both can never be active", () => {
    runTheme(["apply", "agnoster-matrix", "--prompt-engine", "oh-my-posh"]);
    runTheme(["apply", "agnoster-matrix", "--prompt-engine", "starship"]);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.promptEngine).toBe("starship");
    expect(JSON.stringify(stored)).not.toContain("oh-my-posh");
  });

  it("leaves haril.json byte-identical", () => {
    const harilJson = harilConfigPath(host).path;
    const content = '{\r\n    "memory": { "provider": "null" },\r\n  "ui": {"locale":"es"}\r\n}';
    mkdirSync(dirname(harilJson), { recursive: true });
    writeFileSync(harilJson, content);
    expect(runTheme(["apply", "aliens-cyberpunk"]).code).toBe(0);
    expect(readFileSync(harilJson, "utf8")).toBe(content);
  });

  it("does not create haril.json", () => {
    runTheme(["apply", "aliens-cyberpunk"]);
    expect(existsSync(harilConfigPath(host).path)).toBe(false);
  });

  it("keeps the unknown keys of terminal.json", () => {
    writeStored(JSON.stringify({ fromLaterVersion: { kept: [1, 2] }, promptEngine: "starship" }));
    expect(runTheme(["apply", "aliens-cyberpunk"]).code).toBe(0);
    const stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(stored.fromLaterVersion).toEqual({ kept: [1, 2] });
    expect(stored.promptEngine).toBe("starship");
    expect(stored.activeProfile).toBe("aliens-cyberpunk");
  });

  it("replaces a corrupt file only because apply was asked, and warns", () => {
    writeStored("{ not json");
    const applied = runTheme(["apply", "aliens-cyberpunk"]);
    expect(applied.code).toBe(0);
    expect(applied.err.join("\n")).toContain("terminal.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      activeProfile: "aliens-cyberpunk",
    });
  });

  it("reports a failed write and leaves the old file", () => {
    runTheme(["apply", "aliens-cyberpunk"]);
    const before = readFileSync(path, "utf8");
    const h = harness();
    const code = theme(["apply", "agnoster-matrix"], h.io, host, {
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(code).toBe(1);
    expect(h.err.join("\n")).toContain("disk full");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("corrupt or invalid stored values", () => {
  it.each([
    ["broken JSON", "{ not json"],
    ["not an object", "[1, 2]"],
  ])("fall back to the defaults with a warning for %s and keep the file", (_name, text) => {
    writeStored(text);
    const status = runTheme(["status", "--json"]);
    expect(status.code).toBe(0);
    const report = parseJson<{ preferences: unknown; warnings: string[] }>(status.out);
    expect(report.preferences).toEqual({
      activeProfile: null,
      promptEngine: "oh-my-posh",
      animations: true,
      intensity: "medium",
      shaders: false,
      reducedMotion: false,
      startup: "banner",
    });
    expect(report.warnings).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("fall back one value at a time and keep the valid ones", () => {
    const text = JSON.stringify({
      activeProfile: "gone",
      promptEngine: ["oh-my-posh", "starship"],
      animations: "yes",
      intensity: "high",
    });
    writeStored(text);
    const status = runTheme(["status", "--json"]);
    const report = parseJson<{ preferences: Record<string, unknown>; warnings: string[] }>(
      status.out,
    );
    expect(report.preferences).toMatchObject({
      activeProfile: null,
      promptEngine: "oh-my-posh",
      animations: true,
      intensity: "high",
    });
    expect(report.warnings).toHaveLength(3);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("reach list and the text status on stderr, never on stdout", () => {
    writeStored("{ not json");
    const list = runTheme(["list", "--json"]);
    expect(list.code).toBe(0);
    expect(() => parseJson(list.out)).not.toThrow();
    const status = runTheme(["status"]);
    expect(status.err.join("\n")).toContain("terminal.json");
    expect(status.out.join("\n")).not.toContain("not valid JSON");
  });
});

describe("the read-only subcommands", () => {
  it.each([
    [["list"]],
    [["list", "--json"]],
    [["preview", "agnoster-matrix"]],
    [["preview", "agnoster-matrix", "--json"]],
    [["status"]],
    [["status", "--json"]],
  ])("%j writes nothing, with no config folder yet", (args) => {
    expect(runTheme(args).code).toBe(0);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("list, preview and status leave an existing file as it is", () => {
    writeStored('{"activeProfile":"agnoster-matrix"}');
    runTheme(["list"]);
    runTheme(["preview", "aliens-cyberpunk"]);
    runTheme(["status"]);
    expect(readFileSync(path, "utf8")).toBe('{"activeProfile":"agnoster-matrix"}');
  });

  it("list marks the active profile only", () => {
    runTheme(["apply", "agnoster-matrix"]);
    const text = runTheme(["list"]).out;
    expect(text.filter((line) => line.startsWith("*"))).toHaveLength(1);
    expect(text.find((line) => line.startsWith("*"))).toContain("agnoster-matrix");
    const json = parseJson<{ schema: string; profiles: { id: string; active: boolean }[] }>(
      runTheme(["list", "--json"]).out,
    );
    expect(json.schema).toBe("haril.theme.list/1");
    expect(json.profiles.map((profile) => [profile.id, profile.active])).toEqual([
      ["aliens-cyberpunk", false],
      ["agnoster-matrix", true],
      ["agnosterplus-future", false],
    ]);
  });

  it("status without a file shows the defaults and no active profile", () => {
    const status = runTheme(["status"]);
    expect(status.out.join("\n")).toContain("active profile: none");
    expect(status.err).toEqual([]);
  });
});

describe("theme preview", () => {
  const ESCAPE = "\u001b[";

  it("colours the swatches in a terminal", () => {
    const shown = runTheme(["preview", "aliens-cyberpunk"], hostWith({}, true));
    const text = shown.out.join("\n");
    expect(text).toContain(`${ESCAPE}48;2;255;90;217m`);
    expect(text).toContain("#FF5AD9");
  });

  it("is plain text when stdout is not a terminal", () => {
    const text = runTheme(["preview", "aliens-cyberpunk"]).out.join("\n");
    expect(text).not.toContain(ESCAPE);
    expect(text).toContain("#FF5AD9");
    expect(text).toContain("RobotoMono Nerd Font");
    expect(text).toContain("Symbols Nerd Font");
  });

  it("is plain text when NO_COLOR is set, even in a terminal", () => {
    const shown = runTheme(["preview", "aliens-cyberpunk"], hostWith({ NO_COLOR: "1" }, true));
    expect(shown.out.join("\n")).not.toContain(ESCAPE);
  });

  it("shows the fallback font and labels the symbols font", () => {
    const text = runTheme(["preview", "agnosterplus-future"]).out.join("\n");
    expect(text).toContain("primary: RobotoMono Nerd Font");
    expect(text).toContain("fallback: Terminess Nerd Font");
    expect(text).toContain("symbols: Symbols Nerd Font");
  });

  it("has a JSON form with its schema, and no escapes even in a terminal", () => {
    const shown = runTheme(["preview", "agnoster-matrix", "--json"], hostWith({}, true));
    expect(shown.out.join("\n")).not.toContain(ESCAPE);
    expect(parseJson(shown.out)).toMatchObject({
      schema: "haril.theme.preview/1",
      profile: { id: "agnoster-matrix", fonts: { primary: "SpaceMono Nerd Font" } },
    });
  });

  it("refuses an unknown id", () => {
    expect(runTheme(["preview", "nope"]).code).toBe(2);
  });
});

describe("the command line", () => {
  it("is dispatched by the CLI and listed in the help", () => {
    const h = harness();
    expect(run(["theme", "list"], h.io, host)).toBe(0);
    expect(h.out.join("\n")).toContain("agnosterplus-future");
    const help = harness();
    expect(run(["help"], help.io, host)).toBe(0);
    expect(help.out.join("\n")).toContain("haril theme list");
  });

  it("refuses a missing or unknown subcommand, and the slices not yet delivered", () => {
    for (const args of [[], ["doctor"], ["restore"], ["install"]]) {
      expect(runTheme(args).code).toBe(2);
    }
  });

  it("refuses unknown options and extra positionals", () => {
    expect(runTheme(["list", "--nope"]).code).toBe(2);
    expect(runTheme(["status", "extra"]).code).toBe(2);
    expect(runTheme(["apply", "agnoster-matrix", "extra"]).code).toBe(2);
  });
});
