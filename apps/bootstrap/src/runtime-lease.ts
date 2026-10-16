import { DatabaseSync } from "node:sqlite";
import type { FsPort } from "./ports.js";
import { messageOf } from "./text.js";

// Criterion 15 (M3-T6b): uninstall must not remove HARIL under a running runtime. The check reads haril.db
// read-only; a runtime is active when a lease is `active`, unexpired and its pid is alive.

export type RuntimeCheck =
  | { readonly state: "none" }
  | { readonly state: "active"; readonly pid: number }
  | { readonly state: "unknown"; readonly reason: string };

export interface RuntimeCheckInput {
  readonly dbPath: string;
  readonly fs: FsPort;
  readonly now: number;
  readonly isAlive: (pid: number) => boolean;
}

export async function checkActiveRuntime(input: RuntimeCheckInput): Promise<RuntimeCheck> {
  if (!(await input.fs.exists(input.dbPath))) return { state: "none" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(input.dbPath, { readOnly: true });
    const leases = db
      .prepare("SELECT pid FROM runtime_leases WHERE status = 'active' AND expires_at > ?")
      .all(input.now) as { pid: number }[];
    const live = leases.find((lease) => input.isAlive(lease.pid));
    return live === undefined ? { state: "none" } : { state: "active", pid: live.pid };
  } catch (error) {
    // A store that never created the lease table has no runtime; anything else is not known to be idle.
    if (/no such table: runtime_leases/.test(messageOf(error))) return { state: "none" };
    return { state: "unknown", reason: messageOf(error) };
  } finally {
    db?.close();
  }
}

// Liveness of a process. EPERM means it exists but belongs to another user.
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
