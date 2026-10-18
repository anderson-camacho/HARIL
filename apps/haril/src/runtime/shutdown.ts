// Ordered stop of the runtime (ARCH 4.2): one shutdown per runtime, requested by an applied `runtime.stop` command or by
// a signal (Ctrl+C, SIGTERM). The first request wins; a listener added after it is called at once. An applied
// `runtime.stop {mode: "now"}` requests it as an emergency (docs/modos-y-delegacion.md 3.14): the attempts in flight
// are killed instead of aborted, without the grace period.

// The command type `haril stop` enqueues. The store accepts it without a project and the runtime acts on it.
export const RUNTIME_STOP = "runtime.stop";

type ShutdownReason = "command" | "signal" | "emergency";

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

// The kills of the attempts in flight (3.14), for an exit that cannot wait for the ordered stop: a second signal. The
// run loop registers each attempt once its agent started and removes it when the attempt ends.
export interface KillSwitch {
  readonly size: number;
  register(runId: string, kill: () => Promise<void>): () => void;
  // Kills every registered attempt's process tree; resolves once every kill finished.
  killAll(): Promise<void>;
}

export function createKillSwitch(): KillSwitch {
  const kills = new Map<string, () => Promise<void>>();
  return {
    get size() {
      return kills.size;
    },
    register(runId, kill) {
      kills.set(runId, kill);
      return () => {
        if (kills.get(runId) === kill) kills.delete(runId);
      };
    },
    async killAll() {
      await Promise.all([...kills.values()].map((kill) => kill().catch(() => undefined)));
    },
  };
}

// The signals of a terminal. process satisfies this shape; tests inject an EventEmitter.
type StopSignal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

// A second signal exits with this code (128 + SIGINT). The lease is then left for the next start to take over by pid,
// the same as a crash (ARCH 7.5); the next start's sweep finds the runs it left (3.14.5).
const FORCED_EXIT_CODE = 130;
// How long a forced exit waits for the agents' kills before it exits anyway.
const FORCED_KILL_WAIT_MS = 3_000;

// The first signal asks for the ordered stop. The second exits: it kills the process trees of the attempts in flight
// first, so no agent outlives the runtime (3.14), and exits once they are gone or the wait passed; with nothing in flight
// it exits at once. A third signal exits at once. Returns the function that detaches both signals.
export function attachStopSignals(
  source: SignalSource,
  shutdown: Shutdown,
  forceExit: (code: number) => void,
  children?: KillSwitch,
): () => void {
  const signals: StopSignal[] = ["SIGINT", "SIGTERM"];
  let received = 0;
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    forceExit(FORCED_EXIT_CODE);
  };
  const onSignal = (): void => {
    received += 1;
    if (received === 1) {
      shutdown.request("signal");
      return;
    }
    if (received > 2 || children === undefined || children.size === 0) {
      exit();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FORCED_KILL_WAIT_MS);
    });
    void Promise.race([children.killAll(), waited]).then(() => {
      clearTimeout(timer);
      exit();
    });
  };
  for (const signal of signals) source.on(signal, onSignal);
  return () => {
    for (const signal of signals) source.off(signal, onSignal);
  };
}
