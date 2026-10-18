import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELEGATION_LIMITS,
  decideRework,
  INITIAL_REWORK,
  type ReworkTurn,
  replayRework,
} from "../../src/delegation/index.js";

// The rework state of an executor thread is derived from the store, never kept only in memory (3.8): its turns in
// order, whether each came from a proposal (the first one, or the delegator's reformulation) or from a relaunch, and how
// each attempt ended. A restart replays them and continues with the same counts.

const limits = DEFAULT_DELEGATION_LIMITS;
const first = (outcome: ReworkTurn["outcome"]): ReworkTurn => ({ byProposal: true, outcome });
const relaunch = (outcome: ReworkTurn["outcome"]): ReworkTurn => ({ byProposal: false, outcome });
const reformulation = first;

describe("replayRework", () => {
  it("starts working with nothing spent, and keeps working while the attempt has not ended", () => {
    expect(replayRework([], limits)).toEqual(INITIAL_REWORK);
    expect(replayRework([first(null)], limits)).toEqual(INITIAL_REWORK);
  });

  it("approves on an approving verdict", () => {
    expect(replayRework([first("approved")], limits)).toEqual({
      phase: "approved",
      retries: 0,
      escalations: 0,
    });
  });

  it("counts one relaunch after a rejection, and a failed attempt like a rejection", () => {
    for (const ended of ["rejected", "failed"] as const) {
      expect(replayRework([first(ended), relaunch("approved")], limits)).toEqual({
        phase: "approved",
        retries: 1,
        escalations: 0,
      });
      expect(replayRework([first(ended), relaunch(null)], limits)).toEqual({
        phase: "working",
        retries: 1,
        escalations: 0,
      });
    }
  });

  it("escalates the second rejection, runs the reformulation, and fails a rejected reformulation", () => {
    const escalated = [first("rejected"), relaunch("rejected")];
    expect(replayRework(escalated, limits)).toEqual({
      phase: "awaiting_reformulation",
      retries: 1,
      escalations: 1,
    });
    expect(replayRework([...escalated, reformulation(null)], limits)).toEqual({
      phase: "working",
      retries: 1,
      escalations: 1,
    });
    expect(replayRework([...escalated, reformulation("approved")], limits).phase).toBe("approved");
    expect(replayRework([...escalated, reformulation("rejected")], limits)).toEqual({
      phase: "failed",
      retries: 1,
      escalations: 1,
    });
  });

  it("reads a rejection that no relaunch followed as the failure the workflow's agent cap decided", () => {
    expect(replayRework([first("rejected")], limits)).toEqual({
      phase: "failed",
      retries: 0,
      escalations: 0,
    });
  });
});

describe("decideRework", () => {
  it("relaunches when it may, and fails instead when no relaunch fits the workflow's agent cap", () => {
    const rejected = { type: "verdict", approved: false } as const;
    expect(decideRework(INITIAL_REWORK, rejected, limits, true)).toEqual({
      state: { phase: "working", retries: 1, escalations: 0 },
      action: "retry",
    });
    expect(decideRework(INITIAL_REWORK, rejected, limits, false)).toEqual({
      state: { phase: "failed", retries: 0, escalations: 0 },
      action: "fail",
    });
    const replayed = replayRework([first("rejected")], limits);
    expect(replayed).toEqual(decideRework(INITIAL_REWORK, rejected, limits, false).state);
  });

  it("never goes past one relaunch and one escalation, whatever the history", () => {
    const outcomes: ReworkTurn["outcome"][] = ["rejected", "failed", "approved", null];
    for (let mask = 0; mask < 256; mask++) {
      const turns: ReworkTurn[] = [];
      for (let index = 0; index < 4; index++) {
        const outcome = outcomes[(mask >> (index * 2)) & 3] ?? null;
        turns.push(index === 0 ? first(outcome) : relaunch(outcome));
      }
      const state = replayRework(turns, limits);
      expect(state.retries).toBeLessThanOrEqual(limits.maxAuditRetries);
      expect(state.escalations).toBeLessThanOrEqual(limits.maxEscalationsPerTask);
    }
  });
});
