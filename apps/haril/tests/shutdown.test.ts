import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachStopSignals, createKillSwitch, createShutdown } from "../src/runtime/shutdown.js";

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

  it("upgrades a graceful stop to an emergency, and every listener hears it, one added after the first request included (3.14)", () => {
    const shutdown = createShutdown();
    const early: string[] = [];
    const late: string[] = [];
    const removed: string[] = [];
    shutdown.onRequest((reason) => early.push(reason));
    shutdown.request("command");
    shutdown.onRequest((reason) => late.push(reason));
    const remove = shutdown.onRequest((reason) => removed.push(reason));
    remove();
    shutdown.request("emergency");
    expect(shutdown.reason).toBe("emergency");
    expect(early).toEqual(["command", "emergency"]);
    expect(late).toEqual(["command", "emergency"]);
    expect(removed).toEqual(["command"]);
    // An emergency is final: nothing downgrades it, and a repeat notifies nobody.
    shutdown.request("signal");
    shutdown.request("emergency");
    expect(shutdown.reason).toBe("emergency");
    expect(early).toEqual(["command", "emergency"]);
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

  it("with no agent in flight, a second signal exits at once with 130", () => {
    const source = new EventEmitter();
    const shutdown = createShutdown();
    const forced: number[] = [];
    attachStopSignals(source, shutdown, (code) => forced.push(code));

    source.emit("SIGINT");
    source.emit("SIGTERM");
    expect(forced).toEqual([130]);
  });

  it("a second signal kills the agents in flight first and exits with 130 once they are gone (3.14)", async () => {
    const source = new EventEmitter();
    const shutdown = createShutdown();
    const order: string[] = [];
    const children = createKillSwitch();
    children.register("run-1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("killed run-1");
    });
    const unregister = children.register("run-2", async () => {
      order.push("killed run-2");
    });
    unregister();
    attachStopSignals(source, shutdown, (code) => order.push(`exit ${code}`), children);

    source.emit("SIGINT");
    source.emit("SIGINT");
    expect(order).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual(["killed run-1", "exit 130"]);
  });

  it("a third signal exits at once, and the forced exit happens only once", async () => {
    const source = new EventEmitter();
    const shutdown = createShutdown();
    const forced: number[] = [];
    const children = createKillSwitch();
    children.register("run-1", () => new Promise((resolve) => setTimeout(resolve, 50)));
    attachStopSignals(source, shutdown, (code) => forced.push(code), children);

    source.emit("SIGINT");
    source.emit("SIGINT");
    source.emit("SIGINT");
    expect(forced).toEqual([130]);
    await new Promise((resolve) => setTimeout(resolve, 100));
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
