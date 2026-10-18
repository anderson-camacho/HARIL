import { randomBytes } from "node:crypto";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type {
  AgentRuntime,
  Clock,
  DelegationToolHandler,
  Ids,
  PlanProposer,
  Store,
} from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { inspectStore, openStore, type StoreInspection } from "@haril/state-sqlite";
import type { HostInfo } from "./context.js";

// Production wiring of the Clock, Ids and Core rules. The Core never reads the clock or randomness (R7);
// the composition root does.

const STORE_RULES = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
};

// Liveness of a lease holder (M1 fix c). EPERM means the process exists but belongs to another user.
export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

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

export function clockFor(host: HostInfo): Clock {
  return host.clock ?? systemClock;
}

// The simulated agent (M1-D7) unless the host injects another runtime (tests). fake:plan proposes through proposePlan
// (LD-T4), and the fake workflow agents call delegationTools (phase F2); an injected runtime keeps its own.
export function agentRuntimeFor(
  host: HostInfo,
  proposePlan?: PlanProposer,
  delegationTools?: DelegationToolHandler,
): AgentRuntime {
  return (
    host.agentRuntime ??
    new FakeAgentRuntime({
      clock: clockFor(host),
      ...(proposePlan === undefined ? {} : { proposePlan }),
      ...(delegationTools === undefined ? {} : { delegationTools }),
    })
  );
}

// Read-only inspection never creates files; open creates and migrates the store (M1-D8).
export function storeAccess(host: HostInfo): StoreAccess {
  const clock = clockFor(host);
  const ids = host.ids ?? ulidIds;
  return {
    ids,
    inspect:
      host.inspectStore ??
      ((dataDir) => inspectStore({ dataDir, runtime: { nodeVersion: host.nodeVersion } })),
    open:
      host.openStore ??
      ((dataDir) =>
        openStore({
          dataDir,
          clock,
          ids,
          rules: STORE_RULES,
          isPidAlive: host.isPidAlive ?? defaultPidAlive,
        })),
  };
}
