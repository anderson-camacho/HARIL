import { cliAvailable, NOT_LAUNCHED, runHaril, type StartedRuntime, startRuntime } from "./cli.js";
import type { AutocompleteItem, ConsoleContext, ConsolePi } from "./pi-types.js";
import { type BoundProject, folderName } from "./project.js";
import { type PendingApproval, readPending, readRuntimeAlive } from "./status.js";
import { plainText } from "./text.js";

// The HARIL commands of the console. Each one runs the `haril` CLI (cli.ts) on the project of the folder Pi opened
// in, so the CLI's validation and the store's rules decide, exactly as in a terminal. A multi-line answer is shown
// above the editor until the next prompt; a one-line answer is a notification. None of the names is a Pi command.

const DEFAULT_MODEL_ENV = "HARIL_DEFAULT_MODEL";
const PLANNER = "planner";
const SIMULATED_PLANNER = "fake:plan";
const EVENTS_LIMIT = "20";
const NO_PROJECT = "this folder is not a HARIL project: /init registers it";

// What the commands need from the console: its project, its pending plans and its output area.
export interface CommandHost {
  readonly cwd: string;
  readonly project: BoundProject | undefined;
  readonly pending: readonly PendingApproval[];
  started: StartedRuntime | undefined;
  // The current Pi model as a HARIL reference (<provider>/<model>) when a HARIL provider serves it.
  harilModelRef(): string | undefined;
  showOutput(title: string, lines: readonly string[]): void;
  clearOutput(): void;
  // Binds the folder's project again (after /init).
  rebind(): Promise<void>;
  // Reads the pending plans and the runtime again and redraws the bar.
  refresh(): Promise<void>;
}

interface CommandSpec {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly completesApprovals?: boolean;
  // Runs without the CLI (the help).
  readonly local?: boolean;
  run(args: string, host: CommandHost, ctx: ConsoleContext): Promise<void>;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line !== "" || (index > 0 && index < all.length - 1));
}

function firstLine(text: string): string {
  return plainText(lines(text)[0] ?? "").trim();
}

function projectArgs(host: CommandHost): string[] {
  return host.project === undefined ? [] : ["--project", host.project.slug];
}

// Runs one CLI command and shows its answer: the error line on a failure, the output otherwise. True on success.
async function runAndShow(
  ctx: ConsoleContext,
  host: CommandHost,
  args: readonly string[],
  options: { readonly title?: string; readonly widget?: boolean } = {},
): Promise<boolean> {
  const result = await runHaril(args, { cwd: host.cwd });
  if (!result.ok) {
    ctx.ui.notify(firstLine(result.stderr) || `haril ${args[0]} failed`, "error");
    return false;
  }
  const output = lines(result.stdout);
  if (options.widget === true || output.length > 1) {
    host.showOutput(options.title ?? args.join(" "), output);
  } else {
    ctx.ui.notify(firstLine(result.stdout) || "done", "info");
  }
  return true;
}

// Starts a runtime when none holds the lease and the console did not just start one (LD-T6, as haril shell does).
// Returns what the notification adds: nothing when a runtime already runs.
async function ensureRuntime(host: CommandHost): Promise<string | undefined> {
  const alive = await readRuntimeAlive(host.project?.slug);
  if (alive === true) return undefined;
  if (host.started?.running === true) return `runtime starting (pid ${host.started.pid})`;
  if (alive === undefined) return "the runtime state could not be read; haril start runs the work";
  const started = startRuntime();
  if ("error" in started) return `could not start the runtime: ${started.error}`;
  host.started = started;
  return `runtime started (pid ${started.pid}), output in ${started.log}`;
}

// The pending plan an /approve, /deny or /plan names: the one whose id starts with `id`, or without one the only
// pending plan. Anything else is a message and nothing runs.
async function choosePlan(
  verb: string,
  id: string,
  host: CommandHost,
  ctx: ConsoleContext,
): Promise<string | undefined> {
  const plans = (await readPending(host.project?.slug)) ?? host.pending;
  if (id !== "") {
    const wanted = id.toLowerCase();
    const found = plans.filter((plan) => plan.approvalId.toLowerCase().startsWith(wanted));
    if (found.length === 1) return found[0]?.approvalId;
    ctx.ui.notify(
      found.length === 0
        ? `no pending plan matches ${id}`
        : `several pending plans start with ${id}: type more of the id`,
      "warning",
    );
    return undefined;
  }
  if (plans.length === 1) return plans[0]?.approvalId;
  ctx.ui.notify(
    plans.length === 0
      ? "no plan waits for approval"
      : `${plans.length} plans wait for approval: /${verb} <id> (see /plans)`,
    "warning",
  );
  return undefined;
}

async function decide(
  verb: "approve" | "deny",
  args: string,
  host: CommandHost,
  ctx: ConsoleContext,
): Promise<void> {
  const approvalId = await choosePlan(verb, args.trim(), host, ctx);
  if (approvalId === undefined) return;
  const result = await runHaril([verb, approvalId], { cwd: host.cwd });
  if (!result.ok) {
    ctx.ui.notify(firstLine(result.stderr) || `haril ${verb} failed`, "error");
    return;
  }
  const note = verb === "approve" ? await ensureRuntime(host) : undefined;
  const message = firstLine(result.stdout) || `plan ${approvalId.slice(0, 8)} ${verb}d`;
  ctx.ui.notify(note === undefined ? message : `${message} · ${note}`, "info");
}

