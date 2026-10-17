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
import { createTask, openSeedStore, proposeExamplePlan, seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The console frame (LD-T6b-1): a top bar, the main area with the tabs and the active view (the HARIL banner while
// nothing runs), a right column of boxes from 100 columns on, a bordered box at the bottom and a status line. The
// frame is always exactly the terminal's rows, and no line is wider than its columns.

const THEME = resolveTheme({ name: "haril-crimson", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const CTRL_C = "\x03";
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

interface MountExtra {
  readonly model?: string;
  readonly themeLabel?: string;
  // Replaces the fake git read that answers `git` at once.
  readonly readGit?: (rootPath: string) => Promise<GitStatus | undefined>;
}

function mount(
  size: { readonly columns: number; readonly rows: number },
  git: GitStatus | undefined = { branch: "main", changes: 3 },
  extra: MountExtra = {},
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
      themeLabel: extra.themeLabel ?? "haril-crimson",
    },
    defaultModel: extra.model ?? "qwen-test",
    readGit: async (rootPath) => {
      gitReads.push(rootPath);
      return extra.readGit === undefined ? git : extra.readGit(rootPath);
    },
  });
  return { terminal, app, gitReads };
}

// One project and nothing else: no task, no approval, no runtime lease.
function idleStore(
  project: { slug: string; name: string; rootPath: string } = {
    slug: "solo",
    name: "Solo",
    rootPath: "/work/solo",
  },
): string {
  const store = openSeedStore(dataDir);
  try {
    return store.projects.register(project).projectId;
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

// Ctrl+C quits in both keyboard modes (LD-T6b-2).
async function quit(mounted: Mounted): Promise<void> {
  mounted.terminal.send(CTRL_C);
  await mounted.app.done;
}

// The shell opens in input mode (LD-T6b-2); Esc switches to navigation mode, where the single keys act.
function keys(mounted: Mounted): void {
  mounted.terminal.send(ESC);
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
    // MC-T4: the memory row shows the provider and its health, as haril memory status does.
    expect(screen).toMatch(/memory +null · not checked/);
    expect(screen).not.toMatch(/memory +not connected/);
    expect(screen).toContain("isolation N0");
    expect(mounted.gitReads).toEqual(["/work/solo"]);
    // The input box closes the main area (LD-T6b-2): the mode in its top border, the typed line, the keys in its bottom
    // border; the status line is the last line.
    expect(lines[36]).toMatch(/^┌─ Input ─+┐ /);
    expect(lines[37]).toMatch(/^│ > type your goal, or \/ for commands +│ /);
    expect(lines[38]).toMatch(/^└─ Esc keys · \/ commands · Ctrl\+C quit ─+┘ /);
    expect(lines[39]).toMatch(/^qwen-test · runtime idle · tok 0\/0 +input · Ctrl\+C quit$/);
    // In navigation mode the bottom border holds the keys.
    keys(mounted);
    const keyed = mounted.app.frameText();
    expect(keyed[36]).toMatch(/^┌─ Keys ─+┐ /);
    expect(keyed[38]).toMatch(/^└─ i type · .*g goal.*┘ /);
    expect(keyed[39]).toMatch(/^qwen-test · runtime idle · tok 0\/0 +keys · \? help · q quit$/);
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
    expect(lines[20]).toMatch(/^┌─ Input ─+┐$/);
    expect(lines[22]).toMatch(/^└─ Esc keys .*─┘$/);
    expect(lines[23]).toMatch(/input · Ctrl\+C quit$/);
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
    keys(mounted);
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
    keys(mounted);
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

  it("runs one git read at a time and one more after it when asked meanwhile", async () => {
    idleStore();
    const answers: ((status: GitStatus | undefined) => void)[] = [];
    const mounted = mount(WIDE, undefined, {
      readGit: () => new Promise((resolve) => answers.push(resolve)),
    });
    await started(mounted);
    expect(mounted.gitReads).toHaveLength(1);
    keys(mounted);
    for (const _ of [1, 2, 3]) mounted.terminal.send("r");
    expect(mounted.gitReads).toHaveLength(1);
    answers[0]?.({ branch: "first", changes: 0 });
    await sleep(5);
    // The three r while the read ran ask for one more read, not three.
    expect(mounted.gitReads).toHaveLength(2);
    answers[1]?.({ branch: "second", changes: 0 });
    await sleep(5);
    expect(mounted.gitReads).toHaveLength(2);
    expect(mounted.app.frameText().join("\n")).toMatch(/branch +second/);
    await quit(mounted);
  });

  it("on a short terminal a key that moves leaves the home too, so work later keeps the panel", async () => {
    const projectId = idleStore();
    const size = { columns: 80, rows: 14 };
    const mounted = mount(size);
    await started(mounted);
    mounted.terminal.send(DOWN);
    expect(mounted.app.frameText().join("\n")).toContain("> solo");
    // A ready task appears, as when a task is added from another terminal.
    const writer = openSeedStore(dataDir);
    try {
      const grant = writer.runtime.acquire({
        pid: process.pid,
        nodeVersion: process.version,
        sqliteVersion: writer.info().sqliteVersion,
        ttlMs: 600_000,
      });
      if (!grant.ok) throw new Error("no lease");
      createTask(writer, projectId, grant.value.epoch, "Arrives later");
    } finally {
      writer.close();
    }
    keys(mounted);
    mounted.terminal.send("r");
    const screen = mounted.app.frameText().join("\n");
    expect(screen).not.toContain("Newest tasks, oldest first");
    expect(screen).toContain("> solo");
    await quit(mounted);
  });
});

describe("the frame with hostile or unusual text (LD-T6b-1)", () => {
  it("wide characters in the project, the branch, the model and the theme never widen a line", async () => {
    idleStore({
      slug: "プロジェクト",
      name: "日本語のプロジェクト名",
      rootPath: "/work/日本語/リポジトリ",
    });
    const git = { branch: "機能/とても長いブランチ名です", changes: 2 };
    const extra = { themeLabel: "テーマ名がとても長い場合のテスト", model: "モデル名-とても長い" };
    for (const size of [
      { columns: 53, rows: 20 },
      { columns: 61, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 99, rows: 30 },
      { columns: 100, rows: 30 },
      { columns: 120, rows: 40 },
      { columns: 40, rows: 10 },
    ]) {
      const mounted = mount(size, git, extra);
      expectShape(await started(mounted), size);
      keys(mounted);
      for (const key of ["1", "8", "?"]) {
        mounted.terminal.send(key);
        expectShape(mounted.app.frameText(), size);
      }
      // pi-tui rendered every frame: a line wider than the terminal throws there.
      await sleep(5);
      await quit(mounted);
    }
  });

  it("below 80x24 the frame is still exactly the rows, none wider than the columns", async () => {
    idleStore();
    const size = { columns: 40, rows: 10 };
    const mounted = mount(size);
    expectShape(await started(mounted), size);
    keys(mounted);
    for (const key of ["1", DOWN, "?", "l", "8"]) {
      mounted.terminal.send(key);
      expectShape(mounted.app.frameText(), size);
    }
    await quit(mounted);
  });

  it("escape sequences in a project's root and name are shown defused", async () => {
    idleStore({ slug: "solo", name: "Name\x1b]0;evil\x07", rootPath: "/work/\x1b[2Jroot" });
    const mounted = mount(WIDE);
    const frames = [(await started(mounted)).join("\n")];
    keys(mounted);
    mounted.terminal.send("1");
    frames.push(mounted.app.frameText().join("\n"));
    const all = frames.join("\n");
    expect(all).toContain("/work/?[2Jroot");
    expect(all).toContain("Name?]0;evil?");
    for (const screen of frames) expect(screen).not.toContain("\x1b");
    const output = mounted.terminal.output.join("");
    expect(output).not.toContain("\x1b]0;evil");
    expect(output).not.toContain("\x1b[2Jroot");
    await quit(mounted);
  });

  it("an escape in the model name is laid out as the text it is shown as", async () => {
    idleStore();
    const mounted = mount(WIDE, undefined, { model: "m\x1b]0;X\x07" });
    const lines = await started(mounted);
    expect(lines[0]).toContain("◆ HARIL ◇ solo ◇ m?]0;X?");
    // The right side of the top bar is whole: the layout measured the defused text.
    expect(lines[0]).toMatch(/ctx n\/a ◇ tok 0\/0 ◇ runtime idle$/);
    expect(lines.at(-1)).toMatch(/^m\?\]0;X\? · runtime idle · tok 0\/0 +input · Ctrl\+C quit$/);
    await quit(mounted);
  });
});

describe("the status line names the branch below 100 columns (LD-T6b-1)", () => {
  it("shows the branch and its changes at 80x24, and not at 120x40 where the Status box has them", async () => {
    idleStore();
    const narrow = mount(NARROW);
    expect((await started(narrow)).at(-1)).toMatch(
      /^qwen-test · runtime idle · tok 0\/0 · git main · 3 changed +input · Ctrl\+C quit$/,
    );
    await quit(narrow);
    const wide = mount(WIDE);
    expect((await started(wide)).at(-1)).not.toContain("git main");
    await quit(wide);
  });

  it("drops the branch first when the line is too long for it", async () => {
    idleStore();
    const mounted = mount(NARROW, { branch: `feature/${"x".repeat(40)}`, changes: 1 });
    expect((await started(mounted)).at(-1)).toMatch(
      /^qwen-test · runtime idle · tok 0\/0 +input · Ctrl\+C quit$/,
    );
    await quit(mounted);
  });
});
