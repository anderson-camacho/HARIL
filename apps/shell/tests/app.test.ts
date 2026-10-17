import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData } from "../src/data.js";
import { resolveTheme } from "../src/theme.js";
import { createTask, openSeedStore, SEED_TITLES, type SeedResult, seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The shell app in a virtual terminal (TUI-T3): panels, keys, detail, reload, help, quit and the banner.
// Assertions read the plain frame the app renders (frameText), so they see the current screen, not the output log.

const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ESC = "\x1b";
const TAB = "\t";
const SHIFT_TAB = `${ESC}[Z`;
const DOWN = `${ESC}[B`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const ENTER = "\r";
const ESCAPE = ESC;

let root: string;
let dataDir: string;
let runtimeRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-app-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, "config", "themes"), { recursive: true });
});

const opened: ShellData[] = [];

afterEach(() => {
  // A failed test may leave a store open; closing it first lets the temp dir be removed on Windows.
  for (const data of opened) data.close();
  opened.length = 0;
  rmSync(root, { recursive: true, force: true });
});

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
  readonly closed: { count: number };
}

function mount(data: ShellData, options: { warning?: string } = {}): Mounted {
  const terminal = new VirtualTerminal();
  const closed = { count: 0 };
  const wrapped: ShellData = {
    load: (scope) => data.load(scope),
    taskDetail: (taskId) => data.taskDetail(taskId),
    close: () => {
      closed.count++;
      data.close();
    },
  };
  const app = createShellApp({
    terminal,
    theme: THEME,
    banner: { isolation: "N0" },
    warning: options.warning,
    data: wrapped,
    settings: {
      dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
      themeName: "haril-dark",
      themeLabel: "haril-dark",
    },
  });
  return { terminal, app, closed };
}

function frame(mounted: Mounted): string {
  return mounted.app.frameText().join("\n");
}

function open(
  env: Record<string, string | undefined> = {},
  paths: { dataDir?: string } = {},
): ShellData {
  const data = openShellData({
    paths: {
      dataDir: paths.dataDir ?? dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
    },
    env,
  });
  opened.push(data);
  return data;
}

async function started(mounted: Mounted): Promise<void> {
  mounted.app.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("shell app with a seeded store", () => {
  let seeded: SeedResult;

  beforeEach(() => {
    seeded = seedStore(dataDir);
  });

  it("shows the header, the banner with runtime and project, and the quit keys in the footer", async () => {
    const mounted = mount(open());
    await started(mounted);
    const screen = frame(mounted);
    expect(screen).toContain("HARIL shell");
    expect(screen).toContain("isolation N0 · 0 pending approvals · runtime running · project all");
    expect(screen).toContain("q quit");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("number keys 1 to 9 select the panel and Tab and Shift+Tab cycle through all eleven", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("2");
    expect(frame(mounted)).toContain("STATE");
    mounted.terminal.send("3");
    expect(frame(mounted)).toContain("runtime active");
    mounted.terminal.send(TAB);
    expect(frame(mounted)).toContain("Token");
    mounted.terminal.send(SHIFT_TAB);
    expect(frame(mounted)).toContain("runtime active");
    mounted.terminal.send("1");
    expect(frame(mounted)).toContain("all projects");
    mounted.terminal.send(SHIFT_TAB);
    expect(frame(mounted)).toContain("Not available in this version.");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("Enter on a project makes it the filter: the banner and the task list follow it", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("project demo");
    mounted.terminal.send("2");
    const screen = frame(mounted);
    expect(screen).toContain(SEED_TITLES.running);
    expect(screen).not.toContain(SEED_TITLES.unrelated);
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("Down moves the selection cursor and End and Home jump to the ends of the list", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("2");
    mounted.terminal.send(DOWN);
    expect(frame(mounted)).toMatch(new RegExp(`> .*${SEED_TITLES.running}`));
    mounted.terminal.send(END);
    expect(frame(mounted)).toMatch(new RegExp(`> .*${SEED_TITLES.unrelated}`));
    mounted.terminal.send(HOME);
    expect(frame(mounted)).toMatch(new RegExp(`> .*${SEED_TITLES.completed}`));
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("Enter on a task opens its detail and Esc returns to the list", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("2");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("result: Logs summarized");
    expect(frame(mounted)).toContain("verification: verified");
    mounted.terminal.send(ESCAPE);
    expect(frame(mounted)).toContain("STATE");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("r picks up a task added to the store after startup", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("2");
    expect(frame(mounted)).not.toContain("Added later");
    const writer = openSeedStore(dataDir);
    try {
      createTask(writer, seeded.demoId, seeded.epoch, "Added later");
    } finally {
      writer.close();
    }
    mounted.terminal.send("r");
    expect(frame(mounted)).toContain("Added later");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("? shows the help with every key, and Esc closes it", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("?");
    const help = frame(mounted);
    for (const key of ["Tab", "Enter", "Esc", "r", "?", "q"]) expect(help).toContain(key);
    mounted.terminal.send(ESCAPE);
    expect(frame(mounted)).toContain("runtime running");
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("q stops the TUI, closes the store and resolves done", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("q");
    await mounted.app.done;
    expect(mounted.terminal.stopped).toBe(true);
    expect(mounted.closed.count).toBe(1);
  });

  it("Ctrl+C quits the same way", async () => {
    const mounted = mount(open());
    await started(mounted);
    mounted.terminal.send("\x03");
    await mounted.app.done;
    expect(mounted.closed.count).toBe(1);
  });

  it("the Models panel shows set or not set for a key variable and never its value", async () => {
    const secret = "fake-key-shell-test-secret-4242";
    writeFileSync(
      join(runtimeRoot, "config", "haril.json"),
      JSON.stringify({
        providers: [
          { id: "gateway", baseUrl: "http://127.0.0.1:8317/v1", keyEnv: "SHELL_TEST_KEY" },
        ],
      }),
    );
    const mounted = mount(open({ SHELL_TEST_KEY: secret }));
    await started(mounted);
    mounted.terminal.send("6");
    expect(frame(mounted)).toContain("SHELL_TEST_KEY: set");
    mounted.terminal.send("q");
    await mounted.app.done;
    expect(frame(mounted)).not.toContain(secret);
    expect(mounted.terminal.output.join("")).not.toContain(secret);
  });

  it("panels 9 to 11 show the not-available text", async () => {
    const mounted = mount(open());
    await started(mounted);
    for (const key of ["9", "8"]) {
      mounted.terminal.send(key);
      expect(frame(mounted)).toContain(key === "9" ? "Not available in this version." : "Themes");
    }
    mounted.terminal.send("q");
    await mounted.app.done;
  });

  it("shows the warning line when one is given", async () => {
    const mounted = mount(open(), { warning: "theme 'broken' not loaded; using haril-dark" });
    await started(mounted);
    expect(frame(mounted)).toContain("using haril-dark");
    mounted.terminal.send("q");
    await mounted.app.done;
  });
});

describe("shell app without a store", () => {
  it("every data panel shows the empty state and nothing creates the database", async () => {
    const emptyDir = join(root, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const mounted = mount(open({}, { dataDir: emptyDir }));
    await started(mounted);
    const message =
      "No HARIL data yet. Create a project with: haril project init <path> --name <name>";
    for (const key of ["1", "2", "3", "4", "5"]) {
      mounted.terminal.send(key);
      expect(frame(mounted).replace(/\s+/g, " ")).toContain(message);
    }
    mounted.terminal.send("q");
    await mounted.app.done;
    expect(existsSync(join(emptyDir, "haril.db"))).toBe(false);
  });
});
