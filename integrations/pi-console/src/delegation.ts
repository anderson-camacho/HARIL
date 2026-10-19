import { createHash } from "node:crypto";
import { runHaril, runHarilJson } from "./cli.js";
import { readApproval } from "./dashboard-data.js";
import {
  type CardEffect,
  cardClick,
  cardKey,
  cardProblem,
  createCard,
  type DelegateCard,
  renderCard,
  selectedStops,
  workflowStartArgs,
} from "./delegate-card.js";
import type { ConsoleContext, ConsoleMouseEvent, SessionEntry } from "./pi-types.js";
import type { BoundProject } from "./project.js";
import type { PendingApproval } from "./status.js";
import { plainText } from "./text.js";

// DELEGATION (docs/modos-y-delegacion.md 7.5, 3.13): the /delegate card opens over the terminal, the human confirms it,
// and `haril workflow start … --agent orchestrator` queues the workflow; the runtime is started if none runs and the
// ORCHESTRATION module opens. In DELEGATION mode what the user types opens the same card (the text is the goal); while
// a workflow of the project runs or waits at a stop, typed text is refused with a hint instead (P5), so no instruction
// arrives in the middle of a run. /continue lifts the stop a workflow waits at.

const DEFAULT_MODEL_ENV = "HARIL_DEFAULT_MODEL";
const MODEL_TITLE = "Orchestrator model · pick a high model";

export interface DelegationHost {
  readonly cwd: string;
  readonly project: BoundProject | undefined;
  readonly pending: readonly PendingApproval[];
  currentPlan(): string | undefined;
  createPlan(ctx: ConsoleContext): void;
  consult(ctx: ConsoleContext): void;
  // The current Pi model as a HARIL reference, the card's default.
  harilModelRef(): string | undefined;
  // Every model a HARIL provider serves, as <provider>/<model>, for the card's model choice.
  harilModels(): readonly string[];
  // Starts a runtime when none runs; returns what the notification adds.
  ensureRuntime(): Promise<string | undefined>;
  openArea(area: "orchestration"): void;
}

interface WorkflowRow {
  readonly workflowId: string;
  readonly projectId: string;
  readonly state: string;
  readonly stopReason: string | null;
  readonly goal: string;
  readonly intake: {
    readonly plan: {
      readonly sourceId: string;
      readonly revision: string | null;
      readonly sha256: string;
    };
  } | null;
}

function firstLine(text: string): string {
  return plainText(text.trim().split(/\r?\n/)[0] ?? "").trim();
}

function projectArgs(host: { readonly project: BoundProject | undefined }): string[] {
  return host.project === undefined ? [] : ["--project", host.project.slug];
}

// The text of the user's last chat message in the session's branch: /delegate without a goal takes it.
export function lastUserText(entries: readonly SessionEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.message;
    if (entries[index]?.type !== "message" || message?.role !== "user") continue;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text ?? "")
              .join("\n")
          : "";
    if (text.trim() !== "") return text.trim();
  }
  return undefined;
}

// The workflows of the project, newest last; undefined when the CLI cannot answer.
async function listWorkflows(host: {
  readonly cwd: string;
  readonly project: BoundProject | undefined;
}): Promise<WorkflowRow[] | undefined> {
  const listed = await runHarilJson(["workflow", "list", "--json", ...projectArgs(host)]);
  if (!Array.isArray(listed)) return undefined;
  return (listed as Record<string, unknown>[])
    .filter((row) => typeof row.workflowId === "string" && typeof row.state === "string")
    .map((row) => ({
      workflowId: row.workflowId as string,
      projectId: typeof row.projectId === "string" ? row.projectId : "",
      state: row.state as string,
      stopReason: typeof row.stopReason === "string" ? row.stopReason : null,
      goal: typeof row.goal === "string" ? row.goal : "",
      intake:
        typeof row.intake === "object" &&
        row.intake !== null &&
        typeof (row.intake as { plan?: { sourceId?: unknown } }).plan?.sourceId === "string"
          ? (row.intake as WorkflowRow["intake"])
          : null,
    }));
}

