// HARIL console: a Pi extension loaded with `-e` by `haril console` (and a bare `haril` in a terminal), the way
// Gentle Shell is Pi with its own extension. Pi keeps everything it has (/login, /model, the thinking level,
// /settings, sessions); this adds HARIL's yellow bar, a startup header and the HARIL commands, which run the `haril`
// CLI on the project of the folder Pi opened in. Self-contained: node:* imports and local types only, so it bundles
// into one file next to the bridge.

import { cliAvailable } from "./cli.js";
import { type CommandHost, registerCommands } from "./commands.js";
import { DASHBOARD_AREAS, type DashboardArea, renderDashboard, renderHeader, type DashboardFacts } from "./dashboard.js";
import {
  harilRef,
  type ModelRegistration,
  registerHarilModels,
  restoreHarilModel,
} from "./models.js";
import type {
  AgentMessage,
  ConsoleContext,
  ConsolePi,
  ConsoleTui,
  PiModel,
  SessionEntry,
} from "./pi-types.js";
import { type BoundProject, findProject, folderName } from "./project.js";
import { type PendingApproval, readStatus } from "./status.js";
import { type BarFacts, type RuntimeState, renderBar, renderOutput } from "./view.js";

const VERSION_ENV = "HARIL_VERSION";
const OUTPUT_WIDGET = "haril-output";
// The bar reads the runtime and the plans again this often, and only while a runtime runs or a plan waits.
const REFRESH_MS = 5_000;

