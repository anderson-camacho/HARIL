import { randomUUID } from "node:crypto";
import { canTransition, checkPlanSubmission } from "@haril/core";
import { openStore } from "@haril/state-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type Harness, harness, makeSandbox, projectRoot, type Sandbox } from "./helpers.js";

// Recovery through `haril start` (M1-T7) and the simulated agent of non-fake refs (M1 fix a).
let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
  const init = harness();
  run(
    ["project", "init", projectRoot(sb, "demo"), "--name", "Demo", "--slug", "demo", "--yes"],
    init.io,
    sb.host,
  );
});

afterEach(() => {
  sb.cleanup();
});

// Simulates kill -9 during a run: the runtime claims a task and dies without releasing its lease.
function crashWhileRunning(goal: string): string {
  const store = openStore({
    dataDir: sb.dataDir,
    clock: { now: () => Date.now(), schedule: () => () => undefined },
    ids: { next: () => randomUUID() },
    rules: { canTransition, checkPlan: checkPlanSubmission },
    isPidAlive: () => true,
  });
  const grant = store.runtime.acquire({
    pid: 4242,
    nodeVersion: "v24.19.0",
    sqliteVersion: store.info().sqliteVersion,
    ttlMs: 60_000,
  });
  if (!grant.ok) throw new Error("lease not granted");
  const projectId = store.projects.list()[0]?.projectId ?? "";
  store.commands.enqueue({
    type: "task.create",
    projectId,
    args: { goal, dependsOn: [], agent: "fake:succeed", maxAttempts: 1, timeoutMs: 1000 },
    idempotencyKey: `crash-${goal}`,
    requestHash: `crash-${goal}`,
  });
  store.commands.applyNext(grant.value.epoch);
  const claimed = store.tasks.claimNext(grant.value.epoch);
  store.close();
  if (claimed === undefined) throw new Error("nothing claimed before the crash");
  return claimed.taskId;
}

async function start(host = sb.host): Promise<number> {
  h = harness();
  return await run(["start"], h.io, host);
}

describe("haril start after a crash (M1-T7)", () => {
  it("recovers the orphaned task, prints the recovery line and completes it", async () => {
    const taskId = crashWhileRunning("Crashed");
    // The dead runtime's pid is not alive, so its unexpired lease is taken over at once.
    expect(await start({ ...sb.host, isPidAlive: () => false })).toBe(0);
    expect(h.out).toContain(`recovered ${taskId} Crashed (orphaned, restart 1/3)`);
    // The orphan recovery charged no attempt, so the rerun is attempt 1 of 1 (M1-T8).
    expect(h.out).toContain(`claimed ${taskId} Crashed (attempt 1/1)`);
    expect(h.out).toContain(`completed ${taskId} Crashed`);
  });
});

describe("simulated agent for non-fake refs (M1 fix a)", () => {
  it("runs a developer-block task as a simulated success and says so", async () => {
    const add = harness();
    expect(run(["task", "add", "Sim", "--agent", "developer-block"], add.io, sb.host)).toBe(0);
    expect(await start()).toBe(0);
    expect(h.out.join("\n")).toMatch(/^completed \S+ Sim \(simulated: no real agent until M2\)$/m);
  });
});
