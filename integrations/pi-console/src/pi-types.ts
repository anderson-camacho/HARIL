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

export interface ConsoleComponent {
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

// pi-ai's Usage: token counts are numbers (0 when a provider reports none); reasoning is a subset of output.
interface MessageUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly totalTokens?: number;
  readonly cost?: { readonly total?: number };
}

interface MessageContent {
  readonly type: string;
  readonly text?: string;
  // A tool call in an assistant message (type "toolCall").
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
}

// pi-ai's AssistantMessage, and the role of the other messages; only the members read here.
export interface AgentMessage {
  readonly role?: string;
  readonly content?: string | readonly MessageContent[];
  readonly provider?: string;
  readonly model?: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly usage?: MessageUsage;
  readonly stopReason?: string;
  // When the request started (epoch milliseconds) and how long it took.
  readonly timestamp?: number;
  readonly durationMs?: number;
  // A tool result message (role "toolResult").
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

export interface SessionEntry {
  readonly type: string;
  readonly message?: AgentMessage;
  // A custom entry (pi.appendEntry): its type and data.
  readonly customType?: string;
  readonly data?: unknown;
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

interface ConsoleSourceInfo {
  readonly path?: string;
  readonly source?: string;
}

interface ConsoleToolInfo {
  readonly name: string;
  readonly description: string;
  readonly exposure: string;
  readonly sourceInfo?: ConsoleSourceInfo;
}

// source: "extension", "prompt" or "skill". Pi's own commands are not reported here.
interface ConsoleCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly sourceInfo?: ConsoleSourceInfo;
}

interface ConsoleMcpServer {
  readonly name: string;
  readonly config?: unknown;
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
  readonly sessionManager: {
    getEntries(): readonly SessionEntry[];
    // The entries of the active branch, root to leaf.
    getBranch(): readonly SessionEntry[];
    getSessionId(): string;
  };
  getContextUsage(): ContextUsage | undefined;
  // Offered to command handlers; the loaded context files are in it. Only the paths are read.
  getSystemPromptOptions?(): {
    readonly contextFiles?: readonly { readonly path: string }[];
    readonly skills?: readonly {
      readonly name: string;
      readonly description?: string;
      readonly filePath?: string;
      readonly disableModelInvocation?: boolean;
    }[];
  };
  // Whether the agent is idle (not streaming).
  isIdle(): boolean;
  // Aborts the current agent operation (the chat turn); nothing happens while idle.
  abort(): void;
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

interface AgentEndEvent {
  readonly messages?: readonly AgentMessage[];
}

// Fired before a run starts; the result may replace the whole system prompt for that run only.
interface BeforeAgentStartEvent {
  readonly systemPrompt: string;
  readonly messageType: "user" | "custom";
  readonly prompt?: string;
  // Pi 1.2.0's mutable prompt sections for this run, each sent as a <name> block. Extension providers that rebuild the
  // prompt themselves (claude-bridge) forward these and drop a returned systemPrompt.
  readonly systemPromptOptions?: { sections: Record<string, string> };
}

interface BeforeAgentStartResult {
  readonly systemPrompt?: string;
}

// The user's input, before Pi processes it. Extension commands (/goal, /mode…) never reach it: Pi runs them first.
interface InputEvent {
  readonly text: string;
  readonly source: "interactive" | "rpc" | "extension";
  readonly streamingBehavior?: "steer" | "followUp";
}

type InputResult =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly text: string }
  | { readonly action: "handled" };

// Fired before a tool runs, whoever registered it (built-in, another extension, MCP); `input` is the call's arguments.
// A handler that throws blocks the call (Pi's fail-safe).
interface ToolCallEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface ToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

interface ToolResultEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly content: readonly MessageContent[];
  readonly isError: boolean;
}

// A `!` or `!!` shell command the user typed.
interface UserBashEvent {
  readonly command: string;
}

interface UserBashResult {
  readonly result: {
    readonly output: string;
    readonly exitCode: number | undefined;
    readonly cancelled: boolean;
    readonly truncated: boolean;
  };
}

interface ConsoleToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: unknown;
}

// ToolDefinition for registerTool(); the parameters are a plain JSON Schema object, as the bridge registers them.
// execute() throws to produce a failed tool result.
export interface ConsoleToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: string[];
  readonly parameters: Record<string, unknown>;
  // false: registering the tool does not activate it; setActiveTools does.
  readonly defaultActive?: boolean;
  readonly executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ConsoleContext,
  ): Promise<ConsoleToolResult>;
}

// A renderer for a custom entry (pi.appendEntry): drawn in the chat, never sent to the model.
export type EntryRenderer = (
  entry: { readonly customType: string; readonly data?: unknown },
  options: { readonly expanded: boolean },
  theme: ConsoleTheme,
) => ConsoleComponent | undefined;

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
// A handler whose result changes what Pi does (blocks a tool call, replaces the system prompt…); undefined changes nothing.
type ResultHandler<E, R> = (
  event: E,
  ctx: ConsoleContext,
) => R | undefined | Promise<R | undefined>;

export interface ConsolePi {
  on(event: "session_start", handler: Handler<SessionStartEvent>): () => void;
  on(event: "session_shutdown", handler: Handler<unknown>): () => void;
  on(event: "model_select", handler: Handler<ModelSelectEvent>): () => void;
  on(event: "thinking_level_select", handler: Handler<ThinkingLevelSelectEvent>): () => void;
  on(event: "message_end", handler: Handler<MessageEndEvent>): () => void;
  on(event: "turn_end", handler: Handler<unknown>): () => void;
  on(event: "agent_end", handler: Handler<AgentEndEvent>): () => void;
  on(event: "input", handler: ResultHandler<InputEvent, InputResult>): () => void;
  on(
    event: "before_agent_start",
    handler: ResultHandler<BeforeAgentStartEvent, BeforeAgentStartResult>,
  ): () => void;
  on(event: "tool_call", handler: ResultHandler<ToolCallEvent, ToolCallResult>): () => void;
  on(event: "tool_result", handler: Handler<ToolResultEvent>): () => void;
  on(event: "user_bash", handler: ResultHandler<UserBashEvent, UserBashResult>): () => void;
  registerCommand(name: string, options: CommandOptions): void;
  registerTool(tool: ConsoleToolDefinition): void;
  registerEntryRenderer(customType: string, renderer: EntryRenderer): void;
  // Appends a custom entry to the session for state persistence (never sent to the model).
  appendEntry(customType: string, data?: unknown): void;
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
