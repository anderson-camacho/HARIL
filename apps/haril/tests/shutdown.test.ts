import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachStopSignals, createShutdown } from "../src/runtime/shutdown.js";

// Ordered stop by signal (ARCH 4.2): the first Ctrl+C or SIGTERM asks for a graceful stop, the second exits at once.
// The signal source is injected, so the test never sends a real signal (child.kill("SIGINT") ends a process on Windows).
describe("shutdown control", () => {
  it("keeps the first reason, and a listener added after a request is called at once", () => {
    const shutdown = createShutdown();
    const reasons: string[] = [];
    shutdown.request("command");
    shutdown.request("signal");
    expect(shutdown.requested).toBe(true);
    expect(shutdown.reason).toBe("command");
    shutdown.onRequest((reason) => reasons.push(reason));
    expect(reasons).toEqual(["command"]);
  });

  it("notifies each listener once", () => {
    const shutdown = createShutdown();
    const reasons: string[] = [];
    const stop = shutdown.onRequest((reason) => reasons.push(reason));
    shutdown.request("signal");
    shutdown.request("signal");
    expect(reasons).toEqual(["signal"]);
    stop();
  });
});

describe("attachStopSignals", () => {
  it("the first signal requests a graceful stop and does not force an exit", () => {
    const source = new EventEmitter();
    const shutdown = createShutdown();
    const forced: number[] = [];
    attachStopSignals(source, shutdown, (code) => forced.push(code));

    source.emit("SIGINT");
    expect(shutdown.reason).toBe("signal");
    expect(forced).toEqual([]);
  });

  it("a second signal exits at once with 130", () => {
    const source = new EventEmitter();
    const shutdown = createShutdown();
    const forced: number[] = [];
    attachStopSignals(source, shutdown, (code) => forced.push(code));

    source.emit("SIGINT");
    source.emit("SIGTERM");
    expect(forced).toEqual([130]);
  });

  it("detaching removes both listeners", () => {
    const source = new EventEmitter();
    const shutdown = createShutdown();
    const forced: number[] = [];
    const detach = attachStopSignals(source, shutdown, (code) => forced.push(code));
    detach();

    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(shutdown.requested).toBe(false);
  });
});