interface SelectedPlan {
  readonly sourceId: string;
  readonly revision: string | null;
  readonly text: string;
}

async function selectPlan(
  ctx: ConsoleContext,
  host: DelegationHost,
): Promise<SelectedPlan | undefined> {
  const project = host.project;
  if (project === undefined) {
    ctx.ui.notify("Select a registered project first: /init registers this folder", "warning");
    return undefined;
  }
  const options = [
    "Create a plan in PLAN mode",
    "Select an existing or prior plan",
    "Use an explicit current conversation or console plan",
    "Continue read-only consultation",
  ];
  const choice = await ctx.ui.select("Select an exact plan source before starting", options);
  if (choice === options[0]) {
    host.createPlan(ctx);
    ctx.ui.notify("Write an explicit plan in PLAN mode, then use /delegate again", "info");
    return undefined;
  }
  if (choice === options[3]) {
    host.consult(ctx);
    ctx.ui.notify("CONSULT mode remains read-only; no workflow was started", "info");
    return undefined;
  }
  if (choice === options[2]) {
    const existing = host.currentPlan();
    const text = existing?.trim()
      ? existing
      : await ctx.ui.input("Enter the exact plan and tasks", "No generic goal or placeholder plan");
    if (text === undefined || text.trim() === "") {
      ctx.ui.notify("No explicit plan was selected; no workflow was started", "warning");
      return undefined;
    }
    return { sourceId: `console:${ctx.sessionManager.getSessionId()}`, revision: null, text };
  }
  if (choice !== options[1]) return undefined;
  const workflows = await listWorkflows(host);
  if (workflows === undefined) {
    ctx.ui.notify("Prior workflows could not be read; no plan was selected", "error");
    return undefined;
  }
  const listed = await runHarilJson(["approvals", "--all", "--json", "--project", project.slug]);
  const approvals = Array.isArray(listed)
    ? (listed as Record<string, unknown>[])
        .filter(
          (row) =>
            row.projectSlug === project.slug &&
            typeof row.approvalId === "string" &&
            typeof row.tasks === "number" &&
            row.tasks > 0,
        )
        .map((row) => row.approvalId as string)
    : host.pending.filter((row) => row.projectSlug === project.slug).map((row) => row.approvalId);
  const prior = workflows.filter((row) => row.intake?.plan.sourceId.trim());
  const choices = [
    ...approvals.map((approvalId) => `Approval ${approvalId}`),
    ...prior.map((row) => `Workflow ${row.workflowId}`),
  ];
  if (choices.length === 0) {
    ctx.ui.notify("No existing plan was found for this project; create one first", "warning");
    return undefined;
  }
  const picked = await ctx.ui.select("Select a plan from this project", choices);
  const index = choices.indexOf(picked ?? "");
  if (index < 0) return undefined;
  if (index < approvals.length) {
    const approvalId = approvals[index];
    const approval =
      approvalId === undefined ? undefined : await readApproval(project.slug, approvalId);
    const plan = approval?.plan;
    if (
      typeof plan !== "object" ||
      plan === null ||
      !Array.isArray((plan as { tasks?: unknown }).tasks) ||
      (plan as { tasks: unknown[] }).tasks.length === 0
    ) {
      ctx.ui.notify(
        "The selected approval has no readable tasks; no workflow was started",
        "error",
      );
      return undefined;
    }
    return { sourceId: `approval:${approvalId}`, revision: null, text: JSON.stringify(plan) };
  }
  const workflow = prior[index - approvals.length];
  if (workflow === undefined) return undefined;
  const details = await runHarilJson(["workflow", "show", workflow.workflowId, "--intake-json"]);
  if (typeof details !== "object" || details === null) return undefined;
  const payload = details as {
    workflowId?: unknown;
    projectId?: unknown;
    intake?: { plan?: SelectedPlan };
  };
  const selected = payload.intake?.plan;
  if (
    payload.workflowId !== workflow.workflowId ||
    payload.projectId !== workflow.projectId ||
    selected === undefined ||
    selected.sourceId !== workflow.intake?.plan.sourceId ||
    typeof selected.text !== "string" ||
    selected.text.trim() === "" ||
    createHash("sha256").update(selected.text, "utf8").digest("hex") !==
      workflow.intake?.plan.sha256
  ) {
    ctx.ui.notify("The prior plan could not be verified; no workflow was started", "error");
    return undefined;
  }
  return {
    sourceId: `workflow:${workflow.workflowId}`,
    revision: workflow.intake?.plan.sha256 ?? null,
    text: selected.text,
  };
}

