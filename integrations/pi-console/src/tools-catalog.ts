import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { plainText } from "./text.js";

// What the TOOLS tab can truthfully say about skills and MCP servers. The skills are the ones Pi reports. The servers
// come from the same mcp.json files Pi reads and from what extensions registered.
//
// Pi 1.2.0 gives an extension no connection state: its MCP extension keeps that to itself and shows it only in /mcp.
// The one fact visible from here is getAllTools(): a server's tools are registered once it connects, and registered as
// "hidden" when it is turned off. So "connected" means "connected at some point in this session and not turned off"; a
// later drop, a failure, or a server still starting cannot be told apart, and all of them read as "not checked".
//
// Nothing that could hold a secret leaves this module: no env or header value, no argument, no URL query or user, and
// no text of a damaged file (JSON.parse quotes the source in its message, so it is never shown either).

const MAX_FILE_BYTES = 1_000_000;
const MAX_TEXT = 600;

export type McpState = "connected" | "disabled" | "not_checked" | "invalid";
type McpScope = "global" | "project" | "extension";

export interface SkillEntry {
  readonly name: string;
  readonly description: string | undefined;
  readonly path: string | undefined;
  readonly source: string | undefined;
  // false: the skill runs only through its command (disable-model-invocation).
  readonly modelInvocable: boolean;
}

export interface McpEntry {
  readonly name: string;
  readonly state: McpState;
  readonly scope: McpScope;
  // The file that defines it; undefined for a server an extension registered.
  readonly file: string | undefined;
  readonly transport: "stdio" | "http" | undefined;
  // The executable, or the URL's scheme, host and path.
  readonly target: string | undefined;
  readonly argCount: number;
  readonly envCount: number;
  readonly headerCount: number;
  readonly exposure: string | undefined;
  readonly description: string | undefined;
  readonly tools: readonly string[];
  // HARIL's `tools ensure` rewrites this entry, so a saved "enabled" would not last.
  readonly managed: boolean;
}

export interface CatalogWarning {
  readonly file: string;
  readonly kind: "damaged" | "misshapen" | "too_large" | "unreadable";
}

export interface Catalog {
  readonly skills: readonly SkillEntry[];
  readonly servers: readonly McpEntry[];
  readonly warnings: readonly CatalogWarning[];
  // Pi has the /mcp command (built-in MCP not turned off).
  readonly mcpCommand: boolean;
  readonly globalFile: string;
  readonly projectFile: string;
  readonly agentDir: string;
}

export interface CatalogSources {
  readonly commands: readonly {
    readonly name: string;
    readonly description?: string;
    readonly source?: string;
    readonly sourceInfo?: { readonly path?: string; readonly source?: string };
  }[];
  readonly tools: readonly { readonly name: string; readonly exposure?: string }[];
  readonly registered: readonly { readonly name: string; readonly config?: unknown }[];
  // BuildSystemPromptOptions.skills, offered by Pi to command contexts; undefined where it is not.
  readonly promptSkills:
    | readonly {
        readonly name: string;
        readonly description?: string;
        readonly filePath?: string;
        readonly disableModelInvocation?: boolean;
      }[]
    | undefined;
  readonly agentDir: string | undefined;
  readonly cwd: string;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function textOf(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = plainText(value).trim();
  return clean === "" ? undefined : clean.slice(0, max);
}

const countOf = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  return isObject(value) ? Object.keys(value).length : 0;
};

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// The URL without what can carry a credential: its user, its password, its query and its fragment.
function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return textOf(`${url.protocol}//${url.host}${url.pathname}`);
  } catch {
    return undefined;
  }
}

// The executable of a command, without what a command written as one line may carry after it.
function safeCommand(value: string): string | undefined {
  return textOf(value.split(/\s+-/u)[0]);
}

interface ReadFile {
  readonly servers: Json | undefined;
  readonly warning: CatalogWarning["kind"] | undefined;
}

