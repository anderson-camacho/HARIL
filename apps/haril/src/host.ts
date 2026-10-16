import { randomBytes } from "node:crypto";
import type { Clock, Ids, Store } from "@haril/core/ports";
import { inspectStore, openStore, type StoreInspection } from "@haril/state-sqlite";
import type { HostInfo } from "./context.js";

// Production wiring of the Clock and Ids ports. The Core never reads the clock or randomness (R7);
// the composition root does.

const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ULID: 48 bits of time (10 characters) and 80 random bits (16 characters), Crockford base32.
function newUlid(now: number = Date.now(), random: Uint8Array = randomBytes(16)): string {
  let time = "";
  let remaining = now;
  for (let index = 0; index < 10; index++) {
    time = CROCKFORD.charAt(remaining % 32) + time;
    remaining = Math.floor(remaining / 32);
  }
  let entropy = "";
  for (let index = 0; index < 16; index++) {
    entropy += CROCKFORD.charAt((random[index] ?? 0) & 31);
  }
  return time + entropy;
}

const ulidIds: Ids = { next: () => newUlid() };

export interface StoreAccess {
  readonly ids: Ids;
  inspect(dataDir: string): StoreInspection;
  open(dataDir: string): Store;
}

// Read-only inspection never creates files; open creates and migrates the store (M1-D8).
export function storeAccess(host: HostInfo): StoreAccess {
  const clock = host.clock ?? systemClock;
  const ids = host.ids ?? ulidIds;
  return {
    ids,
    inspect:
      host.inspectStore ??
      ((dataDir) => inspectStore({ dataDir, runtime: { nodeVersion: host.nodeVersion } })),
    open: host.openStore ?? ((dataDir) => openStore({ dataDir, clock, ids })),
  };
}
