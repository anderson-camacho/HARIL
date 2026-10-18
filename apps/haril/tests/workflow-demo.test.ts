import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { validateWorkflowSnapshot, type WorkflowSnapshot } from "@haril/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { type Harness, harness, makeSandbox, parseJson, type Sandbox } from "./helpers.js";

// `haril workflow demo` (docs/modos-y-delegacion.md 9, the F1 stop): a simulated three-layer workflow driven by the
// F1 Core rules on the real SQLite store. The limits are never exceeded, the rework never goes past 1 retry and 1
// escalation, a fixed seed always prints the same tree, and the user's data directory is never touched.

interface DemoJson {
  readonly snapshot: WorkflowSnapshot;
  readonly demo: {
    readonly store: { readonly kind: string; readonly path: string; readonly removed: boolean };
  };
  readonly peaks: Record<string, number>;
  readonly limits: Record<string, number>;
  readonly counts: Record<string, number>;
  readonly rework: {
    readonly phase: string;
    readonly retries: number;
    readonly escalations: number;
  }[];
  readonly chain: { readonly ok: boolean };
  readonly rows: { readonly orders: number; readonly usage: number };
}

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

async function demoJson(args: string[] = []): Promise<DemoJson> {
  const code = await invoke(["workflow", "demo", "--json", ...args]);
  expect(code, h.err.join("\n")).toBe(0);
  return parseJson<DemoJson>(h.out);
}

function expectWithinLimits(result: DemoJson): void {
  const { peaks, limits } = result;
  expect(peaks.executors).toBeLessThanOrEqual(limits.executors as number);
  expect(peaks.auditors).toBeLessThanOrEqual(limits.auditors as number);
  expect(peaks.delegators).toBeLessThanOrEqual(limits.delegators as number);
  expect(peaks.writers).toBeLessThanOrEqual(limits.writers as number);
  expect(peaks.orchestratorChildren).toBeLessThanOrEqual(limits.orchestratorChildren as number);
  expect(peaks.delegatorChildren).toBeLessThanOrEqual(limits.delegatorChildren as number);
  expect(result.snapshot.totals.agentsCreated).toBeLessThanOrEqual(limits.agents as number);
  for (const state of result.rework) {
    expect(state.retries).toBeLessThanOrEqual(limits.auditRetries as number);
    expect(state.escalations).toBeLessThanOrEqual(limits.escalations as number);
  }
}

