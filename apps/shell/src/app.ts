import { type Component, matchesKey, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { ShellData, ShellSnapshot, TaskDetailView } from "./data.js";
import { fit, runtimeState, wrap } from "./format.js";
import { HELP_LINES } from "./help.js";
import { clampOffset, followCursor, packTabs } from "./layout.js";
import {
  buildPanelView,
  buildTaskDetailView,
  PANELS,
  type PanelContext,
  type PanelView,
  type ShellSettings,
} from "./panels/index.js";
import type { Theme } from "./theme.js";

// The shell app (TUI-T3): header, banner, tab strip, the active panel's body and a footer with its keys. The app only
// reads through ShellData; its state is the selected panel, one cursor and scroll offset per panel, the project filter,
// an open task detail and the help overlay. Each key changes that state and the next frame shows it.

interface ShellBanner {
  readonly isolation: string;
  readonly pendingApprovals: number;
}

export interface ShellAppOptions {
  readonly terminal: Terminal;
  readonly theme: Theme;
  readonly banner: ShellBanner;
  // A notice shown under the banner, such as a theme that could not be loaded.
  readonly warning?: string;
  readonly data: ShellData;
  readonly settings: ShellSettings;
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

export function createShellApp(options: ShellAppOptions): ShellApp {
  const { terminal, theme, banner, data, settings, warning } = options;
  const tui = new TuiMainScreen(terminal);
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let snapshot: ShellSnapshot = data.load(undefined);
  let panel = 0;
  let scope: string | undefined;
  const cursors: number[] = PANELS.map(() => 0);
  const offsets: number[] = PANELS.map(() => 0);
  let detail: TaskDetailView | undefined;
  let textOffset = 0;
  let helpOpen = false;
  let quitting = false;

  const activeId = () => PANELS[panel]?.id ?? "projects";
  const context = (): PanelContext => ({ snapshot, settings, scope });
  const activeView = (): PanelView => buildPanelView(activeId(), context());
  const projectSlug = (): string =>
    scope === undefined
      ? "all"
      : (snapshot.projects.find((project) => project.projectId === scope)?.slug ?? "all");
  const bannerText = (): string =>
    // Approvals do not exist in this version, so the count is always 0 (the caller passes it).
    `isolation ${banner.isolation} · ${banner.pendingApprovals} pending approvals · runtime ${runtimeState(snapshot.runtime, snapshot.loadedAt)} · project ${projectSlug()}`;
  const footerText = (): string => {
    if (helpOpen) return "↑↓ scroll · Esc close help · q quit";
    if (detail !== undefined) return "↑↓ scroll · Esc back · r reload · q quit";
    return [...activeView().keys, "↑↓ move", "Tab next panel", ...FOOTER_TAIL].join(" · ");
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
      (warning === undefined ? 0 : wrap(warning, columns).length)
    );
  }

  function bodyHeight(columns: number, rows: number): number {
    return Math.max(1, rows - chromeTop(columns) - 1);
  }

  // The body: help or task detail as text, otherwise the active panel with its cursor.
  function bodyLines(columns: number, height: number): FrameLine[] {
    if (helpOpen || detail !== undefined) {
      const lines = (
        helpOpen || detail === undefined ? [...HELP_LINES] : buildTaskDetailView(detail)
      ).flatMap((text) => wrap(text, columns).map((part) => segment(part, "text")));
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
    const height = bodyHeight(columns, rows);
    const body = bodyLines(columns, height);
    while (body.length < height) body.push([segment("", "text")]);
    lines.push(...body);
    lines.push([segment(fit(footerText(), columns), "muted")]);
    return lines;
  }

  function move(delta: number): void {
    if (helpOpen || detail !== undefined) {
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
    if (helpOpen || detail !== undefined) {
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
    textOffset = 0;
  }

  function reload(): void {
    snapshot = data.load(scope);
    if (detail !== undefined) detail = data.taskDetail(detail.detail.taskId);
  }

  // Enter: on Projects it sets the filter (the first row is all projects); on Tasks and Agents it opens the detail.
  function enter(): void {
    const item = activeView().items[cursors[panel] ?? 0];
    if (item === undefined || item.value === undefined) return;
    if (activeId() === "projects") {
      scope = item.value === "" ? undefined : item.value;
      snapshot = data.load(scope);
      return;
    }
    if (activeId() === "tasks" || activeId() === "agents") {
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
      else detail = undefined;
      textOffset = 0;
      return;
    }
    const motion = motionOf(input, pageSize(columns, rows));
    if (motion !== undefined) {
      applyMotion(motion);
      return;
    }
    if (helpOpen) return;
    if (matchesKey(input, "r")) {
      reload();
      return;
    }
    if (detail !== undefined) return;
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

  function applyMotion(motion: Motion): void {
    if (motion.kind === "step") move(motion.delta);
    else jump(motion.toEnd);
  }

  function quit(): void {
    quitting = true;
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
    if (matchesKey(input, "q") || matchesKey(input, "ctrl+c")) {
      quit();
      return { consume: true };
    }
    handleKey(input, terminal.columns, terminal.rows);
    tui.requestRender();
    return { consume: true };
  });

  return {
    start: () => tui.start(),
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
