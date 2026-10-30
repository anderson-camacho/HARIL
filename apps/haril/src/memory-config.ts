import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HostInfo } from "./context.js";
import { harilConfigPath } from "./providers.js";
import { runtimeRootFor } from "./runtime.js";

// The version is pinned: changing it requires qualifying the real HTTP contract.
const ENGRAM_VERSION = "3.6.0";
export interface MemorySettings {
  readonly provider: "null" | "engram";
  readonly binary: string;
  readonly version: string;
}

export function memorySectionErrors(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return ["/memory: must be an object"];
  const section = value as Record<string, unknown>;
  const errors = Object.keys(section)
    .filter((key) => !["provider", "binary", "version"].includes(key))
    .map((key) => `/memory/${key}: unknown key`);
  if (section.provider !== "null" && section.provider !== "engram")
    errors.push("/memory/provider: must be null or engram (string)");
  if (
    section.binary !== undefined &&
    (typeof section.binary !== "string" || !isAbsolute(section.binary))
  )
    errors.push("/memory/binary: must be an absolute executable path");
  if (section.version !== undefined && section.version !== ENGRAM_VERSION)
    errors.push(`/memory/version: supported version is ${ENGRAM_VERSION}`);
  return errors;
}

export function loadMemorySettings(host: HostInfo): MemorySettings {
  const { path, explicit } = harilConfigPath(host);
  if (explicit && !existsSync(path)) throw new Error(`${path}: HARIL_CONFIG does not exist`);
  const document = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error(`${path}: must be a JSON object`);
  const section = document.memory;
  if (section !== undefined) {
    const errors = memorySectionErrors(section);
    if (errors.length > 0) throw new Error(`${path}: ${errors.join("; ")}`);
  }
  return {
    provider: section?.provider ?? "null",
    binary:
      section?.binary ??
      join(
        runtimeRootFor(host),
        "vendor",
        "engram",
        ENGRAM_VERSION,
        host.platform === "win32" ? "engram.exe" : "engram",
      ),
    version: section?.version ?? ENGRAM_VERSION,
  };
}
