import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  type Harness,
  harness,
  makeSandbox,
  parseJson,
  projectRoot,
  type Sandbox,
} from "./helpers.js";

// `haril metrics` and `haril events` (M1-T6): read-only views over runs, tasks and events.
let sb: Sandbox;
let h: Harness;

beforeEach(() => {
  sb = makeSandbox();
});

afterEach(() => {
  sb.cleanup();
});

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

async function initProject(): Promise<void> {
  await invoke([
    "project",
    "init",
    projectRoot(sb, "demo"),
    "--name",
    "Demo",
    "--slug",
    "demo",
    "--yes",
  ]);
}

function taskIdOf(goal: string): string {
  const report = harness();
  run(["status", "--json"], report.io, sb.host);
  const task = parseJson<{ taskList: { taskId: string; goal: string }[] }>(
    report.out,
  ).taskList.find((candidate) => candidate.goal === goal);
  if (task === undefined) throw new Error(`no task "${goal}"`);
  return task.taskId;
}

// One success, and one failure retried once: three runs in total.
async function runScenario(): Promise<void> {
  await initProject();
  await invoke(["task", "add", "M1", "--agent", "fake:succeed"]);
  await invoke(["task", "add", "M2", "--agent", "fake:fail", "--max-attempts", "2"]);
  expect(await invoke(["start"])).toBe(1);
}

describe("not initialized", () => {
  it("metrics and events exit 2 and create nothing", async () => {
    expect(await invoke(["metrics"])).toBe(2);
    expect(h.err.join("\n")).toContain("not initialized");
    expect(await invoke(["events"])).toBe(2);
    expect(h.err.join("\n")).toContain("not initialized");
    expect(existsSync(join(sb.dataDir, "haril.db"))).toBe(false);
  });
});

describe("haril events", () => {
  it("prints the newest events one per line, oldest first, within --limit", async () => {
    await runScenario();
    expect(await invoke(["events", "--limit", "3"])).toBe(0);
    expect(h.out).toHaveLength(3);
    const seqs = h.out.map((line) => Number(line.split(" ")[0]));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(h.out[2]).toMatch(/^\d+ \S+ task\.\S+ task:\S+ /);
  });

  it("filters by task with --task and returns JSON with --json", async () => {
    await runScenario();
    const id = taskIdOf("M1");
    expect(await invoke(["events", "--task", id])).toBe(0);
    expect(h.out.length).toBeGreaterThan(0);
    expect(h.out.join("\n")).toContain("task.completed");
    expect(await invoke(["events", "--task", id, "--json"])).toBe(0);
    const events = parseJson<{ type: string; taskId?: string }[]>(h.out);
    expect(events.every((event) => event.taskId === id)).toBe(true);
  });

  it("rejects a non-positive --limit with exit 2", async () => {
    await initProject();
    expect(await invoke(["events", "--limit", "0"])).toBe(2);
  });
});

describe("haril metrics", () => {
  it("reports runs, retries and per-agent numbers, with tokens and cost null", async () => {
    await runScenario();
    expect(await invoke(["metrics", "--json"])).toBe(0);
    const metrics = parseJson<{
      tasks: Record<string, number>;
      runs: Record<string, number>;
      retries: number;
      orphanedRecoveries: number;
      successRate: number | null;
      agents: { agentRef: string; runs: number; completed: number; failed: number }[];
      tokens: unknown;
      cost: unknown;
      note: string;
    }>(h.out);
    expect(metrics.tasks).toMatchObject({ completed: 1, failed: 1 });
    expect(metrics.runs).toMatchObject({ total: 3, completed: 1, failed: 2, orphaned: 0 });
    expect(metrics.retries).toBe(1);
    expect(metrics.orphanedRecoveries).toBe(0);
    expect(metrics.successRate).toBeCloseTo(1 / 3);
    expect(metrics.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentRef: "fake:succeed", runs: 1, completed: 1 }),
        expect.objectContaining({ agentRef: "fake:fail", runs: 2, failed: 2 }),
      ]),
    );
    expect(metrics.tokens).toBeNull();
    expect(metrics.cost).toBeNull();
    expect(metrics.note).toContain("available from M2 (Broker)");
  });

  it("prints a human summary by default", async () => {
    await runScenario();
    expect(await invoke(["metrics"])).toBe(0);
    expect(h.out.join("\n")).toContain("runs: 3 total");
    expect(h.out.join("\n")).toContain("tokens: null");
    expect(h.out.join("\n")).toContain("available from M2 (Broker)");
  });
});
