import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canTransition,
  checkAcceptance,
  checkPlanSubmission,
  checkTaskKind,
} from "@haril/core";
import type { Clock, Ids, StoreRules } from "@haril/core/ports";

// The Core rules the composition root injects into the store (the store never imports Core values).
export const testRules: StoreRules = {
  canTransition,
  checkPlan: checkPlanSubmission,
  checkAcceptance,
  checkTaskKind,
  canonicalJson,
};

// Clock the test moves by hand: lease expiry and takeover need a controlled time.
export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function manualClock(start = 1_700_000_000_000): ManualClock {
  let time = start;
  return {
    now: () => time,
    set: (ms) => {
      time = ms;
    },
    advance: (ms) => {
      time += ms;
    },
    schedule: () => () => undefined,
  };
}

// Deterministic clock and identifiers for store tests (the store never reads them from the host).
export function fixedClock(start = 1_700_000_000_000): Clock {
  let time = start;
  return {
    now: () => {
      time += 1;
      return time;
    },
    schedule: () => () => undefined,
  };
}

export function sequentialIds(prefix = "id"): Ids {
  let counter = 0;
  return { next: () => `${prefix}-${String(++counter).padStart(6, "0")}` };
}

// A fresh directory under the OS temp dir; the caller removes it with removeTempDir.
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "haril-state-"));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
