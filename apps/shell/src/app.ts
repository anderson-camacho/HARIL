import {
  type Component,
  isKeyRelease,
  matchesKey,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { visibleText } from "@haril/core";
import type { GitStatus } from "@haril/git";
import shellPackage from "../package.json" with { type: "json" };
import { createHarilActions, type ShellActions } from "./actions.js";
import { AddTaskForm, addTaskArgs } from "./add-task.js";
import {
  commandListLines,
  commandMatches,
  parseCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "./commands.js";
import { saveThemeChoice } from "./config-file.js";
import type { PendingApproval, ShellData, ShellSnapshot, TaskDetailView } from "./data.js";
import { fit, wrap } from "./format.js";
import { box, fitLine, joinColumns, type Line, type Segment, segment } from "./frame-layout.js";
import {
  type FrameFacts,
  homeLines,
  RIGHT_COLUMN_FROM,
  RIGHT_COLUMN_WIDTH,
  type RuntimeState,
  rightColumn,
  type ShellMode,
  statusLine,
  topBar,
} from "./frame-view.js";
import { GoalForm, goalArgs, goalDefaults } from "./goal.js";
import { HELP_LINES } from "./help.js";
import { clampOffset, followCursor, packTabs } from "./layout.js";
import { LineEditor } from "./line-editor.js";
import { type ConnectControl, createLiveFeed } from "./live.js";
import {
  buildPanelView,
  buildPlanDetailView,
  buildTaskDetailView,
  PANELS,
  type PanelContext,
  type PanelView,
  type ShellSettings,
} from "./panels/index.js";
import type { RuntimeStarter, SpawnedRuntime } from "./runtime-start.js";
import { readOptionalFile, resolveTheme, type Theme } from "./theme.js";

// The shell app (TUI-T3). The frame (LD-T6b-1): a top bar; the main area with the tab strip, the active panel's body
// (the HARIL banner while nothing runs) and the input box; a right column of status boxes from 100 columns on; a
// status line. The input box (LD-T6b-2) is always there: in input mode, the default, keys are typed into it, Enter
// sends a goal or runs a / command and typing / lists the commands above it; Esc switches to navigation mode, where
// the single keys act. The app only reads through ShellData; its state is the keyboard mode, the typed line, the
// selected panel, one cursor and scroll offset per panel, the project filter, an open task or plan detail, an open
// form, the help overlay and the home view. Each key changes that state and the next frame shows it. Every write is a
// haril child process (TUI-D13), and so is the runtime it may start (LD-T6).

interface ShellBanner {
  readonly isolation: string;
}

export interface ShellAppOptions {
  readonly terminal: Terminal;
  readonly theme: Theme;
  readonly banner: ShellBanner;
  // A notice shown under the banner, such as a theme that could not be loaded.
  readonly warning?: string;
  readonly data: ShellData;
  readonly settings: ShellSettings;
  // Runs the CLI for the actions (TUI-D13). Without it, an action reports that it is not available.
  readonly actions?: ShellActions;
  // HARIL_DEFAULT_MODEL as the shell received it: prefills the model of the add-task and goal forms.
  readonly defaultModel?: string;
  // Opens the control channel for the live feed (LD-T2). Without it the shell never subscribes.
  readonly connectControl?: ConnectControl;
  // Starts a runtime when work waits and none runs (LD-T6, ADR-0022). Without it (haril shell --no-runtime) the shell
  // never starts one and says so after an action.
  readonly runtimeStarter?: RuntimeStarter;
  // Reads the branch and changes of a project root for the Status box (LD-T6b-1): with the store, never on a timer.
  // Without it the box says n/a.
  readonly readGit?: (rootPath: string) => Promise<GitStatus | undefined>;
  // The clock of the git read's rate on wakes (GIT_WAKE_INTERVAL_MS). Defaults to Date.now; tests pass a fake one.
  readonly now?: () => number;
}

export interface ShellApp {
  start(): void;
  // Resolves once the user quits (q or Ctrl+C); the store is closed and the terminal restored by then.
  readonly done: Promise<void>;
  // The frame as plain text at the terminal's size, for tests and diagnostics.
  frameText(): string[];
}

type FrameLine = Line;

// One start of the runtime by this shell (LD-T6): the child, its log relative to the runtime root and when it was
// started; `confirmed` once the handshake reached a runtime, `ended` once a failed start was reported.
interface ShellStart {
  readonly runtime: SpawnedRuntime;
  readonly log: string;
  readonly at: number;
  confirmed: boolean;
  ended: boolean;
}

// A cursor or scroll movement: a step of lines, or a jump to the first or last line.
type Motion =
  | { readonly kind: "step"; readonly delta: number }
  | { readonly kind: "jump"; readonly toEnd: boolean };

function motionOf(input: string, pages: number): Motion | undefined {
  if (matchesKey(input, "up")) return { kind: "step", delta: -1 };
  if (matchesKey(input, "down")) return { kind: "step", delta: 1 };
  if (matchesKey(input, "pageUp")) return { kind: "step", delta: -pages };
  if (matchesKey(input, "pageDown")) return { kind: "step", delta: pages };
  if (matchesKey(input, "home")) return { kind: "jump", toEnd: false };
  if (matchesKey(input, "end")) return { kind: "jump", toEnd: true };
  return undefined;
}

const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
// The input box at the bottom of the main area (LD-T6b-2): the typed line inside a border, the keyboard mode in the
// top border and the keys of what is open in the bottom one.
const INPUT_BOX_ROWS = 3;
const PLACEHOLDER = "type your goal, or / for commands";
const INPUT_FOOTER = "Esc keys · / commands · Ctrl+C quit";
const LIST_FOOTER = "↑↓ choose · Tab complete · Enter run · Esc close";
const INPUT_VIEW_FOOTER = "↑↓ scroll · Esc back · Ctrl+C quit";
const INPUT_PLAN_FOOTER = "↑↓ scroll · /approve · /deny · Esc back";
// The keys that keep acting on the panels in input mode; every other key but Enter and Esc is the editor's.
const PANEL_KEYS = ["up", "down", "pageUp", "pageDown", "tab", "shift+tab"] as const;
// In input mode Enter on a project would send the typed line again: the way to a filter goes through navigation mode.
const PICK_PROJECT = "several projects: pick one on Projects first (Esc, 1, ↓ and Enter, then i)";
const COMMON_KEYS = ["g goal", "a add", "p plans", "l live", "t themes", "r reload", "Tab panels"];
const HOME_KEYS = ["1-9 panels", ...COMMON_KEYS.filter((key) => key !== "Tab panels")];
// Tasks the runtime runs at once (the run loop's concurrency, apps/haril/src/runtime/run-loop.ts): the Taxis box.
const RUNTIME_SLOTS = 1;
// While the runtime works it wakes the shell as often as every 250 ms; a reload from a wake reads git at most this
// often. Opening, r, a filter change and an action always read it.
const GIT_WAKE_INTERVAL_MS = 5_000;
const FORM_FOOTER = "Enter add task · Tab next field · Esc cancel · Ctrl+C quit";
const GOAL_FOOTER = "Enter ask for a plan · Tab next field · Esc cancel · Ctrl+C quit";
const PLAN_FOOTER = "y approve · n deny · ↑↓ scroll · Esc back · r reload · q quit";
const THEMES_PANEL = PANELS.findIndex((entry) => entry.id === "themes");
const PLANS_PANEL = PANELS.findIndex((entry) => entry.id === "plans");
const LIVE_PANEL = PANELS.findIndex((entry) => entry.id === "live");
const NO_PROJECT_MESSAGE =
  "no project yet; create one with: haril project init <path> --name <name>";
// With --no-runtime the shell never starts the runtime: a queued task or a granted plan waits for one (LD-T6).
const NO_RUNTIME_NOTE = "no runtime is running: start it with haril start";
// The handshake after a start (LD-T6): one subscribe attempt at once and one after each wait, about 3 s in all. The
// runtime opens its channel once it holds the lease; past the last wait the shell stops trying and says so.
const HANDSHAKE_DELAYS_MS = [250, 500, 1000, 1250] as const;
const HANDSHAKE_GAVE_UP = "runtime starting… press r";
const NO_ACTIONS: ShellActions = createHarilActions({ harilEntry: undefined });
// Keys that open a panel from anywhere: t Themes (TUI-D14), p Plans and l Live (LD-T5).
const DIRECT_PANELS = [
  { key: "t", panel: THEMES_PANEL },
  { key: "p", panel: PLANS_PANEL },
  { key: "l", panel: LIVE_PANEL },
] as const;

type Project = ShellSnapshot["projects"][number];

export function createShellApp(options: ShellAppOptions): ShellApp {
  const { terminal, banner, data, warning } = options;
  const actions = options.actions ?? NO_ACTIONS;
  const tui = new TuiMainScreen(terminal);
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // The theme and the settings change when the user applies a theme (TUI-D14), so they are state of the app.
  let theme: Theme = options.theme;
  let settings: ShellSettings = options.settings;
  let snapshot: ShellSnapshot = data.load(undefined);
  let panel = 0;
  let scope: string | undefined;
  const cursors: number[] = PANELS.map(() => 0);
  const offsets: number[] = PANELS.map(() => 0);
  let detail: TaskDetailView | undefined;
  // The approval id of the plan whose tasks are open (LD-T5).
  let plan: string | undefined;
  let textOffset = 0;
  let helpOpen = false;
  // The home view (LD-T6b-1): the HARIL banner shows in place of the panel until a panel is chosen, while nothing
  // runs or waits for approval and the terminal is tall and wide enough. With work, the shell lands on Live instead.
  let home = true;
  // The last git read and the root it was for (LD-T6b-1); one read at a time, and one more if asked meanwhile. The
  // time the last read started, by the injected clock, spaces the reads that wakes ask for.
  let gitSeen: { readonly root: string; readonly status: GitStatus | undefined } | undefined;
  let gitReading = false;
  let gitAgain = false;
  let gitStartedAt = Number.NEGATIVE_INFINITY;
  const now = options.now ?? (() => Date.now());
  let quitting = false;
  // The keyboard mode and the input box (LD-T6b-2): the typed line, whether Esc closed the command list for it and the
  // command selected in the list.
  let mode: ShellMode = "input";
  const editor = new LineEditor();
  let listClosed = false;
  let suggestion = 0;
  // The add-task or goal form while it is open, and one line of outcome under the tabs (TUI-D13).
  let form: AddTaskForm | GoalForm | undefined;
  let pending = false;
  let status: string | undefined;
  // The live feed (LD-T2): a wake of the runtime reloads the store. Absent without a data dir or a connector.
  const feed =
    options.connectControl === undefined || settings.dataDir === undefined
      ? undefined
      : createLiveFeed({
          dataDir: settings.dataDir,
          connect: options.connectControl,
          reload: () => {
            reload(true);
            tui.requestRender();
          },
          onChange: () => tui.requestRender(),
        });
  const liveMark = (): string => (feed?.subscribed === true ? " · live" : "");
  // Subscribes only while the runtime is active: on open, after r and after an action, never by polling (LD-T2).
  const subscribeIfRuntimeRunning = (): void => {
    if (feed !== undefined && snapshot.runtimeAlive) void feed.subscribe();
  };
  // The runtime this shell started last (LD-T6), kept after it exits: the banner names it by its pid.
  let started: ShellStart | undefined;
  // Whether the start before the current one ended without a runtime: the next failure says "again".
  let lastStartFailed = false;
  const startingNote = (pid: number): string => `starting the runtime (pid ${pid})…`;
  // Replaces the end of the status line when it still says `from`; a newer line is left as it is.
  const replaceNote = (from: string, to: string): void => {
    if (status?.endsWith(from) === true) status = `${status.slice(0, -from.length)}${to}`;
  };
  // The outcome of a start always reaches the status line: it replaces the note of that start, or the whole line when
  // something newer took its place, so the line never keeps saying the runtime is starting.
  const settleNote = (pid: number, note: string): void => {
    const current = status;
    const suffix = [startingNote(pid), HANDSHAKE_GAVE_UP].find((end) => current?.endsWith(end));
    status =
      current === undefined || suffix === undefined
        ? note
        : `${current.slice(0, -suffix.length)}${note}`;
  };
  // The runtime that answered a start: the shell's own child, or the one that won the lease before it.
  const answeredNote = (pid: number): string => {
    const lease = snapshot.runtime;
    return snapshot.runtimeAlive && lease.status !== "none" && lease.pid !== pid
      ? `runtime running (pid ${lease.pid})`
      : `runtime started (pid ${pid})`;
  };

  const activeId = () => PANELS[panel]?.id ?? "projects";
  const context = (): PanelContext => ({ snapshot, settings, scope });
  const activeView = (): PanelView => buildPanelView(activeId(), context());
  // The project the frame names: the filter's, the only one when there is just one, else "all".
  const projectSlug = (): string =>
    scope === undefined
      ? snapshot.projects.length === 1
        ? (snapshot.projects[0]?.slug ?? "all")
        : "all"
      : (snapshot.projects.find((project) => project.projectId === scope)?.slug ?? "all");
  // The runtime and its pid (LD-T6): running while a live process holds the lease, starting while the one this shell
  // started has not taken it yet, idle otherwise.
  const runtimeState = (): RuntimeState => {
    if (snapshot.runtimeAlive && snapshot.runtime.status !== "none") return "running";
    return started?.runtime.running === true ? "starting" : "idle";
  };
  const runtimePid = (): number | undefined => {
    const lease = snapshot.runtime;
    if (snapshot.runtimeAlive && lease.status !== "none") return lease.pid;
    return started?.runtime.running === true ? started.runtime.pid : undefined;
  };
  // The status line's runtime: "running (started by shell, pid N)", "running (pid N)", "starting (…)" or "idle".
  // "live" shows while the shell holds a subscription to the runtime (LD-T2).
  const runtimeText = (): string => {
    const state = runtimeState();
    const pid = runtimePid();
    if (pid === undefined) return `${state}${liveMark()}`;
    const byShell = started?.runtime.pid === pid ? "started by shell, " : "";
    return `${state} (${byShell}pid ${pid})${liveMark()}`;
  };
  // The tasks of the filter, or of every project.
  const scopedTasks = () =>
    snapshot.tasks.filter((task) => scope === undefined || task.projectId === scope);
  // Work in progress or about to run: the home view gives way to Live.
  const busy = (): boolean =>
    scopedTasks().some((task) => task.state === "running" || task.state === "ready");
  // The root git is read for: the filtered project's, or the only project's.
  const gitRoot = (): string | undefined => {
    const chosen =
      scope === undefined
        ? snapshot.projects.length === 1
          ? snapshot.projects[0]
          : undefined
        : snapshot.projects.find((project) => project.projectId === scope);
    return chosen?.rootPath;
  };
  // What the frame shows besides the panel (LD-T6b-1), read from the snapshot and the shell's own state. Every text is
  // shown here as the screen draws it (visibleText), once, so the bars and boxes lay out and measure the text they will
  // show; fit cuts it later.
  const facts = (): FrameFacts => {
    const tasks = scopedTasks();
    const running = snapshot.live.find((entry) => entry.detail.state === "running");
    const usage = snapshot.metrics
      .filter((entry) => scope === undefined || entry.projectId === scope)
      .reduce(
        (sum, entry) => ({
          input: sum.input + (entry.usage?.inputTokens ?? 0),
          output: sum.output + (entry.usage?.outputTokens ?? 0),
        }),
        { input: 0, output: 0 },
      );
    const root = gitRoot();
    const pid = runtimePid();
    const seen = gitSeen !== undefined && gitSeen.root === root ? gitSeen : undefined;
    return {
      project: visibleText(projectSlug()),
      projectCount: snapshot.projects.length,
      rootPath: root === undefined ? undefined : visibleText(root),
      git:
        seen === undefined
          ? options.readGit === undefined
            ? "unknown"
            : "reading"
          : seen.status === undefined
            ? "unknown"
            : { branch: visibleText(seen.status.branch), changes: seen.status.changes },
      model: options.defaultModel === undefined ? undefined : visibleText(options.defaultModel),
      context:
        running === undefined
          ? undefined
          : {
              used: (running.tokens?.input ?? 0) + (running.tokens?.output ?? 0),
              max: running.detail.maxTokens,
            },
      tokens: usage,
      runtime: {
        state: runtimeState(),
        pid,
        byShell: pid !== undefined && started?.runtime.pid === pid,
        live: feed?.subscribed === true,
      },
      runtimeText: visibleText(runtimeText()),
      isolation: visibleText(banner.isolation),
      approvals: snapshot.pendingApprovals,
      taxis: {
        busy: snapshot.tasks.filter((task) => task.state === "running").length,
        slots: RUNTIME_SLOTS,
      },
      projects: snapshot.projects.map((project) => visibleText(project.slug)),
      tasks: visibleText(taskSummary(tasks)),
      agents: [...new Set(tasks.map((task) => visibleText(task.agentRef)))],
      version: shellPackage.version,
      dataDir: settings.dataDir === undefined ? undefined : visibleText(settings.dataDir),
      theme: visibleText(settings.themeLabel),
    };
  };
  const openApproval = (): PendingApproval | undefined =>
    plan === undefined
      ? undefined
      : snapshot.approvals.find((approval) => approval.approvalId === plan);
  // The plan y and n act on: the open one, or the one under the cursor on Plans.
  const selectedApproval = (): string | undefined =>
    plan ?? (activeId() === "plans" ? activeView().items[cursors[panel] ?? 0]?.value : undefined);
  // The commands the typed line lists (LD-T6b-2): in input mode, with no form open, until Esc closes the list.
  const suggestions = (): SlashCommand[] =>
    mode !== "input" || form !== undefined || listClosed ? [] : commandMatches(editor.value);
  // The text views over the panels: help, a task detail or a plan detail. Undefined shows the active panel.
  const textLines = (): readonly string[] | undefined => {
    if (helpOpen) return HELP_LINES;
    if (detail !== undefined) return buildTaskDetailView(detail);
    const approval = openApproval();
    return approval === undefined ? undefined : buildPlanDetailView(approval, context());
  };
  // The keys of navigation mode: of what is open, else of the home view or the active panel.
  const keysText = (homeShown: boolean): string => {
    if (helpOpen) return "↑↓ scroll · Esc close help · q quit";
    if (detail !== undefined) return "↑↓ scroll · Esc back · r reload · q quit";
    if (openApproval() !== undefined) return PLAN_FOOTER;
    if (homeShown) return HOME_KEYS.join(" · ");
    return [...activeView().keys, ...COMMON_KEYS].join(" · ");
  };
  // The bottom border of the input box: the keys of an open form; in input mode those of the command list or of an
  // open view; in navigation mode i and the keys above. One line; it is cut to the border.
  const footerText = (homeShown: boolean): string => {
    if (form !== undefined) return form instanceof GoalForm ? GOAL_FOOTER : FORM_FOOTER;
    if (mode === "navigation") return `i type · ${keysText(homeShown)}`;
    if (suggestions().length > 0) return LIST_FOOTER;
    if (helpOpen || detail !== undefined) return INPUT_VIEW_FOOTER;
    return openApproval() === undefined ? INPUT_FOOTER : INPUT_PLAN_FOOTER;
  };
  const pageSize = (columns: number, rows: number): number =>
    Math.max(1, panelRows(columns, rows) - 1);

  // The main area's width: all of it, or what the right column leaves from RIGHT_COLUMN_FROM columns on.
  function mainWidth(columns: number): number {
    return columns >= RIGHT_COLUMN_FROM ? columns - RIGHT_COLUMN_WIDTH - 1 : columns;
  }

  // The main area above the body: the tab strip, the warning and the outcome of the last action.
  function headLines(width: number): FrameLine[] {
    const lines: FrameLine[] = packTabs(
      PANELS.map((entry) => entry.label),
      width,
    ).map((tabLine) =>
      tabLine.flatMap((cell, position) => [
        ...(position > 0 ? [segment("  ", "muted")] : []),
        segment(cell.text, cell.index === panel ? "accent" : "muted", cell.index === panel),
      ]),
    );
    if (warning !== undefined) {
      for (const part of wrap(warning, width)) lines.push([segment(part, "warning")]);
    }
    if (status !== undefined) {
      for (const part of wrap(status, width)) lines.push([segment(part, "accent")]);
    }
    return lines;
  }

  // The body's rows: the frame less the top bar, the status line, the head of the main area and the input box.
  function bodyRows(columns: number, rows: number): number {
    return Math.max(0, rows - 2 - headLines(mainWidth(columns)).length - INPUT_BOX_ROWS);
  }

  // The rows of the panel or the open view: the body less the command list.
  function panelRows(columns: number, rows: number): number {
    const height = bodyRows(columns, rows);
    return height - commandList(mainWidth(columns), height).length;
  }

  // The command list while it shows, right above the input box, in the body's last rows.
  function commandList(width: number, height: number): FrameLine[] {
    const matches = suggestions();
    return commandListLines(matches, clamp(suggestion, 0, matches.length - 1), height, width);
  }

  // The home view's lines when it shows: on the home, with nothing running, ready or waiting for approval, nothing
  // open over it, and room for the banner.
  function homeView(width: number, height: number): FrameLine[] | undefined {
    if (!home || busy() || snapshot.pendingApprovals > 0) return undefined;
    if (form !== undefined || textLines() !== undefined) return undefined;
    return homeLines(facts(), width, height);
  }

  function homeShownAt(columns: number, rows: number): boolean {
    return homeView(mainWidth(columns), panelRows(columns, rows)) !== undefined;
  }

  // The body: a form, help or a task or plan detail as text, the home view, otherwise the active panel with its cursor.
  function bodyLines(columns: number, height: number): FrameLine[] {
    if (form !== undefined) {
      return form
        .lines()
        .slice(0, height)
        .map((line) => [segment(fit(line, columns), line.startsWith("> ") ? "accent" : "text")]);
    }
    const text = textLines();
    if (text !== undefined) {
      const lines = text.flatMap((line) =>
        wrap(line, columns).map((part) => segment(part, "text")),
      );
      textOffset = clampOffset(textOffset, height, lines.length);
      return lines.slice(textOffset, textOffset + height).map((part) => [part]);
    }
    const homed = homeView(columns, height);
    if (homed !== undefined) return homed;
    const view = activeView();
    const header = view.header.flatMap((text) =>
      wrap(text, columns).map((part) => [segment(part, "muted")]),
    );
    const items = view.items.map((item, index) => {
      const selected = index === cursors[panel];
      const text = `${selected ? "> " : "  "}${item.text}`;
      return [segment(fit(text, columns), selected ? "accent" : "text", selected)];
    });
    const empty =
      view.items.length === 0 && view.empty !== undefined
        ? wrap(view.empty, columns).map((part) => [segment(part, "muted")])
        : [];
    const all = [...header, ...items, ...empty];
    if (view.items.length > 0) {
      cursors[panel] = Math.min(Math.max(0, cursors[panel] ?? 0), view.items.length - 1);
      offsets[panel] = followCursor(
        offsets[panel] ?? 0,
        header.length + (cursors[panel] ?? 0),
        height,
        all.length,
      );
    } else {
      offsets[panel] = clampOffset(offsets[panel] ?? 0, height, all.length);
    }
    return all.slice(offsets[panel], (offsets[panel] ?? 0) + height);
  }

  // The line of the input box: the prompt and the text around the cursor, or the placeholder while it is empty. The
  // cursor shows while the keys are typed into the box: in input mode, with no form open.
  function inputLine(inner: number): FrameLine {
    const typing = mode === "input" && form === undefined;
    const prompt = segment("> ", typing ? "accent" : "muted");
    if (editor.value === "") {
      return typing
        ? [
            prompt,
            { text: PLACEHOLDER.slice(0, 1), tone: "muted", inverse: true },
            segment(PLACEHOLDER.slice(1), "muted"),
          ]
        : [prompt, segment(PLACEHOLDER, "muted")];
    }
    const view = editor.view(Math.max(0, inner - 2));
    return typing
      ? [
          prompt,
          segment(view.before, "text"),
          { text: view.at, tone: "text", inverse: true },
          segment(view.after, "text"),
        ]
      : [prompt, segment(`${view.before}${view.at}${view.after}`, "muted")];
  }

  function frame(columns: number, rows: number): FrameLine[] {
    const wide = columns >= RIGHT_COLUMN_FROM;
    const width = mainWidth(columns);
    const middle = Math.max(0, rows - 2);
    const height = bodyRows(columns, rows);
    const shownFacts = facts();
    const listed = commandList(width, height);
    const panelHeight = height - listed.length;
    const homeShown = homeView(width, panelHeight) !== undefined;
    const body = bodyLines(width, panelHeight);
    while (body.length < panelHeight) body.push([]);
    const main: FrameLine[] = [
      ...headLines(width),
      ...body,
      ...listed,
      ...box(
        mode === "input" ? "Input" : "Keys",
        [inputLine(width - 4)],
        width,
        footerText(homeShown),
      ),
    ];
    const lines: FrameLine[] = [
      topBar(shownFacts, columns, !wide),
      ...(wide
        ? joinColumns(main, width, rightColumn(shownFacts, middle), RIGHT_COLUMN_WIDTH, middle)
        : main.slice(0, middle)),
      statusLine(shownFacts, columns, !wide, mode),
    ];
    // Exactly `rows` lines, none wider than the terminal: pi-tui fails on a line wider than its width.
    while (lines.length < rows) lines.splice(lines.length - 1, 0, []);
    return lines.slice(0, rows).map((line) => fitLine(line, columns));
  }

  function move(delta: number): void {
    if (textLines() !== undefined) {
      textOffset = Math.max(0, textOffset + delta);
      return;
    }
    const count = activeView().items.length;
    if (count > 0) {
      cursors[panel] = clamp((cursors[panel] ?? 0) + delta, 0, count - 1);
    } else {
      offsets[panel] = Math.max(0, (offsets[panel] ?? 0) + delta);
    }
  }

  function jump(toEnd: boolean): void {
    if (textLines() !== undefined) {
      textOffset = toEnd ? Number.MAX_SAFE_INTEGER : 0;
      return;
    }
    const count = activeView().items.length;
    if (count > 0) cursors[panel] = toEnd ? count - 1 : 0;
    else offsets[panel] = toEnd ? Number.MAX_SAFE_INTEGER : 0;
  }

  function selectPanel(index: number): void {
    panel = index;
    home = false;
    detail = undefined;
    plan = undefined;
    textOffset = 0;
  }

  // Reads the store again. `fromWake` marks the reload the runtime's wake asked for: its git read is rate-limited.
  function reload(fromWake = false): void {
    // Live follows its newest row while the cursor is on it, as tail -f does: new tasks arrive at the end.
    const followLive = (cursors[LIVE_PANEL] ?? 0) >= snapshot.live.length - 1;
    snapshot = data.load(scope);
    if (followLive) cursors[LIVE_PANEL] = Math.max(0, snapshot.live.length - 1);
    if (detail !== undefined) detail = data.taskDetail(detail.detail.taskId);
    // A plan decided meanwhile, here or by haril approve elsewhere, leaves its detail for the list.
    if (openApproval() === undefined) plan = undefined;
    land();
    refreshGit(fromWake);
  }

  // While no panel was chosen yet, work in progress takes the shell from the home view to Live (LD-T6b-1).
  function land(): void {
    if (home && busy()) showLive();
  }

  // Reads the branch and changes of the git root again (LD-T6b-1): on opening, on r, after an action and when the
  // filter changes; for a reload a wake asked for, only when the last read started GIT_WAKE_INTERVAL_MS ago or more.
  // Never on a timer. A read asked for while one runs follows it once it is done.
  function refreshGit(fromWake = false): void {
    const read = options.readGit;
    const root = gitRoot();
    if (read === undefined || root === undefined) return;
    if (fromWake && now() - gitStartedAt < GIT_WAKE_INTERVAL_MS) return;
    if (gitReading) {
      gitAgain = true;
      return;
    }
    gitReading = true;
    gitStartedAt = now();
    void read(root)
      .catch(() => undefined)
      .then((status) => {
        gitReading = false;
        if (quitting) return;
        gitSeen = { root, status };
        if (gitAgain) {
          gitAgain = false;
          refreshGit();
        }
        tui.requestRender();
      });
  }

  // After a goal or an approval: Live with the cursor on the newest task, so the run is seen as it starts. The frame
  // scrolls to the cursor.
  function showLive(): void {
    selectPanel(LIVE_PANEL);
    cursors[LIVE_PANEL] = Math.max(0, snapshot.live.length - 1);
  }

  // The project a form or the input box adds to: the one the filter names, or the only project. Several projects and
  // no filter is the message `several`: the shell never guesses where a task goes (TUI-D13).
  function formProject(several: string): Project | undefined {
    helpOpen = false;
    detail = undefined;
    plan = undefined;
    textOffset = 0;
    if (pending) return undefined;
    if (snapshot.projects.length === 0) {
      status = NO_PROJECT_MESSAGE;
      return undefined;
    }
    const chosen =
      snapshot.projects.find((project) => project.projectId === scope) ??
      (snapshot.projects.length === 1 ? snapshot.projects[0] : undefined);
    status = chosen === undefined ? several : undefined;
    return chosen;
  }

  // a and /add: the add-task form (TUI-D13).
  function openAddTask(): void {
    const chosen = formProject(
      mode === "input"
        ? `${PICK_PROJECT}, then /add again`
        : "several projects: choose one on Projects (Enter), then press a to add a task",
    );
    if (chosen !== undefined) {
      form = new AddTaskForm({ projectSlug: chosen.slug, defaultModel: options.defaultModel });
    }
  }

  // g: the goal form, a plan task for a planner agent (LD-T5).
  function openGoal(): void {
    const chosen = formProject(
      "several projects: choose one on Projects (Enter), then press g to plan a goal",
    );
    if (chosen !== undefined) {
      form = new GoalForm({ projectSlug: chosen.slug, defaultModel: options.defaultModel });
    }
  }

  // Runs haril task add for the open form. A goal switches to Live, where its plan task shows up.
  function submitForm(): void {
    const current = form;
    if (current === undefined || pending) return;
    const target = { slug: current.projectSlug, dataDir: settings.dataDir };
    const goal = current instanceof GoalForm;
    const built = goal ? goalArgs(current.values(), target) : addTaskArgs(current.values(), target);
    if (!built.ok) {
      status = built.message;
      return;
    }
    runAction(built.args, goal ? "asking for a plan..." : "adding task...", true, (ok) => {
      if (ok && form === current) form = undefined;
      if (ok && goal) showLive();
    });
  }

  // y and n (LD-T5): approve or deny the open plan, or the one under the cursor on Plans; /approve and /deny pass the
  // plan they chose (LD-T6b-2). The CLI records the OS user as the decider; the runtime queues a granted plan, so an
  // approval switches to Live. A subject that is not a plan can only be denied. Whether the CLI was run.
  function decide(verb: "approve" | "deny", approvalId = selectedApproval()): boolean {
    if (pending || approvalId === undefined) return false;
    const approve = verb === "approve";
    const subject = snapshot.approvals.find((approval) => approval.approvalId === approvalId);
    if (approve && subject?.error !== undefined) {
      status = `plan ${approvalId.slice(0, 8)} is not a valid plan and cannot be approved; n denies it`;
      return false;
    }
    const args = [verb, approvalId];
    if (settings.dataDir !== undefined) args.push("--data-dir", settings.dataDir);
    runAction(args, approve ? "approving plan..." : "denying plan...", approve, (ok) => {
      if (!ok) return;
      plan = undefined;
      textOffset = 0;
      if (approve) showLive();
    });
    return true;
  }

  // /approve [id] and /deny [id] (LD-T6b-2): the pending plan whose id starts with `id`; without one, the plan y and n
  // would take, else the only pending plan. Anything else is a message and runs nothing. The plans are the snapshot's.
  function decideCommand(verb: "approve" | "deny", id: string | undefined): boolean {
    if (pending) return false;
    const plans = snapshot.approvals;
    if (id !== undefined) {
      const wanted = id.toLowerCase();
      const found = plans.filter((approval) =>
        approval.approvalId.toLowerCase().startsWith(wanted),
      );
      if (found.length !== 1) {
        status =
          found.length === 0
            ? `no pending plan matches ${id}`
            : `several pending plans start with ${id}: type more of the id`;
        return false;
      }
      return decide(verb, found[0]?.approvalId);
    }
    const chosen = selectedApproval() ?? (plans.length === 1 ? plans[0]?.approvalId : undefined);
    if (chosen === undefined) {
      status =
        plans.length === 0
          ? "no plan waits for approval"
          : `${plans.length} plans wait for approval: /${verb} <id>, or select one on Plans`;
      return false;
    }
    return decide(verb, chosen);
  }

  // Enter in input mode (LD-T6b-2): a line that starts with / is a command; any other text is a goal; an empty line is
  // the active panel's Enter.
  function submitInput(input: string, columns: number, rows: number): void {
    const text = editor.value.trim();
    if (text === "") handleKey(input, columns, rows);
    else if (text.startsWith("/")) runCommand(text);
    else submitGoal(editor.value);
  }

  // The typed goal as a plan task, with the defaults of the goal form and the same CLI call (LD-T5): Enter here queues
  // what g, the goal and Enter would. The line is cleared once the CLI took it; on a refusal it stays to be fixed.
  function submitGoal(goal: string): void {
    const chosen = formProject(`${PICK_PROJECT}, then Enter sends the goal`);
    if (chosen === undefined) return;
    const built = goalArgs(goalDefaults(goal, options.defaultModel), {
      slug: chosen.slug,
      dataDir: settings.dataDir,
    });
    if (!built.ok) {
      status = built.message;
      return;
    }
    const sent = editor.value;
    runAction(built.args, "asking for a plan...", true, (ok) => {
      if (!ok) return;
      if (editor.value === sent) clearInput();
      showLive();
    });
  }

  // Runs one / command. One that was carried out clears the line; an unknown command, a wrong argument or one that
  // could not run leaves it, with a message, to be fixed.
  function runCommand(text: string): void {
    const { name, argument } = parseCommand(text);
    const command = SLASH_COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
      status = `unknown command /${name} · /help lists them`;
      return;
    }
    if (argument !== undefined && (command.argument === undefined || /\s/.test(argument))) {
      status =
        command.argument === undefined ? `/${name} takes no argument` : `/${name} takes one id`;
      return;
    }
    if (perform(name, argument)) clearInput();
  }

  // What each command does: what its key does in navigation mode. Whether it was carried out.
  function perform(name: string, argument: string | undefined): boolean {
    const panelIndex = PANELS.findIndex((entry) => entry.id === name);
    if (panelIndex >= 0) {
      helpOpen = false;
      selectPanel(panelIndex);
      return true;
    }
    switch (name) {
      case "approve":
      case "deny":
        return decideCommand(name, argument);
      case "add":
        openAddTask();
        return form !== undefined;
      case "reload":
        reload();
        followRuntime();
        return true;
      case "help":
        helpOpen = true;
        textOffset = 0;
        return true;
      case "quit":
        quit();
        return true;
      default:
        return false;
    }
  }

  function clearInput(): void {
    editor.clear();
    listClosed = false;
    suggestion = 0;
  }

  // Runs one CLI action in the background (TUI-D13). The outcome is one line; then the store is read again and the
  // live feed subscribes if a runtime is up by then (LD-T5). After an action that queued work the shell starts a
  // runtime when none runs (LD-T6), and the line says how that went.
  function runAction(
    args: readonly string[],
    busy: string,
    queuesWork: boolean,
    done: (ok: boolean) => void,
  ): void {
    pending = true;
    status = busy;
    void actions.run(args).then((outcome) => {
      pending = false;
      if (quitting) return;
      reload();
      const note = outcome.ok && queuesWork ? ensureRuntime() : undefined;
      if (note === undefined) subscribeIfRuntimeRunning();
      status = note === undefined ? outcome.message : `${outcome.message} · ${note}`;
      done(outcome.ok);
      tui.requestRender();
    });
  }

  // Starts a runtime unless one runs (LD-T6, ADR-0022), with the lease just read from the store: never a second one
  // while the one this shell started still runs. Returns the note for the status line; none when a runtime runs.
  function ensureRuntime(): string | undefined {
    if (snapshot.runtimeAlive) return undefined;
    const starter = options.runtimeStarter;
    if (starter === undefined) return NO_RUNTIME_NOTE;
    if (started?.runtime.running === true) return startingNote(started.runtime.pid);
    const at = Date.now();
    const outcome = starter.start();
    if (!outcome.ok) return `could not start the runtime: ${outcome.message}`;
    const start: ShellStart = {
      runtime: outcome.runtime,
      log: outcome.log,
      at,
      confirmed: false,
      ended: false,
    };
    started = start;
    start.runtime.onExit((code) => runtimeExited(start, code));
    handshake(start);
    return startingNote(start.runtime.pid);
  }

  // The bounded handshake after a start (LD-T6): a few subscribe attempts, then the outcome on the status line. Nothing
  // keeps trying afterwards; r reads the store again. An exit of the child ends it sooner (runtimeExited).
  function handshake(start: ShellStart): void {
    const pid = start.runtime.pid;
    const subscribed =
      feed === undefined ? Promise.resolve(false) : feed.subscribe(HANDSHAKE_DELAYS_MS);
    void subscribed.then((ok) => {
      if (quitting || start.ended) return;
      reload();
      if (ok) {
        start.confirmed = true;
        lastStartFailed = false;
      }
      replaceNote(startingNote(pid), ok ? answeredNote(pid) : HANDSHAKE_GAVE_UP);
      tui.requestRender();
    });
  }

  // The child of a start exited. After it held the lease, or once the handshake reached a runtime, this is the normal
  // end (idle, a stop) and only the banner changes. Before that, the start failed, unless another runtime won the
  // lease: the handshake stops and the line says so, with the exit code and the log to read.
  function runtimeExited(start: ShellStart, code: number | null): void {
    if (quitting) return;
    reload();
    const lease = snapshot.runtime;
    const heldLease =
      lease.status !== "none" && lease.pid === start.runtime.pid && lease.startedAt >= start.at;
    if (start.confirmed || heldLease) {
      lastStartFailed = false;
    } else if (!start.ended) {
      start.ended = true;
      if (snapshot.runtimeAlive) {
        lastStartFailed = false;
        settleNote(start.runtime.pid, answeredNote(start.runtime.pid));
        subscribeIfRuntimeRunning();
      } else {
        feed?.stopRetrying();
        const again = lastStartFailed ? " again" : "";
        const exited = code === null ? "" : ` (code ${code})`;
        settleNote(start.runtime.pid, `the runtime exited${again}${exited}; see ${start.log}`);
        lastStartFailed = true;
      }
    }
    tui.requestRender();
  }

  // On opening and on r: subscribes to a running runtime, or starts one when work waits and none runs (LD-T6). Under
  // --no-runtime the line says that the waiting work needs haril start.
  function followRuntime(): void {
    if (snapshot.runtimeAlive) {
      subscribeIfRuntimeRunning();
      replaceNote(HANDSHAKE_GAVE_UP, "runtime running");
      return;
    }
    if (snapshot.waitingWork === 0) return;
    if (options.runtimeStarter === undefined) status = NO_RUNTIME_NOTE;
    else if (started?.runtime.running !== true) status = ensureRuntime();
  }

  // Applies a theme now and writes ui.theme (TUI-D14). A theme that cannot be loaded is reported and not saved.
  function applyTheme(name: string): void {
    if (settings.configPath === undefined) {
      status = `theme ${name} not saved: the shell has no config file (start it with haril shell)`;
      return;
    }
    const resolution = resolveTheme({
      name,
      runtimeRoot: settings.runtimeRoot,
      readFile: readOptionalFile,
    });
    if (resolution.warning !== undefined) {
      status = resolution.warning;
      return;
    }
    try {
      saveThemeChoice(settings.configPath, name);
    } catch (error) {
      status = `theme ${name} not saved: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    theme = resolution.theme;
    settings = { ...settings, themeName: name, themeLabel: resolution.theme.name };
    status = `theme ${name} saved`;
  }

  // Enter: on Projects it sets the filter (the first row is all projects); on Tasks, Agents and Live it opens the
  // detail; on Plans it opens the plan; on Themes it applies the theme.
  function enter(): void {
    const item = activeView().items[cursors[panel] ?? 0];
    if (item === undefined || item.value === undefined) return;
    const id = activeId();
    if (id === "themes") {
      applyTheme(item.value);
      return;
    }
    if (id === "projects") {
      scope = item.value === "" ? undefined : item.value;
      snapshot = data.load(scope);
      refreshGit();
      return;
    }
    if (id === "plans") {
      plan = item.value;
      textOffset = 0;
      return;
    }
    if (id === "tasks" || id === "agents" || id === "live") {
      detail = data.taskDetail(item.value);
      textOffset = 0;
    }
  }

  // Closes the help, a task detail or a plan detail, the one on top; false when none is open.
  function closeView(): boolean {
    if (helpOpen) helpOpen = false;
    else if (detail !== undefined) detail = undefined;
    else if (plan !== undefined) plan = undefined;
    else return false;
    textOffset = 0;
    return true;
  }

  // A key in navigation mode. Input mode passes Enter on an empty line, the arrows up and down, the page keys and Tab
  // here too, so they act the same in both modes.
  function handleKey(input: string, columns: number, rows: number): void {
    if (matchesKey(input, "escape")) {
      if (!closeView()) mode = "input";
      return;
    }
    if (matchesKey(input, "i")) {
      mode = "input";
      return;
    }
    if (matchesKey(input, "?")) {
      helpOpen = !helpOpen;
      textOffset = 0;
      return;
    }
    const motion = motionOf(input, pageSize(columns, rows));
    // A key that moves or opens leaves the home (LD-T6b-1): later work no longer takes the shell to Live. While the
    // banner shows, the key only reveals the active panel; otherwise it also acts on it.
    if (motion !== undefined || matchesKey(input, "enter")) {
      const bannerShown = homeShownAt(columns, rows);
      home = false;
      if (bannerShown) return;
    }
    if (motion !== undefined) {
      applyMotion(motion);
      return;
    }
    if (matchesKey(input, "a")) {
      openAddTask();
      return;
    }
    if (matchesKey(input, "g")) {
      openGoal();
      return;
    }
    const direct = DIRECT_PANELS.find((entry) => matchesKey(input, entry.key));
    if (direct !== undefined) {
      helpOpen = false;
      selectPanel(direct.panel);
      return;
    }
    if (helpOpen) return;
    if (matchesKey(input, "r")) {
      reload();
      followRuntime();
      return;
    }
    if (detail !== undefined) return;
    if (matchesKey(input, "y") || matchesKey(input, "n")) {
      decide(matchesKey(input, "y") ? "approve" : "deny");
      return;
    }
    if (plan !== undefined) return;
    const digit = NUMBER_KEYS.findIndex((key) => matchesKey(input, key));
    if (digit >= 0) {
      selectPanel(digit);
      return;
    }
    if (matchesKey(input, "tab")) {
      selectPanel((panel + 1) % PANELS.length);
      return;
    }
    if (matchesKey(input, "shift+tab")) {
      selectPanel((panel + PANELS.length - 1) % PANELS.length);
      return;
    }
    if (matchesKey(input, "enter")) enter();
  }

  // A key in input mode (LD-T6b-2). Esc closes the command list, then an open view, then switches to navigation mode.
  // While the list shows, the arrows up and down choose in it, Tab completes the chosen command and Enter runs it.
  // Otherwise Enter submits the line, the panel keys act on the panels, and every other key edits the line.
  function handleInputKey(input: string, columns: number, rows: number): void {
    const matches = suggestions();
    if (matchesKey(input, "escape")) {
      if (matches.length > 0) listClosed = true;
      else if (!closeView()) mode = "navigation";
      return;
    }
    const chosen = matches[clamp(suggestion, 0, matches.length - 1)];
    if (chosen !== undefined) {
      if (matchesKey(input, "up") || matchesKey(input, "down")) {
        suggestion = clamp(suggestion + (matchesKey(input, "up") ? -1 : 1), 0, matches.length - 1);
        return;
      }
      if (matchesKey(input, "tab")) {
        // A command with an argument completes with a space after it, ready for the id.
        editor.setValue(`/${chosen.name}${chosen.argument === undefined ? "" : " "}`);
        suggestion = 0;
        return;
      }
      if (matchesKey(input, "enter")) {
        runCommand(`/${chosen.name}`);
        return;
      }
    }
    if (matchesKey(input, "enter")) {
      submitInput(input, columns, rows);
      return;
    }
    if (PANEL_KEYS.some((key) => matchesKey(input, key))) {
      handleKey(input, columns, rows);
      return;
    }
    const before = editor.value;
    editor.handleInput(input);
    if (editor.value !== before) {
      listClosed = false;
      suggestion = 0;
    }
  }

  // While the form is open every key is the form's, except Ctrl+C: q and the digits are text in the title.
  function handleFormKey(input: string): void {
    const current = form;
    if (current === undefined || pending) return;
    if (matchesKey(input, "escape")) {
      form = undefined;
      status = current instanceof GoalForm ? "goal cancelled" : "add task cancelled";
      return;
    }
    if (matchesKey(input, "enter")) {
      submitForm();
      return;
    }
    if (matchesKey(input, "tab")) {
      current.next();
      return;
    }
    if (matchesKey(input, "shift+tab")) {
      current.previous();
      return;
    }
    current.handleInput(input);
  }

  function applyMotion(motion: Motion): void {
    if (motion.kind === "step") move(motion.delta);
    else jump(motion.toEnd);
  }

  function quit(): void {
    quitting = true;
    feed?.close();
    tui.stop();
    data.close();
    void terminal.drainInput().then(() => resolveDone());
  }

  const root: Component = {
    render: (width: number): string[] =>
      frame(width, terminal.rows).map((line) => line.map((part) => styled(theme, part)).join("")),
    invalidate: () => {},
  };
  tui.addChild(root);
  // Ctrl+C quits in every mode; q only in navigation mode with no form open. A key release (Kitty) is no key.
  tui.addInputListener((input) => {
    if (quitting || isKeyRelease(input)) return { consume: true };
    const quits =
      matchesKey(input, "ctrl+c") ||
      (form === undefined && mode === "navigation" && matchesKey(input, "q"));
    if (quits) {
      quit();
      return { consume: true };
    }
    if (form !== undefined) handleFormKey(input);
    else if (mode === "input") handleInputKey(input, terminal.columns, terminal.rows);
    else handleKey(input, terminal.columns, terminal.rows);
    if (!quitting) tui.requestRender();
    return { consume: true };
  });

  return {
    start: () => {
      tui.start();
      land();
      refreshGit();
      followRuntime();
      tui.requestRender();
    },
    done,
    frameText: () =>
      frame(terminal.columns, terminal.rows).map((line) => line.map((part) => part.text).join("")),
  };
}

// "3 completed, 1 failed": the scope's tasks counted by state, most common first; "none yet" without any.
function taskSummary(tasks: readonly { readonly state: string }[]): string {
  if (tasks.length === 0) return "none yet";
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
}

// The colors and weight of a segment, applied after fit cut its text: the only escape sequences the frame writes.
function styled(theme: Theme, part: Segment): string {
  const painted = theme.fg(part.tone, part.text);
  const weighted = part.bold === true ? theme.bold(painted) : painted;
  return part.inverse === true ? `\x1b[7m${weighted}\x1b[27m` : weighted;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
