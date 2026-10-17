import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ControlClient,
  type ControlServer,
  connect,
  controlLocation,
  createControlServer,
  nudgeRuntime,
} from "../src/index.js";

// The control pipe (LD-T2, ARCH 4.3): it carries no authority and no data, only wake-ups and redacted event ids.
let dataDir: string;
const servers: ControlServer[] = [];
const clients: ControlClient[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "haril-control-"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function serve(): Promise<ControlServer> {
  const server = createControlServer({ dataDir });
  servers.push(server);
  await server.start();
  return server;
}

async function subscribe(): Promise<ControlClient> {
  const client = await connect(dataDir, { subscribe: true });
  if (client === undefined) throw new Error("no runtime answered");
  clients.push(client);
  return client;
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("the condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Sends raw lines to the endpoint and resolves with whatever the server wrote before it closed the socket.
function rawExchange(endpoint: string, lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      for (const line of lines) socket.write(`${line}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
  });
}

describe("endpoint (LD-T2)", () => {
  it("names the pipe after a hash of the data root on win32", () => {
    const location = controlLocation(dataDir, "win32");
    expect(location.endpoint).toMatch(/^\\\\\.\\pipe\\haril-ctl-[0-9a-f]{16}$/);
    expect(controlLocation(dataDir, "win32").endpoint).toBe(location.endpoint);
    expect(controlLocation(join(dataDir, "other"), "win32").endpoint).not.toBe(location.endpoint);
  });

  it("puts the socket and the token under run/ on POSIX", () => {
    const location = controlLocation(dataDir, "linux");
    expect(location.endpoint).toBe(join(dataDir, "run", "ctl.sock"));
    expect(location.tokenFile).toBe(join(dataDir, "run", "ctl.token"));
  });
});

describe("control server and client (LD-T2)", () => {
  it("writes a 32-byte hex token while it runs and removes the file on close", async () => {
    const server = await serve();
    const token = readFileSync(controlLocation(dataDir).tokenFile, "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(() => readFileSync(controlLocation(dataDir).tokenFile, "utf8")).toThrow();
  });

  it("refuses a bad token and closes without echoing it", async () => {
    await serve();
    const token = readFileSync(controlLocation(dataDir).tokenFile, "utf8").trim();
    const received = await rawExchange(controlLocation(dataDir).endpoint, [
      JSON.stringify({ type: "hello", token: "0".repeat(64), subscribe: true }),
    ]);
    expect(received).toBe("");
    expect(received).not.toContain(token);
  });

  it("refuses any message sent before hello", async () => {
    const server = await serve();
    let nudges = 0;
    server.onNudge(() => {
      nudges += 1;
    });
    const received = await rawExchange(controlLocation(dataDir).endpoint, [
      JSON.stringify({ type: "nudge" }),
    ]);
    expect(received).toBe("");
    expect(nudges).toBe(0);
  });

  it("gives a client no runtime when nothing listens or the token file is missing", async () => {
    expect(await connect(dataDir)).toBeUndefined();

    mkdirSync(join(dataDir, "run"), { recursive: true });
    writeFileSync(controlLocation(dataDir).tokenFile, "a".repeat(64));
    expect(await connect(dataDir)).toBeUndefined();
  });

  it("sends a subscriber a wake and a redacted event with no payload fields", async () => {
    const server = await serve();
    const client = await subscribe();
    const events: unknown[] = [];
    const wakes: number[] = [];
    client.onEvent((event) => events.push(event));
    client.onWake((seq) => wakes.push(seq));

    // A caller that passes more than the ids must not leak them onto the pipe.
    const leaky = { eventType: "task.claimed", taskId: "01TASK", goal: "secret goal", path: "/x" };
    server.notify(leaky);

    await waitFor(() => wakes.length === 1);
    expect(events).toEqual([
      { type: "event", eventType: "task.claimed", taskId: "01TASK", seq: 1 },
    ]);
    expect(wakes).toEqual([1]);
  });

  it("counts subscribers as they connect and disconnect, and a nudge-only client is not one", async () => {
    const server = await serve();
    const subscriber = await subscribe();
    expect(server.subscriberCount()).toBe(1);

    const nudger = await connect(dataDir);
    if (nudger === undefined) throw new Error("no runtime answered");
    clients.push(nudger);
    expect(server.subscriberCount()).toBe(1);

    subscriber.close();
    await waitFor(() => server.subscriberCount() === 0);
  });

  it("delivers a nudge to onNudge", async () => {
    const server = await serve();
    let nudges = 0;
    server.onNudge(() => {
      nudges += 1;
    });
    const client = await connect(dataDir);
    if (client === undefined) throw new Error("no runtime answered");
    clients.push(client);
    client.nudge();
    await waitFor(() => nudges === 1);
  });

  it("tells a subscriber that the runtime is gone when the server closes", async () => {
    const server = await serve();
    const client = await subscribe();
    let closed = 0;
    client.onClose(() => {
      closed += 1;
    });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await waitFor(() => closed === 1);
    expect(await connect(dataDir)).toBeUndefined();
  });

  it("nudgeRuntime reports false with no runtime and true, with the nudge delivered, with one", async () => {
    expect(await nudgeRuntime(dataDir)).toBe(false);

    const server = await serve();
    let nudges = 0;
    server.onNudge(() => {
      nudges += 1;
    });
    expect(await nudgeRuntime(dataDir, { timeoutMs: 1000 })).toBe(true);
    await waitFor(() => nudges === 1);
  });

  it.skipIf(process.platform === "win32")(
    "replaces a stale socket file left by a crashed runtime (POSIX)",
    async () => {
      mkdirSync(join(dataDir, "run"), { recursive: true });
      writeFileSync(controlLocation(dataDir).endpoint, "stale");
      await serve();
      const client = await subscribe();
      expect(client).toBeDefined();
    },
  );
});
