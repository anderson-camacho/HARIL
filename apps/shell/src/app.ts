import { type Component, matchesKey, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { createHarilActions, type ShellActions } from "./actions.js";
import { AddTaskForm, addTaskArgs } from "./add-task.js";
import { saveThemeChoice } from "./config-file.js";
import type { PendingApproval, ShellData, ShellSnapshot, TaskDetailView } from "./data.js";
import { fit, runtimeState, wrap } from "./format.js";
import { GoalForm, goalArgs } from "./goal.js";
import { HELP_LINES } from "./help.js";
import { clampOffset, followCursor, packTabs } from "./layout.js";
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
import { readOptionalFile, resolveTheme, type Theme } from "./theme.js";

// The shell app (TUI-T3): header, banner, tab strip, the active panel's body and a footer with its keys. The app only
// reads through ShellData; its state is the selected panel, one cursor and scroll offset per panel, the project filter,
// an open task or plan detail, an open form and the help overlay. Each key changes that state and the next frame
// shows it. Every write is a haril child process (TUI-D13).

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
}

export interface ShellApp {
  start(): void;
  // Resolves once the user quits (q or Ctrl+C); the store is closed and the terminal restored by then.
  readonly done: Promise<void>;
  // The frame as plain text at the terminal's size, for tests and diagnostics.
  frameText(): string[];
}

type Tone = "text" | "muted" | "accent" | "warning";
interface Segment {
  readonly text: string;
  readonly tone: Tone;
  readonly bold?: boolean;
}
type FrameLine = readonly Segment[];

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
const FOOTER_TAIL = ["r reload", "? help", "q quit"] as const;
const FORM_FOOTER = "Enter add task · Tab next field · Esc cancel · Ctrl+C quit";
const GOAL_FOOTER = "Enter ask for a plan · Tab next field · Esc cancel · Ctrl+C quit";
const PLAN_FOOTER = "y approve · n deny · ↑↓ scroll · Esc back · r reload · q quit";
const THEMES_PANEL = PANELS.findIndex((entry) => entry.id === "themes");
const PLANS_PANEL = PANELS.findIndex((entry) => entry.id === "plans");
const LIVE_PANEL = PANELS.findIndex((entry) => entry.id === "live");
const NO_PROJECT_MESSAGE =
  "no project yet; create one with: haril project init <path> --name <name>";
