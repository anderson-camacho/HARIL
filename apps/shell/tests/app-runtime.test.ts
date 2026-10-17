import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ControlClient } from "@haril/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarilActions } from "../src/actions.js";
import { createShellApp, type ShellApp } from "../src/app.js";
import { openShellData, type ShellData } from "../src/data.js";
import type { ConnectControl } from "../src/live.js";
import {
  createRuntimeStarter,
  type RuntimeCommand,
  runtimeLogFile,
  type SpawnedRuntime,
} from "../src/runtime-start.js";
import { resolveTheme } from "../src/theme.js";
import {
  openSeedStore,
  proposeExamplePlan,
  queueTask,
  releaseSeedLease,
  seedStore,
} from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The shell starts the runtime (LD-T6, ADR-0022): only when work waits and no live lease exists, on opening and after
// an action that queues work, once at a time, and it then subscribes through a bounded handshake. The spawn is a fake
// that records the command, so no test starts a real runtime; the store is real.

const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;
const ENTER = "\r";
// The pid the fake runtime gets. The shell's data treats it as alive, like this test process.
const CHILD_PID = 4242;
// The pid of a runtime that won the lease race against the shell's child.
const WINNER_PID = 5151;
const FAKE_SECRET = "fake-provider-value-not-a-key";

let root: string;
let dataDir: string;
let runtimeRoot: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-runtime-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, "config", "themes"), { recursive: true });
});

afterEach(() => {
  for (const data of opened.splice(0)) data.close();
  rmSync(root, { recursive: true, force: true });
});

interface FakeSpawn {
  readonly commands: RuntimeCommand[];
  spawn(command: RuntimeCommand): SpawnedRuntime;
  // Ends the newest fake runtime with this exit code, as an idle exit (0) or a refusal does.
  exit(code?: number): void;
}

interface FakeChild {
  running: boolean;
  readonly listeners: ((code: number | null) => void)[];
}

// `onSpawn` runs as the fake runtime starts, to play what the real one does (take the lease, for instance). With
// `crashCode`, every child exits with it right after it starts, before it takes any lease (a crash, or a stale entry).
function fakeSpawn(onSpawn: () => void = () => {}, crashCode?: number): FakeSpawn {
  const commands: RuntimeCommand[] = [];
  let current: FakeChild | undefined;
  const end = (child: FakeChild, code: number): void => {
    if (!child.running) return;
    child.running = false;
    for (const listener of child.listeners) listener(code);
  };
  return {
    commands,
    spawn(command) {
      commands.push(command);
      const child: FakeChild = { running: true, listeners: [] };
      current = child;
      onSpawn();
      if (crashCode !== undefined) setTimeout(() => end(child, crashCode), 10);
      return {
        pid: CHILD_PID,
        get running() {
          return child.running;
        },
        onExit: (listener) => {
          child.listeners.push(listener);
        },
      };
    },
    exit(code = 0) {
      if (current !== undefined) end(current, code);
    },
  };
}

interface FakeControl {
  readonly connect: ConnectControl;
  readonly calls: () => number;
}

// Answers once `up()` says a runtime is up; until then no runtime answers, as before the lease is taken.
function fakeControl(up: () => boolean = () => false): FakeControl {
  let calls = 0;
  const client: ControlClient = {
    onWake: () => () => undefined,
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    nudge: () => undefined,
    close: () => undefined,
  };
  return {
    connect: async () => {
      calls += 1;
      return up() ? client : undefined;
    },
    calls: () => calls,
  };
}

