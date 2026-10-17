import { StoreError } from "./errors.js";

// ARCH 8.4: a busy database is retried with a short, bounded backoff. The busy timeout of each attempt stays at 200 ms
// (ST-01); the whole retry budget is about 2 s, so a lock held longer than that still fails with its error. Used for
// the open and for taking the write lock of a transaction, where nothing has run yet and a retry is safe.
const BUSY_RETRY_BUDGET_MS = 2000;
const BUSY_BACKOFF_START_MS = 10;
const BUSY_BACKOFF_CAP_MS = 250;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function withBusyRetry<T>(attempt: () => T): T {
  const deadline = Date.now() + BUSY_RETRY_BUDGET_MS;
  let delay = BUSY_BACKOFF_START_MS;
  for (;;) {
    try {
      return attempt();
    } catch (error) {
      if (!isBusy(error) || Date.now() + delay > deadline) throw error;
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
