import { describe, expect, it } from "vitest";
import {
  matchProcess,
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
      uncertain: [],
    });
  });

  it("keeps a pid whose process started just after the recorded time: the OS reused it", () => {
    const record = { runId: "r1", pid: 100, startedAt: SPAWNED };
    expect(planProcessKills([record], new Map([[100, SPAWNED + 500]]))).toEqual({
      kill: [],
      reused: [record],
      gone: [],
      uncertain: [],
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
      uncertain: [],
    });
  });

  it("concludes nothing about a pid whose batch of the OS query failed", () => {
    const record = { runId: "r1", pid: 100, startedAt: SPAWNED };
    expect(planProcessKills([record], new Map([[100, null]]))).toEqual({
      kill: [],
      reused: [],
      gone: [],
      uncertain: [record],
    });
  });

  it("compares Linux boot ticks, so a wall-clock step never turns a live agent into a reused pid", () => {
    const boot = { bootId: "boot-a", ticks: 123_456 };
    const record = { runId: "r1", pid: 100, startedAt: SPAWNED, boot };
    // The clock stepped 5 s forward since the spawn: the wall-clock rebuild of the start moved with it.
    const stepped = new Map([[100, SPAWNED + 5_000]]);
    expect(
      planProcessKills([record], stepped, PROCESS_START_WINDOW, new Map([[100, boot]])).kill,
    ).toEqual([record]);
    // The same pid with other ticks, or after a reboot, is another process.
    expect(
      planProcessKills(
        [record],
        new Map([[100, SPAWNED]]),
        PROCESS_START_WINDOW,
        new Map([[100, { bootId: "boot-a", ticks: 999_999 }]]),
      ).reused,
    ).toEqual([record]);
    expect(
      planProcessKills(
        [record],
        new Map([[100, SPAWNED]]),
        PROCESS_START_WINDOW,
        new Map([[100, { bootId: "boot-b", ticks: 123_456 }]]),
      ).reused,
    ).toEqual([record]);
  });

  it("marks nothing reused when only a clock step could explain the mismatch of a record without boot ticks", () => {
    const legacy = { runId: "r1", pid: 100, startedAt: SPAWNED };
    const plan = planProcessKills(
      [legacy],
      new Map([[100, SPAWNED + 5_000]]),
      PROCESS_START_WINDOW,
      new Map([[100, { bootId: "boot-a", ticks: 42 }]]),
    );
    expect(plan).toEqual({ kill: [], reused: [], gone: [], uncertain: [legacy] });
  });
});

describe("matchProcess", () => {
  const boot = { bootId: "boot-a", ticks: 500 };
  it("decides by boot id and ticks when both sides have them, whatever the wall clocks say", () => {
    expect(matchProcess({ startedAt: SPAWNED, boot }, { startedAt: SPAWNED - 60_000, boot })).toBe(
      "same",
    );
    expect(
      matchProcess(
        { startedAt: SPAWNED, boot },
        { startedAt: SPAWNED, boot: { ...boot, ticks: 501 } },
      ),
    ).toBe("other");
    expect(
      matchProcess(
        { startedAt: SPAWNED, boot },
        { startedAt: SPAWNED, boot: { ...boot, bootId: "boot-b" } },
      ),
    ).toBe("other");
  });

  it("falls back to the wall-clock window, and says unknown where a Linux clock step could explain a mismatch", () => {
    expect(matchProcess({ startedAt: SPAWNED }, { startedAt: SPAWNED - 10 })).toBe("same");
    expect(matchProcess({ startedAt: SPAWNED }, { startedAt: SPAWNED + 5_000 })).toBe("other");
    expect(matchProcess({ startedAt: SPAWNED }, { startedAt: SPAWNED + 5_000, boot })).toBe(
      "unknown",
    );
    expect(matchProcess({ startedAt: SPAWNED, boot }, { startedAt: SPAWNED + 5_000 })).toBe(
      "unknown",
    );
    expect(matchProcess({ startedAt: SPAWNED, boot }, { startedAt: SPAWNED, boot: null })).toBe(
      "same",
    );
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

  it("kills a verified root first, then its descendants, each parent before its children", () => {
    const plan = planTreeKills([{ pid: 10, startedAt: T + 20 }], table);
    expect(plan.roots.map((entry) => entry.pid)).toEqual([10]);
    // A live root could start a child after the snapshot; killed first, it starts none.
    expect(plan.order.map((entry) => entry.pid)).toEqual([10, 11, 12, 13]);
    expect(plan.order[0]).toEqual({ pid: 10, parentPid: 1, startedAt: T });
  });

  it("verifies a Linux root by its boot ticks and a child by ticks, unmoved by a clock step", () => {
    const boot = (ticks: number) => ({ bootId: "boot-a", ticks });
    const linux = [
      { pid: 10, parentPid: 1, startedAt: T + 7_000, boot: boot(100) },
      { pid: 11, parentPid: 10, startedAt: T + 8_000, boot: boot(150) },
      { pid: 30, parentPid: 10, startedAt: T + 9_000, boot: boot(50) },
    ];
    const plan = planTreeKills([{ pid: 10, startedAt: T, boot: boot(100) }], linux);
    expect(plan.order.map((entry) => entry.pid)).toEqual([10, 11]);
    expect(
      planTreeKills([{ pid: 10, startedAt: T + 7_000, boot: boot(101) }], linux).order,
    ).toEqual([]);
  });

  it("leaves out a process that names a parent pid but started before that parent: its real parent died and the pid was reused", () => {
    const stale = [...table, { pid: 30, parentPid: 10, startedAt: T - 60_000 }];
    const plan = planTreeKills([{ pid: 10, startedAt: T }], stale);
    expect(plan.order.map((entry) => entry.pid)).not.toContain(30);
    expect(plan.order.map((entry) => entry.pid)).toEqual([10, 11, 12, 13]);
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
    expect(plan.order.map((entry) => entry.pid)).toEqual([10, 11, 12, 13]);
    const guarded = planTreeKills([{ pid: 10, startedAt: T }], table, {
      protectedPids: new Set([11]),
    });
    expect(guarded.order.map((entry) => entry.pid)).toEqual([10, 13]);
  });

  it("stops at a loop of parent pids instead of walking it forever", () => {
    const loop = [
      { pid: 40, parentPid: 41, startedAt: T },
      { pid: 41, parentPid: 40, startedAt: T },
    ];
    expect(planTreeKills([{ pid: 40, startedAt: T }], loop).order.map((e) => e.pid)).toEqual([
      40, 41,
    ]);
  });

  it("never plans a pid that is not a positive whole number", () => {
    const bad = [{ pid: 0, parentPid: 0, startedAt: T }];
    expect(planTreeKills([{ pid: 0, startedAt: T }], bad)).toEqual({ roots: [], order: [] });
  });
});
