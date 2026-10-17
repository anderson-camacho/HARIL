import { createHash, randomUUID } from "node:crypto";
import { estimateTokens, NullMemoryProvider } from "@haril/core";
import type { Clock, Hasher, Ids, MemoryProvider } from "@haril/core/ports";

// The memory of a runtime (MC-T4; memory.md 9.6; ARCH 8.3): the provider and the ids and hash core/memory needs. No
// memory can be configured yet (the keys of config/haril.json are HC-05, and Engram comes with MC-T5 and MC-T6), so a
// runtime runs the Null provider, the MVP default: it keeps nothing and nothing is queued (CM-04).
export interface RuntimeMemory {
  readonly provider: MemoryProvider;
  // Operation ids, generated at enqueue time and reused on every retry (ADR-0008 D4).
  readonly ids: Ids;
  readonly hasher: Hasher;
}

const nodeHasher: Hasher = {
  sha256: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
};

const uuidIds: Ids = { next: () => randomUUID() };

export function defaultRuntimeMemory(clock: Clock): RuntimeMemory {
  return {
    provider: new NullMemoryProvider({ clock, ids: uuidIds, hasher: nodeHasher, estimateTokens }),
    ids: uuidIds,
    hasher: nodeHasher,
  };
}

// The jitter of the outbox and health backoffs (R-O4): a whole number of milliseconds in [0, maxMs).
export function backoffJitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}
