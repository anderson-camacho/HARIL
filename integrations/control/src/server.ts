import { mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { controlLocation } from "./endpoint.js";
import {
  type ClientMessage,
  encodeLine,
  LineReader,
  parseClientMessage,
  type ServerMessage,
} from "./protocol.js";
import { newToken, removeOwnToken, tokensMatch, writeToken } from "./token.js";

// The runtime's end of the control channel (LD-T2, ARCH 4.3). It only wakes its subscribers: an event carries an event
// type and an optional task id, never a payload, and a nudge asks the runtime to check its queue now. Nothing here
// reads or writes the store.

// What a caller may name in an event. Anything else (a goal, a path, a key) is dropped by construction: the server
// copies these two fields and nothing more.
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ControlEvent {
  readonly eventType: string;
  readonly taskId?: string;
}

export interface ControlServerOptions {
  readonly dataDir: string;
  // Defaults to the running platform; tests may name another to check the endpoint naming.
  readonly platform?: string;
}

export interface ControlServer {
  // Creates the token file and starts listening. Rejects when the endpoint is taken.
  start(): Promise<void>;
  // Sends the redacted event to every subscriber, then a wake with the new sequence number.
  notify(event: ControlEvent): void;
  // Sends a wake to every subscriber without an event.
  wake(): void;
  subscriberCount(): number;
  // Calls the listener on every nudge. Returns the function that removes it.
  onNudge(listener: () => void): () => void;
  // Stops listening, removes the token file and the socket file this server created, and disconnects every client.
  close(): Promise<void>;
}

export function createControlServer(options: ControlServerOptions): ControlServer {
  const location = controlLocation(options.dataDir, options.platform);
  const sockets = new Set<Socket>();
  const subscribers = new Set<Socket>();
  const nudgeListeners = new Set<() => void>();
  let server: Server | undefined;
  let token: string | undefined;
  let socketIno: number | undefined;
  let seq = 0;

  const send = (socket: Socket, message: ServerMessage): void => {
    if (!socket.destroyed) socket.write(encodeLine(message));
  };
  const broadcast = (message: ServerMessage): void => {
    for (const subscriber of subscribers) send(subscriber, message);
  };

  // A connection must open with a valid hello: anything else is dropped before a byte of data is answered.
  function onConnection(socket: Socket): void {
    sockets.add(socket);
    const reader = new LineReader();
    let authenticated = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) {
        const message = parseClientMessage(line);
        if (message === undefined || !handle(socket, message, authenticated)) {
          socket.destroy();
          return;
        }
        authenticated = true;
      }
    });
    const forget = (): void => {
      sockets.delete(socket);
      subscribers.delete(socket);
    };
    socket.on("close", forget);
    socket.on("error", forget);
  }

  // Returns false on a protocol error. The first message must be a hello with the token; later ones are nudges.
  function handle(socket: Socket, message: ClientMessage, authenticated: boolean): boolean {
    if (!authenticated) {
      if (message.type !== "hello" || token === undefined || !tokensMatch(token, message.token)) {
        return false;
      }
      if (message.subscribe) subscribers.add(socket);
      send(socket, { type: "ready" });
      return true;
    }
    if (message.type !== "nudge") return false;
    for (const listener of [...nudgeListeners]) listener();
    return true;
  }

  return {
    async start(): Promise<void> {
      if (server !== undefined) throw new Error("the control server is already running");
      mkdirSync(location.runDir, { recursive: true });
      // A socket file left by a crashed runtime would make listen fail. The lease makes this runtime the only one.
      if (location.socketFile !== undefined) rmSync(location.socketFile, { force: true });
      // The token is written before listening, so a client that connects always finds it.
      const fresh = newToken();
      writeToken(location.tokenFile, fresh);
      const next = createServer(onConnection);
      try {
        await listen(next, location.endpoint);
      } catch (error) {
        removeOwnToken(location.tokenFile, fresh);
        throw error;
      }
      token = fresh;
      server = next;
      if (location.socketFile !== undefined) socketIno = statSync(location.socketFile).ino;
    },

    notify(event: ControlEvent): void {
      seq += 1;
      if (EVENT_TYPE.test(event.eventType)) {
        const taskId =
          event.taskId !== undefined && TASK_ID.test(event.taskId) ? event.taskId : undefined;
        const message: ServerMessage =
          taskId === undefined
            ? { type: "event", eventType: event.eventType, seq }
            : { type: "event", eventType: event.eventType, taskId, seq };
        broadcast(message);
      }
      broadcast({ type: "wake", seq });
    },

    wake(): void {
      broadcast({ type: "wake", seq });
    },

    subscriberCount(): number {
      return subscribers.size;
    },

    onNudge(listener: () => void): () => void {
      nudgeListeners.add(listener);
      return () => {
        nudgeListeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      const current = server;
      server = undefined;
      // Stop accepting first, so no new client can attach while the files go.
      const stopped =
        current === undefined
          ? undefined
          : new Promise<void>((resolve) => {
              current.close(() => resolve());
            });
      if (location.socketFile !== undefined && socketIno !== undefined) {
        removeOwnSocket(location.socketFile, socketIno);
      }
      socketIno = undefined;
      if (token !== undefined) removeOwnToken(location.tokenFile, token);
      token = undefined;
      subscribers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await stopped;
    },
  };
}

function listen(target: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    target.once("error", onError);
    target.listen(endpoint, () => {
      target.off("error", onError);
      // A later error on the listening server must not crash the runtime.
      target.on("error", () => undefined);
      resolve();
    });
  });
}

// Removes the socket file only when it is still the one this server created (the same inode).
function removeOwnSocket(file: string, ino: number): void {
  try {
    if (statSync(file).ino === ino) rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}
