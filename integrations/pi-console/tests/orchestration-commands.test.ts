import { beforeEach, describe, expect, it } from "vitest";
import { type CommandHost, registerCommands } from "../src/commands.js";
import type { DashboardArea } from "../src/dashboard.js";
import { demoNotice } from "../src/orchestration-state.js";
import type { AutocompleteItem, ConsoleContext, ConsolePi } from "../src/pi-types.js";

// /orchestration keeps its area alias and adds two subcommands: `demo` toggles the sample data and `view` opens the
// full view. A fake Pi records what the console registers; no Pi process runs.

interface Registered {
  readonly getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler(args: string, ctx: ConsoleContext): Promise<void>;
}

let commands: Map<string, Registered>;
let notes: [string, string | undefined][];
let opened: DashboardArea[];
let views: number;
let demo: boolean;
let ctx: ConsoleContext;

function fakePi(): ConsolePi {
  const listeners: ((event: unknown, context: ConsoleContext) => void)[] = [];
  const pi = {
    registerCommand(name: string, options: Registered) {
      commands.set(name, options);
    },
    on(event: string, handler: (event: unknown, context: ConsoleContext) => void) {
      if (event === "session_start") listeners.push(handler);
      return () => undefined;
    },
    getCommands: () => [],
    start() {
      for (const listener of listeners) listener({ reason: "startup" }, ctx);
    },
  };
  return pi as unknown as ConsolePi & { start(): void };
}

function fakeHost(): CommandHost {
  const host = {
    cwd: "fake-cwd",
    project: undefined,
    pending: [],
    area: undefined,
    started: undefined,
    harilModelRef: () => undefined,
    showOutput: () => undefined,
    clearOutput: () => undefined,
    openArea(area: DashboardArea) {
      opened.push(area);
    },
    rebind: async () => undefined,
    refresh: async () => undefined,
    reload: async () => undefined,
    openActions: async () => undefined,
    toggleOrchestrationDemo() {
      demo = !demo;
      return demo;
    },
    async openOrchestrationView() {
      views++;
    },
    mode: () => "action",
    switchMode: () => undefined,
    lastPlan: () => undefined,
  };
  return host as CommandHost;
}

function command(name: string): Registered {
  const found = commands.get(name);
  if (found === undefined) throw new Error(`/${name} is not registered`);
  return found;
}

beforeEach(() => {
  commands = new Map();
  notes = [];
  opened = [];
  views = 0;
  demo = false;
  ctx = {
    ui: {
      notify(message: string, type?: string) {
        notes.push([message, type]);
      },
    },
  } as unknown as ConsoleContext;
  const pi = fakePi() as ConsolePi & { start(): void };
  const host = fakeHost();
  registerCommands(pi, () => host);
  pi.start();
});

describe("/orchestration", () => {
  it("demo toggles the sample data and opens the area", async () => {
    await command("orchestration").handler("demo", ctx);
    expect(demo).toBe(true);
    expect(opened).toEqual(["orchestration"]);
    expect(notes.at(-1)).toEqual([demoNotice(true), "info"]);
    await command("orchestration").handler(" DEMO ", ctx);
    expect(demo).toBe(false);
    expect(notes.at(-1)).toEqual([demoNotice(false), "info"]);
  });

  it("view opens the full view", async () => {
    await command("orchestration").handler("view", ctx);
    expect(views).toBe(1);
    expect(opened).toEqual(["orchestration"]);
  });

  it("without arguments keeps the area alias", async () => {
    await command("orchestration").handler("", ctx);
    expect(opened).toEqual(["orchestration"]);
    expect(views).toBe(0);
    expect(demo).toBe(false);
    expect(notes.at(-1)?.[1]).toBe("info");
  });

  it("an unknown argument opens the area and shows the usage", async () => {
    await command("orchestration").handler("bogus", ctx);
    expect(opened).toEqual(["orchestration"]);
    expect(notes.at(-1)).toEqual(["usage: /orchestration [demo|view]", "warning"]);
  });

  it("completes its two subcommands", () => {
    const complete = command("orchestration").getArgumentCompletions;
    expect(complete?.("")?.map((item) => item.value)).toEqual(["demo", "view"]);
    expect(complete?.("v")?.map((item) => item.value)).toEqual(["view"]);
  });

  it("other area aliases ignore arguments as before", async () => {
    await command("agents").handler("demo", ctx);
    expect(opened).toEqual(["agents"]);
    expect(demo).toBe(false);
  });
});
