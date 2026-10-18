import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runHaril } from "./cli.js";
import { DASHBOARD_AREAS, type DashboardArea } from "./dashboard.js";
import type { DashboardAction } from "./dashboard-controls.js";
import {
  type DashboardEvent,
  type DashboardMethodology,
  readApproval,
  readMethodologyDefinition,
  summarizeApproval,
} from "./dashboard-data.js";
import { chooseLevel, chooseModel, type LevelMemory, openModelAndLevel } from "./model-picker.js";
import { actionRefusal, type ConsoleMode } from "./modes.js";
import { demoNotice } from "./orchestration-state.js";
import type { ConsoleContext, ConsolePi } from "./pi-types.js";
import { type BoundProject, folderName } from "./project.js";
import type { PendingApproval } from "./status.js";
import { plainText, textWidth, truncate, wrap } from "./text.js";

const HARIL_COMMANDS = [
  "/mode",
  "/delegate",
  "/continue",
  "/goal",
  "/plans",
  "/plan",
  "/approve",
  "/deny",
  "/tasks",
  "/task",
  "/events",
  "/init",
  "/haril",
];

export interface DashboardActionHost {
  readonly cwd: string;
  readonly project: BoundProject | undefined;
  readonly pending: readonly PendingApproval[];
  started: { readonly pid: number; readonly log: string; running: boolean } | undefined;
  readonly modelRef: () => string | undefined;
  // The reasoning level kept per model (model-picker.ts).
  readonly levels: LevelMemory;
  readonly runtime: () => string;
  readonly runtimeAvailable: () => boolean;
  readonly tools: () => { readonly name: string; readonly active: boolean }[];
  readonly tasks: () => readonly {
    readonly taskId: string;
    readonly state: string;
    readonly goal: string;
    readonly agent: string;
    readonly model: string | null;
  }[];
  readonly approvals: () => readonly PendingApproval[];
  readonly approvalsAvailable: () => boolean;
  readonly events: () => readonly DashboardEvent[];
  readonly methodologies: () => readonly string[];
  readonly methodologyEntries: () => readonly DashboardMethodology[];
  readonly methodologiesAvailable: () => boolean;
  readonly methodologyError: () => string | undefined;
  readonly memorySummary: () => string;
  readonly details: () => { readonly title: string; readonly lines: readonly string[] };
  readonly reload: () => Promise<void>;
  readonly rebind: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly output: (title: string, lines: readonly string[]) => void;
  readonly openArea: (area: DashboardArea) => void;
  // The ORCHESTRATION view: its full-view overlay and its demo mode (sample data, never HARIL state).
  readonly openOrchestrationView: (ctx: ConsoleContext) => Promise<void>;
  readonly pickWorkflow: (ctx: ConsoleContext) => Promise<boolean>;
  readonly toggleOrchestrationDemo: () => boolean;
  readonly orchestrationDemo: () => boolean;
  // The console mode: CONSULT refuses the actions that change state (modes.ts). Absent means ACTION.
  readonly mode?: () => ConsoleMode;
}

function projectSlug(host: DashboardActionHost, ctx: ConsoleContext): string | undefined {
  const slug = host.project?.slug;
  if (slug === undefined)
    ctx.ui.notify("Open a registered HARIL project before using this action.", "warning");
  return slug;
}

function currentProject(host: DashboardActionHost): BoundProject | undefined {
  return host.project;
}

