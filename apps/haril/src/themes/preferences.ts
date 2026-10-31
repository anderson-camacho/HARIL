import { readFileSync } from "node:fs";
import type { HostInfo } from "../context.js";
import { harilConfigPath } from "../providers.js";
import { pathOps } from "../tools/paths.js";
import { findThemeProfile } from "./catalog.js";

// The terminal preferences live in their own file beside haril.json, not in a section of it: older HARIL versions
// refuse haril.json with an unknown top-level key, so a rollback would lose every provider, and a bad value here
// cannot affect anything else. The config folder is outside the versioned app folder, so it survives updates. Reading
// never throws and never writes: a bad value falls back to its default with a warning until an explicit apply.

export const PROMPT_ENGINES = ["oh-my-posh", "starship"] as const;
export const INTENSITIES = ["low", "medium", "high"] as const;
export const STARTUP_BEHAVIOURS = ["banner", "minimal", "none"] as const;

export interface TerminalPreferences {
  readonly activeProfile: string | null;
  // One value, so two prompt engines can never both be active.
  readonly promptEngine: (typeof PROMPT_ENGINES)[number];
  readonly animations: boolean;
  readonly intensity: (typeof INTENSITIES)[number];
  readonly shaders: boolean;
  readonly reducedMotion: boolean;
  readonly startup: (typeof STARTUP_BEHAVIOURS)[number];
}

const DEFAULTS: TerminalPreferences = {
  activeProfile: null,
  promptEngine: "oh-my-posh",
  animations: true,
  intensity: "medium",
  shaders: false,
  reducedMotion: false,
  startup: "banner",
};

interface StoredPreferences {
  readonly preferences: TerminalPreferences;
  // The file's object as read, unknown keys included; empty when there is none that can be trusted.
  readonly document: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
}

export function terminalConfigPath(host: HostInfo): string {
  const ops = pathOps(host.platform);
  return ops.join(ops.dirname(harilConfigPath(host).path), "terminal.json");
}

function oneOf<T>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function parseDocument(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported by the caller, the same as a value of the wrong shape.
  }
  return undefined;
}

function checkedPreferences(
  document: Readonly<Record<string, unknown>>,
  path: string,
): { preferences: TerminalPreferences; warnings: string[] } {
  const warnings: string[] = [];
  // A value that is absent takes its default silently; one that is present and wrong also warns.
  function pick<T>(
    key: keyof TerminalPreferences,
    fallback: T,
    read: (value: unknown) => T | undefined,
  ): T {
    const value = document[key];
    if (value === undefined) return fallback;
    const checked = read(value);
    if (checked !== undefined) return checked;
    warnings.push(`${path}: ${key} is not valid; using ${JSON.stringify(fallback)}`);
    return fallback;
  }
  const flag = (value: unknown) => oneOf([true, false], value);
  const profile = (value: unknown) =>
    value === null ? null : typeof value === "string" ? findThemeProfile(value)?.id : undefined;
  const preferences: TerminalPreferences = {
    activeProfile: pick<string | null>("activeProfile", DEFAULTS.activeProfile, profile),
    promptEngine: pick("promptEngine", DEFAULTS.promptEngine, (value) =>
      oneOf(PROMPT_ENGINES, value),
    ),
    animations: pick("animations", DEFAULTS.animations, flag),
    intensity: pick("intensity", DEFAULTS.intensity, (value) => oneOf(INTENSITIES, value)),
    shaders: pick("shaders", DEFAULTS.shaders, flag),
    reducedMotion: pick("reducedMotion", DEFAULTS.reducedMotion, flag),
    startup: pick("startup", DEFAULTS.startup, (value) => oneOf(STARTUP_BEHAVIOURS, value)),
  };
  return { preferences, warnings };
}

export function readTerminalPreferences(host: HostInfo): StoredPreferences {
  const path = terminalConfigPath(host);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { preferences: DEFAULTS, document: {}, warnings: [] };
    }
    const warning = `${path}: could not be read; using the defaults`;
    return { preferences: DEFAULTS, document: {}, warnings: [warning] };
  }
  const document = parseDocument(text);
  if (document === undefined) {
    const warning = `${path}: not valid JSON or not an object; using the defaults`;
    return { preferences: DEFAULTS, document: {}, warnings: [warning] };
  }
  return { ...checkedPreferences(document, path), document };
}
