import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarilActions } from "../src/actions.js";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData } from "../src/data.js";
import { resolveTheme } from "../src/theme.js";
import { openSeedStore, seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The add-task action from the TUI (TUI-D13): the form, the exact CLI argv, the outcome line, the reload and the
// keys that belong to the form. A fixture haril records its argv and prints what the CLI would print.

const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const ENTER = "\r";

let root: string;
let dataDir: string;
let runtimeRoot: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-add-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, "config", "themes"), { recursive: true });
});

afterEach(() => {
  for (const data of opened) data.close();
  opened.length = 0;
  rmSync(root, { recursive: true, force: true });
});

// The fixture haril: records argv in argv.json beside itself, prints one line and exits with the code.
function fakeHaril(line: string, code: number, toStderr = false): string {
  const dir = join(root, `fake-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "haril.mjs");
  writeFileSync(
    entry,
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));',
      `(${toStderr ? "process.stderr" : "process.stdout"}).write(${JSON.stringify(`${line}\n`)});`,
      `process.exitCode = ${code};`,
    ].join("\n"),
    "utf8",
  );
  return entry;
}

function argvOf(entry: string): string[] {
  return JSON.parse(readFileSync(join(entry, "..", "argv.json"), "utf8")) as string[];
}

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
}

function mount(options: {
  dataDir?: string;
  harilEntry?: string;
  defaultModel?: string;
  configPath?: string;
}): Mounted {
  const data = openShellData({
    paths: {
      dataDir: options.dataDir ?? dataDir,
      runtimeRoot,
      configPath: options.configPath ?? join(runtimeRoot, "config", "haril.json"),
    },
    env: {},
  });
  opened.push(data);
  const terminal = new VirtualTerminal();
  const app = createShellApp({
    terminal,
    theme: THEME,
    banner: { isolation: "N0" },
    data,
    settings: {
      dataDir: options.dataDir ?? dataDir,
      runtimeRoot,
      configPath: options.configPath ?? join(runtimeRoot, "config", "haril.json"),
      themeName: "haril-dark",
      themeLabel: "haril-dark",
    },
    actions: createHarilActions({ harilEntry: options.harilEntry }),
    defaultModel: options.defaultModel,
  });
  return { terminal, app };
}

function frame(mounted: Mounted): string {
  return mounted.app.frameText().join("\n");
}

async function waitForFrame(mounted: Mounted, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (frame(mounted).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the frame never showed "${text}":\n${frame(mounted)}`);
}

function typeText(mounted: Mounted, text: string): void {
  for (const key of text) mounted.terminal.send(key);
}

describe("add task with a seeded store (TUI-D13)", () => {
  beforeEach(() => {
    seedStore(dataDir);
  });

  it("a runs haril task add with the exact argv, shows the outcome and closes the form", async () => {
    const entry = fakeHaril("command c-9: queued (applied by `haril start`)", 0);
    const mounted = mount({ harilEntry: entry, defaultModel: "qwen-test" });
    mounted.app.start();
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    mounted.terminal.send("a");
    expect(frame(mounted)).toContain("project demo");
    typeText(mounted, "Write docs");
    mounted.terminal.send(ENTER);
    await waitForFrame(mounted, "queued (applied by");
    expect(argvOf(entry)).toEqual([
      "task",
      "add",
      "Write docs",
      "--project",
      "demo",
      "--agent",
      "analyst",
      "--model",
      "qwen-test",
      "--data-dir",
      dataDir,
    ]);
    expect(frame(mounted)).not.toContain("Add task to project");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("Esc cancels the form and runs nothing", async () => {
    const entry = fakeHaril("never printed", 0);
    const mounted = mount({ harilEntry: entry });
    mounted.app.start();
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    mounted.terminal.send("a");
    typeText(mounted, "Abandon me");
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toContain("add task cancelled");
    expect(frame(mounted)).not.toContain("Abandon me");
    expect(existsSync(join(entry, "..", "argv.json"))).toBe(false);
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("while the form is open, q and digits are typed into the title and do not quit or switch panels", async () => {
    const mounted = mount({ harilEntry: fakeHaril("unused", 0) });
    mounted.app.start();
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    mounted.terminal.send("a");
    typeText(mounted, "q2");
    expect(frame(mounted)).toContain("q2");
    expect(frame(mounted)).toContain("Add task");
    mounted.terminal.send(ESC);
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("with several projects and no filter it shows a message and runs nothing", async () => {
    const entry = fakeHaril("never printed", 0);
    const mounted = mount({ harilEntry: entry });
    mounted.app.start();
    mounted.terminal.send("a");
    expect(frame(mounted)).toContain("several projects");
    expect(frame(mounted)).not.toContain("Add task");
    expect(existsSync(join(entry, "..", "argv.json"))).toBe(false);
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("a refused command keeps the form open and shows the CLI message", async () => {
    const entry = fakeHaril("haril: agent analyst needs a model: pass --model", 2, true);
    const mounted = mount({ harilEntry: entry, defaultModel: "qwen-test" });
    mounted.app.start();
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    mounted.terminal.send("a");
    typeText(mounted, "Refused");
    mounted.terminal.send(ENTER);
    await waitForFrame(mounted, "needs a model");
    expect(frame(mounted)).toContain("Add task");
    mounted.terminal.send(ESC);
    mounted.terminal.send("q");
    await mounted.app.done;
  });
});

describe("add task with one project and no filter", () => {
  it("uses the only project and the simulated agent when no default model is known", async () => {
    const solo = join(root, "solo");
    const store = openSeedStoreFor(solo);
    store.close();
    const entry = fakeHaril("command c-2: queued (applied by `haril start`)", 0);
    const mounted = mount({ dataDir: solo, harilEntry: entry });
    mounted.app.start();
    mounted.terminal.send("a");
    typeText(mounted, "Write it");
    mounted.terminal.send(ENTER);
    await waitForFrame(mounted, "queued (applied by");
    expect(argvOf(entry)).toEqual([
      "task",
      "add",
      "Write it",
      "--project",
      "solo",
      "--agent",
      "fake:succeed",
      "--data-dir",
      solo,
    ]);
    mounted.terminal.send("q");
    await mounted.app.done;
  });
});

function openSeedStoreFor(dir: string) {
  mkdirSync(dir, { recursive: true });
  const store = openSeedStore(dir);
  store.projects.register({ slug: "solo", name: "Solo", rootPath: "/work/solo" });
  return store;
}
