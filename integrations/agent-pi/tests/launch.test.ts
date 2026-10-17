import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killProcessTree } from "../src/launch.js";

// killProcessTree's Windows path with the tree killer replaced, so the order and the fallback are checked on any OS.

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

function idleChild(): ChildProcess {
  const child = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function exited(child: ChildProcess): Promise<void> {
  if (!running(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("killProcessTree on Windows", () => {
  it("leaves the child alive for taskkill's tree walk and kills it once taskkill exits", async () => {
    const child = idleChild();
    const killer = new EventEmitter() as ChildProcess;
    const calls: { command: string; args: readonly string[] }[] = [];
    killProcessTree(child, { SystemRoot: "C:\\Windows" }, "win32", (command, args) => {
      calls.push({ command, args });
      return killer;
    });
    expect(calls).toEqual([
      {
        command: join("C:\\Windows", "System32", "taskkill.exe"),
        args: ["/F", "/T", "/PID", String(child.pid)],
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(running(child)).toBe(true);
    killer.emit("exit", 1, null);
    await exited(child);
  });

  it("kills the child itself when taskkill cannot be started", async () => {
    const child = idleChild();
    const missing = join(import.meta.dirname, "fake-missing-taskkill.exe");
    killProcessTree(child, { SystemRoot: "C:\\Windows" }, "win32", (_command, args) =>
      nodeSpawn(missing, [...args], { stdio: "ignore" }),
    );
    await exited(child);
  });

  it("kills the child itself when starting taskkill throws", async () => {
    const child = idleChild();
    killProcessTree(child, { SystemRoot: "C:\\Windows" }, "win32", () => {
      throw new Error("spawn refused");
    });
    await exited(child);
  });
});