describe("haril workflow demo", () => {
  it("runs the three-layer tree to completion with the default seed and prints a valid snapshot", async () => {
    const result = await demoJson();
    expect(validateWorkflowSnapshot(result.snapshot)).toMatchObject({ ok: true });
    const { snapshot } = result;
    expect(snapshot.demo).toBe(true);
    expect(snapshot.workflow).toMatchObject({
      state: "completed",
      goal: "Change the primary button color and test it",
      orchestratorModel: "demo-a/high-model",
      autonomy: { mode: "autonomous", stops: [] },
    });
    const roles = snapshot.nodes.map((node) => node.role);
    expect(roles.filter((role) => role === "orchestrator")).toHaveLength(1);
    expect(roles.filter((role) => role === "delegator")).toHaveLength(3);
    expect(roles.filter((role) => role === "executor")).toHaveLength(12);
    // One auditor per executor and the final auditor.
    expect(roles.filter((role) => role === "auditor")).toHaveLength(13);
    expect(snapshot.nodes.every((node) => node.state === "done")).toBe(true);
    expect(snapshot.nodes[0]).toMatchObject({
      id: "o1",
      parentId: null,
      depth: 0,
      turn: { index: 2, of: 2 },
    });
    expect(snapshot.nodes.find((node) => node.id === "fa")).toMatchObject({
      parentId: "o1",
      layer: 3,
      role: "auditor",
    });
  });

  it("shows every scripted mechanism: a refused proposal, a retry, an escalation with its reformulation and an idle close", async () => {
    const result = await demoJson();
    expect(result.counts).toMatchObject({
      proposalsRefused: 1,
      // One retry each for the step rejected once, the stalled step and the step rejected twice (before it escalated).
      retries: 3,
      escalations: 1,
      reformulations: 1,
      idleCloses: 1,
      failedNodes: 0,
    });
    const executors = result.snapshot.nodes.filter((node) => node.role === "executor");
    expect(executors.map((node) => node.turn?.of).sort()).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3,
    ]);
    expect(result.snapshot.totals).toMatchObject({ retries: 3, escalations: 1, queued: 0 });
    // The auditor of the stalled attempt never ran its first turn; it shows the turn that ran.
    const auditorTurns = result.snapshot.nodes
      .filter((node) => node.role === "auditor")
      .map((node) => `${node.turn?.index}/${node.turn?.of}`);
    expect(auditorTurns.filter((turn) => turn !== "1/1").sort()).toEqual(["2/2", "2/2", "3/3"]);
    const types = result.snapshot.events.map((event) => event.type);
    expect(types).toContain("workflow.completed");
    expect(result.snapshot.usage.some((row) => row.outcome === "closed_idle")).toBe(true);
  });

  it.each([
    [1, 3, 4],
    [2, 5, 6],
    [3, 7, 2],
    [4, 1, 10],
    [5, 2, 1],
  ] as const)(
    "never exceeds a limit nor reworks past 1 retry and 1 escalation (seed %i, %i delegators, %i executors each)",
    async (seed, delegators, executors) => {
      const result = await demoJson([
        "--seed",
        String(seed),
        "--delegators",
        String(delegators),
        "--executors",
        String(executors),
      ]);
      expect(result.snapshot.workflow.state).toBe("completed");
      expectWithinLimits(result);
      expect(result.chain.ok).toBe(true);
    },
    30_000,
  );

  it("reaches the limits it is given: five live executors and one writer at a time", {
    timeout: 30_000,
  }, async () => {
    const result = await demoJson(["--delegators", "5", "--executors", "6"]);
    expect(result.peaks.executors).toBe(5);
    expect(result.peaks.writers).toBe(1);
    expect(result.peaks.delegatorChildren).toBeLessThanOrEqual(4);
  });

  // Only the name of the temporary folder changes between runs; the text output names no folder at all.
  it("prints the same output for the same seed, and a different scenario for another seed", async () => {
    const output = async (args: string[]) => {
      await invoke(["workflow", "demo", ...args]);
      return h.out.join("\n").replace(/"path":"[^"]*"/, '"path":"<temporary>"');
    };
    const first = await output(["--json"]);
    expect(await output(["--json"])).toBe(first);
    expect(await output(["--json", "--seed", "9"])).not.toBe(first);
    expect(await output([])).toBe(await output([]));
  });

  it("writes the order and one usage row per attempt, with a valid hash chain", async () => {
    const result = await demoJson();
    expect(result.rows.orders).toBe(1);
    expect(result.rows.usage).toBe(result.counts.attempts);
    expect(result.chain.ok).toBe(true);
  });

  it("runs on a temporary store it removes, and never creates the user's data directory", async () => {
    const result = await demoJson();
    expect(result.demo.store).toMatchObject({ kind: "temporary", removed: true });
    expect(existsSync(result.demo.store.path)).toBe(false);
    expect(existsSync(join(sb.dataDir, "haril.db"))).toBe(false);
  });

  it("prints the tree and the totals as text", async () => {
    expect(await invoke(["workflow", "demo"])).toBe(0);
    const text = h.out.join("\n");
    expect(h.out[0]).toMatch(/^workflow demo-\d{6} {2}completed {2}\(simulated, seed 1\)$/);
    expect(text).toMatch(/^o1 +orchestrator +done +demo-a\/high-model +pinned/m);
    expect(text).toMatch(/^\+- d1 +delegator/m);
    expect(text).toMatch(/^\| {2}\+- e1 +executor/m);
    expect(text).toMatch(/^`- fa +auditor +done/m);
    expect(text).toMatch(/approved after 1 retry/);
    expect(text).toMatch(
      /^rework {5}retries 3 · escalations 1 · reformulations 1 · idle closes 1/m,
    );
    expect(text).toMatch(
      /^peak live {2}executors \d\/5 · auditors \d\/5 · delegators \d\/5 · writers 1\/1/m,
    );
    expect(text).toMatch(/^usage log {2}1 order · \d+ usage rows · chain ok$/m);
    expect(text).toMatch(/^store {6}temporary, removed/m);
  });

  it("keeps its rows in the folder --data-dir names, readable by haril usage", async () => {
    const folder = join(sb.root, "demo-store");
    expect(await invoke(["workflow", "demo", "--data-dir", folder])).toBe(0);
    expect(existsSync(join(folder, "haril.db"))).toBe(true);
    expect(await invoke(["usage", "verify", "--data-dir", folder])).toBe(0);
    expect(await invoke(["usage", "log", "--data-dir", folder, "--kind", "order"])).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toMatch(/order\.cli .* mode=delegacion/);
    // Each relaunch counts once in the log: the executor rows add up to the demo's three retries.
    expect(await invoke(["usage", "summary", "--by", "role", "--json", "--data-dir", folder])).toBe(
      0,
    );
    const byRole = parseJson<{ rows: { key: string; retries: number; rejected: number }[] }>(
      h.out,
    ).rows;
    expect(byRole.find((row) => row.key === "executor")).toMatchObject({ retries: 3, rejected: 3 });
    // A second run in the same folder adds a second workflow and keeps the chain whole.
    expect(await invoke(["workflow", "demo", "--data-dir", folder, "--seed", "2"])).toBe(0);
    expect(await invoke(["usage", "verify", "--data-dir", folder, "--json"])).toBe(0);
    expect(parseJson<{ orders: { rows: number } }>(h.out).orders.rows).toBe(2);
    expect(readdirSync(sb.root)).not.toContain("data");
  });

  it("pauses at a stop the human set and leaves the queued turns for a later continue", async () => {
    const result = await demoJson(["--stop-at", "after_plan"]);
    expect(result.snapshot.workflow.state).toBe("awaiting_human");
    expect(result.snapshot.workflow.autonomy).toEqual({ mode: "stops", stops: ["after_plan"] });
    expect(result.snapshot.totals.queued).toBeGreaterThan(0);
    expect(
      result.snapshot.nodes
        .filter((node) => node.role === "delegator")
        .every((node) => node.state === "queued"),
    ).toBe(true);
    expect(await invoke(["workflow", "demo", "--stop-at", "after_node:part-2"])).toBe(0);
    expect(h.out.join("\n")).toMatch(/^stopped {4}at after_node:part-2/m);
  });

  it("refuses bad flags", async () => {
    for (const args of [
      ["--delegators", "0"],
      ["--executors", "11"],
      ["--seed", "-1"],
      ["--seed", "x"],
      ["--start", "tomorrow"],
      ["--stop-at", "after_lunch"],
      ["--goal", " "],
      ["extra"],
    ]) {
      expect(await invoke(["workflow", "demo", ...args]), args.join(" ")).toBe(2);
    }
    expect(await invoke(["workflow"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/usage: haril workflow demo/);
  });
});