// The fixture haril: prints one line and exits 0, as task add and approve do. It never writes the store.
function fakeHaril(line: string): string {
  const entry = join(root, `haril-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(entry, `process.stdout.write(${JSON.stringify(`${line}\n`)});\n`, "utf8");
  return entry;
}

interface Mounted {
  readonly terminal: VirtualTerminal;
  readonly app: ShellApp;
}

function mount(options: {
  spawn: FakeSpawn;
  control?: FakeControl;
  harilEntry?: string;
  isPidAlive?: (pid: number) => boolean;
  // False plays haril shell --no-runtime: the app gets no starter.
  starter?: boolean;
}): Mounted {
  const data = openShellData({
    paths: { dataDir, runtimeRoot, configPath: join(runtimeRoot, "config", "haril.json") },
    env: { HARIL_CLIPROXYAPI_KEY: FAKE_SECRET },
    isPidAlive:
      options.isPidAlive ??
      ((pid) => pid === CHILD_PID || pid === WINNER_PID || pid === process.pid),
  });
  opened.push(data);
  const harilEntry = options.harilEntry ?? fakeHaril("unused");
  const terminal = new VirtualTerminal();
  const app = createShellApp({
    terminal,
    theme: THEME,
    banner: { isolation: "N0" },
    data,
    settings: {
      dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
      themeName: "haril-dark",
      themeLabel: "haril-dark",
    },
    actions: createHarilActions({ harilEntry }),
    connectControl: (options.control ?? fakeControl()).connect,
    ...(options.starter === false
      ? {}
      : {
          runtimeStarter: createRuntimeStarter({
            harilEntry,
            dataDir,
            runtimeRoot,
            spawn: (command) => options.spawn.spawn(command),
          }),
        }),
  });
  return { terminal, app };
}

// The frame with its line breaks as spaces: the banner and the status wrap at 80 columns.
function screen(mounted: Mounted): string {
  return mounted.app.frameText().join("\n").replace(/\s+/g, " ");
}

async function waitFor(mounted: Mounted, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (screen(mounted).includes(text)) return;
    await sleep(25);
  }
  throw new Error(`the frame never showed "${text}":\n${mounted.app.frameText().join("\n")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function quit(mounted: Mounted): Promise<void> {
  mounted.terminal.send("q");
  await mounted.app.done;
}

// One project and no runtime lease; `queued` leaves one task.create waiting for a runtime.
function soloStore(queued: boolean): string {
  const store = openSeedStore(dataDir);
  try {
    const project = store.projects.register({ slug: "solo", name: "Solo", rootPath: "/work/solo" });
    if (queued) queueTask(store, project.projectId, "Waiting work");
    return project.projectId;
  } finally {
    store.close();
  }
}

// The fake runtime takes the lease with its own pid, as haril start does once it is up.
function takeLease(pid = CHILD_PID): void {
  const store = openSeedStore(dataDir);
  try {
    const grant = store.runtime.acquire({
      pid,
      nodeVersion: process.version,
      sqliteVersion: store.info().sqliteVersion,
      ttlMs: 600_000,
    });
    if (!grant.ok) throw new Error("the fake runtime could not take the lease");
  } finally {
    store.close();
  }
}

describe("the shell starts the runtime on opening (LD-T6)", () => {
  it("starts one runtime when work is queued, with the shell's argv and nothing else", async () => {
    soloStore(true);
    const spawn = fakeSpawn();
    const harilEntry = fakeHaril("unused");
    const mounted = mount({ spawn, harilEntry });
    mounted.app.start();

    expect(spawn.commands).toStrictEqual([
      {
        harilEntry,
        args: ["start", "--started-by", "shell", "--data-dir", dataDir],
        logFile: runtimeLogFile(runtimeRoot, Date.now()),
        cwd: runtimeRoot,
      },
    ]);
    expect(spawn.commands[0]?.logFile).toMatch(/[\\/]logs[\\/]runtime-\d{4}-\d{2}-\d{2}\.log$/);
    expect(JSON.stringify(spawn.commands)).not.toContain(FAKE_SECRET);
    expect(screen(mounted)).toContain(`runtime starting (started by shell, pid ${CHILD_PID})`);
    expect(screen(mounted)).toContain(`starting the runtime (pid ${CHILD_PID})`);
    // r while the runtime is starting starts no second one.
    mounted.terminal.send("r");
    expect(spawn.commands).toHaveLength(1);
    await quit(mounted);
  });

  it("starts nothing when no work waits", async () => {
    soloStore(false);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn });
    mounted.app.start();
    expect(spawn.commands).toEqual([]);
    expect(screen(mounted)).toContain("runtime idle");
    await quit(mounted);
  });

  it("starts nothing while a live runtime holds the lease", async () => {
    // The seeded lease belongs to this process, and a ready task waits.
    seedStore(dataDir);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn });
    mounted.app.start();
    expect(spawn.commands).toEqual([]);
    expect(screen(mounted)).toContain(`runtime running (pid ${process.pid})`);
    await quit(mounted);
  });

  it("starts one when the lease holder's process is gone", async () => {
    seedStore(dataDir);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn, isPidAlive: (pid) => pid === CHILD_PID });
    mounted.app.start();
    expect(spawn.commands).toHaveLength(1);
    await quit(mounted);
  });

  it("shows started by shell once the runtime holds the lease, and subscribes through the handshake", async () => {
    soloStore(true);
    let up = false;
    const spawn = fakeSpawn(() => {
      takeLease();
      up = true;
    });
    const control = fakeControl(() => up);
    const mounted = mount({ spawn, control });
    mounted.app.start();
    await waitFor(mounted, "· live");
    // The status line names the runtime and the top bar the only project (LD-T6b-1).
    expect(mounted.app.frameText().at(-1)).toContain(
      `runtime running (started by shell, pid ${CHILD_PID}) · live`,
    );
    expect(mounted.app.frameText()[0]).toMatch(/^◆ HARIL ◇ solo ◇ .*runtime running$/);
    expect(screen(mounted)).toContain(`runtime started (pid ${CHILD_PID})`);
    expect(control.calls()).toBe(1);
    await quit(mounted);
  });

  it("gives up the handshake after about 3 s, says to press r and tries nothing more", async () => {
    soloStore(true);
    const spawn = fakeSpawn();
    const control = fakeControl();
    const mounted = mount({ spawn, control });
    const began = Date.now();
    mounted.app.start();
    await waitFor(mounted, "runtime starting… press r");
    expect(Date.now() - began).toBeGreaterThanOrEqual(2_900);
    // One attempt at once and one after each of the four waits.
    expect(control.calls()).toBe(5);
    await sleep(600);
    expect(control.calls()).toBe(5);
    expect(screen(mounted)).toContain(`runtime starting (started by shell, pid ${CHILD_PID})`);
    expect(spawn.commands).toHaveLength(1);
    await quit(mounted);
  }, 15_000);
});

