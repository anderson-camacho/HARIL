import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { canTransition, checkAcceptance, checkPlanSubmission, type RunEvent } from "@haril/core";
import type { Clock } from "@haril/core/ports";
import { FakeAgentRuntime } from "@haril/core/testing";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUntilIdle } from "../src/runtime/run-loop.js";

// INV-18 (TEST_STRATEGY 6, MC-D5): the event loop of a simulated run is not blocked for more than 100 ms at p99.
// The run is a real file store with simulated agents, many tasks, and the same loop the CLI runs. The delay is
// measured with monitorEventLoopDelay: a late timer is a blocked loop, so the 99th percentile is the bound.
const P99_LIMIT_MS = 100;
const TASKS = 60;
const RESOLUTION_MS = 5;
const NS_PER_MS = 1_000_000;
const clock: Clock = {
  now: () => Date.now(),
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "haril-loop-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("[INV-18] event-loop delay during a simulated run", () => {
  it("[INV-18] the p99 delay of the event loop stays under 100 ms with 60 fake tasks", async () => {
    const store = openStore({
      dataDir: dir,
      clock,
      ids: { next: () => randomUUID() },
      rules: { canTransition, checkPlan: checkPlanSubmission, checkAcceptance },
    });
    const projectId = store.projects.register({
      slug: "loop",
      name: "Loop",
      rootPath: dir,
    }).projectId;
    for (let n = 0; n < TASKS; n += 1) {
      const key = `loop-${n}`;
      store.commands.enqueue({
        type: "task.create",
        projectId,
        // fake:slow settles on a timer, so the loop turns between attempts as it does with real I/O. fake:succeed
        // settles on microtasks only, and a run that never yields leaves the sampler with nothing to measure.
        args: {
          goal: `goal ${n}`,
          dependsOn: [],
          agent: "fake:slow:5",
          maxAttempts: 1,
          timeoutMs: 1000,
        },
        idempotencyKey: key,
        requestHash: key,
      });
    }

    const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    histogram.enable();
    const events: RunEvent[] = [];
    let completed = 0;
    try {
      await runUntilIdle({
        store,
        agentRuntime: new FakeAgentRuntime({ clock }),
        clock,
        pid: process.pid,
        nodeVersion: process.version,
        onEvent: (event) => events.push(event),
      });
      completed = store.metrics.snapshot().tasksByState.completed;
    } finally {
      histogram.disable();
      store.close();
    }

    expect(completed).toBe(TASKS);
    // Enough samples for a p99 to mean something: the run lasts well over RESOLUTION_MS per sample.
    expect(histogram.count).toBeGreaterThan(20);
    const p99Ms = histogram.percentile(99) / NS_PER_MS;
    expect(
      p99Ms,
      `p99 event-loop delay in ms (max ${(histogram.max / NS_PER_MS).toFixed(1)})`,
    ).toBeLessThan(P99_LIMIT_MS);
  }, 60_000);
});
