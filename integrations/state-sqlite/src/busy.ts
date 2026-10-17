import { StoreError } from "./errors.js";

// ARCH 8.4: a busy database is retried with a short, bounded backoff. The busy timeout of each attempt stays at 200 ms
// (ST-01). Used for the open and for taking the write lock of a transaction, where nothing has run yet and a retry is
// safe. The wait is synchronous, so it blocks the caller's event loop; two bounds keep that block short:
// - Stalled: about 2 s without a commit by anyone else. A holder that never commits (a stuck process) fails the caller
//   with its error after 2 s, as before.
// - Contended: other writers keep committing. SQLite's write lock has no queue, so a waiter seldom lands in the gap
//   between a busy writer's commit and its next BEGIN IMMEDIATE, and the wait lasts the whole burst, not one commit
//   (INV-01 on a loaded Windows runner). Each commit seen by `progress` restarts the 2 s, up to 10 s in all: a third of
//   the runtime's 30 s lease, so a runtime blocked here still renews its lease (heartbeat every 10 s).
const BUSY_STALL_BUDGET_MS = 2000;
const BUSY_CONTENDED_BUDGET_MS = 10_000;
const BUSY_BACKOFF_START_MS = 10;
const BUSY_BACKOFF_CAP_MS = 250;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

// `progress` returns a value that changes whenever another connection commits (PRAGMA data_version), or undefined
// when it cannot tell. It is read only after a busy attempt, so an uncontended call costs nothing extra.
export function withBusyRetry<T>(attempt: () => T, progress?: () => number | undefined): T {
  const start = Date.now();
  const cap = start + BUSY_CONTENDED_BUDGET_MS;
  let deadline = start + BUSY_STALL_BUDGET_MS;
  let seen: number | undefined;
  let delay = BUSY_BACKOFF_START_MS;
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (!isBusy(error)) throw error;
      const version = progress?.();
      if (version !== undefined) {
        if (seen !== undefined && version !== seen) {
          deadline = Math.min(Date.now() + BUSY_STALL_BUDGET_MS, cap);
        }
        seen = version;
      }
      if (Date.now() + delay > deadline) throw error;
      // Synchronous wait: the store API is synchronous and runs on the main thread.
      Atomics.wait(sleepCell, 0, 0, delay);
      delay = Math.min(delay * 2, BUSY_BACKOFF_CAP_MS);
    }
  }
}

const BUSY_MESSAGE = /database is locked|SQLITE_BUSY/;

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (BUSY_MESSAGE.test(error.message)) return true;
  // A migration failure wraps the driver message in its details.
  return error instanceof StoreError && BUSY_MESSAGE.test(String(error.details.cause ?? ""));
}