describe("the shell starts the runtime after an action (LD-T6)", () => {
  it("a goal starts one, a second action meanwhile starts no other, and one exited is replaced", async () => {
    soloStore(false);
    const spawn = fakeSpawn();
    // task add prints the title it was given, so each outcome line is told apart.
    const entry = join(root, "haril-echo.mjs");
    writeFileSync(entry, 'process.stdout.write("queued " + process.argv[4] + "\\n");\n', "utf8");
    const mounted = mount({ spawn, harilEntry: entry });
    mounted.app.start();
    expect(spawn.commands).toEqual([]);

    mounted.terminal.send("g");
    for (const key of "Plan it") mounted.terminal.send(key);
    mounted.terminal.send(ENTER);
    await waitFor(mounted, "queued Plan it");
    expect(spawn.commands).toHaveLength(1);
    expect(screen(mounted)).toContain(`queued Plan it · starting the runtime (pid ${CHILD_PID})`);
    expect(screen(mounted)).not.toContain("start it with haril start");

    mounted.terminal.send("a");
    for (const key of "Add more") mounted.terminal.send(key);
    mounted.terminal.send(ENTER);
    await waitFor(mounted, "queued Add more");
    expect(spawn.commands).toHaveLength(1);

    // The runtime exits idle without having taken the lease: the banner says idle and the next action starts one.
    spawn.exit();
    expect(screen(mounted)).toContain("runtime idle");
    mounted.terminal.send("a");
    for (const key of "Once more") mounted.terminal.send(key);
    mounted.terminal.send(ENTER);
    await waitFor(mounted, "queued Once more");
    expect(spawn.commands).toHaveLength(2);
    await quit(mounted);
  });

  it("approving a plan starts one when no runtime runs", async () => {
    const projectId = soloStore(false);
    const approvalId = proposeExamplePlan(dataDir, projectId);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn, harilEntry: fakeHaril("approval a-1 granted by tester") });
    mounted.app.start();
    // A plan waiting for a decision is no work for the runtime yet.
    expect(spawn.commands).toEqual([]);
    mounted.terminal.send("p");
    expect(screen(mounted)).toContain(approvalId.slice(0, 8));
    mounted.terminal.send("y");
    await waitFor(mounted, "granted by tester");
    expect(spawn.commands).toHaveLength(1);
    expect(spawn.commands[0]?.args).toEqual([
      "start",
      "--started-by",
      "shell",
      "--data-dir",
      dataDir,
    ]);
    await quit(mounted);
  });

  it("an action re-reads the lease and starts nothing once a runtime started elsewhere", async () => {
    soloStore(false);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn, harilEntry: fakeHaril("command c-5: queued") });
    mounted.app.start();
    expect(screen(mounted)).toContain("runtime idle");
    // haril start in another terminal takes the lease after the shell has read the store.
    takeLease();
    mounted.terminal.send("a");
    for (const key of "Later") mounted.terminal.send(key);
    mounted.terminal.send(ENTER);
    await waitFor(mounted, "c-5: queued");
    expect(spawn.commands).toEqual([]);
    expect(screen(mounted)).toContain(`runtime running (pid ${CHILD_PID})`);
    await quit(mounted);
  });

  it("an action after a runtime exited idle starts a new one", async () => {
    const seeded = seedStore(dataDir);
    releaseSeedLease(dataDir, seeded.epoch);
    // The seeded ready task waits, so opening starts one; it exits without taking the lease.
    const spawn = fakeSpawn();
    const mounted = mount({ spawn });
    mounted.app.start();
    expect(spawn.commands).toHaveLength(1);
    spawn.exit();
    mounted.terminal.send("r");
    expect(spawn.commands).toHaveLength(2);
    await quit(mounted);
  });
});