function firstLine(stderr: string, command: string): string {
  return stderr.trim().split(/\r?\n/)[0] || `${command} failed`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function showInlineDetails(
  ctx: ConsoleContext,
  title: string,
  lines: readonly string[],
): Promise<void> {
  await ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      let offset = 0;
      const cleanLines = lines.map((line) => plainText(line));
      return {
        render(nextWidth) {
          const width = Math.max(1, nextWidth);
          const contentWidth = Math.max(1, width - 4);
          const wrapped = cleanLines.flatMap((line) => wrap(line, contentWidth));
          const pageSize = Math.min(14, Math.max(3, wrapped.length));
          offset = Math.max(0, Math.min(offset, wrapped.length - pageSize));
          const shown = wrapped.slice(offset, offset + pageSize);
          const padRow = (line: string): string => {
            const fitted = truncate(plainText(line), width);
            return fitted + " ".repeat(Math.max(0, width - textWidth(fitted)));
          };
          return [
            theme.bold(theme.fg("warning", padRow(title))),
            ...Array.from({ length: pageSize }, (_, index) =>
              theme.fg("text", padRow(shown[index] ?? "")),
            ),
            theme.fg(
              "dim",
              padRow(
                `${wrapped.length ? offset + 1 : 0}-${Math.min(wrapped.length, offset + pageSize)} of ${wrapped.length} · ↑/↓ or wheel · PgUp/PgDn · Esc closes`,
              ),
            ),
          ];
        },
        handleInput(input) {
          if (input === "\u001b" || input === "q") done(undefined);
          else if (input === "\u001b[A" || input === "k") offset = Math.max(0, offset - 1);
          else if (input === "\u001b[B" || input === "j") offset += 1;
          else if (input === "\u001b[5~") offset = Math.max(0, offset - 14);
          else if (input === "\u001b[6~") offset += 14;
          else if (input === "\u001b[H" || input === "g") offset = 0;
          else if (input === "\u001b[F" || input === "G") offset = Number.MAX_SAFE_INTEGER;
          tui.requestRender();
        },
        handleMouse(event) {
          if (event.type !== "wheel") return undefined;
          offset = Math.max(0, offset + (event.wheelDelta ?? 0));
          tui.requestRender();
          return { handled: true, render: true };
        },
        invalidate() {},
      };
    },
    { overlay: false },
  );
}

function methodologyLabel(entry: DashboardMethodology): string {
  return `${entry.name} · v${entry.version} · ${entry.summary}`;
}

async function registerProject(
  ctx: ConsoleContext,
  host: DashboardActionHost,
  selected?: DashboardMethodology,
): Promise<void> {
  if (host.project !== undefined) {
    ctx.ui.notify(`This folder is already bound to project ${host.project.slug}.`, "info");
    return;
  }
  if (!host.methodologiesAvailable()) await host.reload();
  if (!host.methodologiesAvailable()) {
    ctx.ui.notify(
      host.methodologyError() ??
        "The global methodology registry is unavailable; refresh before registering.",
      "error",
    );
    return;
  }
  const entries = host.methodologyEntries();
  if (entries.length === 0) {
    ctx.ui.notify(
      "The local registry returned no methodologies. This CLI supports listing but not importing definitions.",
      "warning",
    );
    return;
  }
  let methodology = selected;
  if (methodology === undefined) {
    const labels = entries.map(methodologyLabel);
    const choice = await ctx.ui.select("Choose the project's methodology", labels);
    if (choice === undefined) return;
    methodology = entries[labels.indexOf(choice)];
  }
  if (methodology === undefined) return;

  const rawName = await ctx.ui.input(`Register folder · ${host.cwd}`, folderName(host.cwd));
  if (rawName === undefined) return;
  const name = plainText(rawName).trim() || folderName(host.cwd);
  const args = [
    "project",
    "init",
    host.cwd,
    "--name",
    name,
    "--methodology",
    methodology.name,
    "--json",
  ];
  const previewResult = await runHaril(args, { cwd: host.cwd, timeoutMs: 10_000 });
  if (!previewResult.ok) {
    ctx.ui.notify(
      `Registration preview failed: ${firstLine(previewResult.stderr, "project init")}`,
      "error",
    );
    return;
  }

  let preview: Record<string, unknown> | undefined;
  try {
    preview = object(JSON.parse(previewResult.stdout) as unknown);
  } catch {
    preview = undefined;
  }
  const files = Array.isArray(preview?.files) ? preview.files.map(object) : undefined;
  if (
    preview === undefined ||
    preview.applied !== false ||
    typeof preview.rootPath !== "string" ||
    !samePath(preview.rootPath, host.cwd) ||
    preview.name !== name ||
    preview.methodology !== methodology.name ||
    typeof preview.slug !== "string" ||
    files === undefined ||
    files.length === 0 ||
    files.some(
      (file) =>
        file === undefined || typeof file.path !== "string" || typeof file.action !== "string",
    )
  ) {
    ctx.ui.notify(
      "HARIL returned an unexpected project-init preview; nothing was applied.",
      "error",
    );
    return;
  }
  if (files.some((file) => file?.action === "conflict")) {
    ctx.ui.notify(
      "The project manifest conflicts with existing content; review it before registering.",
      "error",
    );
    return;
  }

  const planLines = [
    `Name: ${preview.name}`,
    `Slug: ${preview.slug}`,
    `Folder: ${preview.rootPath}`,
    `Methodology: ${preview.methodology} · v${methodology.version}`,
    "Planned files:",
    ...files.map((file) => `${String(file?.action)} · ${String(file?.path)}`),
    "The CLI preview did not apply these changes.",
  ];
  if (!(await ctx.ui.confirm("Confirm project registration", planLines.join("\n")))) return;

  const appliedResult = await runHaril([...args, "--yes"], { cwd: host.cwd, timeoutMs: 10_000 });
  if (!appliedResult.ok) {
    ctx.ui.notify(
      `Project registration failed: ${firstLine(appliedResult.stderr, "project init")}`,
      "error",
    );
    await host.rebind();
    await host.refreshStatus();
    return;
  }
  let receipt: Record<string, unknown> | undefined;
  try {
    receipt = object(JSON.parse(appliedResult.stdout) as unknown);
  } catch {
    receipt = undefined;
  }
  await host.rebind();
  await host.refreshStatus();
  const reboundProject = currentProject(host);
  if (
    receipt?.applied === true &&
    receipt.rootPath === preview.rootPath &&
    reboundProject?.slug === preview.slug
  ) {
    ctx.ui.notify(
      `Project ${String(receipt.slug)} registered; ${reboundProject.name} is now bound to this console.`,
      "info",
    );
  } else {
    ctx.ui.notify(
      "The CLI returned success, but project binding could not be confirmed. Refresh to reconcile the view.",
      "warning",
    );
  }
}

