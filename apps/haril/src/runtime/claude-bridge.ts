import { existsSync, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { CLAUDE_BRIDGE_PROVIDER } from "@haril/agent-pi";
import type { HostInfo } from "../context.js";
import type { ModelProblem } from "../providers.js";
import { runtimeRootFor } from "../runtime.js";

// The claude-bridge lane of the real agents: a model ref claude-bridge/<id> runs in Pi on the pi-claude-bridge
// extension's provider, the one the console's /model offers once `haril extensions install npm:pi-claude-bridge --yes`
// put it in HARIL's private Pi directory. The extension runs Claude Code through the Agent SDK on the login Claude Code
// already has; HARIL adds no login of its own. No Broker meters the run: Pi's usage is charged to the budgets after each
// model call (real-agent.ts).

export const CLAUDE_BRIDGE_PREFIX = `${CLAUDE_BRIDGE_PROVIDER}/`;
const PACKAGE = "pi-claude-bridge";
const INSTALL_FIX = `run haril extensions install npm:${PACKAGE} --yes, then pick a claude-bridge model with /model`;
// The bridge's model ids are pi-ai's Anthropic ids (claude-fable-5-1, claude-opus-5-5, claude-haiku-4-5).
const MODEL_ID = /^claude-[a-z0-9][a-z0-9-]{0,63}$/;
// What the run's claude-bridge.json takes from the console's: the plan and context settings that decide which window
// Claude Code serves, and the binary when the user moved it. AskClaude, MCP servers and Claude Code's auto-memory stay
// off whatever the console's file says.
const CARRIED_PROVIDER_KEYS = [
  "plan",
  "longContextExtraUsage",
  "forceTwoHundredK",
  "pathToClaudeCodeExecutable",
] as const;

// Anthropic's notice on tools that use the Agent SDK, which the bridge's README cites.
export const CLAUDE_BRIDGE_BILLING_NOTICE =
  "claude-bridge runs Claude Code through the Agent SDK on your Claude Code login: Anthropic announced and then withdrew a billing change for such tools (https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan); today they use your plan's quota like Claude Code";

export function isClaudeBridgeRef(ref: string | null | undefined): ref is string {
  return ref?.startsWith(CLAUDE_BRIDGE_PREFIX) === true;
}

// The installed extension: its entry file, its version and the claude-bridge.json each run's agent directory gets.
export interface ClaudeBridgeInstall {
  readonly entryPath: string;
  readonly version: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export type ClaudeBridgeLookup =
  | ({ readonly ok: true } & ClaudeBridgeInstall)
  | ({ readonly ok: false } & ModelProblem);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

// Where Pi installs the console's packages: <runtime root>/agent/npm/node_modules (the console's PI_CODING_AGENT_DIR).
export function findClaudeBridge(host: HostInfo): ClaudeBridgeLookup {
  const ops = host.platform === "win32" ? win32 : posix;
  const agentDir = ops.join(runtimeRootFor(host), "agent");
  const dir = ops.join(agentDir, "npm", "node_modules", PACKAGE);
  const manifest = readJson(ops.join(dir, "package.json"));
  if (manifest === undefined) {
    return { ok: false, what: `${PACKAGE} is not installed in HARIL's Pi`, fix: INSTALL_FIX };
  }
  const extensions =
    isRecord(manifest) && isRecord(manifest.pi) ? manifest.pi.extensions : undefined;
  const entry = Array.isArray(extensions) ? extensions[0] : undefined;
  // join, not resolve: the host's platform may name another OS's paths (resolve would prefix the current directory).
  const entryPath = typeof entry === "string" ? ops.join(dir, entry) : undefined;
  if (
    entryPath === undefined ||
    !entryPath.startsWith(`${dir}${ops.sep}`) ||
    !existsSync(entryPath) ||
    !statSync(entryPath).isFile()
  ) {
    return {
      ok: false,
      what: `${PACKAGE} in ${dir} names no extension file`,
      fix: `reinstall it: haril extensions install npm:${PACKAGE} --yes`,
    };
  }
  const version =
    isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : "";
  return {
    ok: true,
    entryPath,
    version,
    config: runConfig(readJson(ops.join(agentDir, "claude-bridge.json"))),
  };
}

// The run's claude-bridge.json. The startup notice is marked as shown: it asks a person to set the plan, and an agent's
// run has no one to read it.
function runConfig(consoleConfig: unknown): Record<string, unknown> {
  const consoleProvider =
    isRecord(consoleConfig) && isRecord(consoleConfig.provider) ? consoleConfig.provider : {};
  const carried = Object.fromEntries(
    CARRIED_PROVIDER_KEYS.filter((key) => consoleProvider[key] !== undefined).map((key) => [
      key,
      consoleProvider[key],
    ]),
  );
  return {
    startupNoticeShown: "haril",
    askClaude: { enabled: false },
    provider: { ...carried, strictMcpConfig: true, autoMemoryEnabled: false },
  };
}

// Why a claude-bridge model cannot run now, or undefined when it can: its id, then the installed extension.
export function claudeBridgeProblem(
  ref: string,
  lookup: ClaudeBridgeLookup,
): ModelProblem | undefined {
  const id = ref.slice(CLAUDE_BRIDGE_PREFIX.length);
  if (!MODEL_ID.test(id)) {
    return {
      what: `${ref} is not a claude-bridge model`,
      fix: "name one the console's /model lists, for example claude-bridge/claude-opus-5-5",
    };
  }
  return lookup.ok ? undefined : { what: lookup.what, fix: lookup.fix };
}
