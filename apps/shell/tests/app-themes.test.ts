import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData } from "../src/data.js";
import { resolveTheme } from "../src/theme.js";
import { seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Choosing a theme (TUI-D14): Enter on a theme applies it at once and writes ui.theme into the config file, keeping
// everything else; a theme that cannot be loaded shows its warning and is not saved.

const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const ENTER = "\r";

let root: string;
let dataDir: string;
let runtimeRoot: string;
let configPath: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-theme-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  configPath = join(runtimeRoot, "config", "haril.json");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, "config", "themes"), { recursive: true });
  seedStore(dataDir);
});

afterEach(() => {
  for (const data of opened) data.close();
  opened.length = 0;
  rmSync(root, { recursive: true, force: true });
});

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
}

function mount(): Mounted {
  const data = openShellData({
    paths: { dataDir, runtimeRoot, configPath },
    env: {},
  });
  opened.push(data);
  const terminal = new VirtualTerminal();
  const app = createShellApp({
    terminal,
    theme: THEME,
    banner: { isolation: "N0", pendingApprovals: 0 },
    data,
    settings: {
      dataDir,
      runtimeRoot,
      configPath,
      themeName: "haril-dark",
      themeLabel: "haril-dark",
    },
  });
  return { terminal, app };
}

function frame(mounted: Mounted): string {
  return mounted.app.frameText().join("\n");
}

describe("choose a theme (TUI-D14)", () => {
  it("Enter on a theme applies it at once, writes ui.theme and keeps the providers", async () => {
    const providers = [{ id: "lan", baseUrl: "http://127.0.0.1:8000/v1", keyEnv: "HARIL_LAN_KEY" }];
    mkdirSync(join(runtimeRoot, "config"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ providers, ui: { theme: "haril-dark" } }));
    const mounted = mount();
    mounted.app.start();
    mounted.terminal.send("8");
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("theme haril-light saved");
    expect(frame(mounted)).toContain("theme in use: haril-light");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      providers,
      ui: { theme: "haril-light" },
    });
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("creates haril.json holding only ui.theme when the file does not exist", async () => {
    const mounted = mount();
    mounted.app.start();
    mounted.terminal.send("8");
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ ui: { theme: "haril-light" } });
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("t jumps to the Themes panel from any other panel", async () => {
    const mounted = mount();
    mounted.app.start();
    mounted.terminal.send("2");
    mounted.terminal.send("t");
    expect(frame(mounted)).toContain("theme in use: haril-dark");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("a user theme that cannot be loaded shows its warning and is not saved", async () => {
    writeFileSync(join(runtimeRoot, "config", "themes", "broken.json"), "{ not json");
    const mounted = mount();
    mounted.app.start();
    mounted.terminal.send("8");
    mounted.terminal.send(DOWN);
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("is not valid JSON");
    expect(frame(mounted)).toContain("using haril-dark");
    expect(frame(mounted)).not.toContain("saved");
    expect(existsSync(configPath)).toBe(false);
    mounted.terminal.send("q");
    await mounted.app.done;
  });
});
