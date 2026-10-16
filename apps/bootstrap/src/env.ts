import { systemRoot } from "./platform.js";

// Environment of the child processes (M2-D2). Allow-listed only: no npm_config_*, NODE_OPTIONS, tokens or
// keys from the caller reach Pi's Node or npm. The PATH starts with the isolated Node directory.

type Env = Readonly<Record<string, string | undefined>>;

const SEPARATOR_WIN = ";";
const SEPARATOR_POSIX = ":";

// Variables a Windows or POSIX process needs to start and to reach its temporary directory.
function baseEnv(platform: string, env: Env): Record<string, string> {
  const keys = platform === "win32" ? ["SystemRoot", "TEMP", "TMP"] : ["HOME", "TMPDIR"];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") result[key] = value;
  }
  if (platform === "win32") result.SystemRoot = systemRoot(env);
  return result;
}

// The system tools directories: enough for tar.exe on Windows and for sh-level helpers on POSIX.
function systemPath(platform: string, env: Env): readonly string[] {
  return platform === "win32"
    ? [`${systemRoot(env)}\\System32`, systemRoot(env)]
    : ["/usr/bin", "/bin"];
}

export function isolatedEnv(
  platform: string,
  env: Env,
  binDir: string | undefined,
): Record<string, string> {
  const separator = platform === "win32" ? SEPARATOR_WIN : SEPARATOR_POSIX;
  const entries = [binDir, ...systemPath(platform, env)].filter(
    (entry): entry is string => entry !== undefined && entry !== "",
  );
  return { ...baseEnv(platform, env), PATH: entries.join(separator) };
}