// The shell never starts the runtime (LD-T6 will); a queued plan task or a granted plan waits for one.
const NO_RUNTIME_NOTE = "no runtime is running: start it with haril start";
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
  let quitting = false;
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
            reload();
            tui.requestRender();
          },
          onChange: () => tui.requestRender(),
        });
  const liveMark = (): string => (feed?.subscribed === true ? " · live" : "");
  // Subscribes only while the runtime is active: on open and after r, never by polling (LD-T2).
  const subscribeIfRuntimeRunning = (): void => {
    if (feed !== undefined && runtimeState(snapshot.runtime, snapshot.loadedAt) === "running") {
      feed.subscribe();
    }
  };

  const activeId = () => PANELS[panel]?.id ?? "projects";
  const context = (): PanelContext => ({ snapshot, settings, scope });
  const activeView = (): PanelView => buildPanelView(activeId(), context());
  const projectSlug = (): string =>
    scope === undefined
      ? "all"
      : (snapshot.projects.find((project) => project.projectId === scope)?.slug ?? "all");
  const runtimeRunning = (): boolean =>
    runtimeState(snapshot.runtime, snapshot.loadedAt) === "running";
  const approvalsText = (): string =>
    snapshot.pendingApprovals === 0
      ? "0 pending approvals"
      : `${snapshot.pendingApprovals} pending approvals (p to review)`;
  const bannerText = (): string =>
    // The pending-approval count is read from the store with the rest of the snapshot (LD-T3). "live" shows while
    // the shell holds a subscription to the runtime (LD-T2).
    `isolation ${banner.isolation} · ${approvalsText()} · runtime ${runtimeState(snapshot.runtime, snapshot.loadedAt)}${liveMark()} · project ${projectSlug()}`;
  const openApproval = (): PendingApproval | undefined =>
    plan === undefined
      ? undefined
      : snapshot.approvals.find((approval) => approval.approvalId === plan);
  // The text views over the panels: help, a task detail or a plan detail. Undefined shows the active panel.
  const textLines = (): readonly string[] | undefined => {
    if (helpOpen) return HELP_LINES;
    if (detail !== undefined) return buildTaskDetailView(detail);
    const approval = openApproval();
    return approval === undefined ? undefined : buildPlanDetailView(approval, context());
  };
  const footerText = (): string => {
    if (form !== undefined) return form instanceof GoalForm ? GOAL_FOOTER : FORM_FOOTER;
    if (helpOpen) return "↑↓ scroll · Esc close help · q quit";
    if (detail !== undefined) return "↑↓ scroll · Esc back · r reload · q quit";
    if (openApproval() !== undefined) return PLAN_FOOTER;
    return [
      ...activeView().keys,
      "↑↓ move",
      "Tab next panel",
      "g goal",
      "p plans",
      "l live",
      "a add task",
      "t themes",
      ...FOOTER_TAIL,
    ].join(" · ");
  };
  const pageSize = (columns: number, rows: number): number =>
    Math.max(1, bodyHeight(columns, rows) - 1);

  function chromeTop(columns: number): number {
    return (
      2 +
      packTabs(
        PANELS.map((entry) => entry.label),
        columns,
      ).length +
      (warning === undefined ? 0 : wrap(warning, columns).length) +
      (status === undefined ? 0 : wrap(status, columns).length)
    );
  }

  // The footer takes as many lines as its keys need, so the body gives up the same lines.
  function bodyHeight(columns: number, rows: number): number {
    return Math.max(1, rows - chromeTop(columns) - wrap(footerText(), columns).length);
  }

  // The body: a form, help or a task or plan detail as text, otherwise the active panel with its cursor.
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

  function frame(columns: number, rows: number): FrameLine[] {
    const lines: FrameLine[] = [[segment(fit("HARIL shell", columns), "accent", true)]];
    lines.push([segment(fit(bannerText(), columns), "muted")]);
    for (const tabLine of packTabs(
      PANELS.map((entry) => entry.label),
      columns,
    )) {
      const cells: Segment[] = [];
      tabLine.forEach((cell, position) => {
        if (position > 0) cells.push(segment("  ", "muted"));
        cells.push(
          segment(cell.text, cell.index === panel ? "accent" : "muted", cell.index === panel),
        );
      });
      lines.push(cells);
    }
    if (warning !== undefined) {
      for (const part of wrap(warning, columns)) lines.push([segment(part, "warning")]);
    }
    if (status !== undefined) {
      for (const part of wrap(status, columns)) lines.push([segment(part, "accent")]);
    }
    const height = bodyHeight(columns, rows);
    const body = bodyLines(columns, height);
    while (body.length < height) body.push([segment("", "text")]);
    lines.push(...body);
    for (const part of wrap(footerText(), columns)) lines.push([segment(part, "muted")]);
    return lines;
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
    detail = undefined;
    plan = undefined;
    textOffset = 0;
  }

  function reload(): void {
    // Live follows its newest row while the cursor is on it, as tail -f does: new tasks arrive at the end.
    const followLive = (cursors[LIVE_PANEL] ?? 0) >= snapshot.live.length - 1;
    snapshot = data.load(scope);
    if (followLive) cursors[LIVE_PANEL] = Math.max(0, snapshot.live.length - 1);
    if (detail !== undefined) detail = data.taskDetail(detail.detail.taskId);
    // A plan decided meanwhile, here or by haril approve elsewhere, leaves its detail for the list.
    if (openApproval() === undefined) plan = undefined;
  }

  // After a goal or an approval: Live with the cursor on the newest task, so the run is seen as it starts. The frame
  // scrolls to the cursor.
  function showLive(): void {
    selectPanel(LIVE_PANEL);
    cursors[LIVE_PANEL] = Math.max(0, snapshot.live.length - 1);
  }

  // The project a form adds to: the one the filter names, or the only project. Several projects and no filter is a
  // message: the shell never guesses where a task goes (TUI-D13).
  function formProject(key: string, purpose: string): Project | undefined {
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
    status =
      chosen === undefined
        ? `several projects: choose one on Projects (Enter), then press ${key} to ${purpose}`
        : undefined;
    return chosen;
  }

  // a: the add-task form (TUI-D13).
  function openAddTask(): void {
    const chosen = formProject("a", "add a task");
    if (chosen !== undefined) {
      form = new AddTaskForm({ projectSlug: chosen.slug, defaultModel: options.defaultModel });
    }
  }

  // g: the goal form, a plan task for a planner agent (LD-T5).
  function openGoal(): void {
    const chosen = formProject("g", "plan a goal");
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
    runAction(built.args, goal ? "asking for a plan..." : "adding task...", goal, (ok) => {
      if (ok && form === current) form = undefined;
      if (ok && goal) showLive();
    });
  }

  // y and n (LD-T5): approve or deny the open plan, or the one under the cursor on Plans. The CLI records the OS
  // user as the decider; the runtime queues a granted plan, so an approval switches to Live. A subject that is not a
  // plan can only be denied.
  function decide(verb: "approve" | "deny"): void {
    if (pending) return;
    const approvalId =
      plan ?? (activeId() === "plans" ? activeView().items[cursors[panel] ?? 0]?.value : undefined);
    if (approvalId === undefined) return;
    const approve = verb === "approve";
    const subject = snapshot.approvals.find((approval) => approval.approvalId === approvalId);
    if (approve && subject?.error !== undefined) {
      status = `plan ${approvalId.slice(0, 8)} is not a valid plan and cannot be approved; n denies it`;
      return;
    }
    const args = [verb, approvalId];
    if (settings.dataDir !== undefined) args.push("--data-dir", settings.dataDir);
    runAction(args, approve ? "approving plan..." : "denying plan...", approve, (ok) => {
      if (!ok) return;
      plan = undefined;
      textOffset = 0;
      if (approve) showLive();
    });
  }

  // Runs one CLI action in the background (TUI-D13). The outcome is one line; then the store is read again and the
  // live feed subscribes if a runtime is up by then (LD-T5). An action that needs the runtime says so when none runs.
  function runAction(
    args: readonly string[],
    busy: string,
    needsRuntime: boolean,
    done: (ok: boolean) => void,
  ): void {
    pending = true;
    status = busy;
    void actions.run(args).then((outcome) => {
      pending = false;
      if (quitting) return;
      reload();
      subscribeIfRuntimeRunning();
      status =
        outcome.ok && needsRuntime && !runtimeRunning()
          ? `${outcome.message} · ${NO_RUNTIME_NOTE}`
          : outcome.message;
      done(outcome.ok);
      tui.requestRender();
    });
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

  function handleKey(input: string, columns: number, rows: number): void {
    if (matchesKey(input, "?")) {
      helpOpen = !helpOpen;
      textOffset = 0;
      return;
    }
    if (matchesKey(input, "escape")) {
      if (helpOpen) helpOpen = false;
      else if (detail !== undefined) detail = undefined;
      else plan = undefined;
      textOffset = 0;
      return;
    }
    const motion = motionOf(input, pageSize(columns, rows));
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
      subscribeIfRuntimeRunning();
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
  tui.addInputListener((input) => {
    if (quitting) return { consume: true };
    if (matchesKey(input, "ctrl+c") || (form === undefined && matchesKey(input, "q"))) {
      quit();
      return { consume: true };
    }
    if (form !== undefined) handleFormKey(input);
    else handleKey(input, terminal.columns, terminal.rows);
    tui.requestRender();
    return { consume: true };
  });

  return {
    start: () => {
      tui.start();
      subscribeIfRuntimeRunning();
    },
    done,
    frameText: () =>
      frame(terminal.columns, terminal.rows).map((line) => line.map((part) => part.text).join("")),
  };
}

function segment(text: string, tone: Tone, bold = false): Segment {
  return bold ? { text, tone, bold } : { text, tone };
}

function styled(theme: Theme, part: Segment): string {
  const painted = theme.fg(part.tone, part.text);
  return part.bold === true ? theme.bold(painted) : painted;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