async function selectMethodology(ctx: ConsoleContext): Promise<
  | {
      readonly id: string;
      readonly instructions: string;
    }
  | undefined
> {
  const names = ["ODD", "SDD", "Gentle AI", "Custom / user-supplied"];
  const choice = await ctx.ui.select(
    "Choose a methodology and supply its exact instructions",
    names,
  );
  if (choice === undefined || !names.includes(choice)) return undefined;
  const instructions = await ctx.ui.input(
    `Exact ${choice} instructions for this workflow`,
    "A framework label alone is not executable instructions",
  );
  if (instructions === undefined || instructions.trim() === "") {
    ctx.ui.notify("Methodology instructions are required; no workflow was started", "warning");
    return undefined;
  }
  return { id: choice === names[3] ? "custom" : choice, instructions };
}

// The card over the terminal until the human starts or cancels it; M asks for the model and comes back to the card.
async function confirmInOverlay(
  ctx: ConsoleContext,
  card: DelegateCard,
  models: readonly string[],
): Promise<DelegateCard | undefined> {
  let current = card;
  for (;;) {
    const result = await ctx.ui.custom<{ effect: CardEffect; card: DelegateCard }>(
      (tui, theme, _keybindings, done) => {
        let hits: ReturnType<typeof renderCard>["hits"] = [];
        let finished = false;
        const apply = (step: { card: DelegateCard; effect?: CardEffect }): void => {
          current = step.card;
          if (step.effect !== undefined && !finished) {
            finished = true;
            done({ effect: step.effect, card: current });
            return;
          }
          tui.requestRender();
        };
        return {
          render(width) {
            const drawn = renderCard(current, Math.max(1, width), theme);
            hits = drawn.hits;
            return drawn.lines;
          },
          handleInput(data) {
            const step = cardKey(current, data);
            if (step.handled) apply(step);
          },
          handleMouse(event: ConsoleMouseEvent) {
            if (event.type !== "click" || event.button !== "left") return undefined;
            const hit = hits.find(
              (item) => item.row === event.y && event.x >= item.start && event.x < item.end,
            );
            if (hit === undefined) return undefined;
            apply(cardClick(current, hit.target));
            return { handled: true, render: true };
          },
          invalidate() {},
        };
      },
      { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } },
    );
    current = result.card;
    if (result.effect !== "choose-model") return result.effect === "start" ? current : undefined;
    if (models.length === 0) {
      ctx.ui.notify(
        "No HARIL model is available yet: haril models lists them once a provider answers.",
        "warning",
      );
      continue;
    }
    const picked = await ctx.ui.select(MODEL_TITLE, [...models]);
    if (picked !== undefined) current = { ...current, model: picked };
  }
}

// Without the terminal UI (RPC clients): the card as a confirmation dialog.
async function confirmInDialog(
  ctx: ConsoleContext,
  card: DelegateCard,
): Promise<DelegateCard | undefined> {
  const problem = cardProblem(card);
  if (problem !== undefined) {
    ctx.ui.notify(
      `Delegation needs ${problem}; set ${DEFAULT_MODEL_ENV} or pick a HARIL model with /model`,
      "warning",
    );
    return undefined;
  }
  const stops = selectedStops(card);
  const confirmed = await ctx.ui.confirm(
    "Start a three-layer workflow with real agents",
    [
      `Goal: ${card.goal}`,
      `Orchestrator model: ${card.model}`,
      `Autonomy: ${stops.length === 0 ? "autonomous, no stops" : `stops at ${stops.join(", ")}`}`,
      `Mode: Implementation; base ${card.preflight?.baseBranch ?? "unverified"}`,
      `Test command: ${card.preflight?.testCommand ?? "unverified"} allowed, not run; worktree creation pending runtime.`,
      "Agents may add stops; only you remove them (/continue).",
    ].join("\n"),
  );
  return confirmed ? card : undefined;
}

