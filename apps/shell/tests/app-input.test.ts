import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarilActions, type ShellActions } from "../src/actions.js";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData, type ShellSnapshot } from "../src/data.js";
import { HELP_LINES } from "../src/help.js";
import { resolveTheme } from "../src/theme.js";
import {
  createTask,
  openSeedStore,
  proposeExamplePlan,
  type SeedResult,
  seedStore,
} from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The always-visible input box, the two keyboard modes and the / commands (LD-T6b-2). The shell opens in input mode:
// printable keys are typed, Enter sends a goal or runs a command. Esc switches to navigation mode, where every single
// key acts as before. A fixture haril records its argv where the test proves the real argv; elsewhere a recording fake
// of the actions port answers when the test says so. Neither writes the store.

const THEME = resolveTheme({ name: "haril-crimson", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ESC = "\x1b";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const TAB = "\t";
const SHIFT_TAB = `${ESC}[Z`;
const ENTER = "\r";
const CTRL_C = "\x03";
const PLACEHOLDER = "type your goal, or / for commands";
const LIVE_HEADER = "Newest tasks, oldest first";
const WIDE = { columns: 120, rows: 40 } as const;
const NARROW = { columns: 80, rows: 24 } as const;
const SMALL = { columns: 40, rows: 10 } as const;

let root: string;
let dataDir: string;
let runtimeRoot: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-input-"));
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

// The fixture haril: records argv in argv.json beside itself, prints one line and exits 0.
function fakeHaril(line: string): string {
  const dir = join(root, `fake-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "haril.mjs");
  writeFileSync(
    entry,
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./argv.json", import.meta.url), JSON.stringify(process.argv.slice(2)));',
      `process.stdout.write(${JSON.stringify(`${line}\n`)});`,
    ].join("\n"),
    "utf8",
  );
  return entry;
}

function argvOf(entry: string): string[] {
  return JSON.parse(readFileSync(join(entry, "..", "argv.json"), "utf8")) as string[];
}

type Outcome = Awaited<ReturnType<ShellActions["run"]>>;

// The actions port as a recording fake: no process and no clock. Each call keeps its argv and waits until the test
// answers it, so "nothing ran" is a check of `calls`, not a wait.
interface RecordingActions extends ShellActions {
  readonly calls: string[][];
  // Answers every waiting call with `outcome`, then lets the app take the answers.
  answer(outcome?: Outcome): Promise<void>;
}

function recordingActions(): RecordingActions {
  const calls: string[][] = [];
  const waiting: ((outcome: Outcome) => void)[] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      return new Promise((resolve) => waiting.push(resolve));
    },
    answer: async (outcome = { ok: true, message: "command c-1: queued" }) => {
      for (const resolve of waiting.splice(0)) resolve(outcome);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
  readonly entry: string;
}

function mount(
  options: {
    defaultModel?: string;
    size?: { readonly columns: number; readonly rows: number };
    line?: string;
    // Replaces the fixture haril.
    actions?: ShellActions;
    // Changes what the store returns, for rows the store itself would not hold.
    alter?: (snapshot: ShellSnapshot) => ShellSnapshot;
  } = {},
): Mounted {
  const shellData = openShellData({
    paths: { dataDir, runtimeRoot, configPath: join(runtimeRoot, "config", "haril.json") },
    env: {},
  });
  opened.push(shellData);
  const alter = options.alter;
  const data: ShellData =
    alter === undefined
      ? shellData
      : {
          load: (scope) => alter(shellData.load(scope)),
          taskDetail: (taskId) => shellData.taskDetail(taskId),
          close: () => shellData.close(),
        };
  const entry = fakeHaril(options.line ?? "command c-1: queued (applied by `haril start`)");
  const terminal = new VirtualTerminal([], options.size ?? NARROW);
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
    actions: options.actions ?? createHarilActions({ harilEntry: entry }),
    defaultModel: options.defaultModel,
  });
  return { terminal, app, entry };
}

async function started(mounted: Mounted): Promise<string[]> {
  mounted.app.start();
  await sleep(5);
  return mounted.app.frameText();
}

function frame(mounted: Mounted): string {
  return mounted.app.frameText().join("\n");
}

// The line inside the input box: the second-to-last of the main area, right above its bottom border.
function inputLine(mounted: Mounted): string {
  const lines = mounted.app.frameText();
  let bottom = lines.length - 1;
  while (bottom > 0 && !(lines[bottom] ?? "").startsWith("└")) bottom--;
  return lines[bottom - 1] ?? "";
}

function statusLine(mounted: Mounted): string {
  return mounted.app.frameText().at(-1) ?? "";
}

function typeText(mounted: Mounted, text: string): void {
  for (const key of text) mounted.terminal.send(key);
}

async function waitForFrame(mounted: Mounted, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (frame(mounted).replace(/\s+/g, " ").includes(text)) return;
    await sleep(25);
  }
  throw new Error(`the frame never showed "${text}":\n${frame(mounted)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quit(mounted: Mounted): Promise<void> {
  mounted.terminal.send(CTRL_C);
  await mounted.app.done;
}

function expectShape(lines: readonly string[], size: { columns: number; rows: number }): void {
  expect(lines).toHaveLength(size.rows);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns);
}

// One project, no task and no runtime lease.
function soloStore(): void {
  const store = openSeedStore(dataDir);
  try {
    store.projects.register({ slug: "solo", name: "Solo", rootPath: "/work/solo" });
  } finally {
    store.close();
  }
}

describe("the input box (LD-T6b-2)", () => {
  beforeEach(() => {
    soloStore();
  });

  it("opens in input mode: the box shows the mode, the placeholder and the input hints", async () => {
    const mounted = mount();
    const lines = await started(mounted);
    expectShape(lines, NARROW);
    expect(lines[20]).toMatch(/^┌─ Input ─+┐$/);
    expect(lines[21]).toMatch(/^│ > type your goal, or \/ for commands +│$/);
    expect(lines[22]).toMatch(/^└─ Esc keys · \/ commands · Ctrl\+C quit ─+┘$/);
    expect(lines[23]).toMatch(/ input · Ctrl\+C quit$/);
    await quit(mounted);
  });

  for (const defaultModel of ["qwen-test", undefined]) {
    it(`Enter sends the goal as a plan task exactly as g does (default model ${defaultModel ?? "none"})`, async () => {
      const viaForm = mount({ defaultModel });
      await started(viaForm);
      viaForm.terminal.send(ESC);
      viaForm.terminal.send("g");
      typeText(viaForm, "Document the CLI");
      viaForm.terminal.send(ENTER);
      await waitForFrame(viaForm, "c-1: queued");
      await quit(viaForm);

      const viaInput = mount({ defaultModel });
      await started(viaInput);
      typeText(viaInput, "Document the CLI");
      expect(inputLine(viaInput)).toContain("> Document the CLI");
      viaInput.terminal.send(ENTER);
      await waitForFrame(viaInput, "c-1: queued");
      expect(argvOf(viaInput.entry)).toEqual(argvOf(viaForm.entry));
      expect(argvOf(viaInput.entry)).toEqual([
        "task",
        "add",
        "Document the CLI",
        "--project",
        "solo",
        "--kind",
        "plan",
        ...(defaultModel === undefined
          ? ["--agent", "fake:plan"]
          : ["--agent", "planner", "--model", defaultModel]),
        "--data-dir",
        dataDir,
      ]);
      // The input is empty again, the shell is on Live and still in input mode.
      expect(inputLine(viaInput)).toContain(PLACEHOLDER);
      expect(frame(viaInput)).toContain(LIVE_HEADER);
      expect(statusLine(viaInput)).toMatch(/input · Ctrl\+C quit$/);
      await quit(viaInput);
    });
  }
});

describe("the input box with a recording fake of the CLI (LD-T6b-2)", () => {
  beforeEach(() => {
    soloStore();
  });

  it("a Kitty key release is no key: a press types once, and a released q does not quit", async () => {
    const mounted = mount({ actions: recordingActions() });
    await started(mounted);
    mounted.terminal.send(`${ESC}[97u`);
    mounted.terminal.send(`${ESC}[97;1:3u`);
    expect(inputLine(mounted)).toMatch(/> a +│$/);
    mounted.terminal.send(ESC);
    mounted.terminal.send(`${ESC}[113;1:3u`);
    expect(mounted.terminal.stopped).toBe(false);
    mounted.terminal.send("q");
    expect(mounted.terminal.stopped).toBe(true);
    await mounted.app.done;
  });

  it("Ctrl+C quits with the goal form open and with the command list open, and runs nothing", async () => {
    for (const [keys, shown] of [
      [[ESC, "g"], "Plan a goal for project solo"],
      [["/"], "Commands (15)"],
    ] as const) {
      const actions = recordingActions();
      const mounted = mount({ actions });
      await started(mounted);
      for (const key of keys) mounted.terminal.send(key);
      expect(frame(mounted)).toContain(shown);
      mounted.terminal.send(CTRL_C);
      expect(mounted.terminal.stopped).toBe(true);
      await mounted.app.done;
      expect(actions.calls).toEqual([]);
    }
  });

  it("a second Enter while the goal is on its way makes no second call", async () => {
    const actions = recordingActions();
    const mounted = mount({ actions });
    await started(mounted);
    typeText(mounted, "Plan it");
    mounted.terminal.send(ENTER);
    mounted.terminal.send(ENTER);
    expect(actions.calls).toHaveLength(1);
    expect(frame(mounted)).toContain("asking for a plan...");
    await actions.answer();
    const argv = ["task", "add", "Plan it", "--project", "solo", "--kind", "plan"];
    expect(actions.calls).toEqual([[...argv, "--agent", "fake:plan", "--data-dir", dataDir]]);
    expect(inputLine(mounted)).toContain(PLACEHOLDER);
    expect(frame(mounted)).toContain(LIVE_HEADER);
    await quit(mounted);
  });

  it("a goal the CLI refuses keeps the line and shows the CLI's message", async () => {
    const actions = recordingActions();
    const mounted = mount({ actions, defaultModel: "qwen-test" });
    await started(mounted);
    typeText(mounted, "Plan it");
    mounted.terminal.send(ENTER);
    expect(actions.calls).toHaveLength(1);
    await actions.answer({ ok: false, message: "haril: the gateway refused the model" });
    expect(frame(mounted)).toContain("haril: the gateway refused the model");
    expect(inputLine(mounted)).toContain("> Plan it");
    expect(frame(mounted)).not.toContain(LIVE_HEADER);
    await quit(mounted);
  });

  it("both ways to send a goal send what the screen showed: format characters become ?", async () => {
    // A zero-width space, a right-to-left override and a tag character, pasted.
    const hidden = `${ESC}[200~do\u{200B}it\u{202E}\u{E0041}${ESC}[201~`;
    const viaInput = recordingActions();
    const input = mount({ actions: viaInput });
    await started(input);
    input.terminal.send(hidden);
    expect(inputLine(input)).toContain("> do?it??");
    input.terminal.send(ENTER);
    expect(viaInput.calls[0]?.[2]).toBe("do?it??");
    await quit(input);

    const viaForm = recordingActions();
    const form = mount({ actions: viaForm });
    await started(form);
    form.terminal.send(ESC);
    form.terminal.send("g");
    form.terminal.send(hidden);
    expect(frame(form)).toContain("goal    do?it??_");
    form.terminal.send(ENTER);
    expect(viaForm.calls[0]?.[2]).toBe("do?it??");
    await quit(form);
  });
});

describe("the input box with several projects (LD-T6b-2)", () => {
  it("Enter without a filter keeps the goal, says how to choose a project and runs nothing", async () => {
    seedStore(dataDir);
    const actions = recordingActions();
    const mounted = mount({ actions });
    await started(mounted);
    typeText(mounted, "Plan it");
    mounted.terminal.send(ENTER);
    expect(frame(mounted).replace(/\s+/g, " ")).toContain(
      "several projects: pick one on Projects first",
    );
    expect(inputLine(mounted)).toContain("> Plan it");
    expect(actions.calls).toEqual([]);
    await quit(mounted);
  });
});

describe("keyboard modes (LD-T6b-2)", () => {
  beforeEach(() => {
    seedStore(dataDir);
  });

  it("in input mode q, digits and ? are typed into the box, not acted on", async () => {
    const mounted = mount();
    await started(mounted);
    typeText(mounted, "q2?y");
    expect(inputLine(mounted)).toContain("> q2?y");
    // Still on Live, no help, and the shell did not quit.
    expect(frame(mounted)).toContain(LIVE_HEADER);
    expect(frame(mounted)).not.toContain(HELP_LINES[0]);
    // quit() stops the terminal at once (see the Ctrl+C tests), so a terminal still running proves no quit.
    expect(mounted.terminal.stopped).toBe(false);
    await quit(mounted);
  });

  it("while typing, the arrows move the panel's selection and Tab and Shift+Tab cycle the panels", async () => {
    const mounted = mount();
    await started(mounted);
    typeText(mounted, "draft");
    // Live is the last panel: Tab wraps to Projects.
    mounted.terminal.send(TAB);
    expect(frame(mounted)).toContain("> all projects");
    mounted.terminal.send(DOWN);
    expect(frame(mounted)).toContain("> demo");
    mounted.terminal.send(UP);
    expect(frame(mounted)).toContain("> all projects");
    mounted.terminal.send(SHIFT_TAB);
    expect(frame(mounted)).toContain(LIVE_HEADER);
    expect(inputLine(mounted)).toContain("> draft");
    await quit(mounted);
  });

  it("Esc switches to navigation mode keeping the text; the keys act; i and Esc return to input", async () => {
    const mounted = mount();
    await started(mounted);
    typeText(mounted, "draft");
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toMatch(/┌─ Keys ─/);
    expect(statusLine(mounted)).toMatch(/keys · \? help · q quit$/);
    expect(frame(mounted)).toMatch(/└─ i type · .*─┘/);
    expect(inputLine(mounted)).toContain("> draft");
    mounted.terminal.send("2");
    expect(frame(mounted)).toContain("STATE");
    mounted.terminal.send("?");
    expect(frame(mounted)).toContain(HELP_LINES[0]);
    mounted.terminal.send(ESC);
    mounted.terminal.send("i");
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    typeText(mounted, "s");
    expect(inputLine(mounted)).toContain("> drafts");
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toMatch(/┌─ Keys ─/);
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    expect(inputLine(mounted)).toContain("> drafts");
    await quit(mounted);
  });

  it("Esc closes the help or a task detail first, in both modes, before changing the mode", async () => {
    const mounted = mount();
    await started(mounted);
    // Input mode: an empty Enter on Live opens the selected task; Esc closes it and stays in input mode.
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toMatch(/task [0-9a-f-]{36}: /);
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toContain(LIVE_HEADER);
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    typeText(mounted, "/help");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain(HELP_LINES[0]);
    mounted.terminal.send(ESC);
    expect(frame(mounted)).not.toContain(HELP_LINES[0]);
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    // Navigation mode: the help and the detail close first, then Esc returns to input mode.
    mounted.terminal.send(ESC);
    mounted.terminal.send("?");
    mounted.terminal.send(ESC);
    expect(frame(mounted)).not.toContain(HELP_LINES[0]);
    expect(frame(mounted)).toMatch(/┌─ Keys ─/);
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toMatch(/task [0-9a-f-]{36}: /);
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toContain(LIVE_HEADER);
    expect(frame(mounted)).toMatch(/┌─ Keys ─/);
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    await quit(mounted);
  });

  it("Ctrl+C quits in input mode and in navigation mode", async () => {
    for (const keys of [[CTRL_C], [ESC, CTRL_C]]) {
      const mounted = mount();
      await started(mounted);
      typeText(mounted, "half");
      for (const key of keys) mounted.terminal.send(key);
      expect(mounted.terminal.stopped).toBe(true);
      await mounted.app.done;
    }
  });

  it("an empty Enter keeps the active panel's Enter action: on Projects it sets the filter", async () => {
    const actions = recordingActions();
    const mounted = mount({ actions });
    await started(mounted);
    mounted.terminal.send(TAB);
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    expect(mounted.app.frameText()[0]).toMatch(/^◆ HARIL ◇ demo/);
    // Spaces alone are an empty line too.
    typeText(mounted, "  ");
    mounted.terminal.send(UP);
    mounted.terminal.send(ENTER);
    expect(mounted.app.frameText()[0]).toMatch(/^◆ HARIL ◇ all/);
    expect(actions.calls).toEqual([]);
    await quit(mounted);
  });
});

describe("/ commands (LD-T6b-2)", () => {
  let seeded: SeedResult;

  beforeEach(() => {
    seeded = seedStore(dataDir);
  });

  it("/ lists the commands; typing filters them, the arrows choose, Tab completes and Esc closes the list", async () => {
    const mounted = mount({ size: WIDE });
    await started(mounted);
    typeText(mounted, "/");
    let screen = frame(mounted);
    expect(screen).toMatch(/┌─ Commands \(15\) ─+┐/);
    for (const name of ["/projects", "/tasks", "/themes", "/plans"]) expect(screen).toContain(name);
    expect(screen).not.toContain("/quit");
    expect(screen).toMatch(/│ > \/projects +open Projects/);
    expect(screen).toMatch(/└─ ↑↓ choose · Tab complete · Enter run · Esc close ─+┘/);
    // The list scrolls to the selected command: the last one is fourteen rows down.
    for (let step = 0; step < 20; step++) mounted.terminal.send(DOWN);
    screen = frame(mounted);
    expect(screen).toMatch(/│ > \/quit +quit the shell/);
    expect(screen).toContain("/approve [id]");
    expect(screen).not.toContain("/projects");
    typeText(mounted, "t");
    screen = frame(mounted);
    expect(screen).toMatch(/> \/tasks +/);
    expect(screen).toMatch(/ {2}\/tokens +/);
    expect(screen).toMatch(/ {2}\/themes +/);
    expect(screen).not.toContain("/plans");
    mounted.terminal.send(DOWN);
    expect(frame(mounted)).toMatch(/> \/tokens +/);
    mounted.terminal.send(DOWN);
    mounted.terminal.send(UP);
    mounted.terminal.send(TAB);
    expect(inputLine(mounted)).toContain("> /tokens");
    // Esc closes the list and keeps the mode and the text.
    mounted.terminal.send(ESC);
    expect(frame(mounted)).not.toMatch(/\/tokens +open Tokens/);
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    expect(inputLine(mounted)).toContain("> /tokens");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("Settled token ledger");
    expect(inputLine(mounted)).toContain(PLACEHOLDER);
    await quit(mounted);
  });

  it("Enter with the list open runs the selected command", async () => {
    const mounted = mount();
    await started(mounted);
    typeText(mounted, "/ev");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toMatch(/newest \d+ events, oldest first/);
    await quit(mounted);
  });

  it("each panel command opens its panel and clears the input", async () => {
    const mounted = mount();
    await started(mounted);
    const panels: readonly (readonly [string, string | RegExp])[] = [
      ["projects", "> all projects"],
      ["tasks", "STATE"],
      ["agents", "runtime active"],
      ["tokens", "Settled token ledger"],
      ["events", /newest \d+ events, oldest first/],
      ["models", "providers from"],
      ["themes", "theme in use"],
      ["plans", "No plans waiting for approval."],
      ["live", LIVE_HEADER],
    ];
    for (const [name, shown] of panels) {
      typeText(mounted, `/${name}`);
      mounted.terminal.send(ESC);
      mounted.terminal.send(ENTER);
      if (typeof shown === "string") expect(frame(mounted)).toContain(shown);
      else expect(frame(mounted)).toMatch(shown);
      expect(inputLine(mounted)).toContain(PLACEHOLDER);
    }
    await quit(mounted);
  });

  it("/help opens the help, /reload reads the store again and /quit quits", async () => {
    const mounted = mount();
    await started(mounted);
    typeText(mounted, "/help");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain(HELP_LINES[0]);
    mounted.terminal.send(ESC);
    const writer = openSeedStore(dataDir);
    try {
      createTask(writer, seeded.demoId, seeded.epoch, "Arrives later");
    } finally {
      writer.close();
    }
    expect(frame(mounted)).not.toContain("Arrives later");
    typeText(mounted, "/reload");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("Arrives later");
    typeText(mounted, "/quit");
    mounted.terminal.send(ENTER);
    await mounted.app.done;
    expect(mounted.terminal.stopped).toBe(true);
  });

  it("an unknown command says so and keeps the text to fix it", async () => {
    const actions = recordingActions();
    const mounted = mount({ actions });
    await started(mounted);
    typeText(mounted, "/xyz");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("unknown command /xyz · /help lists them");
    expect(inputLine(mounted)).toContain("> /xyz");
    expect(actions.calls).toEqual([]);
    await quit(mounted);
  });

  it("/approve <id> approves that plan through the same CLI call as y, and switches to Live", async () => {
    const approvalId = proposeExamplePlan(dataDir, seeded.demoId);
    const mounted = mount({ line: "approval a-1 granted by tester" });
    await started(mounted);
    typeText(mounted, `/approve ${approvalId.slice(0, 8)}`);
    mounted.terminal.send(ENTER);
    await waitForFrame(mounted, "granted by tester");
    expect(argvOf(mounted.entry)).toEqual(["approve", approvalId, "--data-dir", dataDir]);
    expect(frame(mounted)).toContain(LIVE_HEADER);
    expect(inputLine(mounted)).toContain(PLACEHOLDER);
    await quit(mounted);
  });

  it("/deny without an id denies the only pending plan", async () => {
    const approvalId = proposeExamplePlan(dataDir, seeded.demoId);
    const mounted = mount({ line: "approval a-1 denied by tester" });
    await started(mounted);
    typeText(mounted, "/deny");
    mounted.terminal.send(ESC);
    mounted.terminal.send(ENTER);
    await waitForFrame(mounted, "denied by tester");
    expect(argvOf(mounted.entry)).toEqual(["deny", approvalId, "--data-dir", dataDir]);
    await quit(mounted);
  });

  it("/approve without an id acts on the plan selected on Plans", async () => {
    const first = proposeExamplePlan(dataDir, seeded.demoId);
    const second = proposeExamplePlan(dataDir, seeded.otherId);
    const mounted = mount({ line: "approval granted by tester" });
    await started(mounted);
    typeText(mounted, "/plans");
    mounted.terminal.send(ENTER);
    mounted.terminal.send(DOWN);
    const selected = mounted.app.frameText().find((line) => line.startsWith("> ")) ?? "";
    const chosen = [first, second].find((id) => selected.startsWith(`> ${id.slice(0, 8)}`));
    expect(chosen).toBeDefined();
    typeText(mounted, "/approve");
    mounted.terminal.send(ENTER);
    await waitForFrame(mounted, "granted by tester");
    expect(argvOf(mounted.entry)).toEqual(["approve", chosen, "--data-dir", dataDir]);
    await quit(mounted);
  });

  it("/approve without an id and several pending plans off Plans asks for an id and runs nothing", async () => {
    proposeExamplePlan(dataDir, seeded.demoId);
    proposeExamplePlan(dataDir, seeded.otherId);
    const actions = recordingActions();
    const mounted = mount({ actions });
    await started(mounted);
    typeText(mounted, "/approve");
    mounted.terminal.send(ENTER);
    expect(frame(mounted).replace(/\s+/g, " ")).toContain(
      "2 plans wait for approval: /approve <id>, or select one on Plans",
    );
    expect(inputLine(mounted)).toContain("> /approve");
    expect(actions.calls).toEqual([]);
    await quit(mounted);
  });

  it("/deny with an id that matches no pending plan says so and runs nothing", async () => {
    proposeExamplePlan(dataDir, seeded.demoId);
    const actions = recordingActions();
    const mounted = mount({ actions });
    await started(mounted);
    typeText(mounted, "/deny zz99");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("no pending plan matches zz99");
    expect(actions.calls).toEqual([]);
    await quit(mounted);
  });

  it("/approve takes an id prefix in any case; an ambiguous prefix asks for more of it", async () => {
    const plans = ["abc12345-0000-4000-8000-000000000001", "abc12399-0000-4000-8000-000000000002"];
    const actions = recordingActions();
    const mounted = mount({
      actions,
      alter: (snapshot) => ({
        ...snapshot,
        pendingApprovals: plans.length,
        approvals: plans.map((approvalId) => ({
          approvalId,
          projectId: seeded.demoId,
          requestedAt: snapshot.loadedAt,
          requestedBy: "cli",
          model: null,
          tasks: [],
          error: undefined,
        })),
      }),
    });
    await started(mounted);
    typeText(mounted, "/approve abc123");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain(
      "several pending plans start with abc123: type more of the id",
    );
    expect(inputLine(mounted)).toContain("> /approve abc123");
    expect(actions.calls).toEqual([]);
    // Ctrl+U clears the line.
    mounted.terminal.send("\x15");
    typeText(mounted, "/approve ABC1234");
    mounted.terminal.send(ENTER);
    expect(actions.calls).toEqual([["approve", plans[0], "--data-dir", dataDir]]);
    await actions.answer({ ok: true, message: "approval granted by tester" });
    expect(frame(mounted)).toContain("approval granted by tester");
    await quit(mounted);
  });

  it("/add opens the add-task form for the filtered project", async () => {
    const mounted = mount();
    await started(mounted);
    typeText(mounted, "/projects");
    mounted.terminal.send(ENTER);
    mounted.terminal.send(DOWN);
    mounted.terminal.send(ENTER);
    typeText(mounted, "/add");
    mounted.terminal.send(ENTER);
    expect(frame(mounted)).toContain("Add task to project demo");
    // The form takes every key; Esc cancels it and leaves input mode as it was.
    mounted.terminal.send(ESC);
    expect(frame(mounted)).toContain("add task cancelled");
    expect(frame(mounted)).toMatch(/┌─ Input ─/);
    await quit(mounted);
  });
});

describe("the frame with the input box (LD-T6b-2)", () => {
  beforeEach(() => {
    seedStore(dataDir);
  });

  it("pasted escape sequences and wide characters never break the frame or reach the terminal", async () => {
    const hostile = `evil\x1b]0;title\x07 \x1b[2J日本語のとても長い入力テキスト ${"wide 幅 ".repeat(20)}`;
    for (const size of [WIDE, NARROW, SMALL]) {
      const mounted = mount({ size });
      await started(mounted);
      mounted.terminal.send(`${ESC}[200~${hostile}${ESC}[201~`);
      expectShape(mounted.app.frameText(), size);
      for (const key of ["\x1b[D", "\x1b[D", "\x1b[H", "日", "\x1b[F", "本"]) {
        mounted.terminal.send(key);
        expectShape(mounted.app.frameText(), size);
      }
      expect(frame(mounted)).not.toContain(ESC);
      // pi-tui rendered every frame: a line wider than the terminal throws there.
      await sleep(5);
      const output = mounted.terminal.output.join("");
      expect(output).not.toContain("\x1b]0;title");
      expect(output).not.toContain("\x1b[2J日");
      await quit(mounted);
    }
    const mounted = mount({ size: WIDE });
    await started(mounted);
    mounted.terminal.send(`${ESC}[200~${hostile}${ESC}[201~`);
    mounted.terminal.send("\x1b[H");
    expect(inputLine(mounted)).toContain("> evil?]0;title? ?[2J日本語");
    await quit(mounted);
  });

  it("with the command list open the frame is exactly the rows, none wider than the columns", async () => {
    for (const size of [
      WIDE,
      NARROW,
      SMALL,
      { columns: 100, rows: 12 },
      { columns: 20, rows: 6 },
    ]) {
      const mounted = mount({ size });
      await started(mounted);
      for (const key of ["/", DOWN, DOWN, "a", UP, TAB]) {
        mounted.terminal.send(key);
        expectShape(mounted.app.frameText(), size);
      }
      await sleep(5);
      await quit(mounted);
    }
  });
});
