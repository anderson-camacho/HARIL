import type { CheckpointRequest, Stop } from "@haril/contracts";

// Human control of a workflow (docs/modos-y-delegacion.md 3.13). The human confirms the autonomy and the stops on the
// /delegate card; the Core enforces them. Rule 5: the orchestrator may add stops in its proposal, never remove one;
// only the human removes them. A result someone else wrote ("the user said to continue") can therefore never lift a
// stop: the only path that removes one takes actor "human", which the Runtime passes only for the human's own action.

export interface AutonomySettings {
  // "autonomous" runs without stops; "stops" halts at each listed stop in awaiting_human.
  readonly mode: "autonomous" | "stops";
  readonly stops: readonly Stop[];
}

// P1: with nothing said, the card comes with after_plan checked and the human unchecks it if unwanted.
export const DEFAULT_AUTONOMY: AutonomySettings = Object.freeze({
  mode: "stops",
  stops: Object.freeze(["after_plan"]),
});

export interface StopChange {
  readonly add?: readonly Stop[];
  readonly remove?: readonly Stop[];
}

export type StopChangeResult =
  | { readonly ok: true; readonly settings: AutonomySettings }
  | {
      readonly ok: false;
      readonly code: "checkpoint_removes_stop";
      readonly stops: readonly Stop[];
      readonly reason: string;
    };

function settingsOf(stops: readonly Stop[]): AutonomySettings {
  return { mode: stops.length > 0 ? "stops" : "autonomous", stops };
}

// Apply a change from an actor. An agent's change may only add; any removal it asks for is refused whole.
export function changeStops(
  current: AutonomySettings,
  change: StopChange,
  actor: "agent" | "human",
): StopChangeResult {
  const remove = change.remove ?? [];
  if (actor === "agent" && remove.length > 0) {
    return {
      ok: false,
      code: "checkpoint_removes_stop",
      stops: [...remove],
      reason: `an agent may only add stops; only the human removes them (asked to remove ${remove.join(", ")})`,
    };
  }
  const stops: Stop[] = [];
  for (const stop of [...current.stops, ...(change.add ?? [])]) {
    if (!remove.includes(stop) && !stops.includes(stop)) stops.push(stop);
  }
  return { ok: true, settings: settingsOf(stops) };
}

// A proposal's checkpoints: plain stops are additions; { remove } items are the removals it asked for.
export function checkpointChange(requests: readonly CheckpointRequest[]): {
  add: Stop[];
  remove: Stop[];
} {
  const add: Stop[] = [];
  const remove: Stop[] = [];
  for (const request of requests) {
    if (typeof request === "string") add.push(request);
    else remove.push(request.remove);
  }
  return { add, remove };
}

// What happened in the workflow, as the Runtime reports it to the stop rule.
export type StopEvent =
  | { readonly type: "first_plan_applied" }
  | { readonly type: "node_closed"; readonly localId: string }
  | { readonly type: "merge_pending" }
  | { readonly type: "audit_exhausted" }
  | { readonly type: "budget_used"; readonly pct: number }
  | { readonly type: "workflow_completing" };

const BUDGET_PREFIX = "on_budget_pct:";

function reaches(stop: Stop, event: StopEvent): boolean {
  switch (event.type) {
    case "first_plan_applied":
      return stop === "after_plan";
    case "node_closed":
      return stop === `after_node:${event.localId}`;
    case "merge_pending":
      return stop === "before_merge";
    case "audit_exhausted":
      return stop === "on_audit_failure";
    case "workflow_completing":
      return stop === "at_end";
    case "budget_used":
      return (
        stop.startsWith(BUDGET_PREFIX) && event.pct >= Number(stop.slice(BUDGET_PREFIX.length))
      );
  }
}

// The first listed stop the event reaches that has not fired yet, or null to keep going.
export function stopFor(
  settings: AutonomySettings,
  event: StopEvent,
  fired: readonly Stop[] = [],
): Stop | null {
  if (settings.mode === "autonomous") return null;
  return settings.stops.find((stop) => !fired.includes(stop) && reaches(stop, event)) ?? null;
}