async function browseMethodologies(ctx: ConsoleContext, host: DashboardActionHost): Promise<void> {
  if (!host.methodologiesAvailable()) await host.reload();
  if (!host.methodologiesAvailable()) {
    ctx.ui.notify(
      host.methodologyError() ??
        "The global methodology registry could not be read; refresh to retry.",
      "error",
    );
    return;
  }
  const entries = host.methodologyEntries();
  if (entries.length === 0) {
    ctx.ui.notify(
      "The local registry successfully returned no methodologies. This CLI has no methodology import command.",
      "info",
    );
    return;
  }
  const labels = entries.map(methodologyLabel);
  const choice = await ctx.ui.select("Browse bundled HARIL methodologies", labels);
  const entry = entries[labels.indexOf(choice ?? "")];
  if (entry === undefined) return;
  const definition = await readMethodologyDefinition(entry);
  const detailLines = [
    `ID: ${entry.id}`,
    `Version: ${entry.version}`,
    `SHA-256: ${entry.sha256}`,
    `Summary: ${entry.summary}`,
    "",
    "COMPLETE BUNDLED DEFINITION",
    ...(definition.contents === undefined
      ? [definition.error ?? "Definition unavailable."]
      : definition.contents.replace(/\r\n/g, "\n").split("\n")),
  ];
  if (host.project !== undefined)
    detailLines.push(
      "",
      "This view inspects the definition only; task add has no methodology selector.",
    );
  await showInlineDetails(ctx, `Methodology · ${entry.name} · v${entry.version}`, detailLines);
}

async function showTasks(host: DashboardActionHost, ctx: ConsoleContext): Promise<void> {
  const tasks = host.tasks();
  if (tasks.length === 0) {
    ctx.ui.notify("No tasks are recorded for this project.", "info");
    return;
  }
  const choice = await ctx.ui.select(
    "Project tasks",
    tasks.map((task) => `${task.taskId} · ${task.state} · ${task.goal}`),
  );
  const task = tasks.find((row) => choice?.startsWith(row.taskId));
  if (task === undefined) return;
  host.output(`Task ${task.taskId}`, [
    `State: ${task.state}`,
    `Observed agent: ${task.agent}`,
    `Model: ${task.model ?? "none recorded"}`,
    `Goal: ${task.goal}`,
  ]);
}

