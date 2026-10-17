import { createHash, randomUUID } from "node:crypto";
import type { MemoryProviderState } from "@haril/contracts";
import { estimateTokens, NullMemoryProvider } from "@haril/core";
import type { Clock, Hasher, Ids, MemoryProvider, Store } from "@haril/core/ports";

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

// What a runtime leaves for memory when it exits (MC-T4 fix): the tasks blocked(memory_unavailable) and the writes
// still queued (pending or sending). Both resume on the next haril start or haril run; a row waiting for review does not
// and is left out.
export interface MemoryLeft {
  readonly state: MemoryProviderState;
  readonly waitingForMemory: number;
  readonly queuedWrites: number;
}

export function memoryLeftOf(store: Store, state: MemoryProviderState): MemoryLeft {
  const waitingForMemory = store.tasks
    .list()
    .filter((task) => task.state === "blocked")
    .filter((task) => store.tasks.get(task.taskId)?.blockReason === "memory_unavailable").length;
  const { outbox } = store.memory.status();
  return { state, waitingForMemory, queuedWrites: outbox.pending + outbox.sending };
}

// The line start prints when it exits with work left for memory, undefined when there is none: "memory degraded: 1 task
// waits for memory and 2 writes are queued; they resume on the next haril start or haril run".
export function memoryLeftLine(left: MemoryLeft): string | undefined {
  const parts = [
    ...(left.waitingForMemory === 0
      ? []
      : [
          `${left.waitingForMemory} ${left.waitingForMemory === 1 ? "task waits" : "tasks wait"} for memory`,
        ]),
    ...(left.queuedWrites === 0
      ? []
      : [`${left.queuedWrites} ${left.queuedWrites === 1 ? "write is" : "writes are"} queued`]),
  ];
  if (parts.length === 0) return undefined;
  const one = left.waitingForMemory + left.queuedWrites === 1;
  return `memory ${left.state}: ${parts.join(" and ")}; ${one ? "it resumes" : "they resume"} on the next haril start or haril run`;
}

// The jitter of the outbox and health backoffs (R-O4): a whole number of milliseconds in [0, maxMs).
export function backoffJitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}
