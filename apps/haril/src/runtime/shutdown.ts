// Ordered stop of the runtime (ARCH 4.2): one shutdown per runtime, requested by an applied `runtime.stop` command or by
// a signal (Ctrl+C, SIGTERM). The first request wins; a listener added after it is called at once.

// The command type `haril stop` enqueues. The store accepts it without a project and the runtime acts on it.
export const RUNTIME_STOP = "runtime.stop";

type ShutdownReason = "command" | "signal";

export interface Shutdown {
  readonly requested: boolean;
  readonly reason: ShutdownReason | undefined;
  request(reason: ShutdownReason): void;
  // Returns the function that removes the listener. The listener runs once.
  onRequest(listener: (reason: ShutdownReason) => void): () => void;
}

export function createShutdown(): Shutdown {
  let reason: ShutdownReason | undefined;
  const listeners = new Set<(reason: ShutdownReason) => void>();
  return {
    get requested() {
      return reason !== undefined;
    },
    get reason() {
      return reason;
    },
    request(next) {
      if (reason !== undefined) return;
      reason = next;
      for (const listener of [...listeners]) listener(next);
    },
    onRequest(listener) {
      if (reason !== undefined) {
        listener(reason);
        return () => undefined;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// The signals of a terminal. process satisfies this shape; tests inject an EventEmitter.
type StopSignal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

// A second signal exits at once with this code (128 + SIGINT). The lease is then left for the next start to take
// over by pid, the same as a crash (ARCH 7.5).
const FORCED_EXIT_CODE = 130;

// The first signal asks for the ordered stop; every later one exits at once. Returns the function that detaches both.
export function attachStopSignals(
  source: SignalSource,
  shutdown: Shutdown,
  forceExit: (code: number) => void,
): () => void {
  const signals: StopSignal[] = ["SIGINT", "SIGTERM"];
  let received = 0;
  const onSignal = (): void => {
    received += 1;
    if (received === 1) {
      shutdown.request("signal");
      return;
    }
    forceExit(FORCED_EXIT_CODE);
  };
  for (const signal of signals) source.on(signal, onSignal);
  return () => {
    for (const signal of signals) source.off(signal, onSignal);
  };
}
