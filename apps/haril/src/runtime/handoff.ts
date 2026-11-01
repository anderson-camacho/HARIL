import { chooseModel, contextActionOf } from "@haril/core";
import type { DelegationHandoffView, Store } from "@haril/core/ports";
import { quotaByKey } from "../quota-view.js";
import {
  resultText,
  type Task,
  type WorkflowSettings,
  type WorkflowView,
} from "./workflow-view.js";

// A handoff (feature haril-factory, F7): an agent whose account passed the 5-hour threshold, or whose context filled when
// its role starts over rather than compacts, leaves at its next safe point, and another agent continues the same task in
// the same worktree on a model the role's list chooses. What it leaves is kept with the `handoff` event, in one
// transaction with its retry, and comes back in the next agent's prompt. A provider's 429 leaves the same way, from the
// last saved point. Handoffs per task are capped.

export type HandoffReason = "quota" | "context" | "rate_limited";

const REASON_TEXT: Readonly<Record<HandoffReason, string>> = {
  quota: "its account passed the 5-hour threshold",
  context: "its context filled",
  rate_limited: "the provider answered 429",
};

export function handoffCount(store: Pick<Store, "events">, task: Task): number {
  return store.events.list({ aggregateId: task.taskId }).filter((event) => event.type === "handoff")
    .length;
}

// Whether the turn's account and group passed the threshold; false when nothing is known.
export function quotaPassed(
  task: Task,
  settings: WorkflowSettings,
  now: number,
): boolean {
  if (task.model === null) return false;
  const context = settings.models(now);
  const entry = context.catalog.find((row) => row.ref === task.model);
  if (entry === undefined) return false;
  const sample = context.quota[entry.quotaKey];
  return (
    sample?.available === true &&
    sample.window5hUsedPct !== null &&
    sample.window5hUsedPct >= context.policy.switchAtPercent5h
  );
}

export function contextPassed(
  view: WorkflowView,
  task: Task,
  used: number | null,
  threshold: number | null,
): boolean {
  return (
    used !== null &&
    threshold !== null &&
    threshold > 0 &&
    used >= threshold &&
    contextActionOf(view.roleOf(task)) === "new_agent"
  );
}

// The model the next agent runs on: the role's list without this one for a quota reason, any fresh one for a context
// reason. null: nothing can take it now, and the stop that follows says who holds the models.
export function successorOf(
  view: WorkflowView,
  task: Task,
  settings: WorkflowSettings,
  reason: HandoffReason,
  now: number,
): string | null {
  const context = settings.models(now);
  const choice = chooseModel(
    {
      archetype: task.role,
      difficulty: task.difficulty ?? "medium",
      budgetTokens: task.budgetTokens,
      phase: "launch",
      proposed: null,
      role: view.roleOf(task),
      avoid: reason === "context" ? null : task.model,
    },
    context,
  );
  if (choice.kind !== "use") return null;
  if (reason !== "context" && choice.model === task.model) return null;
  return choice.model;
}

function filesTouched(
  store: Pick<Store, "events">,
  task: Task,
): { paths: string[]; commit: string | null } {
  const paths = new Set<string>();
  let commit: string | null = null;
  for (const event of store.events.list({ taskId: task.taskId })) {
    if (event.type !== "worktree.committed") continue;
    const payload = event.payload as { paths?: unknown; sha?: unknown };
    if (Array.isArray(payload.paths)) {
      for (const path of payload.paths) if (typeof path === "string") paths.add(path);
    }
    if (typeof payload.sha === "string") commit = payload.sha;
  }
  return { paths: [...paths], commit };
}

export function handoffPackage(
  store: Pick<Store, "events">,
  view: WorkflowView,
  task: Task,
  from: string,
  reason: HandoffReason,
  transcript: string | null,
): DelegationHandoffView {
  const turns = view.turns(task.threadId);
  const done = [...turns].reverse().find((turn) => turn.state === "completed");
  const assignment = view.assignmentOf(task.threadId);
  const touched = filesTouched(store, task);
  return {
    from,
    reason: REASON_TEXT[reason],
    objective: task.goal,
    done: resultText(done?.result ?? null),
    pending: assignment?.acceptanceCriteria ?? [],
    decisions: view.memoOf(task.threadId),
    filesTouched: touched.paths,
    diffSummary:
      touched.commit === null
        ? null
        : `${touched.paths.length} files in commit ${touched.commit.slice(0, 12)}`,
    transcript,
  };
}

export function recordHandoff(
  store: Pick<Store, "events">,
  view: WorkflowView,
  task: Task,
  input: {
    readonly from: string;
    readonly to: string;
    readonly reason: HandoffReason;
    readonly transcript: string | null;
    readonly runId?: string;
  },
): void {
  store.events.append({
    aggregateType: "task",
    aggregateId: task.taskId,
    type: "handoff",
    actorKind: "system",
    actorId: "runtime",
    payload: {
      workflowId: view.workflow.workflowId,
      from: input.from,
      to: input.to,
      reason: input.reason,
      text: `${view.label(task.threadId)} pasa de ${input.from} a ${input.to}`,
      package: handoffPackage(
        store,
        view,
        task,
        input.from,
        input.reason,
        input.transcript,
      ) as never,
    },
    projectId: view.workflow.projectId,
    taskId: task.taskId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  });
}

// The package this attempt continues from: the newest handoff of this task, unless a later attempt already read it.
export function latestHandoff(
  store: Pick<Store, "events">,
  task: Task,
): DelegationHandoffView | null {
  const events = store.events.list({ aggregateId: task.taskId });
  const last = [...events].reverse().find((event) => event.type === "handoff");
  const kept = (last?.payload as { package?: DelegationHandoffView } | undefined)?.package;
  return kept ?? null;
}

// Re-exported for the checks of the quota tab.
export { quotaByKey };
