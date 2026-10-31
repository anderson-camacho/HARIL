import { dirname } from "node:path";
import { compareVersions, versionParts } from "../version-compare.js";
import type { EnsureFs } from "./fs.js";
import { errorText } from "./fs.js";
import { firstFolderBelow, isInside, pathOps } from "./paths.js";

// What installing Engram changes outside its own folder: the `memory` section of haril.json and the Pi MCP entry in
// <runtime root>/agent/mcp.json. Both are read whole, changed in memory and written back through a temporary file, so
// every other key survives and a file that cannot be parsed is left exactly as it is.

type Document = Record<string, unknown>;

const isRecord = (value: unknown): value is Document =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface MemoryContext {
  // <runtime root>/vendor/engram: the folder HARIL manages.
  readonly vendorRoot: string;
  readonly pin: string;
  readonly pinBinary: string;
  readonly platform: string;
}

export type MemoryPlan =
  | { readonly kind: "keep" }
  // memory.binary is the user's own Engram, outside HARIL's folder: not HARIL's to install or change.
  | { readonly kind: "override"; readonly binary: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "write"; readonly document: Document }
  | { readonly kind: "update"; readonly document: Document; readonly from: string };

function olderThan(version: string | undefined, pin: string): version is string {
  return (
    version !== undefined && versionParts(version) !== null && compareVersions(version, pin) < 0
  );
}

// What to do with the memory section of haril.json. With no section a verified install adds one (the user opted out of
// nothing); a section that exists is the user's, except for the values HARIL itself wrote for an older managed version.
export function planMemory(
  document: Document,
  ctx: MemoryContext,
  afterInstall: boolean,
): MemoryPlan {
  const section = document.memory;
  if (section === undefined) {
    if (!afterInstall) return { kind: "keep" };
    const memory = { provider: "engram", binary: ctx.pinBinary, version: ctx.pin };
    return { kind: "write", document: { ...document, memory } };
  }
  if (!isRecord(section)) return { kind: "invalid", reason: "memory is not an object" };

  const binary = typeof section.binary === "string" ? section.binary : undefined;
  const version = typeof section.version === "string" ? section.version : undefined;
  let binaryVersion: string | undefined;
  if (binary !== undefined) {
    if (!isInside(binary, ctx.vendorRoot, ctx.platform)) return { kind: "override", binary };
    const folder = firstFolderBelow(binary, ctx.vendorRoot, ctx.platform);
    binaryVersion = folder !== undefined && versionParts(folder) !== null ? folder : undefined;
  }
  const from = [binaryVersion, version].find((candidate) => olderThan(candidate, ctx.pin));
  if (from === undefined) return { kind: "keep" };
  const memory = { ...section, binary: ctx.pinBinary, version: ctx.pin };
  return { kind: "update", document: { ...document, memory }, from };
}

export type JsonRead =
  | { readonly ok: true; readonly value: Document; readonly existed: boolean }
  | { readonly ok: false; readonly reason: string };

export function readJsonObject(path: string, fs: EnsureFs): JsonRead {
  if (!fs.exists(path)) return { ok: true, value: {}, existed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readText(path));
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "it is not a JSON object" };
  return { ok: true, value: parsed, existed: true };
}

// Writes through a temporary file beside the target that is renamed over it, so a reader never sees half a file and a
// failure leaves the old one. Owner-only where the platform has modes.
export function writeJsonAtomic(path: string, value: unknown, fs: EnsureFs, id: string): void {
  fs.mkdir(dirname(path));
  const temporary = `${path}.${id}.tmp`;
  try {
    fs.writeNew(temporary, `${JSON.stringify(value, null, 2)}\n`, 0o600);
    fs.rename(temporary, path);
  } catch (error) {
    try {
      fs.remove(temporary);
    } catch {
      // The write already failed; the leftover is a temporary file.
    }
    throw error;
  }
}

// The Pi MCP server entry `npm run memory:install` writes: Engram's agent tools over stdio, on HARIL's own data.
export function engramMcpServer(binary: string, dataDir: string, platform: string): Document {
  return {
    command: binary,
    args: ["mcp", "--tools=agent"],
    env: {
      ENGRAM_DATA_DIR: pathOps(platform).join(dataDir, "memory", "engram"),
      ENGRAM_PROJECT: "haril",
      ENGRAM_STARTUP_POLICY: "deny",
      ENGRAM_NO_UPDATE_CHECK: "1",
    },
    exposure: "direct",
    description:
      "Local HARIL project memory: decisions, discoveries, preferences and session handoffs. Never store secrets.",
  };
}

export type McpPlan =
  | { readonly changed: false }
  | { readonly changed: true; readonly document: Document };

// register adds the entry; refresh only replaces one that is already there.
export function planMcp(
  document: Document,
  server: Document,
  mode: "register" | "refresh",
): McpPlan {
  const servers = isRecord(document.mcpServers) ? document.mcpServers : {};
  const current = servers.engram;
  if (mode === "refresh" && current === undefined) return { changed: false };
  if (JSON.stringify(current) === JSON.stringify(server)) return { changed: false };
  return {
    changed: true,
    document: { ...document, mcpServers: { ...servers, engram: server } },
  };
}
