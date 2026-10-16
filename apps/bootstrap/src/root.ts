import { posix, win32 } from "node:path";

// Runtime root resolution (M2-T3): --root > HARIL_RUNTIME_DIR > %LOCALAPPDATA%\HARIL on win32,
// else ${XDG_DATA_HOME:-~/.local/share}/haril. The doctor section resolves the same way without importing this file.

export interface RootInput {
  readonly flag?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homeDir: string;
}

export interface RootResolution {
  readonly root: string;
  readonly source: "flag" | "HARIL_RUNTIME_DIR" | "platform-default";
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function resolveRuntimeRoot(input: RootInput): RootResolution {
  const flag = nonEmpty(input.flag);
  if (flag !== undefined) return { root: flag, source: "flag" };
  const fromEnv = nonEmpty(input.env.HARIL_RUNTIME_DIR);
  if (fromEnv !== undefined) return { root: fromEnv, source: "HARIL_RUNTIME_DIR" };
  return { root: platformDefault(input), source: "platform-default" };
}

function platformDefault(input: RootInput): string {
  if (input.platform === "win32") {
    const localAppData =
      nonEmpty(input.env.LOCALAPPDATA) ?? win32.join(input.homeDir, "AppData", "Local");
    return win32.join(localAppData, "HARIL");
  }
  const dataHome =
    nonEmpty(input.env.XDG_DATA_HOME) ?? posix.join(input.homeDir, ".local", "share");
  return posix.join(dataHome, "haril");
}
