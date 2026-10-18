import { runHaril, runHarilJson } from "./cli.js";
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
  readonly state: string;
  readonly stopReason: string | null;
  readonly goal: string;
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
      state: row.state as string,
      stopReason: typeof row.stopReason === "string" ? row.stopReason : null,
      goal: typeof row.goal === "string" ? row.goal : "",
    }));
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
  const fallback = process.env[DEFAULT_MODEL_ENV]?.trim();
  const card = createCard(goal, host.harilModelRef() ?? (fallback === "" ? undefined : fallback));
  const confirmed =
    ctx.mode === "tui"
      ? await confirmInOverlay(ctx, card, host.harilModels())
      : await confirmInDialog(ctx, card);
  if (confirmed === undefined) {
    ctx.ui.notify("Delegation cancelled: no workflow was started", "info");
    return;
  }
  const result = await runHaril(workflowStartArgs(confirmed, host.project?.slug), {
    cwd: host.cwd,
  });
  if (!result.ok) {
    ctx.ui.notify(firstLine(result.stderr) || "haril workflow start failed", "error");
    return;
  }
  let commandId: string | undefined;
  try {
    const reply = JSON.parse(result.stdout) as { commandId?: unknown };
    commandId = typeof reply.commandId === "string" ? reply.commandId : undefined;
  } catch {
    commandId = undefined;
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
