import { posix, win32 } from "node:path";
import type { EnsureFs } from "./fs.js";

// Path rules for the install: HARIL's own folders are compared with the rules of the platform it runs on, so a
// Windows path is judged case-insensitively and a POSIX one is not, whatever the machine running a test.

export type PathOps = typeof win32;

export function pathOps(platform: string): PathOps {
  return platform === "win32" ? win32 : posix;
}

// `child` is a path strictly below `parent`.
export function isInside(child: string, parent: string, platform: string): boolean {
  const ops = pathOps(platform);
  if (!ops.isAbsolute(child) || !ops.isAbsolute(parent)) return false;
  const relative = ops.relative(parent, child);
  if (relative === "" || ops.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${ops.sep}`);
}

// The folder directly below `parent` that holds `child`, or undefined when it is not below it.
export function firstFolderBelow(
  child: string,
  parent: string,
  platform: string,
): string | undefined {
  if (!isInside(child, parent, platform)) return undefined;
  const ops = pathOps(platform);
  const [first, second] = ops.relative(parent, child).split(ops.sep);
  // A file placed directly in the parent has no folder.
  return second === undefined ? undefined : first;
}

// A path with every existing ancestor resolved, so a junction cannot lead an install into the user's ~/.engram.
function canonicalPath(path: string, fs: EnsureFs, platform: string): string {
  const ops = pathOps(platform);
  if (fs.exists(path)) {
    try {
      return fs.realpath(path);
    } catch {
      return ops.resolve(path);
    }
  }
  const parent = ops.dirname(path);
  return parent === path ? path : ops.join(canonicalPath(parent, fs, platform), ops.basename(path));
}

// The refusal for a path that is, or is inside, the user's own ~/.engram; undefined when it is fine.
export function userEngramProblem(
  paths: readonly string[],
  homeDir: string,
  fs: EnsureFs,
  platform: string,
): string | undefined {
  // Without a known home there is no ~/.engram to protect.
  if (homeDir === "") return undefined;
  const ops = pathOps(platform);
  const fold = (path: string) =>
    platform === "win32" ? ops.resolve(path).toLowerCase() : ops.resolve(path);
  const userMemory = fold(canonicalPath(ops.join(homeDir, ".engram"), fs, platform));
  for (const path of paths) {
    const target = fold(canonicalPath(path, fs, platform));
    if (target === userMemory || target.startsWith(`${userMemory}${ops.sep}`)) {
      return `Refusing to change the user's ~/.engram: ${path}`;
    }
  }
  return undefined;
}