function readServers(file: string): ReadFile {
  let text: string;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return { servers: undefined, warning: "too_large" };
    text = readFileSync(file, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { servers: undefined, warning: missing ? undefined : "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return { servers: undefined, warning: "damaged" };
  }
  if (!isObject(parsed)) return { servers: undefined, warning: "misshapen" };
  if (parsed.mcpServers === undefined) return { servers: {}, warning: undefined };
  if (!isObject(parsed.mcpServers)) return { servers: undefined, warning: "misshapen" };
  return { servers: parsed.mcpServers, warning: undefined };
}

// The tools Pi has registered and not hidden for a server, by the names they were offered with.
function toolsOf(name: string, tools: CatalogSources["tools"]): string[] {
  const prefix = `mcp__${name.replaceAll("-", "_")}__`;
  return tools
    .filter((tool) => tool.name.startsWith(prefix) && tool.exposure !== "hidden")
    .map((tool) => plainText(tool.name.slice(prefix.length)))
    .sort();
}

function entryOf(
  name: string,
  raw: unknown,
  scope: McpScope,
  file: string | undefined,
  tools: CatalogSources["tools"],
): McpEntry {
  const config = isObject(raw) ? raw : {};
  const command = typeof config.command === "string" ? config.command : undefined;
  const url = typeof config.url === "string" ? config.url : undefined;
  const found = toolsOf(name, tools);
  const state: McpState =
    command === undefined && url === undefined
      ? "invalid"
      : config.enabled === false
        ? "disabled"
        : found.length > 0
          ? "connected"
          : "not_checked";
  return {
    name: plainText(name),
    state,
    scope,
    file,
    transport: url !== undefined ? "http" : command !== undefined ? "stdio" : undefined,
    target:
      url !== undefined ? safeUrl(url) : command !== undefined ? safeCommand(command) : undefined,
    argCount: countOf(config.args),
    envCount: countOf(config.env),
    headerCount: countOf(config.headers),
    exposure: textOf(config.exposure, 40),
    description: textOf(config.description),
    tools: found,
    managed: scope === "global" && name === "engram",
  };
}

function skillsOf(sources: CatalogSources): SkillEntry[] {
  const skills = new Map<string, SkillEntry>();
  for (const skill of sources.promptSkills ?? []) {
    const name = textOf(skill.name, 120);
    if (name === undefined) continue;
    skills.set(name, {
      name,
      description: textOf(skill.description),
      path: textOf(skill.filePath),
      source: undefined,
      modelInvocable: skill.disableModelInvocation !== true,
    });
  }
  for (const command of sources.commands) {
    if (command.source !== "skill") continue;
    const name = textOf(command.name.replace(/^skill:/u, ""), 120);
    if (name === undefined) continue;
    const known = skills.get(name);
    skills.set(name, {
      name,
      description: known?.description ?? textOf(command.description),
      path: known?.path ?? textOf(command.sourceInfo?.path),
      source: textOf(command.sourceInfo?.source, 80),
      modelInvocable: known?.modelInvocable ?? true,
    });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function buildCatalog(sources: CatalogSources): Catalog {
  const agentDir =
    sources.agentDir === undefined || sources.agentDir === ""
      ? join(homedir(), ".pi", "agent")
      : sources.agentDir;
  const globalFile = join(agentDir, "mcp.json");
  const projectFile = join(sources.cwd, ".pi", "mcp.json");
  const warnings: CatalogWarning[] = [];
  const servers = new Map<string, McpEntry>();
  for (const [file, scope] of [
    [globalFile, "global"],
    [projectFile, "project"],
  ] as const) {
    const read = readServers(file);
    if (read.warning !== undefined) warnings.push({ file, kind: read.warning });
    for (const [name, raw] of Object.entries(read.servers ?? {})) {
      // A project entry with neither command nor url only overrides settings of the global one, as in Pi.
      const overrides = isObject(raw) && raw.command === undefined && raw.url === undefined;
      if (scope === "project" && overrides && servers.has(name)) continue;
      servers.set(name, entryOf(name, raw, scope, file, sources.tools));
    }
  }
  for (const { name, config } of sources.registered) {
    if (servers.has(name)) continue;
    servers.set(name, entryOf(name, config, "extension", undefined, sources.tools));
  }
  return {
    skills: skillsOf(sources),
    servers: [...servers.values()],
    warnings,
    mcpCommand: sources.commands.some((command) => command.name === "mcp"),
    globalFile,
    projectFile,
    agentDir,
  };
}

export type SetEnabledResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" | "damaged" | "no_entry" | "write" };

const indentOf = (text: string): string | number => /^\{\r?\n([ \t]+)"/u.exec(text)?.[1] ?? 2;

// Sets a server's `enabled` in an mcp.json the way /mcp saves it: `true` is Pi's default and removes the key. The file
// is read again here, every other key survives, and it is replaced through a temporary file beside it, so a failure
// leaves the old one. A file that cannot be parsed is never touched.
export function setMcpEnabled(file: string, name: string, enabled: boolean): SetEnabledResult {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch {
    return { ok: false, reason: "damaged" };
  }
  if (!isObject(parsed) || !isObject(parsed.mcpServers)) {
    return { ok: false, reason: isObject(parsed) ? "no_entry" : "damaged" };
  }
  const entry = Object.hasOwn(parsed.mcpServers, name) ? parsed.mcpServers[name] : undefined;
  if (!isObject(entry)) return { ok: false, reason: "no_entry" };
  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed, null, indentOf(text))}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, file);
    return { ok: true };
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The write already failed; what is left is a temporary file.
    }
    return { ok: false, reason: "write" };
  }
}
