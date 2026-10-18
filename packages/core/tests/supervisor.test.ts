import { describe, expect, it } from "vitest";
import {
  PROCESS_START_TOLERANCE_MS,
  planProcessKills,
  sameProcess,
} from "../src/supervisor/index.js";

// Which recorded agent processes may be killed (docs/modos-y-delegacion.md 3.14.5): only a pid that is still running
// and whose start time, as the OS reports it, agrees with the one recorded when it was spawned. A pid the OS reused
// for another process started later, so it is kept; a pid that is not running is simply gone.

const SPAWNED = 1_800_000_000_000;

describe("sameProcess", () => {
  it("accepts an observed start within the tolerance on either side, and nothing beyond it", () => {
    expect(sameProcess(SPAWNED, SPAWNED)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED - PROCESS_START_TOLERANCE_MS)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED + PROCESS_START_TOLERANCE_MS)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED + PROCESS_START_TOLERANCE_MS + 1)).toBe(false);
    expect(sameProcess(SPAWNED, SPAWNED - PROCESS_START_TOLERANCE_MS - 1)).toBe(false);
  });

  it("never matches a process whose start time is unknown or not a number", () => {
    expect(sameProcess(SPAWNED, undefined)).toBe(false);
    expect(sameProcess(SPAWNED, Number.NaN)).toBe(false);
    expect(sameProcess(Number.NaN, SPAWNED)).toBe(false);
  });

  it("takes a narrower tolerance when asked", () => {
    expect(sameProcess(SPAWNED, SPAWNED + 500, 100)).toBe(false);
    expect(sameProcess(SPAWNED, SPAWNED + 50, 100)).toBe(true);
  });
});

describe("planProcessKills", () => {
  it("kills the running processes that match, keeps the reused pids and leaves the gone ones", () => {
    const ours = { runId: "r1", pid: 100, startedAt: SPAWNED };
    const reused = { runId: "r2", pid: 200, startedAt: SPAWNED - 3_600_000 };
    const gone = { runId: "r3", pid: 300, startedAt: SPAWNED };
    const observed = new Map([
      [100, SPAWNED + 15],
      [200, SPAWNED],
    ]);

    expect(planProcessKills([ours, reused, gone], observed)).toEqual({
      kill: [ours],
      reused: [reused],
      gone: [gone],
    });
  });

  it("kills a pid only for the record that matches when an older run recorded the same pid", () => {
    const old = { runId: "r1", pid: 100, startedAt: SPAWNED - 3_600_000 };
    const current = { runId: "r2", pid: 100, startedAt: SPAWNED };
    const plan = planProcessKills([old, current], new Map([[100, SPAWNED]]));

    expect(plan.kill).toEqual([current]);
    expect(plan.reused).toEqual([old]);
    expect(plan.gone).toEqual([]);
  });

  it("lists a process once in kill when two records name it", () => {
    const first = { runId: "r1", pid: 100, startedAt: SPAWNED };
    const again = { runId: "r2", pid: 100, startedAt: SPAWNED + 10 };
    expect(planProcessKills([first, again], new Map([[100, SPAWNED]])).kill).toEqual([first]);
  });

  it("ignores a record whose pid is not a positive whole number", () => {
    const bad = { runId: "r1", pid: 0, startedAt: SPAWNED };
    expect(planProcessKills([bad], new Map([[0, SPAWNED]]))).toEqual({
      kill: [],
      reused: [],
      gone: [bad],
    });
  });
});
