import type { VerdictInput } from "@haril/contracts";
import type { DelegationLimits } from "./limits.js";

// Anti-rework machine of one audited task (docs/modos-y-delegacion.md 3.8). Guarantees by code, not by trust, that an
// auditor rejecting out of taste cannot start a relaunch loop:
//   - a rejection relaunches the executor with the verdict's reasons, up to maxAuditRetries times (default 1);
//   - the next rejection escalates the task to its delegator with both verdicts, up to maxEscalationsPerTask times
//     (default 1); the delegator may reformulate the assignment once, or the node fails;
//   - a reformulated attempt that is rejected again fails: the budgets are not reset by a reformulation.
// A failed attempt (crash, timeout, an idle close by the watchdog, 3.16) counts like a rejection, so it cannot open a
// loop either. The same machine bounds the final auditor's corrections.

export type ReworkPhase = "working" | "awaiting_reformulation" | "approved" | "failed";

export interface ReworkState {
  readonly phase: ReworkPhase;
  // Relaunches spent.
  readonly retries: number;
  // Escalations spent.
  readonly escalations: number;
}

export const INITIAL_REWORK: ReworkState = Object.freeze({
  phase: "working",
  retries: 0,
  escalations: 0,
});

export type ReworkEvent =
  | { readonly type: "verdict"; readonly approved: boolean }
  | { readonly type: "attempt_failed" }
  | { readonly type: "reformulated" }
  | { readonly type: "reformulation_declined" };

// What the Runtime does next: accept the result, relaunch the executor with the reasons, hand the task to the
// delegator, run the reformulated assignment, fail the node, or nothing (an event that no longer applies, such as a
// duplicate verdict replayed after a restart).
export type ReworkAction = "accept" | "retry" | "escalate" | "rerun" | "fail" | "ignore";

export type ReworkLimits = Pick<DelegationLimits, "maxAuditRetries" | "maxEscalationsPerTask">;

export interface ReworkStep {
  readonly state: ReworkState;
  readonly action: ReworkAction;
}

function rejected(state: ReworkState, limits: ReworkLimits): ReworkStep {
  if (state.retries < limits.maxAuditRetries) {
    return { state: { ...state, retries: state.retries + 1 }, action: "retry" };
  }
  if (state.escalations < limits.maxEscalationsPerTask) {
    return {
      state: { ...state, phase: "awaiting_reformulation", escalations: state.escalations + 1 },
      action: "escalate",
    };
  }
  return { state: { ...state, phase: "failed" }, action: "fail" };
}

export function stepRework(
  state: ReworkState,
  event: ReworkEvent,
  limits: ReworkLimits,
): ReworkStep {
  const ignore: ReworkStep = { state, action: "ignore" };
  switch (state.phase) {
    case "working":
      if (event.type === "verdict" && event.approved) {
        return { state: { ...state, phase: "approved" }, action: "accept" };
      }
      if (event.type === "verdict" || event.type === "attempt_failed") {
        return rejected(state, limits);
      }
      return ignore;
    case "awaiting_reformulation":
      if (event.type === "reformulated") {
        return { state: { ...state, phase: "working" }, action: "rerun" };
      }
      if (event.type === "reformulation_declined") {
        return { state: { ...state, phase: "failed" }, action: "fail" };
      }
      return ignore;
    case "approved":
    case "failed":
      return ignore;
  }
}

export type VerdictCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "verdict_without_reason"; readonly reason: string };

// 3.8 rule 5: a rejection must cite at least one criterion it found unmet, so there are no empty rejections.
export function checkVerdict(verdict: VerdictInput): VerdictCheck {
  if (verdict.approved || verdict.reasons.some((reason) => !reason.ok)) return { ok: true };
  return {
    ok: false,
    code: "verdict_without_reason",
    reason:
      "a rejection needs at least one reason with ok: false that names the acceptance criterion it found unmet",
  };
}
