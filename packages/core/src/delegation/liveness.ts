import type { WorkflowState } from "@haril/contracts";

// The residual-task watchdog (docs/modos-y-delegacion.md 3.16, reading L2). Every intervalMs, layer 1 "asks" each
// live layer-2 thread, layer 2 asks each live layer-3 attempt, and the workflow asks itself: are you still working?
// The one asking is code, not a model: a thread that delegated has no live process to ask, a Pi attempt takes a
// single prompt, and a stuck model could answer "still working". The answer comes from objective facts gathered by an
// adapter (the Broker's ledger, run and tool events, child state changes and, from F8, worktree files).

export interface WatchdogPolicy {
  readonly intervalMs: number;
  // Evaluations in a row without progress before an idle entity is closed (1 closes on the first one).
  readonly idleStrikesToClose: number;
  readonly closeResidualImmediately: boolean;
}

// P16: every 15 minutes; one evaluation without progress closes; residuals are closed at once.
export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicy = Object.freeze({
  intervalMs: 900_000,
  idleStrikesToClose: 1,
  closeResidualImmediately: true,
});

export interface LivenessEvidence {
  // An attempt of layer 3, a layer-2 thread (judged by its subtree), or the workflow itself.
  readonly kind: "attempt" | "thread" | "workflow";
  readonly workflowState: WorkflowState;
  // Its parent is terminal, so nobody will consume its result.
  readonly parentTerminal: boolean;
  // A human stop is pending (awaiting_human): the wait is intentional.
  readonly awaitingHuman: boolean;
  // End of a quota cooldown, or null.
  readonly coolingUntil: number | null;
  // Start of the window being judged: the previous evaluation, or the entity's start.
  readonly windowStart: number;
  // Progress signals, aggregated over the subtree for a thread.
  readonly tokensInWindow: number;
  readonly lastToolCallAt: number | null;
  readonly lastChildChangeAt: number | null;
  readonly lastFileChangeAt: number | null;
  // A model request is in flight. A reasoning model may think for minutes without emitting a token; the Broker
  // already cuts a stream after 120 s of silence, so an open request is a live one, not an idle one.
  readonly modelRequestOpen: boolean;
  // For the workflow: tasks running or ready.
  readonly liveWork: number;
  // Evaluations in a row without progress before this one.
  readonly idleStrikes: number;
}

export type LivenessVerdict = "active" | "idle" | "residual" | "waiting_human" | "cooling_down";

export type ProgressSignal =
  | "tokens"
  | "tool_call"
  | "child_change"
  | "file_change"
  | "model_request_open"
  | "live_work";

export interface LivenessDecision {
  readonly verdict: LivenessVerdict;
  // continue: keep it and check again at nextCheckAt. close: cancel the attempt now, killing its process; it counts as
  // a failed attempt under the rework rules (3.8). For the workflow it means stuck: fail it as stalled. cancel: end it
  // without retry (reason residual).
  readonly action: "continue" | "close" | "cancel";
  readonly nextCheckAt: number | null;
  readonly idleStrikes: number;
  // What showed progress: the answer to "what are you working on?" for the watchdog.checked event.
  readonly signals: readonly ProgressSignal[];
}

const TERMINAL: readonly WorkflowState[] = ["completed", "failed", "stopped"];

function after(at: number | null, windowStart: number): boolean {
  return at !== null && at > windowStart;
}

function progressSignals(evidence: LivenessEvidence): ProgressSignal[] {
  const signals: ProgressSignal[] = [];
  if (evidence.tokensInWindow > 0) signals.push("tokens");
  if (after(evidence.lastToolCallAt, evidence.windowStart)) signals.push("tool_call");
  if (after(evidence.lastChildChangeAt, evidence.windowStart)) signals.push("child_change");
  if (after(evidence.lastFileChangeAt, evidence.windowStart)) signals.push("file_change");
  if (evidence.modelRequestOpen) signals.push("model_request_open");
  if (evidence.kind === "workflow" && evidence.liveWork > 0) signals.push("live_work");
  return signals;
}

export function evaluateLiveness(
  evidence: LivenessEvidence,
  now: number,
  policy: WatchdogPolicy,
): LivenessDecision {
  const recheck = now + policy.intervalMs;
  if (TERMINAL.includes(evidence.workflowState) || evidence.parentTerminal) {
    return policy.closeResidualImmediately
      ? { verdict: "residual", action: "cancel", nextCheckAt: null, idleStrikes: 0, signals: [] }
      : {
          verdict: "residual",
          action: "continue",
          nextCheckAt: recheck,
          idleStrikes: 0,
          signals: [],
        };
  }
  if (evidence.awaitingHuman) {
    return {
      verdict: "waiting_human",
      action: "continue",
      nextCheckAt: recheck,
      idleStrikes: 0,
      signals: [],
    };
  }
  if (evidence.coolingUntil !== null && evidence.coolingUntil > now) {
    return {
      verdict: "cooling_down",
      action: "continue",
      nextCheckAt: recheck,
      idleStrikes: 0,
      signals: [],
    };
  }
  const signals = progressSignals(evidence);
  if (signals.length > 0) {
    return { verdict: "active", action: "continue", nextCheckAt: recheck, idleStrikes: 0, signals };
  }
  const idleStrikes = evidence.idleStrikes + 1;
  if (idleStrikes >= policy.idleStrikesToClose) {
    return { verdict: "idle", action: "close", nextCheckAt: null, idleStrikes, signals };
  }
  return { verdict: "idle", action: "continue", nextCheckAt: recheck, idleStrikes, signals };
}

// An entity never scheduled, or whose next_check_at has come, is due for an evaluation.
export function isCheckDue(nextCheckAt: number | null, now: number): boolean {
  return nextCheckAt === null || now >= nextCheckAt;
}
