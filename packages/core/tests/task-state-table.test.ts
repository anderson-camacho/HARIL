import type { TaskState } from "@haril/contracts";
import { describe, expect, it } from "vitest";
import { canTransition, legalTargets, TASK_STATES } from "../src/domain/task-state.js";

describe("TASK_STATES", () => {
  it("lists the seven task states once each", () => {
    expect(TASK_STATES).toHaveLength(7);
    expect(new Set(TASK_STATES).size).toBe(7);
  });
});

describe("legalTargets", () => {
  it("agrees with canTransition for every state", () => {
    for (const from of TASK_STATES) {
      const targets: readonly TaskState[] = legalTargets(from);
      for (const to of TASK_STATES) {
        expect(targets.includes(to), `${from} -> ${to}`).toBe(canTransition(from, to));
      }
    }
  });

  it("is empty for the terminal states", () => {
    expect(legalTargets("completed")).toEqual([]);
    expect(legalTargets("cancelled")).toEqual([]);
  });
});
