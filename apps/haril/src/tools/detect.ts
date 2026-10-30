import { posix, win32 } from "node:path";
import type { Install, InstallOrigin, ToolId } from "./types.js";
import type { VersionRead } from "./version.js";

// Finds every install of engram and gentle-ai in the only places HARIL looks at and reads each one's real version by
// running it. Nothing is guessed: the places are HARIL's own Engram copy, the memory.binary override, PATH and Go's
// bin directories (GOBIN, GOPATH/bin, ~/go/bin).

export interface DetectContext {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  // Engram only: HARIL's own copy, and the binary the runtime executes (memory.binary, or that same copy).
  readonly harilCopy?: string;
  readonly runtimeBinary?: string;
}

export interface DetectDeps {
  readonly isFile: (path: string) => boolean;
  readonly realPath: (path: string) => string;
  readonly readVersion: (path: string, tool: ToolId) => Promise<VersionRead>;
}

interface Candidate {
  readonly path: string;
  readonly origin: InstallOrigin;
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  const key = caseInsensitive
    ? Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    : name;
  const value = key === undefined ? undefined : env[key];
  return value === undefined || value === "" ? undefined : value;
}

// The directories of a PATH-like variable that can be trusted: absolute, so a bare "bin" or "." (the working
// directory, which a project controls) is never searched.
function absoluteDirs(
  value: string | undefined,
  ops: typeof posix | typeof win32,
  windows: boolean,
): string[] {
  if (value === undefined) return [];
  return value
    .split(ops.delimiter)
    .map((entry) => (windows ? entry.trim().replace(/^"(.*)"$/, "$1") : entry))
    .filter((entry) => entry !== "" && ops.isAbsolute(entry));
}

function goBinDirs(
  ctx: DetectContext,
  ops: typeof posix | typeof win32,
  windows: boolean,
): string[] {
  const dirs: string[] = [];
  const gobin = envValue(ctx.env, "GOBIN", windows);
  if (gobin !== undefined && ops.isAbsolute(gobin)) dirs.push(gobin);
  for (const root of absoluteDirs(envValue(ctx.env, "GOPATH", windows), ops, windows)) {
    dirs.push(ops.join(root, "bin"));
  }
  if (ctx.homeDir !== "") dirs.push(ops.join(ctx.homeDir, "go", "bin"));
  return dirs;
}

function candidates(tool: ToolId, ctx: DetectContext): Candidate[] {
  const windows = ctx.platform === "win32";
  const ops = windows ? win32 : posix;
  const file = windows ? `${tool}.exe` : tool;
  const list: Candidate[] = [];
  if (tool === "engram") {
    if (ctx.harilCopy !== undefined) list.push({ path: ctx.harilCopy, origin: "haril" });
    // The override is its own place only when it points somewhere else than HARIL's copy.
    if (ctx.runtimeBinary !== undefined && ctx.runtimeBinary !== ctx.harilCopy) {
      list.push({ path: ctx.runtimeBinary, origin: "config" });
    }
  }
  for (const dir of absoluteDirs(envValue(ctx.env, "PATH", windows), ops, windows)) {
    list.push({ path: ops.join(dir, file), origin: "path" });
  }
  for (const dir of goBinDirs(ctx, ops, windows)) {
    list.push({ path: ops.join(dir, file), origin: "go-bin" });
  }
  return list;
}

interface Found {
  readonly path: string;
  readonly origins: InstallOrigin[];
}

export async function detectInstalls(
  tool: ToolId,
  ctx: DetectContext,
  deps: DetectDeps,
): Promise<Install[]> {
  const windows = ctx.platform === "win32";
  const sameFile = (path: string) => {
    const real = deps.realPath(path);
    return windows ? real.toLowerCase() : real;
  };
  const found = new Map<string, Found>();
  for (const candidate of candidates(tool, ctx)) {
    if (!deps.isFile(candidate.path)) continue;
    const key = sameFile(candidate.path);
    const known = found.get(key);
    if (known === undefined) found.set(key, { path: candidate.path, origins: [candidate.origin] });
    else if (!known.origins.includes(candidate.origin)) known.origins.push(candidate.origin);
  }

  // The install that runs: Engram's is the one the runtime executes. gentle-ai's is the first one found, and PATH is
  // searched before the Go bin dirs, so that is the first on PATH or, when it is only in a Go bin dir, that one (found,
  // though a bare `gentle-ai` would not resolve to it).
  const runtimeKey = ctx.runtimeBinary === undefined ? undefined : sameFile(ctx.runtimeBinary);
  const entries = [...found.entries()];
  const activeKey =
    tool === "engram" ? entries.find(([key]) => key === runtimeKey)?.[0] : entries[0]?.[0];

  const installs = await Promise.all(
    entries.map(async ([key, entry]): Promise<Install> => {
      const read = await deps.readVersion(entry.path, tool);
      return {
        path: entry.path,
        origin: entry.origins[0] ?? "path",
        origins: entry.origins,
        version: "version" in read ? read.version : null,
        versionError: "error" in read ? read.error : null,
        active: key === activeKey,
      };
    }),
  );
  return [...installs.filter((i) => i.active), ...installs.filter((i) => !i.active)];
}