async function showApprovals(host: DashboardActionHost, ctx: ConsoleContext): Promise<void> {
  const slug = projectSlug(host, ctx);
  if (slug === undefined) return;
  if (!host.approvalsAvailable()) {
    ctx.ui.notify(
      "The project approval list could not be read; refresh before treating it as empty.",
      "warning",
    );
    return;
  }
  const approvals = host.approvals();
  if (approvals.length === 0) {
    ctx.ui.notify("No pending approvals for this project.", "info");
    return;
  }
  const choice = await ctx.ui.select(
    "Pending project approvals",
    approvals.map((row) => `${row.approvalId} · ${row.tasks} tasks · ${row.model ?? "no model"}`),
  );
  const selected = approvals.find((row) => choice?.startsWith(row.approvalId));
  if (selected === undefined || selected.projectSlug !== slug) return;
  const approval = await readApproval(slug, selected.approvalId);
  if (approval === undefined) {
    ctx.ui.notify(
      "Approval changed or no longer belongs to the selected project; refresh and try again.",
      "warning",
    );
    await host.reload();
    await host.refreshStatus();
    return;
  }
  host.output("Approval review", summarizeApproval(approval));
  const action = await ctx.ui.select(`Approval · ${slug}`, [
    "Approve this plan",
    "Deny this plan",
    "Cancel",
  ]);
  if (action === undefined || action === "Cancel") return;
  const verb = action.startsWith("Approve") ? "approve" : "deny";
  const confirmed = await ctx.ui.confirm(
    `${verb.toUpperCase()} plan`,
    `Project ${slug}\n${selected.approvalId}\n${selected.tasks} planned tasks. ${verb === "approve" ? "An active runtime may execute the approved work." : "This records a denial."}`,
  );
  if (!confirmed) return;
  const current = await readApproval(slug, selected.approvalId);
  if (current === undefined || current.status !== "requested") {
    ctx.ui.notify(
      "Approval is no longer pending in this project; no decision was sent.",
      "warning",
    );
    await host.reload();
    await host.refreshStatus();
    return;
  }
  const result = await runHaril([verb, selected.approvalId], { cwd: host.cwd, timeoutMs: 10_000 });
  if (!result.ok) ctx.ui.notify(firstLine(result.stderr, verb), "error");
  else ctx.ui.notify(result.stdout.trim().split(/\r?\n/)[0] || `Approval ${verb} recorded`, "info");
  await host.reload();
  await host.refreshStatus();
}

async function showEvents(host: DashboardActionHost, ctx: ConsoleContext): Promise<void> {
  if (projectSlug(host, ctx) === undefined) return;
  const events = host.events();
  host.output(
    "Project events · newest first",
    events.length
      ? events
          .slice()
          .reverse()
          .map(
            (event) =>
              `#${event.seq} · ${event.time} · ${event.type} · ${event.aggregateType}:${event.aggregateId}${event.taskId ? ` · task ${event.taskId}` : ""}`,
          )
      : ["No project events were returned."],
  );
}

