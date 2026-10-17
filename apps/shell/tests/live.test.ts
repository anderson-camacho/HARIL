import type { ControlClient } from "@haril/control";
import { describe, expect, it } from "vitest";
import { type ConnectControl, createLiveFeed, RELOAD_INTERVAL_MS } from "../src/live.js";

// The live feed of the shell (LD-T2): it subscribes to the control channel, reloads on a wake at most once per
// interval, and ends the subscription on request. A fake client stands in for the pipe.
interface FakeControl {
  readonly client: ControlClient;
  wake(seq: number): void;
  dropConnection(): void;
  readonly closes: () => number;
}

function fakeControl(): FakeControl {
  const wakeListeners: ((seq: number) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let closes = 0;
  const client: ControlClient = {
    onWake: (listener) => {
      wakeListeners.push(listener);
      return () => undefined;
    },
    onEvent: () => () => undefined,
    onClose: (listener) => {
      closeListeners.push(listener);
      return () => undefined;
    },
    nudge: () => undefined,
    close: () => {
      closes += 1;
    },
  };
  return {
    client,
    wake: (seq) => {
      for (const listener of wakeListeners) listener(seq);
    },
    dropConnection: () => {
      for (const listener of closeListeners) listener();
    },
    closes: () => closes,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  readonly feed: ReturnType<typeof createLiveFeed>;
  readonly reloads: () => number;
  readonly changes: () => number;
  readonly connections: { subscribe: boolean }[];
}

function harnessWith(connect: ConnectControl): Harness {
  let reloads = 0;
  let changes = 0;
  const connections: { subscribe: boolean }[] = [];
  const feed = createLiveFeed({
    dataDir: "/data",
    connect: (dataDir, options) => {
      connections.push({ subscribe: options.subscribe });
      return connect(dataDir, options);
    },
    reload: () => {
      reloads += 1;
    },
    onChange: () => {
      changes += 1;
    },
  });
  return {
    feed,
    reloads: () => reloads,
    changes: () => changes,
    connections,
  };
}

describe("live feed (LD-T2)", () => {
  it("subscribes with subscribe true and reloads on a wake", async () => {
    const control = fakeControl();
    const h = harnessWith(async () => control.client);

    h.feed.subscribe();
    await wait(0);
    expect(h.connections).toEqual([{ subscribe: true }]);
    expect(h.feed.subscribed).toBe(true);

    control.wake(1);
    expect(h.reloads()).toBe(1);
    h.feed.close();
  });

  it("stays unsubscribed when no runtime answers", async () => {
    const h = harnessWith(async () => undefined);
    h.feed.subscribe();
    await wait(0);
    expect(h.feed.subscribed).toBe(false);
    expect(h.changes()).toBe(0);
  });

  it("opens one connection however often subscribe is asked", async () => {
    const control = fakeControl();
    const h = harnessWith(async () => control.client);
    h.feed.subscribe();
    h.feed.subscribe();
    await wait(0);
    h.feed.subscribe();
    expect(h.connections).toHaveLength(1);
    h.feed.close();
  });

  it("collapses a burst of wakes into one reload now and one at the end of the interval", async () => {
    const control = fakeControl();
    const h = harnessWith(async () => control.client);
    h.feed.subscribe();
    await wait(0);

    for (let seq = 1; seq <= 10; seq++) control.wake(seq);
    expect(h.reloads()).toBe(1);

    await wait(RELOAD_INTERVAL_MS + 60);
    expect(h.reloads()).toBe(2);

    await wait(RELOAD_INTERVAL_MS + 60);
    expect(h.reloads()).toBe(2);
    h.feed.close();
  });

  it("reloads at once for a wake that comes after the interval has passed", async () => {
    const control = fakeControl();
    const h = harnessWith(async () => control.client);
    h.feed.subscribe();
    await wait(0);

    control.wake(1);
    await wait(RELOAD_INTERVAL_MS + 60);
    control.wake(2);
    expect(h.reloads()).toBe(2);
    h.feed.close();
  });

  it("close ends the subscription and cancels the reload still waiting", async () => {
    const control = fakeControl();
    const h = harnessWith(async () => control.client);
    h.feed.subscribe();
    await wait(0);

    control.wake(1);
    control.wake(2);
    h.feed.close();
    await wait(RELOAD_INTERVAL_MS + 60);

    expect(h.reloads()).toBe(1);
    expect(control.closes()).toBe(1);
    expect(h.feed.subscribed).toBe(false);
  });

  it("tries again after each retry delay and resolves true once a runtime answers (LD-T6)", async () => {
    const control = fakeControl();
    let calls = 0;
    const h = harnessWith(async () => {
      calls += 1;
      return calls < 3 ? undefined : control.client;
    });
    expect(await h.feed.subscribe([10, 10, 10])).toBe(true);
    expect(h.connections).toHaveLength(3);
    expect(h.feed.subscribed).toBe(true);
    h.feed.close();
  });

  it("gives up after the last retry delay and tries nothing more (LD-T6)", async () => {
    const h = harnessWith(async () => undefined);
    expect(await h.feed.subscribe([10, 20])).toBe(false);
    expect(h.connections).toHaveLength(3);
    await wait(60);
    expect(h.connections).toHaveLength(3);
    expect(h.feed.subscribed).toBe(false);
  });

  it("close cancels a retry still waiting and resolves false (LD-T6)", async () => {
    const h = harnessWith(async () => undefined);
    const outcome = h.feed.subscribe([5_000]);
    await wait(0);
    h.feed.close();
    expect(await outcome).toBe(false);
    expect(h.connections).toHaveLength(1);
  });

  it("drops to unsubscribed and reports the change when the connection ends", async () => {
    const control = fakeControl();
    const h = harnessWith(async () => control.client);
    h.feed.subscribe();
    await wait(0);
    const before = h.changes();

    control.dropConnection();
    expect(h.feed.subscribed).toBe(false);
    expect(h.changes()).toBe(before + 1);
  });
});
