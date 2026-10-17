import type { ControlClient } from "@haril/control";

// The live feed of the shell (LD-T2, INTERFACE 5.1). While a runtime is active the shell holds one subscription to the
// control channel. A wake reloads the store, at most once per RELOAD_INTERVAL_MS: the first wake reloads at once, and
// a burst that follows waits for the interval and reloads once more. The pipe only wakes; nothing here polls. The
// timers are that wait and the few bounded retries of one subscription (LD-T6), never a recurring one.

export const RELOAD_INTERVAL_MS = 250;

// Opens a control client (the real one in production). Resolves to undefined when no runtime answers.
export type ConnectControl = (
  dataDir: string,
  options: { readonly subscribe: boolean },
) => Promise<ControlClient | undefined>;

export interface LiveFeedOptions {
  readonly dataDir: string;
  readonly connect: ConnectControl;
  // Re-reads the store. Called at most once per RELOAD_INTERVAL_MS while wakes arrive.
  readonly reload: () => void;
  // Called when the subscription opens or ends, so the screen shows it.
  readonly onChange: () => void;
}

export interface LiveFeed {
  // True while a subscription is open.
  readonly subscribed: boolean;
  // Opens a subscription unless one is open or being opened, and resolves whether one is open. When no runtime answers
  // it tries again after each of `retryDelaysMs`, then gives up (LD-T6: a runtime the shell just started opens its
  // channel only once it holds the lease). A call while an attempt runs joins that attempt.
  subscribe(retryDelaysMs?: readonly number[]): Promise<boolean>;
  // Ends the retries of the attempt that runs, if any: it resolves false once its current try returns, and the next
  // subscribe starts afresh (LD-T6: the runtime the shell started exited, so nothing is left to wait for).
  stopRetrying(): void;
  // Ends the subscription and cancels a reload or a retry still waiting. The feed does not open again after this.
  close(): void;
}

export function createLiveFeed(options: LiveFeedOptions): LiveFeed {
  let client: ControlClient | undefined;
  let attempt: Promise<boolean> | undefined;
  let closed = false;
  let lastReload = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | undefined;
  // The wait before the next retry, so close() can end it.
  let retry:
    | { readonly timer: ReturnType<typeof setTimeout>; readonly done: () => void }
    | undefined;
  // Set by stopRetrying for the attempt that runs.
  let stopping = false;
  const endRetryWait = (): void => {
    if (retry === undefined) return;
    clearTimeout(retry.timer);
    retry.done();
  };

  const reloadNow = (): void => {
    lastReload = Date.now();
    options.reload();
  };

  const onWake = (): void => {
    // A reload already waits for the interval and will read the newest rows: a further wake adds nothing.
    if (closed || pending !== undefined) return;
    const wait = lastReload + RELOAD_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      reloadNow();
      return;
    }
    pending = setTimeout(() => {
      pending = undefined;
      if (!closed) reloadNow();
    }, wait);
  };

  const adopt = (next: ControlClient): void => {
    client = next;
    next.onWake(onWake);
    next.onClose(() => {
      if (client !== next) return;
      client = undefined;
      options.onChange();
    });
    options.onChange();
  };

  // One wait of a bounded retry: a single timer, never a recurring one.
  const waitForRetry = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        retry = undefined;
        resolve();
      };
      retry = { timer: setTimeout(done, ms), done };
    });

  const connectWithRetries = async (retryDelaysMs: readonly number[]): Promise<boolean> => {
    for (let index = 0; ; index++) {
      const next = await options
        .connect(options.dataDir, { subscribe: true })
        .catch(() => undefined);
      if (closed) {
        next?.close();
        return false;
      }
      if (next !== undefined) {
        adopt(next);
        return true;
      }
      const delay = retryDelaysMs[index];
      if (delay === undefined || stopping) return false;
      await waitForRetry(delay);
      if (closed || stopping) return false;
    }
  };

  return {
    get subscribed() {
      return client !== undefined;
    },

    subscribe(retryDelaysMs = []): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (client !== undefined) return Promise.resolve(true);
      if (attempt === undefined) {
        stopping = false;
        attempt = connectWithRetries(retryDelaysMs).finally(() => {
          attempt = undefined;
        });
      }
      return attempt;
    },

    stopRetrying(): void {
      if (attempt === undefined) return;
      stopping = true;
      endRetryWait();
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
      }
      endRetryWait();
      const current = client;
      client = undefined;
      current?.close();
    },
  };
}
