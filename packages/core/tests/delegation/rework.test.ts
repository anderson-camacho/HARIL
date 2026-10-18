import { describe, expect, it } from "vitest";
import {
  checkVerdict,
  DEFAULT_DELEGATION_LIMITS,
  INITIAL_REWORK,
  type ReworkEvent,
  type ReworkLimits,
  type ReworkState,
  stepRework,
} from "../../src/delegation/index.js";
import { seededRandom } from "./random.js";

// Anti-rework (docs/modos-y-delegacion.md 3.8): at most maxAuditRetries relaunches and maxEscalationsPerTask
// escalations per task (1 and 1 by default, P3), whatever the auditor says.

const REJECTED: ReworkEvent = { type: "verdict", approved: false };
const APPROVED: ReworkEvent = { type: "verdict", approved: true };

function run(events: readonly ReworkEvent[], limits: ReworkLimits = DEFAULT_DELEGATION_LIMITS) {
  let state: ReworkState = INITIAL_REWORK;
  const actions: string[] = [];
  for (const event of events) {
    const step = stepRework(state, event, limits);
    state = step.state;
    actions.push(step.action);
  }
  return { state, actions };
}

describe("stepRework", () => {
  it("accepts an approved first attempt", () => {
    expect(run([APPROVED])).toEqual({
      state: { phase: "approved", retries: 0, escalations: 0 },
      actions: ["accept"],
    });
  });

  it("relaunches once, then escalates once, then fails the reformulated attempt", () => {
    expect(run([REJECTED, REJECTED, { type: "reformulated" }, REJECTED])).toEqual({
      state: { phase: "failed", retries: 1, escalations: 1 },
      actions: ["retry", "escalate", "rerun", "fail"],
    });
  });

  it("accepts the relaunch or the reformulation when the auditor approves it", () => {
    expect(run([REJECTED, APPROVED]).actions).toEqual(["retry", "accept"]);
    expect(run([REJECTED, REJECTED, { type: "reformulated" }, APPROVED]).actions).toEqual([
      "retry",
      "escalate",
      "rerun",
      "accept",
    ]);
  });

  it("fails when the delegator declines to reformulate", () => {
    expect(run([REJECTED, REJECTED, { type: "reformulation_declined" }])).toEqual({
      state: { phase: "failed", retries: 1, escalations: 1 },
      actions: ["retry", "escalate", "fail"],
    });
  });

  it("counts a failed attempt (an idle close by the watchdog, a crash) like a rejection", () => {
    expect(run([{ type: "attempt_failed" }, { type: "attempt_failed" }]).actions).toEqual([
      "retry",
      "escalate",
    ]);
  });

  it("ignores events after the end and events that do not fit the phase", () => {
    expect(run([APPROVED, REJECTED, { type: "reformulated" }]).actions).toEqual([
      "accept",
      "ignore",
      "ignore",
    ]);
    expect(run([{ type: "reformulated" }]).actions).toEqual(["ignore"]);
    expect(run([REJECTED, REJECTED, REJECTED]).actions).toEqual(["retry", "escalate", "ignore"]);
  });

  it("reads its limits from configuration: zero retries escalates at once", () => {
    const limits = { maxAuditRetries: 0, maxEscalationsPerTask: 0 };
    expect(run([REJECTED], limits)).toEqual({
      state: { phase: "failed", retries: 0, escalations: 0 },
      actions: ["fail"],
    });
  });

  it("never relaunches more than once nor escalates more than once with the defaults", () => {
    const random = seededRandom(7);
    const kinds: ReworkEvent[] = [
      REJECTED,
      APPROVED,
      { type: "attempt_failed" },
      { type: "reformulated" },
      { type: "reformulation_declined" },
    ];
    for (let round = 0; round < 2000; round++) {
      const events = Array.from({ length: random.int(1, 12) }, () => random.pick(kinds));
      const { state, actions } = run(events);
      expect(actions.filter((action) => action === "retry").length).toBeLessThanOrEqual(1);
      expect(actions.filter((action) => action === "escalate").length).toBeLessThanOrEqual(1);
      expect(state.retries).toBeLessThanOrEqual(1);
      expect(state.escalations).toBeLessThanOrEqual(1);
    }
  });

  it("never exceeds any configured limit and never leaves a terminal phase", () => {
    const random = seededRandom(11);
    const kinds: ReworkEvent[] = [
      REJECTED,
      APPROVED,
      { type: "attempt_failed" },
      { type: "reformulated" },
    ];
    for (let round = 0; round < 2000; round++) {
      const limits = { maxAuditRetries: random.int(0, 3), maxEscalationsPerTask: random.int(0, 3) };
      let state: ReworkState = INITIAL_REWORK;
      let terminal = false;
      const length = random.int(1, 20);
      for (let index = 0; index < length; index++) {
        const step = stepRework(state, random.pick(kinds), limits);
        if (terminal) expect(step).toEqual({ state, action: "ignore" });
        state = step.state;
        terminal = state.phase === "approved" || state.phase === "failed";
        expect(state.retries).toBeLessThanOrEqual(limits.maxAuditRetries);
        expect(state.escalations).toBeLessThanOrEqual(limits.maxEscalationsPerTask);
      }
    }
  });
});

describe("checkVerdict", () => {
  it("accepts an approval, with or without reasons", () => {
    expect(checkVerdict({ approved: true, reasons: [] })).toEqual({ ok: true });
  });

  it("accepts a rejection with at least one failing criterion", () => {
    const verdict = {
      approved: false,
      reasons: [
        { criterion: "Uses the new color", ok: true, evidence: "theme.ts line 4" },
        { criterion: "Has a test", ok: false, evidence: "No test file" },
      ],
    };
    expect(checkVerdict(verdict)).toEqual({ ok: true });
  });

  it("refuses a rejection with no reason, or with no failing criterion: verdict_without_reason", () => {
    for (const reasons of [[], [{ criterion: "Uses the new color", ok: true, evidence: "fine" }]]) {
      const result = checkVerdict({ approved: false, reasons });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("verdict_without_reason");
      expect(result.reason).toContain("criterion");
    }
  });
});
