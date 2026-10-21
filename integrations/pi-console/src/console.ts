// HARIL console: a Pi extension loaded with `-e` by `haril console` (and a bare `haril` in a terminal), the way
// Gentle Shell is Pi with its own extension. Pi keeps everything it has (/login, /model, the thinking level,
// /settings, sessions); this adds HARIL's yellow bar, a startup header and the HARIL commands, which run the `haril`
// CLI on the project of the folder Pi opened in. Self-contained: node:* imports and local types only, so it bundles
// into one file next to the bridge.

import { createChatLog } from "./chat-log.js";
import { cliAvailable, NOT_LAUNCHED, runHaril, runHarilJson } from "./cli.js";
import { type CommandHost, chooseMode, delegationHost, registerCommands } from "./commands.js";
import {
  type DashboardArea,
  type DashboardFacts,
  type RailSection,
  renderFooterNavigation,
  renderHeaderLayout,
} from "./dashboard.js";
import { openDashboardActionMenu, runDashboardAction } from "./dashboard-actions.js";
import type { DashboardAction } from "./dashboard-controls.js";
import { type DashboardData, emptyDashboardData, loadDashboardData } from "./dashboard-data.js";
import { delegateFromChat } from "./delegation.js";
import { effectText, sourceText, valueText } from "./delegation-settings.js";
import { stopAll } from "./emergency.js";
import { DEFAULT_UI_LOCALE, readConsoleLocale, type UiLocale } from "./locale.js";
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
import type {
  AgentMessage,
  ConsoleContext,
  ConsoleMouseEvent,
  ConsolePi,
  ConsoleTui,
  PiModel,
  SessionEntry,
} from "./pi-types.js";
import { type BoundProject, findProject, folderName } from "./project.js";
import { type PendingApproval, readStatus } from "./status.js";
import { createTabPicker, type TabPickerResult } from "./tab-picker.js";
import { clipText, plainText } from "./text.js";
import {
  type BarFacts,
  type BarLayout,
  type RuntimeState,
  renderBarLayout,
  renderOutput,
} from "./view.js";

const VERSION_ENV = "HARIL_VERSION";
const OUTPUT_WIDGET = "haril-output";
// The bar reads the runtime and the plans again this often, and only while a runtime runs or a plan waits.
const REFRESH_MS = 5_000;

