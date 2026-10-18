import { type ChildProcess, spawn } from "node:child_process";
import type { ProcessControl, ProcessEntry } from "@haril/core/ports";
import { afterEach, describe, expect, it } from "vitest";
import { killTrees } from "../src/runtime/processes.js";
import { alive, killNoted, type NotedProcess, processControl, until } from "./process-helpers.js";

// The tree kill of a recorded agent (docs/modos-y-delegacion.md 3.14): the runtime walks the tree itself from one
// snapshot of the OS's processes, instead of the OS's tree kill, which follows parent pids alone. A root is killed only
// while it still has its recorded start time; a descendant only when it started at or after its parent; every pid is
// killed on its own, children first.

// A child that starts a detached grandchild (only a kill ends it), prints its pid and idles.
const TREE_SCRIPT =
  "const { spawn } = require('node:child_process');" +
  "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });" +
  "console.log(g.pid); setInterval(() => {}, 1000);";

let strays: NotedProcess[] = [];

afterEach(async () => {
  await killNoted(strays);
  strays = [];
});

async function spawnTree(): Promise<{ pid: number; grandchild: number; startedAt: number }> {
  const child: ChildProcess = spawn(process.execPath, ["-e", TREE_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const startedAt = Date.now();
  const pid = child.pid as number;
  strays.push({ pid, startedAt });
  const grandchild = await new Promise<number>((resolve, reject) => {
    child.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString("utf8").trim())));
    child.once("error", reject);
  });
  strays.push({ pid: grandchild, startedAt: Date.now() });
  return { pid, grandchild, startedAt };
}

// The OS as a fixed snapshot; the kills it receives are recorded, in order.
function snapshotOs(table: readonly ProcessEntry[] | undefined): ProcessControl & {
  readonly kills: number[];
} {
  const kills: number[] = [];
  return {
    kills,
    startTimes: async () => new Map(),
    processTable: async () => table,
    killProcess: (target) => {
      kills.push(target.pid);
    },
  };
}

describe("killTrees", () => {
  it("kills a recorded root and every process under it, the grandchild before the root", async () => {
    const tree = await spawnTree();
    const result = await killTrees(processControl, [{ pid: tree.pid, startedAt: tree.startedAt }]);
    expect(result?.roots).toEqual([tree.pid]);
    // The root and its grandchild at least; Windows may also list the hidden console host it started.
    expect(result?.killed).toBeGreaterThanOrEqual(2);
    await until(() => !alive(tree.pid) && !alive(tree.grandchild), "the tree killed", 3000);
  });

  it("leaves a root and its tree alone when its pid no longer names the recorded process", async () => {
    const tree = await spawnTree();
    const result = await killTrees(processControl, [
      { pid: tree.pid, startedAt: tree.startedAt - 3_600_000 },
    ]);
    expect(result).toEqual({ roots: [], killed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(tree.pid)).toBe(true);
    expect(alive(tree.grandchild)).toBe(true);
  });

  it("never kills a stranger that names the root as its parent but started before it, nor this process", async () => {
    const T = 1_800_000_000_000;
    const os = snapshotOs([
      { pid: 500, parentPid: 1, startedAt: T },
      { pid: 501, parentPid: 500, startedAt: T + 10 },
      { pid: 502, parentPid: 501, startedAt: T + 20 },
      // Its real parent died long ago and the OS gave that pid to the agent.
      { pid: 503, parentPid: 500, startedAt: T - 60_000 },
      { pid: process.pid, parentPid: 501, startedAt: T + 30 },
    ]);
    const result = await killTrees(os, [{ pid: 500, startedAt: T }], "win32");
    expect(result).toEqual({ roots: [500], killed: 3 });
    expect(os.kills).toEqual([502, 501, 500]);
  });

  it("kills nothing when the OS's process list cannot be read", async () => {
    const os = snapshotOs(undefined);
    expect(await killTrees(os, [{ pid: 500, startedAt: 1 }])).toBeUndefined();
    expect(os.kills).toEqual([]);
  });
});
