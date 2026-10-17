import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShell, type ShellRunDeps } from "../src/run.js";
import type { RuntimeCommand, SpawnRuntime } from "../src/runtime-start.js";
import { openSeedStore, queueTask } from "./seed.js";
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
    // No git runs in these tests; the git read has its own tests in integrations/git.
    readGit: async () => undefined,
    createTerminal: () => {
      created.count++;
      // Esc leaves input mode, the default (LD-T6b-2); q quits in navigation mode.
      return new VirtualTerminal(["\x1b", "q"]);
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
    expect(err.join("\n")).toContain("--no-runtime");
  });
});

describe("runShell and the runtime (LD-T6)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "haril-shell-main-"));
    mkdirSync(join(root, "data"));
    // One project with a queued task and no runtime lease: work waits for a runtime.
    const store = openSeedStore(join(root, "data"));
    try {
      const project = store.projects.register({ slug: "solo", name: "Solo", rootPath: "/w" });
      queueTask(store, project.projectId, "Waiting work");
    } finally {
      store.close();
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function argsFor(extra: readonly string[]): string[] {
    const runtimeRoot = join(root, "runtime");
    return [
      "--data-dir",
      join(root, "data"),
      "--runtime-root",
      runtimeRoot,
      "--config",
      join(runtimeRoot, "config", "haril.json"),
      "--haril",
      join(root, "haril.mjs"),
      ...extra,
    ];
  }

  function recordingSpawn(): { spawn: SpawnRuntime; commands: RuntimeCommand[] } {
    const commands: RuntimeCommand[] = [];
    return {
      commands,
      spawn: (command) => {
        commands.push(command);
        return { pid: 4242, running: true, onExit: () => undefined };
      },
    };
  }

  it("starts the runtime through its spawn port when work waits", async () => {
    const recorder = recordingSpawn();
    const { deps } = harness({ spawnRuntime: recorder.spawn });
    expect(await runShell(argsFor([]), deps)).toBe(0);
    expect(recorder.commands.map((command) => command.args)).toEqual([
      ["start", "--started-by", "shell", "--data-dir", join(root, "data")],
    ]);
  });

  it("never starts one with --no-runtime", async () => {
    const recorder = recordingSpawn();
    const { deps } = harness({ spawnRuntime: recorder.spawn });
    expect(await runShell(argsFor(["--no-runtime"]), deps)).toBe(0);
    expect(recorder.commands).toEqual([]);
  });
});
