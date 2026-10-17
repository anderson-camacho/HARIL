import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GitStatus } from "@haril/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData } from "../src/data.js";
import { HELP_LINES } from "../src/help.js";
import { resolveTheme } from "../src/theme.js";
import { openSeedStore, proposeExamplePlan, seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The console frame (LD-T6b-1): a top bar, the main area with the tabs and the active view (the HARIL banner while
// nothing runs), a right column of boxes from 100 columns on, a bordered box at the bottom and a status line. The
// frame is always exactly the terminal's rows, and no line is wider than its columns.

const THEME = resolveTheme({ name: "haril-crimson", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ENTER = "\r";
const DOWN = "\x1b[B";
const WIDE = { columns: 120, rows: 40 } as const;
const NARROW = { columns: 80, rows: 24 } as const;
const TAGLINE = "Many minds. One flow.";

let root: string;
let dataDir: string;
let runtimeRoot: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-frame-"));
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

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
  // The roots readGit was asked for, in order.
  readonly gitReads: string[];
}

function mount(
  size: { readonly columns: number; readonly rows: number },
  git: GitStatus | undefined = { branch: "main", changes: 3 },
): Mounted {
  const data = openShellData({
    paths: { dataDir, runtimeRoot, configPath: join(runtimeRoot, "config", "haril.json") },
    env: {},
  });
  opened.push(data);
  const terminal = new VirtualTerminal([], size);
  const gitReads: string[] = [];
  const app = createShellApp({
    terminal,
    theme: THEME,
    banner: { isolation: "N0" },
    data,
    settings: {
      dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
      themeName: "haril-crimson",
      themeLabel: "haril-crimson",
    },
    defaultModel: "qwen-test",
    readGit: async (rootPath) => {
      gitReads.push(rootPath);
      return git;
    },
  });
  return { terminal, app, gitReads };
}

// One project and nothing else: no task, no approval, no runtime lease.
function idleStore(): void {
  const store = openSeedStore(dataDir);
  try {
    store.projects.register({ slug: "solo", name: "Solo", rootPath: "/work/solo" });
  } finally {
    store.close();
  }
}

async function started(mounted: Mounted): Promise<string[]> {
  mounted.app.start();
  await sleep(5);
  return mounted.app.frameText();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quit(mounted: Mounted): Promise<void> {
  mounted.terminal.send("q");
  await mounted.app.done;
}

function expectShape(lines: readonly string[], size: { columns: number; rows: number }): void {
  expect(lines).toHaveLength(size.rows);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns);
}

describe("the frame at 120x40 (LD-T6b-1)", () => {
  it("idle: the top bar, the HARIL banner with its facts, the right column and the bottom box", async () => {
    idleStore();
    const mounted = mount(WIDE);
    const lines = await started(mounted);
    expectShape(lines, WIDE);
    const screen = lines.join("\n");
    expect(lines[0]).toMatch(/^◆ HARIL ◇ solo ◇ qwen-test +ctx n\/a ◇ tok 0\/0 ◇ runtime idle$/);
    // The banner, the tagline and the facts grid, in the main area.
    expect(screen).toContain("██");
    expect(screen).toContain(TAGLINE);
    for (const label of [
      "PROJECTS",
      "TASKS",
      "AGENTS",
      "RUNTIME",
      "VERSION",
      "DATA",
      "APPROVALS",
      "THEME",
    ]) {
      expect(screen).toContain(label);
    }
    expect(screen).toContain("haril-crimson");
    // The right column takes the last 30 columns, right under the top bar.
    expect(lines[1]?.slice(90)).toMatch(/^┌─ Status ─+┐$/);
    for (const title of ["Runtime", "Approvals", "Taxis", "Tokens"]) {
      expect(screen).toMatch(new RegExp(`┌─ ${title} ─+┐`));
    }
    expect(screen).toContain("/work/solo");
    expect(screen).toMatch(/branch +main/);
    expect(screen).toContain("3 changed");
    expect(screen).toContain("none pending");
    expect(screen).toContain("0 busy · 1 free");
    expect(screen).toContain("not connected (M4)");
    expect(screen).toContain("isolation N0");
    expect(mounted.gitReads).toEqual(["/work/solo"]);
    // The bottom box of the main area holds the keys; the status line is the last line.
    expect(lines[36]).toMatch(/^┌─+┐ /);
    expect(lines[37]).toMatch(/^│ .*g goal.*│ /);
    expect(lines[38]).toMatch(/^└─+┘ /);
    expect(lines[39]).toMatch(/^qwen-test · runtime idle · tok 0\/0 +\? help · q quit$/);
    await quit(mounted);
  });

  it("with work: Live is the default view, the context bar shows and one taxi is busy", async () => {
    seedStore(dataDir);
    const mounted = mount(WIDE);
    const lines = await started(mounted);
    expectShape(lines, WIDE);
    const screen = lines.join("\n");
    expect(screen).toContain("Newest tasks, oldest first");
    expect(screen).not.toContain(TAGLINE);
    // The running task has settled nothing yet against its 1000 tokens.
    expect(lines[0]).toMatch(/ctx ▱{8} 0% ◇ tok 40\/12 ◇ runtime running$/);
    expect(screen).toContain("1 busy · 0 free");
    expect(screen).toContain(`pid ${process.pid}`);
    expect(screen).toContain("in 40 · out 12");
    // Two projects and no filter: the Status box names no single root.
    expect(screen).toMatch(/project +all \(2\)/);
    expect(mounted.gitReads).toEqual([]);
    await quit(mounted);
  });

  it("a pending plan: the Approvals box points at p, and the banner gives way to the active panel", async () => {
    idleStore();
    const store = openSeedStore(dataDir);
    const projectId = store.projects.list()[0]?.projectId ?? "";
    store.close();
    proposeExamplePlan(dataDir, projectId);
    const mounted = mount(WIDE);
    const screen = (await started(mounted)).join("\n");
    expect(screen).toContain("1 pending");
    expect(screen).toContain("p to review");
    expect(screen).not.toContain(TAGLINE);
    expect(screen).toContain("all projects");
    await quit(mounted);
  });

  it("text from git is defused like any other text", async () => {
    idleStore();
    const mounted = mount(WIDE, { branch: "evil\x1b]0;title\x07", changes: 0 });
    const screen = (await started(mounted)).join("\n");
    expect(screen).toContain("evil?]0;title?");
    expect(screen).toContain("clean");
    expect(mounted.terminal.output.join("")).not.toContain("\x1b]0;title");
    await quit(mounted);
  });

  it("draws the borders in the theme's border color", async () => {
    idleStore();
    const mounted = mount(WIDE);
    await started(mounted);
    const [borderColor] = THEME.fg("border", "X").split("X");
    const [accentColor] = THEME.fg("accent", "X").split("X");
    const output = mounted.terminal.output.join("");
    expect(output).toContain(`${borderColor}┌─ `);
    expect(output).toContain(`${accentColor}`);
    await quit(mounted);
  });
});

describe("the frame at 80x24 (LD-T6b-1)", () => {
  it("idle: no right column, the banner still fits and every line is within the width", async () => {
    idleStore();
    const mounted = mount(NARROW);
    const lines = await started(mounted);
    expectShape(lines, NARROW);
    const screen = lines.join("\n");
    expect(screen).not.toContain("┌─ Status");
    expect(screen).toContain(TAGLINE);
    expect(screen).toContain("██");
    expect(lines[0]).toMatch(/^◆ HARIL ◇ solo ◇ qwen-test .*runtime idle$/);
    expect(lines[20]).toMatch(/^┌─+┐$/);
    expect(lines[22]).toMatch(/^└─+┘$/);
    expect(lines[23]).toMatch(/\? help · q quit$/);
    await quit(mounted);
  });

  it("with work and a pending plan: Live by default, the top bar folds in the approvals", async () => {
    const seeded = seedStore(dataDir);
    proposeExamplePlan(dataDir, seeded.demoId);
    const mounted = mount(NARROW);
    const lines = await started(mounted);
    expectShape(lines, NARROW);
    expect(lines.join("\n")).toContain("Newest tasks, oldest first");
    expect(lines[0]).toMatch(/runtime running ◇ 1 approval \(p\)$/);
    expect(lines[23]).toContain(`runtime running (pid ${process.pid})`);
    await quit(mounted);
  });

  it("a short terminal shows the active panel instead of the banner", async () => {
    idleStore();
    const size = { columns: 80, rows: 14 };
    const mounted = mount(size);
    const lines = await started(mounted);
    expectShape(lines, size);
    expect(lines.join("\n")).not.toContain(TAGLINE);
    expect(lines.join("\n")).toContain("all projects");
    await quit(mounted);
  });

  it("the right column appears at 100 columns and not at 99", async () => {
    idleStore();
    for (const columns of [99, 100]) {
      const size = { columns, rows: 30 };
      const mounted = mount(size);
      const lines = await started(mounted);
      expectShape(lines, size);
      expect(lines.join("\n").includes("┌─ Status")).toBe(columns === 100);
      await quit(mounted);
    }
  });

  it("the help shows every line without scrolling", async () => {
    idleStore();
    const mounted = mount(NARROW);
    await started(mounted);
    mounted.terminal.send("?");
    const lines = mounted.app.frameText();
    expectShape(lines, NARROW);
    for (const line of HELP_LINES) {
      if (line !== "") expect(lines.some((shown) => shown.trimEnd() === line)).toBe(true);
    }
    await quit(mounted);
  });
});

describe("the home view and git (LD-T6b-1)", () => {
  it("a key that moves or opens leaves the banner for the active panel", async () => {
    idleStore();
    const mounted = mount(NARROW);
    expect((await started(mounted)).join("\n")).toContain(TAGLINE);
    mounted.terminal.send(DOWN);
    const screen = mounted.app.frameText().join("\n");
    expect(screen).not.toContain(TAGLINE);
    expect(screen).toContain("> all projects");
    await quit(mounted);
  });

  it("reads git on opening, on r and when the filter changes, never on a timer", async () => {
    idleStore();
    const mounted = mount(NARROW);
    await started(mounted);
    expect(mounted.gitReads).toEqual(["/work/solo"]);
    await sleep(100);
    expect(mounted.gitReads).toHaveLength(1);
    mounted.terminal.send("r");
    await sleep(5);
    expect(mounted.gitReads).toHaveLength(2);
    mounted.terminal.send("1");
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    await sleep(5);
    expect(mounted.gitReads).toEqual(["/work/solo", "/work/solo", "/work/solo"]);
    await quit(mounted);
  });
});
