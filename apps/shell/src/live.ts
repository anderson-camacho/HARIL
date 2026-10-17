import type { ControlClient } from "@haril/control";

// The live feed of the shell (LD-T2, INTERFACE 5.1). While a runtime is active the shell holds one subscription to the
// control channel. A wake reloads the store, at most once per RELOAD_INTERVAL_MS: the first wake reloads at once, and
// a burst that follows waits for the interval and reloads once more. The pipe only wakes; nothing here polls, and the
// one timer is that wait.

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
  // Opens a subscription unless one is open or being opened.
  subscribe(): void;
  // Ends the subscription and cancels a reload still waiting. The feed does not open again after this.
  close(): void;
}

export function createLiveFeed(options: LiveFeedOptions): LiveFeed {
  let client: ControlClient | undefined;
  let connecting = false;
  let closed = false;
  let lastReload = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | undefined;

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

  return {
    get subscribed() {
      return client !== undefined;
    },

    subscribe(): void {
      if (closed || client !== undefined || connecting) return;
      connecting = true;
      options.connect(options.dataDir, { subscribe: true }).then(
        (next) => {
          connecting = false;
          if (closed || next === undefined) {
            next?.close();
            return;
          }
          client = next;
          next.onWake(onWake);
          next.onClose(() => {
            if (client !== next) return;
            client = undefined;
            options.onChange();
          });
          options.onChange();
        },
        () => {
          connecting = false;
        },
      );
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
      }
      const current = client;
      client = undefined;
      current?.close();
    },
  };
}