// The planner of a goal: planner with the current HARIL model, else planner with HARIL_DEFAULT_MODEL, else the
// simulated planner, which needs no model and says so.
function plannerArgs(host: CommandHost): { readonly args: string[]; readonly note?: string } {
  const ref = host.harilModelRef();
  if (ref !== undefined) return { args: ["--agent", PLANNER, "--model", ref] };
  const fallback = process.env[DEFAULT_MODEL_ENV]?.trim();
  if (fallback !== undefined && fallback !== "") {
    return { args: ["--agent", PLANNER, "--model", fallback] };
  }
  return {
    args: ["--agent", SIMULATED_PLANNER],
    note: `the simulated planner (${SIMULATED_PLANNER}) writes it: pick a HARIL model with /model or set ${DEFAULT_MODEL_ENV}`,
  };
}

const COMMANDS: readonly CommandSpec[] = [
  {
    name: "haril",
    usage: "/haril",
    description: "List the HARIL commands",
    local: true,
    async run(_args, host) {
      host.showOutput(
        "haril",
        COMMANDS.map((command) => `${command.usage.padEnd(16)} ${command.description}`),
      );
    },
  },
  {
    name: "init",
    usage: "/init [name]",
    description: "Register this folder as a HARIL project",
    async run(args, host, ctx) {
      const name = plainText(args).trim() || folderName(host.cwd);
      const ok = await runAndShow(
        ctx,
        host,
        ["project", "init", host.cwd, "--name", name, "--yes"],
        { title: "project init" },
      );
      if (ok) await host.rebind();
    },
  },
  {
    name: "goal",
    usage: "/goal <text>",
    description: "Ask the planner for a plan to reach a goal; it waits for /approve",
    async run(args, host, ctx) {
      const goal = plainText(args).trim();
      if (goal === "") {
        ctx.ui.notify("usage: /goal <what you want done>", "warning");
        return;
      }
      if (host.project === undefined) {
        ctx.ui.notify(NO_PROJECT, "warning");
        return;
      }
      const planner = plannerArgs(host);
      const result = await runHaril(
        ["task", "add", goal, ...projectArgs(host), "--kind", "plan", ...planner.args],
        { cwd: host.cwd },
      );
      if (!result.ok) {
        ctx.ui.notify(firstLine(result.stderr) || "haril task add failed", "error");
        return;
      }
      const runtime = await ensureRuntime(host);
      const parts = [firstLine(result.stdout) || "goal queued", planner.note, runtime];
      ctx.ui.notify(parts.filter((part) => part !== undefined).join(" · "), "info");
    },
  },
  {
    name: "plans",
    usage: "/plans",
    description: "The plans that wait for approval",
    async run(_args, host, ctx) {
      await runAndShow(ctx, host, ["approvals", ...projectArgs(host)], { title: "approvals" });
    },
  },
  {
    name: "plan",
    usage: "/plan <id>",
    description: "One plan with every task, to read before /approve",
    completesApprovals: true,
    async run(args, host, ctx) {
      const approvalId = await choosePlan("plan", args.trim(), host, ctx);
      if (approvalId === undefined) return;
      await runAndShow(ctx, host, ["approvals", "show", approvalId], { widget: true });
    },
  },
  {
    name: "approve",
    usage: "/approve [id]",
    description: "Approve a plan (the only pending one without an id)",
    completesApprovals: true,
    run: (args, host, ctx) => decide("approve", args, host, ctx),
  },
  {
    name: "deny",
    usage: "/deny [id]",
    description: "Deny a plan (the only pending one without an id)",
    completesApprovals: true,
    run: (args, host, ctx) => decide("deny", args, host, ctx),
  },
  {
    name: "tasks",
    usage: "/tasks",
    description: "The project's tasks, queued commands and runtime",
    async run(_args, host, ctx) {
      await runAndShow(ctx, host, ["status", ...projectArgs(host)], { widget: true });
    },
  },
  {
    name: "task",
    usage: "/task <id>",
    description: "One task with its result, error and tokens",
    async run(args, host, ctx) {
      const id = args.trim();
      if (id === "") {
        ctx.ui.notify("usage: /task <taskId> (see /tasks)", "warning");
        return;
      }
      await runAndShow(ctx, host, ["task", "show", id], { widget: true });
    },
  },
  {
    name: "events",
    usage: "/events",
    description: "The newest events of the project",
    async run(_args, host, ctx) {
      await runAndShow(ctx, host, ["events", ...projectArgs(host), "--limit", EVENTS_LIMIT], {
        widget: true,
      });
    },
  },
];

function approvalCompletions(host: CommandHost | undefined, prefix: string): AutocompleteItem[] {
  const wanted = prefix.trim().toLowerCase();
  return (host?.pending ?? [])
    .filter((plan) => plan.approvalId.toLowerCase().startsWith(wanted))
    .map((plan) => ({
      value: plan.approvalId,
      label: plan.approvalId.slice(0, 8),
      description: `${plan.projectSlug} · ${plan.tasks} tasks · model ${plan.model ?? "none"}`,
    }));
}

// Registers every command. `host()` is the console of the current session, undefined before it starts.
export function registerCommands(pi: ConsolePi, host: () => CommandHost | undefined): void {
  for (const command of COMMANDS) {
    pi.registerCommand(command.name, {
      description: `HARIL: ${command.description}`,
      ...(command.completesApprovals === true
        ? { getArgumentCompletions: (prefix: string) => approvalCompletions(host(), prefix) }
        : {}),
      async handler(args, ctx) {
        const current = host();
        if (current === undefined) return;
        if (command.local !== true && !cliAvailable()) {
          ctx.ui.notify(NOT_LAUNCHED, "error");
          return;
        }
        current.clearOutput();
        try {
          await command.run(args, current, ctx);
        } finally {
          await current.refresh();
        }
      },
    });
  }
}
