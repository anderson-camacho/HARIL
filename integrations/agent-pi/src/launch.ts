// Launch contract for one Pi process (ADR-0004 decisions 2 to 4): exact argv, a child env built from
// scratch, and tree termination. Nothing here reads process.env except the minimal OS variables.

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";

export interface PiArgvInput {
  readonly piCliPath: string;
  readonly bridgePath: string;
  readonly sessionDir: string;
  readonly model: string;
}

export function buildPiArgv(input: PiArgvInput): string[] {
  return [
    input.piCliPath,
    "--mode",
    "rpc",
    "--no-builtin-tools",
    "--no-extensions",
    "-e",
    input.bridgePath,
    "--no-context-files",
    "--no-approve",
    "--offline",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--session-dir",
    input.sessionDir,
    "--provider",
    "haril",
    "--model",
    input.model,
  ];
}

// Limits the bridge registers for the model when the runtime does not set them (Pi needs a context window and a
// max output for every model it knows).
export const DEFAULT_MODEL_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MODEL_MAX_TOKENS = 4_096;

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
  readonly virtualKey: string;
  readonly osEnv: NodeJS.ProcessEnv;
}

export function buildPiEnv(input: PiEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: input.agentDir,
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    HARIL_RUN_ID: input.runId,
    HARIL_BRIDGE: input.bridge,
    HARIL_TOOLS: input.tools.join(","),
    HARIL_BROKER_URL: input.brokerUrl,
    HARIL_MODEL: input.model,
    HARIL_MODEL_CONTEXT: String(input.modelContextWindow),
    HARIL_MODEL_MAX_TOKENS: String(input.modelMaxTokens),
    HARIL_VKEY: input.virtualKey,
    PATH: dirname(input.nodePath),
  };
  // Windows needs these to start a process; anything else from the parent stays out (ADR-0004 l.58).
  for (const name of ["SystemRoot", "TEMP", "TMP"] as const) {
    const value = input.osEnv[name];
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
