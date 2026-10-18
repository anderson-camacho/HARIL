import { chooseModel, type ModelRequest } from "@haril/core";
import type { AgentOutcome, ProviderFailure, Store } from "@haril/core/ports";
import { quotaByKey, quotaKeyOf } from "../quota-view.js";
import type { TurnWindowReport } from "./delegation-tools.js";
import { QUOTA_FRESH_MS } from "./model-context.js";
import type { Task, WorkflowSettings, WorkflowView } from "./workflow-view.js";

// A workflow turn's model at its launch and after a provider error (docs/modos-y-delegacion.md 3.11, 8; phase F6).
//   - At its launch: a model the user pinned runs as it is, or the turn waits (blocked with a cooldown) when its cooldown
//     or quota holds it back; it is never replaced. A parent's or the table's model that no longer passes the rules is
//     replaced by the next eligible one (model.substituted), or the turn waits for the earliest end of what holds the
//     models back, within maxWaitMs. When nothing can run within maxWaitMs the workflow fails with no_capacity.
//   - After a provider error: a 402 or 429 cools the model down (until the gateway's Retry-After, else the reset of its
//     quota window when known, else a backoff; a 402 cools its whole account down too, keyed "quota:<quota key>"). Then
//     the turn is retried once: on the next eligible model or account, or after the cooldown. A transient error (5xx,
//     timeout, broken stream) is retried once on the same model. Nothing is retried once the turn's deciding call was
//     accepted, so a decision is never applied twice, and a turn is retried at most once for any provider cause.

// Backoff of a cooldown whose end the gateway did not say (provisional values).
const RATE_LIMIT_BACKOFF_MS = 60_000;
const QUOTA_BACKOFF_MS = 15 * 60_000;
const ENDED = new Set(["completed", "failed", "stopped"]);

function launchRequest(task: Task): ModelRequest {
  return {
    archetype: task.role,
    difficulty: task.difficulty ?? "medium",
    budgetTokens: task.budgetTokens,
    phase: "launch",
    explicit: task.modelPinned ? task.model : null,
    proposed: task.modelPinned ? null : task.model,
  };
}

function capacityText(task: Task, view: WorkflowView, cause: string | null): string {
  return `no model can run the ${task.role} ${view.label(task.threadId)} now or within the wait allowed${cause === null ? "" : ` (${cause})`}`;
}

export type LaunchVerdict =
  | { readonly kind: "run" }
  | { readonly kind: "deferred"; readonly until: number }
  | { readonly kind: "no_capacity"; readonly reason: string };

// Checks a ready turn's model right before its claim, and writes what follows: a replaced model, a wait, or the
// workflow's failure.
export function checkLaunch(
  store: Store,
  epoch: number,
  view: WorkflowView,
  task: Task,
  settings: WorkflowSettings,
  now: number,
): LaunchVerdict {
  const choice = chooseModel(launchRequest(task), settings.models(now));
  if (choice.kind === "use" || choice.kind === "reject") {
    if (choice.kind === "use" && choice.model !== task.model) {
      store.transaction(() => {
        store.workflows.setTurnModel(epoch, task.taskId, choice.model);
        store.events.append({
          aggregateType: "workflow",
          aggregateId: view.workflow.workflowId,
          type: "model.substituted",
          actorKind: "system",
          actorId: "runtime",
          payload: {
            from: task.model,
            to: choice.model,
            archetype: task.role,
            taskId: task.taskId,
          },
          projectId: view.workflow.projectId,
        });
      });
    }
    return { kind: "run" };
  }
  if (choice.kind === "wait") {
    store.workflows.deferTurn(epoch, task.taskId, choice.until);
    return { kind: "deferred", until: choice.until };
  }
  const reason = `no_capacity: ${capacityText(task, view, choice.cause)}`;
  store.workflows.setState(epoch, {
    workflowId: view.workflow.workflowId,
    state: "failed",
    reason,
  });
  return { kind: "no_capacity", reason };
}

