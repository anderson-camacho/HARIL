import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessControl } from "../src/index.js";

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

async function spawnTree(): Promise<{ parent: number; grandchild: number }> {
  const child = spawn(process.execPath, ["-e", PARENT_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const parent = child.pid as number;
  strays.push(parent);
  const grandchild = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim())));
    child.once("error", reject);
  });
  strays.push(grandchild);
  return { parent, grandchild };
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

  it("kills a process and the process it started", async () => {
    const tree = await spawnTree();
    expect(alive(tree.parent)).toBe(true);
    expect(alive(tree.grandchild)).toBe(true);
    await control.killTree(tree.parent);
    await until(() => !alive(tree.parent) && !alive(tree.grandchild), "the tree killed", 3000);
  });

  it("resolves for a pid that is not running, and ignores an invalid one", async () => {
    const { child } = spawnIdle();
    const pid = child.pid as number;
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(control.killTree(pid)).resolves.toBeUndefined();
    await expect(control.killTree(0)).resolves.toBeUndefined();
  });
});
