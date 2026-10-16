import { describe, expect, it } from "vitest";
import { type RunEvent, runExitCode, summarizeRun } from "../src/orchestrator/index.js";

// Run summary (M1-T5): tallies the events of one `haril start`; exit 1 when a task failed or was blocked.
describe("summarizeRun", () => {
  it("counts completed, failed and blocked tasks and ignores retries and claims", () => {
    const events: RunEvent[] = [
      { type: "command.applied", commandId: "c1", commandType: "task.create", taskIds: ["a"] },
      { type: "task.claimed", taskId: "a", goal: "A", attempt: 1, maxAttempts: 1 },
      { type: "task.completed", taskId: "a", goal: "A", simulated: false },
      { type: "task.claimed", taskId: "b", goal: "B", attempt: 1, maxAttempts: 2 },
      {
        type: "task.retrying",
        taskId: "b",
        goal: "B",
        nextAttempt: 2,
        maxAttempts: 2,
        code: "fake.failed",
      },
      { type: "task.claimed", taskId: "b", goal: "B", attempt: 2, maxAttempts: 2 },
      { type: "task.failed", taskId: "b", goal: "B", code: "fake.failed" },
      { type: "task.blocked", taskId: "c", goal: "C", reason: "dep_failed" },
    ];
    expect(summarizeRun(events)).toEqual({
      completed: ["a"],
      failed: ["b"],
      blocked: ["c"],
      skipped: [],
      commandsApplied: 1,
      commandsRejected: 0,
    });
  });

  it("counts a task skipped for missing setup (M2-T6) and maps it to exit 1", () => {
    const skip: RunEvent = {
      type: "task.skipped",
      taskId: "s",
      goal: "S",
      what: "HARIL_CLIPROXYAPI_KEY is not set",
      fix: "set it to your CLIProxyAPI client key",
    };
    expect(summarizeRun([skip]).skipped).toEqual(["s"]);
    expect(runExitCode(summarizeRun([skip]))).toBe(1);
  });

  it("maps a run with no failure, block or skip to exit 0 and any failure or block to exit 1", () => {
    expect(
      runExitCode(
        summarizeRun([{ type: "task.completed", taskId: "a", goal: "A", simulated: false }]),
      ),
    ).toBe(0);
    expect(
      runExitCode(summarizeRun([{ type: "task.failed", taskId: "a", goal: "A", code: "x" }])),
    ).toBe(1);
    expect(
      runExitCode(
        summarizeRun([{ type: "task.blocked", taskId: "a", goal: "A", reason: "dep_failed" }]),
      ),
    ).toBe(1);
  });
});
