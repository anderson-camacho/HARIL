// Launch contract for one Pi process (ADR-0004 decisions 2 to 4): exact argv, a child env built from
// scratch, and tree termination. Nothing here reads process.env except the minimal OS variables.

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";

// The Pi provider of the pi-claude-bridge extension: Claude Code through the Agent SDK, on the login Claude Code already
// has. A run on it (the claude-bridge lane) loads the extension next to HARIL's bridge and talks to no Broker.
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";

export interface PiArgvInput {
  readonly piCliPath: string;
  readonly bridgePath: string;
  readonly sessionDir: string;
  readonly model: string;
  // The reasoning level of the agent's layer (docs/modos-y-delegacion.md 7.10 item 6), passed as --thinking. Absent: no
  // flag, and the gateway's default level applies.
  readonly thinking?: string;
  // The claude-bridge lane: the pi-claude-bridge extension's entry file, loaded after HARIL's bridge, whose provider
  // serves the model instead of the Broker's haril provider. HARIL's bridge still serves every tool.
  readonly claudeBridgePath?: string;
}

export function buildPiArgv(input: PiArgvInput): string[] {
  const thinking = input.thinking === undefined ? [] : ["--thinking", input.thinking];
  const claudeBridge = input.claudeBridgePath === undefined ? [] : ["-e", input.claudeBridgePath];
  return [
    input.piCliPath,
    "--mode",
    "rpc",
    "--no-builtin-tools",
    "--no-extensions",
    "-e",
    input.bridgePath,
    ...claudeBridge,
    "--no-context-files",
    "--no-approve",
    "--offline",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--session-dir",
    input.sessionDir,
    "--provider",
    input.claudeBridgePath === undefined ? "haril" : CLAUDE_BRIDGE_PROVIDER,
    "--model",
    input.model,
    ...thinking,
  ];
}

// The documented fallback (ADR-0021 S3): the limits the bridge registers when the runtime knows nothing of the model,
// because the live catalog does not list it or has not answered yet. Pi needs a context window and a max output for
// every model it knows. When the catalog knows the model, its real window and output are passed instead.
export const DEFAULT_MODEL_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MODEL_MAX_TOKENS = 4_096;

// Pi's own compaction reserve (settings-defaults.js, compaction.reserveTokens).
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

// The compaction point of a layer (docs/modos-y-delegacion.md 3.12): Pi compacts when contextTokens > contextWindow -
// reserveTokens, so to compact at `compactAt` on a model of window W the reserve is W - compactAt. It never goes below
// Pi's own reserve: when the window is at most the threshold, the window decides and Pi compacts near its limit.
export function compactionReserveTokens(contextWindow: number, compactAt: number): number {
  return Math.max(PI_DEFAULT_RESERVE_TOKENS, contextWindow - compactAt);
}

// Pi's levels, in its order (pi-ai models.js EXTENDED_THINKING_LEVELS).
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// The levels Pi offers for a model whose gateway publishes `gatewayLevels` (none, auto, minimal... max), as the bridge
// registers them: "off" only when the gateway publishes "none" (what off then sends), xhigh and max only when published,
// and nothing when no reasoning level is published (the model is registered as not reasoning).
function offeredLevels(gatewayLevels: readonly string[]): string[] {
  const published = new Set(gatewayLevels);
  if (!PI_THINKING_LEVELS.slice(1).some((level) => published.has(level))) return [];
  return PI_THINKING_LEVELS.filter((level) =>
    level === "off" ? published.has("none") : published.has(level),
  );
}

// The level Pi runs at when asked for `requested` (pi-ai clampThinkingLevel): the level itself when offered, else the
// next offered one above it, else the nearest below. Undefined when the model publishes no reasoning level: Pi then
// registers it as not reasoning and sends no level.
export function thinkingLevelFor(
  gatewayLevels: readonly string[],
  requested: string,
): string | undefined {
  const offered = offeredLevels(gatewayLevels);
  if (offered.length === 0) return undefined;
  if (offered.includes(requested)) return requested;
  const index = PI_THINKING_LEVELS.indexOf(requested);
  if (index === -1) return offered[0];
  const above = PI_THINKING_LEVELS.slice(index).find((level) => offered.includes(level));
  if (above !== undefined) return above;
  return [...PI_THINKING_LEVELS.slice(0, index)].reverse().find((level) => offered.includes(level));
}

