import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskDetail } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData, type ShellSnapshot } from "../src/data.js";
import { resolveTheme } from "../src/theme.js";
import { inNavigationMode } from "./navigation.js";
import { openSeedStore, SEED_TITLES, seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Text written by an agent or read from the store reaches the screen through the render boundary (LD-T6c): each
// Unicode format character but the zero-width joiner, and each lone surrogate, shows as "?". Such a character draws
// nothing or reorders the text around it, so without this a plan could carry words its approver never sees.

const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const ENTER = "\r";
const CTRL_C = "\x03";
const WIDE = { columns: 120, rows: 40 } as const;
const ZWSP = "\u{200B}";
const RLO = "\u{202E}";
const PDF = "\u{202C}";
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
// What the terminal must never receive: a format character other than the joiner, or a lone surrogate.
const HIDDEN = /(?!\u{200D})\p{Cf}|[\u{D800}-\u{DFFF}]/u;
const EXAMPLE_PLAN = fileURLToPath(new URL("../../../examples/plan.valid.json", import.meta.url));

let root: string;
let dataDir: string;
let runtimeRoot: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-visible-"));
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

// ASCII spelled in Unicode tag characters: nothing on a terminal, one "?" per character on the screen.
function tags(text: string): string {
  return [...text].map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0))).join("");
}

// The seeded rows with text an agent could write or a registration could keep: format characters in the demo
// project's slug and name and in the completed task's goal, agent, model and result, and an emoji sequence in the
// running task's goal and agent.
function hostileTask(task: TaskDetail): TaskDetail {
  if (task.goal === SEED_TITLES.completed) {
    return {
      ...task,
      goal: `Summarize${ZWSP}the logs`,
      agentRef: `fake${tags("x")}-agent`,
      model: `m${RLO}${tags("ab")}`,
      result: { text: `Logs${RLO}enod${PDF} ${tags("ok")}` },
    };
  }
  if (task.goal === SEED_TITLES.running) {
    return { ...task, goal: `Write the parser ${FAMILY}`, agentRef: `bot${FAMILY}` };
  }
  return task;
}

function hostile(snapshot: ShellSnapshot): ShellSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.slug === "demo"
        ? { ...project, slug: `de${ZWSP}mo`, name: `Demo${RLO}tcejorp${PDF}` }
        : project,
    ),
    tasks: snapshot.tasks.map(hostileTask),
    live: snapshot.live.map((entry) => ({ ...entry, detail: hostileTask(entry.detail) })),
  };
}

// examples/plan.valid.json with format characters in the goals of its first two tasks, proposed as a planner would.
function proposeHostilePlan(projectId: string): void {
  const plan = JSON.parse(readFileSync(EXAMPLE_PLAN, "utf8")) as { tasks: { goal: string }[] };
  const [survey, draft] = plan.tasks;
  if (survey === undefined || draft === undefined) throw new Error("the example plan changed");
  survey.goal = `Survey the README${RLO}elif terces${PDF} then ${tags("rm -rf ~")}`;
  draft.goal = `Draft${ZWSP}the section ${FAMILY}`;
  const store = openSeedStore(dataDir);
  try {
    const proposed = store.approvals.proposePlan({ projectId, plan, requestedBy: "planner" });
    if (!proposed.ok) throw new Error(`the plan was refused: ${proposed.error.message}`);
  } finally {
    store.close();
  }
}

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
}

