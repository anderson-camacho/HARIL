import { readFileSync } from "node:fs";
import { join } from "node:path";
import blossomTheme from "../themes/haril-blossom.json" with { type: "json" };
import crimsonTheme from "../themes/haril-crimson.json" with { type: "json" };
import darkTheme from "../themes/haril-dark.json" with { type: "json" };
import lightTheme from "../themes/haril-light.json" with { type: "json" };

// Theme loader (TUI-D2). It reads the Pi theme JSON format (name, appearance, vars, colors) with its own code, so the
// shell never imports pi-coding-agent. Lookup: <runtime root>/config/themes/<name>.json, then the themes embedded here.
// Only the color tokens below are read. Any other token in a theme file is ignored, so a full Pi theme also loads.
//
// Supported color values: "#RGB" or "#RRGGBB", a 0-255 integer (256-color index), "" (terminal default), or the name
// of an entry in "vars" (resolved recursively). OKLCH, OKHSL and other Pi color syntaxes are rejected with a warning.

// Red on black (LD-T6b-1). A saved ui.theme still wins.
export const DEFAULT_THEME_NAME = "haril-crimson";

// The tokens the shell draws with. accent, text, muted and warning are required: a theme without one of them is
// rejected. border, ok and danger came with the console frame (LD-T6b-1); a theme written before them still loads,
// and each takes the color of the token in TOKEN_FALLBACK.
export const SHELL_THEME_TOKENS = [
  "accent",
  "text",
  "muted",
  "warning",
  "border",
  "ok",
  "danger",
] as const;
export type ThemeToken = (typeof SHELL_THEME_TOKENS)[number];
const TOKEN_FALLBACK: Readonly<Partial<Record<ThemeToken, ThemeToken>>> = {
  border: "muted",
  ok: "accent",
  danger: "warning",
};

export interface Theme {
  readonly name: string;
  readonly source: "user" | "native";
  readonly appearance: "dark" | "light" | undefined;
  // Wraps text in the token's foreground color (truecolor, or 256-color for an index). Default colors leave it as is.
  fg(token: ThemeToken, text: string): string;
  bold(text: string): string;
}

export interface ThemeResolution {
  readonly theme: Theme;
  // Set when the requested theme was not used: the message names the cause and the fallback.
  readonly warning: string | undefined;
}

export interface ResolveThemeOptions {
  readonly name: string;
  // Runtime root; the user theme directory is <runtimeRoot>/config/themes. Undefined skips user themes.
  readonly runtimeRoot: string | undefined;
  // Reads a file as text, or undefined when it does not exist. Injected so tests never touch the real disk.
  readonly readFile?: (path: string) => string | undefined;
}

type Color =
  | { readonly kind: "rgb"; readonly r: number; readonly g: number; readonly b: number }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "default" };

class ThemeError extends Error {}

const NATIVE: Readonly<Record<string, unknown>> = {
  "haril-dark": darkTheme,
  "haril-light": lightTheme,
  "haril-crimson": crimsonTheme,
  "haril-blossom": blossomTheme,
};

// The themes built into the bundle, in the order the Themes panel lists them.
export const NATIVE_THEME_NAMES: readonly string[] = Object.keys(NATIVE);

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_REFERENCE_DEPTH = 16;

export function resolveTheme(options: ResolveThemeOptions): ThemeResolution {
  const readFile = options.readFile ?? readOptionalFile;
  try {
    return { theme: loadNamed(options, readFile), warning: undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = nativeTheme(DEFAULT_THEME_NAME);
    return {
      theme: fallback,
      warning: `${reason}; using ${DEFAULT_THEME_NAME}`,
    };
  }
}

// Parses one theme document. Throws a message that names the problem; resolveTheme turns it into a warning.
export function themeFromText(
  label: string,
  text: string,
  source: "user" | "native" = "user",
): Theme {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ThemeError(`theme "${label}": ${label}.json is not valid JSON (${detail})`);
  }
  return themeFromDocument(label, document, source);
}

