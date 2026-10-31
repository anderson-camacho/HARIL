import { randomBytes } from "node:crypto";
import { argsProblem, lastValue, type ParsedArgs, parseArgs } from "../args.js";
import { type CliIo, EXIT_OK, EXIT_USAGE, type HostInfo } from "../context.js";
import { findThemeProfile, THEME_PROFILES, type ThemeProfile } from "../themes/catalog.js";
import {
  INTENSITIES,
  PROMPT_ENGINES,
  readTerminalPreferences,
  STARTUP_BEHAVIOURS,
  type TerminalPreferences,
  terminalConfigPath,
} from "../themes/preferences.js";
import { writeJsonAtomic } from "../tools/engram-config.js";
import { errorText, nodeEnsureFs } from "../tools/fs.js";

// `haril theme list|preview|apply|status`: the terminal profile catalog and the selection. This slice only records the
// selection in <config folder>/terminal.json (themes/preferences.ts): it never changes Windows Terminal, $PROFILE or
// fonts, and it installs nothing. Only apply writes.

const LIST_USAGE = "usage: haril theme list [--json]";
const PREVIEW_USAGE = "usage: haril theme preview <id> [--json]";
const APPLY_USAGE =
  "usage: haril theme apply <id> [--prompt-engine oh-my-posh|starship] [--animations on|off] " +
  "[--intensity low|medium|high] [--shaders on|off] [--reduced-motion on|off] " +
  "[--startup banner|minimal|none] [--json]";
const STATUS_USAGE = "usage: haril theme status [--json]";
const NOT_AVAILABLE =
  "Terminal integration is not available yet: Windows Terminal, $PROFILE and fonts were not changed.";
const EXIT_FAILED = 1;

export interface ThemeServices {
  // Replaces the preferences file; defaults to an atomic write. A failure must leave the old file.
  readonly write?: (path: string, value: unknown) => void;
}

export function theme(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: ThemeServices = {},
): number {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") return themeList(rest, io, host);
  if (subcommand === "preview") return themePreview(rest, io, host);
  if (subcommand === "apply") return themeApply(rest, io, host, services);
  if (subcommand === "status") return themeStatus(rest, io, host);
  if (subcommand === undefined) io.err("haril: theme needs a subcommand");
  else io.err(`haril: unknown theme subcommand "${subcommand}"`);
  for (const usage of [LIST_USAGE, PREVIEW_USAGE, APPLY_USAGE, STATUS_USAGE]) io.err(usage);
  return EXIT_USAGE;
}

function reportWarnings(io: CliIo, warnings: readonly string[]): void {
  for (const warning of warnings) io.err(`haril: warning: ${warning}`);
}

function themeList(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(LIST_USAGE);
    return EXIT_USAGE;
  }
  const { preferences, warnings } = readTerminalPreferences(host);
  reportWarnings(io, warnings);
  const active = (profile: ThemeProfile) => profile.id === preferences.activeProfile;
  if (parsed.flags.has("--json")) {
    const profiles = THEME_PROFILES.map((profile) => ({ ...profile, active: active(profile) }));
    io.out(JSON.stringify({ schema: "haril.theme.list/1", profiles, warnings }));
    return EXIT_OK;
  }
  for (const profile of THEME_PROFILES) {
    io.out(`${active(profile) ? "*" : " "} ${profile.id}  ${profile.fonts.primary}`);
  }
  return EXIT_OK;
}

function colorEnabled(host: HostInfo): boolean {
  const noColor = host.env?.NO_COLOR;
  return host.interactive === true && (noColor === undefined || noColor === "");
}

function swatch(hex: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `\u001b[48;2;${channels.join(";")}m    \u001b[0m `;
}

function unknownProfile(id: string, io: CliIo): number {
  io.err(`haril: unknown profile "${id}"; run haril theme list`);
  return EXIT_USAGE;
}

function themePreview(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [id, ...extra] = parsed.positionals;
  if (id === undefined || extra.length > 0) {
    io.err(PREVIEW_USAGE);
    return EXIT_USAGE;
  }
  const profile = findThemeProfile(id);
  if (profile === undefined) return unknownProfile(id, io);
  if (parsed.flags.has("--json")) {
    io.out(JSON.stringify({ schema: "haril.theme.preview/1", profile }));
    return EXIT_OK;
  }
  const color = colorEnabled(host);
  io.out(`${profile.id} (based on ${profile.basedOn.join(", ")})`);
  for (const { name, hex } of profile.palette) {
    io.out(`  ${color ? swatch(hex) : ""}${hex}  ${name}`);
  }
  io.out(`  primary: ${profile.fonts.primary}`);
  for (const font of profile.fonts.fallbacks) io.out(`  fallback: ${font}`);
  io.out(`  symbols: ${profile.fonts.symbols}`);
  return EXIT_OK;
}

