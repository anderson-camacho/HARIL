import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessControl } from "../src/index.js";
import { cimDateTimeMs } from "../src/processes/process-control.js";

// The OS side of the emergency stop and the startup sweep (docs/modos-y-delegacion.md 3.14): real processes, a real
// tree (a child that starts a grandchild, as Pi starts a tool command) and the real OS queries.
// It runs in npm run test:stop (a step of npm test), on its own: the OS's process list is read through PowerShell's WMI
// on Windows, which took over 10 s under the load of every other test file in parallel and about 1 s alone.

// A child that starts a grandchild, prints the grandchild's pid and idles. POSIX leads its own group, as Pi does. The
// grandchild is detached so that only a kill ends it: on Windows a Node child otherwise dies with its parent's job.
const PARENT_SCRIPT =
  "const { spawn } = require('node:child_process');" +
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });" +
  "console.log(g.pid); setInterval(() => {}, 1000);";

const strays: number[] = [];
const control = createProcessControl();

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`${what}: not met in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawnIdle(): { child: ChildProcess; startedAt: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const startedAt = Date.now();
  if (child.pid !== undefined) strays.push(child.pid);
  return { child, startedAt };
}

async function spawnTree(): Promise<{ parent: number; grandchild: number; startedAt: number }> {
  const child = spawn(process.execPath, ["-e", PARENT_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const startedAt = Date.now();
  const parent = child.pid as number;
  strays.push(parent);
  const grandchild = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim())));
    child.once("error", reject);
  });
  strays.push(grandchild);
  return { parent, grandchild, startedAt };
}

describe("createProcessControl", () => {
  it("reads the start time of a running process, close to the time taken right after its spawn", async () => {
    const { child, startedAt } = spawnIdle();
    const times = await control.startTimes([child.pid as number]);
    const observed = times?.get(child.pid as number);
    expect(observed).toBeDefined();
    expect(Math.abs((observed as number) - startedAt)).toBeLessThan(2000);
    child.kill();
  });

  it("leaves out a process that exited and pids that are not positive whole numbers", async () => {
    const { child } = spawnIdle();
    const pid = child.pid as number;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await until(() => !alive(pid), "the child gone");
    const times = await control.startTimes([pid, 0, -4, Number.NaN, 1.5]);
    expect(times?.has(pid)).toBe(false);
    expect(times?.size).toBe(0);
  });

  it("says the OS could not be read instead of reporting every process gone", async () => {
    const { child } = spawnIdle();
    if (process.platform === "win32") {
      const nowhere = createProcessControl({
        platform: "win32",
        env: { SystemRoot: "Z:\no-windows-here" },
        timeoutMs: 2000,
      });
      await expect(nowhere.startTimes([child.pid as number])).resolves.toBeUndefined();
      await expect(nowhere.processTable()).resolves.toBeUndefined();
    }
    const unknownOs = createProcessControl({ platform: "aix" });
    await expect(unknownOs.startTimes([child.pid as number])).resolves.toBeUndefined();
    await expect(unknownOs.processTable()).resolves.toBeUndefined();
    expect(alive(child.pid as number)).toBe(true);
    child.kill();
  });

  it("lists every process with its parent pid and start time in one snapshot", async () => {
    const tree = await spawnTree();
    const table = (await control.processTable()) ?? [];
    const parent = table.find((entry) => entry.pid === tree.parent);
    const grandchild = table.find((entry) => entry.pid === tree.grandchild);
    expect(parent?.parentPid).toBe(process.pid);
    expect(grandchild?.parentPid).toBe(tree.parent);
    expect(Math.abs((parent?.startedAt ?? 0) - tree.startedAt)).toBeLessThan(2000);
    // A child never started before its parent.
    expect(grandchild?.startedAt).toBeGreaterThanOrEqual(
      parent?.startedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("kills one process and never the process it started", async () => {
    const tree = await spawnTree();
    const table = (await control.processTable()) ?? [];
    const parent = table.find((entry) => entry.pid === tree.parent);
    if (parent === undefined) throw new Error("the parent is not in the snapshot");
    control.killProcess(parent);
    await until(() => !alive(tree.parent), "the parent killed", 3000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(tree.grandchild)).toBe(true);
  });

  it("ignores a pid that is not running, an invalid one and its own process", async () => {
    const { child, startedAt } = spawnIdle();
    const pid = child.pid as number;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await until(() => !alive(pid), "the child gone");
    expect(() => control.killProcess({ pid, parentPid: process.pid, startedAt })).not.toThrow();
    expect(() => control.killProcess({ pid: 0, parentPid: 0, startedAt })).not.toThrow();
    expect(() => control.killProcess({ pid: 1.5, parentPid: 0, startedAt })).not.toThrow();
    control.killProcess({ pid: process.pid, parentPid: process.ppid, startedAt: Date.now() });
    expect(alive(process.pid)).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "on Linux leaves a pid alone whose start time is not the one of the snapshot",
    async () => {
      const tree = await spawnTree();
      control.killProcess({
        pid: tree.parent,
        parentPid: process.pid,
        startedAt: tree.startedAt - 3_600_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(alive(tree.parent)).toBe(true);
    },
  );
});

describe("cimDateTimeMs", () => {
  it("reads WMI's local time with its offset from UTC in minutes", () => {
    expect(cimDateTimeMs("20261018065856.881208-300")).toBe(Date.UTC(2026, 9, 18, 11, 58, 56, 881));
    expect(cimDateTimeMs("20261018065856.881208+060")).toBe(Date.UTC(2026, 9, 18, 5, 58, 56, 881));
    expect(cimDateTimeMs("20261018065856.000000+000")).toBe(Date.UTC(2026, 9, 18, 6, 58, 56));
  });

  it("refuses anything else", () => {
    expect(cimDateTimeMs("")).toBeUndefined();
    expect(cimDateTimeMs("2026-10-18 06:58:56")).toBeUndefined();
    expect(cimDateTimeMs("20261018065856.881208")).toBeUndefined();
  });
});