function mount(size: { readonly columns: number; readonly rows: number }): Mounted {
  const data = openShellData({
    paths: { dataDir, runtimeRoot, configPath: join(runtimeRoot, "config", "haril.json") },
    env: {},
  });
  opened.push(data);
  const terminal = new VirtualTerminal([], size);
  const app = createShellApp({
    terminal,
    theme: THEME,
    banner: { isolation: "N0" },
    data: {
      load: (scope) => hostile(data.load(scope)),
      taskDetail: (taskId) => {
        const view = data.taskDetail(taskId);
        return view === undefined ? undefined : { ...view, detail: hostileTask(view.detail) };
      },
      close: () => data.close(),
    },
    settings: {
      dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
      themeName: "haril-dark",
      themeLabel: "haril-dark",
    },
    defaultModel: "qwen-test",
  });
  return { terminal, app: inNavigationMode(app, terminal) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quit(mounted: Mounted): Promise<void> {
  mounted.terminal.send(CTRL_C);
  await mounted.app.done;
}

function lineWith(lines: readonly string[], text: string): string {
  const found = lines.find((line) => line.includes(text));
  if (found === undefined) throw new Error(`no line holds "${text}":\n${lines.join("\n")}`);
  return found;
}

// The cells before `text` on its line: where its column starts on the screen.
function cellsBefore(line: string, text: string): number {
  return visibleWidth(line.slice(0, line.indexOf(text)));
}

// Everything the terminal received, rendered frames included, holds no hidden character.
async function expectNothingHiddenSent(mounted: Mounted): Promise<void> {
  await sleep(5);
  expect(mounted.terminal.output.join("")).not.toMatch(HIDDEN);
}

describe("text from agents and the store shows as the screen draws it (LD-T6c)", () => {
  it("the plan an approver reads shows a planned goal's format characters as ?", async () => {
    const seeded = seedStore(dataDir);
    proposeHostilePlan(seeded.demoId);
    const mounted = mount(WIDE);
    mounted.app.start();
    mounted.terminal.send("p");
    mounted.terminal.send(ENTER);
    const lines = mounted.app.frameText();
    expect(lineWith(lines, "1. survey-readme:")).toContain(
      "1. survey-readme: Survey the README?elif terces? then ????????",
    );
    expect(lineWith(lines, "2. draft-section:")).toContain(
      `2. draft-section: Draft?the section ${FAMILY}`,
    );
    expect(lines.join("\n")).not.toMatch(HIDDEN);
    await expectNothingHiddenSent(mounted);
    await quit(mounted);
  });

  it("Live shows a result, an agent and a goal with format characters as ?, in the columns of ASCII rows", async () => {
    seedStore(dataDir);
    const mounted = mount(WIDE);
    mounted.app.start();
    const lines = mounted.app.frameText();
    const column = cellsBefore(lineWith(lines, "GOAL · RESULT"), "GOAL · RESULT");
    const completed = lineWith(lines, "Summarize?the logs");
    expect(completed).toMatch(/completed +work +fake\?-agent +/);
    expect(completed).toContain("Summarize?the logs · Logs?enod? ??");
    expect(cellsBefore(completed, "Summarize?the logs")).toBe(column);
    // An emoji sequence is drawn whole, in the agent column and in the goal, and the columns after it stay put.
    const running = lineWith(lines, "Write the parser");
    expect(running).toContain(`bot${FAMILY} `);
    expect(running).toContain(`Write the parser ${FAMILY}`);
    expect(cellsBefore(running, "Write the parser")).toBe(column);
    for (const goal of [SEED_TITLES.pending, SEED_TITLES.unrelated]) {
      expect(cellsBefore(lineWith(lines, goal), goal)).toBe(column);
    }
    expect(lines.join("\n")).not.toMatch(HIDDEN);
    await expectNothingHiddenSent(mounted);
    await quit(mounted);
  });

  it("Tasks, its detail, Projects and the top bar show a project, a model and a result the same way", async () => {
    seedStore(dataDir);
    const mounted = mount(WIDE);
    mounted.app.start();
    mounted.terminal.send("2");
    const tasks = mounted.app.frameText();
    const column = cellsBefore(lineWith(tasks, "DEPS"), "GOAL");
    const row = lineWith(tasks, "Summarize?the logs");
    expect(row).toMatch(/de\?mo +completed +fake\?-agent +m\?\?\? +- +Summarize\?the logs/);
    expect(cellsBefore(row, "Summarize?the logs")).toBe(column);
    expect(cellsBefore(lineWith(tasks, "Write the parser"), "Write the parser")).toBe(column);
    for (const goal of [SEED_TITLES.pending, SEED_TITLES.unrelated]) {
      expect(cellsBefore(lineWith(tasks, goal), goal)).toBe(column);
    }
    // The detail of the completed task: the cursor goes to its row, Enter opens it.
    for (let step = 0; step < 4; step++) {
      const selected = mounted.app.frameText().find((line) => line.startsWith("> "));
      if (selected?.includes("Summarize?the logs") === true) break;
      mounted.terminal.send(DOWN);
    }
    mounted.terminal.send(ENTER);
    const detail = mounted.app.frameText();
    expect(lineWith(detail, "task ")).toMatch(/^task [0-9a-f-]+: Summarize\?the logs/);
    expect(detail.join("\n")).toContain("state completed, agent fake?-agent, model m???");
    expect(detail.join("\n")).toContain("result: Logs?enod? ??");
    mounted.terminal.send(ESC);
    // Projects names the project; choosing it puts its slug in the top bar.
    mounted.terminal.send("1");
    expect(lineWith(mounted.app.frameText(), "/work/demo")).toContain(
      "de?mo  Demo?tcejorp?  /work/demo",
    );
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    expect(mounted.app.frameText()[0]).toMatch(/^◆ HARIL ◇ de\?mo ◇ qwen-test /);
    await expectNothingHiddenSent(mounted);
    await quit(mounted);
  });

  it("frames with such text are exactly the rows, none wider than the columns, none with a hidden character", async () => {
    const seeded = seedStore(dataDir);
    proposeHostilePlan(seeded.demoId);
    for (const size of [WIDE, { columns: 80, rows: 24 }, { columns: 40, rows: 10 }]) {
      const mounted = mount(size);
      mounted.app.start();
      const frames = [mounted.app.frameText()];
      for (const key of ["l", ENTER, ESC, "1", "2", ENTER, ESC, "p", ENTER, ESC, "?", ESC]) {
        mounted.terminal.send(key);
        frames.push(mounted.app.frameText());
      }
      for (const lines of frames) {
        expect(lines).toHaveLength(size.rows);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns);
          expect(line).not.toMatch(HIDDEN);
        }
      }
      // pi-tui rendered every frame: a line wider than the terminal throws there.
      await expectNothingHiddenSent(mounted);
      await quit(mounted);
    }
  });
});