interface Session extends CommandHost {
  readonly ctx: ConsoleContext;
  locale: UiLocale;
  project: BoundProject | undefined;
  pending: readonly PendingApproval[];
  pendingAvailable: boolean;
  tui: ConsoleTui | undefined;
  area: DashboardArea | undefined;
  branch: string | null | undefined;
  extensionStatuses: readonly string[];
  providerWarnings: readonly string[];
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

export default function harilConsole(pi: ConsolePi): void {
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

  function runtimeState(current: Session): RuntimeState {
    if (current.runtimeAlive === true) return "running";
    if (current.started?.running === true) return "starting";
    if (current.runtimeAlive === undefined) return "unknown";
    return "idle";
  }

  function facts(current: Session, statuses: readonly string[], branch: string | null): BarFacts {
    const model = current.model;
    const usage =
      model === undefined ? undefined : safely(() => current.ctx.getContextUsage(), undefined);
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
      logFailures: chatLog.status().failed,
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
      area: undefined,
      branch: undefined,
      extensionStatuses: [],
      providerWarnings: [],
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
      recordOrder(text) {
        if (cliAvailable()) chatLog.order(text, modes.mode());
      },
      harilModelRef: () => harilRef(current.model, current.registration),
      harilModels: () => {
        const registration = current.registration;
        if (registration === undefined) return [];
        const refs = safely(() => ctx.modelRegistry.getAvailable(), []).flatMap((model) => {
          const harilId = registration.harilIdOf.get(model.provider);
          return harilId === undefined ? [] : [`${harilId}/${model.id}`];
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
        const [project, configuredLocale] = await Promise.all([
          findProject(current.cwd),
          runHarilJson(["config", "get", "ui.locale", "--json"], { timeoutMs: 10_000 }),
        ]);
        if (current.closed) return;
        current.project = project;
        current.locale = readConsoleLocale(configuredLocale);
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
        switch (rail.action) {
          case "toggle":
            if (rail.section !== undefined) {
              const baseline = rail.section === "actions" || rail.section === "warnings";
              current.railExpanded[rail.section] =
                !(current.railExpanded[rail.section] ?? baseline);
              redraw();
            }
            break;
          case "run":
            if (rail.control !== undefined) openDashboardAction(current, rail.control);
            break;
          case "mode":
            void chooseMode(current, current.ctx);
            break;
          case "menu":
            void current.openActions(current.ctx);
            break;
          case "focus":
            focusRightRail(current);
            break;
        }
        return { handled: true, render: true };
      },
      invalidate() {},
    }));
    ctx.ui.setFooter((tui, theme, footerData) => {
      current.tui = tui;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      let navigation = renderFooterNavigation(80, current.area, theme);
      let bar: BarLayout = { lines: [], hits: [] };
      return {
        render(width) {
          const statuses = [...footerData.getExtensionStatuses().values()];
          current.branch = footerData.getGitBranch();
          current.extensionStatuses = statuses;
          navigation = renderFooterNavigation(width, current.area, theme);
          bar = renderBarLayout(facts(current, statuses, footerData.getGitBranch()), width, theme);
          return [...bar.lines, ...navigation.lines];
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
            else void chooseLevel(current.ctx, pi, current.levels);
            return { handled: true, render: true };
          }
          const hit = navigation.tabHits.find(
            (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
          );
          if (hit === undefined) return undefined;
          current.openArea(hit.area);
          return { handled: true, render: true };
        },
        invalidate() {},
        dispose: unsubscribe,
      };
    });
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
          "Extension statuses:",
          ...(facts.extensionStatuses.length ? facts.extensionStatuses : ["No status reported"]),
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

  registerCommands(pi, () => session);
  // Alt+H is absent from Pi 1.2.0's default keybindings; Alt+O/X/M are already used by this extension and are
  // documented as working on Windows, so this follows the same terminal-compatible shortcut contract.
  pi.registerShortcut("alt+h", {
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
  pi.registerShortcut("alt+r", {
    description: "Show or hide the HARIL right rail (focus on narrow terminals)",
    handler: (ctx) => {
      const current = session;
      if (current === undefined || !ctx.hasUI || ctx.mode !== "tui") return;
      if ((current.tui?.terminal.columns ?? 0) < 120 || (current.tui?.terminal.rows ?? 0) < 40) {
        void current.openActions(current.ctx);
        return;
      }
      current.railVisible = !current.railVisible;
      redraw();
    },
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
  pi.registerShortcut("alt+o", {
    description: "Open the HARIL orchestration view",
    handler: (ctx) => {
      if (session === undefined) return;
      session.openArea("orchestration");
      void session.openOrchestrationView(ctx);
    },
  });

  // Alt+X and Alt+M are free in Pi 1.2.0's default keybindings (docs/keybindings.md), on Windows too.
  pi.registerShortcut("alt+x", {
    description:
      "■ STOP ALL: abort the chat turn and stop every HARIL agent now (haril stop --now)",
    handler: (ctx) => {
      void runStopAll(ctx);
    },
  });

  pi.registerShortcut("alt+m", {
    description: "Cycle the HARIL console mode (ACTION, CONSULT, PLAN, DELEGATION)",
    handler: (ctx) => {
      modes.cycle(ctx);
    },
  });

  // A session ends: its timer stops and its watch and tail children end with it.
  function closeSession(ended: Session): void {
    ended.closed = true;
    followTimer(ended);
    ended.feed.close();
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
    current.openArea("agents");
    if (!cliAvailable()) return;
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
