import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlClient } from "@haril/control";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createShellApp, type ShellApp } from "../src/app.js";
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

function mount(connectControl: ConnectControl): {
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
    banner: { isolation: "N0", pendingApprovals: 0 },
    data,
    settings: {
      dataDir,
      runtimeRoot,
      configPath: join(runtimeRoot, "config", "haril.json"),
      themeName: "haril-dark",
      themeLabel: "haril-dark",
    },
    connectControl,
  });
  return { terminal, app, data };
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
