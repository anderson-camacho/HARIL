import type { TaskState } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import { canTransition, isTerminal } from "../src/domain/task-state.js";

const ALL_STATES: readonly TaskState[] = [
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

// Literal list of the legal edges of ARCHITECTURE.md 7.2 (diagram and transition table).
// Written out by hand on purpose: it is the oracle, never derived from the implementation.
const LEGAL_EDGES: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ["pending", "ready"],
  ["pending", "blocked"],
  ["pending", "cancelled"],
  ["ready", "running"],
  ["ready", "blocked"],
  ["ready", "cancelled"],
  ["running", "completed"],
  ["running", "ready"],
  ["running", "failed"],
  ["running", "blocked"],
  ["running", "cancelled"],
  ["blocked", "ready"],
  ["blocked", "pending"],
  ["blocked", "failed"],
  ["blocked", "cancelled"],
  ["failed", "ready"],
];

const isLegalEdge = (from: TaskState, to: TaskState): boolean =>
  LEGAL_EDGES.some(([a, b]) => a === from && b === to);

describe("canTransition", () => {
  it("has exactly 16 legal edges in the oracle", () => {
    expect(LEGAL_EDGES).toHaveLength(16);
  });

  it("accepts every legal edge", () => {
    for (const [from, to] of LEGAL_EDGES) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it("rejects every other pair of the 7x7 matrix, including self-loops", () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (isLegalEdge(from, to)) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("covers the full 7x7 matrix (49 pairs)", () => {
    expect(ALL_STATES).toHaveLength(7);
    let pairs = 0;
    for (const _from of ALL_STATES) for (const _to of ALL_STATES) pairs += 1;
    expect(pairs).toBe(49);
  });
});

describe("isTerminal", () => {
  it("marks completed and cancelled as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("marks the other five states as non-terminal", () => {
    for (const state of ["pending", "ready", "running", "blocked", "failed"] as const) {
      expect(isTerminal(state), state).toBe(false);
    }
  });

  it("gives terminal states no outgoing edge", () => {
    for (const state of ALL_STATES) {
      if (!isTerminal(state)) continue;
      for (const to of ALL_STATES) {
        expect(canTransition(state, to), `${state} -> ${to}`).toBe(false);
      }
    }
  });
});