describe("a runtime that fails or loses the lease race (LD-T6)", () => {
  const log = (): string => relative(runtimeRoot, runtimeLogFile(runtimeRoot, Date.now()));

  it("a child that exits before taking the lease is reported with its code and log, and the handshake stops", async () => {
    soloStore(true);
    const spawn = fakeSpawn(undefined, 1);
    const control = fakeControl();
    const mounted = mount({ spawn, control });
    mounted.app.start();
    await waitFor(mounted, `the runtime exited (code 1); see ${log()}`);
    expect(screen(mounted)).not.toContain("starting the runtime");
    expect(screen(mounted)).toContain("runtime idle");
    // The attempt made at the start is the only one: the exit cancelled the waits that followed.
    await sleep(1_000);
    expect(control.calls()).toBe(1);
    expect(screen(mounted)).not.toContain("press r");
    expect(spawn.commands).toHaveLength(1);

    // r tries once per press, and the line says when it failed again.
    mounted.terminal.send("r");
    expect(spawn.commands).toHaveLength(2);
    await waitFor(mounted, `the runtime exited again (code 1); see ${log()}`);
    await sleep(300);
    expect(spawn.commands).toHaveLength(2);
    mounted.terminal.send("r");
    expect(spawn.commands).toHaveLength(3);
    await quit(mounted);
  });

  it("a start that loses the race names the winner, and the loser's exit changes nothing", async () => {
    soloStore(true);
    let up = false;
    const spawn = fakeSpawn(() => {
      takeLease(WINNER_PID);
      up = true;
    });
    const mounted = mount({ spawn, control: fakeControl(() => up) });
    mounted.app.start();
    await waitFor(mounted, "· live");
    expect(screen(mounted)).toContain(`runtime running (pid ${WINNER_PID}) · live`);
    expect(screen(mounted)).not.toContain(`runtime started (pid ${CHILD_PID})`);
    // The status line names the winner too, under the banner.
    expect(
      mounted.app.frameText().some((line) => line.trim() === `runtime running (pid ${WINNER_PID})`),
    ).toBe(true);
    spawn.exit(2);
    expect(screen(mounted)).toContain(`runtime running (pid ${WINNER_PID}) · live`);
    expect(screen(mounted)).not.toContain("the runtime exited");
    await quit(mounted);
  });

  it("a loser that exits before the handshake reaches the winner names the winner", async () => {
    soloStore(true);
    const spawn = fakeSpawn(() => takeLease(WINNER_PID), 2);
    const mounted = mount({ spawn });
    mounted.app.start();
    await waitFor(mounted, `· runtime running (pid ${WINNER_PID})`);
    // The status line names the winner, and so does the line under the tabs.
    expect(mounted.app.frameText().at(-1)).toContain(`runtime running (pid ${WINNER_PID})`);
    expect(
      mounted.app.frameText().some((line) => line.trim() === `runtime running (pid ${WINNER_PID})`),
    ).toBe(true);
    expect(screen(mounted)).not.toContain("the runtime exited");
    await quit(mounted);
  });
});

describe("the shell under --no-runtime (LD-T6)", () => {
  const NOTE = "no runtime is running: start it with haril start";

  it("says on opening that waiting work needs haril start, and starts nothing", async () => {
    soloStore(true);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn, starter: false });
    mounted.app.start();
    expect(screen(mounted)).toContain(NOTE);
    expect(spawn.commands).toEqual([]);
    await quit(mounted);
  });

  it("says nothing without waiting work, and says it on r once work waits", async () => {
    const projectId = soloStore(false);
    const spawn = fakeSpawn();
    const mounted = mount({ spawn, starter: false });
    mounted.app.start();
    expect(screen(mounted)).not.toContain(NOTE);
    const writer = openSeedStore(dataDir);
    try {
      queueTask(writer, projectId, "Queued elsewhere");
    } finally {
      writer.close();
    }
    mounted.terminal.send("r");
    expect(screen(mounted)).toContain(NOTE);
    expect(spawn.commands).toEqual([]);
    await quit(mounted);
  });
});

describe("runtimeLogFile", () => {
  it("names one log per local day under logs/ of the runtime root", () => {
    const day = new Date(2026, 9, 17, 23, 30).getTime();
    expect(runtimeLogFile(runtimeRoot, day)).toBe(
      join(runtimeRoot, "logs", "runtime-2026-10-17.log"),
    );
  });
});
