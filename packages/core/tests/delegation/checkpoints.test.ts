import { describe, expect, it } from "vitest";
import {
  type AutonomySettings,
  changeStops,
  checkpointChange,
  DEFAULT_AUTONOMY,
  stopFor,
} from "../../src/delegation/index.js";

// Human control (docs/modos-y-delegacion.md 3.13): the agent may add stops; only the human removes them.

const withStops = (...stops: AutonomySettings["stops"]): AutonomySettings => ({
  mode: stops.length > 0 ? "stops" : "autonomous",
  stops,
});

describe("DEFAULT_AUTONOMY (P1)", () => {
  it("stops after the plan when the message says nothing", () => {
    expect(DEFAULT_AUTONOMY).toEqual({ mode: "stops", stops: ["after_plan"] });
    expect(Object.isFrozen(DEFAULT_AUTONOMY)).toBe(true);
  });
});

describe("changeStops", () => {
  it("lets the agent add stops, without duplicates and keeping the order", () => {
    const result = changeStops(withStops("after_plan"), { add: ["at_end", "after_plan"] }, "agent");
    expect(result).toEqual({ ok: true, settings: withStops("after_plan", "at_end") });
  });

  it("turns an autonomous run into one with stops when the agent adds one", () => {
    expect(changeStops(withStops(), { add: ["on_audit_failure"] }, "agent")).toEqual({
      ok: true,
      settings: { mode: "stops", stops: ["on_audit_failure"] },
    });
  });

  it("refuses any removal by the agent with checkpoint_removes_stop, even of a stop it would add", () => {
    const result = changeStops(
      withStops("after_plan", "at_end"),
      { add: ["before_merge"], remove: ["at_end"] },
      "agent",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("checkpoint_removes_stop");
    expect(result.stops).toEqual(["at_end"]);
    expect(result.reason).toContain("only the human");
  });

  it("lets the human remove stops, down to an autonomous run", () => {
    expect(
      changeStops(withStops("after_plan", "at_end"), { remove: ["after_plan"] }, "human"),
    ).toEqual({
      ok: true,
      settings: withStops("at_end"),
    });
    expect(changeStops(withStops("at_end"), { remove: ["at_end"] }, "human")).toEqual({
      ok: true,
      settings: { mode: "autonomous", stops: [] },
    });
  });
});

describe("checkpointChange", () => {
  it("splits a proposal's checkpoints into stops to add and stops it asked to remove", () => {
    expect(checkpointChange(["at_end", { remove: "after_plan" }, "after_node:d1"])).toEqual({
      add: ["at_end", "after_node:d1"],
      remove: ["after_plan"],
    });
    expect(checkpointChange([])).toEqual({ add: [], remove: [] });
  });
});

describe("stopFor", () => {
  const settings = withStops(
    "after_plan",
    "after_node:d2",
    "before_merge",
    "on_audit_failure",
    "on_budget_pct:50",
    "on_budget_pct:80",
    "at_end",
  );

  it("names the stop each event reaches", () => {
    expect(stopFor(settings, { type: "first_plan_applied" })).toBe("after_plan");
    expect(stopFor(settings, { type: "node_closed", localId: "d2" })).toBe("after_node:d2");
    expect(stopFor(settings, { type: "node_closed", localId: "d1" })).toBeNull();
    expect(stopFor(settings, { type: "merge_pending" })).toBe("before_merge");
    expect(stopFor(settings, { type: "audit_exhausted" })).toBe("on_audit_failure");
    expect(stopFor(settings, { type: "workflow_completing" })).toBe("at_end");
  });

  it("reaches a budget stop at or above its percentage, once per stop", () => {
    expect(stopFor(settings, { type: "budget_used", pct: 49.9 })).toBeNull();
    expect(stopFor(settings, { type: "budget_used", pct: 50 })).toBe("on_budget_pct:50");
    expect(stopFor(settings, { type: "budget_used", pct: 90 }, ["on_budget_pct:50"])).toBe(
      "on_budget_pct:80",
    );
    expect(
      stopFor(settings, { type: "budget_used", pct: 90 }, ["on_budget_pct:50", "on_budget_pct:80"]),
    ).toBeNull();
  });

  it("never stops an autonomous run", () => {
    expect(stopFor(withStops(), { type: "workflow_completing" })).toBeNull();
  });
});