function launchRuntime(
  host: DashboardActionHost,
  slug: string,
  mode: "start" | "run",
): string | undefined {
  const node = process.env.HARIL_NODE;
  const cli = process.env.HARIL_CLI;
  const root = process.env.HARIL_RUNTIME_DIR;
  if (!node || !cli || !root) return "The HARIL launcher did not provide the runtime paths.";
  const now = new Date();
  const logFile = join(
    root,
    "logs",
    `runtime-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.log`,
  );
  try {
    mkdirSync(join(root, "logs"), { recursive: true });
    const fd = openSync(logFile, "a");
    try {
      const args = [cli, mode, "--project", slug];
      if (mode === "start") args.push("--started-by", "shell");
      const child = spawn(node, args, {
        cwd: root,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: process.env,
      });
      if (child.pid === undefined) {
        child.once("error", () => undefined);
        return "HARIL could not start the project runtime.";
      }
      const started = { pid: child.pid, log: relative(root, logFile), running: true };
      child.once("error", () => {
        started.running = false;
      });
      child.once("exit", () => {
        started.running = false;
      });
      child.unref();
      host.started = started;
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runDashboardAction(
  action: DashboardAction,
  ctx: ConsoleContext,
  pi: ConsolePi,
  host: DashboardActionHost,
): Promise<void> {
  const refusal = actionRefusal(host.mode?.() ?? "action", action);
  if (refusal !== undefined) {
    ctx.ui.notify(refusal, "warning");
    return;
  }
  switch (action) {
    case "register-project":
      await registerProject(ctx, host);
      return;
    case "details": {
      const detail = host.details();
      await showInlineDetails(ctx, detail.title, detail.lines);
      return;
    }
    case "refresh":
      await host.reload();
      await host.refreshStatus();
      ctx.ui.notify("HARIL project data refreshed.", "info");
      return;
    case "model":
      await chooseModel(ctx, pi);
      return;
    case "level":
      await chooseLevel(ctx, pi, host.levels);
      return;
    case "model-level":
      await openModelAndLevel(ctx, pi, host.levels);
      return;
    case "tasks":
      await showTasks(host, ctx);
      return;
    case "approvals":
      await showApprovals(host, ctx);
      return;
    case "events":
      await showEvents(host, ctx);
      return;
    case "goal": {
      const slug = projectSlug(host, ctx);
      if (slug === undefined) return;
      const goal = (
        await ctx.ui.input(`New goal · ${slug}`, "Describe the outcome to plan")
      )?.trim();
      if (!goal) return;
      if (
        !(await ctx.ui.confirm(
          "Queue planning task",
          `Project ${slug}\n${goal}\nThis queues a planner task; it does not start the runtime.`,
        ))
      )
        return;
      const model = host.modelRef();
      const args = [
        "task",
        "add",
        goal,
        "--project",
        slug,
        "--kind",
        "plan",
        "--agent",
        model === undefined ? "fake:plan" : "planner",
      ];
      if (model !== undefined) args.push("--model", model);
      const result = await runHaril(args, { cwd: host.cwd, timeoutMs: 10_000 });
      if (!result.ok) ctx.ui.notify(firstLine(result.stderr, "task add"), "error");
      else ctx.ui.notify(result.stdout.trim().split(/\r?\n/)[0] || "Goal queued", "info");
      await host.reload();
      await host.refreshStatus();
      return;
    }
    case "run-queue":
    case "start-runtime": {
      const slug = projectSlug(host, ctx);
      if (slug === undefined) return;
      const mode = action === "run-queue" ? "run" : "start";
      await host.reload();
      await host.refreshStatus();
      if (!host.runtimeAvailable() || host.runtime() !== "idle") {
        ctx.ui.notify(
          "The HARIL runtime state is not confirmed idle; refresh before starting another worker.",
          "warning",
        );
        return;
      }
      const message =
        mode === "run"
          ? `Run queued work for ${slug} and exit when idle. This may execute real agent tasks.`
          : `Start the shared HARIL runtime filtered to ${slug}. It can execute queued work for this project.`;
      if (
        !(await ctx.ui.confirm(
          mode === "run" ? "Run project queue" : "Start project runtime",
          message,
        ))
      )
        return;
      await host.refreshStatus();
      if (!host.runtimeAvailable() || host.runtime() !== "idle") {
        ctx.ui.notify("Runtime state changed while confirming; no worker was started.", "warning");
        return;
      }
      const error = launchRuntime(host, slug, mode);
      if (error !== undefined) ctx.ui.notify(error, "error");
      else
        ctx.ui.notify(`HARIL ${mode} started for ${slug}; output is in the runtime log.`, "info");
      await host.reload();
      await host.refreshStatus();
      return;
    }
    case "stop-runtime": {
      const slug = projectSlug(host, ctx);
      if (slug === undefined) return;
      await host.reload();
      await host.refreshStatus();
      if (!host.runtimeAvailable() || host.runtime() !== "running") {
        ctx.ui.notify(
          "The shared HARIL runtime is not confirmed running; no stop request was sent.",
          "warning",
        );
        return;
      }
      if (
        !(await ctx.ui.confirm(
          "Stop shared HARIL runtime",
          `The runtime lease is shared by the HARIL data directory, not isolated to ${slug}. This stop request may pause work for other projects too.`,
        ))
      )
        return;
      await host.refreshStatus();
      if (!host.runtimeAvailable() || host.runtime() !== "running") {
        ctx.ui.notify(
          "The shared runtime changed while confirming; no stop request was sent.",
          "warning",
        );
        return;
      }
      const result = await runHaril(["stop"], { cwd: host.cwd, timeoutMs: 10_000 });
      if (!result.ok) ctx.ui.notify(firstLine(result.stderr, "stop"), "error");
      else
        ctx.ui.notify(result.stdout.trim().split(/\r?\n/)[0] || "Runtime stop requested", "info");
      await host.reload();
      await host.refreshStatus();
      return;
    }
    case "toggle-tools": {
      const tools = host.tools();
      const choice = await ctx.ui.select(
        "Pi tools · select to toggle",
        tools.map((tool) => `${tool.active ? "●" : "○"} ${tool.name}`),
      );
      const name = choice?.slice(2);
      if (name === undefined) return;
      const selected = tools.find((tool) => tool.name === name);
      if (selected === undefined) return;
      const enabled = !selected.active;
      const confirmed = await ctx.ui.confirm(
        `${enabled ? "Enable" : "Disable"} Pi tool · ${name}`,
        `Change ${name} to ${enabled ? "enabled" : "disabled"} for this Pi session?`,
      );
      if (!confirmed) return;
      const active = new Set(tools.filter((tool) => tool.active).map((tool) => tool.name));
      if (enabled) active.add(name);
      else active.delete(name);
      try {
        pi.setActiveTools([...active]);
        const known = pi.getAllTools().some((tool) => tool.name === name);
        const actual = pi.getActiveTools().includes(name);
        if (!known)
          ctx.ui.notify(
            `${name} is no longer available; Pi did not confirm the change.`,
            "warning",
          );
        else if (actual !== enabled)
          ctx.ui.notify(
            `Pi did not apply the requested ${enabled ? "enabled" : "disabled"} state for ${name}.`,
            "warning",
          );
        else
          ctx.ui.notify(
            `${name} is ${actual ? "enabled" : "disabled"} for this Pi session.`,
            "info",
          );
      } catch (error) {
        ctx.ui.notify(
          `Pi could not update ${name}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return;
    }
    case "methodologies":
      await browseMethodologies(ctx, host);
      return;
    case "commands": {
      const choice = await ctx.ui.select(
        "HARIL slash commands · select to prefill the editor",
        HARIL_COMMANDS,
      );
      if (choice !== undefined) ctx.ui.setEditorText(`${choice} `);
      return;
    }
    case "memory":
      host.output("HARIL recorded memory health", [
        host.memorySummary(),
        "Provider credentials are not displayed.",
      ]);
      return;
    case "orchestration-view":
      await host.openOrchestrationView(ctx);
      return;
    case "orchestration-pick":
      await host.pickWorkflow(ctx);
      return;
    case "orchestration-demo":
      ctx.ui.notify(demoNotice(host.toggleOrchestrationDemo()), "info");
      return;
  }
}

export async function openDashboardActionMenu(
  ctx: ConsoleContext,
  pi: ConsolePi,
  host: DashboardActionHost,
): Promise<void> {
  const options = [
    "Open an area",
    ...(host.project === undefined ? ["Register this folder"] : []),
    "Open orchestration view",
    "Pick orchestration workflow",
    host.orchestrationDemo() ? "Orchestration demo off" : "Orchestration demo on",
    "Choose Pi model",
    "Choose reasoning level",
    ...(host.project === undefined
      ? []
      : ["Review approvals", "Inspect tasks", "Queue a goal", "Project events"]),
    ...(host.project !== undefined && host.runtimeAvailable() && host.runtime() === "idle"
      ? ["Run project queue", "Start runtime"]
      : []),
    ...(host.project !== undefined && host.runtimeAvailable() && host.runtime() === "running"
      ? ["Stop shared runtime"]
      : []),
    "Toggle Pi tools",
    "Browse methodologies",
    "Browse HARIL commands",
    "Memory status",
    "View area details",
    "Refresh data",
    "Cancel",
  ];
  // CONSULT hides the actions it would refuse.
  const mode = host.mode?.() ?? "action";
  const shown = options.filter((option) => {
    const action = MENU_ACTIONS[option];
    return action === undefined || actionRefusal(mode, action) === undefined;
  });
  const choice = await ctx.ui.select("HARIL console controls", shown);
  if (choice === undefined || choice === "Cancel") return;
  if (choice === "Open an area") {
    const labels = DASHBOARD_AREAS.map((item) => item.toUpperCase());
    const area = await ctx.ui.select("Dashboard area", labels);
    if (area !== undefined) host.openArea(area.toLowerCase() as DashboardArea);
    return;
  }
  const action = MENU_ACTIONS[choice];
  if (action !== undefined) await runDashboardAction(action, ctx, pi, host);
}

// The /haril menu's options and the actions they run.
const MENU_ACTIONS: Readonly<Record<string, DashboardAction>> = {
  "Register this folder": "register-project",
  "Open orchestration view": "orchestration-view",
  "Pick orchestration workflow": "orchestration-pick",
  "Orchestration demo on": "orchestration-demo",
  "Orchestration demo off": "orchestration-demo",
  "Choose Pi model": "model",
  "Choose reasoning level": "level",
  "Review approvals": "approvals",
  "Inspect tasks": "tasks",
  "Queue a goal": "goal",
  "Run project queue": "run-queue",
  "Project events": "events",
  "Start runtime": "start-runtime",
  "Stop shared runtime": "stop-runtime",
  "Toggle Pi tools": "toggle-tools",
  "Browse methodologies": "methodologies",
  "Browse HARIL commands": "commands",
  "Memory status": "memory",
  "View area details": "details",
  "Refresh data": "refresh",
};