const PREFERENCE_FLAGS: readonly (readonly [
  string,
  keyof TerminalPreferences,
  readonly string[],
])[] = [
  ["--prompt-engine", "promptEngine", PROMPT_ENGINES],
  ["--animations", "animations", ["on", "off"]],
  ["--intensity", "intensity", INTENSITIES],
  ["--shaders", "shaders", ["on", "off"]],
  ["--reduced-motion", "reducedMotion", ["on", "off"]],
  ["--startup", "startup", STARTUP_BEHAVIOURS],
];

// The preferences the flags set, or the first problem.
function preferenceFlags(parsed: ParsedArgs): Partial<TerminalPreferences> | string {
  const changes: Record<string, unknown> = {};
  for (const [flag, key, allowed] of PREFERENCE_FLAGS) {
    const value = lastValue(parsed, flag);
    if (value === undefined) continue;
    if (!allowed.includes(value)) return `${flag} must be ${allowed.join(" or ")}`;
    changes[key] = value === "on" ? true : value === "off" ? false : value;
  }
  return changes;
}

function defaultWrite(path: string, value: unknown): void {
  writeJsonAtomic(path, value, nodeEnsureFs, randomBytes(4).toString("hex"));
}

function themeApply(
  args: readonly string[],
  io: CliIo,
  host: HostInfo,
  services: ThemeServices,
): number {
  const parsed = parseArgs(args, {
    values: PREFERENCE_FLAGS.map(([flag]) => flag),
    flags: ["--json"],
  });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  const [id, ...extra] = parsed.positionals;
  if (id === undefined || extra.length > 0) {
    io.err(APPLY_USAGE);
    return EXIT_USAGE;
  }
  const profile = findThemeProfile(id);
  if (profile === undefined) return unknownProfile(id, io);
  const changes = preferenceFlags(parsed);
  if (typeof changes === "string") {
    io.err(`haril: ${changes}`);
    io.err(APPLY_USAGE);
    return EXIT_USAGE;
  }

  const stored = readTerminalPreferences(host);
  reportWarnings(io, stored.warnings);
  const preferences: TerminalPreferences = {
    ...stored.preferences,
    ...changes,
    activeProfile: profile.id,
  };
  // The keys this version does not know stay, for the version that does.
  const next = { ...stored.document, ...preferences };
  // A corrupt file reads as an empty document, so it always differs and an apply replaces it.
  const changed = JSON.stringify(next) !== JSON.stringify(stored.document);
  const path = terminalConfigPath(host);
  if (changed) {
    try {
      (services.write ?? defaultWrite)(path, next);
    } catch (error) {
      io.err(`haril: could not write ${path}: ${errorText(error)}`);
      return EXIT_FAILED;
    }
  }

  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        schema: "haril.theme.apply/1",
        activeProfile: profile.id,
        changed,
        preferences,
        path,
        terminalIntegration: "not_available",
        warnings: stored.warnings,
      }),
    );
    return EXIT_OK;
  }
  io.out(`${changed ? "selected" : "already selected"}: ${profile.id}`);
  io.out(NOT_AVAILABLE);
  return EXIT_OK;
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function themeStatus(args: readonly string[], io: CliIo, host: HostInfo): number {
  const parsed = parseArgs(args, { values: [], flags: ["--json"] });
  const problem = argsProblem(parsed, io);
  if (problem !== null) return problem;
  if (parsed.positionals.length > 0) {
    io.err(STATUS_USAGE);
    return EXIT_USAGE;
  }
  const { preferences, warnings } = readTerminalPreferences(host);
  reportWarnings(io, warnings);
  const path = terminalConfigPath(host);
  if (parsed.flags.has("--json")) {
    io.out(
      JSON.stringify({
        schema: "haril.theme.status/1",
        preferences,
        path,
        terminalIntegration: "not_available",
        warnings,
      }),
    );
    return EXIT_OK;
  }
  io.out(`active profile: ${preferences.activeProfile ?? "none"}`);
  io.out(`prompt engine: ${preferences.promptEngine}`);
  io.out(`animations: ${onOff(preferences.animations)}`);
  io.out(`intensity: ${preferences.intensity}`);
  io.out(`shaders: ${onOff(preferences.shaders)}`);
  io.out(`reduced motion: ${onOff(preferences.reducedMotion)}`);
  io.out(`startup: ${preferences.startup}`);
  io.out(`file: ${path}`);
  return EXIT_OK;
}