interface Session extends CommandHost {
  readonly ctx: ConsoleContext;
  project: BoundProject | undefined;
  pending: readonly PendingApproval[];
  pendingAvailable: boolean;
  tui: ConsoleTui | undefined;
  area: DashboardArea | undefined;
  branch: string | null | undefined;
  extensionStatuses: readonly string[];
  model: PiModel | undefined;
  // HARIL's providers as registered in Pi; undefined until `haril models` answers.
  registration: ModelRegistration | undefined;
  cost: number;
  runtimeAlive: boolean | undefined;
  timer: ReturnType<typeof setInterval> | undefined;
  refreshing: Promise<void> | undefined;
  // A refresh asked for while one runs: that one reads once more before it settles, so no caller sees stale state.
  refreshAgain: boolean;
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
    const level =
      model?.reasoning === true ? safely(() => pi.getThinkingLevel(), undefined) : undefined;
    return {
      place: current.project?.slug ?? folderName(current.cwd),
      model: model?.id,
      level,
      contextPercent: usage === undefined ? undefined : usage.percent,
      cost: current.cost,
      pending: current.pending.length,
      runtime: runtimeState(current),
      cwd: current.cwd,
      branch,
      statuses,
    };
  }

  function dashboardFacts(current: Session): DashboardFacts {
    const usage = current.model === undefined ? undefined : safely(() => current.ctx.getContextUsage(), undefined);
    const allTools = safely(() => pi.getAllTools(), []);
    const active = new Set(safely(() => pi.getActiveTools(), []));
    const commands = safely(() => pi.getCommands(), []);
    const servers = safely(() => pi.getMcpServers(), []);
    return {
      project: current.project?.slug ?? folderName(current.cwd),
      cwd: current.cwd,
      branch: current.branch,
      model: current.model?.id ?? "no model selected",
      thinking: current.model?.reasoning === true ? safely(() => pi.getThinkingLevel(), "unknown") : "n/a",
      runtime: runtimeState(current),
      pending: current.pendingAvailable ? current.pending.length : undefined,
      context: usage === undefined ? "unavailable" : `${usage.percent === null ? "?" : Math.round(usage.percent)}%`,
      cost: `$${current.cost.toFixed(3)}`,
      activeTools: [...active],
      tools: allTools.map((tool) => ({ name: tool.name, active: active.has(tool.name) })),
      commands: commands.map((command) => command.name).sort(),
      mcpServers: servers.map((server) => server.name).sort(),
      extensionStatuses: current.extensionStatuses,
    };
  }

  // The light timer runs only while there is something to follow, and never keeps Pi alive.
  function followTimer(current: Session): void {
    const busy = current.runtimeAlive === true || current.started?.running === true;
    const wanted = !current.closed && (busy || current.pending.length > 0);
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
      cwd: ctx.cwd,
      project: undefined,
      pending: [],
      pendingAvailable: false,
      started: undefined,
      tui: undefined,
      area: undefined,
      branch: undefined,
      extensionStatuses: [],
      model: ctx.model,
      registration: undefined,
      cost: safely(() => sessionCost(ctx.sessionManager.getEntries()), 0),
      runtimeAlive: undefined,
      timer: undefined,
      refreshing: undefined,
      refreshAgain: false,
      closed: false,
      harilModelRef: () => harilRef(current.model, current.registration),
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
        if (!ctx.hasUI || ctx.mode !== "tui") return;
        ctx.ui.setWidget("haril-dashboard", (_tui, theme) => ({
          render: (width) => renderDashboard(area, dashboardFacts(current), width, theme),
          invalidate() {},
        }), { placement: "aboveEditor" });
        redraw();
      },
      async rebind() {
        current.project = await findProject(current.cwd);
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
            current.pendingAvailable = status.pending !== undefined;
            if (status.pending !== undefined) current.pending = status.pending;
          } while (current.refreshAgain);
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
    ctx.ui.setHeader((_tui, theme) => ({
      render: (width) => renderHeader(
        version === "" ? undefined : version,
        width,
        dashboardFacts(current),
        current.area,
        theme,
      ),
      invalidate() {},
    }));
    ctx.ui.setFooter((tui, theme, footerData) => {
      current.tui = tui;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        render(width) {
          const statuses = [...footerData.getExtensionStatuses().values()];
          current.branch = footerData.getGitBranch();
          current.extensionStatuses = statuses;
          return renderBar(facts(current, statuses, footerData.getGitBranch()), width, theme);
        },
        invalidate() {},
        dispose: unsubscribe,
      };
    });
  }

  // HARIL's models join Pi's catalog once `haril models` answers; the bar and /goal follow. On a start, Pi chose its
  // model before they existed, so a saved HARIL default is put back.
  async function loadModels(current: Session, reason: string): Promise<void> {
    const registration = await registerHarilModels(pi, current.ctx);
    if (current.closed) return;
    current.registration = registration;
    if (current.ctx.hasUI && (reason === "startup" || reason === "reload")) {
      for (const note of registration.notes) current.ctx.ui.notify(note, "warning");
    }
    if (reason === "startup") {
      const restored = await restoreHarilModel(pi, current.ctx, registration, current.model);
      if (restored !== undefined && !current.closed) current.model = restored;
    }
    redraw();
  }

  registerCommands(pi, () => session);
  DASHBOARD_AREAS.forEach((area, index) => {
    pi.registerShortcut(`ctrl+shift+${index + 1}`, {
      description: `Open HARIL ${area.toUpperCase()} dashboard`,
      handler: () => session?.openArea(area),
    });
  });

  pi.on("session_start", (event, ctx) => {
    const current = openSession(ctx);
    session = current;
    installUi(current);
    if (!cliAvailable()) return;
    // The project, the HARIL state and the models arrive after the first frame: the bar shows the folder until then.
    void current.rebind().then(() => current.refresh());
    void loadModels(current, event.reason);
  });

  pi.on("session_shutdown", () => {
    if (session === undefined) return;
    session.closed = true;
    followTimer(session);
    session = undefined;
  });

  pi.on("model_select", (event) => {
    if (session === undefined) return;
    session.model = event.model;
    redraw();
  });

  pi.on("thinking_level_select", () => redraw());

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

  pi.on("message_end", (event) => recountCost(event.message));

  pi.on("turn_end", () => recountCost());

  pi.on("agent_end", () => {
    recountCost();
    if (session === undefined || !cliAvailable()) return;
    void session.refresh();
  });

  // A new prompt replaces the answer of the last HARIL command.
  pi.on("input", () => {
    session?.clearOutput();
  });
}
