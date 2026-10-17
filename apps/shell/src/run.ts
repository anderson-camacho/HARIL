import type { Terminal } from "@earendil-works/pi-tui";
import { createHarilActions } from "./actions.js";
import { createShellApp } from "./app.js";
import { openShellData } from "./data.js";
import type { ShellSettings } from "./panels/index.js";
import { DEFAULT_THEME_NAME, readOptionalFile, resolveTheme } from "./theme.js";

// Entry logic of the shell (TUI-D3, TUI-D8). The CLI passes resolved paths; this process opens the store read-only
// (never creates it) and never starts the runtime. main.ts wires the real process; tests inject the streams, the
// terminal, the environment and the files.

const EXIT_OK = 0;
const EXIT_USAGE = 2;

const USAGE =
  "usage: shell [--data-dir <path>] [--runtime-root <path>] [--config <path>] [--haril <path>]";
const NOT_A_TERMINAL =
  "haril shell needs an interactive terminal: stdin and stdout must both be a TTY. Run it in a terminal window.";

export interface ShellRunDeps {
  readonly stdinIsTTY: boolean | undefined;
  readonly stdoutIsTTY: boolean | undefined;
  readonly stderr: (line: string) => void;
  // Reads a file as text, or undefined when it does not exist.
  readonly readFile?: (path: string) => string | undefined;
  // Names of the entries of a directory; empty when it does not exist.
  readonly listFiles?: (dir: string) => readonly string[];
  // The environment, read only to tell whether provider key variables are set. Defaults to none.
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly createTerminal: () => Terminal;
}

interface ShellArgs {
  readonly dataDir: string | undefined;
  readonly runtimeRoot: string | undefined;
  readonly config: string | undefined;
  // The running haril bundle; the shell's actions run its CLI (TUI-D13).
  readonly haril: string | undefined;
}

const VALUE_FLAGS: Readonly<Record<string, keyof ShellArgs>> = {
  "--data-dir": "dataDir",
  "--runtime-root": "runtimeRoot",
  "--config": "config",
  "--haril": "haril",
};

const DEFAULT_MODEL_ENV = "HARIL_DEFAULT_MODEL";

export async function runShell(argv: readonly string[], deps: ShellRunDeps): Promise<number> {
  const args = parseArgs(argv);
  if (args === undefined) {
    deps.stderr(USAGE);
    return EXIT_USAGE;
  }
  if (!deps.stdinIsTTY || !deps.stdoutIsTTY) {
    deps.stderr(NOT_A_TERMINAL);
    return EXIT_USAGE;
  }

  const readFile = deps.readFile ?? readOptionalFile;
  const requested = themeNameFrom(args.config, readFile);
  const { theme, warning } = resolveTheme({
    name: requested.name,
    runtimeRoot: args.runtimeRoot,
    readFile,
  });
  const notices = [requested.warning, warning].filter((notice) => notice !== undefined);

  const data = openShellData({
    paths: { dataDir: args.dataDir, runtimeRoot: args.runtimeRoot, configPath: args.config },
    env: deps.env ?? {},
    readFile,
    ...(deps.listFiles === undefined ? {} : { listFiles: deps.listFiles }),
  });
  const settings: ShellSettings = {
    dataDir: args.dataDir,
    runtimeRoot: args.runtimeRoot,
    configPath: args.config,
    themeName: requested.name,
    themeLabel: theme.name,
  };
  try {
    const app = createShellApp({
      terminal: deps.createTerminal(),
      theme,
      warning: notices.length > 0 ? notices.join("; ") : undefined,
      // Approvals do not exist in this version: the count is always 0.
      banner: { isolation: "N0", pendingApprovals: 0 },
      data,
      settings,
      actions: createHarilActions({ harilEntry: args.haril }),
      defaultModel: nonEmpty(deps.env?.[DEFAULT_MODEL_ENV]),
    });
    app.start();
    await app.done;
  } finally {
    data.close();
  }
  return EXIT_OK;
}

// Only the flags listed in VALUE_FLAGS, each with one value. Anything else is a usage error.
function parseArgs(argv: readonly string[]): ShellArgs | undefined {
  const values: { -readonly [K in keyof ShellArgs]: ShellArgs[K] } = {
    dataDir: undefined,
    runtimeRoot: undefined,
    config: undefined,
    haril: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const key = flag === undefined ? undefined : VALUE_FLAGS[flag];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith("--")) return undefined;
    values[key] = value;
    index++;
  }
  return values;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

// The theme named by haril.json (ui.theme). A missing file means the default; an unreadable one is a warning.
function themeNameFrom(
  configPath: string | undefined,
  readFile: (path: string) => string | undefined,
): { name: string; warning: string | undefined } {
  if (configPath === undefined) return { name: DEFAULT_THEME_NAME, warning: undefined };
  const text = readFile(configPath);
  if (text === undefined) return { name: DEFAULT_THEME_NAME, warning: undefined };
  try {
    const document = JSON.parse(text) as { ui?: { theme?: unknown } } | null;
    const name = document?.ui?.theme;
    if (name === undefined) return { name: DEFAULT_THEME_NAME, warning: undefined };
    if (typeof name !== "string" || name === "") {
      return { name: DEFAULT_THEME_NAME, warning: "ui.theme must be a theme name" };
    }
    return { name, warning: undefined };
  } catch {
    return { name: DEFAULT_THEME_NAME, warning: "haril.json is not valid JSON" };
  }
}