export type RetryDecision =
  | {
      readonly kind: "retry";
      readonly model: string;
      readonly cooldownUntil: number | null;
      readonly retryReason: "transient" | "route_failover";
      readonly substitutedFrom: string | null;
      // What the attempt's usage row says.
      readonly outcome: "provider_retry" | "provider_wait";
    }
  | { readonly kind: "no_capacity"; readonly reason: string }
  | { readonly kind: "none" };

// When a cooldown ends: the gateway's Retry-After, else the reset of the model's quota window that passes its threshold,
// else a backoff.
function cooldownEnd(
  store: Pick<Store, "quota">,
  model: string,
  provider: ProviderFailure,
  settings: WorkflowSettings,
  now: number,
): number {
  if (provider.retryAfterMs !== null && provider.retryAfterMs >= 0)
    return now + provider.retryAfterMs;
  if (provider.kind === "quota") {
    const policy = settings.models(now).policy;
    const sample = quotaByKey(store.quota.latest(now - QUOTA_FRESH_MS), policy)[quotaKeyOf(model)];
    if (sample?.available === true) {
      const resets = [
        sample.weeklyUsedPct !== null && sample.weeklyUsedPct > policy.stopAtPercentWeekly
          ? sample.weeklyResetsAt
          : null,
        sample.window5hUsedPct !== null && sample.window5hUsedPct > policy.switchAtPercent5h
          ? sample.window5hResetsAt
          : null,
      ].filter((at): at is number => at !== null && at > now);
      if (resets.length > 0) return Math.max(...resets);
    }
  }
  return now + (provider.kind === "quota" ? QUOTA_BACKOFF_MS : RATE_LIMIT_BACKOFF_MS);
}

// What follows a turn's failed attempt that the gateway caused. Records the cooldown a 402 or 429 starts whatever the
// decision, since the model is held back for every turn.
export function decideProviderRetry(input: {
  readonly store: Store;
  readonly view: WorkflowView;
  readonly task: Task;
  readonly settings: WorkflowSettings;
  readonly outcome: AgentOutcome;
  readonly report: TurnWindowReport;
  readonly now: number;
}): RetryDecision {
  const { store, view, task, settings, outcome, report, now } = input;
  if (outcome.status !== "failed" || outcome.provider === undefined) return { kind: "none" };
  const provider = outcome.provider;
  const model = task.model ?? provider.model;
  if ((provider.kind === "quota" || provider.kind === "rate_limited") && model !== null) {
    const until = cooldownEnd(store, model, provider, settings, now);
    store.quota.setCooldown({ model, until, reason: provider.kind });
    if (provider.kind === "quota") {
      store.quota.setCooldown({
        model: `quota:${quotaKeyOf(model)}`,
        until,
        reason: provider.kind,
      });
    }
  }
  if (
    provider.kind === "fatal" ||
    model === null ||
    report.action !== null ||
    ENDED.has(view.workflow.state) ||
    store.workflows.providerRetries(task.taskId) > 0
  ) {
    return { kind: "none" };
  }
  if (provider.kind === "transient") {
    return {
      kind: "retry",
      model,
      cooldownUntil: null,
      retryReason: "transient",
      substitutedFrom: null,
      outcome: "provider_retry",
    };
  }
  const choice = chooseModel(launchRequest(task), settings.models(now));
  if (choice.kind === "use" || choice.kind === "reject") {
    const next = choice.kind === "use" ? choice.model : model;
    return {
      kind: "retry",
      model: next,
      cooldownUntil: null,
      retryReason: next === model ? "transient" : "route_failover",
      substitutedFrom: next === model ? null : model,
      outcome: "provider_retry",
    };
  }
  if (choice.kind === "wait") {
    return {
      kind: "retry",
      model: choice.model ?? model,
      cooldownUntil: choice.until,
      retryReason: "transient",
      substitutedFrom: null,
      outcome: "provider_wait",
    };
  }
  return { kind: "no_capacity", reason: `no_capacity: ${capacityText(task, view, choice.cause)}` };
}
