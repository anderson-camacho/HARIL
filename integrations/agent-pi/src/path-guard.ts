// PathGuard for bridge reads and acceptance checks. It is the MVP permission decision in N0, kept as defense in
// depth: the agent is read-only and its shell is denied by the launch flags, so the file path is the capability
// that matters. N1 (M4) adds the real process boundary; no policy engine lives here (MC-D4).
//
// Passes, in order, all before any content is read:
//   1. lexical: stays under the root; no UNC, device, drive-relative or alternate-stream forms;
//   2. names and deny-list: reserved Windows device names, Windows short names (a tilde and a digit), a segment ending
//      in a dot or a space, and entries that are never read (.git, .haril, .pi, .env and .env.*);
//   3. links: every existing component below the root is lstat-ed; a symbolic link or a junction is refused,
//      never followed, and its real name must be the name asked for (no short-name alias); then the deepest existing
//      ancestor is realpath-ed and must sit inside the canonical root.
// The identity of the file that is finally opened is checked by read-guarded.ts (dev and ino).

import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export type PathGuardResult =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: string };

export type PathGuard = (requested: string) => PathGuardResult;

// The filesystem questions the guard asks. Sync on purpose: the acceptance reader is a synchronous port.
export interface GuardFs {
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  realpath(path: string): string;
}

export const nodeGuardFs: GuardFs = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
};

const UNC_OR_DEVICE = /^[\\/]{2}/;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A Windows 8.3 short name ("GIT~1"): NTFS may resolve it to any long name, .git included.
const SHORT_NAME = /~\d/;
const DENIED_DIRECTORIES = new Set([".git", ".haril", ".pi"]);
const ENV_FILE = /^\.env(\..+)?$/i;

export function createPathGuard(projectRoot: string, fs: GuardFs = nodeGuardFs): PathGuard {
  const root = resolve(projectRoot);
  return (requested) => {
    if (typeof requested !== "string" || requested.length === 0) return deny("empty_path");
    if (requested.includes("\0")) return deny("nul_byte");
    if (UNC_OR_DEVICE.test(requested)) return deny("unc_or_device_path");
    if (requested.includes(":") && !DRIVE_ABSOLUTE.test(requested)) return deny("drive_or_stream");

    const absolutePath = resolve(root, requested);
    const rel = relative(root, absolutePath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return deny("outside_root");
    }

    const segments = rel.split(sep);
    for (const segment of segments) {
      const problem = segmentProblem(segment);
      if (problem !== undefined) return deny(problem);
    }

    return checkLinks(root, segments, fs) ?? { ok: true, absolutePath };
  };
}

function segmentProblem(segment: string): string | undefined {
  if (SHORT_NAME.test(segment)) return "short_name";
  if (/[. ]$/.test(segment)) return "trailing_dot_or_space";
  if (RESERVED_NAME.test(segment.split(/[.\s]/)[0] ?? "")) return "reserved_name";
  if (DENIED_DIRECTORIES.has(segment.toLowerCase()) || ENV_FILE.test(segment)) return "denied_path";
  return undefined;
}

// Returns a denial when a link is on the way or the real location leaves the canonical root; undefined otherwise.
function checkLinks(
  root: string,
  segments: readonly string[],
  fs: GuardFs,
): PathGuardResult | undefined {
  let deepest = root;
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (fs.lstat(current).isSymbolicLink()) return deny("link");
      // The name the filesystem keeps must be the one asked for: a short name ("GIT~1") or another alias resolves to
      // a different real name and is refused.
      if (!sameName(basename(fs.realpath(current)), segment)) return deny("alias");
    } catch (error) {
      if (isMissing(error)) break;
      return deny("unreadable");
    }
    deepest = current;
  }

  const canonicalRoot = canonicalOrNull(root, fs);
  if (canonicalRoot === "unreadable") return deny("unreadable");
  const canonicalDeepest = canonicalOrNull(deepest, fs);
  if (canonicalDeepest === "unreadable") return deny("unreadable");
  if (canonicalRoot === undefined || canonicalDeepest === undefined) return undefined;
  return isInside(canonicalRoot, canonicalDeepest) ? undefined : deny("outside_root");
}

// The canonical path, undefined while the path does not exist, "unreadable" for any other failure.
function canonicalOrNull(path: string, fs: GuardFs): string | undefined | "unreadable" {
  try {
    return fs.realpath(path);
  } catch (error) {
    return isMissing(error) ? undefined : "unreadable";
  }
}

// Windows paths are case-insensitive; POSIX paths are compared as they are.
function isInside(base: string, target: string): boolean {
  const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const rel = relative(fold(base), fold(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Two names of one component: the same text, without regard to case or Unicode normalization.
function sameName(real: string, asked: string): boolean {
  const fold = (name: string) => name.normalize("NFC").toLowerCase();
  return fold(real) === fold(asked);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function deny(reason: string): PathGuardResult {
  return { ok: false, reason };
}
