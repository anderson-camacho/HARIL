import type { Store } from "@haril/core/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type StoreError } from "../src/index.js";
import { type ManualClock, manualClock, sequentialIds, testRules } from "./support.js";

// Runtime lease (M1-T5): singleton lease, epochs, takeover of an expired lease, heartbeat and release.
const TTL = 1000;
let clock: ManualClock;
let store: Store;

beforeEach(() => {
  clock = manualClock();
  store = openMemoryStore({ clock, ids: sequentialIds(), rules: testRules });
});

afterEach(() => {
  store.close();
});

function acquire(pid = 100) {
  return store.runtime.acquire({
    pid,
    nodeVersion: "v24.19.0",
    sqliteVersion: "3.53.3",
    ttlMs: TTL,
  });
}

function caught(action: () => unknown): StoreError {
  try {
    action();
  } catch (error) {
    return error as StoreError;
  }
  throw new Error("expected the operation to throw");
}

describe("runtime lease", () => {
  it("grants epoch 1 on an empty store", () => {
    const result = acquire();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.epoch).toBe(1);
  });

  it("refuses a second acquire while the lease is active, naming the holder", () => {
    acquire(100);
    const result = acquire(200);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("runtime.busy");
      expect(result.error.pid).toBe(100);
    }
  });

  it("heartbeat extends the lease so a later acquire is still refused", () => {
    acquire();
    clock.advance(800);
    store.runtime.heartbeat(1, TTL);
    clock.advance(800);
    expect(acquire(200).ok).toBe(false);
  });

  it("takes over an expired lease: the old one is lost and the epoch advances", () => {
    acquire(100);
    clock.advance(TTL + 1);
    const result = acquire(200);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.epoch).toBe(2);
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "active", pid: 200 });
  });

  it("fences a heartbeat from the epoch that lost its lease", () => {
    acquire();
    clock.advance(TTL + 1);
    acquire();
    expect(caught(() => store.runtime.heartbeat(1, TTL)).code).toBe("store.fenced");
  });

  it("release frees the lease for the next acquire", () => {
    acquire();
    store.runtime.release(1, true);
    expect(store.runtime.leaseSummary()).toMatchObject({ status: "released" });
    const next = acquire(200);
    expect(next.ok && next.value.epoch).toBe(2);
  });

  it("fences a release from an epoch that is no longer active", () => {
    acquire();
    clock.advance(TTL + 1);
    acquire();
    expect(caught(() => store.runtime.release(1, true)).code).toBe("store.fenced");
  });
});
