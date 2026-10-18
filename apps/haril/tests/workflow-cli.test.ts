import { validateWorkflowSnapshot, type WorkflowSnapshot } from "@haril/contracts";
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

// `haril workflow start|list|show|continue` (docs/modos-y-delegacion.md 6, 3.13; phase F2), end to end through the CLI:
// start queues the workflow and writes its order, `haril run` runs it with the fake workflow agents, list and show read
// it (show --json is WorkflowSnapshot v1), and continue lifts the stop it waits at.

let sb: Sandbox;
let h: Harness;

beforeEach(async () => {
  sb = makeSandbox();
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
});

afterEach(() => {
  sb.cleanup();
});

async function invoke(args: string[]): Promise<number> {
  h = harness();
  return await run(args, h.io, sb.host);
}

async function workflowId(): Promise<string> {
  expect(await invoke(["workflow", "list", "--json"])).toBe(0);
  const [first] = parseJson<{ workflowId: string }[]>(h.out);
  if (first === undefined) throw new Error("no workflow");
  return first.workflowId;
}

describe("haril workflow start, list, show and continue", () => {
  it("queues a workflow that stops after its first plan, and runs it to the end once continued", async () => {
    expect(
      await invoke([
        "workflow",
        "start",
        "Ship",
        "the",
        "button",
        "[fake:parts=2]",
        "--model",
        "fake/high-model",
        "--json",
      ]),
    ).toBe(0);
    expect(parseJson<{ type: string; status: string }>(h.out)).toMatchObject({
      type: "workflow.start",
      status: "queued",
    });
    expect(await invoke(["run"])).toBe(0);
    // A workflow that waits for the human is neither completed nor failed: the run exits 0 and says it waits.
    expect(h.out[h.out.length - 1]).toBe(
      "done: 0 completed, 0 failed, 0 blocked; workflows: 1 turn, 0 completed, 0 failed, 1 waiting",
    );
    const id = await workflowId();
    expect(await invoke(["workflow", "show", id])).toBe(0);
    const paused = h.out.join("\n");
    expect(paused).toMatch(
      new RegExp(`^workflow ${id} {2}awaiting_human {2}\\(fake agents\\)$`, "m"),
    );
    expect(paused).toMatch(/^o1 +orchestrator +waiting .* waits for its children$/m);
    expect(paused).toMatch(/^\+- d1 +delegator +queued .* waits until the workflow continues$/m);
    expect(paused).toMatch(/^stopped {4}at after_plan: continue it with haril workflow continue/m);

    expect(await invoke(["workflow", "continue", id])).toBe(0);
    expect(await invoke(["run"])).toBe(0);
    expect(await invoke(["workflow", "show", id, "--json"])).toBe(0);
    const snapshot = parseJson<WorkflowSnapshot>(h.out);
    expect(validateWorkflowSnapshot(snapshot)).toMatchObject({ ok: true });
    expect(snapshot.workflow).toMatchObject({
      id,
      state: "completed",
      goal: "Ship the button [fake:parts=2]",
      orchestratorModel: "fake/high-model",
      autonomy: { mode: "stops", stops: ["after_plan"] },
    });
    expect(snapshot.nodes.map((node) => node.role).sort()).toEqual([
      "auditor",
      "auditor",
      "auditor",
      "auditor",
      "auditor",
      "delegator",
      "delegator",
      "executor",
      "executor",
      "executor",
      "executor",
      "orchestrator",
    ]);
    expect(snapshot.nodes.every((node) => node.state === "done")).toBe(true);
    expect(snapshot.usage.length).toBeGreaterThan(0);

    // The order of the start, and every agent_run row of the workflow points at it.
    expect(await invoke(["usage", "log", "--kind", "order", "--json"])).toBe(0);
    const orders = parseJson<{ orderId: string; mode: string; preview: string }[]>(h.out);
    expect(orders).toEqual([
      expect.objectContaining({ mode: "delegacion", preview: "Ship the button [fake:parts=2]" }),
    ]);
    expect(
      await invoke(["usage", "log", "--kind", "agent_run", "--include-simulated", "--json"]),
    ).toBe(0);
    const rows = parseJson<{ orderId: string | null; workflowId: string }[]>(h.out);
    expect(rows.length).toBe(snapshot.usage.length);
    expect(rows.every((row) => row.orderId === orders[0]?.orderId && row.workflowId === id)).toBe(
      true,
    );
    expect(await invoke(["usage", "verify"])).toBe(0);
  });

  it("runs an autonomous workflow without stopping, and lists it", async () => {
    expect(
      await invoke([
        "workflow",
        "start",
        "--goal",
        "Quick job",
        "--model",
        "fake/m",
        "--autonomous",
      ]),
    ).toBe(0);
    expect(h.out[0]).toMatch(/^command \S+: queued/);
    expect(await invoke(["run"])).toBe(0);
    expect(await invoke(["workflow", "list"])).toBe(0);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toMatch(/ {2}completed {2}.* {2}Quick job$/);
    // A node that ended has no next watchdog check: the view must not promise one.
    expect(await invoke(["workflow", "show", await workflowId(), "--json"])).toBe(0);
    const snapshot = parseJson<WorkflowSnapshot>(h.out);
    expect(snapshot.nodes.length).toBeGreaterThan(1);
    expect(snapshot.nodes.map((node) => [node.id, node.nextCheckAt])).toEqual(
      snapshot.nodes.map((node) => [node.id, null]),
    );
  });

  it("refuses a start without a goal or a model, contradictory autonomy and unknown stops", async () => {
    for (const args of [
      ["workflow", "start", "--model", "fake/m"],
      ["workflow", "start", "Goal"],
      ["workflow", "start", "Goal", "--model", "fake/m", "--autonomous", "--stop-at", "at_end"],
      ["workflow", "start", "Goal", "--model", "fake/m", "--stop-at", "after_lunch"],
      ["workflow", "start", "Goal", "--goal", "Other", "--model", "fake/m"],
      ["workflow", "start", "Goal", "--model", "fake/m", "--budget-tokens", "0"],
    ]) {
      expect(await invoke(args), args.join(" ")).toBe(2);
    }
    expect(await invoke(["workflow", "start", "Goal"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/the orchestrator needs a model/);
  });

  it("says so when a workflow does not exist or does not wait for the human", async () => {
    expect(await invoke(["workflow", "show", "no-such-workflow"])).toBe(2);
    expect(h.err.join("\n")).toMatch(/no workflow with id "no-such-workflow"/);
    expect(await invoke(["workflow", "start", "Job", "--model", "fake/m", "--autonomous"])).toBe(0);
    expect(await invoke(["run"])).toBe(0);
    expect(await invoke(["workflow", "continue", await workflowId()])).toBe(2);
    expect(h.err.join("\n")).toMatch(/is completed, not waiting for you/);
    expect(await invoke(["workflow", "list", "--project", "nope"])).toBe(2);
  });
});
