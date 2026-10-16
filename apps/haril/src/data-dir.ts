import { posix, win32 } from "node:path";

// Data directory resolution (M1-D8). Precedence: --data-dir flag > HARIL_HOME > platform default.
// Both the flag and HARIL_HOME name the data directory itself (the one that holds haril.db).

export interface DataDirInput {
  readonly flag?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homeDir: string;
}

export interface DataDirResolution {
  readonly dataDir: string;
  readonly source: "flag" | "HARIL_HOME" | "platform-default";
}

export function resolveDataDir(input: DataDirInput): DataDirResolution {
  if (input.flag !== undefined && input.flag !== "") {
    return { dataDir: input.flag, source: "flag" };
  }
  const fromEnv = input.env.HARIL_HOME;
  if (fromEnv !== undefined && fromEnv !== "") {
    return { dataDir: fromEnv, source: "HARIL_HOME" };
  }
  return { dataDir: platformDefault(input), source: "platform-default" };
}

function platformDefault(input: DataDirInput): string {
  if (input.platform === "win32") {
    const localAppData = input.env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData !== ""
        ? localAppData
        : win32.join(input.homeDir, "AppData", "Local");
    return win32.join(base, "HARIL", "data");
  }
  // XDG base directory: $XDG_DATA_HOME/haril/data when set, else ~/.local/share/haril/data (M1-D8).
  const xdg = input.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg !== "" ? xdg : posix.join(input.homeDir, ".local", "share");
  return posix.join(base, "haril", "data");
}