// Opens the card for `goal` and starts the workflow the human confirms.
export async function startDelegation(
  goal: string,
  ctx: ConsoleContext,
  host: DelegationHost,
): Promise<void> {
  if (!ctx.hasUI) return;
  const plan = await selectPlan(ctx, host);
  if (plan === undefined) return;
  const methodology = await selectMethodology(ctx);
  if (methodology === undefined) return;
  const project = host.project;
  if (project === undefined) return;
  const fallback = process.env[DEFAULT_MODEL_ENV]?.trim();
  const initial = createCard(
    goal,
    host.harilModelRef() ?? (fallback === "" ? undefined : fallback),
  );
  const input = JSON.stringify({ projectRoot: project.rootPath, plan, methodology });
  const preflightArgs = [
    "workflow",
    "start",
    "--preflight",
    ...workflowStartArgs(initial, project.slug).slice(2),
  ];
  const checked = await runHaril(preflightArgs, { cwd: host.cwd, input });
  if (!checked.ok) {
    ctx.ui.notify(firstLine(checked.stderr) || "haril workflow preflight failed", "error");
    return;
  }
  let capabilities: { baseBranch: string; testCommand: string } | undefined;
  try {
    const reply = JSON.parse(checked.stdout) as {
      mode?: unknown;
      status?: unknown;
      capabilities?: Record<string, unknown>;
    };
    const available = reply.capabilities;
    if (
      reply.mode === "implementation" &&
      reply.status === "ready" &&
      available?.writing === true &&
      available.worktreeList === true &&
      available.worktreeCreated === false &&
      available.testsRun === false &&
      typeof available.baseBranch === "string" &&
      typeof available.testCommand === "string"
    ) {
      capabilities = { baseBranch: available.baseBranch, testCommand: available.testCommand };
    }
  } catch {
    // An invalid preflight response is not permission to present an implementation confirmation.
  }
  if (capabilities === undefined) {
    ctx.ui.notify(
      "HARIL could not verify implementation preflight; no workflow was started",
      "error",
    );
    return;
  }
  const card = createCard(goal, initial.model, capabilities);
  const confirmed =
    ctx.mode === "tui"
      ? await confirmInOverlay(ctx, card, host.harilModels())
      : await confirmInDialog(ctx, card);
  if (confirmed === undefined) {
    ctx.ui.notify("Delegation cancelled: no workflow was started", "info");
    return;
  }
  const result = await runHaril(workflowStartArgs(confirmed, project.slug), {
    cwd: host.cwd,
    input,
  });
  if (!result.ok) {
    ctx.ui.notify(firstLine(result.stderr) || "haril workflow start failed", "error");
    return;
  }
  let commandId: string | undefined;
  let queuedImplementation = false;
  try {
    const reply = JSON.parse(result.stdout) as {
      commandId?: unknown;
      status?: unknown;
      mode?: unknown;
      capabilities?: { writing?: unknown; worktreeList?: unknown; testCommand?: unknown };
    };
    commandId = typeof reply.commandId === "string" ? reply.commandId : undefined;
    queuedImplementation =
      reply.status === "queued" &&
      reply.mode === "implementation" &&
      reply.capabilities?.writing === true &&
      reply.capabilities.worktreeList === true &&
      typeof reply.capabilities.testCommand === "string";
  } catch {
    commandId = undefined;
  }
  if (!queuedImplementation) {
    ctx.ui.notify(
      "HARIL queued a command but its implementation response could not be verified; inspect workflow status",
      "error",
    );
    return;
  }
  const stops = selectedStops(confirmed);
  const runtime = await host.ensureRuntime();
  const parts = [
    `workflow queued${commandId === undefined ? "" : ` (command ${commandId})`} with real agents on ${confirmed.model}`,
    stops.length === 0 ? "autonomous" : `stops: ${stops.join(", ")}`,
    runtime,
  ];
  ctx.ui.notify(parts.filter((part) => part !== undefined).join(" · "), "info");
  host.openArea("orchestration");
}

