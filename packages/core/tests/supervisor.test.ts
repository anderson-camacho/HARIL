import { describe, expect, it } from "vitest";
import {
  PROCESS_START_WINDOW,
  planProcessKills,
  planTreeKills,
  processStartWindow,
  sameProcess,
} from "../src/supervisor/index.js";

// Which recorded agent processes may be killed (docs/modos-y-delegacion.md 3.14.5): only a pid that is still running
// and whose start time, as the OS reports it, agrees with the one recorded when it was spawned. The recorded time is
// taken right after the spawn returned, so the same process started a little before it; a pid the OS reused belongs to
// a process that started after it. The window is therefore wide before the recorded time and narrow after it.

const SPAWNED = 1_800_000_000_000;

describe("sameProcess", () => {
  it("accepts a start up to 2 s before the recorded time, and nothing earlier", () => {
    expect(sameProcess(SPAWNED, SPAWNED)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED - 1500)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED - PROCESS_START_WINDOW.beforeMs)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED - PROCESS_START_WINDOW.beforeMs - 1)).toBe(false);
  });

  it("refuses a start more than 100 ms after the recorded time on Windows and Linux: a reused pid starts later", () => {
    for (const platform of ["win32", "linux"]) {
      const window = processStartWindow(platform);
      expect(sameProcess(SPAWNED, SPAWNED + 50, window)).toBe(true);
      expect(sameProcess(SPAWNED, SPAWNED + 100, window)).toBe(true);
      expect(sameProcess(SPAWNED, SPAWNED + 101, window)).toBe(false);
      expect(sameProcess(SPAWNED, SPAWNED + 150, window)).toBe(false);
      expect(sameProcess(SPAWNED, SPAWNED - 1500, window)).toBe(true);
    }
    expect(sameProcess(SPAWNED, SPAWNED + 150)).toBe(false);
  });

  it("allows up to 1 s after the recorded time on macOS, whose ps truncates the elapsed time to whole seconds", () => {
    const window = processStartWindow("darwin");
    expect(sameProcess(SPAWNED, SPAWNED + 900, window)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED + 1000, window)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED + 1001, window)).toBe(false);
    expect(sameProcess(SPAWNED, SPAWNED - 2000, window)).toBe(true);
    expect(sameProcess(SPAWNED, SPAWNED - 2001, window)).toBe(false);
  });

  it("never matches a process whose start time is unknown or not a number", () => {
    expect(sameProcess(SPAWNED, undefined)).toBe(false);
    expect(sameProcess(SPAWNED, Number.NaN)).toBe(false);
    expect(sameProcess(Number.NaN, SPAWNED)).toBe(false);
  });
});

describe("planProcessKills", () => {
  it("kills the running processes that match, keeps the reused pids and leaves the gone ones", () => {
    const ours = { runId: "r1", pid: 100, startedAt: SPAWNED };
    const reused = { runId: "r2", pid: 200, startedAt: SPAWNED - 3_600_000 };
    const gone = { runId: "r3", pid: 300, startedAt: SPAWNED };
    const observed = new Map([
      [100, SPAWNED - 15],
      [200, SPAWNED],
    ]);

    expect(planProcessKills([ours, reused, gone], observed)).toEqual({
      kill: [ours],
      reused: [reused],
      gone: [gone],
    });
  });

  it("keeps a pid whose process started just after the recorded time: the OS reused it", () => {
    const record = { runId: "r1", pid: 100, startedAt: SPAWNED };
    expect(planProcessKills([record], new Map([[100, SPAWNED + 500]]))).toEqual({
      kill: [],
      reused: [record],
      gone: [],
    });
    expect(
      planProcessKills([record], new Map([[100, SPAWNED + 500]]), processStartWindow("darwin"))
        .kill,
    ).toEqual([record]);
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

describe("planTreeKills", () => {
  const T = SPAWNED;
  // pid 10 is the agent; 11 its shell, 12 the tool the shell started; 20 an unrelated program.
  const table = [
    { pid: 10, parentPid: 1, startedAt: T },
    { pid: 11, parentPid: 10, startedAt: T + 1000 },
    { pid: 12, parentPid: 11, startedAt: T + 2000 },
    { pid: 13, parentPid: 10, startedAt: T + 3000 },
    { pid: 20, parentPid: 1, startedAt: T - 9000 },
  ];

  it("kills a verified root's descendants before the root, children before their parents", () => {
    const plan = planTreeKills([{ pid: 10, startedAt: T + 20 }], table);
    expect(plan.roots.map((entry) => entry.pid)).toEqual([10]);
    expect(plan.order.map((entry) => entry.pid)).toEqual([12, 11, 13, 10]);
    expect(plan.order.at(-1)).toEqual({ pid: 10, parentPid: 1, startedAt: T });
  });

  it("leaves out a process that names a parent pid but started before that parent: its real parent died and the pid was reused", () => {
    const stale = [...table, { pid: 30, parentPid: 10, startedAt: T - 60_000 }];
    const plan = planTreeKills([{ pid: 10, startedAt: T }], stale);
    expect(plan.order.map((entry) => entry.pid)).not.toContain(30);
    expect(plan.order.map((entry) => entry.pid)).toEqual([12, 11, 13, 10]);
  });

  it("kills nothing of a root whose pid now names another process, or that is not running", () => {
    expect(planTreeKills([{ pid: 10, startedAt: T - 3_600_000 }], table)).toEqual({
      roots: [],
      order: [],
    });
    expect(planTreeKills([{ pid: 99, startedAt: T }], table)).toEqual({ roots: [], order: [] });
  });

  it("lists every pid once when two roots share a subtree, and never a protected pid or what runs under it", () => {
    const plan = planTreeKills(
      [
        { pid: 11, startedAt: T + 1000 },
        { pid: 10, startedAt: T },
      ],
      table,
    );
    expect(plan.order.map((entry) => entry.pid)).toEqual([12, 11, 13, 10]);
    const guarded = planTreeKills([{ pid: 10, startedAt: T }], table, {
      protectedPids: new Set([11]),
    });
    expect(guarded.order.map((entry) => entry.pid)).toEqual([13, 10]);
  });

  it("stops at a loop of parent pids instead of walking it forever", () => {
    const loop = [
      { pid: 40, parentPid: 41, startedAt: T },
      { pid: 41, parentPid: 40, startedAt: T },
    ];
    expect(planTreeKills([{ pid: 40, startedAt: T }], loop).order.map((e) => e.pid)).toEqual([
      41, 40,
    ]);
  });

  it("never plans a pid that is not a positive whole number", () => {
    const bad = [{ pid: 0, parentPid: 0, startedAt: T }];
    expect(planTreeKills([{ pid: 0, startedAt: T }], bad)).toEqual({ roots: [], order: [] });
  });
});
