// HARIL console: a Pi extension loaded with `-e` by `haril console` (and a bare `haril` in a terminal), the way
// Gentle Shell is Pi with its own extension. Pi keeps everything it has (/login, /model, the thinking level,
// /settings, sessions); this adds HARIL's yellow bar, a startup header and the HARIL commands, which run the `haril`
// CLI on the project of the folder Pi opened in. Self-contained: node:* imports and local types only, so it bundles
// into one file next to the bridge.

import { actionHit } from "./actions-view.js";
import { createActivityPanel } from "./activity-panel.js";
import { createChatLog } from "./chat-log.js";
import { cliAvailable, NOT_LAUNCHED, runHaril, runHarilJson } from "./cli.js";
import {
  type CatalogEntry,
  catalogEntries,
  createCommandPicker,
  statusCommandDescription,
} from "./command-catalog.js";
import {
  type CommandHost,
  chooseMode,
  delegationHost,
  harilCommandDescriptions,
  registerCommands,
} from "./commands.js";
import {
  barAreas,
  DASHBOARD_AREAS,
  type DashboardArea,
  type DashboardFacts,
  type NativeRailContent,
  type RailHitAction,
  type RailSection,
  railArea,
  railControls,
  railWarnings,
  renderHeaderLayout,
  renderNativeRailContent,
} from "./dashboard.js";
import {
  openDashboardActionMenu,
  runDashboardAction,
  showInlineDetails,
} from "./dashboard-actions.js";
import type { DashboardAction } from "./dashboard-controls.js";
import { type DashboardData, emptyDashboardData, loadDashboardData } from "./dashboard-data.js";
import { HARIL_PALETTES, setHarilPalette } from "./dashboard-theme.js";
import { delegateFromChat } from "./delegation.js";
import { effectText, sourceText, valueText } from "./delegation-settings.js";
import { actionsDetails, loadDockDetails, readDocsPath } from "./dock-details.js";
import {
  createDockPicker,
  type DockPickerResult,
  dockIdFromWord,
  dockSlotAt,
} from "./dock-navigation.js";
import { stopAll } from "./emergency.js";
import { createGitSummaryCache, type GitSummary } from "./git-summary.js";
import { DEFAULT_UI_LOCALE, localized, readConsoleLocale, type UiLocale } from "./locale.js";
import { miniLogo } from "./mini-logo.js";
import { installModes } from "./mode-controller.js";
import { levelLabel } from "./model-levels.js";
import { chooseLevel, chooseModel, createLevelMemory, type LevelMemory } from "./model-picker.js";
import {
  harilRef,
  type ModelRegistration,
  registerHarilModels,
  restoreHarilModel,
} from "./models.js";
import { modeLabel } from "./modes.js";
import {
  attachNativePanes,
  DOCK_LABELS,
  initialPaneSettings,
  MAIN_DOCK_ID,
  type NativePanes,
  type PaneSettings,
  panesFit,
  panesShown,
  readDockSlots,
  statusInSidebar,
} from "./native-panes.js";
import { ASCII_GLYPHS, orchestrationGlyphs } from "./orchestration-draw.js";
import { createWorkflowFeed, type WorkflowFeed } from "./orchestration-feed.js";
import { openOrchestrationOverlay } from "./orchestration-overlay.js";
import {
  initialOrchestrationState,
  type OrchestrationAction,
  type OrchestrationState,
  reduceOrchestration,
  selectedNode,
} from "./orchestration-state.js";
import { EMPTY_MESSAGE } from "./orchestration-view.js";
import { decodePiExtensionPackages, extensionStatusText } from "./pi-extensions.js";
import type {
  AgentMessage,
  ConsoleContext,
  ConsoleMouseEvent,
  ConsolePi,
  ConsoleTui,
  PiModel,
  SessionEntry,
} from "./pi-types.js";
import { powerlineEnabled } from "./powerline.js";
import { type BoundProject, findProject, folderName } from "./project.js";
import { buildRailMenu, runRailHit } from "./rail-actions.js";
import { type PendingApproval, readStatus } from "./status.js";
import {
  contextFiles,
  declaredPackages,
  type ExtensionEntry,
  extensionInventory,
  npmLatest,
  packageUpdates,
  readAgentSettings,
  statusLines,
  updateWarning,
} from "./status-info.js";
import { createTabPicker, type TabPickerResult } from "./tab-picker.js";
import { clipText, plainText } from "./text.js";
import { buildCatalog, type Catalog } from "./tools-catalog.js";
import { createToolsPanel, type ToolsHost } from "./tools-panel.js";
import {
  type BarFacts,
  type BarLayout,
  type RuntimeState,
  renderBarLayout,
  renderOutput,
} from "./view.js";

const VERSION_ENV = "HARIL_VERSION";
const OUTPUT_WIDGET = "haril-output";
// Columns the right rail is rendered at for its keyboard menu: wider than any row, so no label is cut.
const RAIL_MENU_WIDTH = 120;
// The bar reads the runtime and the plans again this often, and only while a runtime runs or a plan waits.
const REFRESH_MS = 5_000;

interface Session extends CommandHost {
  readonly ctx: ConsoleContext;
  locale: UiLocale;
  project: BoundProject | undefined;
  pending: readonly PendingApproval[];
  pendingAvailable: boolean;
  tui: ConsoleTui | undefined;
  nativePanes: NativePanes | undefined;
  dock: PaneSettings;
  dockLoadSeq: number;
  // The tab being read right now: reloading the list of tabs must not start a second read of it.
  dockLoading: PaneSettings["selected"] | undefined;
  area: DashboardArea | undefined;
  branch: string | null | undefined;
  extensionStatuses: readonly string[];
  providerWarnings: readonly string[];
  // npm packages with a newer version (status-info.ts); empty until the background check answers.
  packageUpdates: readonly string[];
  railVisible: boolean;
  railExpanded: Partial<Record<RailSection, boolean>>;
  model: PiModel | undefined;
  // HARIL's providers as registered in Pi; undefined until `haril models` answers.
  registration: ModelRegistration | undefined;
  // The reasoning level kept per model for this session (model-picker.ts).
  readonly levels: LevelMemory;
  cost: number;
  runtimeAlive: boolean | undefined;
  runtimeStatusAvailable: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
  refreshing: Promise<void> | undefined;
  // A refresh asked for while one runs: that one reads once more before it settles, so no caller sees stale state.
  refreshAgain: boolean;
  dashboardData: DashboardData;
  dashboardLoading: boolean;
  dashboardRefresh: Promise<void> | undefined;
  // The ORCHESTRATION view's state, shared by the module panel and its full-view overlay, and its real data: the
  // children haril workflow watch and tail (orchestration-feed.ts).
  orchestration: OrchestrationState;
  orchestrationOpen: boolean;
  readonly feed: WorkflowFeed;
  orchestrationDemo(): boolean;
  runtime(): string;
  runtimeAvailable(): boolean;
  modelRef(): string | undefined;
  tools(): { readonly name: string; readonly active: boolean }[];
  tasks(): readonly {
    readonly taskId: string;
    readonly state: string;
    readonly goal: string;
    readonly agent: string;
    readonly model: string | null;
  }[];
  approvals(): readonly PendingApproval[];
  approvalsAvailable(): boolean;
  events(): DashboardData["events"];
  methodologies(): readonly string[];
  methodologyEntries(): DashboardData["methodologyEntries"];
  methodologiesAvailable(): boolean;
  methodologyError(): string | undefined;
  memorySummary(): string;
  reload(): Promise<void>;
  refreshStatus(): Promise<void>;
  output(title: string, lines: readonly string[]): void;
  details(): { readonly title: string; readonly lines: readonly string[] };
  closed: boolean;
}

// The session's spend: the cost Pi recorded on every assistant message of the session file, every branch included.
// `ended` is a message that just ended: Pi 1.2.0 tells extensions before it appends the message to the session, so
// its cost is added unless the entries already hold that same message.
function sessionCost(entries: readonly SessionEntry[], ended?: AgentMessage): number {
  let total = 0;
  let endedSeen = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message === ended) endedSeen = true;
    total += costOf(entry.message);
  }
  if (ended?.role === "assistant" && !endedSeen) total += costOf(ended);
  return total;
}