// A message typed in DELEGATION mode: the card for it, unless a workflow of the project runs or waits (P5).
export async function delegateFromChat(
  text: string,
  ctx: ConsoleContext,
  host: DelegationHost,
): Promise<void> {
  const workflows = await listWorkflows(host);
  const busy = workflows?.find((row) => row.state === "running" || row.state === "awaiting_human");
  if (busy !== undefined) {
    ctx.ui.notify(
      busy.state === "running"
        ? `Workflow ${busy.workflowId} is running: typed text is not sent while it runs. Follow it in ORCHESTRATION (Alt+O); ■ STOP ALL (Alt+X) stops it.`
        : `Workflow ${busy.workflowId} waits at ${busy.stopReason ?? "a stop"}: /continue lifts the stop; typed text is not sent meanwhile.`,
      "warning",
    );
    return;
  }
  await startDelegation(text, ctx, host);
}

// The closed stop vocabulary (contracts STOP_PATTERN), for /continue's stops to remove.
const STOP =
  /^(after_plan|before_merge|on_audit_failure|at_end|after_node:[A-Za-z0-9_-]{1,64}|on_budget_pct:(100|[1-9][0-9]?))$/;

// /continue [workflowId] [stop…]: lifts the stop a workflow waits at, removing the stops named (only the human removes
// stops). Without an id: the project's only waiting workflow, or a choice among them.
export async function continueWorkflow(
  args: string,
  ctx: ConsoleContext,
  host: Omit<DelegationHost, "harilModels" | "harilModelRef" | "openArea">,
): Promise<void> {
  const words = plainText(args)
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  const remove = words.filter((word) => STOP.test(word));
  const ids = words.filter((word) => !STOP.test(word));
  if (ids.length > 1) {
    ctx.ui.notify("usage: /continue [workflowId] [stop to remove]…", "warning");
    return;
  }
  let workflowId = ids[0];
  if (workflowId === undefined) {
    const waiting = (await listWorkflows(host))?.filter((row) => row.state === "awaiting_human");
    if (waiting === undefined) {
      ctx.ui.notify("The workflows could not be read: haril workflow list failed", "error");
      return;
    }
    if (waiting.length === 0) {
      ctx.ui.notify("No workflow waits for you", "info");
      return;
    }
    if (waiting.length === 1) workflowId = waiting[0]?.workflowId;
    else {
      const options = waiting.map(
        (row) =>
          `${row.workflowId} · at ${row.stopReason ?? "a stop"} · ${plainText(row.goal).slice(0, 60)}`,
      );
      const choice = await ctx.ui.select("Continue which workflow?", options);
      workflowId = waiting[options.indexOf(choice ?? "")]?.workflowId;
    }
  }
  if (workflowId === undefined) return;
  const result = await runHaril(
    [
      "workflow",
      "continue",
      workflowId,
      ...remove.flatMap((stop) => ["--remove-stop", stop]),
      ...projectArgs(host),
    ],
    { cwd: host.cwd },
  );
  if (!result.ok) {
    ctx.ui.notify(firstLine(result.stderr) || "haril workflow continue failed", "error");
    return;
  }
  const runtime = await host.ensureRuntime();
  const removed = remove.length === 0 ? "" : ` · removed: ${remove.join(", ")}`;
  ctx.ui.notify(
    `workflow ${workflowId} continues${removed}${runtime === undefined ? "" : ` · ${runtime}`}`,
    "info",
  );
}
