import type {
  ConsoleContext,
  ConsolePi,
  ConsoleToolDefinition,
  EntryRenderer,
  SessionEntry,
} from "../src/pi-types.js";

// A fake ConsolePi for the F4 tests: it records what the console registers (handlers, commands, tools, shortcuts,
// entry renderers), keeps the active tools and the appended entries, and lets a test fire Pi's events. No Pi process
// runs.

type AnyHandler = (event: unknown, ctx: ConsoleContext) => unknown;

interface RegisteredCommand {
  readonly description: string;
  handler(args: string, ctx: ConsoleContext): Promise<void>;
}

export interface FakePi {
  readonly pi: ConsolePi;
  readonly handlers: Map<string, AnyHandler[]>;
  readonly commands: Map<string, RegisteredCommand>;
  readonly tools: Map<string, ConsoleToolDefinition>;
  readonly shortcuts: Map<string, (ctx: ConsoleContext) => void>;
  readonly renderers: Map<string, EntryRenderer>;
  readonly entries: SessionEntry[];
  active: string[];
  readonly setActiveCalls: string[][];
  // Fires an event and returns every handler's result, in order.
  fire(event: string, payload: unknown, ctx: ConsoleContext): Promise<unknown[]>;
}

const PI_BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

export function fakePi(options: { readonly extraTools?: readonly string[] } = {}): FakePi {
  const handlers = new Map<string, AnyHandler[]>();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, ConsoleToolDefinition>();
  const shortcuts = new Map<string, (ctx: ConsoleContext) => void>();
  const renderers = new Map<string, EntryRenderer>();
  const entries: SessionEntry[] = [];
  const setActiveCalls: string[][] = [];
  const builtins = [...PI_BUILTIN_TOOLS, ...(options.extraTools ?? [])];
  const fake: FakePi = {
    handlers,
    commands,
    tools,
    shortcuts,
    renderers,
    entries,
    active: ["read", "bash", "edit", "write"],
    setActiveCalls,
    async fire(event, payload, ctx) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
      return results;
    },
    pi: undefined as unknown as ConsolePi,
  };
  const pi = {
    on(event: string, handler: AnyHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    registerCommand(name: string, options: RegisteredCommand) {
      commands.set(name, options);
    },
    registerTool(tool: ConsoleToolDefinition) {
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false) fake.active = [...fake.active, tool.name];
    },
    registerEntryRenderer(customType: string, renderer: EntryRenderer) {
      renderers.set(customType, renderer);
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerShortcut(key: string, options: { handler(ctx: ConsoleContext): void }) {
      shortcuts.set(key, options.handler);
    },
    registerProvider: () => undefined,
    getActiveTools: () => [...fake.active],
    getAllTools: () =>
      [...builtins, ...tools.keys()].map((name) => ({
        name,
        description: name,
        exposure: "direct",
      })),
    setActiveTools(names: string[]) {
      setActiveCalls.push([...names]);
      const known = new Set([...builtins, ...tools.keys()]);
      fake.active = names.filter((name) => known.has(name));
    },
    getCommands: () => [],
    getMcpServers: () => [],
    getThinkingLevel: () => "off",
    getSettings: () => ({}),
    setModel: async () => true,
    setThinkingLevel: () => undefined,
  };
  (fake as { pi: ConsolePi }).pi = pi as unknown as ConsolePi;
  return fake;
}

export interface FakeContext extends ConsoleContext {
  readonly notes: [string, string | undefined][];
  aborts: number;
  branch: SessionEntry[];
}

export function fakeContext(cwd = "fake-cwd"): FakeContext {
  const notes: [string, string | undefined][] = [];
  const ctx = {
    notes,
    aborts: 0,
    branch: [] as SessionEntry[],
    cwd,
    hasUI: true,
    mode: "tui",
    model: undefined,
    scopedModels: [],
    modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined },
    ui: {
      notify(message: string, type?: string) {
        notes.push([message, type]);
      },
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      custom: async () => undefined,
      setEditorText: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setWidget: () => undefined,
    },
    sessionManager: {
      getEntries: () => ctx.branch,
      getBranch: () => ctx.branch,
      getSessionId: () => "session-fake-1",
    },
    getContextUsage: () => undefined,
    isIdle: () => true,
    abort() {
      ctx.aborts++;
    },
  };
  return ctx as unknown as FakeContext;
}
