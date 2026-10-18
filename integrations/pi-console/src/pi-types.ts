// The part of Pi 1.2.0's extension API the console uses, declared locally so the bundle stays self-contained (it
// imports only node:* builtins, like the bridge). The shapes follow vendor/pi/1.2.0: dist/core/extensions/types.d.ts
// (ExtensionAPI, ExtensionContext, ExtensionUIContext, ProviderConfig), dist/core/footer-data-provider.d.ts and
// pi-tui's Component. Only the members read here are declared; Pi passes richer objects.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// Pi's level -> the value sent as reasoning_effort (pi-ai ThinkingLevelMap); null marks a level the model does not
// support, and xhigh or max are offered only when mapped (pi-ai models.js getSupportedThinkingLevels).
export type ThinkingLevelMap = Readonly<Partial<Record<ThinkingLevel, string | null>>>;

// Theme tokens the console colors with (docs/themes.md); warning is the yellow of HARIL's bar.
export type ThemeColor = "accent" | "text" | "muted" | "dim" | "success" | "error" | "warning";

export interface ConsoleTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

export interface ConsoleMouseEvent {
  readonly type: "press" | "release" | "move" | "drag" | "click" | "wheel";
  readonly button: "left" | "middle" | "right" | "none";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly wheelDelta?: number;
}

interface ConsoleComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(
    event: ConsoleMouseEvent,
  ): { handled?: boolean; render?: boolean; focus?: boolean } | undefined;
  invalidate(): void;
  dispose?(): void;
}

export interface ConsoleTui {
  readonly terminal: { readonly columns: number; readonly rows: number };
  requestRender(force?: boolean): void;
}

interface FooterData {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
}

export interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

interface ContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

export interface AgentMessage {
  readonly role?: string;
  readonly usage?: { readonly cost?: { readonly total?: number } };
}

export interface SessionEntry {
  readonly type: string;
  readonly message?: AgentMessage;
}

interface ConsoleUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  custom<T>(
    factory: (
      tui: ConsoleTui,
      theme: ConsoleTheme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => ConsoleComponent,
    options?: {
      overlay?: boolean;
      overlayOptions?: { width?: number | string; maxHeight?: number | string };
    },
  ): Promise<T>;
  setEditorText(text: string): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setFooter(
    factory:
      | ((tui: ConsoleTui, theme: ConsoleTheme, footerData: FooterData) => ConsoleComponent)
      | undefined,
  ): void;
  setHeader(
    factory: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined,
  ): void;
  setWidget(
    key: string,
    content: ((tui: ConsoleTui, theme: ConsoleTheme) => ConsoleComponent) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

interface ConsoleToolInfo {
  readonly name: string;
  readonly description: string;
  readonly exposure: string;
}

interface ConsoleCommandInfo {
  readonly name: string;
}

interface ConsoleMcpServer {
  readonly name: string;
}

interface ModelRegistry {
  getAll(): readonly PiModel[];
  // The models whose provider has working credentials.
  getAvailable(): readonly PiModel[];
  find(provider: string, modelId: string): PiModel | undefined;
}

export interface ConsoleContext {
  readonly ui: ConsoleUi;
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly model: PiModel | undefined;
  readonly modelRegistry: ModelRegistry;
  // Models scoped with --models or enabledModels; empty when every model is usable.
  readonly scopedModels: readonly unknown[];
  readonly sessionManager: { getEntries(): readonly SessionEntry[] };
  getContextUsage(): ContextUsage | undefined;
}

export interface AutocompleteItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface CommandOptions {
  readonly description: string;
  readonly getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
  handler(args: string, ctx: ConsoleContext): Promise<void>;
}

interface SessionStartEvent {
  readonly reason: "startup" | "reload" | "new" | "resume" | "fork";
}

interface ModelSelectEvent {
  readonly model: PiModel;
}

interface ThinkingLevelSelectEvent {
  readonly level: ThinkingLevel;
  readonly previousLevel: ThinkingLevel;
}

interface MessageEndEvent {
  readonly message: AgentMessage;
}

export interface ProviderModelConfig {
  readonly id: string;
  readonly name: string;
  readonly input: ("text" | "image")[];
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// The legacy registration form (ProviderConfig): a static endpoint and its models.
export interface ProviderConfig {
  readonly name: string;
  readonly baseUrl: string;
  // A literal, or $NAME / ${NAME}: Pi reads that environment variable itself when it sends a request.
  readonly apiKey: string;
  readonly api: "openai-completions";
  readonly models: ProviderModelConfig[];
}

interface ConsoleSettings {
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly defaultThinkingLevel?: ThinkingLevel;
  // Pi's per-model level ("<provider>/<model id>" -> level), applied by Pi when it switches to that model. Pi 1.2.0
  // writes it only from /settings; the extension API can read it (getSettings returns a copy) but not write it.
  readonly modelThinkingLevels?: Readonly<Record<string, ThinkingLevel>>;
}

type Handler<E> = (event: E, ctx: ConsoleContext) => void | Promise<void>;

export interface ConsolePi {
  on(event: "session_start", handler: Handler<SessionStartEvent>): () => void;
  on(event: "session_shutdown", handler: Handler<unknown>): () => void;
  on(event: "model_select", handler: Handler<ModelSelectEvent>): () => void;
  on(event: "thinking_level_select", handler: Handler<ThinkingLevelSelectEvent>): () => void;
  on(event: "message_end", handler: Handler<MessageEndEvent>): () => void;
  on(event: "turn_end", handler: Handler<unknown>): () => void;
  on(event: "agent_end", handler: Handler<unknown>): () => void;
  on(event: "input", handler: Handler<unknown>): () => void;
  registerCommand(name: string, options: CommandOptions): void;
  registerProvider(name: string, config: ProviderConfig): void;
  getThinkingLevel(): ThinkingLevel;
  getSettings(): ConsoleSettings;
  getActiveTools(): string[];
  getAllTools(): ConsoleToolInfo[];
  getCommands(): ConsoleCommandInfo[];
  getMcpServers(): ConsoleMcpServer[];
  setActiveTools(toolNames: string[]): void;
  registerShortcut(
    shortcut: string,
    options: { description?: string; handler(ctx: ConsoleContext): void },
  ): void;
  // Sets the session's model without changing the configured default; false without auth for its provider.
  setModel(model: PiModel): Promise<boolean>;
  // Sets the session's thinking level, clamped by Pi to the model's levels, without changing the configured default.
  setThinkingLevel(level: ThinkingLevel): void;
}