function costOf(message: AgentMessage): number {
  const cost = message.usage?.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

// What a test may replace so that no real command runs: the way the TOOLS tab's check and actions reach the HARIL CLI, and
// how long the check waits after the console opens. Pi calls the console with the extension API alone.
export interface ConsoleOptions {
  readonly tools?: {
    readonly run?: ToolsHost["run"];
    readonly checkDelayMs?: number;
  };
  // How the latest version of an npm package is read; null never asks. Tests set it.
  readonly packageLatest?: ((name: string) => Promise<string | undefined>) | null;
  // The git counts of the bar's powerline folder line: how a test answers them without running git.
  readonly git?: {
    readonly read?: (cwd: string) => Promise<GitSummary | undefined>;
  };
}

function catalogCounts(catalog: Catalog) {
  return {
    skills: catalog.skills.length,
    servers: catalog.servers.length,
    connected: catalog.servers.filter(({ state }) => state === "connected").length,
  };
}

export default function harilConsole(pi: ConsolePi, options: ConsoleOptions = {}): void {
  // The shortcuts as they are registered, so the command list and /haril-status read them instead of a copy.
  const shortcuts: {
    readonly key: string;
    readonly description: string;
    readonly handler: (ctx: ConsoleContext) => void;
  }[] = [];
  const registerShortcut = (
    key: string,
    shortcut: { description?: string; handler(ctx: ConsoleContext): void },
  ): void => {
    shortcuts.push({
      key,
      description: shortcut.description ?? "",
      handler: (ctx) => shortcut.handler(ctx),
    });
    pi.registerShortcut(key, shortcut);
  };
  let session: Session | undefined;

  const redraw = (): void => session?.tui?.requestRender();

  // The console modes and their read-only guard (F4): registered once, before any session, so the guard is in place
  // for the first tool call. Research files go under the bound project's root, else the folder Pi opened in.
  const modes = installModes(pi, {
    researchRoot: () => session?.project?.rootPath ?? session?.cwd ?? process.cwd(),
    // P18: haril.json names the research folder (delegation.research.folder); without haril, docs/investigacion.
    researchFolder: async () => {
      if (!cliAvailable()) return undefined;
      const read = await runHarilJson(["config", "get", "delegation.research.folder", "--json"], {
        timeoutMs: 10_000,
      });
      const value = (read as { value?: unknown } | undefined)?.value;
      return typeof value === "string" ? value : undefined;
    },
    now: () => Date.now(),
    redraw,
  });

  // Every prompt and every reply of the chat, logged through haril usage record (4.5, P14); only when this Pi was
  // opened by haril, and never in the way of the chat: failures show as "log ✗ n" in the bar.
  const chatLog = createChatLog({
    run: (args, input) => runHaril(args, { cwd: session?.cwd, input, timeoutMs: 10_000 }),
    projectSlug: () => session?.project?.slug,
    sessionId: () => session?.ctx.sessionManager.getSessionId(),
    onChange: redraw,
  });

  // The TOOLS tab's data, its actions and the check that runs when the console opens (tools-panel.ts). Every command goes
  // through the HARIL CLI, in the background, and none is waited for by the console.
  const toolsPanel = createToolsPanel(
    {
      run:
        options.tools?.run ??
        ((args, { timeoutMs }) => runHaril(args, { cwd: session?.cwd, timeoutMs })),
      env: () => process.env,
      locale: () => session?.locale ?? DEFAULT_UI_LOCALE,
      extensions: () => loadedExtensions(),
      catalog: () => loadedCatalog(session),
      ui: () =>
        session === undefined || session.closed || !session.ctx.hasUI ? undefined : session.ctx.ui,
      memoryOpen: () =>
        session !== undefined && !session.closed && session.dock.selected === "memory",
      // Only the busy state changed: the tab is drawn again from the data it holds, with no command run.
      repaint: () => {
        const current = session;
        if (current === undefined || current.closed || current.dock.detail?.id !== "memory") return;
        if (current.dock.selected !== "memory") return;
        const details = toolsPanel.view();
        if (details === undefined) return;
        current.dock.detail = details;
        current.nativePanes?.refresh();
      },
      reload: () => {
        const current = session;
        if (current !== undefined && !current.closed && current.dock.selected === "memory") {
          void openDockSlot(current, "memory");
        }
      },
    },
    options.tools?.checkDelayMs === undefined ? {} : { checkDelayMs: options.tools.checkDelayMs },
  );

  // The ACT tab's range, its reads and its dialog (activity-panel.ts). Every command goes through the HARIL CLI, in the
  // background, and none is waited for by the console.
  const activityPanel = createActivityPanel({
    run: (args, { timeoutMs }) => runHaril(args, { cwd: session?.cwd, timeoutMs }),
    locale: () => session?.locale ?? DEFAULT_UI_LOCALE,
    projectSlug: () => session?.project?.slug,
    now: () => Date.now(),
    ui: () =>
      session === undefined || session.closed || !session.ctx.hasUI ? undefined : session.ctx.ui,
    // Only the busy state changed: the tab is drawn again from the data it holds, with no command run.
    repaint: () => {
      const current = session;
      if (current === undefined || current.closed || current.dock.detail?.id !== "activity") return;
      if (current.dock.selected !== "activity") return;
      const details = activityPanel.view();
      if (details === undefined) return;
      current.dock.detail = details;
      current.nativePanes?.refresh();
    },
  });

  function runtimeState(current: Session): RuntimeState {
    if (current.runtimeAlive === true) return "running";
    if (current.started?.running === true) return "starting";
    if (current.runtimeAlive === undefined) return "unknown";
    return "idle";
  }

  // `compact`: the status of the console is in the right sidebar, so the bar leaves it out (view.ts). `powerline`: the
  // folder line is drawn as segments with these git counts; absent, it is the plain line.
  function facts(
    current: Session,
    statuses: readonly string[],
    branch: string | null,
    compact: boolean,
    powerline?: BarFacts["powerline"],
  ): BarFacts {
    const model = current.model;
    const usage =
      model === undefined ? undefined : safely(() => current.ctx.getContextUsage(), undefined);
    const logFailures = chatLog.status().failed;
    return {
      place: current.project?.slug ?? folderName(current.cwd),
      model: model?.id,
      level: modelLevelOf(current).level,
      contextPercent: usage === undefined ? undefined : usage.percent,
      cost: current.cost,
      pending: current.pendingAvailable ? current.pending.length : undefined,
      runtime: runtimeState(current),
      cwd: current.cwd,
      branch,
      statuses,
      mode: modeLabel(modes.mode()),
      logFailures,
      // The same list the sidebar shows under AVISOS, so the count in the bar is the number written there.
      warnings: railWarnings({
        providerWarnings: current.providerWarnings,
        packageWarnings: updateWarning(current.packageUpdates, current.locale),
        data: current.dashboardData,
        logFailures,
      }).length,
      compact,
      powerline,
      areas: barAreas(current.area),
    };
  }

  // What the panes need to know about the terminal and the dock: whether they are drawn at all, and where the status
  // of the console is shown. The header, the bar and the panes all decide with these two rules (native-panes.ts).
  function paneLayout(current: Session, tui: ConsoleTui) {
    const drawn = {
      attached: current.nativePanes?.attached === true,
      columns: tui.terminal.columns,
      rows: tui.terminal.rows,
    };
    return {
      panesShown: panesShown({
        ...drawn,
        leftVisible: current.dock.leftVisible,
        rightVisible: current.dock.rightVisible,
      }),
      statusInSidebar: statusInSidebar({
        ...drawn,
        rightVisible: current.dock.rightVisible,
        selected: current.dock.selected,
      }),
    };
  }

  // The model and its level as the bar and the headers show them: "<model> · <level>", "<model> · no reasoning" or
  // "no model selected".
  function modelLevelOf(current: Session): { level: string | undefined; text: string } {
    const model = current.model;
    const level = levelLabel(
      model,
      model?.reasoning === true ? safely(() => pi.getThinkingLevel(), undefined) : undefined,
    );
    return {
      level,
      text: model === undefined ? "no model selected" : `${model.id} · ${level ?? "unknown"}`,
    };
  }

  function loadedContextFiles(current: Session): readonly string[] {
    return contextFiles(
      safely(() => current.ctx.getSystemPromptOptions?.().contextFiles, undefined),
      current.cwd,
      process.env.PI_CODING_AGENT_DIR,
    );
  }

  // The skills and MCP servers of the TOOLS tab: what Pi reports now and what its mcp.json files say. Never throws.
  function loadedCatalog(current: Session | undefined): Catalog {
    return buildCatalog({
      commands: safely(() => pi.getCommands(), []),
      tools: safely(() => pi.getAllTools(), []),
      registered: safely(() => pi.getMcpServers(), []),
      promptSkills: safely(() => current?.ctx.getSystemPromptOptions?.().skills, undefined),
      agentDir: process.env.PI_CODING_AGENT_DIR,
      cwd: current?.cwd ?? process.cwd(),
    });
  }

  function loadedExtensions(): ExtensionEntry[] {
    return extensionInventory(
      [...safely(() => pi.getCommands(), []), ...safely(() => pi.getAllTools(), [])],
      declaredPackages(readAgentSettings(process.env.PI_CODING_AGENT_DIR)),
    );
  }

  function dashboardFacts(current: Session): DashboardFacts {
    const usage =
      current.model === undefined
        ? undefined
        : safely(() => current.ctx.getContextUsage(), undefined);
    const allTools = safely(() => pi.getAllTools(), []);
    const active = new Set(safely(() => pi.getActiveTools(), []));
    const commands = safely(() => pi.getCommands(), []);
    const servers = safely(() => pi.getMcpServers(), []);
    return {
      locale: current.locale,
      project: current.project?.slug ?? folderName(current.cwd),
      cwd: current.cwd,
      branch: current.branch,
      modelLevel: modelLevelOf(current).text,
      providers: [
        ...new Set(
          safely(() => current.ctx.modelRegistry.getAll(), []).map((model) => model.provider),
        ),
      ].sort(),
      runtime: runtimeState(current),
      runtimeAvailable: current.runtimeStatusAvailable && current.dashboardData.runtimeAvailable,
      pending: current.pendingAvailable ? current.pending.length : undefined,
      context:
        usage === undefined
          ? "unavailable"
          : `${usage.percent === null ? "?" : Math.round(usage.percent)}%`,
      cost: `$${current.cost.toFixed(3)}`,
      activeTools: [...active],
      tools: allTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        active: active.has(tool.name),
      })),
      commands: commands.map((command) => command.name).sort(),
      mcpServers: servers.map((server) => server.name).sort(),
      extensionStatuses: current.extensionStatuses,
      providerWarnings: current.providerWarnings,
      mode: modeLabel(modes.mode()),
      logFailures: chatLog.status().failed,
      memory: current.dashboardData.memorySummary,
      version: process.env[VERSION_ENV],
      contextFiles: loadedContextFiles(current),
      packageWarnings: updateWarning(current.packageUpdates, current.locale),
      data: current.dashboardData,
      loading: current.dashboardLoading,
      orchestration: current.orchestration,
      asciiGlyphs: orchestrationGlyphs() === ASCII_GLYPHS,
    };
  }

  // ■ STOP ALL (3.14.6, P20): the bar button, Alt+X and the ORCHESTRATION "Stop all" outside demo. No confirmation:
  // it aborts the chat turn, then runs haril stop --now and reports what the CLI says. A second press while one runs
  // aborts the chat again and says the stop is under way.
  let stopping = false;
  async function runStopAll(ctx: ConsoleContext): Promise<void> {
    if (stopping) {
      safely(() => ctx.abort(), undefined);
      if (ctx.hasUI) ctx.ui.notify("STOP ALL is already under way", "warning");
      return;
    }
    stopping = true;
    if (ctx.hasUI) ctx.ui.notify("STOP ALL: stopping every agent…", "warning");
    try {
      const outcome = await stopAll({
        abort: () => ctx.abort(),
        cliAvailable,
        run: (args, options) => runHaril(args, { cwd: session?.cwd, timeoutMs: options.timeoutMs }),
      });
      if (ctx.hasUI) ctx.ui.notify(outcome.message, outcome.level);
    } finally {
      stopping = false;
      if (session !== undefined && cliAvailable()) void session.refresh();
    }
  }

  function orchestrate(current: Session, action: OrchestrationAction): void {
    current.orchestration = reduceOrchestration(current.orchestration, action).state;
  }

  // The live view's tail runs only while the full view shows a real agent live; anything else ends it.
  function syncLive(current: Session): void {
    const state = current.orchestration;
    const snapshot = state.snapshot;
    const node =
      current.orchestrationOpen && state.screen === "live" && !state.demo && snapshot !== undefined
        ? selectedNode(state)
        : undefined;
    current.feed.follow(
      node === undefined || snapshot === undefined
        ? undefined
        : { workflowId: snapshot.workflow.id, nodeId: node.id },
    );
  }

  async function refreshDashboard(current: Session): Promise<void> {
    if (current.dashboardRefresh !== undefined) return current.dashboardRefresh;
    current.dashboardLoading = true;
    redraw();
    current.dashboardRefresh = loadDashboardData(current.project?.slug)
      .then((data) => {
        if (!current.closed && current.project?.slug === data.projectSlug) {
          if (data.approvalsAvailable) {
            current.pending = data.approvals;
            current.pendingAvailable = true;
            current.dashboardData = data;
          } else {
            current.dashboardData = { ...data, approvals: current.pending };
          }
        }
      })
      .finally(() => {
        current.dashboardLoading = false;
        current.dashboardRefresh = undefined;
        redraw();
      });
    return current.dashboardRefresh;
  }

  function openDashboardAction(current: Session, action: DashboardAction): void {
    void runDashboardAction(action, current.ctx, pi, current);
  }

  // The light timer runs only while there is something to follow, and never keeps Pi alive. A real workflow on screen
  // (the ORCHESTRATION panel or the full view) is something to follow: its relative times move with the timer.
  function followTimer(current: Session): void {
    const busy = current.runtimeAlive === true || current.started?.running === true;
    const watching =
      (current.area === "orchestration" || current.orchestrationOpen) &&
      current.orchestration.real !== undefined;
    const wanted = !current.closed && (busy || watching || current.pending.length > 0);
    if (wanted && current.timer === undefined) {
      current.timer = setInterval(() => void current.refresh(), REFRESH_MS);
      current.timer.unref();
    } else if (!wanted && current.timer !== undefined) {
      clearInterval(current.timer);
      current.timer = undefined;
    }
  }

  function openSession(ctx: ConsoleContext): Session {
    const current: Session = {
      ctx,
      locale: DEFAULT_UI_LOCALE,
      cwd: ctx.cwd,
      project: undefined,
      pending: [],
      pendingAvailable: false,
      started: undefined,
      tui: undefined,
      nativePanes: undefined,
      dock: initialPaneSettings(),
      dockLoadSeq: 0,
      dockLoading: undefined,
      area: undefined,
      branch: undefined,
      extensionStatuses: [],
      providerWarnings: [],
      packageUpdates: [],
      railVisible: true,
      railExpanded: {},
      model: ctx.model,
      registration: undefined,
      levels: createLevelMemory(pi, () => current.registration?.defaultLevels ?? new Map()),
      cost: safely(() => sessionCost(ctx.sessionManager.getEntries()), 0),
      runtimeAlive: undefined,
      runtimeStatusAvailable: false,
      timer: undefined,
      refreshing: undefined,
      refreshAgain: false,
      dashboardData: emptyDashboardData(),
      dashboardLoading: false,
      dashboardRefresh: undefined,
      orchestration: initialOrchestrationState(),
      orchestrationOpen: false,
      feed: createWorkflowFeed({
        cwd: () => current.cwd,
        projectSlug: () => current.project?.slug,
        onWorkflows: (rows) => {
          orchestrate(current, { type: "workflows", rows });
          redraw();
        },
        onSnapshot: (snapshot) => {
          orchestrate(current, { type: "real-snapshot", snapshot, now: Date.now() });
          syncLive(current);
          // A real workflow on screen keeps the light timer running, so its relative times move.
          followTimer(current);
          redraw();
        },
        onTail: (nodeId, lines) => {
          orchestrate(current, { type: "tail", nodeId, lines });
          redraw();
        },
        onTailReset: (nodeId) => {
          orchestrate(current, { type: "tail-reset", nodeId });
          redraw();
        },
        onTailEnded: (nodeId) => {
          orchestrate(current, { type: "tail-ended", nodeId });
          redraw();
        },
      }),
      orchestrationDemo: () => current.orchestration.demo,
      toggleOrchestrationDemo() {
        current.orchestration = reduceOrchestration(current.orchestration, {
          type: "toggle-demo",
          now: Date.now(),
        }).state;
        redraw();
        return current.orchestration.demo;
      },
      async openOrchestrationView(viewCtx) {
        if (!viewCtx.hasUI || viewCtx.mode !== "tui") {
          if (viewCtx.hasUI)
            viewCtx.ui.notify("The orchestration view needs the interactive console.", "warning");
          return;
        }
        if (current.orchestrationOpen) return;
        current.orchestrationOpen = true;
        if (cliAvailable()) void current.feed.refresh();
        let effect: Awaited<ReturnType<typeof openOrchestrationOverlay>>;
        try {
          effect = await openOrchestrationOverlay(viewCtx, {
            get: () => current.orchestration,
            set: (state) => {
              current.orchestration = state;
              syncLive(current);
            },
            glyphs: orchestrationGlyphs(),
          });
          current.orchestration = { ...current.orchestration, screen: "workflow" };
        } finally {
          current.orchestrationOpen = false;
          syncLive(current);
          redraw();
        }
        // STOP ALL runs once the overlay is gone, so its report is seen; the workflow choice too, then the view
        // opens again on the chosen workflow.
        if (effect === "emergency-stop") await runStopAll(viewCtx);
        else if (effect === "pick-workflow" && (await current.pickWorkflow(viewCtx)))
          await current.openOrchestrationView(viewCtx);
      },
      async pickWorkflow(pickCtx) {
        if (!cliAvailable()) {
          if (pickCtx.hasUI) pickCtx.ui.notify(NOT_LAUNCHED, "error");
          return false;
        }
        await current.feed.refresh();
        const rows = current.orchestration.workflows;
        if (rows.length === 0) {
          pickCtx.ui.notify(EMPTY_MESSAGE, "info");
          return false;
        }
        const labels = rows.map(
          (row) =>
            `${plainText(row.id)} · ${plainText(row.state)}${row.stopReason === null ? "" : ` (${clipText(plainText(row.stopReason), 60)})`} · ${clipText(plainText(row.goal), 60)}`,
        );
        const choice = await pickCtx.ui.select("Follow which workflow?", labels);
        const row = rows[labels.indexOf(choice ?? "")];
        if (row === undefined) return false;
        // The real workflow is what the user asked for: the demo's sample data steps aside.
        if (current.orchestration.demo)
          orchestrate(current, { type: "toggle-demo", now: Date.now() });
        await current.feed.pick(row.id);
        redraw();
        return true;
      },
      closed: false,
      mode: () => modes.mode(),
      switchMode(mode, modeCtx) {
        modes.switchTo(mode, modeCtx);
      },
      lastPlan: () => modes.lastPlan(),
      savePlan: (title, content) => modes.savePlan(title, content),
      recordOrder(text) {
        if (cliAvailable()) chatLog.order(text, modes.mode());
      },
      harilModelRef: () => harilRef(current.model, current.registration),
      harilModels: () => {
        const refs = safely(() => ctx.modelRegistry.getAvailable(), []).flatMap((model) => {
          const ref = harilRef(model, current.registration);
          return ref === undefined ? [] : [ref];
        });
        return [...new Set(refs)].sort();
      },
      modelRef: () => harilRef(current.model, current.registration),
      runtime: () => runtimeState(current),
      runtimeAvailable: () =>
        current.runtimeStatusAvailable && current.dashboardData.runtimeAvailable,
      tools: () => {
        const active = new Set(safely(() => pi.getActiveTools(), []));
        return safely(() => pi.getAllTools(), []).map((tool) => ({
          name: tool.name,
          active: active.has(tool.name),
        }));
      },
      tasks: () => current.dashboardData.tasks,
      approvals: () => current.dashboardData.approvals,
      approvalsAvailable: () => current.dashboardData.approvalsAvailable,
      events: () => current.dashboardData.events,
      methodologies: () => current.dashboardData.methodologies,
      methodologyEntries: () => current.dashboardData.methodologyEntries,
      methodologiesAvailable: () => current.dashboardData.methodologiesAvailable,
      methodologyError: () =>
        current.dashboardData.errors.find((error) => error.startsWith("Methodologies:")),
      memorySummary: () => current.dashboardData.memorySummary,
      details: () => dashboardDetails(current, current.area ?? "everywhere"),
      reload: () => refreshDashboard(current),
      refreshStatus: () => current.refresh(),
      output: (title, lines) => current.showOutput(title, lines),
      openActions: (actionCtx) => openDashboardActionMenu(actionCtx, pi, current),
      showOutput(title, lines) {
        if (!ctx.hasUI) return;
        if (ctx.mode !== "tui") {
          ctx.ui.notify([title, ...lines].join("\n"), "info");
          return;
        }
        ctx.ui.setWidget(OUTPUT_WIDGET, (_tui, theme) => ({
          render: (width) => renderOutput(title, lines, width, theme),
          invalidate() {},
        }));
      },
      clearOutput() {
        if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(OUTPUT_WIDGET, undefined);
      },
      openArea(area) {
        current.area = area;
        // ORCHESTRATION follows the project's real workflow (haril workflow list and watch).
        if (area === "orchestration" && cliAvailable()) void current.feed.refresh();
        if (!ctx.hasUI || ctx.mode !== "tui") return;
        if (
          current.dashboardData.projectSlug !== current.project?.slug ||
          current.dashboardData.loadedAt === undefined ||
          Date.now() - current.dashboardData.loadedAt > 15_000
        ) {
          void refreshDashboard(current);
        }
        // Pi stacks widgets vertically. Hide the huge central module widget:
        // the area is summarized in the right rail and can be focused with Alt+F.
        ctx.ui.setWidget("haril-dashboard", undefined);
        redraw();
      },
      async rebind() {
        const [project, configuredLocale, configuredTheme] = await Promise.all([
          findProject(current.cwd),
          runHarilJson(["config", "get", "ui.locale", "--json"], { timeoutMs: 10_000 }),
          runHarilJson(["config", "get", "ui.theme", "--json"], { timeoutMs: 10_000 }),
        ]);
        if (current.closed) return;
        current.project = project;
        current.locale = readConsoleLocale(configuredLocale);
        setHarilPalette(
          typeof configuredTheme === "object" &&
            configuredTheme !== null &&
            "value" in configuredTheme
            ? configuredTheme.value
            : undefined,
        );
        current.runtimeStatusAvailable = false;
        current.dashboardData = emptyDashboardData(current.project?.slug);
        if (current.area !== undefined) {
          await current.dashboardRefresh;
          await refreshDashboard(current);
        }
        redraw();
      },
      refresh() {
        // One read at a time: a refresh asked for meanwhile joins the running one, which then reads again.
        if (current.refreshing !== undefined) {
          current.refreshAgain = true;
          return current.refreshing;
        }
        current.refreshing = (async () => {
          do {
            current.refreshAgain = false;
            const status = await readStatus(current.project?.slug);
            if (current.closed) return;
            current.runtimeAlive = status.runtimeAlive;
            current.runtimeStatusAvailable = status.runtimeAlive !== undefined;
            current.pendingAvailable = status.pending !== undefined;
            if (status.pending !== undefined) current.pending = status.pending;
          } while (current.refreshAgain);
          // A workflow started elsewhere (another terminal) is found while ORCHESTRATION shows, and the real view's
          // relative times move on even when no snapshot came.
          if (current.area === "orchestration" || current.orchestrationOpen) {
            orchestrate(current, { type: "tick", now: Date.now() });
            void current.feed.refresh();
          }
          followTimer(current);
          redraw();
        })().finally(() => {
          current.refreshing = undefined;
        });
        return current.refreshing;
      },
    };
    return current;
  }

  function installUi(current: Session): void {
    const { ctx } = current;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const version = process.env[VERSION_ENV];
    let headerLayout: ReturnType<typeof renderHeaderLayout> = { lines: [], tabHits: [] };
    ctx.ui.setHeader((tui, theme) => ({
      render(width) {
        // With the panes available the panel or the bar says everything: the chat starts clean, panel open or closed.
        if (
          panesFit({
            attached: current.nativePanes?.attached === true,
            columns: tui.terminal.columns,
            rows: tui.terminal.rows,
          })
        ) {
          headerLayout = { lines: [], tabHits: [] };
          // The panel draws the small logo while it is open; closed, it opens the chat instead.
          return current.dock.rightVisible
            ? []
            : miniLogo(width, { ascii: orchestrationGlyphs() === ASCII_GLYPHS });
        }
        headerLayout = renderHeaderLayout(
          version === "" ? undefined : version,
          width,
          dashboardFacts(current),
          current.area,
          theme,
          tui.terminal.rows,
          current.railVisible,
          current.railExpanded,
        );
        return headerLayout.lines;
      },
      handleMouse(event: ConsoleMouseEvent) {
        if (event.type !== "click" || event.button !== "left") return undefined;
        const hit = headerLayout.tabHits.find(
          (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
        );
        if (hit !== undefined) {
          current.openArea(hit.area);
          return { handled: true, render: true };
        }
        const rail = headerLayout.railHits?.find(
          (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
        );
        if (rail === undefined) return undefined;
        runRail(current, rail);
        return { handled: true, render: true };
      },
      invalidate() {},
    }));
    ctx.ui.setFooter((tui, theme, footerData) => {
      current.tui = tui;
      mountNativePanes(current, tui);
      // The git counts of the folder line come from a cache that reads in the background: the render below only asks it,
      // and a read that ends with new counts asks Pi to draw the footer again. A new branch makes the counts old.
      const gitSummary = createGitSummaryCache({
        ...(options.git?.read === undefined ? {} : { read: options.git.read }),
        onChange: () => tui.requestRender(),
      });
      const unsubscribeBranch = footerData.onBranchChange(() => {
        gitSummary.invalidate();
        tui.requestRender();
      });
      let bar: BarLayout = { lines: [], hits: [] };
      return {
        render(width) {
          const statuses = [...footerData.getExtensionStatuses().values()];
          current.branch = footerData.getGitBranch();
          current.extensionStatuses = statuses;
          // Nothing when the sidebar holds the status (open, on MAIN), the bar anywhere else. Nothing here is cached:
          // Alt+I and a tab change both ask Pi for a new frame, and this runs again with the new state.
          const compact = paneLayout(current, tui).statusInSidebar;
          const branch = current.branch;
          // Git is asked about only when the folder line is drawn as segments (not compact, not HARIL_POWERLINE=off) and
          // the folder is a repository (Pi knows a branch).
          const powerline = !compact && powerlineEnabled();
          bar = renderBarLayout(
            facts(
              current,
              statuses,
              branch,
              compact,
              powerline
                ? { git: branch === null ? undefined : gitSummary.peek(current.cwd) }
                : undefined,
            ),
            width,
            theme,
          );
          return bar.lines;
        },
        handleMouse(event: ConsoleMouseEvent) {
          if (event.type !== "click" || event.button !== "left") return undefined;
          // The model and the level in the bar open their selectors.
          const barHit = bar.hits.find(
            (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
          );
          if (barHit !== undefined) {
            if (barHit.target === "model") void chooseModel(current.ctx, pi);
            else if (barHit.target === "mode") void chooseMode(current, current.ctx);
            else if (barHit.target === "stop") void runStopAll(current.ctx);
            else if (barHit.target === "area") {
              const area = DASHBOARD_AREAS.find((item) => item === barHit.area);
              if (area !== undefined) current.openArea(area);
            } else void chooseLevel(current.ctx, pi, current.levels);
            return { handled: true, render: true };
          }
          return undefined;
        },
        invalidate() {},
        dispose() {
          unsubscribeBranch();
          gitSummary.dispose();
        },
      };
    });
    // A zero-row widget gives access to Pi's live TUI after its layout root is ready. It does not push the editor,
    // consume transcript rows, or create an output panel. Footer mounting above is a second safe attempt.
    ctx.ui.setWidget("haril-native-panes-anchor", (tui) => {
      mountNativePanes(current, tui);
      return { render: () => [], invalidate() {} };
    });
  }

  // The right rail's rows and the action of each: the native pane draws them (as cards) and the keyboard menu lists
  // them (from the flat rows its labels are read from). The actions of the chosen area are the ACC tab's, so only the
  // keyboard menu asks for them here.
  function railContent(
    current: Session,
    width: number,
    options: { readonly actions?: boolean; readonly cards?: boolean } = {},
  ): NativeRailContent {
    return renderNativeRailContent(
      dashboardFacts(current),
      current.area,
      width,
      current.railExpanded,
      options,
    );
  }

  // What the ACC tab is made of: the area chosen in MAIN and its controls, read from the same facts MAIN draws.
  function actionsInput(current: Session) {
    return {
      area: railArea(current.area),
      controls: railControls(dashboardFacts(current), current.area),
      locale: current.locale,
    };
  }

  function mountNativePanes(current: Session, tui: ConsoleTui): void {
    if (current.closed || current.nativePanes?.attached) return;
    const mounted = attachNativePanes(tui, current.dock, {
      project: () => current.cwd,
      effortLevel: () => modelLevelOf(current).level,
      locale: () => current.locale,
      ascii: () => orchestrationGlyphs() === ASCII_GLYPHS,
      right: (width) => railContent(current, width, { cards: true }),
      select(id) {
        void openDockSlot(current, id);
      },
      // A click on a row a view declared an action for (DockDetails.actions); DOCS is the one that declares them.
      activate(id, action) {
        void runDockAction(current, id, action);
      },
      railAction: (hit) => runRail(current, hit),
      // ACC follows the area chosen in MAIN's list, so it is made again before every frame and every click.
      live: (id) => (id === "actions" ? actionsDetails(actionsInput(current)) : undefined),
    });
    if (mounted.attached) {
      current.nativePanes = mounted;
      // The footer keeps this up to date; the panes need it before the first footer frame (the keyboard menu asks).
      current.tui = tui;
    }
  }

  async function reloadDockSlots(current: Session): Promise<void> {
    if (!cliAvailable()) return;
    const config = await runHarilJson(["config", "get", "ui.plugins", "--json"], {
      timeoutMs: 10_000,
    });
    if (current.closed) return;
    current.dock.slots = readDockSlots(config);
    if (!current.dock.slots.some((slot) => slot.visible && slot.id === current.dock.selected)) {
      current.dock.selected = current.dock.slots.find((slot) => slot.visible)?.id ?? MAIN_DOCK_ID;
    }
    if (
      current.dock.detail?.id !== current.dock.selected &&
      current.dockLoading !== current.dock.selected
    )
      void openDockSlot(current, current.dock.selected);
    current.nativePanes?.refresh();
  }

  async function openDockSlot(current: Session, id: PaneSettings["selected"]): Promise<void> {
    if (!current.dock.slots.some((slot) => slot.id === id && slot.visible)) {
      current.ctx.ui.notify("Ese espacio está oculto. Muéstralo con /haril-plugins.", "warning");
      return;
    }
    const seq = ++current.dockLoadSeq;
    current.dockLoading = id;
    current.dock.selected = id;
    current.dock.detail = undefined;
    redraw();
    const details =
      id === "memory"
        ? await toolsPanel.load()
        : id === "activity"
          ? await activityPanel.load()
          : await loadDockDetails(id, current.cwd, {
              locale: current.locale,
              ...(id === "actions" ? { actions: actionsInput(current) } : {}),
            });
    if (current.dockLoadSeq === seq) current.dockLoading = undefined;
    if (current.closed || session !== current || current.dockLoadSeq !== seq) return;
    current.dock.detail = details;
    current.nativePanes?.refresh();
  }

  async function pickDockSlot(current: Session, ctx: ConsoleContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const result = await ctx.ui.custom<DockPickerResult | undefined>(
      (tui, _theme, _keys, done) =>
        createDockPicker(current.dock.slots, current.dock.selected, done, tui, current.locale),
      { overlay: true },
    );
    if (result?.type !== "open" || current.closed || session !== current) return;
    await openDockSlot(current, result.id);
  }

  // The rows a dock view declares (DockDetails.actions), by the tab they belong to. DOCS's rows connect, change and
  // disconnect the documentation folder; the TOOLS tab's check Engram, look the versions up and update gentle-ai; ACT's choose
  // the range of the events; ACC's are the controls of the area chosen in MAIN, which run through the rail's own path.
  async function runDockAction(current: Session, id: string, action: string): Promise<void> {
    if (id === "memory") {
      await toolsPanel.act(action);
      return;
    }
    if (id === "activity") {
      await activityPanel.act(action);
      return;
    }
    if (id === "actions") {
      // The button's id is read back against the controls of the area as it is now: a click that arrives after the area
      // changed, on a control the new area lacks, runs nothing.
      const hit = actionHit(action, actionsInput(current).controls);
      if (hit === undefined || current.closed) return;
      runRail(current, hit);
      redraw();
      return;
    }
    if (id !== "docs") return;
    if (action === "docs:set") await connectDocsFolder(current, current.ctx);
    else if (action === "docs:clear") await disconnectDocsFolder(current, current.ctx);
  }

  // One docs prompt or save at a time: a second click while the input is open must not open another.
  let docsBusy = false;

  // Connects (or changes) the documentation folder: the path comes from `given` (/haril-docs <path>) or from the input,
  // which proposes the folder that is connected now. HARIL stores the path through `haril config set docs.path`, which
  // refuses what is not an existing directory; the console shows that message as it is. Nothing is written in the folder.
  async function connectDocsFolder(
    current: Session,
    ctx: ConsoleContext,
    given?: string,
  ): Promise<void> {
    if (docsBusy || current.closed) return;
    if (!cliAvailable()) {
      ctx.ui.notify(NOT_LAUNCHED, "warning");
      return;
    }
    docsBusy = true;
    try {
      let typed = given;
      if (typed === undefined) {
        const connected = await readDocsPath(current.cwd).catch(() => undefined);
        if (current.closed || session !== current) return;
        typed = await ctx.ui.input(
          localized(
            current.locale,
            "Documentation folder path",
            "Ruta de la carpeta de documentación",
          ),
          connected ?? "",
        );
      }
      const value = typed?.trim() ?? "";
      if (value === "" || current.closed || session !== current) return;
      await saveDocsPath(current, ctx, value);
    } finally {
      docsBusy = false;
    }
  }

  // Disconnects the folder (`--reset`): the folder itself is not touched.
  async function disconnectDocsFolder(current: Session, ctx: ConsoleContext): Promise<void> {
    if (docsBusy || current.closed) return;
    if (!cliAvailable()) {
      ctx.ui.notify(NOT_LAUNCHED, "warning");
      return;
    }
    docsBusy = true;
    try {
      await saveDocsPath(current, ctx, undefined);
    } finally {
      docsBusy = false;
    }
  }

  // Runs `haril config set docs.path <value>` (or `--reset` without a value), tells the user how it went with the CLI's
  // own words when it fails, and loads the DOCS tab again when it is the one on screen. Another tab loads fresh when it
  // is selected, so a command typed from there does not pull the user away from it.
  async function saveDocsPath(
    current: Session,
    ctx: ConsoleContext,
    value: string | undefined,
  ): Promise<void> {
    const result = await runHaril(
      value === undefined
        ? ["config", "set", "docs.path", "--reset", "--json"]
        : ["config", "set", "docs.path", value, "--json"],
      { cwd: current.cwd, timeoutMs: 10_000 },
    );
    if (current.closed || session !== current) return;
    if (!result.ok) {
      const reason = result.stderr
        .split(/\r?\n/)
        .map((line) => plainText(line.trimEnd()))
        .filter(Boolean)
        .join("\n");
      ctx.ui.notify(
        reason ||
          localized(
            current.locale,
            "Could not save the documentation folder.",
            "No se pudo guardar la carpeta de documentación.",
          ),
        "error",
      );
      return;
    }
    let stored = value;
    try {
      const written = (JSON.parse(result.stdout) as { value?: unknown }).value;
      if (typeof written === "string" && written !== "") stored = plainText(written);
    } catch {
      // The CLI's answer is only used to show the path it stored; the typed one stands in.
    }
    ctx.ui.notify(
      stored === undefined
        ? localized(
            current.locale,
            "Documentation folder disconnected.",
            "Carpeta de documentación desconectada.",
          )
        : localized(
            current.locale,
            `Documentation folder connected: ${stored}`,
            `Carpeta de documentación conectada: ${stored}`,
          ),
      "info",
    );
    // Not awaited: the tab loads on its own, and the next click on its rows must not wait for the scan.
    if (current.dock.selected === "docs") void openDockSlot(current, "docs");
  }

  async function managePiExtensions(current: Session, ctx: ConsoleContext): Promise<void> {
    if (current.closed || !cliAvailable()) {
      ctx.ui.notify(NOT_LAUNCHED, "warning");
      return;
    }
    const result = await runHaril(["extensions", "list", "--json"], { cwd: current.cwd });
    if (current.closed || session !== current) return;
    if (!result.ok) {
      ctx.ui.notify(result.stderr || "No se pudieron consultar los paquetes Pi", "error");
      return;
    }
    let entries: ReturnType<typeof decodePiExtensionPackages>;
    try {
      entries = decodePiExtensionPackages(JSON.parse(result.stdout) as unknown);
    } catch {
      entries = undefined;
    }
    if (entries === undefined) {
      ctx.ui.notify("HARIL recibió una lista de extensiones no válida", "error");
      return;
    }
    const installChoice = "+ Instalar paquete Pi (npm/GitHub)";
    const choices = [
      installChoice,
      ...entries.map(
        (entry, index) =>
          `${index + 1}. ${plainText(entry.source)} · ${entry.extensions === "enabled" ? "habilitada" : entry.extensions === "disabled" ? "deshabilitada" : "filtrada"}`,
      ),
    ];
    const selected = await ctx.ui.select("Paquetes declarados en el Pi privado de HARIL", choices);
    if (!selected || session !== current || current.closed) return;
    if (selected === installChoice) {
      const source = (
        await ctx.ui.input(
          "Origen Pi (npm:paquete o git:github.com/usuario/repositorio)",
          "git:github.com/CinloDev/pi-youtube-player",
        )
      )?.trim();
      if (!source || session !== current || current.closed) return;
      if (
        !(await ctx.ui.confirm(
          "Instalar código de terceros",
          `Pi descargará e instalará ${plainText(source)} en el agente privado de HARIL. Sus extensiones pueden ejecutar código con los permisos de tu usuario. ¿Has revisado el repositorio y quieres continuar?`,
        ))
      ) {
        return;
      }
      if (session !== current || current.closed) return;
      ctx.ui.notify("Instalando paquete Pi; puede tardar hasta dos minutos…", "info");
      const installed = await runHaril(["extensions", "install", source, "--yes"], {
        cwd: current.cwd,
        timeoutMs: 130_000,
      });
      if (session !== current || current.closed) return;
      ctx.ui.notify(
        installed.ok
          ? "Paquete instalado en el Pi privado de HARIL. Reinicia HARIL para cargarlo."
          : installed.stderr || "Pi no pudo instalar el paquete",
        installed.ok ? "info" : "error",
      );
      return;
    }
    const chosen = entries[choices.indexOf(selected) - 1];
    if (!chosen) return;
    const actions = [
      "Ver información",
      "Habilitar extensiones",
      "Deshabilitar extensiones",
      "Desinstalar paquete",
    ];
    const action = await ctx.ui.select(plainText(chosen.source), actions);
    if (!action || session !== current || current.closed) return;
    if (action === "Ver información") {
      await showInlineDetails(ctx, plainText(chosen.source), [
        extensionStatusText(chosen.extensions),
        "Estado real de instalación o carga: desconocido en esta sesión.",
        "La visibilidad del dock se administra por separado con /haril-plugins.",
        "Los cambios requieren reiniciar HARIL para que Pi los cargue.",
      ]);
      return;
    }
    if (action === "Desinstalar paquete") {
      if (
        !(await ctx.ui.confirm(
          "Eliminar paquete Pi",
          `¿Eliminar ${plainText(chosen.source)} del agente privado de HARIL? Esta operación quita su paquete y recursos; reinicia HARIL después.`,
        ))
      ) {
        return;
      }
      if (session !== current || current.closed) return;
      const removed = await runHaril(["extensions", "remove", chosen.source, "--yes"], {
        cwd: current.cwd,
        timeoutMs: 130_000,
      });
      if (session !== current || current.closed) return;
      ctx.ui.notify(
        removed.ok
          ? "Paquete retirado. Reinicia HARIL para aplicar los cambios."
          : removed.stderr || "Pi no pudo retirar el paquete",
        removed.ok ? "info" : "error",
      );
      return;
    }
    if (chosen.extensions === "filtered") {
      ctx.ui.notify(
        "Ese paquete tiene filtros propios; usa pi config para conservarlos.",
        "warning",
      );
      return;
    }
    const enable = action === "Habilitar extensiones";
    if (
      !(await ctx.ui.confirm(
        "Confirmar cambio Pi",
        `${enable ? "Habilitar" : "Deshabilitar"} extensiones de ${plainText(chosen.source)} para el próximo arranque de HARIL?`,
      ))
    ) {
      return;
    }
    if (session !== current || current.closed) return;
    const updated = await runHaril(
      ["extensions", enable ? "enable" : "disable", chosen.source, "--yes"],
      { cwd: current.cwd },
    );
    if (session !== current || current.closed) return;
    ctx.ui.notify(
      updated.ok
        ? "Preferencia Pi guardada. Reinicia HARIL para aplicar el cambio; el dock visible es independiente."
        : updated.stderr || "No se pudo guardar la preferencia Pi",
      updated.ok ? "info" : "error",
    );
  }

  function dashboardDetails(
    current: Session,
    area: DashboardArea,
  ): { title: string; lines: string[] } {
    const data = current.dashboardData;
    const facts = dashboardFacts(current);
    const lines: string[] = [];
    const knownWarnings = [
      ...new Set([
        ...current.providerWarnings,
        ...data.errors,
        ...(chatLog.status().failed > 0
          ? [`Activity log: ${chatLog.status().failed} failed record(s)`]
          : []),
      ]),
    ];
    if (knownWarnings.length > 0)
      lines.push("HARIL WARNINGS", ...knownWarnings.map((warning) => `! ${warning}`), "");
    lines.push(
      "PI EXTENSION STATUS REPORTS",
      ...(facts.extensionStatuses.length
        ? facts.extensionStatuses
        : ["Pi reports no extension statuses; this is not a list of installed packages."]),
      "",
    );
    switch (area) {
      case "agents":
        lines.push(`Pi model: ${facts.modelLevel}`, "Observed agents in task records:");
        lines.push(
          ...(data.tasks.length
            ? data.tasks.map(
                (task) => `${task.agent} · ${task.state} · ${task.taskId} · ${task.goal}`,
              )
            : ["No task agent records."]),
        );
        lines.push("A separate HARIL agent-profile registry is not available.");
        break;
      case "orchestration":
        lines.push(
          "PENDING APPROVALS",
          ...(data.approvalsAvailable && data.approvals.length
            ? data.approvals.map(
                (row) => `${row.approvalId} · ${row.tasks} tasks · ${row.model ?? "no model"}`,
              )
            : [
                data.approvalsAvailable
                  ? "No pending approvals."
                  : "Approval list unavailable; refresh before treating it as empty.",
              ]),
          "PROJECT TASKS",
        );
        lines.push(
          ...(data.tasks.length
            ? data.tasks.map(
                (task) => `${task.taskId} · ${task.state} · ${task.agent} · ${task.goal}`,
              )
            : ["No task records."]),
          "QUEUED COMMANDS",
          ...(data.queued.length ? data.queued : ["No queued commands reported."]),
          "EVENTS",
        );
        lines.push(
          ...(data.events.length
            ? data.events.map(
                (event) =>
                  `#${event.seq} ${event.time} · ${event.type} · ${event.aggregateType}:${event.aggregateId}`,
              )
            : ["No events reported."]),
        );
        break;
      case "automation":
        lines.push(
          data.projectSlug === undefined
            ? "No project is bound to this folder; register it before queue or runtime actions."
            : `Project: ${facts.project}`,
          `Runtime: ${facts.runtime}`,
          current.runtimeStatusAvailable && data.runtimeAvailable
            ? "Runtime lease status is represented by valid HARIL status JSON."
            : (data.errors.find((error) => error.startsWith("Project status:")) ??
                "Runtime lease status has not been confirmed; refresh to retry."),
          "Queued project work:",
          ...(data.projectSlug === undefined
            ? ["Unavailable until a project is registered."]
            : data.queued.length
              ? data.queued
              : ["No queued commands reported."]),
          "No scheduled automation registry or scheduler API is available.",
        );
        break;
      case "tools":
        lines.push(
          "PI TOOLS",
          ...(facts.tools.length
            ? facts.tools.map(
                (tool) =>
                  `${tool.active ? "ACTIVE" : "OFF"} · ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`,
              )
            : ["Pi reports no configured tools."]),
          "GLOBAL HARIL METHODOLOGIES",
          ...(!data.methodologiesAvailable
            ? [
                data.errors.find((error) => error.startsWith("Methodologies:")) ??
                  "Registry unavailable; refresh to retry.",
              ]
            : data.methodologyEntries.length
              ? data.methodologyEntries.map(
                  (entry) => `${entry.id} · v${entry.version} · ${entry.summary}`,
                )
              : ["The local registry returned no methodologies; this CLI has no import command."]),
          "Select Browse methodologies to read a complete bundled definition.",
          "Task add accepts no methodology selector; browsing does not execute the definition.",
          "PI COMMANDS REPORTED",
        );
        lines.push(
          ...(facts.commands.length
            ? facts.commands.map((command) => `/${command}`)
            : ["No command list available."]),
          "Native Pi slash commands remain separate and available.",
          "DELEGATION SETTINGS (haril.json; change them with Delegation settings or /delegation)",
          ...(data.delegation === undefined
            ? [data.delegationError ?? "Not loaded yet; refresh to read them."]
            : data.delegation.fields.map(
                (field) =>
                  `${field.path} = ${valueText(field)} · ${sourceText(field)} · ${effectText(field)}`,
              )),
        );
        break;
      case "everywhere": {
        const log = chatLog.status();
        lines.push(
          `Project: ${facts.project}`,
          `Workspace: ${facts.cwd}`,
          `Git: ${facts.branch === undefined ? "unavailable" : (facts.branch ?? "not a Git repository")}`,
          `Session: ${facts.modelLevel} · context ${facts.context} · cost ${facts.cost}`,
          `Providers (${facts.providers.length}):`,
          ...(facts.providers.length ? facts.providers : ["None reported"]),
          `Memory: ${facts.memory}`,
          `MCP servers (${facts.mcpServers.length}):`,
          ...(facts.mcpServers.length ? facts.mcpServers : ["None reported"]),
          `Runtime: ${facts.runtime} · pending approvals: ${facts.pending === undefined ? "unavailable" : facts.pending}`,
          `Mode: ${modeLabel(modes.mode())}`,
          !cliAvailable()
            ? "Usage log: off (this Pi was not opened by haril)"
            : `Usage log: ${log.recorded} rows recorded this session${log.failed === 0 ? "" : `, ${log.failed} failed (last: ${log.lastError ?? "unknown"})`}`,
        );
        break;
      }
    }
    return { title: `${area.toUpperCase()} details · ${facts.project}`, lines };
  }

  // HARIL's models join Pi's catalog once `haril models` answers; the bar and /goal follow. On a start, Pi chose its
  // model before they existed, so a saved HARIL default is put back.
  async function loadModels(current: Session, reason: string): Promise<void> {
    const registration = await registerHarilModels(pi, current.ctx);
    if (current.closed) return;
    current.registration = registration;
    current.providerWarnings = registration.notes;
    if (current.ctx.hasUI && (reason === "startup" || reason === "reload")) {
      for (const note of registration.notes) current.ctx.ui.notify(note, "warning");
    }
    if (reason === "startup") {
      const restored = await restoreHarilModel(pi, current.ctx, registration, current.model);
      if (restored !== undefined && !current.closed) current.model = restored;
    }
    redraw();
  }

  function focusRightRail(current: Session): void {
    if (current.area === "orchestration") void current.openOrchestrationView(current.ctx);
    else openDashboardAction(current, "details");
  }

  // A rail row means the same thing wherever it is drawn: the classic header and the native right pane both land here.
  function runRail(current: Session, hit: RailHitAction): void {
    runRailHit(
      {
        railExpanded: current.railExpanded,
        redraw,
        runControl: (control) => openDashboardAction(current, control),
        chooseMode: () => void chooseMode(current, current.ctx),
        chooseModel: () => void chooseModel(current.ctx, pi),
        chooseLevel: () => void chooseLevel(current.ctx, pi, current.levels),
        stopAll: () => void runStopAll(current.ctx),
        openMenu: () => void current.openActions(current.ctx),
        focus: () => focusRightRail(current),
        openArea: (area) => current.openArea(area),
      },
      hit,
    );
  }

  // The rail takes no keyboard focus (Pi hands extension shortcuts to the editor only), so its keyboard path is a menu
  // of what a click on it does. It is built from the same content the pane draws; the pane's own 39 columns would
  // cut the long labels, so the content is rendered wide for it.
  async function openRailMenu(ctx: ConsoleContext): Promise<void> {
    const current = session;
    if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
    // The section of the actions is drawn by the classic header only: the native panes leave the actions to the ACC tab,
    // so an entry that opens or closes it would change nothing on screen. The actions themselves stay in the menu.
    const panesDrawn = current.tui !== undefined && paneLayout(current, current.tui).panesShown;
    const entries = buildRailMenu(
      railContent(current, RAIL_MENU_WIDTH, { actions: true }),
      current.locale,
    ).filter(
      (entry) =>
        !(
          panesDrawn &&
          entry.hit.action === "toggle" &&
          (entry.hit.section === "actions" ||
            entry.hit.section === "extensions" ||
            (entry.hit.section === "warnings" &&
              railWarnings(dashboardFacts(current)).length === 0))
        ),
    );
    const rows = viewMenuRows(current);
    const choice = await ctx.ui.select(localized(current.locale, "Right panel", "Panel derecho"), [
      ...rows.map((row) => row.label),
      ...entries.map((entry) => entry.label),
    ]);
    if (choice === undefined || session !== current || current.closed) return;
    const row = rows.find((item) => item.label === choice);
    if (row !== undefined) {
      // Not awaited: an install can take minutes, and the menu has done its part.
      void runDockAction(current, row.dock, row.action);
      return;
    }
    const entry = entries.find((item) => item.label === choice);
    if (entry !== undefined) runRail(current, entry.hit);
  }

  // The rows the tab on screen declared (DockDetails.actions), as menu choices: "TOOLS · Comprobar e instalar Engram".
  // They come first, since they are what the user is looking at. A tab with no rows, or one that is busy, adds none.
  // ACC adds none either: its buttons are the rail entries the menu lists below them anyway.
  function viewMenuRows(current: Session): { label: string; dock: string; action: string }[] {
    const detail = current.dock.detail;
    if (
      detail === undefined ||
      detail.id !== current.dock.selected ||
      detail.id === "actions" ||
      detail.actions === undefined
    ) {
      return [];
    }
    const tab = DOCK_LABELS.find((slot) => slot.id === detail.id)?.tab ?? detail.id;
    return detail.actions.flatMap(({ line, action, label }) => {
      // The label is carried by the action; a view that declares only the line has its words read from that line.
      const text = label ?? detail.lines[line]?.replace(/^▸\s*/u, "").trim();
      if (text === undefined || text === "") return [];
      return [{ label: `${tab} · ${text}`, dock: detail.id, action }];
    });
  }

  async function changeTheme(current: Session, requested: string): Promise<void> {
    if (!HARIL_PALETTES.some((item) => item === requested)) {
      current.ctx.ui.notify(
        "Paleta desconocida. Usa future, matrix, violet, rose, amber u obsidian.",
        "warning",
      );
      return;
    }
    if (!cliAvailable()) {
      current.ctx.ui.notify("HARIL CLI no disponible para guardar el tema.", "warning");
      return;
    }
    const saved = await runHaril(["config", "set", "ui.theme", requested, "--json"], {
      cwd: current.cwd,
      timeoutMs: 10_000,
    });
    if (current.closed || session !== current) return;
    if (!saved.ok) {
      current.ctx.ui.notify(saved.stderr || "No se pudo guardar la paleta.", "error");
      return;
    }
    setHarilPalette(requested);
    current.ctx.ui.notify(`Tema HARIL: ${requested}`, "info");
    // No dock view lists the palettes any more: repaint the panes and the bar with the new colours.
    current.nativePanes?.refresh();
    redraw();
  }

  pi.registerCommand("haril-theme", {
    description: "HARIL: cambiar paleta Future, Matrix, violeta, rosa, ámbar u obsidiana",
    getArgumentCompletions: (prefix: string) =>
      HARIL_PALETTES.filter((name) => name.startsWith(prefix.trim().toLowerCase())).map((name) => ({
        value: name,
        label: name,
      })),
    async handler(args, ctx) {
      const current = session;
      if (current === undefined) return;
      const input = args.trim().toLowerCase();
      const choice = input || (await ctx.ui.select("Paleta HARIL", [...HARIL_PALETTES]));
      if (choice !== undefined) await changeTheme(current, choice);
    },
  });

  // HARIL-only language switch. Pi's own diagnostics and model text retain their original language.
  pi.registerCommand("language", {
    description: "HARIL: cambiar idioma / change UI language (es, en)",
    getArgumentCompletions: (prefix: string) =>
      [
        { value: "es", label: "es", description: "Español" },
        { value: "en", label: "en", description: "English" },
      ].filter((item) => item.value.startsWith(prefix.trim().toLowerCase())),
    async handler(args, ctx) {
      const current = session;
      if (current === undefined) return;
      const input = args.trim().toLowerCase();
      let choice = input;
      if (choice === "") {
        const picked = await ctx.ui.select(
          current.locale === "es" ? "Idioma de HARIL" : "HARIL language",
          ["Español", "English"],
        );
        if (picked === undefined) return;
        choice = picked === "Español" ? "es" : "en";
      }
      if (choice !== "es" && choice !== "en") {
        ctx.ui.notify("Uso / Usage: /language [es|en]", "warning");
        return;
      }
      if (choice === current.locale) {
        ctx.ui.notify(
          choice === "es" ? "HARIL ya está en español." : "HARIL is already in English.",
          "info",
        );
        return;
      }
      if (!cliAvailable()) {
        ctx.ui.notify(
          choice === "es"
            ? "No se puede guardar el idioma sin el CLI de HARIL."
            : "Cannot save language without the HARIL CLI.",
          "error",
        );
        return;
      }
      const previous = current.locale;
      const result = await runHaril(["config", "set", "ui.locale", choice, "--json"], {
        cwd: current.cwd,
        timeoutMs: 10_000,
      });
      if (!result.ok) {
        ctx.ui.notify(
          choice === "es"
            ? "No se pudo guardar el idioma. La preferencia anterior se mantiene."
            : "Could not save language. The previous preference remains active.",
          "error",
        );
        return;
      }
      current.locale = choice;
      if (current.dock.detail !== undefined) void openDockSlot(current, current.dock.selected);
      redraw();
      ctx.ui.notify(
        choice === "es" ? "Idioma de HARIL: Español" : "HARIL language: English",
        "info",
      );
      if (previous !== choice && current.area !== undefined) current.openArea(current.area);
    },
  });

  registerCommands(pi, () => session);
  // Every command this session has and every shortcut, searched as the user types. Enter puts a command in the editor
  // (the extension API cannot run another extension's command) and runs a shortcut.
  async function showCommandCatalog(ctx: ConsoleContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const entries = catalogEntries(
      safely(() => pi.getCommands(), []),
      harilCommandDescriptions(),
      shortcuts.map(({ key, description, handler }) => ({
        key,
        description,
        run: () => void handler(ctx),
      })),
    );
    const chosen = await ctx.ui.custom<CatalogEntry | undefined>(
      (tui, _theme, _keybindings, done) => createCommandPicker(entries, done, tui),
      { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
    );
    if (chosen === undefined) return;
    if (chosen.kind === "shortcut") chosen.run?.();
    else ctx.ui.setEditorText(`/${chosen.name} `);
  }
  pi.registerCommand("haril-commands", {
    description: "Search every command and shortcut / buscar todos los comandos y atajos",
    handler: async (_args, ctx) => showCommandCatalog(ctx),
  });
  registerShortcut("alt+c", {
    description: "Search every command and shortcut",
    handler: (ctx) => {
      void showCommandCatalog(ctx);
    },
  });
  // What the panel says, with the panel closed.
  pi.registerCommand("haril-status", {
    description: statusCommandDescription(),
    handler: async (_args, ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      const facts = dashboardFacts(current);
      await showInlineDetails(
        ctx,
        "HARIL · status",
        statusLines({
          locale: current.locale,
          version: facts.version,
          cwd: facts.cwd,
          project: facts.project,
          mode: facts.mode,
          modelLevel: facts.modelLevel,
          context: facts.context,
          cost: facts.cost,
          runtime: facts.runtime,
          memory: facts.memory,
          warnings: railWarnings(facts),
          extensions: loadedExtensions(),
          catalog: catalogCounts(loadedCatalog(current)),
          contextFiles: contextFiles(
            safely(() => ctx.getSystemPromptOptions?.().contextFiles, undefined),
            current.cwd,
            process.env.PI_CODING_AGENT_DIR,
          ),
          shortcuts,
        }),
      );
    },
  });
  pi.registerCommand("haril-plugin", {
    description:
      "Open a HARIL dock view: /haril-plugin [main|tools|docs|activity|actions|1..5|details]",
    handler: async (args, ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      const word = args.trim().toLowerCase();
      if (word === "") {
        await pickDockSlot(current, ctx);
        return;
      }
      const id =
        word === "details"
          ? current.dock.selected
          : /^[1-9]$/.test(word)
            ? dockSlotAt(current.dock.slots, Number(word))?.id
            : dockIdFromWord(word);
      if (id === undefined) {
        ctx.ui.notify(
          "Uso: /haril-plugin [main|tools|docs|activity|actions|1..5|details]",
          "warning",
        );
        return;
      }
      if (word !== "details") await openDockSlot(current, id);
      const detail = current.dock.detail;
      if (detail?.id !== id || current.closed || session !== current) return;
      // MAIN has no view to list: its content is the status block, which the right panel already shows.
      if (id === MAIN_DOCK_ID) {
        ctx.ui.notify(
          localized(
            current.locale,
            "MAIN shows the status in the right panel; /haril-focus opens its details.",
            "MAIN muestra el estado en el panel derecho; /haril-focus abre sus detalles.",
          ),
          "info",
        );
        return;
      }
      await showInlineDetails(ctx, detail.title, [detail.status, ...detail.lines]);
    },
  });
  // The documentation folder (DOCS tab): the keyboard way to what its rows do with a click.
  pi.registerCommand("haril-docs", {
    description:
      "HARIL: conectar la carpeta de documentación (por ejemplo Obsidian): /haril-docs [<ruta>|clear]",
    getArgumentCompletions: (prefix: string) =>
      [{ value: "clear", label: "clear", description: "Desconectar la carpeta" }].filter((item) =>
        item.value.startsWith(prefix.trim().toLowerCase()),
      ),
    async handler(args, ctx) {
      const current = session;
      if (current === undefined) return;
      const word = args.trim();
      if (word.toLowerCase() === "clear") await disconnectDocsFolder(current, ctx);
      else if (word !== "") await connectDocsFolder(current, ctx, word);
      else if (ctx.hasUI) await connectDocsFolder(current, ctx);
    },
  });
  pi.registerCommand("haril-extensions", {
    description: "Inspect and toggle configured Pi package extensions for the NEXT HARIL session",
    handler: async (_args, ctx) => {
      const current = session;
      if (!current || !ctx.hasUI || ctx.mode !== "tui") return;
      await managePiExtensions(current, ctx);
    },
  });
  // Pi's default bindings leave Alt+L / Alt+I free. Alt+Z is Pi's undo shortcut on WSL.
  registerShortcut("alt+l", {
    description: "Open HARIL's plugin list (then press 1..3, arrows, Enter or Esc)",
    handler: (ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      void pickDockSlot(current, ctx);
    },
  });
  pi.registerCommand("haril-plugins", {
    description:
      "Manage HARIL's visible plugin dock slots and their order (not installed Pi packages)",
    handler: async (_args, ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      if (!cliAvailable()) {
        ctx.ui.notify(NOT_LAUNCHED, "warning");
        return;
      }
      await reloadDockSlots(current);
      const choices = current.dock.slots.map((slot, index) => {
        const label = DOCK_LABELS.find((item) => item.id === slot.id)?.label ?? slot.id;
        return `${index + 1}. ${label} · ${slot.visible ? "visible" : "oculto"}`;
      });
      const piManagement = "Paquetes Pi · gestionar extensiones reales";
      choices.push(piManagement);
      const picked = await ctx.ui.select("Administrar dock izquierdo", choices);
      if (!picked || session !== current || current.closed) return;
      if (picked === piManagement) {
        await managePiExtensions(current, ctx);
        return;
      }
      const selected = current.dock.slots[choices.indexOf(picked)];
      if (!selected) return;
      const operations = ["Mostrar", "Ocultar", "Subir", "Bajar"];
      const action = await ctx.ui.select("¿Qué quieres hacer?", operations);
      if (!action || session !== current || current.closed) return;
      const index = operations.indexOf(action);
      const args =
        index < 2
          ? ["plugins", index === 0 ? "show" : "hide", selected.id]
          : ["plugins", "move", selected.id, index === 2 ? "up" : "down"];
      const result = await runHaril(args, { cwd: current.cwd });
      if (!result.ok) {
        ctx.ui.notify(result.stderr || "No fue posible modificar los plugins", "error");
        return;
      }
      await reloadDockSlots(current);
      ctx.ui.notify("Dock actualizado (no se instalaron ni desactivaron extensiones Pi)", "info");
    },
  });
  pi.registerCommand("haril-dock", {
    description: "Show or hide HARIL's native left and right sidebars: /haril-dock left|right|both",
    handler: async (args, ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      const target = args.trim().toLowerCase() || "right";
      if (target !== "left" && target !== "right" && target !== "both") {
        ctx.ui.notify("Uso: /haril-dock left|right|both", "warning");
        return;
      }
      if (target === "both") {
        const visible = !(current.dock.leftVisible && current.dock.rightVisible);
        current.dock.leftVisible = visible;
        current.dock.rightVisible = visible;
      } else if (target === "left") current.dock.leftVisible = !current.dock.leftVisible;
      else current.dock.rightVisible = !current.dock.rightVisible;
      current.nativePanes?.refresh();
    },
  });
  // Alt+H is absent from Pi 1.2.0's default keybindings; Alt+O/X/M are already used by this extension and are
  // documented as working on Windows, so this follows the same terminal-compatible shortcut contract.
  registerShortcut("alt+h", {
    description: "Choose a HARIL dashboard area",
    handler: (ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      void ctx.ui
        .custom<TabPickerResult | undefined>(
          (tui, theme, _keybindings, done) => createTabPicker(current.area, done, tui, theme),
          { overlay: true },
        )
        .then((result) => {
          if (result?.type === "open" && session === current && !current.closed) {
            current.openArea(result.area);
          }
        });
    },
  });
  registerShortcut("alt+i", {
    description: "Show or hide the HARIL right rail (focus on narrow terminals)",
    handler: (ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      if (current.nativePanes?.attached) {
        current.dock.rightVisible = !current.dock.rightVisible;
        current.nativePanes.refresh();
        return;
      }
      if ((current.tui?.terminal.columns ?? 0) < 120 || (current.tui?.terminal.rows ?? 0) < 40) {
        void current.openActions(current.ctx);
        return;
      }
      current.railVisible = !current.railVisible;
      redraw();
    },
  });
  // Alt+K is absent from Pi 1.2.0's default keybindings (pi-tui and pi-coding-agent), like Alt+H and Alt+I. The slash
  // command always reaches the editor, even where a terminal swallows Alt chords.
  registerShortcut("alt+k", {
    description: "Open the HARIL right-panel menu (arrows, Enter or Esc)",
    handler: (ctx) => {
      void openRailMenu(ctx);
    },
  });
  pi.registerCommand("haril-panel", {
    description: "Open the HARIL right-panel menu: its sections and actions, with arrows and Enter",
    handler: async (_args, ctx) => openRailMenu(ctx),
  });
  // Alt+F belongs to Pi's editor.cursorWordRight; never override a built-in shortcut.
  pi.registerCommand("haril-focus", {
    description: "Open a focused view of the selected HARIL area",
    handler: async (_args, ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      focusRightRail(current);
    },
  });

  // Alt+O is free in Pi 1.2.0's default keybindings (docs/keybindings.md and the pi-tui/coding-agent defaults).
  registerShortcut("alt+o", {
    description: "Open the HARIL orchestration view",
    handler: (ctx) => {
      if (session === undefined) return;
      session.openArea("orchestration");
      void session.openOrchestrationView(ctx);
    },
  });

  // Alt+X and Alt+M are free in Pi 1.2.0's default keybindings (docs/keybindings.md), on Windows too.
  registerShortcut("alt+x", {
    description:
      "■ STOP ALL: abort the chat turn and stop every HARIL agent now (haril stop --now)",
    handler: (ctx) => {
      void runStopAll(ctx);
    },
  });

  registerShortcut("alt+m", {
    description: "Cycle the HARIL console mode (ACTION, CONSULT, PLAN, DELEGATION)",
    handler: (ctx) => {
      modes.cycle(ctx);
    },
  });

  // A session ends: its timer stops and its watch and tail children end with it.
  function closeSession(ended: Session): void {
    ended.closed = true;
    ended.nativePanes?.close();
    ended.nativePanes = undefined;
    // A check still waiting for its moment belongs to no session now; the next session asks for it again.
    toolsPanel.cancelCheck();
    // The ACT tab's range is the session's: the next one starts on every event.
    activityPanel.reset();
    followTimer(ended);
    ended.feed.close();
  }

  // What Pi's own update notice says, for the panel. It never blocks the start and a failure says nothing.
  function checkPackageUpdates(current: Session): void {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (agentDir === undefined || options.packageLatest === null) return;
    void packageUpdates({
      packages: declaredPackages(readAgentSettings(agentDir)),
      agentDir,
      offline: process.env.PI_OFFLINE !== undefined && process.env.PI_OFFLINE !== "",
      latest: options.packageLatest ?? npmLatest,
    }).then(
      (names) => {
        current.packageUpdates = names;
        if (names.length > 0) redraw();
      },
      () => undefined,
    );
  }

  pi.on("session_start", (event, ctx) => {
    // Pi may start a session again without shutting the last one down (/new, /resume, a reload): the last one's
    // children end first, so none outlives the session that started it.
    if (session !== undefined) closeSession(session);
    const current = openSession(ctx);
    session = current;
    // The mode kept in the session comes back (resume, reload); a new session starts in ACTION.
    modes.restore(ctx);
    installUi(current);
    checkPackageUpdates(current);
    current.openArea("agents");
    void openDockSlot(current, current.dock.selected);
    // Engram and gentle-ai are checked in the background, once per process (HARIL_TOOLS_CHECK=off skips it).
    if (cliAvailable() || options.tools?.run !== undefined) toolsPanel.scheduleCheck();
    if (!cliAvailable()) return;
    void reloadDockSlots(current);
    // The project, the HARIL state and the models arrive after the first frame: the bar shows the folder until then.
    void current.rebind().then(() => current.refresh());
    void loadModels(current, event.reason);
  });

  pi.on("session_shutdown", () => {
    if (session === undefined) return;
    closeSession(session);
    session = undefined;
  });

  // A switch puts back the level kept for the new model (or the gateway's default); the console's model follows
  // first, so the level event that a switch causes is not taken for a choice on the old model.
  pi.on("model_select", (event) => {
    if (session === undefined) return;
    session.model = event.model;
    session.levels.modelSelected(event.model);
    redraw();
  });

  // /thinking and Shift+Tab: the new level is kept for the model, unless the event belongs to a model switch.
  pi.on("thinking_level_select", (event, ctx) => {
    if (session !== undefined)
      session.levels.levelSelected(
        safely(() => ctx.model, undefined),
        session.model,
        event.level,
      );
    redraw();
  });

  // The cost follows every reply: at its end with the message that ended, and again at the end of each turn and
  // run, once Pi has appended everything to the session.
  function recountCost(ended?: AgentMessage): void {
    if (session === undefined) return;
    const current = session;
    current.cost = safely(
      () => sessionCost(current.ctx.sessionManager.getEntries(), ended),
      current.cost,
    );
    redraw();
  }

  pi.on("message_end", (event) => {
    recountCost(event.message);
    if (session !== undefined && cliAvailable()) chatLog.usage(event.message, modes.mode());
  });

  pi.on("turn_end", () => recountCost());

  pi.on("agent_end", () => {
    recountCost();
    if (session === undefined || !cliAvailable()) return;
    void session.refresh();
  });

  // A new prompt replaces the answer of the last HARIL command. In DELEGATION mode the text never reaches the model:
  // it opens the /delegate card as the goal (or a hint while a workflow runs, P5). Pi stops at a handled input, so
  // everything the console does with an input happens here.
  pi.on("input", (event, ctx) => {
    const current = session;
    current?.clearOutput();
    if (current === undefined || event.source === "extension") return undefined;
    const text = event.text.trim();
    if (text === "") return undefined;
    // Every order typed in the console is logged, whatever happens to it next.
    if (cliAvailable()) chatLog.order(event.text, modes.mode());
    if (modes.mode() !== "delegation") return undefined;
    if (!cliAvailable()) ctx.ui.notify(NOT_LAUNCHED, "error");
    else void delegateFromChat(text, ctx, delegationHost(current));
    return { action: "handled" };
  });
}
