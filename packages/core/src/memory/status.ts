// How a recorded memory status reads (MC-T4; RF-132; MEMORY.md 12.3; memory.md 9.6): one rule for `haril memory status`
// and the shell's Connect box, which read the same Store status. Pure.
import type { MemoryProviderState } from "@haril/contracts";
import type { MemoryOutboxCounts, MemoryStatus } from "../ports/index.js";

// The provider the MVP runs when none is configured (memory.md 9.6): it keeps nothing.
export const DEFAULT_MEMORY_PROVIDER = "null";

// The status of a data dir without a store, or before any runtime recorded one.
export const UNRECORDED_MEMORY_STATUS: MemoryStatus = {
  provider: null,
  persistent: null,
  lastState: null,
  lastStateAt: null,
  lastError: null,
  outbox: { pending: 0, sending: 0, needsReview: 0, dead: 0, delivered: 0, oldestPendingAt: null },
};

// not_checked: no runtime is alive to check the provider, so the recorded state is only the last one known.
export type MemoryHealthView = MemoryProviderState | "not_checked";

export interface MemoryStatusView {
  readonly provider: string;
  // recorded: a runtime recorded it; default: none did yet, so it is the MVP default.
  readonly providerSource: "recorded" | "default";
  // null when a recorded provider did not say.
  readonly persistent: boolean | null;
  readonly health: MemoryHealthView;
  // The last recorded state is not active, whether or not a runtime is alive.
  readonly degraded: boolean;
  readonly lastState: MemoryProviderState | null;
  readonly lastStateAt: number | null;
  readonly lastError: { readonly code: string; readonly at: number } | null;
  readonly outbox: MemoryOutboxCounts & { readonly depth: number };
}

// The rows still to deliver: dead and delivered rows are done.
export function outboxDepth(outbox: MemoryOutboxCounts): number {
  return outbox.pending + outbox.sending + outbox.needsReview;
}

export function describeMemory(status: MemoryStatus, runtimeAlive: boolean): MemoryStatusView {
  const recorded = status.provider !== null;
  return {
    provider: status.provider ?? DEFAULT_MEMORY_PROVIDER,
    providerSource: recorded ? "recorded" : "default",
    persistent: recorded ? status.persistent : false,
    health: runtimeAlive && status.lastState !== null ? status.lastState : "not_checked",
    degraded: status.lastState === "degraded" || status.lastState === "blocked_by_policy",
    lastState: status.lastState,
    lastStateAt: status.lastStateAt,
    lastError: status.lastError,
    outbox: { depth: outboxDepth(status.outbox), ...status.outbox },
  };
}
