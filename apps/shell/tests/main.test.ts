import { describe, expect, it } from "vitest";
import { runShell, type ShellRunDeps } from "../src/run.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Entry point (TUI-D8): without a terminal on stdin and stdout the shell refuses to start with exit 2.

function harness(overrides: Partial<ShellRunDeps> = {}) {
  const err: string[] = [];
  const created = { count: 0 };
  const deps: ShellRunDeps = {
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderr: (line) => err.push(line),
    readFile: () => undefined,
    createTerminal: () => {
      created.count++;
      return new VirtualTerminal(["q"]);
    },
    ...overrides,
  };
  return { deps, err, created };
}

const ARGS = ["--data-dir", "/d", "--runtime-root", "/r", "--config", "/r/config/haril.json"];

describe("runShell", () => {
  it("refuses to start without a TTY on stdin, exit 2 with a clear message", async () => {
    const { deps, err, created } = harness({ stdinIsTTY: false });
    expect(await runShell(ARGS, deps)).toBe(2);
    expect(created.count).toBe(0);
    expect(err.join("\n")).toMatch(/interactive terminal/);
  });

  it("refuses to start without a TTY on stdout, exit 2", async () => {
    const { deps, err, created } = harness({ stdoutIsTTY: false });
    expect(await runShell(ARGS, deps)).toBe(2);
    expect(created.count).toBe(0);
    expect(err.join("\n")).toMatch(/interactive terminal/);
  });

  it("starts on a terminal and exits 0 after q", async () => {
    const { deps, created } = harness();
    expect(await runShell(ARGS, deps)).toBe(0);
    expect(created.count).toBe(1);
  });

  it("rejects an unknown argument with exit 2 and usage text", async () => {
    const { deps, err } = harness();
    expect(await runShell(["--nope"], deps)).toBe(2);
    expect(err.join("\n")).toMatch(/usage: shell/);
  });
});
