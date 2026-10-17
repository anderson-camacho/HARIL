// The guards that run before `engram serve` is launched (ADR-0008 D5; MEMORY.md 4.4, 11.2; memory.md 9.4 point 2).
// ENGRAM_DATA_DIR must be absolute, local, never ~/.engram nor inside it (lexically and canonically: case variants,
// trailing separators, 8.3 short names, junctions and symlinks), free of names Win32 renames, without a link that
// points nowhere, and HARIL's own <data>/memory/engram. The home the child gets passes the same checks and must not
// hold the user's ~/.engram. ENGRAM_PORT must be explicit, valid, never 0, never 7437 or another reserved port, and
// free on loopback. Any refusal is fail-closed: the caller does not fall back to another directory or port (I6).
import { lstatSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { posix, win32 } from "node:path";
import { portProblem } from "./loopback.js";

type Env = Readonly<Record<string, string | undefined>>;

// The file system the data dir guard reads: the canonical form of a path that exists, and whether an entry exists.
export interface GuardFs {
  // Junctions, symlinks and 8.3 short names resolved; throws for a path that does not exist.
  realpath(path: string): string;
  // Whether there is an entry at the path itself, a link not followed (lstat).
  exists(path: string): boolean;
}

export const nodeGuardFs: GuardFs = {
  realpath: (path) => realpathSync.native(path),
  exists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
};

export interface EngramDataDirInput {
  // The ENGRAM_DATA_DIR value to check.
  readonly candidate: string;
  // HARIL's data dir (<root>\data, the one holding haril.db).
  readonly harilDataDir: string;
  // The home whose .engram belongs to the user's own Engram.
  readonly homeDir: string;
  // Read for the OneDrive variables only.
  readonly env: Env;
  readonly platform?: NodeJS.Platform;
  readonly fs?: GuardFs;
}

export type DataDirRefusal =
  | "empty"
  | "relative"
  | "not_local"
  | "ambiguous_name"
  | "user_engram"
  | "unresolvable"
  | "not_owned";

export type EngramDataDirCheck =
  | { readonly ok: true; readonly dataDir: string }
  | { readonly ok: false; readonly reason: DataDirRefusal; readonly message: string };

export type PortRefusal = "invalid" | "reserved" | "in_use";

export type EngramPortCheck =
  | { readonly ok: true; readonly port: number }
  | { readonly ok: false; readonly reason: PortRefusal; readonly message: string };

export interface PortProbe {
  // Whether 127.0.0.1:port can be bound right now (it is released at once).
  isFree(port: number): Promise<boolean>;
}

const ONEDRIVE_VARIABLES = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const;

function pathsOf(platform: NodeJS.Platform): typeof win32 {
  return platform === "win32" ? win32 : posix;
}

// The data dir HARIL owns for its single serve (ARCH 4.4).
export function engramDataDirOf(
  harilDataDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathsOf(platform).join(harilDataDir, "memory", "engram");
}

// The home the serve's environment names (USERPROFILE, HOME, HOMEDRIVE and HOMEPATH) [S]: a directory HARIL owns next
// to the data dir, so nothing in the child can reach the user's home and its ~/.engram. No document names it.
export function engramHomeOf(
  harilDataDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathsOf(platform).join(harilDataDir, "memory", "engram-home");
}

// A Win32 name that Win32 APIs (Go, .NET) read differently from Node: a trailing dot or space is dropped, a device
// name is the device whatever its extension, a colon opens an alternate data stream, and the reserved and control
// characters.
const RENAMED_SEGMENT = /[. ]$|[<>:"|?*]/;
const DEVICE_SEGMENT =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;

function refused(reason: DataDirRefusal, message: string): EngramDataDirCheck {
  return { ok: false, reason, message };
}

class PathRules {
  private readonly paths: typeof win32;
  private readonly windows: boolean;

  constructor(platform: NodeJS.Platform) {
    this.paths = pathsOf(platform);
    this.windows = platform === "win32";
  }

  // Normalized, without a trailing separator (a root keeps its own).
  normal(path: string): string {
    const normalized = this.paths.normalize(path);
    const root = this.paths.parse(normalized).root;
    let end = normalized.length;
    while (end > root.length && /[\\/]/.test(normalized[end - 1] ?? "")) end -= 1;
    return normalized.slice(0, end);
  }

  private fold(path: string): string {
    const normal = this.normal(path);
    return this.windows ? normal.toLowerCase() : normal;
  }

  // `path` is `base` or below it, at a segment boundary.
  within(path: string, base: string): boolean {
    const child = this.fold(path);
    const parent = this.fold(base);
    if (child === parent) return true;
    const prefix = parent.endsWith(this.paths.sep) ? parent : `${parent}${this.paths.sep}`;
    return child.startsWith(prefix);
  }

  same(a: string, b: string): boolean {
    return this.fold(a) === this.fold(b);
  }

  // A device, extended-length, UNC or WSL form: not a plain path on a local disk (INV-13).
  notLocal(path: string): boolean {
    return /^[\\/]{2}/.test(path);
  }

  absolute(path: string): boolean {
    return this.windows ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith("/");
  }

  // On Windows, a segment Win32 would rename or read as a device (RENAMED_SEGMENT, DEVICE_SEGMENT).
  ambiguous(path: string): boolean {
    if (!this.windows) return false;
    const normal = this.normal(path);
    return normal
      .slice(this.paths.parse(normal).root.length)
      .split(/[\\/]+/)
      .some(
        (part) =>
          part !== "" &&
          (RENAMED_SEGMENT.test(part) ||
            DEVICE_SEGMENT.test(part) ||
            [...part].some((char) => (char.codePointAt(0) ?? 0) < 0x20)),
      );
  }

  // The canonical form, resolved from the root down one segment at a time: a part that does not exist yet is
  // appended as it is, and the walk stops as soon as it reaches a place `stop` names, so it never looks inside it.
  // undefined when an existing part cannot be resolved (fail-closed).
  canonical(path: string, fs: GuardFs, stop?: (path: string) => boolean): string | undefined {
    const normal = this.normal(path);
    const root = this.paths.parse(normal).root;
    const segments = normal
      .slice(root.length)
      .split(/[\\/]+/)
      .filter((part) => part !== "");
    let current = this.real(root, fs) ?? root;
    for (let i = 0; i < segments.length; i++) {
      const next = this.paths.join(current, segments[i] ?? "");
      const real = this.real(next, fs);
      if (real === null) return undefined;
      if (real === undefined) return this.paths.join(next, ...segments.slice(i + 1));
      current = real;
      if (stop?.(current) === true) return current;
    }
    return current;
  }

  // The real path; undefined when nothing is there, null when something is there and cannot be resolved (a link that
  // points nowhere, a file where a directory goes, a permission error).
  private real(path: string, fs: GuardFs): string | undefined | null {
    try {
      return this.normal(fs.realpath(path));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      return fs.exists(path) ? null : undefined;
    }
  }
}

export function checkEngramDataDir(input: EngramDataDirInput): EngramDataDirCheck {
  const platform = input.platform ?? process.platform;
  return checkOwned(input, engramDataDirOf(input.harilDataDir, platform), false);
}

// The same checks for the child's home, which also must not be, or hold, the user's home with its ~/.engram.
export function checkEngramHome(input: EngramDataDirInput): EngramDataDirCheck {
  const platform = input.platform ?? process.platform;
  return checkOwned(input, engramHomeOf(input.harilDataDir, platform), true);
}

function checkOwned(
  input: EngramDataDirInput,
  ownedPath: string,
  isHome: boolean,
): EngramDataDirCheck {
  const platform = input.platform ?? process.platform;
  const rules = new PathRules(platform);
  const fs = input.fs ?? nodeGuardFs;
  const candidate = input.candidate;
  if (candidate.trim() === "") {
    return refused("empty", "ENGRAM_DATA_DIR is empty: Engram would fall back to ~/.engram");
  }
  if (rules.notLocal(candidate)) {
    return refused("not_local", `${candidate} is a UNC, device, extended-length or WSL path`);
  }
  if (!rules.absolute(candidate))
    return refused("relative", `${candidate} is not an absolute path`);
  if (rules.ambiguous(candidate)) {
    return refused(
      "ambiguous_name",
      `${candidate} has a segment Win32 would rename or read as a device`,
    );
  }
  for (const name of ONEDRIVE_VARIABLES) {
    const oneDrive = input.env[name];
    if (oneDrive !== undefined && oneDrive.trim() !== "" && rules.within(candidate, oneDrive)) {
      return refused("not_local", `${candidate} is inside ${name} (${oneDrive})`);
    }
  }
  const userEngram = pathsOf(platform).join(input.homeDir, ".engram");
  const inUserEngram = (path: string): boolean => rules.within(path, userEngram);
  // Lexically first, so a path inside ~/.engram is refused without any look at the disk.
  if (inUserEngram(candidate)) {
    return refused("user_engram", `${candidate} is the user's ~/.engram or inside it`);
  }
  const realUserEngram = rules.canonical(userEngram, fs);
  const intoUserEngram = (path: string): boolean =>
    inUserEngram(path) || (realUserEngram !== undefined && rules.within(path, realUserEngram));
  const real = rules.canonical(candidate, fs, intoUserEngram);
  if (real === undefined) return refused("unresolvable", `${candidate} cannot be resolved`);
  if (intoUserEngram(real)) {
    return refused("user_engram", `${candidate} resolves to the user's ~/.engram (${real})`);
  }
  if (
    isHome &&
    (rules.within(userEngram, real) ||
      (realUserEngram !== undefined && rules.within(realUserEngram, real)))
  ) {
    return refused("user_engram", `${candidate} would hold the user's ~/.engram (${real})`);
  }
  const owned = rules.canonical(ownedPath, fs, intoUserEngram);
  if (owned === undefined || intoUserEngram(owned)) {
    return refused("user_engram", "HARIL's data dir resolves into the user's ~/.engram");
  }
  if (!rules.same(real, owned)) {
    return refused("not_owned", `${candidate} is not HARIL's own ${owned}`);
  }
  return { ok: true, dataDir: real };
}

// Binds 127.0.0.1 only, as `engram serve` does (06 sec3.2), and releases the port at once.
export const loopbackPortProbe: PortProbe = {
  isFree: (port) =>
    new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    }),
};

export async function checkEngramPort(
  port: number,
  probe: PortProbe = loopbackPortProbe,
): Promise<EngramPortCheck> {
  const problem = portProblem(port);
  if (problem === "invalid") {
    return { ok: false, reason: "invalid", message: `${port} is not a port from 1 to 65535` };
  }
  if (problem === "reserved") {
    return {
      ok: false,
      reason: "reserved",
      message: `${port} is reserved (7437 is the user's Engram)`,
    };
  }
  if (!(await probe.isFree(port))) {
    return { ok: false, reason: "in_use", message: `127.0.0.1:${port} is already in use` };
  }
  return { ok: true, port };
}

// A free loopback port the operating system hands out, never a reserved one. Between this choice and the bind of
// `engram serve` another process may take it: the identity check after the launch catches that (ADR-0008 Q11).
export async function pickEngramPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
        const address = server.address();
        const chosen = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (portProblem(port) === undefined) return port;
  }
}
