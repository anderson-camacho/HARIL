import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlClient } from "@haril/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarilActions } from "../src/actions.js";
import { createShellApp, type ShellApp, type ShellAppOptions } from "../src/app.js";
import { openShellData, type ShellData } from "../src/data.js";
import type { ConnectControl } from "../src/live.js";
import { resolveTheme } from "../src/theme.js";
import { createTask, openSeedStore, type SeedResult, seedStore } from "./seed.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The shell with the live feed (LD-T2): the banner says live while subscribed, a wake reloads the store, and quit
// ends the subscription. The control client is a fake; the store is real.
const THEME = resolveTheme({ name: "haril-dark", runtimeRoot: "/nonexistent-haril-root" }).theme;
const TASKS_PANEL = "2";

let root: string;
let dataDir: string;
let runtimeRoot: string;
const opened: ShellData[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haril-shell-live-"));
  dataDir = join(root, "data");
  runtimeRoot = join(root, "runtime");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, "config", "themes"), { recursive: true });
});

afterEach(() => {
  for (const data of opened.splice(0)) data.close();
  rmSync(root, { recursive: true, force: true });
});

interface FakeControl {
  readonly connect: ConnectControl;
  readonly requests: { subscribe: boolean }[];
  readonly client: ControlClient;
  wake(seq: number): void;
  readonly closes: () => number;
}

function fakeControl(): FakeControl {
  const wakeListeners: ((seq: number) => void)[] = [];
  const requests: { subscribe: boolean }[] = [];
  let closes = 0;
  const client: ControlClient = {
    onWake: (listener) => {
      wakeListeners.push(listener);
      return () => undefined;
    },
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    nudge: () => undefined,
    close: () => {
      closes += 1;
    },
  };
  return {
    connect: async (_dir, options) => {
      requests.push({ subscribe: options.subscribe });
      return client;
    },
    requests,
    client,
    wake: (seq) => {
      for (const listener of wakeListeners) listener(seq);
    },
    closes: () => closes,
  };
}

function mount(
  connectControl: ConnectControl,
  harilEntry?: string,
  extra: Pick<ShellAppOptions, "now" | "readGit"> = {},
): {
  terminal: VirtualTerminal;
  app: ShellApp;
  data: ShellData;
} {
  const data = openShellData({
    paths: {
      dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
    },
    env: {},
  });
  opened.push(data);
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
    connectControl,
    ...extra,
  });
  return { terminal, app, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function started(app: ShellApp): Promise<void> {
  app.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function frame(app: ShellApp): string {
  return app.frameText().join("\n");
}

describe("shell app with the live feed (LD-T2)", () => {
  let seeded: SeedResult;

  beforeEach(() => {
    seeded = seedStore(dataDir);
  });

  it("shows live in the banner once subscribed, and a wake reloads a task created meanwhile", async () => {
    const control = fakeControl();
    const { terminal, app } = mount(control.connect);
    await started(app);

    expect(control.requests).toEqual([{ subscribe: true }]);
    expect(frame(app)).toContain("· live");

    terminal.send(TASKS_PANEL);
    expect(frame(app)).not.toContain("Fresh task");

    const writer = openSeedStore(dataDir);
    try {
      createTask(writer, seeded.demoId, seeded.epoch, "Fresh task");
    } finally {
      writer.close();
    }

    control.wake(1);
    expect(frame(app)).toContain("Fresh task");

    terminal.send("q");
    await app.done;
    expect(control.closes()).toBe(1);
  });

  it("subscribes after an action once a runtime is up, without waiting for r (LD-T5)", async () => {
    const control = fakeControl();
    // A store with one project and no runtime lease: the shell opens idle and does not subscribe.
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const store = openSeedStore(dataDir);
    store.projects.register({ slug: "solo", name: "Solo", rootPath: "/work/solo" });
    store.close();
    // The fixture haril prints what task add prints and writes nothing.
    const entry = join(root, "haril.mjs");
    writeFileSync(entry, 'process.stdout.write("command c-1: queued\\n");\n', "utf8");
    const { terminal, app } = mount(control.connect, entry);
    await started(app);
    expect(control.requests).toEqual([]);

    // A runtime starts elsewhere (haril start in another terminal) while the shell is open.
    const runtime = openSeedStore(dataDir);
    try {
      const grant = runtime.runtime.acquire({
        pid: process.pid,
        nodeVersion: process.version,
        sqliteVersion: runtime.info().sqliteVersion,
        ttlMs: 600_000,
      });
      expect(grant.ok).toBe(true);
    } finally {
      runtime.close();
    }

    terminal.send("a");
    for (const key of "Queued now") terminal.send(key);
    terminal.send("\r");
    const deadline = Date.now() + 10_000;
    while (!frame(app).includes("c-1: queued") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(frame(app)).toContain("c-1: queued");
    expect(control.requests).toEqual([{ subscribe: true }]);
    expect(frame(app)).toContain("· live");

    terminal.send("q");
    await app.done;
  });

  it("does not subscribe when no runtime is active", async () => {
    const control = fakeControl();
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    const { terminal, app } = mount(control.connect);
    await started(app);

    expect(control.requests).toEqual([]);
    expect(frame(app)).not.toContain("· live");

    terminal.send("q");
    await app.done;
  });
});

describe("git reads while the runtime wakes the shell (LD-T6b-1)", () => {
  it("a wake reads git at most once every 5 s of the shell's clock; opening and r always read", async () => {
    // One project and a live runtime lease held by this process, so the shell subscribes.
    const store = openSeedStore(dataDir);
    try {
      store.projects.register({ slug: "solo", name: "Solo", rootPath: "/work/solo" });
      const grant = store.runtime.acquire({
        pid: process.pid,
        nodeVersion: process.version,
        sqliteVersion: store.info().sqliteVersion,
        ttlMs: 600_000,
      });
      expect(grant.ok).toBe(true);
    } finally {
      store.close();
    }
    const control = fakeControl();
    let clock = 1_000_000;
    const reads: string[] = [];
    const { terminal, app } = mount(control.connect, undefined, {
      now: () => clock,
      readGit: async (rootPath) => {
        reads.push(rootPath);
        return { branch: "main", changes: 0 };
      },
    });
    await started(app);
    expect(control.requests).toEqual([{ subscribe: true }]);
    expect(reads).toHaveLength(1);

    // The feed reloads on a wake at most every 250 ms of real time, so the wakes are spaced by more than that.
    clock += 1_000;
    control.wake(1);
    await sleep(5);
    expect(reads).toHaveLength(1);
    await sleep(300);
    clock += 3_999;
    control.wake(2);
    await sleep(5);
    expect(reads).toHaveLength(1);
    await sleep(300);
    clock += 1;
    control.wake(3);
    await sleep(5);
    expect(reads).toHaveLength(2);
    // r reads at once, whenever the last read was.
    terminal.send("r");
    await sleep(5);
    expect(reads).toHaveLength(3);

    terminal.send("q");
    await app.done;
  });
});
