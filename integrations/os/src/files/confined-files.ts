import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";

// The filesystem half of the workspace PathGuard (docs/modos-y-delegacion.md 3.10.5 and section 8; phase F8). The host
// writes an agent's file only after the Core's lexical check (checkWorkspacePath) accepted its path; this module then
// proves, on the filesystem, that the write lands inside the worktree:
//   1. every existing component below the root is lstat-ed: a symbolic link or a junction is refused, never followed,
//      a component that is not a folder is refused, and its real name must be the name asked for (a Windows short name
//      such as GIT~1, or any other alias, opens a component whose real name differs);
//   2. a missing folder is created one level at a time and lstat-ed again after its creation;
//   3. the real location of the file's folder must sit inside the canonical root;
//   4. an existing file must be a plain file with its own name and no other hard link (a hard link to a file outside the
//      worktree would change that file too): it is opened without truncation, the handle's identity (dev and ino) must
//      be the one the lstat saw (a file swapped for a link in between fails here), and only then is it truncated and
//      written through the handle; a new file is created exclusively, so nothing that appeared meanwhile is followed.
// N0 (3.10.6): there is no sandbox. A program the allow list runs could still swap a folder for a link between these
// checks and the write; the checks close every path an agent's own tools can open.

export type ConfinedFileDenial =
  | "outside_root"
  | "link"
  | "not_a_directory"
  | "not_a_file"
  | "identity_changed"
  | "missing"
  | "too_large"
  | "alias"
  | "hard_link"
  | "unreadable";

export type ConfinedWrite =
  | { readonly ok: true; readonly created: boolean; readonly bytes: number }
  | { readonly ok: false; readonly reason: ConfinedFileDenial };

export type ConfinedRead =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: ConfinedFileDenial };

type Walk =
  | { readonly ok: true; readonly folder: string; readonly name: string }
  | { readonly ok: false; readonly reason: ConfinedFileDenial };

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
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

// Whether the component at `path` keeps the name that was asked for. On Windows a short name ("GIT~1") or another alias
// opens a component whose real name differs (realpath answers the final path, as the handle sees it); that is refused.
async function keepsName(path: string, asked: string): Promise<boolean | "error"> {
  try {
    return sameName(basename(await realpath(path)), asked);
  } catch {
    return "error";
  }
}

function segmentsOf(relativePath: string): string[] | null {
  if (isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) return null;
  const segments = relativePath.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

// Walks the folders of `relativePath` under `root`, refusing links and non-folders; with `create`, a missing folder is
// made one level at a time. Answers the real folder of the file and the file's name.
async function walk(root: string, relativePath: string, create: boolean): Promise<Walk> {
  const segments = segmentsOf(relativePath);
  if (segments === null) return { ok: false, reason: "outside_root" };
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let stats = await lstatOrUndefined(current);
    if (stats === "error") return { ok: false, reason: "unreadable" };
    if (stats === "not_a_directory") return { ok: false, reason: "not_a_directory" };
    if (stats === undefined) {
      if (!create) return { ok: false, reason: "missing" };
      try {
        await mkdir(current);
      } catch (error) {
        if (code(error) !== "EEXIST") return { ok: false, reason: "unreadable" };
      }
      stats = await lstatOrUndefined(current);
      if (stats === undefined || stats === "error") return { ok: false, reason: "unreadable" };
      if (stats === "not_a_directory") return { ok: false, reason: "not_a_directory" };
    }
    if (stats.isSymbolicLink()) return { ok: false, reason: "link" };
    if (!stats.isDirectory()) return { ok: false, reason: "not_a_directory" };
    const named = await keepsName(current, segment);
    if (named === "error") return { ok: false, reason: "unreadable" };
    if (!named) return { ok: false, reason: "alias" };
  }
  let canonicalFolder: string;
  try {
    canonicalFolder = await realpath(current);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!isInside(canonicalRoot, canonicalFolder)) return { ok: false, reason: "outside_root" };
  return { ok: true, folder: current, name: segments[segments.length - 1] as string };
}

async function lstatOrUndefined(
  path: string,
): Promise<BigIntStats | undefined | "error" | "not_a_directory"> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (code(error) === "ENOENT") return undefined;
    if (code(error) === "ENOTDIR") return "not_a_directory";
    return "error";
  }
}

// Writes `content` as UTF-8 to `relativePath` under `root`, creating missing folders. The path was already checked by
// the lexical PathGuard; this refuses what the filesystem shows would leave the root.
export async function writeConfinedFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<ConfinedWrite> {
  const place = await walk(root, relativePath, true);
  if (!place.ok) return place;
  const target = join(place.folder, place.name);
  const bytes = Buffer.from(content, "utf8");
  const existing = await lstatOrUndefined(target);
  if (existing === "error") return { ok: false, reason: "unreadable" };
  if (existing === "not_a_directory") return { ok: false, reason: "not_a_directory" };
  if (existing === undefined) {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, "wx");
    } catch (error) {
      // Something appeared at the path between the check and the creation: it is not followed.
      return { ok: false, reason: code(error) === "EEXIST" ? "identity_changed" : "unreadable" };
    }
    try {
      await handle.writeFile(bytes);
    } catch {
      return { ok: false, reason: "unreadable" };
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { ok: true, created: true, bytes: bytes.length };
  }
  if (existing.isSymbolicLink()) return { ok: false, reason: "link" };
  if (!existing.isFile()) return { ok: false, reason: "not_a_file" };
  // A file with another hard link may be a file outside the worktree: writing it would change that file too.
  if (existing.nlink > 1n) return { ok: false, reason: "hard_link" };
  const named = await keepsName(target, place.name);
  if (named === "error") return { ok: false, reason: "unreadable" };
  if (!named) return { ok: false, reason: "alias" };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, "r+");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== existing.dev || opened.ino !== existing.ino || !opened.isFile()) {
      return { ok: false, reason: "identity_changed" };
    }
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
    return { ok: true, created: false, bytes: bytes.length };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// Reads `relativePath` under `root` as UTF-8, refusing links on the way, a swapped file and a file over `maxBytes`.
export async function readConfinedFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<ConfinedRead> {
  const place = await walk(root, relativePath, false);
  if (!place.ok) return place;
  const target = join(place.folder, place.name);
  const linked = await lstatOrUndefined(target);
  if (linked === undefined || linked === "not_a_directory") return { ok: false, reason: "missing" };
  if (linked === "error") return { ok: false, reason: "unreadable" };
  if (linked.isSymbolicLink()) return { ok: false, reason: "link" };
  if (!linked.isFile()) return { ok: false, reason: "not_a_file" };
  const named = await keepsName(target, place.name);
  if (named === "error") return { ok: false, reason: "unreadable" };
  if (!named) return { ok: false, reason: "alias" };
  if (linked.size > BigInt(maxBytes)) return { ok: false, reason: "too_large" };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target, "r");
  } catch (error) {
    return { ok: false, reason: code(error) === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
      return { ok: false, reason: "identity_changed" };
    }
    if (opened.size > BigInt(maxBytes)) return { ok: false, reason: "too_large" };
    const content = await handle.readFile();
    if (content.length > maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, content: content.toString("utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