function loadNamed(
  options: ResolveThemeOptions,
  readFile: (path: string) => string | undefined,
): Theme {
  const { name } = options;
  if (!PLAIN_NAME.test(name)) {
    throw new ThemeError(`theme name "${name}" is not a plain name`);
  }
  if (options.runtimeRoot !== undefined) {
    const path = join(options.runtimeRoot, "config", "themes", `${name}.json`);
    const text = readFile(path);
    if (text !== undefined) return themeFromText(name, text, "user");
  }
  if (name in NATIVE) return nativeTheme(name);
  throw new ThemeError(`theme "${name}" not found in config/themes or the built-in themes`);
}

function nativeTheme(name: string): Theme {
  const document = NATIVE[name];
  if (document === undefined) throw new ThemeError(`no built-in theme "${name}"`);
  return themeFromDocument(name, document, "native");
}

function themeFromDocument(label: string, document: unknown, source: "user" | "native"): Theme {
  const root = asRecord(document, `theme "${label}" is not a JSON object`);
  const name = typeof root.name === "string" && root.name !== "" ? root.name : label;
  if (name.includes("/")) {
    throw new ThemeError(`theme "${label}": the name must not contain "/"`);
  }
  const appearance = root.appearance;
  if (appearance !== undefined && appearance !== "dark" && appearance !== "light") {
    throw new ThemeError(`theme "${label}": appearance must be "dark" or "light"`);
  }
  const vars =
    root.vars === undefined ? {} : asRecord(root.vars, `theme "${label}": vars must be an object`);
  const colors = asRecord(root.colors, `theme "${label}": colors must be an object`);

  const resolved = {} as Record<ThemeToken, Color>;
  // The required tokens come first in SHELL_THEME_TOKENS, so a fallback is always resolved before it is used.
  for (const token of SHELL_THEME_TOKENS) {
    const value = colors[token];
    const fallback = TOKEN_FALLBACK[token];
    if (value === undefined && fallback !== undefined) {
      resolved[token] = resolved[fallback];
      continue;
    }
    if (value === undefined) {
      throw new ThemeError(`theme "${label}": missing color "${token}"`);
    }
    resolved[token] = parseColor(label, token, value, vars, []);
  }

  return {
    name,
    source,
    appearance,
    fg: (token, text) => paint(resolved[token], text),
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  };
}

function parseColor(
  label: string,
  token: string,
  value: unknown,
  vars: Record<string, unknown>,
  chain: readonly string[],
): Color {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new ThemeError(`theme "${label}": color "${token}" must be an index from 0 to 255`);
    }
    return { kind: "index", index: value };
  }
  if (typeof value !== "string") {
    throw new ThemeError(`theme "${label}": color "${token}" must be a string or a 0-255 index`);
  }
  if (value === "") return { kind: "default" };
  const hex = HEX.exec(value);
  if (hex !== null) return hexColor(hex[1] ?? "");
  if (value.startsWith("#") || value.includes("(")) {
    throw new ThemeError(
      `theme "${label}": color "${token}" is "${value}", which is not supported (use #RRGGBB, #RGB, a 0-255 index, or a variable)`,
    );
  }
  // Anything else is a variable reference, followed through `vars` until a literal value is reached.
  if (chain.length >= MAX_REFERENCE_DEPTH || chain.includes(value)) {
    throw new ThemeError(`theme "${label}": variable reference cycle at "${value}"`);
  }
  if (!(value in vars)) {
    throw new ThemeError(
      `theme "${label}": color "${token}" refers to unknown variable "${value}"`,
    );
  }
  return parseColor(label, token, vars[value], vars, [...chain, value]);
}

function hexColor(digits: string): Color {
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join("") : digits;
  return {
    kind: "rgb",
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function paint(color: Color, text: string): string {
  switch (color.kind) {
    case "rgb":
      return `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[39m`;
    case "index":
      return `\x1b[38;5;${color.index}m${text}\x1b[39m`;
    case "default":
      return text;
  }
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThemeError(message);
  }
  return value as Record<string, unknown>;
}

// The user theme file, or undefined when it does not exist. Other read errors propagate to resolveTheme.
export function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
