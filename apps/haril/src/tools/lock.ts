import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { EnsureFs } from "./fs.js";
import { errorCode, errorText } from "./fs.js";

// <runtime root>/state/tools.lock: created exclusively (`wx`), so two consoles that start together do not both install;
// the one that loses is told it is busy at once, and never waits. A lock whose file has not been touched for 15
// minutes is the leftover of a process that died, and is taken over. The file's content is only for a person reading it.

const LOCK_STALE_MS = 15 * 60_000;

export type LockResult =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly busy: true }
  | { readonly ok: false; readonly busy: false; readonly message: string };

export function acquireLock(path: string, now: () => number, fs: EnsureFs): LockResult {
  try {
    fs.mkdir(dirname(path));
  } catch (error) {
    return { ok: false, busy: false, message: `cannot use the state folder: ${errorText(error)}` };
  }
  const token = randomBytes(8).toString("hex");
  const payload = JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() });
  const release = (): void => {
    // Only the holder's own lock goes: after a takeover the file belongs to someone else.
    try {
      if (JSON.parse(fs.readText(path)).token === token) fs.remove(path);
    } catch {
      // Already gone, or replaced by a lock this process cannot read: either way it is not ours to delete.
    }
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeNew(path, payload, 0o600);
      return { ok: true, release };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        return {
          ok: false,
          busy: false,
          message: `cannot take the tools lock: ${errorText(error)}`,
        };
      }
    }
    if (!isStale(path, now, fs)) return { ok: false, busy: true };
    try {
      fs.remove(path);
    } catch {
      return { ok: false, busy: true };
    }
  }
  return { ok: false, busy: true };
}

// A lock that vanished while it was being looked at is free, so the caller tries to take it again.
function isStale(path: string, now: () => number, fs: EnsureFs): boolean {
  try {
    return now() - fs.stat(path).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true;
  }
}
