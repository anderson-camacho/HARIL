// Lexical PathGuard for bridge file operations. It resolves a requested path against the project root and
// denies anything that leaves the root, including UNC and device paths, drive-relative paths and NTFS
// alternate streams. It does not resolve symlinks: a symlink inside the root can still point outside it.

import { isAbsolute, relative, resolve, sep } from "node:path";

export type PathGuardResult =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: string };

export type PathGuard = (requested: string) => PathGuardResult;

const UNC_OR_DEVICE = /^[\\/]{2}/;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

export function createPathGuard(projectRoot: string): PathGuard {
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
    return { ok: true, absolutePath };
  };
}

function deny(reason: string): PathGuardResult {
  return { ok: false, reason };
}
