import { describe, expect, it } from "vitest";
import {
  DEFAULT_WATCHDOG_POLICY,
  evaluateLiveness,
  isCheckDue,
  type LivenessEvidence,
  type WatchdogPolicy,
} from "../../src/delegation/index.js";

// The 15-minute watchdog (docs/modos-y-delegacion.md 3.16, reading L2): code asks "are you still working?" with
// objective facts, never a model. The clock is a plain number advanced by hand, like a fake clock.

const MINUTE = 60_000;
const START = 10_000_000;
const NOW = START + 15 * MINUTE;

function evidence(change: Partial<LivenessEvidence> = {}): LivenessEvidence {
  return {
    kind: "attempt",
    workflowState: "running",
    parentTerminal: false,
    awaitingHuman: false,
    coolingUntil: null,
    windowStart: START,
    tokensInWindow: 0,
    lastToolCallAt: null,
    lastChildChangeAt: null,
    lastFileChangeAt: null,
    modelRequestOpen: false,
    liveWork: 0,
    idleStrikes: 0,
    ...change,
  };
}

describe("evaluateLiveness", () => {
  it("closes an attempt that showed no progress in its 15-minute window", () => {
    expect(evaluateLiveness(evidence(), NOW, DEFAULT_WATCHDOG_POLICY)).toEqual({
      verdict: "idle",
      action: "close",
      nextCheckAt: null,
      idleStrikes: 1,
      signals: [],
    });
  });

  it("lets an attempt with progress continue and checks it again in 15 minutes", () => {
    expect(
      evaluateLiveness(
        evidence({ tokensInWindow: 1200, idleStrikes: 0 }),
        NOW,
        DEFAULT_WATCHDOG_POLICY,
      ),
    ).toEqual({
      verdict: "active",
      action: "continue",
      nextCheckAt: NOW + 15 * MINUTE,
      idleStrikes: 0,
      signals: ["tokens"],
    });
  });

  it("counts each progress signal inside the window, and none from before it", () => {
    const inside = START + MINUTE;
    const cases: [Partial<LivenessEvidence>, string][] = [
      [{ lastToolCallAt: inside }, "tool_call"],
      [{ lastChildChangeAt: inside }, "child_change"],
      [{ lastFileChangeAt: inside }, "file_change"],
      [{ modelRequestOpen: true }, "model_request_open"],
    ];
    for (const [change, signal] of cases) {
      const decision = evaluateLiveness(evidence(change), NOW, DEFAULT_WATCHDOG_POLICY);
      expect(decision).toMatchObject({ verdict: "active", signals: [signal] });
    }
    const stale = evidence({ lastToolCallAt: START, lastChildChangeAt: START - MINUTE });
    expect(evaluateLiveness(stale, NOW, DEFAULT_WATCHDOG_POLICY).verdict).toBe("idle");
  });

  it("does not close a model that thinks without emitting while its request is open", () => {
    const thinking = evidence({ modelRequestOpen: true, tokensInWindow: 0, lastToolCallAt: null });
    expect(evaluateLiveness(thinking, NOW, DEFAULT_WATCHDOG_POLICY)).toMatchObject({
      verdict: "active",
      action: "continue",
    });
  });

  it("cancels without retry what has no purpose left: residual", () => {
    for (const workflowState of ["completed", "failed", "stopped"] as const) {
      const decision = evaluateLiveness(
        evidence({ workflowState, tokensInWindow: 50 }),
        NOW,
        DEFAULT_WATCHDOG_POLICY,
      );
      expect(decision).toEqual({
        verdict: "residual",
        action: "cancel",
        nextCheckAt: null,
        idleStrikes: 0,
        signals: [],
      });
    }
    expect(
      evaluateLiveness(evidence({ parentTerminal: true }), NOW, DEFAULT_WATCHDOG_POLICY).verdict,
    ).toBe("residual");
  });

  // The user's hard rule: a residual task is closed at once, and no policy can keep it.
  it("cancels a residual entity whatever the policy says", () => {
    const policy = {
      ...DEFAULT_WATCHDOG_POLICY,
      closeResidualImmediately: false,
      idleStrikesToClose: 5,
    } as WatchdogPolicy;
    expect(evaluateLiveness(evidence({ parentTerminal: true }), NOW, policy)).toMatchObject({
      verdict: "residual",
      action: "cancel",
      nextCheckAt: null,
    });
  });

  it("never closes an intentional wait for a human or a cooldown", () => {
    expect(
      evaluateLiveness(evidence({ awaitingHuman: true }), NOW, DEFAULT_WATCHDOG_POLICY),
    ).toMatchObject({
      verdict: "waiting_human",
      action: "continue",
      nextCheckAt: NOW + 15 * MINUTE,
    });
    expect(
      evaluateLiveness(evidence({ coolingUntil: NOW + 30 * MINUTE }), NOW, DEFAULT_WATCHDOG_POLICY),
    ).toMatchObject({ verdict: "cooling_down", action: "continue" });
    expect(
      evaluateLiveness(evidence({ coolingUntil: NOW - 1 }), NOW, DEFAULT_WATCHDOG_POLICY).verdict,
    ).toBe("idle");
  });

  it("detects a workflow with nothing running, ready, waiting or cooling as stuck", () => {
    const stuck = evidence({ kind: "workflow" });
    expect(evaluateLiveness(stuck, NOW, DEFAULT_WATCHDOG_POLICY)).toMatchObject({
      verdict: "idle",
      action: "close",
    });
    const busy = evidence({ kind: "workflow", liveWork: 3 });
    expect(evaluateLiveness(busy, NOW, DEFAULT_WATCHDOG_POLICY)).toMatchObject({
      verdict: "active",
      signals: ["live_work"],
    });
  });

  it("judges a delegator thread by the progress of its subtree", () => {
    const quietThread = evidence({ kind: "thread" });
    expect(evaluateLiveness(quietThread, NOW, DEFAULT_WATCHDOG_POLICY).verdict).toBe("idle");
    const childMoved = evidence({ kind: "thread", lastChildChangeAt: NOW - MINUTE });
    expect(evaluateLiveness(childMoved, NOW, DEFAULT_WATCHDOG_POLICY).verdict).toBe("active");
  });

  // A thread whose children are ready but held back by a limit (role, writer, surface, workflow cap) is waiting for
  // capacity, not idle: it continues and is checked again in 15 minutes.
  it("never closes a thread whose subtree has live work, even when the limits hold it back", () => {
    const waiting = evidence({ kind: "thread", liveWork: 4 });
    expect(evaluateLiveness(waiting, NOW, DEFAULT_WATCHDOG_POLICY)).toEqual({
      verdict: "active",
      action: "continue",
      nextCheckAt: NOW + 15 * MINUTE,
      idleStrikes: 0,
      signals: ["live_work"],
    });
  });

  it("does not count live work for a single attempt, which is judged by its own progress", () => {
    const attempt = evidence({ kind: "attempt", liveWork: 4 });
    expect(evaluateLiveness(attempt, NOW, DEFAULT_WATCHDOG_POLICY).verdict).toBe("idle");
  });

  it("waits for idleStrikesToClose evaluations without progress, and progress resets the count", () => {
    const policy = { ...DEFAULT_WATCHDOG_POLICY, idleStrikesToClose: 2 };
    expect(evaluateLiveness(evidence(), NOW, policy)).toEqual({
      verdict: "idle",
      action: "continue",
      nextCheckAt: NOW + 15 * MINUTE,
      idleStrikes: 1,
      signals: [],
    });
    expect(evaluateLiveness(evidence({ idleStrikes: 1 }), NOW, policy)).toMatchObject({
      action: "close",
      idleStrikes: 2,
    });
    expect(
      evaluateLiveness(evidence({ idleStrikes: 1, tokensInWindow: 9 }), NOW, policy),
    ).toMatchObject({ verdict: "active", idleStrikes: 0 });
  });

  it("schedules with the configured interval", () => {
    const policy = { ...DEFAULT_WATCHDOG_POLICY, intervalMs: 5 * MINUTE };
    expect(evaluateLiveness(evidence({ tokensInWindow: 1 }), NOW, policy).nextCheckAt).toBe(
      NOW + 5 * MINUTE,
    );
  });
});

describe("DEFAULT_WATCHDOG_POLICY (P16)", () => {
  it("checks every 15 minutes and closes after one evaluation without progress", () => {
    expect(DEFAULT_WATCHDOG_POLICY).toEqual({
      intervalMs: 900_000,
      idleStrikesToClose: 1,
    });
  });
});

describe("isCheckDue", () => {
  it("is due when never scheduled or when the time has come", () => {
    expect(isCheckDue(null, NOW)).toBe(true);
    expect(isCheckDue(NOW, NOW)).toBe(true);
    expect(isCheckDue(NOW + 1, NOW)).toBe(false);
  });
});