export interface PiEnvInput {
  readonly nodePath: string;
  readonly agentDir: string;
  readonly runId: string;
  readonly bridge: string;
  readonly tools: readonly string[];
  readonly brokerUrl: string;
  readonly model: string;
  readonly modelContextWindow: number;
  readonly modelMaxTokens: number;
  // The reasoning levels the gateway publishes for the model, when the run asks for a level: the bridge registers the
  // model as reasoning with them (HARIL_MODEL_LEVELS), so Pi sends the level as reasoning_effort (P27).
  readonly modelLevels?: readonly string[];
  readonly virtualKey: string;
  readonly osEnv: NodeJS.ProcessEnv;
}

export function buildPiEnv(input: PiEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    ...baseEnv(input),
    HARIL_BROKER_URL: input.brokerUrl,
    HARIL_MODEL: input.model,
    HARIL_MODEL_CONTEXT: String(input.modelContextWindow),
    HARIL_MODEL_MAX_TOKENS: String(input.modelMaxTokens),
    HARIL_VKEY: input.virtualKey,
  };
  if (input.modelLevels !== undefined && input.modelLevels.length > 0) {
    env.HARIL_MODEL_LEVELS = input.modelLevels.join(",");
  }
  return withOsEnv(env, input.osEnv, ["SystemRoot", "TEMP", "TMP"]);
}

export interface ClaudeBridgeEnvInput {
  readonly nodePath: string;
  readonly agentDir: string;
  readonly runId: string;
  readonly bridge: string;
  readonly tools: readonly string[];
  readonly osEnv: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

// The child env of the claude-bridge lane: no Broker URL, virtual key or model limits (the extension registers its own
// models), HARIL_LANE so HARIL's bridge registers no haril provider, and the home variables Claude Code needs to find its
// login (USERPROFILE or HOME, and CLAUDE_CONFIG_DIR when the user moved it). An exported ANTHROPIC_* variable would
// redirect Claude Code away from that login (pi-claude-bridge issue #107), so none is passed.
// UNVERIFIED on macOS: Claude Code reads its login from the keychain there; /usr/bin is on PATH for the security tool.
export function buildClaudeBridgeEnv(input: ClaudeBridgeEnvInput): Record<string, string> {
  const env: Record<string, string> = { ...baseEnv(input), HARIL_LANE: CLAUDE_BRIDGE_PROVIDER };
  if ((input.platform ?? process.platform) === "darwin") env.PATH = `${env.PATH}:/usr/bin`;
  return withOsEnv(env, input.osEnv, [
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "CLAUDE_CONFIG_DIR",
  ]);
}

function baseEnv(
  input: Pick<PiEnvInput, "nodePath" | "agentDir" | "runId" | "bridge" | "tools">,
): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: input.agentDir,
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    HARIL_RUN_ID: input.runId,
    HARIL_BRIDGE: input.bridge,
    HARIL_TOOLS: input.tools.join(","),
    PATH: dirname(input.nodePath),
  };
}

// Windows needs SystemRoot, TEMP and TMP to start a process; anything the list does not name stays out (ADR-0004 l.58).
function withOsEnv(
  env: Record<string, string>,
  osEnv: NodeJS.ProcessEnv,
  names: readonly string[],
): Record<string, string> {
  for (const name of names) {
    const value = osEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildProcess;

interface SpawnOptionsLike {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly detached: boolean;
}

export const defaultSpawn: SpawnFn = (command, args, options) => spawn(command, [...args], options);

type KillerSpawnFn = (command: string, args: readonly string[]) => ChildProcess;

const defaultKillerSpawn: KillerSpawnFn = (command, args) =>
  spawn(command, [...args], { shell: false, windowsHide: true, stdio: "ignore" });

// The fallback tree kill (3.14): the runtime kills through the host's verified tree kill (PiAgentRuntimeOptions.killTree),
// and this runs only without one or when the host cannot read the process table. taskkill /T walks the tree by parent pid
// alone, so a process whose dead parent's pid was reused could be taken along; the verified kill checks start times.
// Windows: taskkill /T takes the whole tree by walking it from the child, so the child is killed only after taskkill
// exits, or when taskkill cannot start. A child killed first leaves taskkill no tree to walk, and a process that a
// shell under the child started has left the job object that would take it down with the child. POSIX: the child
// leads its own process group (detached).
export function killProcessTree(
  child: ChildProcess,
  osEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  spawnKiller: KillerSpawnFn = defaultKillerSpawn,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    const killChild = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const systemRoot = osEnv.SystemRoot ?? osEnv.windir ?? "C:\\Windows";
    let killer: ChildProcess;
    try {
      killer = spawnKiller(join(systemRoot, "System32", "taskkill.exe"), [
        "/F",
        "/T",
        "/PID",
        String(pid),
      ]);
    } catch {
      killChild();
      return;
    }
    killer.on("error", killChild);
    killer.once("exit", killChild);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
