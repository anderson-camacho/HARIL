// Reads a file that PathGuard already allowed, and proves it is the same file at open time. The path check
// happens before the open, so a file can be swapped in between; lstat (the path) and fstat (the open handle)
// must agree on dev and ino, and only the handle is read. A link seen at lstat time is refused.

import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat as lstatAsync, open as openAsync } from "node:fs/promises";

export type GuardedReadDenial =
  | "missing"
  | "not_a_file"
  | "link"
  | "identity_changed"
  | "too_large"
  | "unreadable";

export type GuardedRead =
  | { readonly ok: true; readonly content: Buffer }
  | { readonly ok: false; readonly reason: GuardedReadDenial };

export interface IdentityStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReadHandle {
  stat(): Promise<IdentityStats>;
  readFile(): Promise<Buffer>;
  close(): Promise<void>;
}

// The async port used by the bridge. The default is node:fs/promises; tests inject a fake.
export interface ReadFsPort {
  lstat(path: string): Promise<IdentityStats>;
  open(path: string): Promise<ReadHandle>;
}

const nodeReadFs: ReadFsPort = {
  lstat: (path) => lstatAsync(path, { bigint: true }),
  open: async (path) => {
    const handle = await openAsync(path, "r");
    return {
      stat: () => handle.stat({ bigint: true }),
      readFile: () => handle.readFile(),
      close: () => handle.close(),
    };
  },
};

export async function readGuardedFile(
  absolutePath: string,
  options: { readonly maxBytes?: number; readonly fs?: ReadFsPort } = {},
): Promise<GuardedRead> {
  const port = options.fs ?? nodeReadFs;
  let linked: IdentityStats;
  try {
    linked = await port.lstat(absolutePath);
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing" : "unreadable" };
  }
  const kind = classify(linked);
  if (kind !== undefined) return { ok: false, reason: kind };

  let handle: ReadHandle;
  try {
    handle = await port.open(absolutePath);
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing" : "unreadable" };
  }
  try {
    const opened = await handle.stat();
    if (!sameFile(linked, opened)) return { ok: false, reason: "identity_changed" };
    if (!opened.isFile()) return { ok: false, reason: "not_a_file" };
    if (exceeds(opened.size, options.maxBytes)) return { ok: false, reason: "too_large" };
    const content = await handle.readFile();
    if (exceeds(BigInt(content.length), options.maxBytes))
      return { ok: false, reason: "too_large" };
    return { ok: true, content };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// The synchronous variant for the acceptance reader, whose port is synchronous.
export function readGuardedFileSync(
  absolutePath: string,
  options: { readonly maxBytes?: number } = {},
): GuardedRead {
  let linked: IdentityStats;
  try {
    linked = lstatSync(absolutePath, { bigint: true });
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing" : "unreadable" };
  }
  const kind = classify(linked);
  if (kind !== undefined) return { ok: false, reason: kind };

  let fd: number;
  try {
    fd = openSync(absolutePath, "r");
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing" : "unreadable" };
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(linked, opened)) return { ok: false, reason: "identity_changed" };
    if (!opened.isFile()) return { ok: false, reason: "not_a_file" };
    if (exceeds(opened.size, options.maxBytes)) return { ok: false, reason: "too_large" };
    const content = readFileSync(fd);
    if (exceeds(BigInt(content.length), options.maxBytes))
      return { ok: false, reason: "too_large" };
    return { ok: true, content };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function classify(stats: IdentityStats): GuardedReadDenial | undefined {
  if (stats.isSymbolicLink()) return "link";
  if (!stats.isFile()) return "not_a_file";
  return undefined;
}

function sameFile(a: IdentityStats, b: IdentityStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function exceeds(size: bigint, maxBytes: number | undefined): boolean {
  return maxBytes !== undefined && size > BigInt(maxBytes);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
