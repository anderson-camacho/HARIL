import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessControl } from "../src/index.js";
import { cimDateTimeMs } from "../src/processes/process-control.js";

// The OS side of the emergency stop and the startup sweep (docs/modos-y-delegacion.md 3.14): real processes, a real
// tree (a child that starts a grandchild, as Pi starts a tool command) and the real OS queries.

// A child that starts a grandchild, prints the grandchild's pid and idles. POSIX leads its own group, as Pi does.
const PARENT_SCRIPT =
  "const { spawn } = require('node:child_process');" +
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
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
    const observed = times.get(child.pid as number);
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
    expect(times.has(pid)).toBe(false);
    expect(times.size).toBe(0);
  });

  it("kills a recorded root and the process it started, the child first, and reports the root", async () => {
    const tree = await spawnTree();
    expect(alive(tree.parent)).toBe(true);
    expect(alive(tree.grandchild)).toBe(true);
    const result = await control.killTrees([{ pid: tree.parent, startedAt: tree.startedAt }]);
    expect(result?.roots).toEqual([tree.parent]);
    // The root and its child at least; Windows may also list the hidden console host it started.
    expect(result?.killed).toBeGreaterThanOrEqual(2);
    await until(() => !alive(tree.parent) && !alive(tree.grandchild), "the tree killed", 3000);
  });

  it("leaves a root alone, with its children, when its pid no longer names the recorded process", async () => {
    const tree = await spawnTree();
    const result = await control.killTrees([
      { pid: tree.parent, startedAt: tree.startedAt - 3_600_000 },
    ]);
    expect(result).toEqual({ roots: [], killed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(tree.parent)).toBe(true);
    expect(alive(tree.grandchild)).toBe(true);
  });

  it("resolves for a pid that is not running, and ignores an invalid one and its own process", async () => {
    const { child, startedAt } = spawnIdle();
    const pid = child.pid as number;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await until(() => !alive(pid), "the child gone");
    await expect(control.killTrees([{ pid, startedAt }])).resolves.toEqual({
      roots: [],
      killed: 0,
    });
    await expect(control.killTrees([{ pid: 0, startedAt }])).resolves.toEqual({
      roots: [],
      killed: 0,
    });
    await expect(control.killTrees([{ pid: process.pid, startedAt: Date.now() }])).resolves.toEqual(
      {
        roots: [],
        killed: 0,
      },
    );
    expect(alive(process.pid)).toBe(true);
  });
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
