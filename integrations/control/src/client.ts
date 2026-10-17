import { createConnection } from "node:net";
import { controlLocation } from "./endpoint.js";
import { encodeLine, LineReader, parseServerMessage, type ServerMessage } from "./protocol.js";
import { readToken } from "./token.js";

// The client end of the control channel (LD-T2). It keeps no timers: a subscription is driven by the pipe's own
// messages. The only timeout is the one-shot nudge, which clears its timer as soon as it settles.

const NUDGE_TIMEOUT_MS = 500;

export type ControlEventMessage = Extract<ServerMessage, { readonly type: "event" }>;

export interface ControlClient {
  // Called with the sequence number of every wake.
  onWake(listener: (seq: number) => void): () => void;
  // Called with every redacted event: its type and task id, never a payload.
  onEvent(listener: (event: ControlEventMessage) => void): () => void;
  // Called once when the connection ends, whichever side ended it.
  onClose(listener: () => void): () => void;
  // Asks the runtime to check its queue now.
  nudge(): void;
  // Ends the connection. Safe to call more than once.
  close(): void;
}

export interface ConnectOptions {
  // A subscribed client keeps the runtime up past its idle window (ARCH 4.2). Defaults to false.
  readonly subscribe?: boolean;
}

// Resolves to a client once the runtime answers ready. Resolves to undefined when no runtime listens, the token file
// is missing, or the runtime refuses the token. Never rejects.
export function connect(
  dataDir: string,
  options: ConnectOptions = {},
): Promise<ControlClient | undefined> {
  const location = controlLocation(dataDir);
  const token = readToken(location.tokenFile);
  if (token === undefined) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const socket = createConnection(location.endpoint);
    const wakeListeners = new Set<(seq: number) => void>();
    const eventListeners = new Set<(event: ControlEventMessage) => void>();
    const closeListeners = new Set<() => void>();
    const reader = new LineReader();
    let ready = false;
    let settled = false;

    const client: ControlClient = {
      onWake(listener) {
        wakeListeners.add(listener);
        return () => {
          wakeListeners.delete(listener);
        };
      },
      onEvent(listener) {
        eventListeners.add(listener);
        return () => {
          eventListeners.delete(listener);
        };
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => {
          closeListeners.delete(listener);
        };
      },
      nudge() {
        if (!socket.destroyed) socket.write(encodeLine({ type: "nudge" }));
      },
      close() {
        if (!socket.destroyed) socket.end();
      },
    };

    const settle = (value: ControlClient | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const dispatch = (message: ServerMessage): boolean => {
      if (!ready) {
        if (message.type !== "ready") return false;
        ready = true;
        settle(client);
        return true;
      }
      if (message.type === "wake") for (const listener of [...wakeListeners]) listener(message.seq);
      if (message.type === "event") for (const listener of [...eventListeners]) listener(message);
      return true;
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(encodeLine({ type: "hello", token, subscribe: options.subscribe === true }));
    });
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        const message = parseServerMessage(line);
        if (message === undefined || !dispatch(message)) {
          socket.destroy();
          return;
        }
      }
    });
    // An error before ready means no runtime answered; the close that follows settles the promise.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      settle(undefined);
      for (const listener of [...closeListeners]) listener();
    });
  });
}

export interface NudgeOptions {
  // How long the nudge may take before it is given up. Defaults to 500 ms.
  readonly timeoutMs?: number;
}

// Best-effort: connects, nudges and disconnects. Resolves true when the nudge was sent, false when no runtime was
// reached in time. A late connection after the timeout is closed at once, so nothing is left open.
export function nudgeRuntime(dataDir: string, options: NudgeOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? NUDGE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (sent: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(sent);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    connect(dataDir).then(
      (client) => {
        if (client === undefined) return finish(false);
        if (done) {
          client.close();
          return;
        }
        client.nudge();
        client.close();
        finish(true);
      },
      () => finish(false),
    );
  });
}
