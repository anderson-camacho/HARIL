import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, Ids } from "@haril/core/ports";

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
