import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_PROVIDER,
  deliveryBackoffMs,
  describeMemory,
  MAX_DELIVERY_ATTEMPTS,
  outboxTransitionOf,
} from "../src/memory/index.js";
import type { MemoryFailure, MemoryStatus } from "../src/ports/index.js";

// The pure rules of core/memory's outbox consumer and of `haril memory status` (MC-T4; memory.md 4.4, 4.5, 9.6;
// MEMORY.md 12.3): the backoff, what each failure does to an outbox row, and how a recorded status reads.

function failure(code: MemoryFailure["code"], retryable = code === "Unavailable"): MemoryFailure {
  return code === "contract.invalid"
    ? { code, category: "contract", retryable: false, message: "fake" }
    : { code, category: "memory", retryable, message: "fake" };
}

const EMPTY: MemoryStatus = {
  provider: null,
  persistent: null,
  lastState: null,
  lastStateAt: null,
  lastError: null,
  outbox: { pending: 0, sending: 0, needsReview: 0, dead: 0, delivered: 0, oldestPendingAt: null },
};

describe("deliveryBackoffMs (R-O4)", () => {
  it("starts at 1 s and doubles up to 60 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(deliveryBackoffMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe("outboxTransitionOf (memory.md 4.4)", () => {
  it("retries an unavailable provider until the attempt cap, then gives the row up", () => {
    expect(outboxTransitionOf(failure("Unavailable"), 1)).toBe("pending");
    expect(outboxTransitionOf(failure("Unavailable"), MAX_DELIVERY_ATTEMPTS - 1)).toBe("pending");
    expect(outboxTransitionOf(failure("Unavailable"), MAX_DELIVERY_ATTEMPTS)).toBe("dead");
  });

  it("sends to review what a retry cannot settle, and kills what was a defect", () => {
    // An unknown result the adapter could not resolve is a non-retryable Unavailable (R-O6): never resent blindly.
    expect(outboxTransitionOf(failure("Unavailable", false), 1)).toBe("needs_review");
    expect(outboxTransitionOf(failure("SessionEnded"), 1)).toBe("needs_review");
    expect(outboxTransitionOf(failure("ScopeMismatch"), 1)).toBe("needs_review");
    expect(outboxTransitionOf(failure("Unsupported"), 1)).toBe("dead");
    expect(outboxTransitionOf(failure("NotFound"), 1)).toBe("dead");
    expect(outboxTransitionOf(failure("contract.invalid"), 1)).toBe("dead");
  });
});

describe("describeMemory (haril memory status, the shell's Connect box)", () => {
  it("before any runtime recorded a provider: the MVP default, not persistent, health not checked", () => {
    expect(DEFAULT_MEMORY_PROVIDER).toBe("null");
    expect(describeMemory(EMPTY, false)).toEqual({
      provider: "null",
      providerSource: "default",
      persistent: false,
      health: "not_checked",
      degraded: false,
      lastState: null,
      lastStateAt: null,
      lastError: null,
      outbox: {
        depth: 0,
        pending: 0,
        sending: 0,
        needsReview: 0,
        dead: 0,
        delivered: 0,
        oldestPendingAt: null,
      },
    });
  });

  it("the recorded state is the health only while a runtime is alive", () => {
    const recorded: MemoryStatus = {
      ...EMPTY,
      provider: "fake-provider",
      persistent: true,
      lastState: "active",
      lastStateAt: 10,
    };
    expect(describeMemory(recorded, true)).toMatchObject({
      provider: "fake-provider",
      providerSource: "recorded",
      persistent: true,
      health: "active",
      degraded: false,
    });
    expect(describeMemory(recorded, false)).toMatchObject({
      health: "not_checked",
      lastState: "active",
    });
  });

  it("a degraded or blocked state is degraded even without a runtime to check it", () => {
    const degraded: MemoryStatus = {
      ...EMPTY,
      provider: "fake-provider",
      persistent: true,
      lastState: "degraded",
      lastStateAt: 10,
      lastError: { code: "Unavailable", at: 10 },
    };
    expect(describeMemory(degraded, true)).toMatchObject({ health: "degraded", degraded: true });
    expect(describeMemory(degraded, false)).toMatchObject({
      health: "not_checked",
      degraded: true,
    });
    expect(describeMemory({ ...degraded, lastState: "blocked_by_policy" }, true)).toMatchObject({
      health: "blocked_by_policy",
      degraded: true,
    });
  });

  it("the outbox depth counts the rows still to deliver: pending, sending and needs review", () => {
    const view = describeMemory(
      {
        ...EMPTY,
        outbox: {
          pending: 2,
          sending: 1,
          needsReview: 1,
          dead: 4,
          delivered: 9,
          oldestPendingAt: 5,
        },
      },
      false,
    );
    expect(view.outbox).toEqual({
      depth: 4,
      pending: 2,
      sending: 1,
      needsReview: 1,
      dead: 4,
      delivered: 9,
      oldestPendingAt: 5,
    });
  });
});
